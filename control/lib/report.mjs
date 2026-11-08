/**
 * 一键体检报告（v0.8.5 之后的控制台功能）。
 *
 * 控制台总览里那张「一键体检」卡只够瞄一眼：它把 18 项检查平铺成一列 ✅/❌，
 * 但"先修哪个""六条硬约束和这次体检是什么关系""这份东西能不能直接发给别人"
 * 都没有答案。这一页把两件**既有产物**合成一份可打印、可复制、可深链回控制台的报告：
 *
 *   diagnose    逐项检查（依赖/端口/链路/快照/事件/审计）→ 分组明细
 *   acceptance  6 条硬约束的实时证据                      → 约束表
 *
 * 纯函数：输入全由调用方注入（体检结果、验收结果、运行快照），因此每条分支都能在
 * 没有宿主、没有网络时断言。页面只负责画，判定与文案都在这里，避免"页面里一套口径、
 * 测试里另一套"。
 */

/** 体检检查项的分组（顺序即页面顺序；target = 控制台里该跳去看的元素 id）。 */
export const REPORT_GROUPS = [
  { key: 'env', title: '本机依赖', target: 'cfgCwd' },
  { key: 'ports', title: '端口 / 进程', target: 'ports' },
  { key: 'link', title: '链路', target: 'runtime' },
  { key: 'runtime', title: '运行快照', target: 'runtime' },
  { key: 'events', title: '事件面', target: 'streamBox' },
  { key: 'audit', title: '审计与文件', target: 'log' },
  { key: 'other', title: '其它', target: 'diag' },
]

/** 检查 id → 分组 key。新增检查项忘了登记时落到 other，不会从报告里消失。 */
export const GROUP_OF_CHECK = {
  node: 'env',
  dsh: 'env',
  cwd: 'env',
  'napcat-bat': 'env',
  'port-host': 'ports',
  'port-onebot': 'ports',
  'port-napcat': 'ports',
  'port-tts': 'ports',
  'bot-online': 'link',
  'bridge-alive': 'link',
  runtime: 'runtime',
  sessions: 'runtime',
  gate: 'runtime',
  features: 'runtime',
  errors: 'events',
  warn: 'events',
  drops: 'events',
  audit: 'audit',
  'trace-file': 'audit',
}

/** 单条检查的跳转目标（比分组更精确：例如"事件面"里 error 项跳事件流）。 */
export const CHECK_TARGETS = {
  node: 'cfgCwd',
  dsh: 'cfgCwd',
  cwd: 'cfgCwd',
  'napcat-bat': 'cfgNapcatBat',
  errors: 'streamBox',
  warn: 'streamBox',
  drops: 'streamBox',
  audit: 'log',
  'trace-file': 'log',
}

/** 6 条硬约束 → 控制台里的落地卡片（与面板 ACCEPT_TARGETS 保持一致）。 */
export const CONSTRAINT_TARGETS = {
  silent: 'streamBox',
  trace: 'chain',
  replay: 'replayOut',
  diagnose: 'diag',
  export: 'log',
  inject: 'injState',
}

export const TONE_OF_VERDICT = {
  blocked: 'bad',
  unknown: 'unknown',
  warnings: 'warn',
  healthy: 'ok',
}

const STATUS_ICON = { pass: '✅', warn: '⚠️', fail: '❌', unknown: '❔' }
const VERDICT_TITLE = {
  blocked: '先修阻断项',
  warnings: '能跑，但有告警',
  unknown: '证据不足',
  healthy: '全部通过',
}

const asNumber = (value) => (Number.isFinite(value) ? value : 0)

/** 体检检查项 → 报告条目（补上分组与跳转目标；ok 项没有 hint）。 */
function toReportItem(check = {}) {
  const id = String(check.id ?? '')
  return {
    id,
    title: String(check.title ?? id ?? '（未命名检查）'),
    ok: check.ok === true,
    severity: check.ok === true ? 'ok' : (check.severity === 'warn' ? 'warn' : 'error'),
    detail: String(check.detail ?? ''),
    hint: check.ok === true ? '' : String(check.hint ?? ''),
    target: CHECK_TARGETS[id] ?? (REPORT_GROUPS.find((group) => group.key === (GROUP_OF_CHECK[id] ?? 'other'))?.target ?? 'diag'),
  }
}

