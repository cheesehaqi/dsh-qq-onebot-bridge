/**
 * 注入安全边界测试：注入的帧**绝不能**真的发出 QQ 消息。
 *
 * 同步阶段由 OneBotServer 的 dry-run 覆盖；真正危险的是**异步的 agent 回合**——
 * dry-run 窗口在 `#handleInjection` 结束时关掉，模型几秒后才回话，那条回复如果
 * 没人拦就会真的发出去（真机测试抓到过：注入触发了一轮真实模型回答）。
 *
 * 这里用 mock DSH 上下文把整条链路跑起来，驱动四种时序：
 *   ① 注入消息 + 模型回话 → 出站必须为空，且事件流里有"注入回合的模型回复已被拦截"
 *   ② 注入之后的**真人消息** → 必须恢复正常发送（不能被注入标记连坐）
 *   ③ 注入回合模型报错（没有 assistant/message）→ 记账要清掉，后续真人回复照常
 *   ④ 连续两次注入 → 两次回复都被拦下，不会漏掉第二次
 */
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/index.js'
import { QQBridge } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class StubServer extends EventEmitter {
  constructor({ dryRun = false } = {}) {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
    this.dryRun = dryRun
    this.dryRunCalls = []
  }
  setDryRun(enabled, scope = null) {
    const previous = { enabled: this.dryRun, scope: this.dryRunScope ?? null }
    this.dryRun = enabled === true
    this.dryRunScope = this.dryRun && scope ? { ...scope } : null
    if (this.dryRun) this.dryRunCalls = []
    return previous
  }
  /** 只有命中作用域的调用才被拦（与 lib/onebot.js 的 #inDryRunScope 一致）。 */
  #inScope(params) {
    if (!this.dryRun) return false
    if (!this.dryRunScope) return true
    const { groupId = 0, userId = 0 } = this.dryRunScope
    if (groupId && Number(params?.group_id) === Number(groupId)) return true
    if (userId && Number(params?.user_id) === Number(userId)) return true
    return false
  }
  sendSegments(_bot, messageType, targetId, segments) {
    const params = messageType === 'group' ? { group_id: targetId, message: segments } : { user_id: targetId, message: segments }
    if (this.#inScope(params)) {
      this.dryRunCalls.push({ action: messageType === 'group' ? 'send_group_msg' : 'send_private_msg', params })
      return Promise.resolve({ message_id: `dry-${this.dryRunCalls.length}`, dryRun: true })
    }
    this.sent.push({ messageType, targetId, text: segments.map((segment) => segment.data?.text ?? '').join('') })
    return Promise.resolve({ message_id: `mid${this.sent.length}` })
  }
  takeDryRunCalls() { const calls = this.dryRunCalls.slice(); this.dryRunCalls = []; return calls }
  sendForwardMsg() { this.sent.push({ messageType: 'forward', targetId: 0, text: '[合并转发]' }); return Promise.resolve({ message_id: 'fwd1' }) }
  currentSocket() { return this.socket }
  async stop() {}
}

/**
 * mock DSH 上下文：`reply` 决定模型这一回合怎么回应（文本 / 报错 / 不回话）。
 * `emit` 让测试能精确控制"什么时候回话"，从而制造注入窗口关闭后才回话的时序。
 */
function makeCtx({ createDelayMs = 0 } = {}) {
  const handlers = new Map()
  const records = new Map()
  const registeredTools = []
  const emit = (sessionId, event) => {
    for (const handler of handlers.get('session/event') ?? []) handler({ id: sessionId }, event)
  }
  const build = async (sessionId, options) => {
    // 模拟真实宿主建会话的耗时：用来制造"注入派发仍在进行"的窗口
    if (createDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, createDelayMs))
    const record = { followups: [], sections: 0, tools: 0 }
    const agentCtx = {
      systemPrompt: { section: () => { record.sections += 1 } },
      tools: { register: (tool) => { record.tools += 1; registeredTools.push(tool); return tool } },
    }
    if (options.setup) await options.setup(agentCtx)
    record.sessionId = String(sessionId)
    const agent = {
      id: String(sessionId),
      status: 'idle',
      followup: (message) => {
        record.followups.push((message.content ?? []).map((block) => block.text ?? '').join(''))
      },
      cancel: () => {},
    }
    records.set(String(sessionId), record)
    return { agent, dispose: async () => {} }
  }
  const ctx = {
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(handler)
      return () => handlers.get(event)?.delete(handler)
    },
    get: () => undefined,
    agents: {
      create: async ({ sessionId, setup }) => build(sessionId ?? `qq-mock-${records.size + 1}`, { setup }),
      resume: async ({ resumeSessionId, setup }) => build(resumeSessionId ?? `qq-mock-r${records.size + 1}`, { setup }),
    },
    agentDefaultModel: { currentSelection: () => ({}) },
  }
  return { ctx, emit, records, tools: registeredTools }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-inject-guard-'))
