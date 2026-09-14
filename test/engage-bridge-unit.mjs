/**
 * Bridge-level tests for the v0.5.3 interaction pack ("点一下就完事"):
 * poke back / typing status / emoji reaction / profile like / mark-as-read —
 * i.e. the wiring that lives in lib/bridge.js, NOT the module-level unit tests
 * of lib/engage.js (that author ships its own).
 *
 * Every OneBot action name and parameter shape asserted here was confirmed by the
 * REAL-DEVICE static probe of the installed NapCat bundle (bootmain/napcat.mjs,
 * QQ 9.9.32-50969) — see the header of lib/engage.js for the full probe result.
 * The probe also proved this build CANNOT send inline keyboard buttons, which is
 * why there is no button feature here.
 *
 * The skeleton follows test/unattended-unit.mjs: MockServer extends EventEmitter,
 * the REAL QQBridge runs against it, frames are injected with server.emit, and
 * outgoing calls are read back from the mock. No DSH host, no network, no model.
 *
 * The red line this file exists to guard: every new write API must produce
 * **zero outbound frames** during an injected / replayed turn, and every blocked
 * branch must leave a trace entry with a TRUE reason.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { Config } from '../lib/index.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
function brief(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, 220)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.calls = []
    this.dryRunCalls = []
    this.dryRun = false
    this.dryRunScope = null
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
    this.emojiLikesResult = { emoji_like_list: [] }
    this.emojiLikeError = null
  }

  #rec(action, params) { this.calls.push({ action, params }) }
  count(action) { return this.calls.filter((call) => call.action === action).length }
  paramsOf(action) { return this.calls.filter((call) => call.action === action).map((call) => call.params) }
  reset() { this.calls.length = 0; this.sent.length = 0; this.dryRunCalls.length = 0 }
  currentSocket() { return this.socket }

  /**
   * Faithful copy of the real OneBotServer's dry-run rule: a call is intercepted when
   * dry-run is on AND the params carry the scoped chat key. Calls WITHOUT a chat key
   * (set_msg_emoji_like / mark-*-as-read by message id) fall through — which is exactly
   * why lib/bridge.js has to self-check those, and why this mock must model it.
   */
  #inDryRunScope(params) {
    if (this.dryRun !== true) return false
    if (!this.dryRunScope) return true
    const scope = this.dryRunScope
    if (scope.groupId !== undefined && params && params.group_id !== undefined && String(params.group_id) === String(scope.groupId)) return true
    if (scope.userId !== undefined && params && params.user_id !== undefined && String(params.user_id) === String(scope.userId)) return true
    return false
  }

  setDryRun(enabled, scope = null) {
    this.dryRun = enabled === true
    this.dryRunScope = scope ?? null
    return { enabled: !enabled, scope: this.dryRunScope }
  }
  takeDryRunCalls() { return this.dryRunCalls }

  #write(action, params) {
    if (this.#inDryRunScope(params)) {
      this.dryRunCalls.push({ action, params })
      return true
    }
    return false
  }

  sendSegments(_bot, messageType, targetId, segments) {
    this.#rec('send_msg', { messageType, targetId, segments })
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: this.sent.length })
  }

  sendText(_bot, messageType, targetId, text) {
    return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  // ---- v0.5.3 interaction APIs (names verified against the real NapCat build) ----
  groupPoke(_socket, groupId, userId) {
    const params = { group_id: Number(groupId), user_id: Number(userId) }
    if (!this.#write('group_poke', params)) this.#rec('group_poke', { groupId: Number(groupId), userId: Number(userId) })
    return Promise.resolve(null)
  }

  friendPoke(_socket, userId) {
    const params = { user_id: Number(userId) }
    if (!this.#write('friend_poke', params)) this.#rec('friend_poke', { userId: Number(userId) })
    return Promise.resolve(null)
  }

  setInputStatus(_socket, userId, eventType) {
    const params = { user_id: String(userId), event_type: Number(eventType) }
    if (!this.#write('set_input_status', params)) this.#rec('set_input_status', { userId: String(userId), eventType: Number(eventType) })
    return Promise.resolve(null)
  }

  sendLike(_socket, userId, times) {
    const params = { user_id: String(userId), times: Number(times) }
    if (!this.#write('send_like', params)) this.#rec('send_like', { userId: String(userId), times: Number(times) })
    return Promise.resolve(null)
  }

  markGroupMsgAsRead(_socket, groupId) {
    const params = { group_id: String(groupId) }
    if (!this.#write('mark_group_msg_as_read', params)) this.#rec('mark_group_msg_as_read', { groupId: String(groupId) })
    return Promise.resolve(null)
  }

  markPrivateMsgAsRead(_socket, userId) {
    const params = { user_id: String(userId) }
    if (!this.#write('mark_private_msg_as_read', params)) this.#rec('mark_private_msg_as_read', { userId: String(userId) })
    return Promise.resolve(null)
  }

  setMsgEmojiLike(_socket, messageId, emojiId) {
    // 真机的 set_msg_emoji_like 只带 message_id → scoped dry-run 拦不住，这里如实建模
    const params = { message_id: Number(messageId), emoji_id: Number(emojiId) }
    if (!this.#write('set_msg_emoji_like', params)) this.#rec('set_msg_emoji_like', { messageId, emojiId })
    return Promise.resolve({ ok: true })
  }

  getEmojiLikes(_socket, messageId, emojiId, options) {
    this.#rec('get_emoji_likes', { messageId, emojiId, options })
    if (this.emojiLikeError) return Promise.reject(this.emojiLikeError)
    return Promise.resolve(this.emojiLikesResult)
  }

  // harmless stubs
  getMsg() { return Promise.resolve({ message: [] }) }
  sendForwardMsg() { return Promise.resolve({ message_id: 1 }) }
  uploadFile() { return Promise.resolve({}) }
  deleteMsg() { return Promise.resolve({}) }
  sendGroupNotice() { return Promise.resolve({}) }
  setGroupWholeBan() { return Promise.resolve({}) }
  setGroupBan() { return Promise.resolve({}) }
  setGroupKick() { return Promise.resolve({}) }
  setGroupLeave() { return Promise.resolve({}) }
  getForwardMsg() { return Promise.resolve({ messages: [] }) }
  getGroupMemberList() { return Promise.resolve([]) }
  getGroupInfo() { return Promise.resolve({}) }
  getFriendList() { return Promise.resolve([]) }
}

/** Config keys pinned so no scenario depends on another's defaults. Engage pack OFF unless a scenario turns it on. */
const QUIET_BASE = {
  host: '127.0.0.1',
  port: 0,
  accessToken: '',
  allowUsers: [1001],
  allowGroups: [2002],
  botQq: 999,
  botName: '小鲸鱼',
  replyOnlyWhenMentioned: true,
  acceptPrivate: true,
  sessionMode: 'chat',
  sessionResumeEnabled: false,
  quietHours: [],
  quietHoursEnabled: false,
  notifyEnabled: false,
  injectEnabled: false,
  injectDryRun: true,
  recordInbound: false,
  traceEnabled: true,
  traceLevel: 'debug',
  traceMemorySize: 2000,
  actionAuditEnabled: false,
  adminEnabled: true,
  adminUsers: [1001],
  engageEnabled: false,
  pokeBackEnabled: false,
  pokeBackText: '',
  pokeCommandEnabled: false,
  pokePerHour: 5,
  typingEnabled: false,
  emojiLikeEnabled: false,
  emojiLikeId: '128077',
  emojiLikeMentionOnly: true,
  emojiLikePerHour: 20,
  reactionStatsEnabled: false,
  sendLikeEnabled: false,
  sendLikeTimes: 10,
  sendLikePerDay: 3,
  markReadEnabled: false,
  markReadPerMinute: 10,
  // keep the rest of the pipeline narrow
  webhookEnabled: false,
  broadcastEnabled: false,
  autoHealEnabled: false,
  keywordEnabled: false,
  fortuneEnabled: false,
  diceEnabled: false,
  pointsEnabled: false,
  statsEnabled: false,
  checkinEnabled: false,
  gameEnabled: false,
  reminderEnabled: false,
  recurringReminderEnabled: false,
  todoEnabled: false,
  voteEnabled: false,
  summaryEnabled: false,
  exportEnabled: false,
  dailyReportEnabled: false,
  mcStatusEnabled: false,
  imageGenEnabled: false,
  ttsEnabled: false,
  sttEnabled: false,
  voiceReadingEnabled: false,
  verifyEnabled: false,
  filterEnabled: false,
  floodEnabled: false,
  antiRecallEnabled: false,
  welcomeEnabled: false,
  pokeEnabled: false,
  autoCollectStickers: false,
  faceEnabled: false,
  privateImageView: false,
  fileTransferEnabled: false,
  agentMediaToolsEnabled: false,
  memoryEnabled: false,
  rateLimitEnabled: false,
}

const dirs = []
function freshCwd() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-engage-test-'))
  dirs.push(dir)
  return dir
}

function makeBridge(overrides = {}) {
  const cwd = overrides.cwd ?? freshCwd()
  const server = new MockServer()
  const tools = []
  const turns = []
  let seq = 0

  const makeCtx = () => {
    const agentCtx = {
      tools: { register: (tool) => { tools.push(tool); return tool } },
      systemPrompt: { section: (section) => section },
    }
    const newHandle = (sessionId, setup) => {
      const id = String(sessionId || `qq-engage-${++seq}`)
      if (typeof setup === 'function') setup(agentCtx)
      return {
        agent: {
          id,
          status: 'idle',
          followup(message) {
            const blocks = Array.isArray(message?.content) ? message.content : []
            turns.push({ sessionId: id, text: blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('') })
            return Promise.resolve()
          },
          cancel() {},
        },
        sessionId: id,
        dispose: async () => {},
      }
    }
    return {
      on: () => () => {},
      get: () => undefined,
      agents: {
        create: async ({ sessionId, setup }) => newHandle(sessionId, setup),
        resume: async ({ resumeSessionId, setup }) => newHandle(resumeSessionId, setup),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
      logger: () => ({ info() {}, warn() {}, error() {} }),
    }
  }

  const config = { ...Config({}), ...QUIET_BASE, ...overrides, cwd }
  const bridge = new QQBridge(makeCtx(), config, server, { info() {}, warn() {}, error() {} })
  bridge.start()

  let seqMsgId = 0
  function message(text, extra = {}) {
    return {
      bot: server.socket,
      userId: 1001,
      messageType: 'group',
      groupId: 2002,
      text,
      atMe: true,
      ats: [],
      reply: null,
      records: [],
      images: [],
      files: [],
      forwards: [],
      messageId: String(9000 + (++seqMsgId)),
      senderName: '小明',
      raw: { message: [] },
      ...extra,
    }
  }
  const groupMessage = (text, extra = {}) => message(text, extra)
  const privateMessage = (text, extra = {}) => message(text, { messageType: 'private', groupId: undefined, atMe: false, ...extra })

  async function send(msg, waitMs = 140) {
    const before = server.sent.length
    server.emit('message', msg)
    await sleep(waitMs)
    return server.sent.slice(before)
      .map((item) => item.segments.map((segment) => segment.data?.text ?? `[${segment.type}]`).join(''))
      .join('\n')
  }

  const traceStage = (stage, ok = null) => bridge.trace.recent({ limit: 5000, stage, ok })
  const reasonsOf = (events) => events.map((event) => String(event?.reason ?? '')).join(' | ')

  return {
    bridge, server, config, cwd, turns, tools,
    traceStage, reasonsOf, message, groupMessage, privateMessage, send,
    stop: () => bridge.stop(),
  }
}

/** A group emoji-reaction notice, matching the field names the real NapCat sends. */
function emojiNotice({ userId = 1001, messageId = '9001', isAdd = true, likes = [{ emoji_id: '128077', count: 1 }] } = {}) {
  return { bot: null, noticeType: 'group_msg_emoji_like', groupId: 2002, userId, messageId, likes, isAdd }
}

// ---------------------------------------------------------------------------
// A. 标记已读：按会话（不是按消息），注入回合必须 0 出站
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ engageEnabled: true, markReadEnabled: true })
  await t.send(t.groupMessage('大家早'))
  check('A1 群消息触发 mark_group_msg_as_read', t.server.count('mark_group_msg_as_read') === 1, brief(t.server.paramsOf('mark_group_msg_as_read')))
  check('A1 参数是会话级 group_id（不带 message_id）',
    String(t.server.paramsOf('mark_group_msg_as_read')[0].groupId) === '2002' && t.server.paramsOf('mark_group_msg_as_read')[0].messageId === undefined,
    brief(t.server.paramsOf('mark_group_msg_as_read')[0]))
  check('A1 trace 留下「已标记已读」', t.reasonsOf(t.traceStage('engage')).includes('已标记已读'), brief(t.reasonsOf(t.traceStage('engage'))))

  await t.send(t.privateMessage('在吗'))
  check('A2 私聊走 mark_private_msg_as_read', t.server.count('mark_private_msg_as_read') === 1, brief(t.server.paramsOf('mark_private_msg_as_read')))

  t.server.reset()
  await t.send(t.groupMessage('注入的假消息', { __injected: true }))
  check('A3 注入回合 0 出站：mark_group_msg_as_read', t.server.count('mark_group_msg_as_read') === 0, `count=${t.server.count('mark_group_msg_as_read')}`)
  check('A3 注入回合 reason 说明是真原因',
    t.reasonsOf(t.traceStage('engage')).includes('注入/回放回合不写 QQ'), brief(t.reasonsOf(t.traceStage('engage'))))

  t.server.reset()
  await t.send(t.groupMessage('回放的假消息', { __replayed: true }))
  check('A4 回放回合 0 出站：mark_group_msg_as_read', t.server.count('mark_group_msg_as_read') === 0)
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, markReadEnabled: false })
  await t.send(t.groupMessage('没开标记已读'))
  check('A5 markReadEnabled=false → 0 出站', t.server.count('mark_group_msg_as_read') === 0)
  check('A5 关闭时不写 engage trace（没做事就不刷屏）', t.traceStage('engage').length === 0, `count=${t.traceStage('engage').length}`)
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, markReadEnabled: true, markReadPerMinute: 1 })
  await t.send(t.groupMessage('第一条'))
  await t.send(t.groupMessage('第二条'))
  check('A6 每分钟配额生效（只标记一次）', t.server.count('mark_group_msg_as_read') === 1, `count=${t.server.count('mark_group_msg_as_read')}`)
  check('A6 配额拒绝理由含「每分钟上限」', t.reasonsOf(t.traceStage('engage')).includes('每分钟上限'), brief(t.reasonsOf(t.traceStage('engage'))))
  t.stop()
}