/** 失败项排在前面，其余保持体检原顺序（稳定排序）。 */
function failedFirst(items) {
  return [...items.filter((item) => !item.ok), ...items.filter((item) => item.ok)]
}

/**
 * 合成结论。
 *
 * 优先级：有阻断项 → 阻断；有告警 → 告警；证据不足 → 证据不足；否则全绿。
 * 为什么"告警"排在"证据不足"前面：告警是**已经发生的事实**（某项检查真的没过），
 * 而证据不足是"还没测"，先让人处理已经确知的问题；同时 unknown 计数会写进 headline
 * 的明细，不会被藏起来。页面另有一张约束表把 ❔ 逐条列出来。
 */
export function combineVerdict({ diagnosis = null, acceptance = null } = {}) {
  const checks = diagnosis?.summary ?? {}
  const totals = acceptance?.totals ?? {}
  const blockers = asNumber(checks.blockers)
  const failed = asNumber(checks.failed)
  const warn = asNumber(totals.warn)
  const unknown = asNumber(totals.unknown)
  const fail = asNumber(totals.fail)
  if (blockers > 0 || fail > 0) return 'blocked'
  if (failed > 0 || warn > 0) return 'warnings'
  if (unknown > 0 || (!diagnosis && !acceptance)) return 'unknown'
  return 'healthy'
}

/** 报告里的一句话结论 + 明细。 */
export function buildHeadline({ verdict, checks, totals, hasDiagnosis }) {
  const total = asNumber(checks.total)
  const passed = asNumber(checks.passed)
  const failed = asNumber(checks.failed)
  const blockers = asNumber(checks.blockers)
  const unknown = asNumber(totals.unknown)
  const constraintPass = asNumber(totals.pass)
  const checkText = hasDiagnosis ? `体检 ${passed}/${total} 通过` : '还没有体检结果'
  if (verdict === 'blocked') {
    const reasons = [
      blockers > 0 ? `体检 blocker ${blockers} 项（失败 ${failed} 项）` : '',
      asNumber(totals.fail) > 0 ? `硬约束不达标 ${totals.fail} 条` : '',
    ].filter(Boolean).join('，')
    return {
      title: '有阻断项，先修这个',
      detail: `${reasons}${reasons ? '；' : ''}${checkText}`,
    }
  }
  if (verdict === 'warnings') {
    const warnings = failed + asNumber(totals.warn)
    return {
      title: `能跑，但有 ${warnings} 项告警`,
      detail: `${checkText}（失败 ${failed} 项，均非阻断）· 6 条硬约束 ${constraintPass}/6 达标`
        + (unknown > 0 ? ` · 另有 ${unknown} 条证据不足` : ''),
    }
  }
  if (verdict === 'unknown') {
    return {
      title: '证据不足，先别下结论',
      detail: `${checkText} · 6 条硬约束里 ${unknown} 条还没有证据（跑一次体检/回放/导出后再验收）`,
    }
  }
  return {
    title: '全部通过',
    detail: `${checkText} · 6 条硬约束 ${constraintPass}/6 达标`,
  }
}

