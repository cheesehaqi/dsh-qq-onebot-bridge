/**
 * Bridge-level integration tests for the "seeing" pack: merged-forward card
 * expansion, the read-only /成员 · /群信息 · /好友 commands, the /退群 admin
 * command, and the per-session query tools (qq_member_info / qq_recent_history
 * / qq_react) including the action-gate limit on reactions.
 *
 * Style follows test/features-unit.mjs: a MockServer extends EventEmitter, the
 * real QQBridge runs against it, messages are injected with server.emit and the
 * outbound text is read back from the mock. Unlike features-unit.mjs, the agent
 * is NOT a throwing stub here — capture of the agent turn needs the real
 * followup shape (see control/lib/replay.mjs#createMockCtx).
 *
 * No DSH host, no network, no model call.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { Config } from '../lib/index.js'
import { DEFAULT_ACTION_LIMITS } from '../lib/actions.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

/** A tiny `x` helper: turn anything into a short single-line string for `extra`. */
function brief(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, 160)
}

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.calls = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
    // Injectable return values (per scenario).
    this.forwardResult = { messages: [] }
    this.forwardError = null
    this.memberList = []
    this.memberInfo = {}
    this.groupInfo = {}
    this.friendList = []
    this.groupHistory = []
    this.friendHistory = []
    this.emojiResult = { ok: true }
    this.leaveResult = { ok: true }
  }

  #rec(action, params) { this.calls.push({ action, params }) }
  count(action) { return this.calls.filter((call) => call.action === action).length }
  paramsOf(action) { return this.calls.filter((call) => call.action === action).map((call) => call.params) }
  reset() { this.calls.length = 0; this.sent.length = 0 }

  currentSocket() { return this.socket }

  sendSegments(_bot, messageType, targetId, segments) {
    this.#rec('send_msg', { messageType, targetId, segments })
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: this.sent.length })
  }

  sendText(_bot, messageType, targetId, text) {
    return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  getForwardMsg(socket, id) {
    this.#rec('get_forward_msg', { id, socket })
    if (this.forwardError) return Promise.reject(this.forwardError)
    return Promise.resolve(this.forwardResult)
  }

  getGroupMemberList(socket, groupId, noCache = false) {
    this.#rec('get_group_member_list', { groupId, noCache })
    return Promise.resolve(this.memberList)
  }

  getGroupMemberInfo(socket, groupId, userId, noCache = true) {
    this.#rec('get_group_member_info', { groupId, userId, noCache })
    return Promise.resolve(this.memberInfo)
  }

  getGroupInfo(socket, groupId, noCache = true) {
    this.#rec('get_group_info', { groupId, noCache })
    return Promise.resolve(this.groupInfo)
  }

  getFriendList(socket) {
    this.#rec('get_friend_list', {})
    return Promise.resolve(this.friendList)
  }

  getGroupMsgHistory(socket, groupId, messageSeq = 0, count = 20) {
    this.#rec('get_group_msg_history', { groupId, messageSeq, count })
    return Promise.resolve(this.groupHistory)
  }

  getFriendMsgHistory(socket, userId, messageSeq = 0, count = 20) {
    this.#rec('get_friend_msg_history', { userId, messageSeq, count })
    return Promise.resolve(this.friendHistory)
  }

  setMsgEmojiLike(socket, messageId, emojiId) {
    this.#rec('set_msg_emoji_like', { messageId, emojiId })
    return Promise.resolve(this.emojiResult)
  }

  setGroupLeave(socket, groupId, isDismiss = false) {
    this.#rec('set_group_leave', { groupId, isDismiss })
    return Promise.resolve(this.leaveResult)
  }

  getMsg() { return Promise.resolve({ message: [] }) }
  sendForwardMsg() { return Promise.resolve({ message_id: 9999 }) }
  uploadFile() { return Promise.resolve({}) }
  deleteMsg() { return Promise.resolve({}) }
  sendGroupNotice() { return Promise.resolve({}) }
  setGroupWholeBan() { return Promise.resolve({}) }
  setGroupBan() { return Promise.resolve({}) }
  setGroupKick() { return Promise.resolve({}) }
  getGroupHonorInfo() { return Promise.resolve({}) }
  getGroupNotice() { return Promise.resolve([]) }
  getEssenceMsgList() { return Promise.resolve([]) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-seeing-test-'))

/** Config keys every scenario pins, so no test depends on another's defaults. */
const QUIET_BASE = {
  cwd: dir,
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
  recordInbound: false,
  traceEnabled: true,
  traceLevel: 'debug',
  traceMemorySize: 500,
  actionAuditEnabled: false,
  adminEnabled: true,
  adminUsers: [1001],
  // Keep the pipeline narrow: only the pack under test may react to a message.
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

/**
 * One isolated bridge per scenario: fresh mock server, fresh mock ctx, fresh
 * config (= Config() defaults + QUIET_BASE + scenario overrides).
 */
function makeBridge(overrides = {}) {
  const server = new MockServer()
  const tools = []
  const sections = []
  const turns = []
  const created = []
  let seq = 0

  const makeCtx = () => {
    const agentCtx = {
      tools: { register: (tool) => { tools.push(tool); return tool } },
      systemPrompt: { section: (section) => { sections.push(section); return section } },
    }
    const newHandle = (sessionId, setup) => {
      const id = String(sessionId || `qq-seeing-${++seq}`)
      if (typeof setup === 'function') setup(agentCtx)
      const agent = {
        id,
        status: 'idle',
        // This is exactly what lib/bridge.js#handoff calls, so the captured text
        // IS the user turn the model would have received.
        followup(message) {
          const blocks = Array.isArray(message?.content) ? message.content : []
          const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
          turns.push({ sessionId: id, text, blocks })
          return Promise.resolve()
        },
        cancel() {},
      }
      created.push(id)
      return { agent, sessionId: id, dispose: async () => {} }
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

  const config = { ...Config({}), ...QUIET_BASE, ...overrides }
  const logger = { info() {}, warn() {}, error() {} }
  const bridge = new QQBridge(makeCtx(), config, server, logger)
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
      messageId: `s${++seqMsgId}`,
      senderName: '小明',
      raw: { message: [] },
      ...extra,
    }
  }
  const groupMessage = (text, extra = {}) => message(text, extra)
  const privateMessage = (text, extra = {}) => message(text, { messageType: 'private', groupId: undefined, atMe: false, ...extra })

  async function send(msg, waitMs = 40) {
    const before = server.sent.length
    server.emit('message', msg)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    return server.sent.slice(before)
      .map((item) => item.segments.map((segment) => segment.data?.text ?? `[${segment.type}]`).join(''))
      .join('\n')
  }

  const toolNamed = (name) => tools.find((tool) => tool.name === name)
  const toolNames = () => tools.map((tool) => tool.name)
  const lastTurn = () => turns.at(-1)?.text ?? ''
  const traceStage = (stage, ok = null) => bridge.trace.recent({ limit: 5000, stage, ok })

  return { bridge, server, config, turns, tools, sections, toolNamed, toolNames, lastTurn, traceStage, message, groupMessage, privateMessage, send, stop: () => bridge.stop() }
}

/** One forwarded node shaped like a real OneBot v11 `node` segment. */
const FORWARD_NODE = {
  messages: [{
    type: 'node',
    data: { name: '小明', uin: '20002', content: [{ type: 'text', data: { text: '今晚开黑吗' } }] },
  }],
}

// ===========================================================================
// A. 合并转发展开
// ===========================================================================

// 1. 私聊只含转发卡片（text:''，无图无语音无文件）→ 真的走 getForwardMsg 并进入 agent 回合
{
  const t = makeBridge()
  t.server.forwardResult = FORWARD_NODE
  const reply = await t.send(t.privateMessage('', { forwards: [{ id: 'f1' }] }))
  check('A1 私聊转发卡片调用 getForwardMsg', t.server.count('get_forward_msg') === 1, `calls=${t.server.count('get_forward_msg')}`)
  check('A1 转发正文进入 agent 回合', t.lastTurn().includes('今晚开黑吗') && t.lastTurn().includes('[转发聊天记录'), brief(t.lastTurn()))
  const forwardEvents = t.traceStage('forward')
  check('A1 trace 记录 forward 阶段成功', forwardEvents.some((event) => event.ok !== false), brief(forwardEvents.map((e) => `${e.ok}:${e.reason ?? ''}`)))
  check('A1 转发卡片本身不直接回消息', reply === '', brief(reply))
  t.stop()
}

// 2. 群里转发卡片但没 @ 机器人 → 门控先拦下，一次 API 都不调
{
  const t = makeBridge()
  t.server.forwardResult = FORWARD_NODE
  const reply = await t.send(t.groupMessage('', { atMe: false, forwards: [{ id: 'f2' }] }))
  check('A2 未 @ 时不调用 getForwardMsg', t.server.count('get_forward_msg') === 0, `calls=${t.server.count('get_forward_msg')}`)
  check('A2 未 @ 时不产生 agent 回合', t.turns.length === 0, `turns=${t.turns.length}`)
  check('A2 未 @ 时也不回复', reply === '', brief(reply))
  t.stop()
}

// 2b. 私聊转发卡片 + acceptPrivate:false → 空文本路径的另一个门也必须过
{
  const t = makeBridge({ acceptPrivate: false })
  t.server.forwardResult = FORWARD_NODE
  const reply = await t.send(t.privateMessage('', { forwards: [{ id: 'f2b' }] }))
  check('A2b 私聊关闭时不调用 getForwardMsg', t.server.count('get_forward_msg') === 0, `calls=${t.server.count('get_forward_msg')}`)
  check('A2b 私聊关闭时不产生 agent 回合', t.turns.length === 0, `turns=${t.turns.length}`)
  check('A2b 私聊关闭时也不回复', reply === '', brief(reply))
  const closed = t.traceStage('drop', false)
  check('A2b trace 说明 acceptPrivate=false', closed.some((event) => String(event.reason ?? '').includes('acceptPrivate')), brief(closed.map((e) => e.reason)))
  t.stop()
}

// 3. forwardExpandEnabled:false → 不展开，但 trace 必须写明原因
{
  const t = makeBridge({ forwardExpandEnabled: false })
  t.server.forwardResult = FORWARD_NODE
  await t.send(t.privateMessage('', { forwards: [{ id: 'f3' }] }))
  check('A3 关闭展开时不调用 getForwardMsg', t.server.count('get_forward_msg') === 0, `calls=${t.server.count('get_forward_msg')}`)
  const off = t.traceStage('forward', false)
  check('A3 trace 有 forward 失败事件', off.length > 0, brief(off.map((e) => e.reason)))
  check('A3 trace 原因提到 forwardExpandEnabled', off.some((event) => String(event.reason ?? '').includes('forwardExpandEnabled')), brief(off.map((e) => e.reason)))
  t.stop()
}

// 4. 注入帧（__injected，带 forwards，没带 forwardText）→ 离线，不碰 QQ
{
  const t = makeBridge()
  t.server.forwardResult = FORWARD_NODE
  await t.send(t.privateMessage('', { forwards: [{ id: 'f4' }], __injected: true }))
  check('A4 注入帧不调用 getForwardMsg', t.server.count('get_forward_msg') === 0, `calls=${t.server.count('get_forward_msg')}`)
  const offline = t.traceStage('forward', false)
  check('A4 trace 的 forward 原因说明回放/注入不访问 QQ', offline.some((event) => /回放/.test(String(event.reason ?? '')) || /dry-run/.test(String(event.reason ?? ''))), brief(offline.map((e) => e.reason)))
  t.stop()
}

// 5. 注入帧自带 forwardText → 直接采用，同样不碰 QQ
{
  const t = makeBridge()
  t.server.forwardResult = FORWARD_NODE
  await t.send(t.privateMessage('', { forwards: [{ id: 'f5' }], __injected: true, forwardText: '小明: 你好' }))
  check('A5 注入 forwardText 进入 agent 回合', t.lastTurn().includes('小明: 你好'), brief(t.lastTurn()))
  check('A5 注入 forwardText 时不调用 getForwardMsg', t.server.count('get_forward_msg') === 0, `calls=${t.server.count('get_forward_msg')}`)
  t.stop()
}

// 6. getForwardMsg 抛错 → 不崩，trace 记失败；消息自带文本仍进 agent 回合
{
  const t = makeBridge()
  t.server.forwardError = new Error('boom-forward')
  const reply = await t.send(t.privateMessage('顺便看看这个', { forwards: [{ id: 'f6' }] }))
  check('A6 转发拉取失败不崩溃（无错误回复）', !reply.includes('处理失败'), brief(reply))
  const broke = t.traceStage('forward', false)
  check('A6 拉取失败时 trace 的 forward ok=false', broke.length > 0, brief(broke.map((e) => e.reason)))
  check('A6 拉取失败时自带的文本仍进入 agent 回合', t.lastTurn().includes('顺便看看这个'), brief(t.lastTurn()))
  t.stop()
}

// ===========================================================================
// B. /成员
// ===========================================================================

const MEMBERS = [
  { user_id: 20002, nickname: '小红', role: 'admin', level: '5' },
  { user_id: 30003, nickname: '小刚', role: 'member', level: '2' },
]

// 7. /成员 → 群成员名单
{
  const t = makeBridge()
  t.server.memberList = MEMBERS
  const reply = await t.send(t.groupMessage('/成员'))
  check('B7 /成员 触发 getGroupMemberList', t.server.count('get_group_member_list') === 1, `calls=${t.server.count('get_group_member_list')}`)
  check('B7 /成员 回复含群成员与昵称', reply.includes('群成员') && reply.includes('小红') && reply.includes('小刚'), brief(reply))
  check('B7 /成员 不调用 getGroupMemberInfo', t.server.count('get_group_member_info') === 0, `calls=${t.server.count('get_group_member_info')}`)
  t.stop()
}

// 8. /成员 @某人 → 成员详情
{
  const t = makeBridge()
  t.server.memberList = MEMBERS
  t.server.memberInfo = { user_id: 20002, nickname: '小红', card: '小红帽', role: 'owner', level: '7', join_time: 1700000000 }
  const reply = await t.send(t.groupMessage('/成员', { ats: [20002] }))
  check('B8 /成员 @ 触发 getGroupMemberInfo', t.server.count('get_group_member_info') === 1, `calls=${t.server.count('get_group_member_info')}`)
  check('B8 查询的是被 @ 的号', t.server.paramsOf('get_group_member_info')[0]?.userId === 20002, brief(t.server.paramsOf('get_group_member_info')))
  check('B8 回复含身份与 QQ 号', reply.includes('身份') && reply.includes('QQ 号'), brief(reply))
  t.stop()
}

// 9. 空成员列表 → 兜底文案，不抛错
{
  const t = makeBridge()
  t.server.memberList = []
  const reply = await t.send(t.groupMessage('/成员'))
  check('B9 空名单回复共 0 人', /共 0 人/.test(reply), brief(reply))
  check('B9 空名单不报错', !reply.includes('查询成员失败') && !reply.includes('处理失败'), brief(reply))
  t.stop()
}

// 10. 私聊 /成员 → 只读群命令不越界
{
  const t = makeBridge()
  t.server.memberList = MEMBERS
  t.server.forwardResult = { messages: [] }
  const reply = await t.send(t.privateMessage('/成员'))
  check('B10 私聊 /成员 不调用 getGroupMemberList', t.server.count('get_group_member_list') === 0, `calls=${t.server.count('get_group_member_list')}`)
  check('B10 私聊 /成员 不回复名单', !reply.includes('群成员'), brief(reply))
  t.stop()
}

// ===========================================================================
// C. /群信息、/好友
// ===========================================================================

// 11. /群信息
{
  const t = makeBridge()
  t.server.groupInfo = { group_name: '测试群', group_id: 2002, member_count: 42, max_member_count: 200 }
  const reply = await t.send(t.groupMessage('/群信息'))
  check('C11 /群信息 触发 getGroupInfo', t.server.count('get_group_info') === 1, `calls=${t.server.count('get_group_info')}`)
  check('C11 回复含群名与人数', reply.includes('测试群') && reply.includes('42'), brief(reply))
  t.stop()
}

// 12. friendListEnabled 未开 → 私聊 /好友 什么都不做
{
  const t = makeBridge({ friendListEnabled: false })
  t.server.friendList = [{ user_id: 20002, nickname: '小红' }]
  const reply = await t.send(t.privateMessage('/好友'))
  check('C12 未开好友列表时不调用 getFriendList', t.server.count('get_friend_list') === 0, `calls=${t.server.count('get_friend_list')}`)
  check('C12 未开好友列表时不回复好友', !reply.includes('小红'), brief(reply))
  t.stop()
}

// 13. friendListEnabled + 私聊 + 管理员 → 列出好友；非管理员不给
{
  const t = makeBridge({ friendListEnabled: true })
  t.server.friendList = [{ user_id: 20002, nickname: '小红' }, { user_id: 30003, remark: '老刚' }]
  const reply = await t.send(t.privateMessage('/好友'))
  check('C13 管理员私聊 /好友 触发 getFriendList', t.server.count('get_friend_list') === 1, `calls=${t.server.count('get_friend_list')}`)
  check('C13 回复含好友昵称', reply.includes('小红') && reply.includes('老刚'), brief(reply))
  t.stop()
}

// 13b. 非管理员私聊 /好友 → 不触发
{
  const t = makeBridge({ friendListEnabled: true })
  t.server.friendList = [{ user_id: 20002, nickname: '小红' }]
  const reply = await t.send(t.message('/好友', { messageType: 'private', groupId: undefined, atMe: false, userId: 30003 }))
  check('C13b 非管理员私聊 /好友 不调用 getFriendList', t.server.count('get_friend_list') === 0, `calls=${t.server.count('get_friend_list')}`)
  check('C13b 非管理员私聊 /好友 不回复好友', !reply.includes('小红'), brief(reply))
  t.stop()
}

// ===========================================================================
// D. /退群
// ===========================================================================

// 14. 默认关闭
{
  const t = makeBridge({ leaveGroupEnabled: false })
  const reply = await t.send(t.groupMessage('/退群 确认'))
  check('D14 关闭时回复提到默认关闭', reply.includes('默认关闭'), brief(reply))
  check('D14 关闭时不调用 setGroupLeave', t.server.count('set_group_leave') === 0, `calls=${t.server.count('set_group_leave')}`)
  t.stop()
}

// 15. 开启但没确认
{
  const t = makeBridge({ leaveGroupEnabled: true })
  const reply = await t.send(t.groupMessage('/退群'))
  check('D15 未确认时要求确认', reply.includes('确认'), brief(reply))
  check('D15 未确认时不调用 setGroupLeave', t.server.count('set_group_leave') === 0, `calls=${t.server.count('set_group_leave')}`)
  t.stop()
}

// 16. 开启 + 确认
{
  const t = makeBridge({ leaveGroupEnabled: true })
  const reply = await t.send(t.groupMessage('/退群 确认'))
  check('D16 确认后调用 setGroupLeave 一次', t.server.count('set_group_leave') === 1, `calls=${t.server.count('set_group_leave')}`)
  check('D16 确认后退出的是本群', t.server.paramsOf('set_group_leave')[0]?.groupId === 2002, brief(t.server.paramsOf('set_group_leave')))
  check('D16 回复表明已退出', reply.includes('已退出本群'), brief(reply))
  t.stop()
}

// ===========================================================================
// E. 工具注册与执行
// ===========================================================================

const QUERY_TOOLS = ['qq_member_info', 'qq_recent_history', 'qq_react']

// 17. 群会话注册三件套（用一个不触发任何命令的普通消息建立会话）
{
  const t = makeBridge()
  await t.send(t.groupMessage('你好呀'))
  check('E17 群会话建立成功', t.turns.length === 1, `turns=${t.turns.length}`)
  check('E17 群会话注册成员/历史/表情工具', QUERY_TOOLS.every((name) => t.toolNames().includes(name)), brief(t.toolNames()))
  t.stop()
}

// 18. memberQueryEnabled:false 的群；以及私聊会话
{
  const t = makeBridge({ memberQueryEnabled: false })
  await t.send(t.groupMessage('你好呀'))
  check('E18 memberQueryEnabled=false 时不注册 qq_member_info', !t.toolNames().includes('qq_member_info'), brief(t.toolNames()))
  check('E18 关掉成员工具不影响历史工具', t.toolNames().includes('qq_recent_history'), brief(t.toolNames()))
  t.stop()
}
{
  const t = makeBridge()
  await t.send(t.privateMessage('你好呀'))
  check('E18 私聊会话不注册 qq_member_info', !t.toolNames().includes('qq_member_info'), brief(t.toolNames()))
  check('E18 私聊会话仍注册 qq_recent_history', t.toolNames().includes('qq_recent_history'), brief(t.toolNames()))
  t.stop()
}

// 19. historyQueryEnabled / reactToolEnabled 关闭
{
  const t = makeBridge({ historyQueryEnabled: false, reactToolEnabled: false })
  await t.send(t.groupMessage('你好呀'))
  check('E19 historyQueryEnabled=false 时不注册 qq_recent_history', !t.toolNames().includes('qq_recent_history'), brief(t.toolNames()))
  check('E19 reactToolEnabled=false 时不注册 qq_react', !t.toolNames().includes('qq_react'), brief(t.toolNames()))
  check('E19 两个开关都不影响 qq_member_info', t.toolNames().includes('qq_member_info'), brief(t.toolNames()))
  t.stop()
}

// 20. qq_recent_history 正常取回两条
{
  const t = makeBridge()
  await t.send(t.groupMessage('你好呀'))
  const tool = t.toolNamed('qq_recent_history')
  t.server.groupHistory = [
    { message_id: 11, user_id: 20002, time: 1700000100, sender: { nickname: '小红' }, message: [{ type: 'text', data: { text: '第一条消息' } }] },
    { message_id: 12, user_id: 30003, time: 1700000200, sender: { nickname: '小刚' }, message: [{ type: 'text', data: { text: '第二条消息' } }] },
  ]
  const result = await tool.execute({ count: 2 })
  check('E20 qq_recent_history 走会话所在群的历史接口', t.server.count('get_group_msg_history') === 1, `calls=${t.server.count('get_group_msg_history')}`)
  check('E20 count 为 2', result.count === 2, brief(result))
  check('E20 detail 含最近消息与两条文本', result.detail.includes('[最近消息') && result.detail.includes('第一条消息') && result.detail.includes('第二条消息'), brief(result.detail))
  t.stop()
}

// 21. qq_recent_history 遇到 dry-run 载荷 → 明确说明，不抛错
{
  const t = makeBridge()
  await t.send(t.groupMessage('你好呀'))
  const tool = t.toolNamed('qq_recent_history')
  t.server.groupHistory = { dryRun: true, message_id: 'dry-1' }
  let result
  let threw = ''
  try { result = await tool.execute({ count: 2 }) } catch (error) { threw = error.message }
  check('E21 dry-run 载荷不抛错', threw === '', brief(threw))
  check('E21 dry-run 时 count 为 0', result?.count === 0, brief(result))
  check('E21 dry-run 时 detail 说明 dry-run/取不到', /dry-run/.test(String(result?.detail ?? '')) || /取不到/.test(String(result?.detail ?? '')), brief(result?.detail))
  t.stop()
}

// 22. qq_react 贴表情
{
  const t = makeBridge()
  await t.send(t.groupMessage('你好呀'))
  const tool = t.toolNamed('qq_react')
  const result = await tool.execute({ emoji_id: 128077 })
  check('E22 qq_react 调用 setMsgEmojiLike', t.server.count('set_msg_emoji_like') === 1, `calls=${t.server.count('set_msg_emoji_like')}`)
  check('E22 用的是刚收到的那条消息 id', t.server.paramsOf('set_msg_emoji_like')[0]?.messageId === 's1', brief(t.server.paramsOf('set_msg_emoji_like')))
  check('E22 qq_react 返回 ok', result.ok === true, brief(result))
  t.stop()
}

// 23. qq_react 受 ActionGate 限额约束
{
  const t = makeBridge()
  await t.send(t.groupMessage('你好呀'))
  t.bridge.gate.limits.set_msg_emoji_like = { perMinute: 1, perDay: 1 }
  const tool = t.toolNamed('qq_react')
  const first = await tool.execute({ emoji_id: 128077 })
  const second = await tool.execute({ emoji_id: 128077 })
  check('E23 第一次贴表情通过', first.ok === true, brief(first))
  check('E23 第二次被限额拦下', second.ok === false, brief(second))
  check('E23 拦截原因含「上限」', String(second.detail ?? '').includes('上限'), brief(second.detail))
  check('E23 被拦下时没有真的再调一次 API', t.server.count('set_msg_emoji_like') === 1, `calls=${t.server.count('set_msg_emoji_like')}`)
  t.stop()
}

// ===========================================================================
// F. 闸门限额表
// ===========================================================================

check('F24 DEFAULT_ACTION_LIMITS 含 set_group_leave', Boolean(DEFAULT_ACTION_LIMITS.set_group_leave), brief(Object.keys(DEFAULT_ACTION_LIMITS)))
check('F24 set_group_leave.perMinute >= 1', Number(DEFAULT_ACTION_LIMITS.set_group_leave?.perMinute) >= 1, brief(DEFAULT_ACTION_LIMITS.set_group_leave))
check('F24 set_group_leave.perDay 有上限', Number(DEFAULT_ACTION_LIMITS.set_group_leave?.perDay) >= 1, brief(DEFAULT_ACTION_LIMITS.set_group_leave))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