// ---------------------------------------------------------------------------
// B. 自动贴表情：只带 message_id → 注入回合必须自己判（scoped dry-run 拦不住）
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ engageEnabled: true, emojiLikeEnabled: true, emojiLikeMentionOnly: false })
  await t.send(t.groupMessage('随便说点什么'))
  check('B1 贴表情调用 set_msg_emoji_like', t.server.count('set_msg_emoji_like') === 1, brief(t.server.paramsOf('set_msg_emoji_like')))
  check('B1 表情 ID 用配置值（默认 👍 的码点）', t.server.paramsOf('set_msg_emoji_like')[0].emojiId === '128077', brief(t.server.paramsOf('set_msg_emoji_like')[0]))

  t.server.reset()
  await t.send(t.groupMessage('注入的一条', { __injected: true }))
  check('B2 注入回合 0 出站：set_msg_emoji_like', t.server.count('set_msg_emoji_like') === 0)
  check('B2 reason 点名 scoped dry-run 拦不住这条调用',
    t.reasonsOf(t.traceStage('engage')).includes('scoped dry-run 拦不住'), brief(t.reasonsOf(t.traceStage('engage'))))

  t.server.reset()
  await t.send(t.groupMessage('回放的一条', { __replayed: true }))
  check('B3 回放回合 0 出站：set_msg_emoji_like', t.server.count('set_msg_emoji_like') === 0)
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, emojiLikeEnabled: true, emojiLikeMentionOnly: true })
  await t.send(t.groupMessage('没叫我的消息', { atMe: false }))
  check('B4 emojiLikeMentionOnly=true 时普通消息不贴', t.server.count('set_msg_emoji_like') === 0)
  check('B4 reason 说明是「没叫我」', t.reasonsOf(t.traceStage('engage')).includes('emojiLikeMentionOnly'), brief(t.reasonsOf(t.traceStage('engage'))))
  await t.send(t.groupMessage('叫我的消息', { atMe: true }))
  check('B5 被 @ 时才贴', t.server.count('set_msg_emoji_like') === 1)
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, emojiLikeEnabled: true, emojiLikeId: '不是数字' })
  await t.send(t.groupMessage('表情 ID 配错', { atMe: true }))
  check('B6 表情 ID 非数字 → 不发且 reason 带原值',
    t.server.count('set_msg_emoji_like') === 0 && t.reasonsOf(t.traceStage('engage')).includes('不是数字'),
    brief(t.reasonsOf(t.traceStage('engage'))))
  t.stop()
}

