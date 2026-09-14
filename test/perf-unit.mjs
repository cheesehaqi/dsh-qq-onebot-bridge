/**
 * control/lib/perf.mjs 单测：控制台「性能 / 定时任务 / 群配置」三个面板的纯计算。
 *
 * 全部用手写的真实形状数据（trace 事件与运行快照都按 lib/trace.js / lib/bridge.js
 * 真正写出来的字段构造），不联网、不依赖控制台进程、不依赖第三方库。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  DEFAULT_PERCENTILES,
  chainSummaries,
  chainSummary,
  errorReport,
  groupsView,
  jobsView,
  percentiles,
  perfReport,
  stageStats,
} from '../control/lib/perf.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// —— 1. 分位数（空集绝不能返回 NaN） ——
const p = percentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
check('percentiles P50', p.p50 === 50, String(p.p50))
check('percentiles P95', p.p95 === 100, String(p.p95))
check('percentiles count/min/max/avg', p.count === 10 && p.min === 10 && p.max === 100 && p.avg === 55, JSON.stringify(p))
const empty = percentiles([])
check('percentiles 空数组 → null（不是 NaN）',
  empty.p50 === null && empty.p95 === null && empty.max === null && empty.count === 0, JSON.stringify(empty))
check('percentiles 过滤非数字与非数字字符串',
  percentiles([1, 'x', null, undefined, 3, '', true]).count === 2,
  JSON.stringify(percentiles([1, 'x', null, undefined, 3, '', true])))
check('percentiles 认数字字符串', percentiles(['100', '300']).p50 === 100, JSON.stringify(percentiles(['100', '300'])))
check('percentiles 单个值', percentiles([42]).p95 === 42)
check('percentiles 不修改入参顺序', (() => { const v = [3, 1, 2]; percentiles(v); return v[0] === 3 })())
check('DEFAULT_PERCENTILES 是 [50,95]', DEFAULT_PERCENTILES.join(',') === '50,95')

// —— 2. 单条链的摘要 ——
const inbound = { v: 1, ts: 1000, id: 't1', stage: 'inbound', ok: true, chatKey: 'g:2002', level: 'info' }
const agent = { v: 1, ts: 1300, id: 't1', stage: 'agent', ok: true, chatKey: 'g:2002', ms: 300, level: 'info' }
const reply = { v: 1, ts: 1500, id: 't1', stage: 'reply', ok: true, chatKey: 'g:2002', ms: 200, level: 'info' }
const summary = chainSummary([inbound, agent, reply])
check('chainSummary 端到端耗时 = 最后 − 最先', summary.ms === 500, JSON.stringify(summary))
check('chainSummary 记录会话键与阶段序列',
  summary.chatKey === 'g:2002' && summary.stages.join('>') === 'inbound>agent>reply', summary.stages.join('>'))
check('chainSummary 数出回复条数', summary.replies === 1)
check('chainSummary 乱序输入也能算', chainSummary([reply, inbound, agent]).ms === 500)
check('chainSummary 空输入 → null', chainSummary([]) === null && chainSummary(null) === null)
check('chainSummary 无 ts 的事件被忽略', chainSummary([{ id: 'x' }]) === null)

// —— 3. 失败判定：debug 级失败不算事故 ——
const failedChain = chainSummary([
  { v: 1, ts: 1, id: 't2', stage: 'inbound', ok: true },
  { v: 1, ts: 2, id: 't2', stage: 'engage', ok: false, level: 'warn', reason: '闸门拦下' },
])
check('chainSummary 有 warn 级失败 → failed=true', failedChain.failed === true)
const softFail = chainSummary([
  { v: 1, ts: 1, id: 't3', stage: 'inbound', ok: true },
  { v: 1, ts: 2, id: 't3', stage: 'engage', ok: false, level: 'debug', reason: '未启用' },
])
check('chainSummary 只有 debug 级失败 → 不算失败', softFail.failed === false)

// —— 4. 按 traceId 分组 ——
const events = [
  inbound, agent, reply,
  { v: 1, ts: 2000, id: 't2', stage: 'inbound', ok: true, chatKey: 'g:2003', level: 'info' },
  { v: 1, ts: 2400, id: 't2', stage: 'reply', ok: true, chatKey: 'g:2003', ms: 400, level: 'info' },
  { v: 1, ts: 3000, id: 't-untraced', stage: 'broadcast', ok: true, level: 'info' },
]
const chains = chainSummaries(events)
check('chainSummaries 按 id 分组，忽略 t-untraced', chains.length === 2, `len=${chains.length}`)
check('chainSummaries 按开始时间排序', chains[0].id === 't1' && chains[1].id === 't2')
check('chainSummaries 支持按会话过滤', chainSummaries(events, { chatKey: 'g:2003' }).length === 1)
check('chainSummaries 过滤到不存在的会话 → 空', chainSummaries(events, { chatKey: 'g:9999' }).length === 0)

// —— 5. 阶段耗时画像 ——
const stages = stageStats([
  { stage: 'agent', ms: 100 }, { stage: 'agent', ms: 300 }, { stage: 'agent', ms: 200 },
  { stage: 'reply', ms: 50 },
  { stage: 'inbound', ms: 0 },
  { stage: 'agent', ms: -5 },
])
check('stageStats 只统计 ms>0（0 表示没记时）', stages.find((s) => s.stage === 'inbound') === undefined, JSON.stringify(stages.map((s) => s.stage)))
check('stageStats 按数量出分位数', stages[0].stage === 'agent' && stages[0].count === 3 && stages[0].p50 === 200 && stages[0].p95 === 300, JSON.stringify(stages[0]))
check('stageStats 按 P95 降序', stages[0].stage === 'agent' && stages[1].stage === 'reply', stages.map((s) => s.stage).join(','))
check('stageStats 空输入 → 空数组', stageStats([]).length === 0)

// —— 6. 失败画像 ——
const errors = errorReport([
  { stage: 'reply', ok: false, reason: '限流丢弃', level: 'warn' },
  { stage: 'reply', ok: false, reason: '限流丢弃', level: 'warn' },
  { stage: 'reply', ok: false, reason: '合并转发失败', level: 'error' },
  { stage: 'agent', ok: false, reason: '模型超时', level: 'error' },
  { stage: 'engage', ok: false, reason: '未启用', level: 'debug' },
  { stage: 'reply', ok: true, level: 'info' },
])
check('errorReport 统计总数与失败数（debug 不计）', errors.total === 6 && errors.failed === 4, JSON.stringify({ total: errors.total, failed: errors.failed }))
check('errorReport 按阶段聚合', errors.byStage[0].stage === 'reply' && errors.byStage[0].count === 3, JSON.stringify(errors.byStage))
check('errorReport 给出最常见原因（含次数）',
  errors.byStage[0].topReasons[0].reason === '限流丢弃' && errors.byStage[0].topReasons[0].count === 2,
  JSON.stringify(errors.byStage[0].topReasons))
check('errorReport 没有 reason 时如实标注',
  errorReport([{ stage: 'x', ok: false, level: 'error' }]).byStage[0].topReasons[0].reason === '(没有 reason)')
check('errorReport 空输入不炸', errorReport(null).failed === 0 && errorReport([]).byStage.length === 0)

// —— 7. 性能面板总入口 ——
const report = perfReport(events, { now: 9999 })
check('perfReport 总条数与链数', report.events === 6 && report.chains.count === 2, JSON.stringify(report.chains))
check('perfReport 给出整体 P50/P95', report.chains.p50 === 400 && report.chains.p95 === 500, JSON.stringify(report.chains))
check('perfReport 按会话分组', report.byChat.length === 2 && report.byChat[0].chatKey === 'g:2002', JSON.stringify(report.byChat.map((c) => c.chatKey)))
check('perfReport 最慢的排前面', report.slowest[0].id === 't1' && report.slowest[0].ms === 500, JSON.stringify(report.slowest[0]))
check('perfReport 带阶段画像与失败画像', Array.isArray(report.stages) && typeof report.errors.failed === 'number')
check('perfReport 给一句人话结论', report.verdict.includes('P50') && report.verdict.includes('P95'), report.verdict)
const emptyReport = perfReport([])
check('perfReport 无数据时给中文说明而不是 NaN',
  emptyReport.verdict.includes('还没有可统计的消息') && emptyReport.chains.p50 === null, emptyReport.verdict)
check('perfReport 支持按会话聚焦（且只算该会话）',
  perfReport(events, { chatKey: 'g:2003' }).chains.count === 1, JSON.stringify(perfReport(events, { chatKey: 'g:2003' }).chains))

// —— 8. 定时任务视图 ——
const runtime = {
  features: { broadcastEnabled: true, autoHealEnabled: true },
  jobs: {
    broadcast: [
      { id: 'news', kind: 'rss', chat: 'g:2002', enabled: true, describe: 'RSS 播报', nextAt: 10_000 + 30_000, lastAt: 1000, lastReason: '已播报', runs: 5, failures: 0 },
      { id: 'bad', kind: 'mc', chat: 'g:2002', enabled: true, describe: 'MC', nextAt: 0, lastAt: 0, lastReason: '连接被拒绝', runs: 3, failures: 3 },
      { id: 'paused', kind: 'rss', chat: 'g:2003', enabled: false, describe: 'RSS 播报', nextAt: 0, lastAt: 0, lastReason: '', runs: 0, failures: 0 },
    ],
    webhook: { enabled: true, port: 8798, sources: [{ name: 'ci', received: 4, dropped: 1, lastAt: 1234 }] },
    autoHeal: { enabled: true, commandConfigured: true, cooldownSeconds: 300, maxPerHour: 3, attemptsLastHour: 1 },
  },
  injection: { enabled: true, dryRun: true, intervalMs: 2000, queued: 3, consumed: 7 },
}
const jobs = jobsView(runtime, { now: 10_000 })
check('jobsView 统计启用数量', jobs.broadcast.total === 3 && jobs.broadcast.enabledCount === 2, JSON.stringify(jobs.broadcast))
check('jobsView 把下次时间翻成人话', jobs.broadcast.rows[0].nextText === '30 秒后', jobs.broadcast.rows[0].nextText)
check('jobsView 停用的任务标「已停用」', jobs.broadcast.rows[2].nextText === '已停用', jobs.broadcast.rows[2].nextText)
check('jobsView 标出一直在失败的任务', jobs.broadcast.rows[1].health === '一直在失败', jobs.broadcast.rows[1].health)
check('jobsView 带上 webhook 来源计数',
  jobs.webhook.enabled === true && jobs.webhook.sources[0].received === 4,
  JSON.stringify(jobs.webhook))
check('jobsView 带上自愈状态（不含命令原文）',
  jobs.autoHeal.enabled === true && jobs.autoHeal.commandConfigured === true && jobs.autoHeal.command === undefined,
  JSON.stringify(jobs.autoHeal))
check('jobsView 带上注入队列状态', jobs.injection.queued === 3 && jobs.injection.consumed === 7 && jobs.injection.dryRun === true)
check('jobsView 缺 jobs 块时不炸', jobsView({}).broadcast.total === 0 && jobsView(null).webhook.enabled === false)
// 审查 G6：元素级畸形不能让整个接口 500
check('jobsView 元素级畸形不抛错（[null] / [1] / ["x"]）',
  (() => { try { const r = jobsView({ jobs: { broadcast: [null, 1, 'x', { id: 'ok', enabled: true }] } }); return r.broadcast.rows.length === 1 && r.broadcast.rows[0].id === 'ok' } catch { return false } })())
check('jobsView webhook.sources 元素级畸形也不抛错',
  (() => { try { return jobsView({ jobs: { webhook: { enabled: true, sources: [null, { name: 'ci' }] } } }).webhook.sources.length === 1 } catch { return false } })())
// 审查 G7：控制台侧必须自己挑字段，不能整对象透传
const leaky = jobsView({ jobs: { webhook: { enabled: true, port: 8798, sources: [{ name: 'ci', token: 'SECRET-TOKEN', secret: 'S3CR3T' }] }, autoHeal: { enabled: true, command: 'D:\\secret\\start-qq.bat', commandConfigured: true } } })
check('jobsView 不透传 token/secret',
  !JSON.stringify(leaky).includes('SECRET-TOKEN') && !JSON.stringify(leaky).includes('S3CR3T'), JSON.stringify(leaky.webhook.sources))
check('jobsView 不透传自愈命令原文',
  !JSON.stringify(leaky).includes('start-qq.bat') && leaky.autoHeal.command === undefined, JSON.stringify(leaky.autoHeal))
check('groupsView 元素级畸形不抛错（sessions:[null]、jobs:[null]）',
  (() => { try { const r = groupsView({ sessions: [null, { chatKey: 'g:2002', sessionId: 's', status: 'idle', lastTurnAt: 1 }], jobs: { broadcast: [null] } }); return r.groups.length === 1 } catch { return false } })())
check('jobsView 时间文案：即将触发 / 分钟 / 小时',
  jobsView({ jobs: { broadcast: [
    { id: 'a', enabled: true, nextAt: 9_000 },
    { id: 'b', enabled: true, nextAt: 10_000 + 120_000 },
    { id: 'c', enabled: true, nextAt: 10_000 + 7_200_000 },
  ] } }, { now: 10_000 }).broadcast.rows.map((r) => r.nextText).join('|') === '即将触发|2 分钟后|2 小时后',
  jobsView({ jobs: { broadcast: [
    { id: 'a', enabled: true, nextAt: 9_000 },
    { id: 'b', enabled: true, nextAt: 10_000 + 120_000 },
    { id: 'c', enabled: true, nextAt: 10_000 + 7_200_000 },
  ] } }, { now: 10_000 }).broadcast.rows.map((r) => r.nextText).join('|'))

// —— 9. 群配置视图 ——
const groupRuntime = {
  features: {
    engageEnabled: true, pokeBackEnabled: true, groupOpsEnabled: true, opsKickEnabled: false,
    reactionMessageCount: 12, opsCounterEntries: 4, pendingKickBatches: 1, typingActiveCount: 2,
  },
  replay: { allowGroups: [2002, 2003] },
  sessions: [
    { chatKey: 'g:2002', sessionId: 's-2002', status: 'idle', lastTurnAt: 1700 },
    { chatKey: 'g:2003', sessionId: 's-2003', status: 'running', lastTurnAt: 1800 },
    { chatKey: 'u:10001', sessionId: 's-priv', status: 'idle', lastTurnAt: 1900 },
  ],
  jobs: { broadcast: [{ id: 'news', chat: 'g:2002', enabled: true, nextAt: 5000 }, { id: 'x', chat: 'g:9999', enabled: true, nextAt: 6000 }] },
}
const groups = groupsView(groupRuntime, { now: 10_000 })
check('groupsView 只列群会话（私聊不进群配置页）',
  groups.groups.length === 2 && groups.groups.every((g) => /^\d+$/.test(g.groupId)), JSON.stringify(groups.groups.map((g) => g.groupId)))
check('groupsView 标出白名单状态', groups.groups.find((g) => g.groupId === '2002').allowlisted === true)
check('groupsView 把该群的定时任务挂到行上',
  groups.groups.find((g) => g.groupId === '2002').jobs.length === 1
  && groups.groups.find((g) => g.groupId === '2003').jobs.length === 0,
  JSON.stringify(groups.groups.map((g) => [g.groupId, g.jobs.length])))
check('groupsView 开关表带中文名与生效值',
  groups.switches.find((row) => row.key === 'pokeBackEnabled').on === true
  && groups.switches.find((row) => row.key === 'opsKickEnabled').on === false
  && groups.switches.every((row) => row.label.length > 0),
  JSON.stringify(groups.switches.slice(0, 3)))
check('groupsView 统计打开的开关数', groups.onCount === 3, String(groups.onCount))
check('groupsView 带实时计数', groups.counters.reactionMessages === 12 && groups.counters.pendingKickBatches === 1, JSON.stringify(groups.counters))
check('groupsView 说明开关真源在插件配置',
  groups.note.includes('cordis.patch.yml'), groups.note)
check('groupsView 白名单不可知时 allowlisted=null（不猜）',
  groupsView({ features: {}, sessions: [{ chatKey: 'g:2002', sessionId: 's', status: 'idle', lastTurnAt: 1 }] }).groups[0].allowlisted === null)
check('groupsView 空快照不炸', groupsView({}).groups.length === 0 && groupsView(null).switches.length > 0)
check('groupsView 群按最近活跃排序',
  groupsView(groupRuntime).groups[0].groupId === '2003', JSON.stringify(groupsView(groupRuntime).groups.map((g) => g.groupId)))
check('groupsView 时间显示为可读字符串（不是 — 也不是原始时间戳）',
  groups.groups[0].lastTurnText !== '—' && /\d{4}/.test(groups.groups[0].lastTurnText), groups.groups[0].lastTurnText)

// —— 10. 红线：纯模块（零依赖、零 I/O） ——
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'control', 'lib', 'perf.mjs'), 'utf8')
check('perf.mjs 零 import', source.split('\n').filter((line) => /^\s*import\s/.test(line)).length === 0)
check('perf.mjs 不读文件/不联网', !/readFileSync|writeFileSync|fetch\s*\(|node:fs|node:http/.test(source))
check('perf.mjs 不碰进程/环境变量', !/process\.env|child_process/.test(source))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
