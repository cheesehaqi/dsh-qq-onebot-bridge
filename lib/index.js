/**
 * dsh-qq-onebot-bridge — bidirectional QQ ↔ DeepSeek Harness agent bridge
 * over the OneBot v11 protocol (reverse WebSocket).
 *
 * Install (web profile):
 *   dsh plugin --profile web add <path-to-this-directory>
 * Remove anytime:
 *   dsh plugin --profile web remove dsh-qq-onebot-bridge
 */
import z from 'schemastery'
import { QQBridge } from './bridge.js'
import { OneBotServer } from './onebot.js'

export const name = 'dsh-qq-onebot-bridge'
export const inject = ['agents', 'agentDefaultModel']

export const Config = z.object({
  host: z.string().default('127.0.0.1').description('Reverse-WS listen host.'),
  port: z.number().step(1).min(1).max(65535).default(6700).description('Reverse-WS listen port. Point your OneBot implementation at ws://127.0.0.1:<port>.'),
  accessToken: z.string().role('secret').default('').description('Optional Bearer token the OneBot client must present.'),
  allowUsers: z.array(z.number().step(1)).default([]).description('Allowlisted QQ user ids for private chats. Empty = deny ALL private chats until you list your own QQ id (safe default).'),
  allowGroups: z.array(z.number().step(1)).default([]).description('Allowlisted QQ group ids. Empty = deny ALL group messages until you list the groups the bot should serve (safe default).'),
  botQq: z.number().step(1).default(0).description('Bot QQ id used to detect @-mentions in groups (0 = treat every group message as mentioned).'),
  replyOnlyWhenMentioned: z.boolean().default(true).description('In groups, only respond when the bot is @-mentioned.'),
  acceptPrivate: z.boolean().default(true).description('Whether to respond to private chats at all (private chats still require allowUsers allowlisting).'),
  autoCollectStickers: z.boolean().default(false).description('Automatically save image stickers from incoming messages into the local face library.'),
  faceEnabled: z.boolean().default(true).description('Master switch for emoji features ([face:xxx] markers and qq_face_* tools).'),
  sessionMode: z.union(['chat', 'user']).default('chat').description('Group session mapping: chat = one session per group, user = one session per sender.'),
  cwd: z.string().default('').description('Working directory for bridged sessions (empty = host cwd).'),
  provider: z.string().default('').description('LLM provider override (empty = agent default).'),
  model: z.string().default('').description('LLM model override (empty = agent default).'),
  maxMessageLength: z.number().step(1).min(100).max(4000).default(1700).description('Max chars per outbound QQ message before chunking.'),
  sttEnabled: z.boolean().default(false).description('Speech-to-text: when the bot is @-mentioned in a group (or anytime in private) and the message quotes (replies to) a voice message, transcribe the quoted voice and reply with its text. Private voice messages sent directly are also transcribed (regardless of acceptPrivate).'),
  sttBaseUrl: z.string().default('https://open.bigmodel.cn/api/paas/v4').description('STT base URL of an OpenAI-compatible /audio/transcriptions endpoint (Zhipu GLM-ASR or SiliconFlow).'),
  sttModel: z.string().default('glm-asr-2512').description('STT model id (Zhipu: glm-asr-2512; SiliconFlow: FunAudioLLM/SenseVoiceSmall).'),
  sttApiKey: z.string().role('secret').default('').description('STT API key (Zhipu key can be shared with DeepEye).'),
  privateImageView: z.boolean().default(true).description('In private chats, proactively download images/animated stickers the user sends (to cwd/qq-images) so the agent can view them with describe_image and respond.'),
  visionMode: z.union(['tool', 'native']).default('tool').description('How the agent views images: tool = save images to disk and let the agent view them via visionToolName; native = attach images as native multimodal attachments (DSH 0.1.1+ attachment seam; text-only models degrade to placeholders automatically).'),
  visionToolName: z.string().default('describe_image').description('Vision tool the agent uses when visionMode is tool (e.g. describe_image).'),
  imageRetentionDays: z.number().step(1).min(1).max(365).default(14).description('Days downloaded images (qq-images, qq-replies) are kept before cleanup on host start.'),
  memoryEnabled: z.boolean().default(true).description('Persist a rolling window of each chat\'s recent conversation to <cwd>/qq-memory/ and re-inject it into new sessions after host restarts, so the bot remembers previous chats. /new clears the memory for that chat.'),
  memoryMaxEntries: z.number().step(1).min(1).max(100).default(30).description('Max conversation lines kept per chat in persistent memory.'),
  reminderEnabled: z.boolean().default(true).description('Scheduled reminders: "30分钟后提醒我喝水" / "明天9点开会". In groups this requires @-mentioning the bot; in private chats it works directly. Reminders persist across host restarts (cwd/qq-reminders.json); /reminders lists them.'),
  reminderMaxPerChat: z.number().step(1).min(1).max(50).default(10).description('Max pending reminders per chat.'),
  rateLimitEnabled: z.boolean().default(false).description('Outbound reply rate limiting (default OFF, risk-control). When enabled, each chat gets at most rateLimitMaxReplies replies per rateLimitWindowSeconds; excess replies are silently dropped and logged.'),
  rateLimitMaxReplies: z.number().step(1).min(1).max(120).default(10).description('Max replies per chat per window when rate limiting is enabled.'),
  rateLimitWindowSeconds: z.number().step(1).min(5).max(3600).default(60).description('Rate limit sliding window length in seconds.'),
  dedupEnabled: z.boolean().default(true).description('Ignore duplicate inbound messages (the same message re-delivered after a NapCat reconnect) within dedupWindowSeconds.'),
  dedupWindowSeconds: z.number().step(1).min(10).max(3600).default(300).description('Duplicate detection window in seconds.'),
  adminUsers: z.array(z.number().step(1)).default([]).description('QQ user ids allowed to run admin commands (/mute /unmute /kick /clear). Kick requires a second confirmation in chat.'),
  adminEnabled: z.boolean().default(true).description('Master switch for admin commands.'),
  summaryEnabled: z.boolean().default(true).description('Enable /summary: the agent summarizes the chat\'s persisted conversation.'),
  voteEnabled: z.boolean().default(true).description('Enable group votes: "投票：问题？A 选项 B 选项"; members reply with option letters; /vote /vote-end manage it.'),
  voteDurationSeconds: z.number().step(1).min(10).max(3600).default(300).description('Default vote duration before results publish.'),
  todoEnabled: z.boolean().default(true).description('Enable shared todos: /todo add|list|done|clear and "记一下：xxx"; stored per chat in cwd/qq-todos/.'),
  ttsEnabled: z.boolean().default(false).description('Voice replies via TTS (default provider: Azure Speech; off until you set ttsApiKey and flip this on). A voice message follows each text reply.'),
  ttsProvider: z.union(['azure', 'openai', 'local']).default('azure').description('TTS provider: azure = Microsoft Speech SSML; openai = any OpenAI-compatible /audio/speech endpoint (OpenAI/Minimax/Doubao...); local = a local GPT-SoVITS api_v2 server (zero-shot voice cloning, no API key).'),
  ttsApiKey: z.string().role('secret').default('').description('TTS API key (Azure Speech key, or OpenAI-compatible key; not needed for local).'),
  ttsAzureRegion: z.string().default('eastasia').description('Azure Speech region (e.g. eastasia).'),
  ttsVoice: z.string().default('zh-CN-XiaoxiaoNeural').description('Voice id: Azure voice name (e.g. zh-CN-XiaoxiaoNeural) or OpenAI-compatible voice name.'),
  ttsStyle: z.string().default('chat').description('Azure speaking style (e.g. chat/cheerful/sad; empty = neutral). Ignored by OpenAI-compatible providers.'),
  ttsBaseUrl: z.string().default('https://api.openai.com/v1').description('OpenAI-compatible TTS base URL (used when ttsProvider is openai).'),
  ttsModel: z.string().default('tts-1').description('OpenAI-compatible TTS model id.'),
  ttsMaxChars: z.number().step(1).min(10).max(500).default(120).description('Max chars spoken per voice reply (longer replies are truncated for voice only).'),
  ttsLocalUrl: z.string().default('http://127.0.0.1:9880').description('Local GPT-SoVITS api_v2 base URL (used when ttsProvider is local; e.g. http://127.0.0.1:9880).'),
  ttsLocalRefAudio: z.string().default('').description('Absolute path to the reference voice clip (3-10s wav) that defines the voice, e.g. D:/voice/xiaojingyu.wav. Required for local TTS.'),
  ttsLocalPromptText: z.string().default('').description('Transcript of the reference clip (helps the voice clone; can be empty).'),
  ttsLocalTextLang: z.string().default('zh').description('Language of the text to synthesize (zh/en/ja...).'),
  ttsLocalPromptLang: z.string().default('zh').description('Language of the reference clip transcript.'),
  ttsLocalConvertToMp3: z.boolean().default(true).description('Convert local TTS wav output to mp3 with ffmpeg before sending (better QQ/NapCat compatibility).'),
  fileTransferEnabled: z.boolean().default(true).description('In private chats, save files the user sends to cwd/qq-files/ and reply with the local path.'),
  fileTransferMaxBytes: z.number().step(1).min(1).default(52428800).description('Max accepted file size for private file transfer (default 50 MiB).'),
  exportEnabled: z.boolean().default(true).description('Enable /export: dump this chat\'s persisted conversation to a markdown file under cwd/qq-exports/.'),
  notifyEnabled: z.boolean().default(false).description('Status push notifications (default OFF): the host pushes bot online/offline events to a push service (PushPlus or any JSON webhook) without going through QQ, so you learn about outages even when the bot is offline.'),
  notifyPushUrl: z.string().default('').description('Push endpoint URL (defaults to PushPlus http://www.pushplus.plus/send when empty but notifyToken is set; can be any JSON webhook).'),
  notifyToken: z.string().role('secret').default('').description('PushPlus token (or the token field of a custom webhook payload).'),
  notifyCooldownSeconds: z.number().step(1).min(30).max(3600).default(300).description('Min seconds between status notifications (anti-flood for flapping connections).'),
  gifFrameExtract: z.boolean().default(true).description('Extract the first frame of GIF images via ffmpeg into PNG before handing them to the vision path (animated stickers become stably viewable).'),
  ffmpegPath: z.string().default('ffmpeg').description('Path to the ffmpeg executable for GIF frame extraction (empty PATH name is fine when ffmpeg is on PATH).'),
  quietHoursEnabled: z.boolean().default(false).description('Avoid peak hours (default OFF): while enabled, the bot does not reply to ANY inbound message during the quiet windows on weekdays (scheduled reminders and vote publishing still fire).'),
  quietHours: z.array(z.string()).default(['9:00-12:00', '14:00-18:00']).description('Quiet windows as local-time "H:MM-H:MM" ranges (full-width colons are normalized).'),
  quietWeekendExempt: z.boolean().default(true).description('Do not apply quiet hours on Saturdays and Sundays.'),
})

function makeLogger(ctx) {
  const base = ctx.logger('dsh-qq-onebot-bridge')
  return {
    info: (message) => base.info(message),
    warn: (message) => base.warn(message),
    error: (message) => base.error(message),
  }
}

export async function apply(ctx, config) {
  const logger = makeLogger(ctx)
  const server = new OneBotServer(config, logger)
  const bridge = new QQBridge(ctx, config, server, logger)
  await ctx.effect(async () => {
    await server.start()
    bridge.start()
    logger.info(`QQ bridge ready: reverse-WS ws://${config.host}:${config.port}`)
    return async () => {
      bridge.stop()
      await server.stop()
      logger.info('QQ bridge stopped')
    }
  }, 'dsh-qq-onebot-bridge.serve')
}
