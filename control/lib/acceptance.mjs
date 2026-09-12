/**
 * v0.4 阶段 4：硬约束验收台。
 *
 * 「一切皆可调试」被拆成 6 条硬约束（纲领见 Mnemon 文档 2d6f1b23）。这一页不问
 * "功能有没有写"，只问"此刻机器上有没有证据"——每条约束都用**现有产物**算出一个
 * 状态与一段可读证据，任何一条不达标都直接说明该点哪里。
 *
 * 纯函数：所有输入（事件、快照、录制、体检、最近一次回放/导出）都由调用方注入，
 * 因此这里的分支可以在没有宿主、没有网络的情况下逐条断言。
 */

/** 消息级阶段：这些阶段的事件必须挂在某个 traceId 上（否则就无法端到端追）。 */
export const MESSAGE_STAGES = ['inbound', 'whitelist', 'quiet', 'dedup', 'filter', 'verify', 'keyword', 'game', 'command', 'mention', 'quote', 'media', 'transcribe', 'agent', 'reply', 'ratelimit', 'notice', 'request']

export const CONSTRAINTS = [
  { key: 'silent', title: '① 无静默分支', detail: '每一次"不回复/丢弃/降级"都留下中文原因' },
  { key: 'trace', title: '② 可关联（traceId）', detail: '一条消息从收到到回复共用一个 traceId' },
  { key: 'replay', title: '③ 可回放', detail: '录制 → 沙箱里 dry-run 重跑真实管线' },
  { key: 'diagnose', title: '④ 可体检', detail: '一键 pass/fail 体检并给修复建议' },
  { key: 'export', title: '⑤ 可导出', detail: '一个 zip 打包日志/配置/快照/体检' },
  { key: 'inject', title: '⑥ 可注入', detail: '假事件走真实管线，默认 dry-run 不碰 QQ' },
]

const item = (key, status, evidence, hint = '', metric = {}) => {
  const meta = CONSTRAINTS.find((entry) => entry.key === key) ?? { key, title: key, detail: '' }
  return { key, title: meta.title, detail: meta.detail, status, evidence, hint, metric }
}

/** ① 无静默分支：被拒/失败事件必须带 reason。 */
export function evaluateSilent(events = [], { traceLevel = '' } = {}) {
  // 被拒/丢弃埋点是 info 级，而 traceLevel 过滤发生在**写文件与内存环之前**：
  // 非 debug 时这些证据根本不存在，此时必须判"证据不足"，不能因为"文件里没有失败"就判达标。
  if (traceLevel && traceLevel !== 'debug') {
    return item('silent', 'unknown',
      `当前 traceLevel=${traceLevel}：被拒/丢弃分支（info 级）不会落盘，无法据此验收这一条`,
      '把 traceLevel 改回 debug（默认值）后再验收；或用 `mark` 的可选 level 参数把关键分支提升为 warn',
      { traceLevel })
  }
  const rejections = events.filter((event) => event.ok === false)
  const missing = rejections.filter((event) => String(event.reason ?? '').trim() === '')
  const errors = events.filter((event) => event.level === 'error')
  const errorsWithoutReason = errors.filter((event) => String(event.reason ?? '').trim() === '')
  if (events.length === 0) {
    return item('silent', 'unknown', '还没有读到事件（宿主/桥未运行或 traceEnabled=false）', '先给机器人发一条消息，或把 traceEnabled 打开', { rejections: 0, missing: 0 })
  }
  if (missing.length === 0 && errorsWithoutReason.length === 0) {
    const stages = [...new Set(rejections.map((event) => event.stage))].slice(0, 6)
    return item('silent', 'pass',
      `最近 ${events.length} 条事件里 ${rejections.length} 条被拒/失败，全部带原因${stages.length ? `（如 ${stages.join('、')}）` : ''}`,
      '', { rejections: rejections.length, missing: 0, errors: errors.length })
  }
  const bad = [...missing, ...errorsWithoutReason].slice(0, 5).map((event) => `${event.stage || '?'}@${event.chatKey || '-'}`)
  return item('silent', 'fail',
    `${missing.length + errorsWithoutReason.length} 条事件没有原因：${bad.join('、')}`,
    '这些埋点没写 reason；用 traceLevel=debug 复现后按 stage 补埋点', { rejections: rejections.length, missing: missing.length })
}

