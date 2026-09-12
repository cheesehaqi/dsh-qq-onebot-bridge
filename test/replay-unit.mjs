/**
 * Unit tests for the offline replay engine.
 *
 * Two layers:
 *   1. pure helpers (sandbox planning/copying, mock ctx, verdict summarising,
 *      pruning) driven entirely by injections;
 *   2. `createReplayer().run()` driven by a STUB bridge server + stub bridge, so the
 *      orchestration (single entry, batches, exceptions, time budget, warnings) is
 *      tested without loading the real pipeline. The real end-to-end replay is
 *      covered by test/replay-live.mjs.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MEDIA_DIRS, NEVER_COPY, STATE_FILES, copySandboxState, createMockCtx, createReplayer,
  formatReplayText, planSandboxCopy, pruneSandboxes, sandboxConfig, stageLabel, summarizeEntry,
} from '../control/lib/replay.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const dir = mkdtempSync(join(tmpdir(), 'qq-replay-unit-'))
const exists = (file) => existsSync(file)

// ---------------------------------------------------------- sandbox planning --
const live = join(dir, 'live')
mkdirSync(live, { recursive: true })
for (const name of ['qq-keywords.json', 'qq-reminders.json', 'qq-points', 'qq-memory', 'qq-images', 'qq-sessions.json']) {
  if (name.endsWith('.json')) writeFileSync(join(live, name), '{"a":1}', 'utf8')
  else { mkdirSync(join(live, name), { recursive: true }); writeFileSync(join(live, name, 'x.json'), '{}', 'utf8') }
}
for (const name of ['qq-runtime.json', 'qq-inbox.jsonl', 'qq-inject.jsonl', 'qq-actions.log']) {
  writeFileSync(join(live, name), 'noise', 'utf8')
}
const plan = planSandboxCopy(live)
check('状态文件进入复制计划', plan.files.includes('qq-keywords.json') && plan.files.includes('qq-reminders.json'))
check('状态目录进入复制计划', plan.dirs.includes('qq-points') && plan.dirs.includes('qq-memory'))
check('敏感文件永不复制', NEVER_COPY.every((name) => !plan.files.includes(name) && !plan.dirs.includes(name)))
check('缺失的状态文件被跳过', !plan.files.includes('qq-counters.json'))
check('媒体目录被单独标记而不复制', plan.skippedMedia.includes('qq-images') && !plan.dirs.includes('qq-images'))
check('空媒体目录不算提示', planSandboxCopy(live, { exists: () => true, stat: () => ({ isFile: () => false, isDirectory: () => true }), readdir: () => [] }).skippedMedia.length === 0)
check('读取全部失败时不抛错', planSandboxCopy(live, { exists: () => { throw new Error('x') }, stat: () => { throw new Error('x') }, readdir: () => { throw new Error('x') } }).files.length === 0)
check('STATE_FILES 与 MEDIA_DIRS 无交集', STATE_FILES.every((name) => !MEDIA_DIRS.includes(name)))

const sandbox = join(dir, 'sandbox')
const copied = copySandboxState(live, sandbox)
check('复制结果记录成功项', copied.copied.includes('qq-keywords.json') && copied.copied.includes('qq-points/'))
check('复制真的落盘', exists(join(sandbox, 'qq-keywords.json')) && exists(join(sandbox, 'qq-points', 'x.json')))
check('复制不做媒体目录', !exists(join(sandbox, 'qq-images')))
check('复制不做敏感文件', !exists(join(sandbox, 'qq-inbox.jsonl')))
check('复制失败被记录而非抛出', copySandboxState(live, join(dir, 'sb2'), { copyFile: () => { throw new Error('locked') } }).failed.includes('qq-keywords.json'))
check('沙箱建立失败返回空计划', copySandboxState(live, sandbox, { mkdir: () => { throw new Error('x') } }).copied.length === 0)

// ------------------------------------------------------------ forced config --
const forced = sandboxConfig('C:\\sb', 3000000001)
check('cwd 被强制指向沙箱', forced.cwd === 'C:\\sb')
check('trace/inbox/inject 都在沙箱内', forced.traceFile.startsWith('C:\\sb') && forced.inboxFile.startsWith('C:\\sb') && forced.injectFile.startsWith('C:\\sb'))
check('回放强制关闭录制与注入', forced.recordInbound === false && forced.injectEnabled === false)
check('回放强制关闭外发通道', forced.notifyEnabled === false && forced.ttsEnabled === false && forced.sttEnabled === false)
check('回放强制关闭审计与续接', forced.actionAuditEnabled === false && forced.sessionResumeEnabled === false)
check('trace 保持开启且为 debug', forced.traceEnabled === true && forced.traceLevel === 'debug')
check('botQq 仅在有效时写入', !('botQq' in sandboxConfig('C:\\sb', 0)) && sandboxConfig('C:\\sb', 7).botQq === 7)
check('memory 足够大以免环形覆盖', forced.traceMemorySize >= 1000)

// -------------------------------------------------------------- mock agent --
const mock = createMockCtx({ replyText: '模拟回复', botQq: 999 })
check('mock ctx 提供 on/agents/agentDefaultModel', typeof mock.ctx.on === 'function' && typeof mock.ctx.agents.create === 'function' && typeof mock.ctx.agentDefaultModel.currentSelection === 'function')
check('mock ctx 没有真实模型入口', mock.ctx.agents.send === undefined && mock.ctx.models === undefined)
check('mock ctx get 返回 undefined', mock.ctx.get('attachments') === undefined)

const seen = []
mock.ctx.on('session/event', (session, event) => {
  const text = event.type === 'assistant/message' ? event.data.message.content[0].text : ''
  seen.push(`${session.id}:${event.type}${text ? `(${text})` : ''}`)
})
check('on 返回可用的取消订阅函数', typeof mock.ctx.on('session/event', () => {}) === 'function')

async function mockFlow() {
  const handle = await mock.ctx.agents.create({
    sessionId: 'qq-replay-1',
    setup: (agentCtx) => {
      agentCtx.tools.register({ name: 'fake-tool' })
      agentCtx.systemPrompt.section({ name: 'fake-section', text: 'x' })
    },
  })
  check('create 返回 agent 与 id', String(handle.agent.id) === 'qq-replay-1' && handle.agent.status === 'idle')
  check('setup 收到 agentCtx 且注册生效', mock.tools.length === 1 && mock.sections.length === 1)
  handle.agent.followup({ content: [{ type: 'text', text: '用户消息' }, { type: 'image', data: {} }] })
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('followup 记录用户文本', mock.turns.length === 1 && mock.turns[0].text === '用户消息')
  check('模拟回合按真实顺序发出事件', seen.join('|') === 'qq-replay-1:turn/start|qq-replay-1:assistant/message(模拟回复)|qq-replay-1:turn/end', seen.join('|'))
  check('模拟回复内容来自注入文本', seen.some((line) => line.includes('(模拟回复)')))
  handle.agent.cancel({ kind: 'user' })
  await handle.dispose()
  const resumed = await mock.ctx.agents.resume({ resumeSessionId: 'qq-old-9' })
  check('resume 复用既有 sessionId', String(resumed.agent.id) === 'qq-old-9')
  check('监听器异常不影响其它监听器', (() => {
    mock.ctx.on('boom', () => { throw new Error('bad listener') })
    let ok = false
    mock.ctx.on('boom', () => { ok = true })
    mock.emit('boom')
    return ok
  })())
}

// ------------------------------------------------------------- summarizing --
const stages = { reply: '回复', whitelist: '白名单' }
const silent = summarizeEntry({
  events: [
    { id: 't-1', stage: 'inbound', ok: true },
    { id: 't-1', stage: 'whitelist', ok: false, reason: '不在白名单' },
  ],
  calls: [], stages,
})
check('静默条目给出被拒原因', silent.status === 'silent' && silent.verdict.includes('不在白名单'))
check('静默条目仍带完整链路', silent.chain.length === 2 && silent.chain[1].label === '白名单')
check('静默条目保留 traceId', silent.traceId === 't-1')
const replied = summarizeEntry({
  events: [{ id: 't-2', stage: 'inbound', ok: true }, { id: 't-2', stage: 'reply', ok: true, ms: 12 }],
  calls: [{ action: 'send_group_msg', params: { message: [{ type: 'text', data: { text: '你好' } }, { type: 'image', data: {} }] } }],
  stages,
})
check('会回复的条目给出条数', replied.status === 'replied' && replied.verdict.includes('1 条'))
check('出站调用被渲染成可读文本', replied.calls[0].text === '你好[image]')
check('只调用非发送动作时单独归类', summarizeEntry({ events: [], calls: [{ action: 'set_group_ban' }] }).status === 'action')
check('出错条目优先报错', summarizeEntry({ events: [{ stage: 'reply', ok: false, level: 'error', reason: '发送失败：超时' }] }).verdict.includes('发送失败'))
check('超时会写进结论', summarizeEntry({ events: [], calls: [], timedOut: true }).verdict.includes('超时'))
check('完全无痕迹时明确说无法归因', summarizeEntry({ events: [], calls: [] }).verdict.includes('未记录到原因'))
check('stageLabel 回落原始 id', stageLabel('reply', stages) === '回复' && stageLabel('mystery', stages) === 'mystery')

// -------------------------------------------------------------- 剪枝（回收站） --
const pruneRoot = join(dir, 'runs')
mkdirSync(pruneRoot, { recursive: true })
for (const name of ['run-1', 'run-2', 'run-3', 'run-4']) {
  mkdirSync(join(pruneRoot, name), { recursive: true })
  writeFileSync(join(pruneRoot, name, 'qq-trace.jsonl'), '{}', 'utf8')
}
// mtime 用目录名注入，保证剪枝顺序确定（run-1 最旧）
const fakeStat = (path) => ({ mtimeMs: Number(String(path).slice(-1)) })
const moved = pruneSandboxes(pruneRoot, 2, { stat: fakeStat })
check('只把超出保留数的沙箱移入回收站', moved.slice().sort().join(',') === 'run-1,run-2', moved.join(','))
check('沙箱不是被删除而是被移动', !exists(join(pruneRoot, 'run-1')) && exists(join(pruneRoot, '_trash')))
check('回收站按日期分桶保留内容', (() => {
  const buckets = readdirSync(join(pruneRoot, '_trash'))
  return buckets.length === 1 && readdirSync(join(pruneRoot, '_trash', buckets[0])).sort().join(',') === 'run-1,run-2'
})())
check('保留数内的沙箱原样留下', exists(join(pruneRoot, 'run-3')) && exists(join(pruneRoot, 'run-4')))
check('不存在的根目录返回空', pruneSandboxes(join(dir, 'nope'), 2).length === 0)
check('_trash 自己不会被剪枝', (() => { pruneSandboxes(pruneRoot, 0, { stat: fakeStat }); return exists(join(pruneRoot, '_trash')) })())

// --------------------------------------------------------------- text view --
const text = formatReplayText({
  results: [{ input: '群 2002：你好', traceId: 't-1', verdict: '会发出 1 条消息', chain: [{ stage: 'inbound', ok: true }, { stage: 'reply', label: '回复', ok: true, ms: 5 }], calls: [{ action: 'send_group_msg', text: '在的' }] }],
  totals: { replied: 1, silent: 0, error: 0 },
  durationMs: 12,
  sandbox: 'C:\\sb',
  copied: ['qq-keywords.json'],
  warnings: ['未复制媒体目录 qq-images'],
})
check('文本报告包含结论与出站动作', text.includes('会发出 1 条消息') && text.includes('→ 会发送 send_group_msg：在的'))
check('文本报告包含提示与沙箱', text.includes('未复制媒体目录') && text.includes('C:\\sb'))
check('文本报告不重复 inbound 行', !text.split('\n').some((line) => line.includes('inbound')))

// ------------------------------------------------- orchestration（桩桥驱动） --
class StubServer extends EventEmitter {
  constructor() { super(); this.dryRun = false; this.dryRunCalls = []; this.stopped = 0 }
  setDryRun(enabled) { const previous = this.dryRun; this.dryRun = enabled === true; if (this.dryRun) this.dryRunCalls = []; return previous }
  takeDryRunCalls() { const calls = this.dryRunCalls.slice(); this.dryRunCalls = []; return calls }
  async stop() { this.stopped += 1 }
}

function stubLoaders({ replyWith = '好的', silent = false, boom = false } = {}) {
  return {
    STAGES: { reply: '回复', whitelist: '白名单' },
    Config: (input) => ({ cwd: '', botQq: 0, traceEnabled: true, ...input }),
    OneBotServer: StubServer,
    QQBridge: class {
      constructor(ctx, config, server) {
        // 每次构造一份全新的 trace 内存（真实 TraceRecorder 也是每个 bridge 一份）
        const traceEvents = []
        this.ctx = ctx; this.config = config; this.server = server; this.events = traceEvents
        this.trace = {
          recent: ({ limit }) => traceEvents.slice(-limit),
          event: (event) => { traceEvents.push(event); return event },
        }
        this.stopped = false
        ctx.on('session/event', () => {})
      }
      start() {
        this.server.on('message', (frame) => {
          if (boom) throw new Error('处理炸了')
          const id = `t-${this.events.length + 1}`
          this.events.push({ id, stage: 'inbound', ok: true, level: 'info' })
          if (silent) { this.events.push({ id, stage: 'whitelist', ok: false, level: 'info', reason: '不在白名单' }); return }
          this.server.dryRunCalls.push({ action: 'send_group_msg', params: { message: [{ type: 'text', data: { text: replyWith } }] } })
          this.events.push({ id, stage: 'reply', ok: true, level: 'info', ms: 3 })
        })
        this.server.on('notice', () => { this.events.push({ id: 't-n', stage: 'inbound', ok: true, level: 'info' }) })
      }
      stop() { this.stopped = true }
    },
  }
}

const sourceCwd = join(dir, 'src')
mkdirSync(sourceCwd, { recursive: true })
writeFileSync(join(sourceCwd, 'qq-keywords.json'), '{}', 'utf8')
const replayer = createReplayer({ pluginRoot: dir, sourceCwd, sandboxRoot: join(dir, 'replay-runs'), botQq: 999, logger: { info() {}, warn() {}, error() {} }, loaders: stubLoaders() })

const entries = [
  { v: 1, ts: 1, kind: 'message', frame: { messageType: 'group', groupId: 2002, userId: 1001, text: '你好', atMe: true } },
  { v: 1, ts: 2, kind: 'message', frame: { messageType: 'private', userId: 1002, text: '在吗', atMe: false } },
]
const report = await replayer.run({ entries })
check('回放返回结果而非抛出', report.ok === true && report.results.length === 2)
check('逐条给出输入描述', report.results[0].input.includes('群 2002') && report.results[1].input.includes('私聊 1002'))
check('逐条给出会回复结论', report.results.every((item) => item.status === 'replied' && item.calls.length === 1))
check('统计数字正确', report.totals.entries === 2 && report.totals.replied === 2 && report.totals.silent === 0)
check('每条结论都带原因', report.results.every((item) => item.verdict.length > 0))
check('报告带文本视图与耗时', typeof report.text === 'string' && report.text.includes('离线回放') && report.durationMs >= 0)
check('沙箱目录真实存在且独立于源目录', exists(report.sandbox) && report.sandbox !== sourceCwd)
check('沙箱内不写入源目录', readFileSync(join(sourceCwd, 'qq-keywords.json'), 'utf8') === '{}')
check('状态被复制进沙箱', report.copied.includes('qq-keywords.json') && exists(join(report.sandbox, 'qq-keywords.json')))
check('cwd 覆盖被拒绝并留下提示', (await replayer.run({ entries: entries.slice(0, 1), overrides: { cwd: 'D:\\somewhere-else' } })).warnings.some((line) => line.includes('cwd 覆盖')))

const silentRun = await createReplayer({ pluginRoot: dir, sourceCwd, sandboxRoot: join(dir, 'replay-runs'), loaders: stubLoaders({ silent: true }) }).run({ entries })
check('静默分支被如实报告', silentRun.results[0].status === 'silent' && silentRun.results[0].verdict.includes('不在白名单'))
check('静默不改变 ok 总判定', silentRun.ok === true && silentRun.totals.silent === 2, `${silentRun.ok}/${silentRun.totals.silent}`)

const boomRun = await createReplayer({ pluginRoot: dir, sourceCwd, sandboxRoot: join(dir, 'replay-runs'), loaders: stubLoaders({ boom: true }) }).run({ entries: entries.slice(0, 1) })
check('处理异常被捕获成错误条目', boomRun.results[0].status === 'error' && boomRun.results[0].verdict.includes('回放抛出异常'))
check('有出错条目时整体 ok=false', boomRun.ok === false && boomRun.totals.error === 1)

const many = Array.from({ length: 5 }, (_, index) => ({ v: 1, ts: index, kind: 'message', frame: { messageType: 'private', userId: 1001, text: `第${index}条` } }))
const capped = await createReplayer({ pluginRoot: dir, sourceCwd, sandboxRoot: join(dir, 'replay-runs'), loaders: stubLoaders() }).run({ entries: many, maxEntries: 2 })
check('maxEntries 限制条数并留下提示', capped.results.length === 2 && capped.warnings.some((line) => line.includes('最多回放 2 条')))
const budgeted = await createReplayer({ pluginRoot: dir, sourceCwd, sandboxRoot: join(dir, 'replay-runs'), loaders: stubLoaders() }).run({ entries: many, budgetMs: -1 })
check('时间预算用尽时停止并留下提示', budgeted.results.length === 0 && budgeted.warnings.some((line) => line.includes('时间预算')))
const noticeRun = await createReplayer({ pluginRoot: dir, sourceCwd, sandboxRoot: join(dir, 'replay-runs'), loaders: stubLoaders() }).run({ entries: [{ v: 1, ts: 1, kind: 'notice', frame: { noticeType: 'notify', subType: 'poke', groupId: 2002, userId: 1001 } }] })
check('通知类事件也能回放', noticeRun.results.length === 1 && noticeRun.results[0].input.includes('notify/poke'))
check('通知回放结论为无出站调用', noticeRun.results[0].status === 'silent')

const prunedRun = await createReplayer({ pluginRoot: dir, sourceCwd, sandboxRoot: join(dir, 'replay-runs'), loaders: stubLoaders(), keepSandboxes: 1 }).run({ entries: entries.slice(0, 1) })
check('默认保留数内的沙箱可继续回放', exists(prunedRun.sandbox))
check('prune 目标目录是 qq-replay/_trash', replayer.sandboxRoot.endsWith('replay-runs'))

check('sandboxRoot 默认落在工作目录下的 qq-replay', String(createReplayer({ pluginRoot: dir, sourceCwd }).sandboxRoot) === join(sourceCwd, 'qq-replay'))
check('可显式指定沙箱根目录', createReplayer({ pluginRoot: dir, sourceCwd, sandboxRoot: join(dir, 'x') }).sandboxRoot === join(dir, 'x'))

await mockFlow()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
