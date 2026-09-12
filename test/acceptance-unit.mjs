/**
 * 阶段 4「硬约束验收台」测试。
 *
 * 三层：
 *   ① 纯评估器：6 条约束各自的达标/告警/不达标/证据不足分支（含"dry-run 被关掉"
 *      这种真危险的情况必须报 fail，而不是悄悄放过）；
 *   ② 真实 supervisor：把临时目录里造出来的事件/录制/快照喂进去，验证汇总口径；
 *   ③ 真实 HTTP + 面板静态校验：`/api/acceptance` 的往返、token/Origin 门禁、
 *      以及面板里新卡片引用的元素与函数都存在。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlServer, createToken, readUi } from '../control/lib/server.mjs'
import { createSupervisor } from '../control/lib/supervisor.mjs'
import {
  CONSTRAINTS, MESSAGE_STAGES, buildAcceptance, evaluateDiagnose, evaluateExport,
  evaluateInject, evaluateReplay, evaluateSilent, evaluateTrace, formatAcceptance,
} from '../control/lib/acceptance.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const die = (message) => { failed++; console.log('FAIL', message) }

const dir = mkdtempSync(join(tmpdir(), 'qq-acceptance-'))
const cwd = join(dir, 'live')
mkdirSync(cwd, { recursive: true })

// ------------------------------------------------------------------ ① 无静默分支 --
check('约束表固定 6 条', CONSTRAINTS.length === 6 && CONSTRAINTS.every((entry) => entry.key && entry.title && entry.detail))
check('消息级阶段表覆盖关键阶段', ['inbound', 'whitelist', 'mention', 'reply', 'agent'].every((stage) => MESSAGE_STAGES.includes(stage)))
const silentOk = evaluateSilent([
  { id: 't-1', stage: 'whitelist', ok: false, level: 'info', reason: '群不在 allowGroups 白名单' },
  { id: 't-1', stage: 'reply', ok: true, level: 'info' },
])
check('被拒事件都带原因 → 达标', silentOk.status === 'pass' && silentOk.evidence.includes('1 条被拒'), silentOk.evidence)
check('达标项不带提示', silentOk.hint === '')
const silentMissing = evaluateSilent([{ id: 't-1', stage: 'dedup', ok: false, level: 'info' }, { id: 't-2', stage: 'reply', ok: false, level: 'error' }])
check('缺原因 → 不达标并点名阶段', silentMissing.status === 'fail' && silentMissing.evidence.includes('dedup@'), silentMissing.evidence)
check('缺原因给出修复提示', silentMissing.hint.includes('traceLevel'))
check('空白原因也算缺（不是只有 undefined）', evaluateSilent([{ stage: 'x', ok: false, reason: '   ' }]).status === 'fail')
check('没有事件 → 证据不足而不是达标', evaluateSilent([]).status === 'unknown' && evaluateSilent([]).hint.includes('traceEnabled'))
check('成功事件不需要原因', evaluateSilent([{ stage: 'reply', ok: true }, { stage: 'inbound', ok: true }]).status === 'pass')

// -------------------------------------------------------------------- ② 可关联 --
const traceOk = evaluateTrace([
  { id: 't-1', stage: 'inbound', ok: true },
  { id: 't-1', stage: 'mention', ok: false, reason: '未 @' },
  { id: 't-2', stage: 'inbound', ok: true },
  { id: 't-2', stage: 'reply', ok: true },
])
check('有端到端贯穿链路 → 达标', traceOk.status === 'pass' && traceOk.evidence.includes('走完 inbound→reply'), traceOk.evidence)
check('覆盖率算得出来', traceOk.metric.coverage === 100, String(traceOk.metric.coverage))
const traceOrphan = evaluateTrace([
  { id: 't-1', stage: 'inbound', ok: true },
  { id: 't-1', stage: 'reply', ok: true },
  { id: '', stage: 'agent', ok: true },
])
check('消息级事件缺 traceId → 不达标', traceOrphan.status === 'fail' && traceOrphan.evidence.includes('agent'), traceOrphan.evidence)
const traceSilentOnly = evaluateTrace([{ id: 't-1', stage: 'inbound', ok: true }, { id: 't-1', stage: 'whitelist', ok: false, reason: '不在白名单' }])
check('只被拦下、没走到 reply → 告警而非不达标', traceSilentOnly.status === 'warn' && traceSilentOnly.hint.includes('实时事件流'), traceSilentOnly.evidence)
check('无入站事件 → 证据不足', evaluateTrace([]).status === 'unknown')
check('全局事件（无 traceId 的非消息阶段）不误判', evaluateTrace([
  { id: 't-1', stage: 'inbound', ok: true }, { id: 't-1', stage: 'reply', ok: true },
  { id: '', stage: 'timer', ok: true, reason: '定时体检' }, { id: '', stage: 'inject', ok: true, reason: '注入完成' },
]).status === 'pass')

// -------------------------------------------------------------------- ③ 可回放 --
const replayPass = evaluateReplay({
  inbox: { exists: true, recorded: 12, queued: 3 },
  lastReplay: { ok: true, at: 1, durationMs: 240, totals: { entries: 1, replied: 1, silent: 0, error: 0 }, safety: { dryRun: true, connectedBots: 0 } },
  sandboxCount: 4,
})
check('录制 + 成功回放 → 达标', replayPass.status === 'pass' && replayPass.evidence.includes('dry-run=开'), replayPass.evidence)
check('回放证据里带沙箱数', replayPass.evidence.includes('沙箱 4 个'))
check('没录制 → 告警并指出 recordInbound', evaluateReplay({ inbox: { exists: false, recorded: 0 } }).hint.includes('recordInbound'))
check('有录制但没跑过回放 → 告警并指出按钮', evaluateReplay({ inbox: { exists: true, recorded: 5 } }).hint.includes('回放最近 5 条'))
const replayUnsafe = evaluateReplay({ inbox: { exists: true, recorded: 5 }, lastReplay: { ok: true, safety: { dryRun: false, connectedBots: 0 } } })
check('dry-run 没开 → 不达标（安全第一）', replayUnsafe.status === 'fail' && replayUnsafe.evidence.includes('安全保证不完整'), replayUnsafe.evidence)
const replayConnected = evaluateReplay({ inbox: { exists: true, recorded: 5 }, lastReplay: { ok: true, safety: { dryRun: true, connectedBots: 1 } } })
check('回放期间有 QQ 连接 → 不达标', replayConnected.status === 'fail')
const replayErrored = evaluateReplay({ inbox: { exists: true, recorded: 5 }, lastReplay: { ok: false, safety: { dryRun: true, connectedBots: 0 }, totals: { entries: 2, error: 1 } } })
check('回放里有出错条目 → 不达标', replayErrored.status === 'fail' && replayErrored.hint.includes('出错'))

// -------------------------------------------------------------------- ④ 可体检 --
check('体检全绿 → 达标', evaluateDiagnose({ report: { summary: { passed: 18, total: 18, failed: 0, blockers: 0, verdict: 'healthy' }, checks: [] } }).status === 'pass')
const diagWarn = evaluateDiagnose({ report: { summary: { passed: 16, total: 18, failed: 2, blockers: 0, verdict: 'degraded' }, checks: [{ ok: true, title: 'A' }, { ok: false, title: 'B' }] } })
check('体检有失败但无 blocker → 告警并点名', diagWarn.status === 'warn' && diagWarn.evidence.includes('B'), diagWarn.evidence)
const diagBlocked = evaluateDiagnose({ report: { summary: { passed: 5, total: 15, failed: 10, blockers: 6, verdict: 'blocked' }, checks: [{ ok: false, title: '宿主端口' }] } })
check('体检有 blocker → 不达标', diagBlocked.status === 'fail' && diagBlocked.evidence.includes('宿主端口'), diagBlocked.evidence)
check('没体检过 → 告警并指出按钮', evaluateDiagnose(null).hint.includes('一键体检'))

// -------------------------------------------------------------------- ⑤ 可导出 --
check('有产物可打包 → 达标', evaluateExport({ sources: [{ name: '事件流', present: true }, { name: '宿主 stdout', present: false }] }).status === 'pass')
const exported = evaluateExport({ lastExport: { entries: 9, bytes: 40960, filename: 'qq-diagnose-x.zip' }, sources: [] })
check('导出过 → 证据显示体积与文件名', exported.status === 'pass' && exported.evidence.includes('40 KB') && exported.evidence.includes('.zip'), exported.evidence)
check('没有任何产物 → 告警', evaluateExport({ sources: [{ name: 'x', present: false }] }).status === 'warn')

// -------------------------------------------------------------------- ⑥ 可注入 --
const injectPass = evaluateInject({ injection: { enabled: true, dryRun: true, consumed: 4, queued: 6, intervalMs: 2000, lastAt: Date.now() }, injectedEvents: [{ stage: 'inject', reason: '注入回合的模型回复已被拦截（dry-run，未发送）：x' }] })
check('通道开 + dry-run + 已消费 → 达标', injectPass.status === 'pass' && injectPass.evidence.includes('本次已消费 4 行'), injectPass.evidence)
check('证据里写出拦下异步回复的次数', injectPass.evidence.includes('1 次拦下了异步 agent 回合的回复'), injectPass.evidence)
const injectDanger = evaluateInject({ injection: { enabled: true, dryRun: false, consumed: 2 } })
check('dry-run 关闭 → 不达标（会真发 QQ）', injectDanger.status === 'fail' && injectDanger.evidence.includes('真的把消息发到 QQ'), injectDanger.evidence)
check('通道关闭 → 告警并指出开关名', evaluateInject({ injection: { enabled: false, dryRun: true } }).hint.includes('injectEnabled'))
check('开了但没消费过 → 告警并提示去注入', evaluateInject({ injection: { enabled: true, dryRun: true, consumed: 0, lastAt: 0 } }).hint.includes('注入'))
check('没有快照 → 证据不足', evaluateInject({ injection: null }).status === 'unknown')

// -------------------------------------------------------------------- 汇总视图 --
const allGreen = buildAcceptance({
  events: [
    { id: 't-1', stage: 'inbound', ok: true, level: 'info' },
    { id: 't-1', stage: 'reply', ok: true, level: 'info' },
    { id: '', stage: 'inject', ok: true, level: 'info', reason: '注入完成：0 个出站调用被拦截（dry-run，未发送）' },
  ],
  runtime: { injection: { enabled: true, dryRun: true, consumed: 2, queued: 2, intervalMs: 2000, lastAt: Date.now() } },
  inbox: { exists: true, recorded: 9, queued: 2 },
  lastReplay: { ok: true, at: 1, durationMs: 200, totals: { entries: 1, replied: 1, silent: 0, error: 0 }, safety: { dryRun: true, connectedBots: 0 } },
  lastExport: { entries: 8, bytes: 2048, filename: 'x.zip' },
  diagnosis: { report: { summary: { passed: 18, total: 18, failed: 0, blockers: 0, verdict: 'healthy' }, checks: [] } },
  sandboxCount: 2,
  now: () => 1_700_000_000_000,
})
check('全绿判定与计数', allGreen.verdict === 'all-green' && allGreen.ok === true && allGreen.totals.pass === 6 && allGreen.checks === 6)
check('汇总带生成时间戳', allGreen.generatedAt === 1_700_000_000_000)
const text = formatAcceptance(allGreen)
check('文本视图含 6 条约束与结论', text.includes('6/6 达标') && text.split('\n').filter((line) => line.startsWith('✅')).length === 6, text.split('\n')[0])
check('文本视图包含提示缩进行（有提示时）', formatAcceptance(buildAcceptance({})).includes('↳'))
check('空输入不会崩且结论是"证据不足"', buildAcceptance({}).verdict === 'unknown' && buildAcceptance({}).items.length === 6)
check('formatAcceptance 容忍 null', formatAcceptance(null) === '（还没有验收结果）')
const brokenReport = buildAcceptance({ events: [{ stage: 'reply', ok: false, level: 'error' }], runtime: { injection: { enabled: true, dryRun: false } } })
check('有不达标项时 ok=false 且 verdict=broken', brokenReport.ok === false && brokenReport.verdict === 'broken' && brokenReport.totals.fail === 2)
check('未知项单独计数（不算失败）', buildAcceptance({ events: [], runtime: null }).totals.unknown >= 3)

// ------------------------------------------------------- 真实 supervisor 汇总 --
const traceFile = join(cwd, 'qq-trace.jsonl')
writeFileSync(traceFile, [
  JSON.stringify({ v: 1, ts: 1, id: 't-aaa-1', level: 'info', module: 'bridge', stage: 'inbound', ok: true, chatKey: 'g:2002' }),
  JSON.stringify({ v: 1, ts: 2, id: 't-aaa-1', level: 'info', module: 'bridge', stage: 'mention', ok: false, reason: '群聊未 @ 机器人', chatKey: 'g:2002' }),
  JSON.stringify({ v: 1, ts: 3, id: 't-aaa-2', level: 'info', module: 'bridge', stage: 'inbound', ok: true, chatKey: 'u:1001' }),
  JSON.stringify({ v: 1, ts: 4, id: 't-aaa-2', level: 'info', module: 'bridge', stage: 'reply', ok: true, chatKey: 'u:1001' }),
].join('\n') + '\n', 'utf8')
writeFileSync(join(cwd, 'qq-runtime.json'), JSON.stringify({
  updatedAt: Date.now(), version: '0.4.0',
  injection: { enabled: true, dryRun: true, intervalMs: 2000, consumed: 1, queued: 2, lastAt: Date.now() },
  inbox: { enabled: true, file: join(cwd, 'qq-inbox.jsonl'), recorded: 4 },
  features: {}, gate: {}, trace: {}, sessions: [],
}), 'utf8')
writeFileSync(join(cwd, 'qq-inbox.jsonl'), '{"v":1,"ts":1,"kind":"message","frame":{"messageType":"group","groupId":2002,"userId":1001,"text":"hi"}}\n', 'utf8')
mkdirSync(join(cwd, 'qq-replay', 'run-2026-09-12T00-00-00'), { recursive: true })
mkdirSync(join(cwd, 'qq-replay', '_trash'), { recursive: true })

const noExec = (command, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  if (command === 'netstat') return done(null, '  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    555\n', '')
  if (command === 'tasklist') return done(null, '"node.exe","555","Console","1","100 K"\n', '')
  return done(new Error('not stubbed'), '', '')
}
const config = {
  cwd,
  pluginRoot: join(dir, 'plugin-root'),
  nodeExe: process.execPath,
  ports: { control: 18802, host: 3080, onebot: 6700, napcat: 6099, tts: 9880 },
  logs: { trace: traceFile, runtime: join(cwd, 'qq-runtime.json'), audit: join(cwd, 'qq-actions.log'), inbox: join(cwd, 'qq-inbox.jsonl'), inject: join(cwd, 'qq-inject.jsonl'), hostOut: join(cwd, 'h.out'), bridge: join(cwd, 'b.log') },
}
const sup = createSupervisor(config, { exec: noExec, logger: { info() {}, warn() {}, error() {} } })
const accepted = await sup.acceptance()
check('supervisor 汇总出 6 条', accepted.report.items.length === 6 && Object.keys(accepted.totals).length === 4)
check('① 读到真实事件并判达标', accepted.report.items[0].status === 'pass', accepted.report.items[0].evidence)
check('② 认出端到端贯穿链路', accepted.report.items[1].status === 'pass' && accepted.report.items[1].evidence.includes('1 条走完'), accepted.report.items[1].evidence)
check('③ 没跑过回放时报告警', accepted.report.items[2].status === 'warn')
check('③ 的沙箱计数排除回收站', accepted.report.items[2].metric.sandboxCount === 1, String(accepted.report.items[2].metric.sandboxCount))
check('⑤ 认出在位产物', accepted.report.items[4].evidence.includes('事件流'), accepted.report.items[4].evidence)
check('⑥ 读到快照里的注入状态', accepted.report.items[5].status === 'pass' && accepted.report.items[5].evidence.includes('已消费 1 行'), accepted.report.items[5].evidence)
check('文本视图与结构化结果一致', accepted.text.includes('硬约束验收') && accepted.text.includes('① 无静默分支'))
const cachedDiag = await sup.acceptance()
check('体检结果被复用（两次汇总结论一致）', cachedDiag.report.items[3].evidence === accepted.report.items[3].evidence)

// 回放一次之后 ③ 应变成达标（沙箱里的插件代码不存在 → 失败报告也算"跑过"，但要如实标 fail）
const replayFail = await sup.replay({ limit: 1 })
check('回放失败仍会记录"最近一次回放"证据', replayFail.ok === false && typeof replayFail.reason === 'string')
const afterReplay = await sup.acceptance()
check('③ 在跑过回放后不再是"还没跑过"', !afterReplay.report.items[2].evidence.includes('还没跑过回放'), afterReplay.report.items[2].evidence.slice(0, 90))
check('插件代码缺失时 ③ 如实报不达标', afterReplay.report.items[2].status === 'fail', afterReplay.report.items[2].evidence.slice(0, 120))

// ------------------------------------------------------------- 真实 HTTP ------
const token = createToken()
const server = createControlServer({
  config,
  token,
  api: {
    status: async () => ({ ports: [], processes: {}, warnings: [], config: {}, scannedAt: Date.now() }),
    logFile: () => traceFile,
    acceptance: () => sup.acceptance(),
  },
  ui: '<h1>console</h1>',
})
await new Promise((resolve) => server.listen(18802, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:18802'
const response = await fetch(`${base}/api/acceptance?token=${token}`)
const body = await response.json()
check('GET /api/acceptance 返回报告与文本', response.status === 200 && body.report?.items?.length === 6 && typeof body.text === 'string', JSON.stringify(body.totals ?? {}))
check('接口同时返回 verdict 与 totals', typeof body.verdict === 'string' && typeof body.totals.pass === 'number')
check('验收接口需要 token', (await fetch(`${base}/api/acceptance`)).status === 401)
check('验收接口拒绝跨站 Origin', (await fetch(`${base}/api/acceptance?token=${token}`, { headers: { Origin: 'https://evil.example' } })).status === 403)
server.close()

// 不支持验收台的旧 supervisor 也要给可读原因
const bare = createControlServer({ config, token, api: { status: async () => ({}), logFile: () => '', diagnose: async () => ({}) }, ui: '' })
await new Promise((resolve) => bare.listen(18803, '127.0.0.1', resolve))
const bareBody = await (await fetch(`http://127.0.0.1:18803/api/acceptance?token=${token}`)).json()
check('旧控制台返回可读的不支持原因', bareBody.ok === false && bareBody.reason.includes('不支持验收台'))
bare.close()

// --------------------------------------------------------- 面板静态校验 -------
const ui = readUi(join(import.meta.dirname, '..', 'control', 'ui.html'))
check('面板包含验收台卡片', ui.includes('硬约束验收台'))
for (const id of ['acceptance', 'acceptMeta']) {
  if (!ui.includes(`id="${id}"`)) die(`面板缺少元素 #${id}`)
}
const script = /<script>([\s\S]*)<\/script>/.exec(ui)?.[1] ?? ''
check('面板脚本可解析', (() => { try { new Function(script); return true } catch { return false } })())
for (const fn of ['loadAcceptance', 'renderAcceptance', 'focusCard']) {
  if (!new RegExp(`(async )?function ${fn}\\(`).test(script)) die(`面板缺少函数 ${fn}`)
}
check('验收台函数都定义了', true)
check('验收台映射了"去看"跳转目标', script.includes('ACCEPT_TARGETS') && ['streamBox', 'chain', 'replayOut', 'diag', 'injState'].every((id) => script.includes(id)))
check('验收台区分四种状态图标', ['pass', 'warn', 'fail', 'unknown'].every((status) => script.includes(`${status}:`)))
check('加载时会拉验收结果', script.includes('loadAcceptance()'))
check('回放完成后会刷新验收台', /replayEntries[\s\S]{0,1200}loadAcceptance\(\)/.test(script))
const inline = [...ui.matchAll(/on(?:click|change|input)="([a-zA-Z_$][\w$]*)\(/g)].map((match) => match[1])
const missing = [...new Set(inline)].filter((name) => !new RegExp(`(async )?function ${name}\\(`).test(script))
check('内联事件调用的函数都存在', missing.length === 0, missing.join(','))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