/** ② 可关联：消息级事件必须带 traceId，且至少有一条消息走完了 inbound→reply。 */
export function evaluateTrace(events = []) {
  const scoped = events.filter((event) => MESSAGE_STAGES.includes(event.stage))
  const orphans = scoped.filter((event) => !event.id)
  const inbound = events.filter((event) => event.stage === 'inbound' && event.id)
  const chains = new Map()
  for (const event of events) {
    if (!event.id) continue
    if (!chains.has(event.id)) chains.set(event.id, new Set())
    chains.get(event.id).add(event.stage)
  }
  const endToEnd = [...chains.values()].filter((stages) => stages.has('inbound') && stages.has('reply')).length
  if (inbound.length === 0) {
    return item('trace', 'unknown', '还没有带 traceId 的入站事件', '给机器人发一条消息再看（需要 traceEnabled 打开）', { inbound: 0, endToEnd: 0, orphans: orphans.length })
  }
  const coverage = Math.round(((scoped.length - orphans.length) / Math.max(1, scoped.length)) * 100)
  if (orphans.length === 0 && endToEnd > 0) {
    return item('trace', 'pass',
      `最近 ${inbound.length} 条入站消息、${chains.size} 条链路，其中 ${endToEnd} 条走完 inbound→reply；消息级事件 traceId 覆盖率 ${coverage}%`,
      '', { inbound: inbound.length, endToEnd, coverage, orphans: 0 })
  }
  if (endToEnd === 0) {
    return item('trace', 'warn',
      `有 ${inbound.length} 条入站消息，但最近没有一条走到 reply（可能都被白名单/@ 门拦下了）`,
      '看「实时事件流」里被拒的原因；或发一条必定会回复的消息（如私聊 /status）', { inbound: inbound.length, endToEnd: 0, coverage })
  }
  return item('trace', 'fail',
    `${orphans.length} 条消息级事件没有 traceId：${[...new Set(orphans.map((event) => event.stage))].slice(0, 5).join('、')}`,
    '这些阶段绕过了 beginTrace；检查对应埋点是否在 trace 句柄之外', { inbound: inbound.length, endToEnd, coverage, orphans: orphans.length })
}

/** ③ 可回放：录制在跑，且至少成功跑过一次沙箱回放。 */
export function evaluateReplay({ inbox = null, lastReplay = null, sandboxCount = 0 } = {}) {
  const recorded = inbox?.recorded ?? 0
  const queued = inbox?.queued ?? 0
  if (!inbox?.exists || recorded === 0) {
    return item('replay', 'warn', '还没有录制记录（qq-inbox.jsonl 为空或不存在）',
      '确认插件配置 recordInbound=true（默认开）并重启宿主，然后发一条消息', { recorded, queued, sandboxCount })
  }
  if (!lastReplay) {
    return item('replay', 'warn', `已录制 ${recorded} 条，但本次控制台还没跑过回放`,
      '点这一页上面的「回放最近 5 条」或录制列表里的「回放这条」', { recorded, queued, sandboxCount })
  }
  const totals = lastReplay.totals ?? {}
  const safety = lastReplay.safety ?? {}
  // 「源目录未改动」必须是**实测**出来的（replay.mjs 在回放前后各取一次清单），
  // 没测到就不许写成已验证；sandboxed 也参与判定（它是自证字段，但一样要真）。
  const sandboxed = safety.sandboxed !== false
  const sourceUnchanged = safety.sourceUnchanged === true
  const safe = safety.dryRun === true && safety.connectedBots === 0 && sandboxed && sourceUnchanged
  const evidence = `已录制 ${recorded} 条；最近一次回放 ${totals.entries ?? 0} 条（${totals.replied ?? 0} 会回复 / ${totals.silent ?? 0} 静默 / ${totals.error ?? 0} 出错），耗时 ${lastReplay.durationMs ?? 0}ms；沙箱 ${sandboxCount} 个`
  if (!safe) {
    const missing = [
      safety.dryRun === true ? '' : `dry-run=${safety.dryRun ? '开' : '关'}`,
      safety.connectedBots === 0 ? '' : `QQ 连接=${safety.connectedBots ?? '?'}`,
      sandboxed ? '' : 'cwd 未沙箱化',
      sourceUnchanged ? '' : (safety.sourceUnchanged === false ? `源目录有改动（${(safety.sourceChanges ?? []).slice(0, 3).join('、') || '见报告'}）` : '源目录未被实测校验'),
    ].filter(Boolean)
    return item('replay', 'fail', `${evidence}；安全保证不完整：${missing.join('、')}`,
      '回放必须全程 dry-run、零连接、cwd 在沙箱内，且回放前后源目录清单一致', { recorded, lastReplayAt: lastReplay.at })
  }
  if (lastReplay.ok === false) {
    return item('replay', 'fail', `${evidence}；本次回放里有条目出错`, '看回放结果文本里的「出错」条目原因', { recorded, lastReplayAt: lastReplay.at })
  }
  return item('replay', 'pass', `${evidence}；dry-run=开、QQ 连接 0、cwd 沙箱化、源目录实测未改动`, '', { recorded, lastReplayAt: lastReplay.at, sandboxCount })
}