const injectFile = join(dir, 'qq-inject.jsonl')
const config = Config({
  cwd: dir,
  allowUsers: [1001],
  allowGroups: [2002],
  botQq: 999,
  adminUsers: [1001],
  sessionMode: 'chat',
  sessionResumeEnabled: false,
  actionAuditEnabled: false,
  memoryEnabled: true,
  ttsEnabled: false,
  sttEnabled: false,
  notifyEnabled: false,
  traceEnabled: true,
  traceLevel: 'debug',
  recordInbound: false,
  // 走真实注入通道：注入只在会话空闲时投递（这是"记账不错位"的前提）
  injectEnabled: true,
  injectFile,
  injectIntervalMs: 500,
  injectDryRun: true,
})
config.injectDryRun = true

/** 追加一行到注入队列（模拟控制台写入）。 */
function queueInjection(spec) {
  appendFileSync(injectFile, `${JSON.stringify(spec)}\n`, 'utf8')
}

/** 轮询等待一个条件成立。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(80)
  }
  return predicate()
}

const server = new StubServer()
const mock = makeCtx()
const bridge = new QQBridge(mock.ctx, config, server, { info() {}, warn() {}, error() {} })
bridge.start()

const groupFrame = (text, extra = {}) => ({
  bot: server.socket,
  messageType: 'group',
  groupId: 2002,
  userId: 1001,
  text,
  atMe: true,
  ats: [999],
  reply: null,
  records: [],
  images: [],
  files: [],
  messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
  senderName: '测试',
  raw: { message: [] },
  ...extra,
})
const replyOf = (sessionId, text) => mock.emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const turnStart = (sessionId, turn = 1) => mock.emit(sessionId, { type: 'turn/start', data: { turn } })
const turnEnd = (sessionId, turn = 1, reason = { kind: 'completed' }) => mock.emit(sessionId, { type: 'turn/end', data: { turn, reason } })
const sessionIdOf = (text) => {
  const record = [...mock.records.values()].find((item) => item.followups.includes(text))
  return record?.sessionId ?? ''
}

// ---- ① 真人消息：正常发送（基线） ----
server.emit('message', groupFrame('真人消息一'))
await sleep(30)
const firstSession = sessionIdOf('真人消息一')
check('真人消息建立了会话并转交 agent', firstSession !== '', firstSession || '（没有会话）')
turnStart(firstSession)
replyOf(firstSession, '真人回复一')
turnEnd(firstSession)
await sleep(30)
check('真人回复照常发出（基线）', server.sent.length === 1 && server.sent[0].text === '真人回复一', JSON.stringify(server.sent))

// ---- ② 注入消息：同步窗口 + 异步回复都必须被拦下 ----
server.emit('message', groupFrame('注入的消息', { __injected: true }))
await sleep(30)
check('注入帧也走真实管线（转交给了 agent）', mock.records.get(firstSession).followups.includes('注入的消息'))
turnStart(firstSession, 2)
replyOf(firstSession, '注入回合的回复')
turnEnd(firstSession, 2)
await sleep(30)
check('注入回合的模型回复没有被发出', server.sent.length === 1, `已发送 ${server.sent.length} 条`)
const events = bridge.trace.recent({ limit: 200 })
const suppressed = events.filter((event) => String(event.reason ?? '').includes('注入回合的模型回复已被拦截'))
check('事件流记录了"注入回复被拦截"并带原文', suppressed.length === 1 && suppressed[0].reason.includes('注入回合的回复'), suppressed[0]?.reason ?? '（没有记录）')
check('拦截事件带 suppressed 标记与长度', suppressed[0]?.data?.suppressed === true && suppressed[0]?.data?.length === '注入回合的回复'.length)
check('拦截有中文原因而不是静默丢弃', events.every((event) => event.ok !== false || event.reason))

// ---- ③ 注入之后的真人消息：必须恢复正常 ----
server.emit('message', groupFrame('真人消息二'))
await sleep(30)
turnStart(firstSession, 3)
replyOf(firstSession, '真人回复二')
turnEnd(firstSession, 3)
await sleep(30)
check('注入之后的真人回复照常发出', server.sent.length === 2 && server.sent[1].text === '真人回复二', JSON.stringify(server.sent.map((item) => item.text)))

// ---- ④ 注入回合报错（没有 assistant/message）：记账清掉，别连坐下一回合 ----
server.emit('message', groupFrame('注入的消息二', { __injected: true }))
await sleep(30)
turnStart(firstSession, 4)
turnEnd(firstSession, 4, { kind: 'error', error: { message: "Cannot read properties of undefined (reading 'filter')" } })
await sleep(20)
server.emit('message', groupFrame('真人消息三'))
await sleep(30)
turnStart(firstSession, 5)
replyOf(firstSession, '真人回复三')
turnEnd(firstSession, 5)
await sleep(30)
check('注入回合报错后真人回复不被连坐', server.sent.length === 3 && server.sent[2].text === '真人回复三', JSON.stringify(server.sent.map((item) => item.text)))

// ---- ⑤ 连续两次注入：两次回复都要被拦 ----
server.emit('message', groupFrame('注入的消息三', { __injected: true }))
await sleep(20)
turnStart(firstSession, 6)
replyOf(firstSession, '注入回复三')
turnEnd(firstSession, 6)
await sleep(20)
server.emit('message', groupFrame('注入的消息四', { __injected: true }))
await sleep(20)
turnStart(firstSession, 7)
replyOf(firstSession, '注入回复四')
turnEnd(firstSession, 7)
await sleep(30)
check('连续两次注入都被拦下', server.sent.length === 3, `已发送 ${server.sent.length} 条`)
check('每次拦截都有独立事件', bridge.trace.recent({ limit: 300 }).filter((event) => String(event.reason ?? '').includes('注入回合的模型回复已被拦截')).length === 3)

// ---- ⑥ 注入的私聊同理 ----
server.emit('message', { bot: server.socket, messageType: 'private', userId: 1001, text: '私聊注入', atMe: false, ats: [], reply: null, records: [], images: [], files: [], messageId: 'pm-1', senderName: '测试', raw: { message: [] }, __injected: true })
await sleep(30)
const privateSession = [...mock.records.values()].find((item) => item.followups.includes('私聊注入'))?.sessionId ?? ''
check('私聊注入也建立了会话', privateSession !== '')
turnStart(privateSession, 1)
replyOf(privateSession, '私聊注入回复')
turnEnd(privateSession, 1)
await sleep(30)
check('私聊注入的回复同样被拦', server.sent.length === 3, `已发送 ${server.sent.length} 条`)

// ---- ⑦ 注入的同步出站（命令回复）仍由 dry-run 覆盖 ----
server.dryRun = true
const dryBefore = server.sent.length
server.emit('message', groupFrame('/status', { __injected: true }))
await sleep(40)
check('注入触发的同步出站进入 dry-run 队列', server.dryRunCalls.length > 0 || server.sent.length === dryBefore, `dryRunCalls=${server.dryRunCalls.length} sent=${server.sent.length}`)
check('dry-run 期间没有真实出站', server.sent.length === dryBefore)
server.dryRun = false

// ---- ⑧ 真人消息插队在「注入 → 模型回复」之间：注入回复仍不可发出 ----
// 这是最容易漏的时序：注入先入队，真人消息在后、模型还没回话。若用"真人消息清零标记"
// 的记法，注入回合的回复就会在窗口关闭后被真发出去。
const beforeInterleave = server.sent.length
server.emit('message', groupFrame('注入的消息五', { __injected: true }))
await sleep(20)
server.emit('message', groupFrame('真人插队消息'))
await sleep(20)
turnStart(firstSession, 8)
replyOf(firstSession, '注入回复五（不该发出去）')
turnEnd(firstSession, 8)
await sleep(40)
check('真人插队后，注入回合的回复仍未被发出', !server.sent.some((item) => String(item.text).includes('注入回复五')), JSON.stringify(server.sent.map((item) => item.text)))
turnStart(firstSession, 9)
replyOf(firstSession, '真人插队消息的回复')
turnEnd(firstSession, 9)
await sleep(30)
check('插队真人的回复同样照常发出', server.sent.some((item) => item.text === '真人插队消息的回复'), JSON.stringify(server.sent.map((item) => item.text)))
check('插队场景下注入拦截有独立事件', bridge.trace.recent({ limit: 400 }).some((event) => String(event.reason ?? '').includes('注入回复五')))

// ---- ⑨ 一个注入回合里的**多条** assistant/message（用工具的回合必然多步）都要被拦 ----
const beforeMulti = server.sent.length
server.emit('message', groupFrame('注入的消息六', { __injected: true }))
await sleep(20)
turnStart(firstSession, 10)
replyOf(firstSession, '第1步：我先查一下工具')
replyOf(firstSession, '第2步：这是注入回合的最终回答')
turnEnd(firstSession, 10)
await sleep(30)
check('注入回合的多步回复全部被拦（不止第一条）', server.sent.length === beforeMulti, JSON.stringify(server.sent.map((item) => item.text)))

// ---- ⑩ 注入回合里 agent 调工具产生的出站（发图/撤回）也必须被拦 ----
const tools = mock.tools
const sendImageTool = tools.find((tool) => tool.name === 'qq_send_image')
const recallTool = tools.find((tool) => tool.name === 'qq_recall')
check('会话工具已注册（发图/撤回）', Boolean(sendImageTool) && Boolean(recallTool))
server.emit('message', groupFrame('注入的消息七', { __injected: true }))
await sleep(20)
turnStart(firstSession, 11)
const imageResult = await sendImageTool.execute({ path: 'pic.png' })
const recallResult = await recallTool.execute({ count: 1 })
turnEnd(firstSession, 11)
await sleep(30)
check('注入回合里发图被拦（工具返回未发送）', imageResult?.sent === false && String(imageResult.detail).includes('注入回合'), JSON.stringify(imageResult))
check('注入回合里撤回被拦', recallResult?.recalled === 0 && String(recallResult.detail).includes('注入回合'), JSON.stringify(recallResult))
check('工具出站被拦时同样留事件', bridge.trace.recent({ limit: 500 }).some((event) => String(event.reason ?? '').includes('图片') && String(event.reason ?? '').includes('已被拦截')))
check('注入回合没有产生真实出站', server.sent.length === beforeMulti, JSON.stringify(server.sent.map((item) => item.text)))

// ---- ⑪ 会话正在跑回合时注入被推迟（走真实注入通道）：不污染真人回合、也不漏拦 ----
const beforeBusy = server.sent.length
server.emit('message', groupFrame('真人消息四'))
await sleep(20)
turnStart(firstSession, 12)                          // 真人回合进行中
await sleep(60)
queueInjection({ kind: 'message', text: '注入的消息八', groupId: 2002, userId: 1001, atMe: true })
await waitFor(() => bridge.deferredInjections.length === 1, 3000)
check('会话忙时注入被推迟（没有立刻投递）', bridge.deferredInjections.length === 1, `队列 ${bridge.deferredInjections.length}`)
check('推迟有事件记录', bridge.trace.recent({ limit: 500 }).some((event) => String(event.reason ?? '').includes('注入推迟')))
replyOf(firstSession, '真人回复四')
turnEnd(firstSession, 12)
await sleep(30)
check('被推迟的注入没有污染真人回合（真人回复照常发出）', server.sent.some((item) => item.text === '真人回复四'), JSON.stringify(server.sent.map((item) => item.text)))
await waitFor(() => (mock.records.get(firstSession)?.followups ?? []).some((text) => text.includes('注入的消息八')), 4000)
check('会话空闲后注入被投递到真实管线', (mock.records.get(firstSession)?.followups ?? []).some((text) => text.includes('注入的消息八')), JSON.stringify(mock.records.get(firstSession)?.followups))

// ---- ⑫ 投递后的注入回合（自己的回合）回复仍被拦 ----
turnStart(firstSession, 13)
replyOf(firstSession, '注入回复八（不该发出去）')
turnEnd(firstSession, 13)
await sleep(30)
check('经通道投递的注入回复仍被拦下', !server.sent.some((item) => String(item.text).includes('注入回复八')), JSON.stringify(server.sent.map((item) => item.text)))

// ---- ⑬ 注入窗口期到达的真人消息不被吞（不再使用服务器级 dry-run） ----
const beforeReal = server.sent.length
server.emit('message', groupFrame('窗口期真人消息'))
await sleep(20)
turnStart(firstSession, 14)
replyOf(firstSession, '窗口期真人回复')
turnEnd(firstSession, 14)
await sleep(30)
check('真人消息的回复不会被注入窗口吞掉', server.sent.length === beforeReal + 1 && server.sent.some((item) => item.text === '窗口期真人回复'), JSON.stringify(server.sent.map((item) => item.text)))

// ---- ⑭ 注入帧登记的**延时发送**（提醒）到点也不许发 QQ（审计发现的第二条通道） ----
const beforeReminder = server.sent.length
queueInjection({ kind: 'message', text: '6秒后提醒我喝水', groupId: 2002, userId: 1001, atMe: true })
await waitFor(() => [...bridge.reminders.values()].some((rem) => rem.injected === true), 4000)
const injectedReminder = [...bridge.reminders.values()].find((rem) => rem.injected === true)
check('注入登记的提醒被打上 injected 标记', Boolean(injectedReminder), JSON.stringify([...bridge.reminders.values()].map((rem) => ({ id: rem.id, injected: rem.injected }))))
await waitFor(() => !bridge.reminders.has(injectedReminder?.id), 12000)
await sleep(300)
check('注入登记的提醒到点后没有发 QQ', server.sent.length === beforeReminder, JSON.stringify(server.sent.map((item) => item.text)))
check('提醒被拦时留下事件', bridge.trace.recent({ limit: 600 }).some((event) => String(event.reason ?? '').includes('注入登记的提醒已被拦截')))

// ---- ⑮ 注入帧发起的投票开奖也不许发 QQ ----
const beforeVote = server.sent.length
queueInjection({ kind: 'message', text: '投票：晚饭吃什么？A 火锅 B 烧烤', groupId: 2002, userId: 1001, atMe: true })
await waitFor(() => [...bridge.votes.values()].some((vote) => vote.injected === true), 4000)
check('注入发起的投票被打上 injected 标记', [...bridge.votes.values()].some((vote) => vote.injected === true))
queueInjection({ kind: 'message', text: '/vote-end', groupId: 2002, userId: 1001, atMe: true })
await sleep(1500)
check('注入投票开奖没有发 QQ', server.sent.length === beforeVote, JSON.stringify(server.sent.map((item) => item.text)))
check('投票开奖被拦时留下事件', bridge.trace.recent({ limit: 800 }).some((event) => String(event.reason ?? '').includes('注入登记的投票结果已被拦截')), JSON.stringify(bridge.trace.recent({ limit: 100 }).filter((event) => event.reason).map((event) => String(event.reason).slice(0, 32)).slice(-6)))

// ---- ⑯ 注入派发期间，别的会话的真人回复不受影响（作用域 dry-run） ----
// 让 mock 建会话变慢，制造"注入派发仍在进行"的窗口，再从**另一个群**发真人消息
const slowDir = mkdtempSync(join(tmpdir(), 'qq-inject-scope-'))
const slowInjectFile = join(slowDir, 'qq-inject.jsonl')
const slowMock = makeCtx({ createDelayMs: 800 })
const slowServer = new StubServer()
const slowBridge = new QQBridge(slowMock.ctx, Config({
  cwd: slowDir,
  allowUsers: [1001],
  allowGroups: [2002, 2003],
  botQq: 999,
  sessionMode: 'chat',
  sessionResumeEnabled: false,
  actionAuditEnabled: false,
  memoryEnabled: false,
  ttsEnabled: false,
  sttEnabled: false,
  notifyEnabled: false,
  traceEnabled: true,
  recordInbound: false,
  injectEnabled: true,
  injectFile: slowInjectFile,
  injectIntervalMs: 500,
  injectDryRun: true,
}), slowServer, { info() {}, warn() {}, error() {} })
slowBridge.start()
appendFileSync(slowInjectFile, `${JSON.stringify({ kind: 'message', text: '注入的消息', groupId: 2002, userId: 1001, atMe: true })}\n`, 'utf8')
await waitFor(() => slowBridge.injecting === true, 4000)
// 注入派发还在等会话建立（800ms）时，另一个群来了一条真人消息
slowServer.emit('message', { bot: slowServer.socket, messageType: 'group', groupId: 2003, userId: 1001, text: '别的群的真人消息', atMe: true, ats: [999], reply: null, records: [], images: [], files: [], messageId: 'g2003-1', senderName: '测试', raw: { message: [] } })
await waitFor(() => [...slowMock.records.values()].some((record) => record.followups.includes('别的群的真人消息')), 5000)
const otherSession = [...slowMock.records.values()].find((record) => record.followups.includes('别的群的真人消息'))?.sessionId ?? ''
await waitFor(() => slowBridge.injecting === false, 5000)
if (otherSession) {
  slowMock.emit(otherSession, { type: 'turn/start', data: { turn: 1 } })
  slowMock.emit(otherSession, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '别的群的真人回复' }] } } })
  slowMock.emit(otherSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}
await sleep(300)
check('注入派发期间其它群的真人回复照常发出', slowServer.sent.some((item) => item.text === '别的群的真人回复'), JSON.stringify(slowServer.sent.map((item) => item.text)))
check('注入派发期间其它群的出站没有被计入注入拦截', slowServer.dryRunCalls.every((call) => Number(call.params?.group_id) === 2002 || Number(call.params?.user_id) === 1001), JSON.stringify(slowServer.dryRunCalls.map((call) => call.params)))
slowBridge.stop()

// ---- ⑰ 注入通道异常后不许永久卡死 ----
const flakyMock = makeCtx()
const flakyServer = new StubServer()
let threw = false
const originalSetDryRun = flakyServer.setDryRun.bind(flakyServer)
flakyServer.setDryRun = (enabled, scope) => { if (!threw) { threw = true; throw new Error('boom in setDryRun') } return originalSetDryRun(enabled, scope) }
const flakyBridge = new QQBridge(flakyMock.ctx, Config({
  cwd: mkdtempSync(join(tmpdir(), 'qq-inject-flaky-')),
  allowUsers: [1001],
  allowGroups: [2002],
  botQq: 999,
  sessionMode: 'chat',
  sessionResumeEnabled: false,
  actionAuditEnabled: false,
  ttsEnabled: false,
  sttEnabled: false,
  notifyEnabled: false,
  traceEnabled: true,
  recordInbound: false,
  injectEnabled: true,
  injectFile: join(mkdtempSync(join(tmpdir(), 'qq-inject-flaky-file-')), 'qq-inject.jsonl'),
  injectIntervalMs: 500,
  injectDryRun: true,
}), flakyServer, { info() {}, warn() {}, error() {} })
flakyBridge.start()
appendFileSync(flakyBridge.injectFile, `${JSON.stringify({ kind: 'message', text: '第一次注入', groupId: 2002, userId: 1001 })}\n`, 'utf8')
await waitFor(() => flakyBridge.injecting === false && threw, 5000)
check('注入派发异常后 injecting 被复位（通道不卡死）', flakyBridge.injecting === false, String(flakyBridge.injecting))
appendFileSync(flakyBridge.injectFile, `${JSON.stringify({ kind: 'message', text: '第二次注入', groupId: 2002, userId: 1001 })}\n`, 'utf8')
await waitFor(() => [...flakyMock.records.values()].some((record) => record.followups.includes('第二次注入')), 5000)
check('异常之后的注入仍能被消费', [...flakyMock.records.values()].some((record) => record.followups.includes('第二次注入')))
flakyBridge.stop()
server.dryRun = false

bridge.stop()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
