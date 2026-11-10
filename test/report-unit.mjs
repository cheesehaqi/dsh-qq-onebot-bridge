/**
 * 「一键体检报告」测试（控制台 /report 页 + /api/report）。
 *
 * 四层：
 *   ① 纯函数：结论优先级（阻断 > 告警 > 证据不足 > 全绿）、分组、先修列表、关键事实、
 *      文本视图——这些是页面与"复制报告"共用的一套口径，分支必须逐条钉住；
 *   ② 真实 supervisor：一次体检 + 一次验收合成报告，且好约束复用同一次体检结果；
 *   ③ 真实 HTTP：`/api/report` 的往返、token/Origin 门禁、fresh=1 透传、旧版可读原因，
 *      以及 `/report` 页面的服务与缺页兜底；
 *   ④ 页面静态校验：元素、函数、转义、打印样式、token 透传，以及控制台入口与深链。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlServer, createToken, readUi } from '../control/lib/server.mjs'
import { createSupervisor } from '../control/lib/supervisor.mjs'
import {
  CONSTRAINT_TARGETS, GROUP_OF_CHECK, REPORT_GROUPS, buildActions, buildFacts,
  buildHealthReport, combineVerdict, formatHealthReport,
} from '../control/lib/report.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ------------------------------------------------------------------ 夹具 ----
const CHECK = (id, ok, severity = ok ? 'ok' : 'error') => ({
  id,
  title: `检查-${id}`,
  ok,
  detail: `${id} 的详情`,
  hint: ok ? '' : `修 ${id}`,
  severity,
})
const constraint = (key, status, evidence = `${key} 的证据`, hint = '') => ({
  key, title: `约束-${key}`, status, evidence, hint, detail: '',
})
function diagOf(checks) {
  const failedChecks = checks.filter((entry) => !entry.ok)
  return {
    checks,
    summary: {
      total: checks.length,
      passed: checks.length - failedChecks.length,
      failed: failedChecks.length,
      blockers: failedChecks.filter((entry) => entry.severity === 'error').length,
      verdict: failedChecks.some((entry) => entry.severity === 'error') ? 'blocked' : (failedChecks.length ? 'warnings' : 'healthy'),
    },
  }
}
function accOf(items) {
  const count = (status) => items.filter((entry) => entry.status === status).length
  return {
    items,
    checks: items.length,
    verdict: count('fail') > 0 ? 'broken' : (count('unknown') > 0 ? 'unknown' : (count('warn') > 0 ? 'partial' : 'all-green')),
    totals: { pass: count('pass'), warn: count('warn'), fail: count('fail'), unknown: count('unknown') },
  }
}
const ALL_PASS = accOf(['silent', 'trace', 'replay', 'diagnose', 'export', 'inject'].map((key) => constraint(key, 'pass')))
const HEALTHY_DIAG = diagOf([CHECK('node', true), CHECK('port-host', true), CHECK('errors', true)])

// ------------------------------------------------------------ ① 纯函数 ----
check('分组表保持固定顺序', REPORT_GROUPS.map((group) => group.key).join(',') === 'env,ports,link,runtime,events,audit,other')
check('每个分组都有标题与跳转目标', REPORT_GROUPS.every((group) => group.title && group.target))
check('检查项登记到正确分组', ['node', 'port-onebot', 'bot-online', 'runtime', 'drops', 'trace-file'].every((id) => {
  const expected = { node: 'env', 'port-onebot': 'ports', 'bot-online': 'link', runtime: 'runtime', drops: 'events', 'trace-file': 'audit' }[id]
  return GROUP_OF_CHECK[id] === expected
}))
check('六条硬约束都有控制台落点', Object.keys(CONSTRAINT_TARGETS).join(',') === 'silent,trace,replay,diagnose,export,inject')

const healthy = buildHealthReport({ diagnosis: HEALTHY_DIAG, acceptance: ALL_PASS, generatedAt: 1_700_000_000_000 })
check('全绿：结论与 ok', healthy.verdict === 'healthy' && healthy.ok === true && healthy.tone === 'ok', healthy.verdict)
check('全绿：一句话结论', healthy.headline.title === '全部通过' && healthy.headline.detail.includes('3/3'), healthy.headline.detail)
check('全绿：计数器分别来自体检与验收',
  healthy.counters.checks.total === 3 && healthy.counters.checks.passed === 3
  && healthy.counters.constraints.total === 6 && healthy.counters.constraints.pass === 6,
  JSON.stringify(healthy.counters))
check('全绿：生成时间原样保留', healthy.generatedAt === 1_700_000_000_000)

const grouped = buildHealthReport({
  diagnosis: diagOf([CHECK('errors', true), CHECK('node', true), CHECK('port-host', true), CHECK('mystery', true)]),
  acceptance: ALL_PASS,
})
check('分组只保留有内容的分组且按表排序',
  grouped.groups.map((group) => group.key).join(',') === 'env,ports,events,other',
  grouped.groups.map((group) => group.key).join(','))
check('未登记的检查落到 other，不会从报告里消失',
  grouped.groups.find((group) => group.key === 'other').items[0].id === 'mystery')
check('未登记检查的跳转目标回落到体检卡',
  grouped.groups.find((group) => group.key === 'other').items[0].target === 'diag')
check('组内失败项排在最前',
  buildHealthReport({
    diagnosis: diagOf([CHECK('errors', true), CHECK('warn', false, 'warn'), CHECK('drops', true)]),
    acceptance: ALL_PASS,
  }).groups.find((group) => group.key === 'events').items.map((item) => item.id).join(',') === 'warn,errors,drops')
const itemOf = (report, id) => report.groups.flatMap((group) => group.items).find((item) => item.id === id)
check('检查项标题与详情进报告', itemOf(grouped, 'node').title === '检查-node' && itemOf(grouped, 'node').detail === 'node 的详情')
check('通过的检查不带修复提示', itemOf(grouped, 'node').hint === '')
check('检查项跳转目标按表解析', itemOf(grouped, 'errors').target === 'streamBox' && itemOf(grouped, 'port-host').target === 'ports')

const blockedDiag = buildHealthReport({ diagnosis: diagOf([CHECK('dsh', false), CHECK('node', true)]), acceptance: ALL_PASS })
check('体检有 blocker → 阻断', blockedDiag.verdict === 'blocked' && blockedDiag.ok === false && blockedDiag.tone === 'bad')
check('阻断结论写明原因与失败数', blockedDiag.headline.detail.includes('blocker 1') && blockedDiag.headline.detail.includes('失败 1'), blockedDiag.headline.detail)
const blockedAcc = buildHealthReport({ diagnosis: HEALTHY_DIAG, acceptance: accOf([constraint('inject', 'fail')]) })
check('体检全绿但硬约束不达标 → 仍判阻断', blockedAcc.verdict === 'blocked' && blockedAcc.ok === false)
check('不达标约束的跳转目标可用', blockedAcc.constraints[0].target === 'injState')

const warned = buildHealthReport({ diagnosis: diagOf([CHECK('napcat-bat', false, 'warn'), CHECK('node', true)]), acceptance: ALL_PASS })
check('只有非阻断失败 → 告警（ok 仍为 true）', warned.verdict === 'warnings' && warned.ok === true && warned.tone === 'warn')
check('告警结论写明数量', warned.headline.title.includes('1 项告警'), warned.headline.title)

const unknown = buildHealthReport({ diagnosis: healthy.diagnosis, acceptance: accOf([constraint('silent', 'pass'), constraint('replay', 'unknown')]) })
check('有证据不足的约束 → 证据不足（ok 为 false）', unknown.verdict === 'unknown' && unknown.ok === false && unknown.tone === 'unknown')
check('证据不足结论点名缺口', unknown.headline.detail.includes('1 条'), unknown.headline.detail)

const empty = buildHealthReport({})
check('空输入不崩且判证据不足', empty.verdict === 'unknown' && empty.ok === false)
check('空输入没有分组/约束/动作/事实',
  empty.groups.length === 0 && empty.constraints.length === 0 && empty.actions.length === 0 && empty.facts.length === 0)
check('combineVerdict 优先级：阻断 > 告警 > 证据不足 > 全绿',
  combineVerdict({ diagnosis: { summary: { blockers: 1, failed: 1 } }, acceptance: { totals: { warn: 1, unknown: 1 } } }) === 'blocked'
  && combineVerdict({ diagnosis: { summary: { failed: 1 } }, acceptance: { totals: { unknown: 2 } } }) === 'warnings'
  && combineVerdict({ acceptance: { totals: { unknown: 1 } } }) === 'unknown'
  && combineVerdict({ diagnosis: { summary: {} }, acceptance: { totals: {} } }) === 'healthy')

// ---- 先修列表 ----
const actionsReport = buildHealthReport({
  diagnosis: diagOf([CHECK('dsh', false, 'error'), CHECK('napcat-bat', false, 'warn'), CHECK('node', true), CHECK('errors', false, 'error')]),
  acceptance: accOf([constraint('inject', 'fail', 'dry-run 关闭', '改回 injectDryRun=true'), constraint('diagnose', 'fail', '体检有 blocker', '先修体检')]),
})
check('先修列表：阻断检查 → 不达标约束 → 告警检查',
  actionsReport.actions.map((action) => `${action.source}:${action.id}`).join(',') === 'check:dsh,check:errors,constraint:inject,check:napcat-bat',
  actionsReport.actions.map((action) => action.id).join(','))
check('先修列表排除 ④ 可体检（它的失败就是体检本身，重复列只会吵）',
  actionsReport.actions.every((action) => action.id !== 'diagnose'))
check('先修项带修复提示与跳转目标', actionsReport.actions[0].hint === '修 dsh' && actionsReport.actions[0].target === 'cfgCwd')
check('约束不达标项也能进先修列表并带提示',
  actionsReport.actions.find((action) => action.id === 'inject').hint === '改回 injectDryRun=true')
check('先修列表上限 6 项', buildActions({
  groups: [{ items: Array.from({ length: 9 }, (_, index) => ({ id: `x${index}`, title: `x${index}`, ok: false, severity: 'error', detail: '', hint: 'h', target: 'diag' })) }],
  constraints: [],
}).length === 6)
check('全绿时先修列表为空', healthy.actions.length === 0)

// ---- 关键事实 ----
const facts = buildFacts({ version: '0.8.5', uptimeSeconds: 3600, sessionCount: 3, gate: { denied: 2 }, trace: { total: 99 }, ageSeconds: 12 })
check('关键事实：版本/运行时长/会话/拒绝/事件/快照', facts.map((fact) => fact.label).join(',') === '桥版本,已运行,会话,写操作被拒,事件总数,快照更新于', facts.map((fact) => fact.label).join(','))
check('关键事实：数值格式', facts.find((fact) => fact.label === '已运行').value === '60 分钟'
  && facts.find((fact) => fact.label === '写操作被拒').value === '2 次'
  && facts.find((fact) => fact.label === '快照更新于').value === '12 秒前')
check('没有快照时没有关键事实', buildFacts(null).length === 0)
check('缺字段的快照按 0 处理而不是 NaN',
  buildFacts({ version: 'x' }).find((fact) => fact.label === '事件总数').value === '0')

// ---- 文本视图 ----
const text = formatHealthReport(actionsReport)
check('文本：标题与结论', text.startsWith('一键体检报告 · ') && text.includes('结论：有阻断项'), text.split('\n')[0])
check('文本：先修清单带编号与提示', text.includes('先修这些') && /1\. ❌/.test(text) && text.includes('↳ 改回 injectDryRun=true'))
check('文本：明细按分组', text.includes('体检明细') && text.includes('【本机依赖】') && text.includes('【事件面】'))
check('文本：六条硬约束', text.includes('六条硬约束') && text.includes('❌ 约束-inject'))
check('文本：只读声明', text.includes('本报告只读'))
check('文本：全绿时说明无需先修', formatHealthReport(healthy).includes('（没有需要先修的项）'))
check('文本：没有验收结果时说明去哪点', formatHealthReport(empty).includes('还没有验收结果'))
check('文本容忍 null', formatHealthReport(null) === '（还没有体检报告）')

// 兼容两种形状：分包传 report 或整包
const nested = buildHealthReport({ diagnosis: { report: HEALTHY_DIAG }, acceptance: { report: ALL_PASS } })
check('传入整包时自动取 report 字段', nested.verdict === 'healthy' && nested.counters.checks.total === 3)

// ------------------------------------------------------ ② 真实 supervisor ----
const dir = mkdtempSync(join(tmpdir(), 'qq-report-'))
const cwd = join(dir, 'live')
mkdirSync(cwd, { recursive: true })
const traceFile = join(cwd, 'qq-trace.jsonl')
writeFileSync(traceFile, [
  JSON.stringify({ v: 1, ts: Date.now() - 1000, id: 't-r-1', level: 'info', module: 'bridge', stage: 'inbound', ok: true, chatKey: 'u:1' }),
  JSON.stringify({ v: 1, ts: Date.now() - 900, id: 't-r-1', level: 'info', module: 'bridge', stage: 'reply', ok: true, chatKey: 'u:1' }),
].join('\n') + '\n', 'utf8')
const runtimeFile = join(cwd, 'qq-runtime.json')
writeFileSync(runtimeFile, JSON.stringify({
  updatedAt: Date.now(), version: '0.8.5', uptimeSeconds: 300, sessionCount: 1,
  injection: { enabled: true, dryRun: true, intervalMs: 2000, consumed: 0, queued: 0, lastAt: 0 },
  inbox: { enabled: true, file: join(cwd, 'qq-inbox.jsonl'), recorded: 1 },
  features: {}, gate: { denied: 1 }, trace: { total: 2 }, sessions: [],
}), 'utf8')
writeFileSync(join(cwd, 'qq-inbox.jsonl'), '{"v":1,"ts":1,"kind":"message","frame":{"messageType":"private","userId":1,"text":"hi"}}\n', 'utf8')

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
  ports: { control: 18809, host: 3080, onebot: 6700, napcat: 6099, tts: 9880 },
  logs: {
    trace: traceFile, runtime: runtimeFile, audit: join(cwd, 'qq-actions.log'),
    inbox: join(cwd, 'qq-inbox.jsonl'), inject: join(cwd, 'qq-inject.jsonl'),
    hostOut: join(cwd, 'h.out'), bridge: join(cwd, 'b.log'),
  },
}
const sup = createSupervisor(config, { exec: noExec, logger: { info() {}, warn() {}, error() {} } })
const generated = await sup.healthReport()
check('supervisor 合成出 6 条硬约束', generated.report.constraints.length === 6, String(generated.report.constraints.length))
check('supervisor 合成出分组明细', generated.report.groups.length > 0)
check('supervisor 报告带文本视图', typeof generated.text === 'string' && generated.text.includes('一键体检报告'))
check('supervisor 报告 ok 与结论一致', generated.ok === (generated.report.verdict !== 'blocked' && generated.report.verdict !== 'unknown'))
const diagEvidence = generated.report.constraints.find((entry) => entry.key === 'diagnose')?.evidence ?? ''
check('④ 的证明显式写出体检通过数（说明复用了同一次体检）', /项通过/.test(diagEvidence), diagEvidence)
check('③ 如实反映"还没跑过回放"（证据不足/告警都在允许范围）',
  ['warn', 'unknown'].includes(generated.report.constraints.find((entry) => entry.key === 'replay')?.status ?? ''),
  generated.report.constraints.find((entry) => entry.key === 'replay')?.status)
check('真实快照进了关键事实', generated.report.facts.some((fact) => fact.value === 'v0.8.5'))
check('健康检查接口形状稳定（report/text/ok）',
  Object.keys(generated).sort().join(',') === 'ok,report,text')
const healthHistory = sup.healthHistory({ limit: 5 })
check('体检历史落盘并可倒序读回',
  healthHistory.ok === true && healthHistory.entries.length >= 1
  && healthHistory.entries[0].at > 0 && typeof healthHistory.entries[0].verdict === 'string',
  healthHistory.file)
const forced = await sup.healthReport({ force: true })
check('force 选项可用且不改变结构', forced.report.constraints.length === 6)

// ------------------------------------------------------------- ③ HTTP ----
const token = createToken()
const fakeReport = buildHealthReport({ diagnosis: HEALTHY_DIAG, acceptance: ALL_PASS, generatedAt: Date.now() })
const seen = []
const server = createControlServer({
  config,
  token,
  api: {
    status: async () => ({ ports: [], processes: {}, warnings: [], config: {}, scannedAt: Date.now() }),
    logFile: () => traceFile,
    healthReport: async (options) => {
      seen.push(options)
      return { ok: fakeReport.ok, report: fakeReport, text: formatHealthReport(fakeReport) }
    },
    healthHistory: async ({ limit }) => ({
      ok: true,
      file: 'qq-health-history.jsonl',
      entries: [{ at: 1_700_000_000_000, verdict: 'healthy', ok: true, checks: { total: 3, passed: 3, failed: 0 }, constraints: null }].slice(0, limit),
    }),
    activity: async ({ days }) => ({
      ok: true,
      dir: 'qq-history',
      days,
      total: 2,
      groups: [{ chatKey: 'g:100', kind: 'group', total: 2, lastAt: 1_700_000_000_000, daily: [], topMembers: [{ userId: 1, name: '甲', count: 2 }] }],
      privates: [],
      chats: [{ chatKey: 'g:100', kind: 'group', total: 2, lastAt: 1_700_000_000_000, daily: [], topMembers: [{ userId: 1, name: '甲', count: 2 }] }],
      scanned: { files: 1, lines: 2, truncated: false },
    }),
  },
  ui: '<h1>console</h1>',
  reportUi: '<h1>报告页</h1>',
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const response = await fetch(`${base}/api/report?token=${token}`)
const body = await response.json()
check('GET /api/report 返回报告/文本/结论',
  response.status === 200 && body.report?.constraints?.length === 6 && typeof body.text === 'string' && body.verdict === 'healthy',
  JSON.stringify(body.report?.counters ?? {}))
check('接口带 ok 字段且与报告一致', body.ok === true)
check('默认不强制刷新体检缓存', seen.length === 1 && seen[0].force === false, JSON.stringify(seen[0]))
await fetch(`${base}/api/report?fresh=1&token=${token}`)
check('fresh=1 透传成 force=true', seen[1].force === true, JSON.stringify(seen[1]))
const historyResponse = await fetch(`${base}/api/health/history?limit=5&token=${token}`)
const historyBody = await historyResponse.json()
check('GET /api/health/history 返回体检趋势点',
  historyResponse.status === 200 && historyBody.ok === true && Array.isArray(historyBody.entries)
  && historyBody.entries.length === 1 && historyBody.entries[0].checks.passed === 3,
  JSON.stringify(historyBody.entries?.[0] ?? {}))
const activityResponse = await fetch(`${base}/api/activity?days=7&token=${token}`)
const activityBody = await activityResponse.json()
check('GET /api/activity 返回群活跃聚合（不含原文）',
  activityResponse.status === 200 && activityBody.ok === true && activityBody.days === 7
  && activityBody.groups[0].total === 2 && !JSON.stringify(activityBody).includes('text'),
  JSON.stringify(activityBody.groups?.[0] ?? {}))
check('报告接口需要 token', (await fetch(`${base}/api/report`)).status === 401)
check('报告接口拒绝跨站 Origin',
  (await fetch(`${base}/api/report?token=${token}`, { headers: { Origin: 'https://evil.example' } })).status === 403)
const page = await fetch(`${base}/report?token=${token}`)
const pageText = await page.text()
check('GET /report 返回页面', page.status === 200 && pageText.includes('报告页') && (page.headers.get('content-type') ?? '').includes('text/html'))
server.close()

// 旧 supervisor 没有 healthReport：给可读原因而不是 500
const legacy = createControlServer({ config, token, api: { status: async () => ({}), logFile: () => '' }, ui: '' })
await new Promise((resolve) => legacy.listen(0, '127.0.0.1', resolve))
const legacyBody = await (await fetch(`http://127.0.0.1:${legacy.address().port}/api/report?token=${token}`)).json()
check('旧控制台返回可读的不支持原因', legacyBody.ok === false && legacyBody.reason.includes('体检报告'))
const noPage = await fetch(`http://127.0.0.1:${legacy.address().port}/report?token=${token}`)
check('没配置报告页时 /report 明确 404', noPage.status === 404 && (await noPage.text()).includes('没有体检报告页'))
legacy.close()

// ------------------------------------------------------- ④ 页面静态 ------
const pageHtml = readUi(join(import.meta.dirname, '..', 'control', 'report.html'))
check('报告页面存在且非空', pageHtml.length > 8000, String(pageHtml.length))
for (const id of ['verdict', 'verdictTitle', 'verdictDetail', 'verdictPill', 'stamp', 'summary', 'actions',
  'constraints', 'checks', 'facts', 'factsCard', 'pageErrors', 'toast', 'btnReload', 'btnCopy', 'consoleTop', 'tokenHint']) {
  if (!pageHtml.includes(`id="${id}"`)) { failed++; console.log('FAIL', `报告页缺少元素 #${id}`) }
}
check('报告页元素齐全', true)
const pageScript = /<script>([\s\S]*)<\/script>/.exec(pageHtml)?.[1] ?? ''
check('报告页脚本可解析', (() => { try { new Function(pageScript); return true } catch { return false } })())
for (const fn of ['api', 'escapeHtml', 'icon', 'statusLabel', 'consoleHref', 'stampText', 'toast',
  'render', 'renderSummary', 'renderActions', 'renderConstraints', 'renderGroups', 'renderFacts',
  'showFailure', 'loadReport', 'copyReport']) {
  if (!new RegExp(`(async )?function ${fn}\\(`).test(pageScript)) { failed++; console.log('FAIL', `报告页缺少函数 ${fn}`) }
}
check('报告页函数齐全', true)
const inline = [...pageHtml.matchAll(/onclick="([a-zA-Z_$][\w$]*)\(/g)].map((match) => match[1])
check('内联事件调用的函数都存在', inline.every((name) => new RegExp(`(async )?function ${name}\\(`).test(pageScript)), inline.join(','))
check('页面从 ?token= 读 token', pageScript.includes("new URLSearchParams(location.search).get('token')"))
check('没有 token 时给出说明而不是满屏报错', pageScript.includes("getElementById('tokenHint').style.display = ''"))
check('页面请求 /api/report', pageScript.includes("api('/api/report'") && pageScript.includes("fresh=1"))
check('重新体检会强制刷新', pageHtml.includes('onclick="loadReport(true)"') && pageScript.includes("(force ? '?fresh=1' : '')"))
check('「去看 →」带 focus 深链回控制台', pageScript.includes('&focus=') && pageScript.includes('consoleHref'))
check('复制报告用服务端文本（不在页面里重算）', pageScript.includes('lastText = result.text') && pageScript.includes('navigator.clipboard.writeText(lastText)'))
check('剪贴板失败有兜底', pageScript.includes('document.execCommand') && pageScript.includes('手动全选'))
check('动态内容统一走 escapeHtml', /escapeHtml\((action|item|entry|group|fact|line)\./.test(pageScript))
check('错误自己显示出来（脚本错误不静默）', pageScript.includes("addEventListener('error'") && pageScript.includes("addEventListener('unhandledrejection'"))
check('有打印样式且打印时隐藏按钮', pageHtml.includes('@media print') && pageHtml.includes('header button,header a'))
check('可见时每分钟自动重算', pageScript.includes('}, 60000)') && pageScript.includes('document.hidden'))
check('页面不提供任何写操作（只读）', !/method\s*:\s*'POST'/.test(pageScript) && !pageScript.includes("method: 'POST'"))

const ui = readUi(join(import.meta.dirname, '..', 'control', 'ui.html'))
check('控制台右上角有「体检报告」入口', ui.includes('体检报告') && ui.includes('class="reportLink"'))
check('控制台一键体检卡里有完整报告链接', (ui.match(/class="reportLink/g) ?? []).length >= 2, String((ui.match(/class="reportLink/g) ?? []).length))
check('入口会带上 token', ui.includes("reportLink.href = '/report?token='"))
check('控制台支持 ?focus= 深链高亮（即时滚动，避免无头/后台标签页不滚）', ui.includes("get('focus')") && ui.includes('focusCard(focusTarget, false)'))

// 打包形态：页面跟 control/ 一起分发（package.json 的 files 里有 control）
const pkg = JSON.parse(readUi(join(import.meta.dirname, '..', 'package.json')))
check('package.json files 覆盖 report.html', (pkg.files ?? []).includes('control'))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