// ---------------------------------------------------------------------------
// C. 表情回应统计（入站 notice）+ /赞榜 / /谁赞了
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ engageEnabled: true, reactionStatsEnabled: true })
  t.server.emit('notice', emojiNotice({ userId: 1001, messageId: '9001' }))
  await sleep(80)
  check('C1 收到 group_msg_emoji_like 会记账', t.bridge.reactions.totalFor('9001') === 1, String(t.bridge.reactions.totalFor('9001')))
  check('C1 trace 说明记了哪条消息',
    t.reasonsOf(t.traceStage('notice')).includes('表情回应已记账'), brief(t.reasonsOf(t.traceStage('notice'))))

  t.server.emit('notice', emojiNotice({ userId: 1002, messageId: '9001' }))
  await sleep(80)
  check('C2 第二个人累加', t.bridge.reactions.totalFor('9001') === 2)
  t.server.emit('notice', emojiNotice({ userId: 1002, messageId: '9001', isAdd: false }))
  await sleep(80)
  check('C3 撤回只去掉那个人', t.bridge.reactions.totalFor('9001') === 1)

  const out = await t.send(t.groupMessage('/赞榜'))
  check('C4 /赞榜 给出榜单', out.includes('表情回应榜') && out.includes('9001'), brief(out))
  check('C4 /赞榜 不访问 QQ（本地统计）', t.server.count('get_emoji_likes') === 0)
  check('C4 trace 说明只读本地',
    t.reasonsOf(t.traceStage('engage')).includes('只读本地 JSON'), brief(t.reasonsOf(t.traceStage('engage'))))

  const injected = await t.send(t.groupMessage('/赞榜', { __injected: true }))
  check('C5 注入回合 /赞榜 照常回答（本地读）', injected.includes('表情回应榜'), brief(injected))

  t.server.reset()
  t.server.emojiLikesResult = { emoji_like_list: [{ user_id: '1001', nick_name: '小明' }, { user_id: '1002', nick_name: '小红' }] }
  const who = await t.send(t.groupMessage('/谁赞了 9001'))
  check('C6 /谁赞了 调 get_emoji_likes', t.server.count('get_emoji_likes') === 1, brief(t.server.paramsOf('get_emoji_likes')))
  check('C6 /谁赞了 显示实时名单', who.includes('小明') && who.includes('1002'), brief(who))
  check('C6 trace 标出数据来源', t.reasonsOf(t.traceStage('engage')).includes('get_emoji_likes'), brief(t.reasonsOf(t.traceStage('engage'))))

  t.server.reset()
  const injectedWho = await t.send(t.groupMessage('/谁赞了 9001', { __injected: true }))
  check('C7 注入回合 /谁赞了 0 次 QQ 调用', t.server.count('get_emoji_likes') === 0, `count=${t.server.count('get_emoji_likes')}`)
  check('C7 注入回合回落到本地统计并标注来源', injectedWho.includes('本地统计'), brief(injectedWho))
  check('C7 reason 说明注入回合为什么不查',
    t.reasonsOf(t.traceStage('engage')).includes('注入/回放回合不调用 get_emoji_likes'), brief(t.reasonsOf(t.traceStage('engage'))))

  t.server.reset()
  t.server.emojiLikeError = new Error('OneBot action get_emoji_likes failed')
  const failed = await t.send(t.groupMessage('/谁赞了 9001'))
  check('C8 get_emoji_likes 失败 → 回落本地 + 真实 reason',
    failed.includes('本地统计') && t.reasonsOf(t.traceStage('engage')).includes('失败，改用本地统计'),
    brief(t.reasonsOf(t.traceStage('engage'))))
  t.server.emojiLikeError = null
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, reactionStatsEnabled: false })
  t.server.emit('notice', emojiNotice({}))
  await sleep(80)
  check('C9 reactionStatsEnabled=false → 不记账', t.bridge.reactions.totalFor('9001') === 0)
  check('C9 trace 点名两个开关的真实状态',
    t.reasonsOf(t.traceStage('notice')).includes('engageEnabled='), brief(t.reasonsOf(t.traceStage('notice'))))
  const out = await t.send(t.groupMessage('/赞榜'))
  check('C10 未启用时 /赞榜 给中文原因', out.includes('未启用'), brief(out))
  t.stop()
}