/** 「先修这些」列表：体检失败项（阻断在前）+ 不达标的硬约束（④ 除外，它就是体检本身）。 */
export function buildActions({ groups = [], constraints = [], limit = 6 } = {}) {
  const items = groups.flatMap((group) => group.items)
  const errorChecks = items.filter((item) => !item.ok && item.severity !== 'warn')
  const warnChecks = items.filter((item) => !item.ok && item.severity === 'warn')
  const constraintFails = constraints.filter((entry) => entry.status === 'fail' && entry.key !== 'diagnose')
  const collected = [
    ...errorChecks.map((item) => ({
      source: 'check', severity: 'error', title: item.title,
      detail: item.detail, hint: item.hint, target: item.target, id: item.id,
    })),
    ...constraintFails.map((entry) => ({
      source: 'constraint', severity: 'error', title: entry.title,
      detail: entry.evidence, hint: entry.hint, target: entry.target, id: entry.key,
    })),
    ...warnChecks.map((item) => ({
      source: 'check', severity: 'warn', title: item.title,
      detail: item.detail, hint: item.hint, target: item.target, id: item.id,
    })),
  ]
  const seen = new Set()
  const actions = []
  for (const action of collected) {
    const key = `${action.source}:${action.id}`
    if (seen.has(key)) continue
    seen.add(key)
    actions.push(action)
    if (actions.length >= limit) break
  }
  return actions
}

/** 运行快照 → 报告页底部的"关键事实"（没有快照就整段不显示）。 */
export function buildFacts(runtime = null) {
  if (!runtime) return []
  const facts = [
    { label: '桥版本', value: `v${runtime.version ?? '?'}` },
    { label: '会话', value: String(asNumber(runtime.sessionCount)) },
    { label: '写操作被拒', value: `${asNumber(runtime.gate?.denied)} 次` },
    { label: '事件总数', value: String(asNumber(runtime.trace?.total)) },
  ]
  if (Number.isFinite(runtime.uptimeSeconds)) {
    facts.splice(1, 0, { label: '已运行', value: `${Math.max(0, Math.round(runtime.uptimeSeconds / 60))} 分钟` })
  }
  if (Number.isFinite(runtime.ageSeconds)) {
    facts.push({ label: '快照更新于', value: `${Math.max(0, Math.round(runtime.ageSeconds))} 秒前` })
  }
  return facts
}

/**
 * 合成整份报告。
 *
 * @param diagnosis   `sup.diagnose()` 的 `report`（或整包，两种形状都容忍）
 * @param acceptance  `sup.acceptance()` 的 `report`（或整包）
 * @param runtime     运行快照（可空）
 * @param generatedAt 生成时间；默认 Date.now()
 */
export function buildHealthReport({
  diagnosis = null, acceptance = null, runtime = null, generatedAt = Date.now(),
} = {}) {
  const checksReport = diagnosis?.report ?? diagnosis ?? null
  const acceptanceReport = acceptance?.report ?? acceptance ?? null
  const checks = {
    total: asNumber(checksReport?.summary?.total),
    passed: asNumber(checksReport?.summary?.passed),
    failed: asNumber(checksReport?.summary?.failed),
    blockers: asNumber(checksReport?.summary?.blockers),
  }
  const totals = {
    total: asNumber(acceptanceReport?.totals?.total ?? acceptanceReport?.checks),
    pass: asNumber(acceptanceReport?.totals?.pass),
    warn: asNumber(acceptanceReport?.totals?.warn),
    fail: asNumber(acceptanceReport?.totals?.fail),
    unknown: asNumber(acceptanceReport?.totals?.unknown),
  }
  if (totals.total === 0) totals.total = totals.pass + totals.warn + totals.fail + totals.unknown

  const items = (checksReport?.checks ?? []).map(toReportItem)
  const groups = REPORT_GROUPS
    .map((group) => {
      const groupItems = failedFirst(items.filter((item) => (GROUP_OF_CHECK[item.id] ?? 'other') === group.key))
      return {
        key: group.key,
        title: group.title,
        target: group.target,
        total: groupItems.length,
        failed: groupItems.filter((item) => !item.ok).length,
        items: groupItems,
      }
    })
    .filter((group) => group.items.length > 0)

  const constraints = (acceptanceReport?.items ?? []).map((item) => ({
    key: String(item.key ?? ''),
    title: String(item.title ?? item.key ?? ''),
    status: ['pass', 'warn', 'fail', 'unknown'].includes(item.status) ? item.status : 'unknown',
    evidence: String(item.evidence ?? ''),
    hint: String(item.hint ?? ''),
    target: CONSTRAINT_TARGETS[item.key] ?? 'acceptance',
  }))

  const verdict = combineVerdict({ diagnosis: checksReport, acceptance: acceptanceReport })
  const headline = buildHeadline({ verdict, checks, totals, hasDiagnosis: Boolean(checksReport) })
  const actions = buildActions({ groups, constraints })
  const facts = buildFacts(runtime)
  return {
    generatedAt,
    verdict,
    tone: TONE_OF_VERDICT[verdict] ?? 'unknown',
    // blocked / unknown 不算 ok：脚本与监控不该把"有阻断"或"证据不足"当通过
    ok: verdict !== 'blocked' && verdict !== 'unknown',
    headline,
    counters: {
      checks,
      constraints: {
        total: totals.total || constraints.length,
        pass: totals.pass,
        warn: totals.warn,
        fail: totals.fail,
        unknown: totals.unknown,
      },
    },
    groups,
    constraints,
    actions,
    facts,
  }
}

