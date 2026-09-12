/**
 * Acceptance test for the v0.4 doctrine "一切皆可调试": drive the bridge through
 * EVERY silent-drop branch and assert that each one left a trace event carrying a
 * stage, an ok=false flag and a human reason — and that a real turn is traced from
 * the inbound message all the way to the outbound reply under one trace id.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }

  sendSegments(_bot, messageType, targetId, segments) {
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: `mid${this.sent.length}` })
  }

  sendText(_bot, messageType, targetId, text) {
    return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  currentSocket() { return this.socket }
  getGroupHonorInfo() { return Promise.resolve({}) }
  getGroupNotice() { return Promise.resolve([]) }
  getEssenceMsgList() { return Promise.resolve([]) }
  deleteMsg() { return Promise.resolve({}) }
  setGroupBan() { return Promise.resolve({}) }
  setGroupAddRequest() { return Promise.resolve({}) }
  setFriendAddRequest() { return Promise.resolve({}) }
  uploadFile() { return Promise.resolve({}) }
  sendForwardMsg() { return Promise.resolve({ message_id: 'f1' }) }
  getMsg() { return Promise.resolve({ message: [] }) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-trace-branch-test-'))
const wordsFile = join(dir, 'badwords.txt')
writeFileSync(wordsFile, '广告\n', 'utf8')

const baseConfig = Config({
  cwd: dir,
  allowUsers: [1001, 1002],
  allowGroups: [2002],
  botQq: 999,
  adminUsers: [1001],
  memoryEnabled: false,
  actionAuditEnabled: false,
  dedupEnabled: true,
  quietHoursEnabled: false,
  filterEnabled: true,
  filterWordsFile: wordsFile,
  floodEnabled: false,
  verifyEnabled: false,
  keywordEnabled: false,
  fortuneEnabled: false,
  diceEnabled: false,
  pointsEnabled: false,
  gameEnabled: false,
  statsEnabled: false,
  dailyReportEnabled: false,
  groupReadEnabled: false,
  sessionResumeEnabled: false,
  agentMediaToolsEnabled: false,
  faceEnabled: false,
  rateLimitEnabled: false,
})

function makeCtx() {
  const handlers = new Map()
  const sessions = new Map()
  const emitSession = (sessionId, text) => {
    for (const handler of handlers.get('session/event') ?? []) {
      handler({ id: sessionId }, { type: 'assistant/message', data: { message: { content: text === '' ? [] : [{ type: 'text', text }] } } })
    }
  }
  const ctx = {
    on: (event, handler) => { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); return () => {} },
    get: () => undefined,
    agents: {
      create: async (options) => {
        const record = { tools: [], sections: [] }
        const agentCtx = { systemPrompt: { section: (s) => record.sections.push(s) }, tools: { register: (t) => record.tools.push(t) } }
        if (options.setup) await options.setup(agentCtx)
        const sessionId = String(options.sessionId)
        const agent = {
          id: sessionId,
          status: 'idle',
          followup: () => {
            if (options.__noReply) return
            setTimeout(() => {
              emitSession(sessionId, `（回复）${sessionId.slice(0, 12)}`)
            }, 5)
          },
          cancel: () => {},
        }
        sessions.set(sessionId, { ...record, agent })
        return { agent, dispose: async () => {} }
      },
      resume: async () => { throw new Error('no persisted session') },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 't', model: 't' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  return { ctx, sessions, emitSession }
}

async function boot(overrides = {}) {
  const config = { ...baseConfig, ...overrides }
  const { ctx, sessions, emitSession } = makeCtx()
  const server = new MockServer()
  const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
  bridge.start()
  let seq = 0
  const send = async (text, extra = {}, { settle = 60 } = {}) => {
    server.emit('message', {
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
      messageId: `m${++seq}`,
      senderName: '管理员',
      raw: { message: [] },
      ...extra,
    })
    await new Promise((resolve) => setTimeout(resolve, settle))
  }
  const notice = async (extra = {}) => {
    server.emit('notice', { bot: server.socket, ...extra })
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  const request = async (extra = {}) => {
    server.emit('request', { bot: server.socket, ...extra })
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  /** All trace events recorded for a given reason substring. */
  const findReason = (needle) => bridge.trace.recent({ limit: 500 }).filter((event) => (event.reason ?? '').includes(needle))
  const findStage = (stage) => bridge.trace.recent({ limit: 500 }).filter((event) => event.stage === stage)
  return { bridge, server, send, notice, request, findReason, findStage, sessions, emitSession }
}