// ---------------------------------------------------------------------------
// D. /戳（主动戳）与 /点赞
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ engageEnabled: true, pokeCommandEnabled: true })
  await t.send(t.groupMessage('/戳 10002'))
  check('D1 /戳 发出 group_poke', t.server.count('group_poke') === 1, brief(t.server.paramsOf('group_poke')))
  check('D1 参数是 group_id + user_id',
    String(t.server.paramsOf('group_poke')[0].groupId) === '2002' && String(t.server.paramsOf('group_poke')[0].userId) === '10002',
    brief(t.server.paramsOf('group_poke')[0]))

  t.server.reset()
  await t.send(t.groupMessage('/戳12345'))
  check('D2 没有空格分隔 → 不认这条命令（零调用）', t.server.count('group_poke') === 0)

  t.server.reset()
  const fourDigit = await t.send(t.groupMessage('/戳 1002'))
  check('D2b 4 位数字不当 QQ 号（仓库约定 5–11 位）→ 用法提示且零调用',
    fourDigit.includes('用法') && t.server.count('group_poke') === 0, brief(fourDigit))

  t.server.reset()
  const reply = await t.send(t.groupMessage('/戳'))
  check('D3 /戳 无参数 → 用法提示', reply.includes('用法'), brief(reply))
  check('D3 无参数时零调用', t.server.count('group_poke') === 0)

  t.server.reset()
  await t.send(t.groupMessage('/戳 10002', { __injected: true }))
  check('D4 注入回合 /戳 的写操作被拦下（0 出站）', t.server.count('group_poke') === 0, `count=${t.server.count('group_poke')}`)
  check('D4 拒绝理由说清是注入/回放回合',
    t.reasonsOf(t.traceStage('engage')).includes('注入/回放回合不写 QQ'), brief(t.reasonsOf(t.traceStage('engage'))))

  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, pokeCommandEnabled: true })
  await t.send(t.groupMessage('/戳 10002', { userId: 10002 }))
  check('D5 非管理员不能主动戳', t.server.count('group_poke') === 0)
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, pokeCommandEnabled: false })
  const out = await t.send(t.groupMessage('/戳 10002'))
  check('D6 未启用时给出两个开关的真实状态', out.includes('pokeCommandEnabled='), brief(out))
  check('D6 未启用时零调用', t.server.count('group_poke') === 0)
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, sendLikeEnabled: true, sendLikeTimes: 10 })
  await t.send(t.groupMessage('/点赞 10002'))
  check('D7 /点赞 发出 send_like', t.server.count('send_like') === 1, brief(t.server.paramsOf('send_like')))
  check('D7 次数按配置（QQ 上限 10）', t.server.paramsOf('send_like')[0].times === 10, brief(t.server.paramsOf('send_like')[0]))

  t.server.reset()
  await t.send(t.groupMessage('/点赞 10002', { __injected: true }))
  check('D9 注入回合 send_like 0 出站', t.server.count('send_like') === 0)

  t.stop()
}