/** ④ 可体检：体检跑过且没有 blocker。 */
export function evaluateDiagnose(diagnosis = null) {
  const summary = diagnosis?.report?.summary ?? null
  if (!summary) {
    return item('diagnose', 'warn', '还没拿到体检报告', '点右上角「一键体检」运行一次', {})
  }
  const { passed = 0, total = 0, failed = 0, blockers = 0, verdict = '' } = summary
  const failing = (diagnosis.report?.checks ?? []).filter((check) => !check.ok).slice(0, 3).map((check) => check.title)
  const evidence = `${passed}/${total} 项通过，失败 ${failed}（blocker ${blockers}），结论 ${verdict}`
  if (blockers > 0) {
    return item('diagnose', 'fail', `${evidence}${failing.length ? `；卡住项：${failing.join('、')}` : ''}`,
      '体检报告里每项都带修复建议，先处理 blocker', { passed, total, failed, blockers })
  }
  if (failed > 0) {
    return item('diagnose', 'warn', `${evidence}${failing.length ? `；告警项：${failing.join('、')}` : ''}`,
      '这些不是阻断项，但值得看一眼', { passed, total, failed, blockers })
  }
  return item('diagnose', 'pass', evidence, '', { passed, total, failed, blockers })
}

/** ⑤ 可导出：诊断包可生成（有内容可打），并显示最近一次导出体积。 */
export function evaluateExport({ lastExport = null, sources = [] } = {}) {
  const present = sources.filter((source) => source.present)
  if (lastExport) {
    return item('export', 'pass',
      `最近一次导出：${lastExport.entries} 个文件 / ${Math.round((lastExport.bytes ?? 0) / 1024)} KB（${lastExport.filename ?? ''}）`,
      '', { entries: lastExport.entries, bytes: lastExport.bytes })
  }
  if (present.length === 0) {
    return item('export', 'warn', '没有任何可打包的产物（日志/事件/快照都不存在）',
      '宿主与桥跑起来后就有了；点「导出诊断包」随时可生成', { present: 0, sources: sources.length })
  }
  return item('export', 'pass',
    `可导出：${present.length}/${sources.length} 类产物在位（${present.map((source) => source.name).slice(0, 6).join('、')}）`,
    '点右上角「导出诊断包」生成 zip（含体检报告与环境信息）', { present: present.length, sources: sources.length })
}

