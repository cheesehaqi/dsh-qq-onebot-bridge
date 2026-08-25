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
  memoryEnabled: z.boolean().default(true).description('Persist a rolling window of each chat\'s recent conversation to <cwd>/qq-memory/ and re-inject it into new sessions after host restarts, so the bot remembers previous chats. /new clears the memory for that chat.'),
  memoryMaxEntries: z.number().step(1).min(1).max(100).default(30).description('Max conversation lines kept per chat in persistent memory.'),
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