{
  // 单开一个桥：ActionGate 对 send_like 的限额是每分钟 1 次，同一进程里连发第二次会被闸门拦下。
  const t = makeBridge({ engageEnabled: true, sendLikeEnabled: true, sendLikeTimes: 5 })
  await t.send(t.groupMessage('/点赞'))
  check('D8 /点赞 不带目标 → 给自己点', String(t.server.paramsOf('send_like')[0]?.userId) === '1001', brief(t.server.paramsOf('send_like')))
  check('D8 次数用配置值', t.server.paramsOf('send_like')[0]?.times === 5, brief(t.server.paramsOf('send_like')[0]))
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, sendLikeEnabled: true, sendLikePerDay: 1 })
  await t.send(t.groupMessage('/点赞 10002'))
  const second = await t.send(t.groupMessage('/点赞 10002'))
  check('D10 每天配额生效', t.server.count('send_like') === 1, `count=${t.server.count('send_like')}`)
  check('D10 拒绝理由含「每天上限」', second.includes('每天上限'), brief(second))
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, sendLikeEnabled: false })
  const out = await t.send(t.groupMessage('/点赞 10002'))
  check('D11 未启用时给出 reason 且零调用', out.includes('sendLikeEnabled=') && t.server.count('send_like') === 0, brief(out))
  t.stop()
}

