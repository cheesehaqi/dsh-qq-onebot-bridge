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
import { mkdtempSync, rmSync } from 'node:fs'
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
  setDryRun(enabled) { const previous = this.dryRun; this.dryRun = enabled === true; if (this.dryRun) this.dryRunCalls = []; return previous }
  takeDryRunCalls() { const calls = this.dryRunCalls.slice(); this.dryRunCalls = []; return calls }
  sendSegments(_bot, messageType, targetId, segments) {
    if (this.dryRun) { this.dryRunCalls.push({ action: `${messageType === 'group' ? 'send_group_msg' : 'send_private_msg'}`, params: { message: segments } }); return Promise.resolve({ message_id: `dry-${this.dryRunCalls.length}`, dryRun: true }) }
    this.sent.push({ messageType, targetId, text: segments.map((segment) => segment.data?.text ?? '').join('') })
    return Promise.resolve({ message_id: `mid${this.sent.length}` })
  }
  sendForwardMsg() { this.sent.push({ messageType: 'forward', targetId: 0, text: '[合并转发]' }); return Promise.resolve({ message_id: 'fwd1' }) }
  currentSocket() { return this.socket }
  async stop() {}
}

/**
 * mock DSH 上下文：`reply` 决定模型这一回合怎么回应（文本 / 报错 / 不回话）。
 * `emit` 让测试能精确控制"什么时候回话"，从而制造注入窗口关闭后才回话的时序。
 */
function makeCtx() {
  const handlers = new Map()
  const records = new Map()
  const emit = (sessionId, event) => {
    for (const handler of handlers.get('session/event') ?? []) handler({ id: sessionId }, event)
  }
  const build = async (sessionId, options) => {
    const record = { followups: [], sections: 0, tools: 0 }
    const agentCtx = {
      systemPrompt: { section: () => { record.sections += 1 } },
      tools: { register: () => { record.tools += 1 } },
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
  return { ctx, emit, records }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-inject-guard-'))
const config = Config({
  cwd: dir,
  allowUsers: [1001],
  allowGroups: [2002],
  botQq: 999,
  sessionMode: 'chat',
  sessionResumeEnabled: false,
  actionAuditEnabled: false,
  memoryEnabled: true,
  ttsEnabled: false,
  sttEnabled: false,
  notifyEnabled: false,
  traceEnabled: true,
  traceLevel: 'debug',
  injectEnabled: false,     // 直接用 #handleInjection 之外的公开入口（server.emit）更贴近真实，但这里测私有分支用 emit('message') + __injected
  recordInbound: false,
})
config.injectDryRun = true

const server = new StubServer()
const mock = makeCtx()
const bridge = new QQBridge(mock.ctx, config, server, { info() {}, warn() {}, error() {} })
bridge.start()
bridge.timers.forEach((timer) => clearTimeout(timer))   // 定时器不参与本测试

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

bridge.stop()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