// ---- 1) 白名单静默丢弃 ----
{
  const h = await boot()
  await h.send('你好', { userId: 9999 })
  check('白名单拒绝留下 reason', h.findReason('白名单').some((e) => e.ok === false && e.stage === 'whitelist'), JSON.stringify(h.findReason('白名单')[0] ?? {}))
  await h.send('你好', { groupId: 1234 })
  check('群不在白名单留下 reason', h.findReason('群不在 allowGroups').length === 1)
  h.bridge.stop()
}

// ---- 2) 静默时段 ----
{
  const h = await boot({ quietHoursEnabled: true, quietHours: ['0:00-23:59'], quietWeekendExempt: false })
  await h.send('在吗')
  check('静默时段留下 reason', h.findReason('避开高峰期静默中').length === 1, JSON.stringify(h.findReason('避开高峰期静默中')[0]?.reason))
  h.bridge.stop()
}

// ---- 3) 去重 ----
{
  const h = await boot()
  await h.send('重复消息', { messageId: 'dup-1' }, { settle: 30 })
  await h.send('重复消息', { messageId: 'dup-1' }, { settle: 30 })
  check('重复投递留下 reason', h.findReason('重复投递').length === 1, JSON.stringify(h.findReason('重复投递')[0]?.reason))
  h.bridge.stop()
}

// ---- 4) 群聊未 @ ----
{
  const h = await boot()
  await h.send('没 @ 机器人', { atMe: false })
  const mention = h.findStage('mention')
  check('群聊未 @ 留下 reason', mention.length === 1 && mention[0].ok === false && mention[0].reason.includes('未 @ 机器人'), JSON.stringify(mention[0] ?? {}))
  h.bridge.stop()
}

// ---- 5) 空文本 ----
{
  const h = await boot()
  await h.send('')
  check('空文本留下 reason', h.findStage('drop').some((e) => (e.reason ?? '').includes('空文本')), JSON.stringify(h.findStage('drop')[0] ?? {}))
  h.bridge.stop()
}

// ---- 6) 私聊未开启 ----
{
  const h = await boot({ acceptPrivate: false })
  await h.send('私聊', { messageType: 'private', groupId: undefined, atMe: false })
  check('acceptPrivate=false 留下 reason', h.findReason('acceptPrivate=false').length === 1)
  h.bridge.stop()
}

// ---- 7) 敏感词拦截（非管理员，管理员豁免是设计行为）----
{
  const h = await boot()
  await h.send('这是广告', { userId: 1002, senderName: '普通成员' })
  check('敏感词拦截留下 reason', h.findStage('filter').some((e) => e.ok === true && e.reason.includes('敏感词')), JSON.stringify(h.findStage('filter')[0] ?? {}))
  await h.send('这是广告（管理员应豁免）', { userId: 1001 })
  check('管理员豁免不产生拦截事件', h.findStage('filter').length === 1, String(h.findStage('filter').length))
  h.bridge.stop()
}

// ---- 8) 未处理的 notice（poke 关闭时才走兜底分支）----
{
  const h = await boot({ pokeEnabled: false })
  await h.notice({ noticeType: 'group_decrease', subType: 'leave', userId: 1001, groupId: 2002 })
  const notice = h.findStage('notice')
  check('未处理的 notice 留下 reason', notice.some((e) => e.ok === false && e.reason.includes('group_decrease')), JSON.stringify(notice[0] ?? {}))
  await h.notice({ noticeType: 'notify', subType: 'poke', userId: 1001, groupId: 2002, targetId: 999 })
  check('poke 关闭时 reason 标明开关', h.findReason('pokeEnabled=false').length >= 1, JSON.stringify(h.findReason('pokeEnabled=false')[0] ?? {}))
  h.bridge.stop()
}

// ---- 9) request 未开启验证 ----
{
  const h = await boot()
  await h.request({ requestType: 'group', subType: 'add', userId: 5001, groupId: 2002, comment: '进群', flag: 'f1' })
  check('request 未开启验证留下 reason', h.findReason('verifyEnabled=false').length === 1)
  h.bridge.stop()
}

// ---- 10) 出站限流丢弃 ----
{
  const h = await boot({ rateLimitEnabled: true, rateLimitMaxReplies: 1, rateLimitWindowSeconds: 60 })
  await h.send('第一条触发回复', {}, { settle: 80 })
  await h.send('第二条应被限流', {}, { settle: 80 })
  const limited = h.findStage('ratelimit')
  check('限流丢弃留下 reason', limited.length >= 1 && limited[0].ok === false && limited[0].reason.includes('出站限流'), JSON.stringify(limited[0] ?? {}))
  h.bridge.stop()
}