// ---------------------------------------------------------------------------
// E. 回戳（pokeBackEnabled）与输入状态（typingEnabled）
// ---------------------------------------------------------------------------
function pokeNotice() {
  return { bot: null, noticeType: 'notify', subType: 'poke', groupId: 2002, userId: 1001, targetId: 999 }
}

{
  const t = makeBridge({ engageEnabled: true, pokeEnabled: true, pokeBackEnabled: true, pokeBackText: '' })
  t.server.emit('notice', pokeNotice())
  await sleep(120)
  check('E1 被戳时真的戳回去（group_poke）', t.server.count('group_poke') === 1, brief(t.server.paramsOf('group_poke')))
  check('E1 参数指向戳我的人', String(t.server.paramsOf('group_poke')[0].userId) === '1001', brief(t.server.paramsOf('group_poke')[0]))
  check('E1 没配文案时只戳不发消息', t.server.count('send_msg') === 0, `send=${t.server.count('send_msg')}`)
  check('E1 trace 说明戳一戳已回复', t.reasonsOf(t.traceStage('notice')).includes('戳一戳已回复'), brief(t.reasonsOf(t.traceStage('notice'))))
  t.stop()
}

{
  // pokeEnabled 是既有的"要不要理会戳一戳"总开关；回戳也必须过它，否则等于偷偷开了新行为。
  const t = makeBridge({ engageEnabled: true, pokeEnabled: false, pokeBackEnabled: true })
  t.server.emit('notice', pokeNotice())
  await sleep(120)
  check('E1b pokeEnabled=false 时回戳不生效（零出站）', t.server.count('group_poke') === 0 && t.server.count('send_msg') === 0)
  check('E1b trace 点名 pokeEnabled=false', t.reasonsOf(t.traceStage('notice')).includes('pokeEnabled=false'), brief(t.reasonsOf(t.traceStage('notice'))))
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, pokeEnabled: true, pokeBackEnabled: true })
  t.server.emit('notice', { ...pokeNotice(), __injected: true })
  await sleep(120)
  check('E1c 注入的戳一戳不触发真回戳（0 出站）', t.server.count('group_poke') === 0)
  check('E1c reason 说明注入回合不写 QQ',
    t.reasonsOf(t.traceStage('notice')).includes('注入/回放回合不写 QQ'), brief(t.reasonsOf(t.traceStage('notice'))))
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, pokeEnabled: true, pokeReplies: ['别戳啦'] })
  t.server.emit('notice', pokeNotice())
  await sleep(120)
  check('E2 没开回戳时保留旧行为（文字回复）', t.server.count('send_msg') === 1 && t.server.count('group_poke') === 0, brief(t.server.paramsOf('send_msg')))
  check('E2 文字回复走 pokeReplies', t.server.sent[0].segments[0].data.text === '别戳啦', brief(t.server.sent[0]?.segments))
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, pokeEnabled: true, pokeBackEnabled: true, pokeBackText: '戳回去！' })
  t.server.emit('notice', pokeNotice())
  await sleep(120)
  check('E3 开了回戳又配了文案 → 两者都发', t.server.count('group_poke') === 1 && t.server.count('send_msg') === 1)
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, pokeEnabled: true, pokeBackEnabled: true, pokePerHour: 1, pokeCooldownSeconds: 5 })
  t.server.emit('notice', pokeNotice())
  await sleep(120)
  t.server.reset()
  t.bridge.lastPokeAt.clear()
  t.server.emit('notice', pokeNotice())
  await sleep(120)
  check('E4 每小时配额拦住第二次回戳', t.server.count('group_poke') === 0, `count=${t.server.count('group_poke')}`)
  check('E4 拒绝理由含「每小时上限」', t.reasonsOf(t.traceStage('notice')).includes('每小时上限'), brief(t.reasonsOf(t.traceStage('notice'))))
  t.stop()
}

