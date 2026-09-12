/**
 * One-click diagnostics: the automated version of the "机器人没反应先查这些"
 * checklist. Pure function over injected facts, so every branch is testable and
 * the panel gets pass/fail plus a concrete next step for each item.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'

const MINUTE = 60_000

function item(id, title, ok, detail, hint = '', severity = 'error') {
  return { id, title, ok: Boolean(ok), detail, hint: ok ? '' : hint, severity: ok ? 'ok' : severity }
}

/** How stale a log/trace file may be before we call the bridge "not running". */
export const FRESH_WINDOW_MS = 15 * MINUTE

/**
 * @param config    resolved console config (paths + ports)
 * @param snapshot  supervisor inspect() result (ports + processes)
 * @param runtime   qq-runtime.json content (may be null)
 * @param events    recent trace events
 * @param files     { exists, stat, readFile } injectables for tests
 */
export function runDiagnose({ config, snapshot, runtime, events = [], now = Date.now(), files = {} } = {}) {
  const exists = files.exists ?? existsSync
  const readFile = files.readFile ?? ((file) => readFileSync(file, 'utf8'))
  const stat = files.stat ?? statSync
  const ports = snapshot?.ports ?? []
  const row = (name) => ports.find((port) => port.name === name)
  const checks = []

  // ---- 本机依赖 ----
  checks.push(item('node', 'node 可执行文件', config?.nodeExe && exists(config.nodeExe), config?.nodeExe || '未探测到', '设置 qq-control.json 的 nodeExe'))
  checks.push(item('dsh', 'DSH 宿主入口 bin.js', config?.dshBin && exists(config.dshBin), config?.dshBin || '未探测到', '用 --print-config 检查探测结果，或手动设置 dshBin'))
  checks.push(item('napcat-bat', 'NapCat 启动脚本', config?.napcatBat && exists(config.napcatBat), config?.napcatBat || '未探测到', '设置 napcatBat，或先安装 NapCat', 'warn'))
  checks.push(item('cwd', '宿主工作目录', Boolean(config?.cwd) && exists(config.cwd), config?.cwd || '未设置', '设置 cwd（宿主与桥都在这个目录读写日志/状态）'))

  // ---- 端口 ----
  const host = row('host')
  checks.push(item('port-host', `宿主端口 ${host?.port ?? '?'}`, host?.listening, host?.listening ? `PID ${host.pid} ${host.process}` : '无人监听', '点「启动宿主」，或先释放该端口'))
  const onebot = row('onebot')
  checks.push(item('port-onebot', `OneBot 端口 ${onebot?.port ?? '?'}`, onebot?.listening,
    onebot?.listening ? `PID ${onebot.pid} ${onebot.process}` : '无人监听',
    '机器人宿主没起来时 6700 不会监听；若被别的进程占用，用「释放」按钮结束它'))
  const napcatPort = row('napcat')
  checks.push(item('port-napcat', `NapCat WebUI ${napcatPort?.port ?? '?'}`, napcatPort?.listening,
    napcatPort?.listening ? `PID ${napcatPort.pid} ${napcatPort.process}` : '无人监听',
    '需要扫码登录时点「启动 NapCat」；仅聊天不需要它也能收消息（反向 WS 由 NapCat 主动连出）', 'warn'))
  const tts = row('tts')
  const ttsWanted = runtime?.features?.ttsEnabled === true
  checks.push(item('port-tts', `GPT-SoVITS ${tts?.port ?? '?'}`, !ttsWanted || tts?.listening,
    tts?.listening ? `PID ${tts.pid}` : (ttsWanted ? '未运行但 ttsEnabled=true' : '未运行（ttsEnabled=false，无影响）'),
    'ttsEnabled=true 而 9880 未运行时，每条回复都会记一条 tts failed（文字照发）', 'warn'))

  // ---- 链路 ----
  checks.push(item('bot-online', '机器人已连上桥（6700 有连接）', snapshot?.botOnline === true,
    snapshot?.botOnline ? `${onebot?.established ?? 0} 条连接` : '无 ESTABLISHED 连接',
    'NapCat 未启动/未登录时不会连过来：检查 QQ 是否在线、NapCat 是否扫码'))
  const bridgeSeen = events.some((event) => now - event.ts < FRESH_WINDOW_MS)
  checks.push(item('bridge-alive', '桥在最近 15 分钟内产生过事件', bridgeSeen,
    bridgeSeen ? `最近事件 ${Math.round((now - Math.max(...events.map((event) => event.ts))) / 1000)}s 前` : 'trace 文件里没有近期事件',
    '桥随宿主启动；若刚重启宿主，先发一条消息再看', 'warn'))

  // ---- 运行快照（跨进程读到的桥状态）----
  const runtimeFresh = runtime && now - (runtime.updatedAt ?? 0) < FRESH_WINDOW_MS
  checks.push(item('runtime', '桥的运行快照新鲜', runtimeFresh,
    runtime ? `更新于 ${Math.round((now - runtime.updatedAt) / 1000)}s 前，版本 ${runtime.version}，会话 ${runtime.sessionCount}` : '读不到 qq-runtime.json',
    '宿主没跑或桥插件没加载时会没有快照；先启动宿主', 'warn'))
  if (runtime) {
    const sessions = runtime.sessions ?? []
    checks.push(item('sessions', '会话映射', true, `${sessions.length} 个会话${sessions.length ? `（最近：${sessions[0].chatKey} ${sessions[0].resumed ? '续接' : '新建'}）` : ''}`, ''))
    const gate = runtime.gate ?? {}
    checks.push(item('gate', '写操作闸门', true, `已拒绝 ${gate.denied ?? 0} 次，跟踪 ${gate.tracked ?? 0} 个动作`, ''))
    const features = runtime.features ?? {}
    const off = Object.entries(features).filter(([, value]) => value === false).map(([key]) => key)
    checks.push(item('features', '生效配置已读取', true, `关闭中的开关：${off.slice(0, 8).join('、') || '无'}${off.length > 8 ? ` 等 ${off.length} 项` : ''}`, ''))
  }

  // ---- 事件面 ----
  const errors = events.filter((event) => event.level === 'error')
  const warns = events.filter((event) => event.level === 'warn')
  checks.push(item('errors', '最近没有 error 级事件', errors.length === 0,
    errors.length ? `${errors.length} 条，最近：${errors[errors.length - 1].stage} ${errors[errors.length - 1].reason ?? ''}` : '无',
    '看面板「事件流」筛 error 定位，或导出诊断包', 'warn'))
  checks.push(item('warn', '最近没有 warn 级事件', warns.length === 0,
    warns.length ? `${warns.length} 条，最近：${warns[warns.length - 1].stage} ${warns[warns.length - 1].reason ?? ''}` : '无',
    'warn 常见为「限流丢弃」「未处理的 notice」，多为配置预期', 'warn'))
  const drops = events.filter((event) => event.ok === false && event.reason)
  const topDrop = drops.length ? drops[drops.length - 1] : null
  checks.push(item('drops', '静默丢弃均有原因记录', true,
    drops.length ? `${drops.length} 条被拒，最常见：${topDrop.stage} ${topDrop.reason}` : '没有被拒事件',
    ''))

  // ---- 审计 ----
  const auditFile = config?.auditLog
  if (auditFile) {
    let denied = 0
    try {
      denied = (readFile(auditFile).match(/DENIED/g) ?? []).length
    } catch { denied = 0 }
    checks.push(item('audit', '写操作审计', true, denied > 0 ? `记录到 ${denied} 次被闸门拒绝的写操作` : '无被拒绝的写操作', denied > 0 ? '被拒原因见 qq-actions.log（多为每分钟/每日上限）' : '', 'warn'))
  }
  let traceSize = 0
  try { traceSize = stat(config?.logs?.trace ?? '')?.size ?? 0 } catch { traceSize = 0 }
  checks.push(item('trace-file', '事件文件可读', traceSize > 0, traceSize ? `${Math.round(traceSize / 1024)} KB` : '文件为空或不存在', 'traceEnabled=false 时不会产生事件文件', 'warn'))

  const failed = checks.filter((check) => !check.ok)
  return {
    checks,
    summary: {
      total: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      blockers: failed.filter((check) => check.severity === 'error').length,
      verdict: failed.some((check) => check.severity === 'error') ? 'blocked' : (failed.length ? 'warnings' : 'healthy'),
    },
    generatedAt: now,
  }
}

/** Render a diagnosis for the CLI / log output. */
export function formatDiagnose(report) {
  const lines = [`诊断结果：${report.summary.passed}/${report.summary.total} 通过（${report.summary.verdict}）`]
  for (const check of report.checks) {
    lines.push(`${check.ok ? '✅' : (check.severity === 'warn' ? '⚠️' : '❌')} ${check.title} — ${check.detail}`)
    if (!check.ok && check.hint) lines.push(`      ↳ ${check.hint}`)
  }
  return lines.join('\n')
}
