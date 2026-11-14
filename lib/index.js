/**
 * dsh-qq-onebot-bridge — bidirectional QQ ↔ DeepSeek Harness agent bridge
 * over the OneBot v11 protocol (reverse WebSocket).
 *
 * Install (web profile):
 *   dsh plugin --profile web add <path-to-this-directory>
 * Remove anytime:
 *   dsh plugin --profile web remove dsh-qq-onebot-bridge
 */
// Scoped on purpose: the unscoped `schemastery` is a DIFFERENT package and is not
// declared here — importing it only ever worked when another plugin happened to
// hoist it into the shared profile node_modules (see issue #1).
import z from '@deepseek-ai/schemastery'
import { QQBridge } from './bridge.js'
import { OneBotServer } from './onebot.js'
import { mountQqAiPanel, resolveProfile } from './settings-routes.js'
import { EXTENSION_SERVICE, attachExtensionService } from './extension.js'

/**
 * schema 里**面板会用到**的那几类默认值（布尔 / 数值 / 字符串数组）；Config 是 schemastery 对象。
 *
 * v0.6.8 起不止布尔：面板有数值控件（要标"默认 5"）和时段列表（要标"默认 9:00-12:00 / 14:00-18:00"），
 * 默认值一律从 schema 现读——面板里抄第二份，改一处忘另一处，界面就会显示错的"默认"。
 *
 * 导出是为了单测能拿到**真实**默认值（否则夹具里只有布尔，时段行的"默认"就永远显示不出来）。
 */
export function configDefaults() {
  const dict = Config?.dict ?? {}
  const out = {}
  for (const [key, schema] of Object.entries(dict)) {
    const type = String(schema?.type)
    const def = schema?.meta?.default
    if (type === 'boolean' && typeof def === 'boolean') out[key] = def
    else if (type === 'number' && typeof def === 'number') out[key] = def
    else if (type === 'array' && Array.isArray(def)) out[key] = def.slice()
  }
  return out
}

/**
 * 数值键的 `{ min, max, step, default }`——**从 schema 现读**，面板的数值控件只认这一份。
 *
 * 为什么要这样（v0.6.7）：面板里如果手抄一遍范围，改 schema 时忘了同步，界面就会允许写出
 * schema 会拒绝的值（宿主启动直接校验失败）。单测钉住"面板登记的每个数值键都能在这里找到"。
 */
export function numberMetaOf(schema = Config) {
  const dict = schema?.dict ?? {}
  const out = {}
  for (const [key, entry] of Object.entries(dict)) {
    if (String(entry?.type) !== 'number') continue
    const meta = entry?.meta ?? {}
    out[key] = {
      min: Number.isFinite(Number(meta.min)) ? Number(meta.min) : null,
      max: Number.isFinite(Number(meta.max)) ? Number(meta.max) : null,
      step: Number.isFinite(Number(meta.step)) && Number(meta.step) > 0 ? Number(meta.step) : 1,
      default: Number.isFinite(Number(meta.default)) ? Number(meta.default) : null,
    }
  }
  return out
}

export const name = 'dsh-qq-onebot-bridge'
export const inject = ['agents', 'agentDefaultModel']