// ---------------------------------------------------------------------------
// E9/E10. 两种注入模式：默认干跑（拦）与 injectDryRun:false（真发）
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ engageEnabled: true, pokeCommandEnabled: true })
  // 真实注入流程会做两件事：ActionGate 进 dryRun、OneBot 连接进 scoped dry-run。
  // 桥自己还会先判一次 __injected（第一道防线），所以这里断言的是"两层都在也没漏出去"。
  t.bridge.gate.dryRun = true
  t.server.setDryRun(true, { groupId: 2002 })
  await t.send(t.groupMessage('/戳 10002', { __injected: true }))
  check('E9 注入回合 group_poke 没有真的发出去', t.server.count('group_poke') === 0, `real=${t.server.count('group_poke')}`)
  check('E9 连传输层都没碰到（桥自己就拦下了）', t.server.dryRunCalls.length === 0, brief(t.server.dryRunCalls))
  check('E9 理由说明是注入/回放回合',
    t.reasonsOf(t.traceStage('engage')).includes('注入/回放回合不写 QQ'), brief(t.reasonsOf(t.traceStage('engage'))))
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, pokeCommandEnabled: true, injectDryRun: false })
  await t.send(t.groupMessage('/戳 10002', { __injected: true }))
  check('E10 injectDryRun=false（真发模式）时注入的 /戳 照常执行', t.server.count('group_poke') === 1, `count=${t.server.count('group_poke')}`)
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, typingEnabled: true })
  await t.send(t.privateMessage('帮我想个名字'))
  const typing = t.server.paramsOf('set_input_status')
  check('E5 私聊发「正在输入」', typing.length >= 1, brief(typing))
  check('E5 第一条 event_type=1（正在输入）', typing[0]?.eventType === 1, brief(typing[0]))
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, typingEnabled: true })
  t.server.reset()
  await t.send(t.groupMessage('群聊不该有输入状态'))
  check('E6 群聊不发输入状态（真机探针：NapCat 只支持 C2C）', t.server.count('set_input_status') === 0)
  check('E6 群聊 reason 说明只支持私聊', t.reasonsOf(t.traceStage('engage')).includes('只支持私聊'), brief(t.reasonsOf(t.traceStage('engage'))))
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, typingEnabled: true })
  t.server.reset()
  await t.send(t.privateMessage('注入的私聊', { __injected: true }))
  check('E7 注入回合不发输入状态', t.server.count('set_input_status') === 0)
  t.stop()
}

{
  const t = makeBridge({ engageEnabled: true, typingEnabled: false })
  t.server.reset()
  await t.send(t.privateMessage('没开输入状态'))
  check('E8 typingEnabled=false → 零调用', t.server.count('set_input_status') === 0)
  t.stop()
}