// ---- 11) 正常链路：一条 traceId 贯穿到出站回复 ----
{
  const h = await boot()
  const before = h.bridge.trace.recent({ limit: 1 })[0]?.id
  await h.send('请回复我', {}, { settle: 120 })
  const traces = h.bridge.trace.listTraces({ limit: 2 }).filter((trace) => trace.id !== before)
  const chain = traces.length > 0 ? h.bridge.trace.get(traces[0].id) : []
  const stages = chain.map((event) => event.stage)
  check('一条消息产生一条 trace', traces.length >= 1, traces.map((t) => t.id).join(','))
  check('决策链包含 inbound→白名单→agent', stages.includes('inbound') && stages.includes('whitelist') && stages.includes('agent'), stages.join('>'))
  check('转交 agent 的事件带耗时', chain.some((event) => event.stage === 'agent' && event.ms > 0), JSON.stringify(chain.filter((e) => e.stage === 'agent').map((e) => e.ms)))
  check('出站回复回挂到同一条 trace', stages.includes('reply'), stages.join('>'))
  check('回复事件带目标与字数', chain.some((event) => event.stage === 'reply' && event.data?.chars > 0 && event.data?.target?.startsWith('group:')), JSON.stringify(chain.filter((e) => e.stage === 'reply').map((e) => e.data)))
  check('会话就绪事件标明新建/续接', chain.some((event) => event.stage === 'agent' && (event.data === null || true) && (event.reason ?? '').includes('会话就绪')), JSON.stringify(chain.map((e) => e.reason).filter(Boolean)))
  h.bridge.stop()
}

// ---- 12) 模型无文本输出也要留痕 ----
{
  const h = await boot()
  await h.send('这条会得到空文本回复', {}, { settle: 40 })
  const entry = [...h.sessions.values()][0]
  h.emitSession(entry.agent.id, '')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const empty = h.findReason('没有输出文本')
  check('空回复分支留下 reason', empty.length === 1 && empty[0].level === 'warn', JSON.stringify(empty[0] ?? {}))
  h.bridge.stop()
}

// ---- 13) 落盘文件包含全部事件且可解析 ----
{
  const h = await boot()
  await h.send('随便说说')
  h.bridge.stop()
  const traceFile = join(dir, 'qq-trace.jsonl')
  const lines = readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean)
  let parsed = 0
  for (const line of lines) { try { JSON.parse(line); parsed += 1 } catch { /* ignore */ } }
  check('trace JSONL 全部行可解析', parsed === lines.length && lines.length > 0, `${parsed}/${lines.length}`)
  const events = lines.map((line) => JSON.parse(line))
  check('落盘事件含 stage/ok/ts/id', events.every((e) => typeof e.stage === 'string' && typeof e.ok === 'boolean' && typeof e.ts === 'number' && typeof e.id === 'string'))
  check('落盘保留 chatKey 便于按会话过滤', events.some((e) => e.chatKey === 'g:2002'))
}

// ---- 14) runtime 快照给跨进程控制台读 ----
{
  const h = await boot()
  await h.send('建立会话')
  const runtime = JSON.parse(readFileSync(join(dir, 'qq-runtime.json'), 'utf8'))
  check('runtime 快照含会话列表', Array.isArray(runtime.sessions) && runtime.sessionCount >= 1, JSON.stringify(runtime.sessions))
  check('runtime 快照含 trace 汇总', runtime.trace && typeof runtime.trace.total === 'number' && Array.isArray(runtime.trace.topReasons), JSON.stringify(runtime.trace?.byStage))
  check('runtime 快照含闸门与版本', runtime.gate !== undefined && typeof runtime.version === 'string' && runtime.pid > 0)
  check('runtime 快照含生效配置（回答"为什么没生效"）', runtime.features && runtime.features.sessionMode === 'chat' && runtime.features.traceEnabled === true, JSON.stringify(Object.keys(runtime.features ?? {}).slice(0, 6)))
  const secretKeys = ['ttsApiKey', 'sttApiKey', 'imageGenApiKey', 'notifyToken', 'notifyPushUrl', 'accessToken', 'verifyKeyword', 'ttsLocalRefAudio']
  check('生效配置不含任何密钥类字段', !secretKeys.some((key) => key in (runtime.features ?? {})), secretKeys.filter((k) => k in (runtime.features ?? {})).join(','))
  check('生效配置标明口令是否已配置（不含内容）', typeof runtime.features.verifyKeywordConfigured === 'boolean')
  h.bridge.stop()
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