export const Config = z.object({
  host: z.string().default('127.0.0.1').description('Reverse-WS listen host.'),
  port: z.number().step(1).min(1).max(65535).default(6700).description('Reverse-WS listen port. Point your OneBot implementation at ws://127.0.0.1:<port>.'),
  accessToken: z.string().role('secret').default('').description('Optional Bearer token the OneBot client must present.'),
  allowUsers: z.array(z.number().step(1)).default([]).description('Allowlisted QQ user ids for private chats. Empty = deny ALL private chats until you list your own QQ id (safe default).'),
  allowGroups: z.array(z.number().step(1)).default([]).description('Allowlisted QQ group ids. Empty = deny ALL group messages until you list the groups the bot should serve (safe default).'),
  allowUsersPrivateOnly: z.boolean().default(false).description('Apply allowUsers to PRIVATE chats only: when on, group messages are governed by allowGroups alone (the extra “sender must also be in allowUsers” check is skipped). Default off = previous behaviour.'),
  allowAllChats: z.boolean().default(false).description('Skip the allowlists entirely: answer every private chat and every group (groups still need an @-mention while replyOnlyWhenMentioned is on). Both lists above stop mattering while this is on.'),
  botQq: z.number().step(1).default(0).description('Bot QQ id used to detect @-mentions in groups (0 = treat every group message as mentioned).'),
  replyOnlyWhenMentioned: z.boolean().default(true).description('In groups, only respond when the bot is @-mentioned.'),
  quoteReplyEnabled: z.boolean().default(false).description('Quote the message being answered (QQ "reply" segment). Off by default: quoting changes how the group reads, and a message id can expire — such failures are retried once without the quote.'),
  longReplySplitOnPunctuation: z.boolean().default(true).description('When a reply exceeds maxMessageLength and has to be split, break at sentence punctuation first (then at commas, and only then mid-word). On by default; turn it off to fall back to a plain character-count cut. Only very long replies are affected.'),
  extensionToolsEnabled: z.boolean().default(false).description('EXPERIMENTAL (v0.7.0): let other plugins in the same host inject agent tools and prompt sections into every session through ctx.qqBridge.registerToolProvider(). Off by default — a prompt section costs tokens on every message and external tools are outside this project\'s maintenance scope. Additive only; a provider that throws is skipped and traced.'),
  taintDryRunEnabled: z.boolean().default(false).description('EXPERIMENTAL (v0.7.4): when an inbound message looks like a prompt-injection instruction ("ignore previous instructions", "print your system prompt", …), mark that chat for a while and turn every outbound write action into a dry-run (nothing reaches QQ). Question answering still runs; every blocked send is traced with the reason. Off by default — it suppresses real replies, so it must be an explicit choice.'),
  taintWindowMinutes: z.number().step(1).min(1).max(1440).default(30).description('How long the taint window lasts after an injection-looking message (minutes). Only used when taintDryRunEnabled is on.'),
  taintExtraPatterns: z.array(z.string()).default([]).description('EXPERIMENTAL (v0.7.8): extra prompt-injection patterns for the taint window. Each entry is a case-insensitive JS regular expression (max 200 chars, max 20 entries). They run only when taintDryRunEnabled is on, and only after the built-in eight missed. Invalid patterns are ignored and reported in the trace — never silently dropped.'),
  mentionAliases: z.array(z.string()).default([]).description('Names that also count as an @-mention when a QQ client sends the @ as PLAIN TEXT instead of an at-segment (e.g. "@MyBot /help"). The bot learns its own nickname and per-group card automatically; list aliases here to cover cases where that fails.'),
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
  forwardExpandEnabled: z.boolean().default(true).description('Expand merged-forward ("chat record") cards the bot receives: fetch the node list via get_forward_msg and hand the transcript to the agent instead of dropping the message (read-only).'),
  forwardMaxNodes: z.number().step(1).min(1).max(200).default(50).description('Max nodes taken from one merged-forward card when expanding it.'),
  forwardMaxChars: z.number().step(1).min(100).max(20000).default(4000).description('Max characters of an expanded merged-forward transcript handed to the agent.'),
  memberQueryEnabled: z.boolean().default(true).description('Member queries (read-only): /成员 lists the group roster and /成员 @someone shows one member\'s card, joined date, level and mute state.'),
  memberListLimit: z.number().step(1).min(1).max(200).default(20).description('How many members /成员 lists before truncating.'),
  friendListEnabled: z.boolean().default(false).description('Allow /好友 to list the bot\'s friends (default OFF: the friend list is private, and it is only accepted in private chats from an admin).'),
  historyQueryEnabled: z.boolean().default(true).description('Expose the qq_recent_history agent tool so the bot can read the last N messages of the current group/private chat (read-only).'),
  historyQueryLimit: z.number().step(1).min(1).max(100).default(20).description('How many messages qq_recent_history may fetch per call.'),
  reactToolEnabled: z.boolean().default(true).description('Expose the qq_react agent tool so the bot can attach an emoji reaction to a message (write action: goes through the action gate).'),
  leaveGroupEnabled: z.boolean().default(false).description('Allow the admin command /退群 to make the bot leave a group (default OFF; requires a second confirmation in chat).'),
  ocrEnabled: z.boolean().default(true).description('Image text recognition (read-only): /ocr reads the text out of an image the user sends or quotes (uses the NapCat ocr_image action).'),
  ocrMaxImages: z.number().step(1).min(1).max(5).default(3).description('How many images one /ocr call may recognize.'),
  groupFileEnabled: z.boolean().default(true).description('Group file browsing (read-only): /文件 lists the group file list and its folders /文件 <文件夹>.'),
  groupFileDownloadEnabled: z.boolean().default(true).description('Allow /取 <文件名> to download one group file into cwd/qq-files/ and hand it back to the requester in private (never posted into the group).'),
  groupFileListLimit: z.number().step(1).min(1).max(100).default(20).description('How many group files /文件 lists before truncating (also caps how many albums /相册 shows).'),
  groupFileMaxBytes: z.number().step(1).min(1024).default(52428800).description('Max size /取 will download (bytes, default 50 MiB).'),
  albumEnabled: z.boolean().default(true).description('Group album browsing (read-only): /相册 lists the group albums (NapCat get_qun_album_list).'),
  historyArchiveEnabled: z.boolean().default(true).description('Archive every allowlisted message into cwd/qq-history/YYYY-MM-DD.jsonl, so /找 can search far more history than the rotating qq-inbox.jsonl keeps. Injected/replayed frames are never archived.'),
  historyArchiveDir: z.string().default('').description('Archive directory (empty = cwd/qq-history).'),
  historyArchiveKeepDays: z.number().step(1).min(1).max(3650).default(90).description('Days of archived messages kept; older day files are MOVED to the local trash on host start, never deleted.'),
  historySearchEnabled: z.boolean().default(true).description('Enable /找 <keywords> (searches this chat\'s local archive) and the qq_search_history agent tool.'),
  historySearchDays: z.number().step(1).min(1).max(365).default(7).description('How many recent days /找 scans by default.'),
  historySearchLimit: z.number().step(1).min(1).max(100).default(20).description('Max hits /找 returns, and the default limit of the qq_search_history tool.'),
  webhookEnabled: z.boolean().default(false).description('Inbound webhook receiver (default OFF): an HTTP endpoint on 127.0.0.1 turns external events (GitHub, Uptime Kuma, any JSON service) into messages in a configured chat.'),
  webhookPort: z.number().step(1).min(1).max(65535).default(8798).description('Port of the inbound webhook receiver (bound to 127.0.0.1 only).'),
  webhookSources: z.array(z.object({
    name: z.string().description('Path segment: POST /hook/<name>.'),
    format: z.union(['github', 'uptime-kuma', 'generic']).default('generic').description('Payload dialect used to render the message.'),
    chat: z.string().default('').description('Destination chat: "g:<group id>" or "u:<user id>".'),
    token: z.string().role('secret').default('').description('Shared token (X-Webhook-Token header or ?token=). Either token or secret is required: an unauthenticated source is refused.'),
    secret: z.string().role('secret').default('').description('HMAC-SHA256 secret verified against X-Hub-Signature-256 (GitHub style).'),
    template: z.string().default('').description('generic only: template with {a.b.c} placeholders read from the payload.'),
    maxChars: z.number().step(1).min(50).max(4000).default(800).description('Max characters of the rendered message.'),
  })).default([]).description('Webhook sources; each one needs its own token or secret.'),
  webhookRatePerMinute: z.number().step(1).min(1).max(600).default(30).description('Per-source rate limit of the webhook receiver.'),
  webhookMaxBodyBytes: z.number().step(1).min(1024).max(1048576).default(65536).description('Max accepted webhook body size (larger requests are refused with 413).'),
  broadcastEnabled: z.boolean().default(false).description('Scheduled broadcasts (default OFF): push RSS feeds, weather or Minecraft status into a chat on a timer.'),
  broadcastJobs: z.array(z.object({
    id: z.string().description('Job id, used by /播报 测试 <id>.'),
    kind: z.union(['rss', 'weather', 'mc']).description('What this job fetches.'),
    chat: z.string().default('').description('Destination chat: "g:<group id>" or "u:<user id>".'),
    enabled: z.boolean().default(true).description('Set false to keep the job configured but paused.'),
    at: z.string().default('').description('Daily local time "HH:MM" (weekdays filters the days).'),
    weekdays: z.array(z.number().step(1)).default([]).description('0=Sunday .. 6=Saturday; empty = every day (used together with at).'),
    everyMinutes: z.number().step(1).default(0).description('Interval in minutes (min 5); takes precedence over at.'),
    url: z.string().default('').description('rss: feed URL.'),
    maxItems: z.number().step(1).min(1).max(20).default(5).description('rss: how many new items to post at most.'),
    keyword: z.string().default('').description('rss: only post items whose title/summary contains this keyword.'),
    latitude: z.number().default(999).description('weather: latitude (-90..90).'),
    longitude: z.number().default(999).description('weather: longitude (-180..180).'),
    name: z.string().default('').description('weather: display name of the place.'),
    address: z.string().default('').description('mc: host[:port] of the Minecraft server.'),
  })).default([]).description('Broadcast jobs (still off unless broadcastEnabled is true).'),
  broadcastStateFile: z.string().default('').description('Where broadcast dedupe/statistics are persisted (empty = cwd/qq-broadcast.json).'),
  autoHealEnabled: z.boolean().default(false).description('Auto-heal (default OFF): when the OneBot client disconnects, launch the configured command again. It only ever STARTS a process, never kills one.'),
  autoHealCommand: z.string().default('').description('Command auto-heal runs to bring the QQ client back (e.g. the NapCat launcher path/script).'),
  autoHealCooldownSeconds: z.number().step(1).min(30).max(3600).default(300).description('Minimum seconds between two auto-heal attempts.'),
  autoHealMaxPerHour: z.number().step(1).min(1).max(10).default(3).description('Hard cap of auto-heal attempts per hour.'),
  engageEnabled: z.boolean().default(false).description('Interaction pack (default OFF): poke back, typing status, emoji reactions, profile likes and mark-as-read. Every sub-switch below must also be on.'),
  pokeBackEnabled: z.boolean().default(false).description('Poke back with a REAL poke action (group_poke / friend_poke) instead of only replying with text.'),
  pokeBackText: z.string().default('').description('Optional line sent together with the poke-back (empty = poke only, no message).'),
  pokeCommandEnabled: z.boolean().default(false).description('Allow the admin command /戳 <@user|QQ号> to poke someone on purpose (rate limited per hour).'),
  pokePerHour: z.number().step(1).min(1).max(60).default(5).description('Hard cap of outgoing pokes per chat per hour.'),
  typingEnabled: z.boolean().default(false).description('Show a "typing" status in PRIVATE chats while the model is working (set_input_status; the probe showed NapCat has no group equivalent).'),
  emojiLikeEnabled: z.boolean().default(false).description('React to incoming messages with an emoji (set_msg_emoji_like) instead of sending text.'),
  emojiLikeId: z.string().default('128077').description('Which emoji to react with: decimal unicode code point (128077 = 👍).'),
  emojiLikeMentionOnly: z.boolean().default(true).description('Only react when the bot was mentioned or quoted, so the group stays quiet.'),
  emojiLikePerHour: z.number().step(1).min(1).max(200).default(20).description('Hard cap of emoji reactions per chat per hour.'),
  reactionStatsEnabled: z.boolean().default(false).description('Record group emoji reactions (notice group_msg_emoji_like) and expose /赞榜 and /谁赞了.'),
  reactionStatsFile: z.string().default('').description('Where reaction statistics and interaction quotas are persisted (empty = cwd/qq-engage.json).'),
  sendLikeEnabled: z.boolean().default(false).description('Allow /点赞 [@user|QQ号] to send QQ profile likes (default OFF).'),
  sendLikeTimes: z.number().step(1).min(1).max(10).default(10).description('How many likes one /点赞 sends (the QQ client caps this at 10).'),
  sendLikePerDay: z.number().step(1).min(1).max(30).default(3).description('Hard cap of /点赞 per target per day.'),
  markReadEnabled: z.boolean().default(false).description('Mark incoming chats as read (mark_group_msg_as_read / mark_private_msg_as_read) so the account stops showing unread badges.'),
  markReadPerMinute: z.number().step(1).min(1).max(120).default(10).description('Hard cap of mark-as-read calls per minute (NapCat marks a whole chat, not a single message).'),
  groupOpsEnabled: z.boolean().default(false).description('Group operations toolbox (default OFF): native group check-in, @all quota, mute list, batch kick, group todos, group profile, file organisation, album upload and a weekly ops report. Every sub-switch below must also be on.'),
  nativeSignEnabled: z.boolean().default(false).description('Enable /群打卡: the REAL QQ group check-in (set_group_sign), separate from the local streak game behind /签到.'),
  opsReadEnabled: z.boolean().default(true).description('Enable the read-only ops queries once groupOpsEnabled is on: /全体余量, /禁言名单, /群资料, /入群通知.'),
  opsKickEnabled: z.boolean().default(false).description('Enable /批量踢 (set_group_kick_members, admin, batch confirm) — kicks several members in one native call.'),
  opsKickBatchSize: z.number().step(1).min(1).max(20).default(20).description('How many members one batch-kick request carries (larger lists are split, never truncated).'),
  opsTodoEnabled: z.boolean().default(false).description('Enable group todos: /待办, /完成待办, /取消待办 on a quoted message (set/complete/cancel_group_todo).'),
  opsFileEnabled: z.boolean().default(false).description('Enable file organisation: /移动文件, /重命名文件, /删文件, /新建文件夹 (move/rename/delete_group_file, create_group_file_folder). Destructive, so it is off by default and admin-only.'),
  opsAlbumUploadEnabled: z.boolean().default(false).description('Enable /传图: upload a quoted image into a group album (upload_image_to_qun_album).'),
  opsProfileEnabled: z.boolean().default(false).description('Enable group profile edits: /群名 and /群备注 (set_group_name, set_group_remark). Admin only.'),
  opsPolicyEnabled: z.boolean().default(false).description('Enable join/speak policy: /成员权限 (set_group_member_permissions, partial update) and /历史可见 (set_group_new_member_history_visibility). Admin only.'),
  opsAdminEnabled: z.boolean().default(false).description('Enable /设管理 and /撤管理 (set_group_admin). Needs groupOpsEnabled. The enable flag is ALWAYS sent explicitly: the probe showed NapCat treats a missing enable as false, i.e. silently demotes the member. Admin only.'),
  opsInvitePolicyEnabled: z.boolean().default(false).description('Enable /邀请策略 (set_group_member_invite_policy) with the four documented values: disabled / require_approval / no_approval / no_approval_under_100. Needs groupOpsEnabled. Admin only.'),
  opsAddOptionEnabled: z.boolean().default(false).description('Enable /加群方式 (set_group_add_option). Needs groupOpsEnabled. add_type is a raw QQ number with NO documented enum, so /群搜索 (no_*_finger_open) is deliberately not implemented; question/answer are only sent for 4 and 5. Admin only.'),
  requestSyncEnabled: z.boolean().default(false).description('Enable /申请: actively pull pending join requests (get_group_system_msg) and doubtful friend requests (get_doubt_friends_add_request) into the approval queue, so requests that arrived while nobody was watching are not lost. Needs groupOpsEnabled + verifyEnabled (verifyEnabled is what provides the /同意 and /拒绝 commands; without it /申请 only previews the list). Admin only.'),
  requestSyncCount: z.number().step(1).min(1).max(100).default(50).description('How many notifications /申请 pulls per call. Capped at 100 on purpose: NapCat resolves an approval flag by searching only the newest 100 notifications (set_group_add_request never sends a count), so entries pulled beyond that could never be approved.'),
  adminWatchEnabled: z.boolean().default(false).description('Watch group_admin notices: tell the chat when the bot gains or loses group admin. The known state is tracked either way, so write commands can report "I am not an admin any more" instead of failing at the API.'),
  opsReportEnabled: z.boolean().default(false).description('Enable /周报 and the ops counters that feed it (messages, joins, leaves, kicks, mutes, sign-ins, reactions).'),
  opsReportDays: z.number().step(1).min(1).max(90).default(7).description('Window of /周报 in days.'),
  opsCountersFile: z.string().default('').description('Where the ops counters for /周报 are persisted (empty = cwd/qq-ops.json).'),
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
  keywordWatchEnabled: z.boolean().default(false).description('Keyword watch (default OFF, groups only): members can /订阅 关键词 and the bot privately messages them when that word appears in the group (excluding their own messages, 5-minute cooldown per watch, max 20 per member/chat).'),
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
  outboundRedactEnabled: z.boolean().default(false).description('EXPERIMENTAL (v0.7.9) "defence three": before sending, mask secrets in outbound text (OpenAI-style sk- keys, GitHub tokens, AWS keys, Slack tokens, JWTs, Bearer headers, PRIVATE KEY blocks). Off by default like every guard. QQ numbers, phone numbers and URLs are deliberately NOT touched.'),
  outboundRedactBlock: z.boolean().default(false).description('When outbound redaction matches: false = mask and send, true = drop the whole message and trace it. Masking is the default because dropping a reply can look like the bot is broken.'),
  outboundRedactPatterns: z.array(z.string()).default([]).description('Extra outbound redaction patterns: case-insensitive JS regexes (max 20 entries, 200 chars each). Meant for your own secret formats. Invalid regexes are skipped and traced, never silently dropped.'),
  floodEnabled: z.boolean().default(false).description('Anti-flood (default OFF): too many messages in a short window earn a warning, then a mute.'),
  floodWindowSeconds: z.number().step(1).min(1).max(600).default(10).description('Sliding window used by the anti-flood guard.'),
  floodMaxMessages: z.number().step(1).min(2).max(200).default(8).description('Messages allowed per window before the guard reacts.'),
  floodMuteSeconds: z.number().step(1).min(10).max(86400).default(300).description('Mute duration applied when the flood guard escalates.'),
  floodStrikeLimit: z.number().step(1).min(1).max(20).default(3).description('Warnings before the flood guard mutes a member.'),
  /**
   * v0.6.7 风控：**每分钟会话上限**（用户 2026-10-16 要的：最大 10、默认值 5、最低 1）。
   *
   * ⚠️ **默认不开启**（用户 2026-10-16 当场纠正过：`chatTurnsPerMinute` 的"默认 5"是**数值**默认，
   * 不是"默认生效"）：`chatTurnLimitEnabled` 关着时完全不限流，打开后才按 `chatTurnsPerMinute` 生效。
   * 这样升级上来的忙群行为不变（与 `floodEnabled` / `rateLimitEnabled` 同一口径：激进的守卫默认关）。
   *
   * 与 `rateLimitMaxReplies` 是两件事：那个管"每个窗口回多少条"（出站），
   * 这个管"每分钟最多让几条消息进模型"（入站，模型额度与响应速度的真正瓶颈）。
   * 超出的一律**丢弃并记账**（不排队）——排队只会在窗口过后集体爆发，反而更糟。
   */
  chatTurnLimitEnabled: z.boolean().default(false)
    .description('Risk control (default OFF): enable the per-minute turn cap below. When off, nothing is dropped.'),
  chatTurnsPerMinute: z.number().step(1).min(1).max(10).default(5)
    .description('Per-minute turn cap used when chatTurnLimitEnabled is on: max model turns per chat per minute (1-10, default 5). Extra messages within that minute are dropped with a trace reason; they are not queued.'),
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
  sttEnabled: z.boolean().default(false).description('DSH SHIPS STT: the experimental voice-input bundle provides local transcription (SenseVoice; the model downloads on first use) and must be enabled in the profile - or point sttBaseUrl at your own OpenAI-compatible service. Speech-to-text: when the bot is @-mentioned in a group (or anytime in private) and the message quotes (replies to) a voice message, transcribe the quoted voice and reply with its text. Private voice messages sent directly are also transcribed (regardless of acceptPrivate).'),
  sttProvider: z.union(['dsh', 'cloud']).default('dsh').description('Where transcription happens. dsh (default): the host service speechToText from DSH\'s experimental voice-input bundle - local SenseVoice, nothing leaves the machine, no API key needed. cloud: POST the audio to sttBaseUrl/audio/transcriptions with sttApiKey (Zhipu GLM-ASR or any OpenAI-compatible endpoint).'),
  sttLanguage: z.string().default('auto').description('Language hint for the DSH local recogniser: auto | zh | en | yue | ja | ko (auto lets SenseVoice decide, which also copes with mixed speech). Only used when sttProvider is dsh.'),
  sttBaseUrl: z.string().default('https://open.bigmodel.cn/api/paas/v4').description('STT base URL of an OpenAI-compatible /audio/transcriptions endpoint (Zhipu GLM-ASR or SiliconFlow). Only used when sttProvider is cloud.'),
  sttModel: z.string().default('glm-asr-2512').description('STT model id (Zhipu: glm-asr-2512; SiliconFlow: FunAudioLLM/SenseVoiceSmall).'),
  sttApiKey: z.string().role('secret').default('').description('STT API key (Zhipu key can be shared with DeepEye).'),
  privateImageView: z.boolean().default(true).description('In private chats, proactively download images/animated stickers the user sends (to cwd/qq-images) so the agent can view them with describe_image and respond.'),
  videoEnabled: z.boolean().default(false).description('EXPERIMENTAL: QQ video understanding. Private chats: a video is processed automatically; groups: the user must quote/reply to a video and @ the bot with /看视频. Local ffmpeg extracts frames + contact sheets (no cloud); contact sheets are attached to the agent if visionMode=native, otherwise saved for visionToolName. Off by default — it downloads video and adds images to the model context.'),
  videoMaxSeconds: z.number().step(1).min(1).max(600).default(60).description('Only the first N seconds of a long video are analysed (frames/audio), so a group cannot burn the context with a movie.'),
  videoFrames: z.number().step(1).min(2).max(24).default(12).description('How many frames the built-in local analyser extracts (2–24). More frames catch faster action but cost more context.'),
  videoMaxBytes: z.number().step(1).min(1048576).max(209715200).default(104857600).description('Maximum downloaded video size in bytes (default 100 MB); larger videos are rejected with a reason instead of filling the disk.'),
  videoPeekCommand: z.string().default('').description('Optional external video analyser command (replaceable). It is called with --input <file> --out <dir> --frames N --ffmpeg <path> --max-seconds N [--start S --duration S] and must write <out>/manifest.json with frames/contactSheets; an optional description field is passed to the model (lets a text-only model use a VLM wrapper). Empty = built-in local analyser.'),
  videoProvider: z.union(['local', 'command', 'qwen', 'gemini']).default('local').description('Where the final video description comes from. local = only frames/contact sheets, model sees them via videoVisionMode; command = external videoPeekCommand must write a description; qwen = OpenAI-compatible vision chat using the contact sheets; gemini = native video upload via Google Files API + generateContent.'),
  videoApiBase: z.string().default('').description('Provider API base URL. qwen: e.g. https://dashscope.aliyuncs.com/compatible-mode/v1 (empty = this default); gemini: https://generativelanguage.googleapis.com (empty = this default).'),
  videoApiModel: z.string().default('').description('Provider model id. qwen: e.g. qwen-vl-max; gemini: e.g. gemini-2.0-flash (empty = provider default).'),
  videoApiKey: z.string().role('secret').default('').description('Provider API key (secret; control console never echoes it back). qwen uses DashScope key; gemini uses a Google AI Studio key.'),
  videoPrompt: z.string().default('').description('Optional prompt for the external video model. Empty = a built-in Chinese prompt asking for a timestamped description of what happens, including any speech/audio cues.'),
  videoVisionMode: z.union(['native', 'tool']).default('tool').description('How video contact sheets reach the model: native = attach them as image content (needs a vision-capable provider/model); tool = only save paths and tell the model to use visionToolName (works with text-only models if that tool exists). Change provider/model to swap the vision model itself.'),
  visionMode: z.union(['tool', 'native']).default('tool').description('How the agent views images: tool = save images to disk and let the agent view them via visionToolName; native = attach images as native multimodal attachments (DSH 0.1.1+ attachment seam; text-only models degrade to placeholders automatically).'),
  visionToolName: z.string().default('describe_image').description('Vision tool the agent uses when visionMode is tool (e.g. describe_image).'),
  imageRetentionDays: z.number().step(1).min(1).max(365).default(14).description('Days downloaded images/videos/exports (qq-images, qq-replies, qq-videos, qq-exports) are kept before cleanup on host start.'),
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
  summaryEnabled: z.boolean().default(true).description('Enable /summary [N] (alias /总结 [N]): summarize the last N messages of this chat from the local archive, falling back to persisted session memory. N is 1–200, default 30.'),
  voteEnabled: z.boolean().default(true).description('Enable group votes: "投票：问题？A 选项 B 选项"; members reply with option letters; /vote /vote-end manage it.'),
  signupEnabled: z.boolean().default(false).description('Enable group activity sign-up (default OFF): /报名 活动名 starts, /报名 joins, /报名列表, /取消报名, /报名结束 (creator or admin). One active signup per chat, max 100 entries.'),
  voteDurationSeconds: z.number().step(1).min(10).max(3600).default(300).description('Default vote duration before results publish.'),
  todoEnabled: z.boolean().default(true).description('Enable shared todos: /todo add|list|done|clear and "记一下：xxx"; stored per chat in cwd/qq-todos/.'),
  ttsEnabled: z.boolean().default(false).description('NOT BUNDLED: dsh and this plugin ship no TTS service - you must provide your own (local software or a third-party key). Voice replies via TTS (default provider: Azure Speech; off until you set ttsApiKey and flip this on). A voice message follows each text reply.'),
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
  // Default OFF: this one needs an EXTRA service (a working TTS provider — local GPT-SoVITS or a cloud
  // key). Features that require installing something ship off, so a fresh install is usable without it.
  voiceReadingEnabled: z.boolean().default(false).description('NOT BUNDLED: needs a TTS provider you install or pay for. Voice reading (default OFF because it needs an extra service: a working TTS provider, see ttsProvider): "@bot + quote a text message saying 读一下/念出来" or "/读 <text>" — the bot reads the text aloud via TTS.'),
  checkinEnabled: z.boolean().default(false).description('Daily check-in (default OFF): group members say the keyword (default 签到) to check in; streak and total days are persisted per chat (cwd/qq-checkin/); 签到榜 shows the leaderboard.'),
  checkinKeyword: z.string().default('签到').description('Check-in trigger keyword.'),
  welcomeEnabled: z.boolean().default(false).description('Welcome new members (default OFF): when someone joins an allowlisted group (notice group_increase), @-mention them with the welcome text.'),
  welcomeText: z.string().default('').description('Welcome message template (empty = built-in default).'),
  fileTransferEnabled: z.boolean().default(true).description('In private chats, save files the user sends to cwd/qq-files/ and reply with the local path.'),
  fileTransferMaxBytes: z.number().step(1).min(1).default(52428800).description('Max accepted file size for private file transfer (default 50 MiB).'),
  exportEnabled: z.boolean().default(true).description('Enable /导出 [days] [md|csv|json] (alias /export): export this chat\'s archived messages (last N days) to a markdown/csv/json file under cwd/qq-exports/ and send it back. Groups require an adminUsers member and the file is sent privately.'),
  notifyEnabled: z.boolean().default(false).description('Status push notifications (default OFF): the host pushes bot online/offline events to a push service (PushPlus or any JSON webhook) without going through QQ, so you learn about outages even when the bot is offline.'),
  notifyPushUrl: z.string().default('').description('Push endpoint URL (defaults to PushPlus http://www.pushplus.plus/send when empty but notifyToken is set; can be any JSON webhook).'),
  notifyToken: z.string().role('secret').default('').description('PushPlus token (or the token field of a custom webhook payload).'),
  notifyCooldownSeconds: z.number().step(1).min(30).max(3600).default(300).description('Min seconds between status notifications (anti-flood for flapping connections).'),
  gifFrameExtract: z.boolean().default(true).description('Extract the first frame of GIF images via ffmpeg into PNG before handing them to the vision path (animated stickers become stably viewable).'),
  ffmpegPath: z.string().default('ffmpeg').description('Path to the ffmpeg executable for GIF frame extraction (empty PATH name is fine when ffmpeg is on PATH).'),
  quietHoursEnabled: z.boolean().default(false).description('Avoid peak hours (default OFF): while enabled, the bot does not reply to ANY inbound message during the quiet windows on weekdays (scheduled reminders and vote publishing still fire).'),
  quietHours: z.array(z.string()).default(['9:00-12:00', '14:00-18:00']).description('Quiet windows as local-time "H:MM-H:MM" ranges (full-width colons are normalized).'),
  quietWeekendExempt: z.boolean().default(true).description('Do not apply quiet hours on Saturdays and Sundays.'),
  imageGenEnabled: z.boolean().default(false).description('NOT BUNDLED: dsh and this plugin ship no image generation service - you must provide your own (a locally hosted backend or a third-party key). Image generation (default OFF): "/画 <描述词>" generates an image and sends it back (group usage requires @-mentioning the bot). Extensible provider backends, same contract as TTS.'),
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
  /**
   * 端口被占时的行为（v0.5.9，官方桌面端兼容）。
   *
   * web 宿主与官方桌面端（Electron，同一份 `~/.dsh` 配置、同一个 OneBot 端口）可能同时在跑，
   * 两边都想监听 6700 时**必然有一边绑不上**。旧实现会未捕获抛错 + 启动卡死，
   * 现在改成：如实报告 → 后台退避重试 → 端口释放后自动接管。
   * 绑不上时不启动桥（避免"两个实例都在跑定时任务/回消息"的假象）。
   */
  await ctx.effect(async () => {
    const RETRY_MS = 15_000
    let stopped = false
    let retryTimer = null
    let bridgeStarted = false
    let attempts = 0
    /** 稳态（另一个实例一直占着端口）下不能每 15 秒刷一条 error：只在第 1 次与每 10 分钟各记一条。 */
    const LOG_EVERY = Math.max(1, Math.round(600_000 / RETRY_MS))

    const tryServe = async () => {
      if (stopped) return
      attempts += 1
      const result = await server.start()
      if (stopped) {
        await server.stop().catch(() => {})
        return
      }
      if (result.ok === true) {
        try {
          bridge.start()
        } finally {
          // 无论 start() 是否中途抛错都算"动过了"：dispose 必须去 stop 它，
          // 否则会留下半初始化的桥（定时器/订阅还在，dispose 却不再管）。
          bridgeStarted = true
        }
        logger.info(`QQ bridge ready: reverse-WS ws://${config.host}:${config.port}`)
        return
      }
      const hint = result.code === 'EADDRINUSE'
        ? `端口 ${config.port} 已被另一个进程占用：同一台机器上「web 宿主」与「官方桌面端」只允许一个实例托管 QQ 桥，`
          + '另一个实例会在端口释放后自动接管（用控制台的端口摘要，或 `netstat -ano | findstr :' + config.port + '` 找占用者）。'
        : `将在 ${Math.round(RETRY_MS / 1000)} 秒后重试。`
      if (attempts === 1 || attempts % LOG_EVERY === 0) {
        logger.error(`QQ bridge 未启动（第 ${attempts} 次）：无法监听 ws://${config.host}:${config.port}`
          + `（${result.code || '未知错误'}）：${result.reason}。${hint}`)
      }
      retryTimer = setTimeout(() => {
        // 重试回调里绝不能漏 catch：未处理的 rejection 在 Node CLI 宿主上是致命的。
        void tryServe().catch((error) => logger.error(`QQ bridge 重试异常：${error?.message ?? error}`))
      }, RETRY_MS)
      if (typeof retryTimer.unref === 'function') retryTimer.unref()
    }

    await tryServe()
    return async () => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      if (bridgeStarted) bridge.stop()
      await server.stop()
      logger.info('QQ bridge stopped')
    }
  }, 'dsh-qq-onebot-bridge.serve')

  /**
   * v0.7.0 扩展接缝：把桥的能力挂成宿主服务 `ctx.qqBridge`（受控发送 + 只读快照 + 实验性的工具 provider 注册）。
   *
   * 挂不上（宿主既没有 `ctx.set` 也没有 `ctx.provide`）只记一条 info —— 扩展口少一个入口，
   * 绝不能影响 QQ 桥本身。事件那条路（`ctx.on('qqbridge:inbound'/'outbound')`）不依赖它。
   */
  const extensionApi = bridge.createExtensionApi()
  const attached = attachExtensionService(ctx, extensionApi)
  // 把挂载结果留在桥上：面板「实验性」组要显示"出口挂上了没有 / 走哪条机制"。
  bridge.extensionMount = attached
  if (attached.ok === true) {
    logger.info(`扩展出口已挂载：ctx.${EXTENSION_SERVICE}（via ${attached.via}）`)
  } else {
    logger.info(`扩展出口未挂到 ctx（${attached.reason}）；同进程插件仍可用 getExtensionApi() + ctx.on('qqbridge:*')`)
  }
  // 挂载结果写进 trace（调试台的「实时事件」里能直接看到，不用翻宿主控制台）。
  try {
    bridge.trace?.event({
      id: '', module: 'extension', stage: 'extension', level: attached.ok === true ? 'info' : 'warn', ok: attached.ok === true,
      reason: attached.ok === true
        ? `扩展出口已挂载：ctx.${EXTENSION_SERVICE}（via ${attached.via}）`
        : `扩展出口未挂到 ctx：${attached.reason}（降级到模块级注册表 + 事件总线）`,
    })
  } catch { /* trace 写不了也不能影响启动 */ }

  /**
   * v0.6「轻量化设计」：把「QQ助手」面板挂进 DSH 设置。
   *
   * - 服务端：往宿主 HTTP 服务注册两条路由（`GET /qqai/panel`、`POST /qqai/panel/set`），
   *   客户端 bundle（client/client.js）用 fetch 调它们。契约与已装插件（dshmarket）一致。
   * - 用 `ctx.inject(['webServer'], …)` 而不是在 apply 里直接拿：TUI 等没有 webServer 的
   *   宿主上这段**根本不会执行**，插件照常工作（面板只是没有入口而已）。
   * - 任何失败都只记一条 warn：绝不能因为"面板挂不上"影响 QQ 桥本身。
   */
  ctx.inject(['webServer'], (hostCtx) => {
    try {
      const resolved = resolveProfile()
      if (resolved.source === 'fallback') {
        logger.warn('QQ助手面板：没能从宿主命令行认出 profile，按 web 处理'
          + `（面板顶行会显示它要写的文件：${resolved.profile}）`)
      }
      hostCtx.effect(() => mountQqAiPanel(hostCtx, {
        profile: resolved.profile,
        dir: resolved.dir ?? null,
        config,
        defaults: configDefaults(),
        // 数值型控件的范围/步长（schema 现读，面板不抄第二份）。
        numberMeta: numberMetaOf(),
        // 扩展接缝的**运行时**状态（挂载结果 / provider 列表 / 最近一次注入）：只有桥实例知道。
        bridge,
        logger,
      }), 'dsh-qq-onebot-bridge: QQ助手面板路由')
    } catch (error) {
      logger.warn(`QQ助手面板未挂载（不影响 QQ 桥）：${error?.message ?? error}`)
    }
  })
}