// ---------------------------------------------------------------------------
// F. 快照卫生 + 默认全关
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ engageEnabled: true, reactionStatsEnabled: true, sendLikeEnabled: true, pokeBackEnabled: true })
  // 快照写入是节流的（2s），启动时那次写的是「0 条」——等过节流窗口再读，验证的是真实行为。
  await sleep(2100)
  t.server.emit('notice', emojiNotice({ userId: 1001, messageId: '9010' }))
  await sleep(120)
  const runtime = JSON.parse(readFileSync(join(t.cwd, 'qq-runtime.json'), 'utf8'))
  const features = runtime.features
  check('F1 运行快照含互动开关', features?.engageEnabled === true && features?.sendLikeEnabled === true, brief(features))
  check('F1 运行快照只给计数，不给消息原文/消息 ID',
    features?.reactionMessageCount === 1 && !JSON.stringify(features).includes('9010'),
    brief(JSON.stringify(features).slice(0, 200)))
  check('F1 快照里没有表情回应的用户明细', !JSON.stringify(runtime).includes('"emojis"'), brief(JSON.stringify(runtime).length))
  check('F1 统计落盘文件里确实有回应数据（本地 JSON，不外发）',
    readFileSync(join(t.cwd, 'qq-engage.json'), 'utf8').includes('9010'),
    `engageState=${t.bridge.engageState !== null}`)
  t.stop()
}

{
  const t = makeBridge({})
  await t.send(t.groupMessage('默认全关时什么都不做'))
  check('F2 默认全关：五类互动 API 全部零调用',
    t.server.count('group_poke') === 0 && t.server.count('send_like') === 0
    && t.server.count('set_msg_emoji_like') === 0 && t.server.count('mark_group_msg_as_read') === 0
    && t.server.count('set_input_status') === 0,
    brief(t.server.calls.map((call) => call.action)))
  t.stop()
}

// ---------------------------------------------------------------------------
// G. 持久化：统计与配额必须真的落盘、并且重启后读得回来
//    （这一节是为一个真实缺陷补的回归：JsonStore 的 API 是 read()/write()，
//     曾经写成 load()/save()，被 try/catch 静默吞掉 → 持久化从来没生效过。）
// ---------------------------------------------------------------------------
{
  const cwd = freshCwd()
  const t1 = makeBridge({ engageEnabled: true, reactionStatsEnabled: true, cwd })
  t1.server.emit('notice', emojiNotice({ userId: 1001, messageId: '9100' }))
  await sleep(120)
  const file = join(cwd, 'qq-engage.json')
  check('G1 统计真的写到了 qq-engage.json', existsSync(file) && readFileSync(file, 'utf8').includes('9100'),
    existsSync(file) ? brief(readFileSync(file, 'utf8')) : 'file missing')
  t1.stop()

  const t2 = makeBridge({ engageEnabled: true, reactionStatsEnabled: true, cwd })
  check('G2 重启后统计被恢复（不是从零开始）', t2.bridge.reactions.totalFor('9100') === 1,
    `total=${t2.bridge.reactions.totalFor('9100')} restored=${t2.bridge.reactions.size}`)
  t2.stop()
}

{
  const cwd = freshCwd()
  const t1 = makeBridge({ engageEnabled: true, pokeEnabled: true, pokeBackEnabled: true, pokePerHour: 1, cwd })
  t1.server.emit('notice', pokeNotice())
  await sleep(150)
  const wroteQuota = existsSync(join(cwd, 'qq-engage.json'))
  t1.stop()

  const t2 = makeBridge({ engageEnabled: true, pokeEnabled: true, pokeBackEnabled: true, pokePerHour: 1, cwd })
  t2.server.emit('notice', pokeNotice())
  await sleep(150)
  check('G3 每小时戳的配额跨重启仍然生效（重启后第一次就被拦）', wroteQuota && t2.server.count('group_poke') === 0,
    `quotaFile=${wroteQuota} pokes=${t2.server.count('group_poke')} reason=${brief(t2.reasonsOf(t2.traceStage('notice')))}`)
  t2.stop()
}

{
  // engageEnabled=false 时不建状态文件：关掉的功能不该往磁盘上写东西。
  const cwd = freshCwd()
  const t = makeBridge({ engageEnabled: false, cwd })
  await t.send(t.groupMessage('关着的时候不该落盘'))
  check('G4 未启用时不创建 qq-engage.json', !existsSync(join(cwd, 'qq-engage.json')))
  check('G4 未启用时 engageState 为 null', t.bridge.engageState === null)
  t.stop()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
