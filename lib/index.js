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
  traceEnabled: z.boolean().default(true).description('Everything-debuggable tracing: every inbound message gets a trace id and every decision — including every silent drop — is recorded with stage/ok/reason/duration into cwd/qq-trace.jsonl plus an in-memory ring. The standalone console renders it as a live event stream and per-message decision chain.'),
  traceLevel: z.union(['debug', 'info', 'warn', 'error']).default('debug').description('Minimum level written to the trace file: debug = everything (per-turn internals), warn = only problems (much smaller file).'),
  traceMemorySize: z.number().step(1).min(20).max(5000).default(500).description('Recent trace events kept in memory (used by /health and the runtime snapshot).'),
  traceFile: z.string().default('').description('Trace file path (empty = cwd/qq-trace.jsonl). Size-rotated: 4 MiB cap, last 512 KiB kept.'),
  recordInbound: z.boolean().default(true).description('Record every inbound frame to cwd/qq-inbox.jsonl in a replayable shape, so any past message can be replayed offline through the real pipeline.'),
  inboxFile: z.string().default('').description('Inbound recording path (empty = cwd/qq-inbox.jsonl).'),
  inboxRedact: z.boolean().default(false).description('Mask QQ numbers in the recorded inbox (set true if you plan to share the file).'),
  injectEnabled: z.boolean().default(false).description('Event injector (default OFF): the bridge polls cwd/qq-inject.jsonl and feeds each JSON spec through the real pipeline — a synthetic message/notice/request for debugging without QQ.'),
  injectFile: z.string().default('').description('Injection queue path (empty = cwd/qq-inject.jsonl). Only lines appended AFTER start are processed.'),
  injectDryRun: z.boolean().default(true).description('Injected events run in dry-run: every outbound OneBot call is recorded instead of sent, so an injection can never reach QQ. Set false only if you really want injections to be delivered.'),
  injectIntervalMs: z.number().step(1).min(500).max(60000).default(2000).description('How often the injection queue is polled (ms).'),
  botName: z.string().default('小鲸鱼').description('Bot display name used in merged-forward cards (and shown to the agent as its QQ name).'),
  sessionResumeEnabled: z.boolean().default(true).description('Resume the session this chat used before the host restarted (full transcript continuity instead of only the memory window). Set false to always start a new session.'),
  agentMediaToolsEnabled: z.boolean().default(true).description('Expose qq_send_image / qq_send_file / qq_send_voice / qq_recall tools so the agent can send local media and withdraw its own recent messages.'),
  fileSendDirs: z.array(z.string()).default([]).description('Extra directories the agent may send files from. The session cwd is always allowed.'),
  fileSendMaxBytes: z.number().step(1).min(1).default(52428800).description('Max size of a file the agent may send (bytes, default 50 MiB).'),
  imageSendMaxBytes: z.number().step(1).min(10240).default(4194304).description('Images larger than this (bytes, default 4 MiB) are compressed with ffmpeg before sending.'),
  recallWindowSeconds: z.number().step(1).min(5).max(300).default(110).description('How long an outbound message of this bridge stays withdrawable via qq_recall / /撤回 (QQ itself allows ~2 minutes).'),
  forwardLongReplies: z.boolean().default(false).description('Deliver long group replies as a merged-forward ("chat record") card instead of a wall of text.'),
  forwardThresholdChars: z.number().step(1).min(200).max(5000).default(600).description('Character count from which a group reply becomes a merged-forward card (only when forwardLongReplies is on).'),
  actionRatePerMinute: z.number().step(1).min(1).max(600).default(20).description('Global gate for OneBot WRITE actions (ban/kick/notice/essence/upload/recall/forward...): max per minute across all chats.'),
  actionRatePerDay: z.number().step(1).min(1).max(10000).default(500).description('Global gate for OneBot write actions: max per day across all chats.'),
  actionAuditEnabled: z.boolean().default(true).description('Append every write action (and every denial) to cwd/qq-actions.log for auditing.'),
  keywordEnabled: z.boolean().default(false).description('Keyword auto-replies (default OFF): a local JSON wordbook answers matching messages instantly without calling the model (and without requiring an @-mention). Manage it with /kw add|del|list (admins) or edit the file directly.'),
  keywordFile: z.string().default('').description('Path of the keyword wordbook (empty = cwd/qq-keywords.json). Supports exact / contains / regex triggers with random reply pools, per-chat scope and cooldowns.'),
  fortuneEnabled: z.boolean().default(true).description('Local fortune features: 今日人品/运势, 抽签, 塔罗 — deterministic per user and day, no model call, no network.'),
  diceEnabled: z.boolean().default(true).description('Local dice and random picks: ".r 3d6", "掷骰 2d6+1", "/抽一个 A B C" — pure computation, no model call.'),
  pointsEnabled: z.boolean().default(false).description('Points economy (default OFF): members earn points by chatting and checking in; /积分 shows the balance, /排行榜 the leaderboard, /转账 @某人 数量 transfers points.'),
  pointsPerMessage: z.number().step(1).min(0).max(100).default(1).description('Points granted per chat message when the points economy is on (0 = chatting earns nothing).'),
  pointsDailyCap: z.number().step(1).min(0).max(1000).default(20).description('Max points a member can earn from chatting per day.'),
  pointsCheckinBonus: z.number().step(1).min(0).max(1000).default(5).description('Extra points granted for the daily check-in.'),
  gameEnabled: z.boolean().default(false).description('Chat mini-games (default OFF): 成语接龙 (idiom chain) and 猜数字 (guess the number); say 接龙 / 猜数字 to start, 不玩了 to stop.'),
  idiomChainTimeoutSeconds: z.number().step(1).min(30).max(1800).default(120).description('Idle timeout of an idiom-chain round in seconds.'),
  guessNumberMax: z.number().step(1).min(10).max(100000).default(100).description('Upper bound of the guess-the-number game.'),
  guessNumberMaxTries: z.number().step(1).min(1).max(50).default(10).description('Allowed guesses in the guess-the-number game.'),
  antiRecallEnabled: z.boolean().default(false).description('Anti-recall (default OFF): cache recent inbound messages and repost the content when someone withdraws it (group_recall / friend_recall notices).'),
  antiRecallInGroup: z.boolean().default(true).description('Post the anti-recall notice into the group itself (false = send it to the first adminUsers entry in private instead).'),
  antiRecallImages: z.boolean().default(true).description('Re-send images that were attached to a withdrawn message (up to 3 per recall).'),
  antiRecallCacheSize: z.number().step(1).min(5).max(500).default(50).description('Messages cached per chat for anti-recall.'),
  antiRecallMaxAgeMinutes: z.number().step(1).min(1).max(1440).default(120).description('How long a cached message stays recoverable.'),
  antiRecallCooldownSeconds: z.number().step(1).min(1).max(300).default(5).description('Min seconds between two anti-recall posts in the same chat (anti-flood).'),
  filterEnabled: z.boolean().default(false).description('Sensitive-word filter (default OFF): matches a local word list and reacts with warn / recall / mute.'),
  filterWordsFile: z.string().default('').description('Word list path (empty = cwd/qq-badwords.txt). One entry per line, "#" comments, "re:<regex>" for regular expressions; reloaded when the file changes.'),
  filterAction: z.union(['warn', 'recall', 'mute']).default('warn').description('Reaction to a filtered message: warn = reply with a notice, recall = withdraw the message, mute = mute the sender (group chats only).'),
  filterMuteSeconds: z.number().step(1).min(60).max(86400).default(300).description('Mute duration used by filterAction: mute and by the flood guard escalation.'),
  filterWhitelist: z.array(z.string()).default([]).description('Words/patterns that are always allowed (also supports "re:" regexes).'),
  floodEnabled: z.boolean().default(false).description('Anti-flood (default OFF): too many messages in a short window earn a warning, then a mute.'),
  floodWindowSeconds: z.number().step(1).min(1).max(600).default(10).description('Sliding window used by the anti-flood guard.'),
  floodMaxMessages: z.number().step(1).min(2).max(200).default(8).description('Messages allowed per window before the guard reacts.'),
  floodMuteSeconds: z.number().step(1).min(10).max(86400).default(300).description('Mute duration applied when the flood guard escalates.'),
  floodStrikeLimit: z.number().step(1).min(1).max(20).default(3).description('Warnings before the flood guard mutes a member.'),
  verifyEnabled: z.boolean().default(false).description('Join verification (default OFF): group/friend requests are queued, a challenge is pushed to admins, and nothing is approved until an admin replies /同意 <id> or the applicant answers correctly.'),
  verifyKeyword: z.string().default('').description('Optional passphrase: a request whose verification message contains it is approved automatically (empty = always ask an admin).'),
  verifyTimeoutSeconds: z.number().step(1).min(30).max(86400).default(300).description('How long a join request waits before it expires (admins get a reminder).'),
  verifyMaxPending: z.number().step(1).min(1).max(100).default(20).description('Max queued join/friend requests.'),
  statsEnabled: z.boolean().default(false).description('Group activity statistics (default OFF): count messages per member per day, /统计 and /活跃榜 show the leaderboard, /周榜 the weekly one. Also feeds the daily report.'),
  statsKeepDays: z.number().step(1).min(1).max(365).default(30).description('How many days of per-member message counts are kept.'),
  groupReadEnabled: z.boolean().default(true).description('Read-only group queries: /荣誉 (talkative dragon and friends), /公告 (read the group notices) and /群精华.'),
  mcStatusEnabled: z.boolean().default(true).description('Minecraft Java server status: /mc host[:port] uses the Server List Ping protocol (no API key, read-only).'),
  mcStatusTimeoutMs: z.number().step(1).min(1000).max(30000).default(5000).description('Timeout of the Minecraft status ping.'),
  recurringReminderEnabled: z.boolean().default(true).description('Recurring reminders: "每天8点提醒我喝水", "每周一9点开会", "每个工作日15点打卡" — they fire again automatically.'),
  dailyReportEnabled: z.boolean().default(false).description('Daily group report (default OFF): at dailyReportTime the agent summarizes the day and posts it to the chat. Targets = dailyReportChats plus chats that opted in with /日报 on (empty = every allowlisted group).'),
  dailyReportTime: z.string().default('22:00').description('Local time (HH:mm) of the daily report.'),
  dailyReportChats: z.array(z.union([z.string(), z.number().step(1)])).default([]).description('Chats that always receive the daily report, e.g. ["g:100000001"] or [100000001].'),
  sttEnabled: z.boolean().default(false).description('Speech-to-text: when the bot is @-mentioned in a group (or anytime in private) and the message quotes (replies to) a voice message, transcribe the quoted voice and reply with its text. Private voice messages sent directly are also transcribed (regardless of acceptPrivate).'),
  sttBaseUrl: z.string().default('https://open.bigmodel.cn/api/paas/v4').description('STT base URL of an OpenAI-compatible /audio/transcriptions endpoint (Zhipu GLM-ASR or SiliconFlow).'),
  sttModel: z.string().default('glm-asr-2512').description('STT model id (Zhipu: glm-asr-2512; SiliconFlow: FunAudioLLM/SenseVoiceSmall).'),
  sttApiKey: z.string().role('secret').default('').description('STT API key (Zhipu key can be shared with DeepEye).'),
  privateImageView: z.boolean().default(true).description('In private chats, proactively download images/animated stickers the user sends (to cwd/qq-images) so the agent can view them with describe_image and respond.'),
  visionMode: z.union(['tool', 'native']).default('tool').description('How the agent views images: tool = save images to disk and let the agent view them via visionToolName; native = attach images as native multimodal attachments (DSH 0.1.1+ attachment seam; text-only models degrade to placeholders automatically).'),
  visionToolName: z.string().default('describe_image').description('Vision tool the agent uses when visionMode is tool (e.g. describe_image).'),
  imageRetentionDays: z.number().step(1).min(1).max(365).default(14).description('Days downloaded images (qq-images, qq-replies) are kept before cleanup on host start.'),
  imageTrashEnabled: z.boolean().default(true).description('Deletion policy (never destroy): expired downloads are MOVED to cwd/qq-trash/<date>/ instead of being deleted, so nothing is lost by accident. Set false to unlink them permanently.'),
  imageTrashDir: z.string().default('').description('Where expired downloads go (empty = cwd/qq-trash). The trash is never auto-pruned; clean it yourself when convenient.'),
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
  pokeEnabled: z.boolean().default(true).description('Poke replies: when someone pokes the bot (OneBot notice poke), reply with a random cute line (allowlisted chats only).'),
  pokeReplies: z.array(z.string()).default([
    '哎呀，别戳啦～再戳小鲸鱼就要吐泡泡了！',
    '戳戳戳……你是要把我戳成筛子吗！',
    '呜哇！不要突然戳人家啦 ( ˘•ω•˘ )',
    '哼，再戳就咬你哦～（露出小虎牙）',
    '小鲸鱼收到！请问有什么吩咐呀？',
  ]).description('Random poke reply lines.'),
  pokeCooldownSeconds: z.number().step(1).min(5).max(300).default(15).description('Min seconds between poke replies per chat (anti-spam).'),
  voiceReadingEnabled: z.boolean().default(true).description('Voice reading: "@bot + quote a text message saying 读一下/念出来" or "/读 <text>" — the bot reads the text aloud via TTS (uses the configured ttsProvider).'),
  checkinEnabled: z.boolean().default(false).description('Daily check-in (default OFF): group members say the keyword (default 签到) to check in; streak and total days are persisted per chat (cwd/qq-checkin/); 签到榜 shows the leaderboard.'),
  checkinKeyword: z.string().default('签到').description('Check-in trigger keyword.'),
  welcomeEnabled: z.boolean().default(false).description('Welcome new members (default OFF): when someone joins an allowlisted group (notice group_increase), @-mention them with the welcome text.'),
  welcomeText: z.string().default('').description('Welcome message template (empty = built-in default).'),
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
  imageGenEnabled: z.boolean().default(false).description('Image generation (default OFF): "/画 <描述词>" generates an image and sends it back (group usage requires @-mentioning the bot). Extensible provider backends, same contract as TTS.'),
  imageGenProvider: z.union(['openai', 'local']).default('openai').description('Generation backend: openai = any OpenAI-compatible /images/generations endpoint (DALL·E / Zhipu CogView / SiliconFlow...); local = Stable Diffusion WebUI (AUTOMATIC1111 /sdapi/v1/txt2img).'),
  imageGenBaseUrl: z.string().default('').description('Backend base URL (empty = provider default: https://api.openai.com/v1, or http://127.0.0.1:7860 for local).'),
  imageGenApiKey: z.string().role('secret').default('').description('API key for OpenAI-compatible providers (not needed for local).'),
  imageGenModel: z.string().default('').description('Model id (empty = provider default, e.g. gpt-image-1; ignored by local SD WebUI).'),
  imageGenSize: z.string().default('1024x1024').description('Image size as WxH (e.g. 1024x1024, 512x512; local SD supports arbitrary sizes).'),
  imageGenSteps: z.number().step(1).min(1).max(100).default(20).description('Sampling steps (local SD only).'),
  imageGenCfgScale: z.number().min(1).max(30).default(7).description('CFG scale (local SD only).'),
  imageGenSampler: z.string().default('').description('Sampler name (local SD only; empty = WebUI default).'),
  imageGenCooldownSeconds: z.number().step(1).min(10).max(3600).default(60).description('Min seconds between image generations per chat (cost/spam guard).'),
  imageGenDailyLimit: z.number().step(1).min(1).max(100).default(20).description('Max image generations per chat per day.'),
  imageGenMaxPromptChars: z.number().step(1).min(10).max(1000).default(400).description('Max prompt characters (longer prompts are truncated).'),
  imageGenCommand: z.string().default('/画').description('Trigger command for image generation (e.g. "/画 一只蓝鲸在星空下喷水花").'),
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