const padNumber = (value) => String(value).padStart(2, '0')
function stampOf(ts) {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} `
    + `${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`
}

/**
 * 可读文本（页面「复制报告」、CLI、贴到 issue 都用这一份）。
 * 结构与页面一致：结论 → 先修 → 明细 → 硬约束 → 关键事实。
 */
export function formatHealthReport(report) {
  if (!report) return '（还没有体检报告）'
  const checks = report.counters?.checks ?? {}
  const totals = report.counters?.constraints ?? {}
  const lines = [
    `一键体检报告 · ${stampOf(report.generatedAt)}`,
    `结论：${report.headline?.title ?? VERDICT_TITLE[report.verdict] ?? report.verdict}`,
    `      ${report.headline?.detail ?? ''}`.trimEnd(),
    `体检 ${checks.passed ?? 0}/${checks.total ?? 0} 通过（失败 ${checks.failed ?? 0}，其中 blocker ${checks.blockers ?? 0}）`
      + ` · 6 条硬约束 ${totals.pass ?? 0}/${totals.total ?? 0} 达标`
      + `（✅${totals.pass ?? 0} ⚠️${totals.warn ?? 0} ❌${totals.fail ?? 0} ❔${totals.unknown ?? 0}）`,
    '',
    '先修这些',
  ]
  if ((report.actions ?? []).length === 0) lines.push('  （没有需要先修的项）')
  for (const [index, action] of (report.actions ?? []).entries()) {
    const icon = action.severity === 'warn' ? '⚠️' : '❌'
    lines.push(`  ${index + 1}. ${icon} ${action.title} — ${action.detail}`)
    if (action.hint) lines.push(`     ↳ ${action.hint}`)
  }

  lines.push('', '体检明细')
  if ((report.groups ?? []).length === 0) lines.push('  （还没有体检结果：先把宿主与桥跑起来，再点「重新体检」）')
  for (const group of report.groups) {
    lines.push(`【${group.title}】${group.total - group.failed}/${group.total} 通过`)
    for (const item of group.items) {
      lines.push(`  ${STATUS_ICON[item.ok ? 'pass' : (item.severity === 'warn' ? 'warn' : 'fail')]} ${item.title} — ${item.detail}`)
      if (!item.ok && item.hint) lines.push(`      ↳ ${item.hint}`)
    }
  }

  lines.push('', '六条硬约束')
  if ((report.constraints ?? []).length === 0) lines.push('  （还没有验收结果：点「重新体检」会一起重算）')
  for (const entry of report.constraints) {
    lines.push(`  ${STATUS_ICON[entry.status]} ${entry.title} — ${entry.evidence}`)
    if (entry.hint) lines.push(`      ↳ ${entry.hint}`)
  }

  if ((report.facts ?? []).length > 0) {
    lines.push('', '关键事实')
    lines.push('  ' + report.facts.map((fact) => `${fact.label} ${fact.value}`).join(' · '))
  }
  lines.push('', '（本报告只读，不会改动机器上的任何状态；要动手请回控制台对应卡片）')
  return lines.join('\n')
}