/** ⑥ 可注入：通道开着、dry-run 开着、队列能被消费。 */
export function evaluateInject({ injection = null, injectedEvents = [] } = {}) {
  if (!injection) {
    return item('inject', 'unknown', '运行时快照里还没有注入通道状态', '宿主起来后快照会带上（qq-runtime.json 的 injection）', {})
  }
  const { enabled = false, dryRun = false, consumed = 0, queued = 0, intervalMs = 0, lastAt = 0 } = injection
  const evidence = `通道${enabled ? '已开' : '关闭'} · dry-run=${dryRun ? '开' : '关'} · 轮询 ${intervalMs || '?'}ms · 本次已消费 ${consumed} 行 · 队列 ${queued} 行`
  if (!enabled) {
    return item('inject', 'warn', `${evidence}；通道关闭时控制台会明确拒绝入队并指出开关名`,
      '需要调试时把插件配置 injectEnabled 设为 true 并重启宿主', { enabled, dryRun, consumed, queued })
  }
  if (!dryRun) {
    return item('inject', 'fail', `${evidence}；**dry-run 关闭**：注入会真的把消息发到 QQ`,
      '把 injectDryRun 改回 true（默认值），除非你明确要用注入真发消息', { enabled, dryRun, consumed, queued })
  }
  // 消费过 ≠ 验证过：只有真的出现过"拦下出站"的证据（模型回复/工具/延时发送），才能说这一条达标
  const suppressed = injectedEvents.filter((event) => String(event.reason ?? '').includes('已被拦截')).length
  const consumedRecently = lastAt > 0 && Date.now() - lastAt < 24 * 3600 * 1000
  const verified = suppressed > 0
  const detail = consumed > 0
    ? `；已消费 ${consumed} 行，其中 ${suppressed} 次拦下了注入触发的出站（模型回复/工具/延时发送）`
    : '；还没消费过注入——发一条试试，注意出站会被拦下'
  return item('inject', consumed === 0 || !verified ? 'warn' : 'pass',
    `${evidence}${detail}`,
    consumed === 0
      ? '点上面的「注入」按钮，或在控制台注入一条消息验证链路'
      : (verified ? '' : '已消费过注入，但还没出现"拦下出站"的证据：确认桥的 dry-run 拦截事件是否被记录（stage=inject）'),
    { enabled, dryRun, consumed, queued, suppressed })
}

/**
 * 汇总 6 条约束。
 * @param events       最近的结构化事件（api.traceEvents）
 * @param runtime      运行快照（含 injection / inbox / replayHints）
 * @param inbox        api.inboxList() 的结果
 * @param lastReplay   本次控制台最近一次回放报告摘要（没有则 null）
 * @param lastExport   本次控制台最近一次导出摘要（没有则 null）
 * @param diagnosis    api.diagnose() 的结果
 * @param exportSources 体检包里会收集的产物清单（{name, present}）
 */
export function buildAcceptance({
  events = [], runtime = null, inbox = null, lastReplay = null, lastExport = null,
  diagnosis = null, exportSources = [], sandboxCount = 0, now = Date.now(),
} = {}) {
  const injectedEvents = events.filter((event) => event.stage === 'inject')
  const items = [
    evaluateSilent(events, { traceLevel: runtime?.features?.traceLevel ?? '' }),
    evaluateTrace(events),
    evaluateReplay({ inbox, lastReplay, sandboxCount }),
    evaluateDiagnose(diagnosis),
    evaluateExport({ lastExport, sources: exportSources }),
    evaluateInject({ injection: runtime?.injection ?? null, injectedEvents }),
  ]
  const generatedAt = typeof now === 'function' ? now() : now
  const totals = {
    pass: items.filter((entry) => entry.status === 'pass').length,
    warn: items.filter((entry) => entry.status === 'warn').length,
    fail: items.filter((entry) => entry.status === 'fail').length,
    unknown: items.filter((entry) => entry.status === 'unknown').length,
  }
  const verdict = totals.fail > 0 ? 'broken' : (totals.unknown > 0 ? 'unknown' : (totals.warn > 0 ? 'partial' : 'all-green'))
  // ok 同时要求"没有 fail"和"没有 unknown"：只读 ok 的脚本/监控不该把"证据不足"当通过
  return { ok: totals.fail === 0 && totals.unknown === 0, verdict, totals, items, generatedAt, checks: items.length }
}

/** 可读文本（控制台/CLI 通用）。 */
export function formatAcceptance(report) {
  if (!report) return '（还没有验收结果）'
  const icon = { pass: '✅', warn: '⚠️', fail: '❌', unknown: '❔' }
  const label = { 'all-green': '6 条硬约束全部达标', partial: '全部达标但有提示项', unknown: '证据不足（有未验证项）', broken: '有不达标项' }
  const lines = [`v0.4「一切皆可调试」硬约束验收：${report.totals.pass}/6 达标 · ${label[report.verdict] ?? report.verdict}`]
  for (const entry of report.items) {
    lines.push(`${icon[entry.status] ?? '·'} ${entry.title}：${entry.evidence}`)
    if (entry.hint) lines.push(`    ↳ ${entry.hint}`)
  }
  lines.push(`生成时间：${new Date(report.generatedAt).toLocaleString('zh-CN', { hour12: false })}`)
  return lines.join('\n')
}
