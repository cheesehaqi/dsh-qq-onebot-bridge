/**
 * Supervision primitives for the standalone QQ bot console.
 *
 * Every function is pure or takes its side effects by injection (`exec`, `spawn`,
 * `readFile`, `now`) so the whole layer is unit-testable without touching the
 * real machine, and the console can never invent a target it was not configured
 * to touch (see `assertKillAllowed`).
 */
import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PORT_LABELS, configWarnings } from './config.mjs'
import { createTraceTailer, filterEvents, formatChain, groupChains, readRuntime, readTraceFile, summarizeEvents } from './trace.mjs'
import { formatDiagnose, runDiagnose } from './diagnose.mjs'
import { buildZip, fileEntry } from './zip.mjs'
import { createAccountsApi, napcatConfigDir } from './accounts.mjs'
import { createReplayer } from './replay.mjs'
import { buildAcceptance, formatAcceptance } from './acceptance.mjs'
import { buildHealthReport, formatHealthReport } from './report.mjs'
import { buildHistoryEntry, filterHistory, formatHistory, parseHistory } from './history.mjs'
import { groupsView as groupsReport, jobsView as jobsReport, perfReport } from './perf.mjs'
import { redactByKind, redactionNote } from './redact.mjs'
import { appendCappedLine, moveToTrash } from '../../lib/store.js'
import { countLines, describeFrame, parseInjectionLine, readInbox } from '../../lib/inbox.js'
import { HistoryArchive } from '../../lib/archive.js'

/** Plugin repo root, derived from this file's location (control/lib/… → repo). */
export function defaultPluginRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

// ---------------------------------------------------------------- parsing ----

/**
 * Parse `netstat -ano` output into rows.
 * @returns {{proto:string, localPort:number, remotePort:number, state:string, pid:number}[]}
 */
export function parseNetstat(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(TCP|UDP)\s+(\S+)\s+(\S+)\s*(LISTENING|ESTABLISHED|TIME_WAIT|CLOSE_WAIT|SYN_SENT|UDP)?\s+(\d+)\s*$/i.exec(line)
    if (!match) continue
    const [, proto, local, remote, state, pid] = match
    rows.push({
      proto: proto.toUpperCase(),
      localPort: portOf(local),
      remotePort: portOf(remote),
      state: (state ?? '').toUpperCase(),
      pid: Number(pid),
    })
  }
  return rows
}

/** `127.0.0.1:3080` / `[::]:6700` / `0.0.0.0:0` → 3080 / 6700 / 0 */
export function portOf(address) {
  const match = /:(\d+)$/.exec(String(address ?? ''))
  return match ? Number(match[1]) : 0
}

/** `tasklist /FO CSV /NH` 的解析在 lib/napcat-launch.js（那里也做加载器挑选）。 */

/** Combine netstat + tasklist into one row per watched port. */
/**
 * 宿主（DSH 桌面端）的监听端口**不是固定的**：每次启动可能是 5xxxx 的随机端口，
 * 而 `qq-control.json` 里只有一个默认值（3080）。这里做一次兜底识别：
 * 配置端口没在监听时，从 netstat + tasklist 里找"宿主进程"的监听端口。
 * 识别不了就保持原样（不瞎猜）。
 */
const HOST_PROCESS_HINT = /deepseek|harness|dsh|electron/i

export function guessHostPort(netstatRows, taskMap, ports, preferred = 3080) {
  const watched = new Set(Object.values(ports ?? {}).map((port) => Number(port)))
  const candidates = netstatRows
    .filter((row) => row.state === 'LISTENING')
    .filter((row) => HOST_PROCESS_HINT.test(taskMap.get(row.pid) ?? ''))
    .filter((row) => !watched.has(Number(row.localPort)) || Number(row.localPort) === Number(preferred))
  if (candidates.length === 0) return null
  // 优先 4-5 位的高位端口（DSH 实际用的），再退回第一个
  const high = candidates.filter((row) => row.localPort >= 10000)
  const picked = (high.length > 0 ? high : candidates)[0]
  return picked ? Number(picked.localPort) : null
}

export function summarizePorts(netstatRows, taskMap, ports, labels = {}) {
  const rows = Object.entries(ports).map(([name, port]) => {
    const listeners = netstatRows.filter((row) => row.localPort === port && row.state === 'LISTENING')
    const established = netstatRows.filter((row) => row.localPort === port && row.state === 'ESTABLISHED')
    const owner = listeners[0]
    return {
      name,
      label: labels[name] ?? name,
      port,
      listening: listeners.length > 0,
      pid: owner?.pid ?? 0,
      process: owner ? (taskMap.get(owner.pid) ?? '') : '',
      established: established.length,
    }
  })

  // 宿主端口兜底：配置值没在监听，就去 netstat 里认出宿主真正的端口
  const hostRow = rows.find((row) => row.name === 'host')
  if (hostRow && hostRow.listening !== true) {
    const guessed = guessHostPort(netstatRows, taskMap, ports, hostRow.port)
    if (guessed !== null) {
      const owner = netstatRows.find((row) => row.state === 'LISTENING' && Number(row.localPort) === guessed)
      hostRow.port = guessed
      hostRow.listening = true
      hostRow.pid = owner?.pid ?? 0
      hostRow.process = owner ? (taskMap.get(owner.pid) ?? '') : ''
      hostRow.autoDetected = true
    }
  }
  return rows
}

// ------------------------------------------------------------------ reads ----

/** Last `lines` lines of a file (missing/locked files yield an empty list). */
export function tailLines(file, lines = 200, { readFile = readFileSync } = {}) {
  try {
    const text = readFile(file, 'utf8')
    const all = String(text).split(/\r?\n/)
    return all.slice(Math.max(0, all.length - Math.max(1, lines)))
  } catch {
    return []
  }
}

/**
 * The 3080 console URL with its token, parsed out of the host's stdout log.
 * The log is appended to across host restarts, so the LAST match is the token
 * of the currently running host (taking the first would yield a stale 401).
 */
export function extractHostUrl(logText) {
  const matches = [...String(logText ?? '').matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/g)]
  if (matches.length === 0) return ''
  const last = matches[matches.length - 1]
  return `http://127.0.0.1:${last[1]}/?token=${last[2]}`
}

/** QR-code freshness for the NapCat login page. */
export function qrStatus(file, now = Date.now(), { stat = statSync } = {}) {
  try {
    const info = stat(file)
    const ageSeconds = Math.max(0, Math.round((now - info.mtimeMs) / 1000))
    return { exists: true, ageSeconds, fresh: ageSeconds < 300, mtimeMs: info.mtimeMs, error: '' }
  } catch (error) {
    // 区分"文件不存在"和"存在但读不到"（EBUSY/EACCES/EPERM）。
    // 一律当成"不存在"会把真实原因掩盖成"NapCat 没在运行"（审查提的 O1）。
    const code = error?.code ?? ''
    if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, ageSeconds: -1, fresh: false, mtimeMs: 0, error: '' }
    return { exists: false, ageSeconds: -1, fresh: false, mtimeMs: 0, error: `${code || 'stat 失败'}：${error?.message ?? ''}`.slice(0, 160) }
  }
}

/** 二维码超过这个秒数就认为过期（QQ 的码大约 1～2 分钟失效，这里给宽一点）。 */
export const QR_STALE_SECONDS = 300

/**
 * NapCat 的启动 / 加载器判定逻辑**住在 `lib/napcat-launch.js`**（DSH 设置页的「快捷操作」也用同一份）。
 * 这里既 import（本模块自己要用）又 re-export（`test/control-unit.mjs` 等原有 import 不变）——
 * 注意 `export … from` 不会在本地作用域建绑定，所以两件事都得写。
 */
import {
  NAPCAT_LAUNCH_LOG_FILE, NAPCAT_LOADER_NAMES, NAPCAT_LOADER_RE, NAPCAT_SHIM_FILE, QQ_CLIENT_RE,
  fileMtime, napcatLaunchCommand, napcatLaunchLogPath, napcatRestartCommand, napcatShimPath,
  parseTasklist, pickNapcatLoaders, resolveNapcatLauncher, shimHeartbeatFresh, writeNapcatShim,
} from '../../lib/napcat-launch.js'

export {
  NAPCAT_LAUNCH_LOG_FILE, NAPCAT_LOADER_NAMES, NAPCAT_LOADER_RE, NAPCAT_SHIM_FILE, QQ_CLIENT_RE,
  napcatLaunchCommand, napcatLaunchLogPath, napcatRestartCommand, napcatShimPath,
  parseTasklist, pickNapcatLoaders, resolveNapcatLauncher, writeNapcatShim,
}

// ---------------------------------------------------------------- actions ----

/** Default execFile wrapper (promise, never throws). */
export function run(command, args, { timeoutMs = 15000, exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null || error === undefined, code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), message: error?.message ?? '' })
    })
  })
}

/** Snapshot of ports + processes used by the UI. */
export async function inspect({ ports, labels = {}, exec } = {}) {
  const [netstat, tasklist] = await Promise.all([
    run('netstat', ['-ano'], { exec }),
    run('tasklist', ['/FO', 'CSV', '/NH'], { exec }),
  ])
  const rows = parseNetstat(netstat.stdout)
  const tasks = parseTasklist(tasklist.stdout)
  const summary = summarizePorts(rows, tasks, ports, labels)
  const entries = [...tasks.entries()].map(([pid, name]) => ({ pid, name }))

  // 关键区分：只有 NapCat 加载器存在时才把 QQ.exe 当作"受管机器人进程"。
  // 否则用户自己的 QQ 客户端必须原封不动（曾被误杀风险）。
  const loaders = entries.filter((entry) => NAPCAT_LOADER_RE.test(entry.name))
  const qqClients = entries.filter((entry) => QQ_CLIENT_RE.test(entry.name))
  const napcatPort = summary.find((item) => item.name === 'napcat')
  const napcatManaged = loaders.length > 0 || Boolean(napcatPort?.listening)

  const host = summary.find((item) => item.name === 'host')
  return {
    ports: summary,
    processes: {
      host: { running: Boolean(host?.listening), pid: host?.listening ? host.pid : 0 },
      // 受管 NapCat：加载器 +（仅在 NapCat 确实在跑时）它的 QQ 客户端
      napcat: napcatManaged ? loaders.concat(qqClients) : loaders,
      napcatLoaders: loaders,
      qqClients,
      napcatManaged,
      tts: entries.filter((entry) => /^pythonw?\.exe$/i.test(entry.name)),
    },
    botOnline: (summary.find((item) => item.name === 'onebot')?.established ?? 0) > 0,
    scannedAt: Date.now(),
  }
}

/** NapCat's own loader/launcher executables (never the personal QQ client) —— 定义在 lib/napcat-launch.js。 */

/** Launch a detached process with its stdout/stderr appended to log files. */
export function startDetached({ command, args = [], cwd, outFile, errFile, spawnImpl = spawn }) {
  if (!command) throw new Error('缺少可执行文件路径')
  const stdio = ['ignore', 'ignore', 'ignore']
  let outFd = null
  let errFd = null
  try {
    if (outFile) { outFd = openSync(outFile, 'a'); stdio[1] = outFd }
    if (errFile) { errFd = openSync(errFile, 'a'); stdio[2] = errFd }
  } catch {
    /* 日志文件打不开就退化成丢弃输出，进程照常启动 */
  }
  const child = spawnImpl(command, args, { cwd, detached: true, windowsHide: true, stdio })
  child.unref?.()
  if (outFd !== null) closeSync(outFd)
  if (errFd !== null) closeSync(errFd)
  return { pid: child.pid ?? 0 }
}

/**
 * Guard rail: only PIDs that currently own a watched port, a NapCat loader, or
 * the GPT-SoVITS process may be killed. The personal QQ client is NOT killable
 * (its name alone never qualifies), which is deliberate.
 */
export function assertKillAllowed(pid, { snapshot, ports, allowedNames = ['node.exe', 'napcatwinbootmain.exe', 'napcat.exe', 'napcatshell.exe', 'python.exe', 'pythonw.exe'] } = {}) {
  const target = Number(pid)
  if (!Number.isFinite(target) || target <= 0) return { ok: false, reason: 'PID 非法' }
  if (target === process.pid) return { ok: false, reason: '拒绝杀掉控制台自身' }
  const ownsPort = (snapshot?.ports ?? []).some((item) => item.pid === target && (ports ? Object.values(ports).includes(item.port) : true))
  if (ownsPort) return { ok: true, reason: 'occupies a watched port' }
  const loader = (snapshot?.processes?.napcatLoaders ?? []).some((entry) => entry.pid === target)
  if (loader) return { ok: true, reason: 'NapCat loader' }
  const tts = (snapshot?.processes?.tts ?? []).some((entry) => entry.pid === target && /^pythonw?\.exe$/i.test(entry.name))
  if (tts) return { ok: true, reason: 'GPT-SoVITS process' }
  const name = (snapshot?.ports ?? []).find((item) => item.pid === target)?.process ?? ''
  if (name && allowedNames.includes(name.toLowerCase())) return { ok: true, reason: `known executable ${name}` }
  return { ok: false, reason: `PID ${target} 不属于受管端口或已知进程，拒绝操作（个人 QQ 客户端不受管）` }
}

/** Kill a process tree (Windows: taskkill /T /F). */
export async function killTree(pid, { exec } = {}) {
  return run('taskkill', ['/PID', String(pid), '/T', '/F'], { exec })
}

/** Whether a path exists (injectable for tests). */
export function fileExists(file, { exists = existsSync } = {}) {
  return Boolean(file) && exists(file)
}

/**
 * 拉起**提权**命令用的子进程：**绝不能带 `detached`**（2026-10-16 真机实测，issue #2 的第二层原因）。
 *
 * 现象：这台机器上 `detached: true` 的 **powershell 子进程根本不执行**——退出码 0、没有任何输出、
 * 垫片一行都没写；把同一个命令的 `detached` 去掉，垫片立刻跑起来（`control-unit` 里那条
 * "垫片留下心跳才算成功"的断言就是这条路）。控制台原来用的是通用 `startDetached`（`detached: true`），
 * 于是**就算垫片路径修好了，点「启动 NapCat」也只会得到一句"提权那一跳被拦下了"——诊断仍然是错的**。
 *
 * 顺带把 powershell 的输出收下来（与 DSH 面板的 `spawnDetachedProcess` 同一形状）：
 * `QAI-ELEVATED` / `QAI-RUNAS` 说明走的是哪条分支，报错原文也能带回界面，而不是丢掉。
 *
 * 这里不需要 `detached`：提权那一跳由 AppInfo（RunAs）或 WmiPrvSE（WMI）拉起，
 * **本来就脱离我们的进程树**——NapCat 不会因为控制台退出被带走。
 */
export function spawnElevated({ command, args = [], cwd, spawnImpl = spawn, waitMs = 8000 } = {}) {
  if (!command) throw new Error('缺少可执行文件路径')
  return new Promise((resolve) => {
    let child = null
    try {
      child = spawnImpl(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ pid: 0, failed: true, code: -1, stdout: '', stderr: '', message: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout?.on?.('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk) })
    const finish = (extra) => {
      if (settled) return
      settled = true
      child.unref?.()
      resolve({ pid: child.pid ?? 0, failed: false, code: null, stdout, stderr, ...extra })
    }
    child.once?.('error', (error) => finish({ failed: true, code: -1, message: String(error?.message ?? error) }))
    child.once?.('exit', (code) => finish({ code: typeof code === 'number' ? code : -1 }))
    // 超时也照常放行：命令可能还挂着（比如等 UAC / 等提权那一跳），我们只是不再等它。
    // 单测里的假子进程不会发 `exit`，把 waitMs 调小即可（真机给 8 秒）。
    const timer = setTimeout(() => finish({ code: null, timedOut: true }), Math.max(500, Number(waitMs) || 0))
    timer.unref?.()
  })
}

// ------------------------------------------------------------ supervisor ----

/** Config fields the UI/API is allowed to read (no secrets live here anyway). */
export function publicConfig(config) {
  return {
    cwd: config.cwd,
    nodeExe: config.nodeExe,
    dshBin: config.dshBin,
    napcatBat: config.napcatBat,
    napcatQr: config.napcatQr,
    ttsBat: config.ttsBat,
    logs: { ...config.logs },
    ports: { ...config.ports },
  }
}
/**
 * The real supervisor: every action re-inspects the machine first, so a stale
 * PID can never be killed and a busy port is reported instead of half-started.
 */
export function createSupervisor(config, deps = {}) {
  const { exec, spawnImpl, now = () => Date.now() } = deps
  const inspectNow = () => inspect({ ports: config.ports, labels: PORT_LABELS, exec })
  let replayer = null   // 每个 supervisor 一份，避免跨实例共享沙箱状态
  let diagnoseCache = null   // { at, value }：体检结果的短时缓存
  let lastReplaySummary = null   // 验收台要看"最近一次回放"的证据
  let lastExportSummary = null   // 验收台要看"最近一次导出"的证据

  const portRow = (snapshot, name) => (snapshot.ports ?? []).find((item) => item.name === name)

  /**
   * 运行统计（纯本地）：读 trace 尾部，按 stage / ok 聚合最近 N 条。
   * 为什么读 trace 而不是问 NapCat：这是"机器人做了什么"的唯一真源，且 NapCat 那边没有等价接口。
   */
  async function traceStats({ lines = 2000 } = {}) {
    const file = config.logs?.trace ?? ''
    if (!file) return { ok: false, reason: '没有配置 trace 路径', total: 0, byStage: {}, errors: 0, recent: [] }
    const raw = tailLines(file, lines)
    const byStage = {}
    let errors = 0
    let oldest = null
    let newest = null
    const recentErrors = []
    for (const line of raw) {
      let event = null
      try { event = JSON.parse(line) } catch { continue }
      const stage = String(event.stage ?? 'unknown')
      byStage[stage] = (byStage[stage] ?? 0) + 1
      if (event.ok === false) {
        errors += 1
        if (recentErrors.length < 8) recentErrors.push({ stage, reason: String(event.reason ?? '').slice(0, 160), at: event.at ?? event.ts ?? '' })
      }
      const at = event.at ?? event.ts ?? event.time
      if (typeof at === 'string' && at !== '') {
        if (newest === null || at > newest) newest = at
        if (oldest === null || at < oldest) oldest = at
      }
    }
    return { ok: true, reason: '', total: raw.length, byStage, errors, oldest, newest, recentErrors }
  }

  async function status() {
    const snapshot = await inspectNow()
    const hostLog = tailLines(config.logs?.hostOut, 120, deps).join('\n')
    return {
      ...snapshot,
      // 运行时快照一并返回：面板只发一个轮询请求，避免和 SSE 抢 HTTP/1.1 的并发名额。
      runtime: runtime(),
      hostUrl: extractHostUrl(hostLog),
      hostStartedHint: /dsh web: http:\/\/127\.0\.0\.1/.test(hostLog),
      qr: qrStatus(config.napcatQr, now(), deps),
      warnings: configWarnings(config),
      config: publicConfig(config),
    }
  }

  async function startHost() {
    if (!config.nodeExe || !config.dshBin) return { ok: false, reason: '未配置 nodeExe / dshBin，无法启动宿主' }
    const snapshot = await inspectNow()
    const busy = ['host', 'onebot'].map((name) => portRow(snapshot, name)).filter((row) => row?.listening)
    if (busy.length > 0) {
      return { ok: false, reason: `端口被占用：${busy.map((row) => `${row.port}←${row.process || '未知'}#${row.pid}`).join('、')}`, snapshot }
    }
    try {
      const { pid } = startDetached({
        command: config.nodeExe,
        args: [config.dshBin, 'web', '--no-open'],
        cwd: config.cwd || undefined,
        outFile: config.logs?.hostOut,
        errFile: config.logs?.hostErr,
        spawnImpl,
      })
      return { ok: true, pid, reason: '' }
    } catch (error) {
      return { ok: false, reason: `启动失败：${error.message}` }
    }
  }

  /** Kill whatever occupies one watched port (guard-railed). */
  async function freePort(name) {
    const snapshot = await inspectNow()
    const row = portRow(snapshot, name)
    if (!row) return { ok: false, reason: `未知端口名：${name}` }
    if (!row.listening) return { ok: false, reason: `${row.label}（${row.port}）当前没有监听进程` }
    const guard = assertKillAllowed(row.pid, { snapshot, ports: config.ports })
    if (!guard.ok) return { ok: false, reason: guard.reason }
    const result = await killTree(row.pid, { exec })
    return { ok: result.ok, reason: result.ok ? `已结束 PID ${row.pid}（${row.process || '未知'}）` : `结束失败：${result.stderr || result.message}`, pid: row.pid }
  }

  async function stopHost() {
    const snapshot = await inspectNow()
    const host = portRow(snapshot, 'host')
    if (!host?.listening) return { ok: false, reason: '宿主未在运行' }
    const guard = assertKillAllowed(host.pid, { snapshot, ports: config.ports })
    if (!guard.ok) return { ok: false, reason: guard.reason }
    const result = await killTree(host.pid, { exec })
    return { ok: result.ok, reason: result.ok ? `宿主已停止（PID ${host.pid}）` : '停止失败' }
  }

  /**
   * 垫片脚本 / 启动日志的落点：**与控制台配置里那个工作目录一致**。
   *
   * 为什么必须是同一个文件（issue #2）：DSH 面板用的是同一份 `qq-control.json` 的 `cwd`，
   * 两边各写一处就会出现"面板点了能起来、控制台点了说找不到垫片"。名字也共用常量。
   */
  const napcatShimDir = () => String(config.cwd ?? '').trim() || defaultPluginRoot()
  const napcatShimFile = () => napcatShimPath(napcatShimDir())
  const napcatLogFile = () => napcatLaunchLogPath(napcatShimDir())

  /** 垫片心跳：`since` = 点击之前的日志 mtime（只有"这次新写进去的"心跳才算数）。 */
  const shimRan = (logFile, since, withinMs = 60_000) => shimHeartbeatFresh(logFile, {
    stat: deps.stat ?? statSync,
    readFile: deps.readFile ?? readFileSync,
    withinMs,
    since,
  })

  /** 等垫片留下心跳：提权那一跳是被系统**悄悄**拦下的（powershell 退出码还是 0），只能靠日志判。 */
  async function waitForShimRan(logFile, since, waitMs) {
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0)
    for (;;) {
      if (shimRan(logFile, since)) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => { const timer = setTimeout(resolve, 400); timer.unref?.() })
    }
  }

  /**
   * 写垫片 → 提权执行 → **等心跳**。启动与重启登录共用（这两条路原来都漏了垫片路径）。
   *
   * 返回的 `ok` 只在**垫片真的跑起来**时才为 true：`6099 在听`不能当判据
   * （NapCat 本来就在跑时它永远为真，真机上抓到过"界面报成功、其实什么都没发生"）。
   */
  async function runNapcatPlan({ plan, chosen }) {
    const shimFile = plan.shim?.path ?? ''
    const logFile = plan.logFile ?? napcatLogFile()
    const written = writeNapcatShim(plan.shim, { writeFile: deps.writeFile ?? writeFileSync, ensureDir: deps.ensureDir })
    if (written.ok !== true) {
      return { ok: false, shimFile, logFile, reason: `写不了启动垫片 ${written.path}：${written.reason}` }
    }
    const since = fileMtime(logFile, { stat: deps.stat ?? statSync })
    const result = await spawnElevated({
      command: plan.command,
      args: plan.args,
      cwd: config.cwd || undefined,
      spawnImpl,
      waitMs: deps.elevatedWaitMs ?? 8000,
    }).catch((error) => ({ failed: true, code: -1, stdout: '', stderr: '', message: String(error?.message ?? error) }))
    const said = String(result.stdout ?? '').trim()
    const complained = String(result.stderr ?? '').trim()
    if (result.failed === true || (typeof result.code === 'number' && result.code !== 0)) {
      const detail = (complained || said || result.message || '').split(/\r?\n/).filter(Boolean).slice(0, 3).join(' / ')
      return {
        ok: false,
        pid: result.pid,
        shimFile,
        logFile,
        reason: `启动命令没发出去（powershell 退出码 ${result.code}）${detail ? `：${detail}` : '，没有任何错误输出'}。`
          + '请用**管理员身份**重开控制台，或手动右键"以管理员身份运行" launcher.bat。',
      }
    }
    const ran = await waitForShimRan(logFile, since, deps.shimWaitMs ?? 8000)
    // 实话实说：本机策略是"提权不提示"（ConsentPromptBehaviorAdmin=0），看不到 UAC 弹窗是正常的，
    // 界面**不能**再让用户去点一个根本不会出现的窗口（旧文案就是这么写的）。
    // 到底走的哪条分支由命令自己打的 QAI-ELEVATED / QAI-RUNAS 决定。
    const branch = said.includes('QAI-ELEVATED') ? '当前控制台已是管理员，走 WMI 直接执行' : '已按提权方式拉起'
    const noDialog = '本机策略是提权不提示，看不到 UAC 弹窗是正常的'
    if (ran !== true) {
      return {
        ok: false,
        pid: result.pid,
        shimRan: false,
        shimFile,
        logFile,
        reason: `启动命令已发出（${branch}；${noDialog}），但**启动脚本没有留下心跳**（垫片 ${shimFile}，日志 ${logFile}）——`
          + '说明提权那一跳被系统拦下了，这次点击什么都没发生。'
          + '请用**管理员身份**重开控制台（或手动右键"以管理员身份运行" launcher.bat）后再试。',
      }
    }
    return {
      ok: true,
      pid: result.pid,
      shimRan: true,
      shimFile,
      logFile,
      reason: `已请求提权启动 NapCat（${String(chosen.path).split(/[\\/]/).pop()}）：垫片已执行（${branch}，日志：${logFile}）。`
        + '等几秒扫码窗口就会出现；二维码也会显示在控制台/面板里'
        + (chosen.switched ? `。注意：${chosen.reason}` : ''),
    }
  }

  async function startNapcat() {
    // 先用共享的挑选逻辑：配置里常常写的是 napcat.bat（这版只是拉起加载器 + pause，实测秒退），
    // 同目录的 launcher.bat 才是真正干活的（设 NAPCAT_* 环境变量、从注册表找 QQ.exe）。
    const chosen = resolveNapcatLauncher(config.napcatBat, { exists: (file) => fileExists(file, deps) })
    if (chosen.ok !== true) return { ok: false, reason: chosen.reason }
    // **必须把垫片路径与日志路径传进去**（原来一个都没传 ⇒ 每次点击都只会回一句
    // "缺少垫片脚本路径（shimFile）"，用户拿着这个名字在安装目录里翻是翻不到的，见 issue #2）。
    const planned = napcatLaunchCommand(chosen.path, { shimFile: napcatShimFile(), logFile: napcatLogFile(), qrFile: config.napcatQr ?? '' })
    if (planned.ok !== true) return { ok: false, reason: planned.reason }
    return runNapcatPlan({ plan: planned, chosen })
  }

  /**
   * 重启登录流程：结束 NapCat 加载器（连同其子进程）后重新走启动脚本。
   *
   * 护栏（按审查结论收紧，旧版按镜像名杀 QQ 会误杀用户自己的 QQ）：
   * 1. 启动脚本必须存在（否则"先杀后启失败"，什么都不剩）；
   * 2. **必须拿到加载器 PID**：拿不到就拒绝，绝不退回按进程名杀；
   * 3. 6099 只当提示，不作放行依据（别的程序也可能占用它）；
   * 4. 只对这些 PID 用 taskkill /T，个人 QQ 客户端不在名单里、也不会被按名杀掉。
   */
  async function restartNapcatLogin() {
    const chosen = resolveNapcatLauncher(config.napcatBat, { exists: (file) => fileExists(file, deps) })
    if (chosen.ok !== true) {
      return { ok: false, reason: chosen.reason.includes('不存在') ? `${chosen.reason}（先杀后启会什么都起不来，已拒绝）` : chosen.reason }
    }
    let loaders = []
    try {
      const snapshot = await status()
      loaders = (snapshot.processes?.napcatLoaders ?? []).filter((entry) => entry && Number.isFinite(entry.pid) && entry.pid > 0)
    } catch (error) {
      return { ok: false, reason: `无法确认 NapCat 状态，拒绝重启（避免误杀你自己的 QQ）：${error.message}` }
    }
    if (loaders.length === 0) {
      return {
        ok: false,
        reason: `没有检测到 NapCat 加载器进程（${NAPCAT_LOADER_NAMES.join(' / ')}），拒绝执行：按进程名杀 QQ 会连你自己开的 QQ 一起杀掉。请改用「启动 NapCat」，或在任务管理器里结束 NapCatWinBootMain.exe 后再启动`,
      }
    }
    const plan = napcatRestartCommand(chosen.path, loaders.map((entry) => entry.pid), {
      shimFile: napcatShimFile(), logFile: napcatLogFile(), qrFile: config.napcatQr ?? '',
    })
    if (plan.ok !== true) return { ok: false, reason: plan.reason }
    // 与「启动 NapCat」同一条路：写垫片 → 提权执行 → 等心跳（这里原来也漏了 shimFile）。
    const outcome = await runNapcatPlan({ plan, chosen })
    if (outcome.ok !== true) return outcome
    const names = loaders.map((entry) => `${entry.name ?? 'napcat'}#${entry.pid}`).join('、')
    return { ...outcome, reason: `${outcome.reason}；本次只结束了 ${names}（连同其子进程），不会碰你自己的 QQ` }
  }

  /**
   * 登录二维码：控制台直接画出图片，并说清"这张码是几秒前生成的"。
   * 为什么要显示新鲜度：NapCat 只在 QQ 侧产出新码时镜像一次，过期后文件就不再变化，
   * 光看"文件存在"会误以为还能扫（实测：文件是 8 分钟前的旧码）。
   */
  function qr({ maxBytes = 512 * 1024 } = {}) {
    const file = config.napcatQr ?? ''
    const info = qrStatus(file, now(), deps.stat ? { stat: deps.stat } : undefined)
    const base = { ...info, path: file, staleSeconds: QR_STALE_SECONDS }
    if (!info.exists) {
      return {
        ok: true,
        ...base,
        dataUrl: '',
        hint: info.error
          ? `读取二维码文件失败（${info.error}）——不是"没有二维码"，请检查文件是否被占用/权限`
          : '还没有二维码文件：NapCat 没在运行，或还没走到登录界面',
      }
    }
    try {
      // 先看大小再读：坏掉/超大的文件不该被整块读进内存（这也是审计里补的一刀）。
      const size = (deps.stat ? deps.stat(file) : statSync(file)).size
      if (Number.isFinite(size) && size > maxBytes) {
        return { ok: true, ...base, dataUrl: '', hint: `二维码文件过大（${Math.round(size / 1024)} KB），请在文件管理器里打开：${file}` }
      }
      const buffer = (deps.readFile ?? readFileSync)(file)
      if (buffer.length > maxBytes) {
        return { ok: true, ...base, dataUrl: '', hint: `二维码文件过大（${Math.round(buffer.length / 1024)} KB），请在文件管理器里打开：${file}` }
      }
      // 只认真正的 PNG（8 字节魔数）；否则把任意文件当图片回给前端（审查提的 O2）。
      const isPng = buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
      if (!isPng) {
        return { ok: true, ...base, dataUrl: '', hint: `这个文件不是 PNG 图片（${file}），请确认 napcatQr 配置指向二维码文件` }
      }
      const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`
      const hint = info.ageSeconds > QR_STALE_SECONDS
        ? `这张二维码是 ${Math.round(info.ageSeconds / 60)} 分钟前生成的，已经过期——扫之前请先点「重启登录流程」`
        : `这张二维码是 ${info.ageSeconds} 秒前生成的，请尽快扫（QQ 的码约 1～2 分钟失效）`
      return { ok: true, ...base, dataUrl, hint }
    } catch (error) {
      return { ok: true, ...base, dataUrl: '', hint: `读取二维码失败：${error.message}` }
    }
  }

  async function stopNapcat() {
    const snapshot = await inspectNow()
    const targets = new Map()
    // 只结束 NapCat 加载器（taskkill /T 会连带它启动的 QQ 子进程）；
    // 个人 QQ 客户端（没有 NapCat 加载器时的 QQ.exe）绝不触碰。
    for (const entry of snapshot.processes.napcatLoaders ?? []) targets.set(entry.pid, entry.name)
    const napcatPort = portRow(snapshot, 'napcat')
    // 6099 在听**不等于**那就是 NapCat：别的程序也可能占用它（审查复现过 nginx 占用 6099）。
    // 所以只有进程名落在 NapCat 加载器名单里才把它算作目标，否则只提示、不动手。
    if (napcatPort?.listening && napcatPort.pid && NAPCAT_LOADER_NAMES.includes(String(napcatPort.process ?? '').toLowerCase())) {
      targets.set(napcatPort.pid, napcatPort.process)
    }
    if (targets.size === 0) {
      const personal = (snapshot.processes.qqClients ?? []).length
      return {
        ok: false,
        reason: personal > 0
          ? `未检测到 NapCat 加载器；当前 ${personal} 个 QQ 客户端属于个人版，控制台不会结束它们`
          : '没有检测到 NapCat 进程',
      }
    }
    const done = []
    for (const [pid, name] of targets) {
      const guard = assertKillAllowed(pid, { snapshot, ports: config.ports })
      if (!guard.ok) continue
      const result = await killTree(pid, { exec })
      if (result.ok) done.push(`${name || 'napcat'}#${pid}`)
    }
    return { ok: done.length > 0, reason: done.length > 0 ? `已结束 NapCat（含其 QQ 子进程）：${done.join('、')}` : '没有可结束的进程' }
  }

  async function startTts() {
    if (!config.ttsBat) return { ok: false, reason: '未配置 GPT-SoVITS 启动脚本（ttsBat）' }
    if (!fileExists(config.ttsBat, deps)) return { ok: false, reason: `启动脚本不存在：${config.ttsBat}` }
    try {
      const { pid } = startDetached({
        command: 'cmd.exe',
        args: ['/c', 'start', '', config.ttsBat],
        cwd: config.cwd || undefined,
        spawnImpl,
      })
      return { ok: true, pid, reason: '已请求启动 GPT-SoVITS' }
    } catch (error) {
      return { ok: false, reason: `启动失败：${error.message}` }
    }
  }

  async function stopTts() {
    const snapshot = await inspectNow()
    const row = portRow(snapshot, 'tts')
    if (!row?.listening) return { ok: false, reason: 'GPT-SoVITS 未在运行（9880 无监听）' }
    // 只杀占用 9880 的那个进程，绝不动其它 python。
    const result = await freePort('tts')
    return result
  }

  async function stopAll() {
    const results = []
    for (const [label, action] of [['宿主', stopHost], ['NapCat', stopNapcat], ['GPT-SoVITS', stopTts]]) {
      try {
        const result = await action()
        results.push(`${label}：${result.ok ? '已停止' : result.reason}`)
      } catch (error) {
        results.push(`${label}：异常 ${error.message}`)
      }
    }
    return { ok: true, reason: results.join('；') }
  }

  // ------------------------------------------------------------ debugging ----

  /** Recent trace events (the bridge's decision stream), filtered. */
  function traceEvents(options = {}) {
    const events = readTraceFile(config.logs?.trace ?? '', { readFile: deps.readFile })
    return filterEvents(events, { limit: options.limit ?? 300, chatKey: options.chatKey ?? '', level: options.level ?? '', stage: options.stage ?? '', traceId: options.traceId ?? '', ok: options.ok ?? null })
  }

  /** Full decision chain for one trace id. */
  function traceChain(traceId, { limit = 500 } = {}) {
    const events = readTraceFile(config.logs?.trace ?? '', { readFile: deps.readFile })
    const filtered = events.filter((event) => event.id === traceId).slice(-limit)
    const chain = groupChains(filtered)[0] ?? null
    return chain ? { ...chain, timeline: formatChain(chain) } : null
  }

  /** Latest runtime snapshot written by the bridge plugin. */
  function runtime() {
    const data = readRuntime(config.logs?.runtime ?? '', { readFile: deps.readFile })
    if (!data) return null
    return {
      updatedAt: data.updatedAt,
      ageSeconds: Math.round((now() - (data.updatedAt ?? 0)) / 1000),
      pid: data.pid,
      version: data.version,
      uptimeSeconds: data.uptimeSeconds,
      sessions: data.sessions ?? [],
      sessionCount: data.sessionCount ?? 0,
      reminders: data.reminders ?? 0,
      votes: data.votes ?? 0,
      games: data.games ?? 0,
      joinsPending: data.joinsPending ?? 0,
      features: data.features ?? {},
      // 离线回放要用线上真实的决策配置（白名单等），随快照一起带出去
      replayHints: data.replay ?? null,
      inbox: data.inbox ?? null,
      injection: data.injection ?? null,
      // 桥写出的定时任务/自愈/webhook 描述性字段（v0.5.5「控制台看得见」用；绝无密钥）
      jobs: data.jobs ?? null,
      // 桥写出的**生效**归档目录（插件的 historyArchiveDir 住在 profile 里，控制台读不到）
      archive: data.archive ?? null,
      gate: data.gate ?? {},
      trace: data.trace ?? {},
    }
  }

  /** One-click diagnosis (the automated "why is it silent" checklist). */
  async function diagnose(force = false) {
    const nowMs = now()
    // 体检要跑 netstat+tasklist：5 秒内复用同一份，避免面板与验收台同时刷新时重复扫进程
    if (!force && diagnoseCache && nowMs - diagnoseCache.at < 5000) return diagnoseCache.value
    const snapshot = await inspectNow()
    const events = traceEvents({ limit: 400 })
    const report = runDiagnose({
      config: { ...config, auditLog: config.logs?.audit ?? '' },
      snapshot,
      runtime: runtime(),
      events,
      now: now(),
      files: deps,
    })
    const value = { ok: report.summary.blockers === 0, report, text: formatDiagnose(report) }
    diagnoseCache = { at: nowMs, value }
    return value
  }

  /**
   * Diagnostic bundle: logs + effective config + snapshot + diagnosis, as a zip.
   *
   * `redact: true` 走"分享安全"通路：QQ 号按位掩码、消息原文只留长度——因为这些
   * 文件（事件流/录制/日志）天然含用户数据，而这个包的使用场景就是发给别人。
   */
  async function exportBundle({ redact = false } = {}) {
    const diagnosis = await diagnose()
    const entries = []
    const take = (file, name, tailBytes) => {
      const entry = fileEntry(file, { name, tailBytes, readFile: deps.readFile ?? readFileSync, stat: deps.stat ?? statSync })
      if (!entry) return
      entries.push(redact ? { ...entry, data: redactByKind(entry.name, String(entry.data)) } : entry)
    }
    take(config.logs?.trace, 'qq-trace.jsonl', 1024 * 1024)
    take(config.logs?.audit, 'qq-actions.log', 256 * 1024)
    take(config.logs?.bridge, 'qq-bridge-debug.log', 256 * 1024)
    take(config.logs?.hostOut, 'qq-host-out.log', 128 * 1024)
    take(config.logs?.hostErr, 'qq-host-err.log', 128 * 1024)
    take(config.logs?.runtime, 'qq-runtime.json')
    entries.push({ name: 'diagnose.json', data: JSON.stringify(redact ? redactByKind('x.json', JSON.stringify(diagnosis.report, null, 2)) : diagnosis.report, null, 2) })
    entries.push({ name: 'diagnose.txt', data: redact ? redactByKind('x.log', diagnosis.text) : diagnosis.text })
    const environment = {
      generatedAt: new Date(now()).toISOString(),
      controlConfig: publicConfig(config),
      ports: (await inspectNow()).ports,
      runtime: runtime(),
      traceSummary: summarizeEvents(traceEvents({ limit: 2000 })),
    }
    entries.push({ name: 'environment.json', data: JSON.stringify(redact ? JSON.parse(redactByKind('x.json', JSON.stringify(environment))) : environment, null, 2) })
    if (redact) entries.push({ name: 'REDACTED.json', data: JSON.stringify(redactionNote(), null, 2) })
    const buffer = buildZip(entries, { now: new Date(now()) })
    lastExportSummary = {
      at: now(), entries: entries.length, bytes: buffer.length, redacted: redact,
      filename: `qq-diagnose${redact ? '-redacted' : ''}-${new Date(now()).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`,
    }
    return { ok: true, entries: entries.length, bytes: buffer.length, buffer, filename: lastExportSummary.filename }
  }

  // ------------------------------------------------------------ 验收台 ----

  /** 体检包里会收集的产物（验收台据它判断"可导出"）。 */
  function exportSources() {
    return [
      { name: '事件流', file: config.logs?.trace },
      { name: '写操作审计', file: config.logs?.audit },
      { name: '桥调试日志', file: config.logs?.bridge },
      { name: '宿主 stdout', file: config.logs?.hostOut },
      { name: '运行快照', file: config.logs?.runtime },
    ].map((entry) => ({ name: entry.name, present: Boolean(entry.file) && existsSync(entry.file) }))
  }

  /** 回放沙箱数量（`qq-replay/run-*`，不含回收站）。 */
  function sandboxCount() {
    if (!config.cwd) return 0
    try {
      return readdirSync(join(config.cwd, 'qq-replay'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== '_trash').length
    } catch {
      return 0
    }
  }

  /**
   * v0.4「一切皆可调试」6 条硬约束的实时验收：每条都用**现有产物**算证据，
   * 不达标时直接说明该点哪里。
   */
  async function acceptance({ diagnosis = null } = {}) {
    const report = buildAcceptance({
      events: traceEvents({ limit: 500 }),
      runtime: runtime(),
      inbox: inboxList({ limit: 1 }),
      lastReplay: lastReplaySummary,
      lastExport: lastExportSummary,
      // 调用方已经跑过体检时直接复用（体检要扫 netstat/tasklist，重复跑纯属浪费）；
      // 注意这里要的是 diagnose() 的**整包**（{ ok, report, text }），evaluateDiagnose 读的是 .report
      diagnosis: diagnosis ?? await diagnose(),
      exportSources: exportSources(),
      sandboxCount: sandboxCount(),
      now: now(),
    })
    return { ok: report.ok, report, text: formatAcceptance(report), verdict: report.verdict, totals: report.totals }
  }

  /**
   * 一键体检报告（独立页面 `/report` 的数据源）：一次体检 + 一次验收 → 一份报告。
   *
   * `force` 会绕过 5 秒体检缓存（页面上的「重新体检」按钮就该真的重新扫一遍端口与进程，
   * 否则用户点完看到的还是旧读数，会以为按钮坏了）。
   */
  async function healthReport({ force = false } = {}) {
    const diagnosis = await diagnose(force)
    const accepted = await acceptance({ diagnosis })
    const report = buildHealthReport({
      diagnosis: diagnosis.report,
      acceptance: accepted.report,
      runtime: runtime(),
      generatedAt: now(),
    })
    return { ok: report.ok, report, text: formatHealthReport(report) }
  }

  // ---------------------------------------------------- 设置项变更历史 ----
  /**
   * 会写"设置文件"的入口只有一个包装（在 server 的 POST 分发里）：动作前后各拍一份快照，
   * 这里负责 diff + 落盘。为什么盯文件而不是盯接口参数：接口会加/改，文件不会 ——
   * 只要写到了 `qq-control.json` / `webui.json` / `onebot11_<uin>.json`，历史就一定能记到。
   */
  // 历史文件的位置**在启动时就钉死**：不然"把工作目录改到 D 盘"这条记录会被写进新目录，
  // 旧目录里的历史看起来凭空消失（而它恰恰是说明"目录为什么变了"的那一条）。
  const settingsHistoryRoot = config.cwd || process.cwd()
  const settingsHistoryFile = () => join(settingsHistoryRoot, 'qq-settings-history.jsonl')

  /** 允许进历史的设置文件（control 配置 + NapCat 的账号/网络/WebUI 配置）。 */
  function watchedSettingsFiles() {
    const files = []
    if (typeof deps.configFile === 'string' && deps.configFile.trim() !== '') {
      files.push({ name: 'qq-control.json', file: deps.configFile })
    }
    const dir = napcatConfigDir({ napcatBat: config.napcatBat ?? '' })
    if (dir !== '' && existsSync(dir)) {
      let names = []
      try { names = readdirSync(dir).filter((name) => /^(webui|onebot11_\d+|napcat_\d+)\.json$/.test(name)).sort() } catch { names = [] }
      for (const name of names) files.push({ name, file: join(dir, name) })
    }
    return files
  }

  function readSettingsJson(file) {
    if (existsSync(file) !== true) return { exists: false, data: null, unreadable: false }
    try {
      return { exists: true, data: JSON.parse((deps.readFile ?? readFileSync)(file, 'utf8')), unreadable: false }
    } catch {
      return { exists: true, data: null, unreadable: true }
    }
  }

  /** 拍一份设置文件快照（键名/大小都受控，webui.json 里的 token 只在内存里，落盘前会脱敏）。 */
  function settingsSnapshot() {
    return {
      at: now(),
      files: watchedSettingsFiles().map(({ name, file }) => ({ name, file, ...readSettingsJson(file) })),
    }
  }

  /** 动作后调用：有变化才写一行；没有变化返回 recorded:false（不写空行）。 */
  function recordSettingsChange({ source = '', route = '', ok = true, reason = '', before = null, after = null } = {}) {
    const entry = buildHistoryEntry({ at: now(), source, route, ok, reason, before, after })
    if (!entry) return { ok: true, recorded: false }
    const written = appendCappedLine(settingsHistoryFile(), JSON.stringify(entry), { maxBytes: 256 * 1024, keepBytes: 64 * 1024 })
    return { ok: written, recorded: written, entry }
  }

  /** 页面用：最近 N 条（新的在前），可按关键词过滤。 */
  function settingsHistory({ limit = 100, q = '', source = '' } = {}) {
    const file = settingsHistoryFile()
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { text = '' }
    const all = parseHistory(text)
    const entries = filterHistory(all, { q, source, limit: Math.min(500, Math.max(1, Number(limit) || 100)) })
    return { ok: true, file, total: all.length, entries, text: formatHistory(entries) }
  }

  // -------------------------------------------------------- 语音调试代理 ----
  /**
   * 语音调试必须走宿主：`speechToText` 服务与 TTS 密钥都只存在于宿主进程里。
   *
   * 宿主地址有两条来源，按顺序试：
   *   ① `qq-host-out.log` 里带 token 的地址 —— 控制台启动的宿主；
   *   ② 从本机监听端口里认出 DSH 宿主 —— 桌面端自己起的宿主（端口每次可能不同），
   *      插件路由本身不要 token，所以猜到的地址也能用。
   * 两条都失败时把"到底卡在哪"说清楚（找不到宿主 / 宿主是旧版没这个接口 / 连不上）。
   */
  function hostConsoleUrl() {
    let text = ''
    try { text = (deps.readFile ?? readFileSync)(config.logs?.hostOut ?? '', 'utf8') } catch { text = '' }
    return extractHostUrl(text)
  }

  /** 宿主进程的候选端口（缓存 20 秒）：按高位优先，排除控制台自己盯的那些端口。 */
  let hostPortCache = { at: 0, ports: [] }
  async function guessHostPorts() {
    if (now() - hostPortCache.at < 20_000) return hostPortCache.ports
    let ports = []
    try {
      const [netstat, tasklist] = await Promise.all([
        run('netstat', ['-ano'], { exec: deps.exec }),
        run('tasklist', ['/FO', 'CSV', '/NH'], { exec: deps.exec }),
      ])
      const watched = new Set(Object.values(config.ports ?? {}).map((port) => Number(port)))
      const tasks = parseTasklist(tasklist.stdout)
      ports = [...new Set(parseNetstat(netstat.stdout)
        .filter((row) => row.state === 'LISTENING')
        .filter((row) => HOST_PROCESS_HINT.test(tasks.get(row.pid) ?? ''))
        .filter((row) => row.localPort >= 1024 && !watched.has(Number(row.localPort)))
        .map((row) => Number(row.localPort)))]
        .sort((a, b) => b - a)
        .slice(0, 6)
    } catch { ports = [] }
    hostPortCache = { at: now(), ports }
    return ports
  }

  /** 候选宿主：带 token 的日志地址优先，然后是按端口猜到的（新起的在前）。 */
  async function hostCandidates() {
    const list = []
    const base = hostConsoleUrl()
    if (base !== '') {
      try {
        const parsed = new URL(base)
        list.push({ origin: `http://${parsed.host}`, token: parsed.searchParams.get('token') ?? '' })
      } catch { /* 坏地址就当没有 */ }
    }
    for (const port of await guessHostPorts()) {
      const origin = `http://127.0.0.1:${port}`
      if (!list.some((item) => item.origin === origin)) list.push({ origin, token: '' })
    }
    return list
  }

  async function voiceCall(path, { method = 'GET', body = null } = {}) {
    const candidates = await hostCandidates()
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: '找不到宿主：日志里没有带 token 的地址（控制台没启动过宿主），也没从监听端口里认出 DSH 宿主；'
          + '先启动（或重启）一次宿主，再回来点「刷新状态」',
      }
    }
    const fetchImpl = deps.fetchImpl ?? fetch
    let last = ''
    for (const candidate of candidates) {
      const query = candidate.token === '' ? '' : `?token=${encodeURIComponent(candidate.token)}`
      const target = `${candidate.origin}${path}${query}`
      try {
        const response = await fetchImpl(target, {
          method,
          headers: body === null ? undefined : { 'content-type': 'application/json' },
          body: body === null ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        })
        if (response.status === 404) {
          last = `宿主在 ${candidate.origin}，但没有 ${path} 接口（插件还是更新前的版本）——重启一次宿主后再试`
          continue
        }
        const data = await response.json().catch(() => null)
        if (data === null) { last = `宿主（${candidate.origin}）返回了非 JSON（HTTP ${response.status}）`; continue }
        return { ...data, host: candidate.origin }
      } catch (error) {
        last = `连不上 ${candidate.origin}：${error?.message ?? error}`
      }
    }
    return { ok: false, reason: last || '调用宿主语音接口失败' }
  }

  async function voiceStatus() { return await voiceCall('/qqai/voice/status') }
  async function voiceTts({ text = '', overrides = null, voice = '', textLang = '' } = {}) {
    const clean = overrides && typeof overrides === 'object' && Array.isArray(overrides) === false ? overrides : {}
    return await voiceCall('/qqai/voice/tts', {
      method: 'POST',
      body: {
        text: String(text ?? '').slice(0, 500),
        overrides: clean,
        ...(String(voice ?? '').trim() === '' ? {} : { voice: String(voice).slice(0, 80) }),
        ...(String(textLang ?? '').trim() === '' ? {} : { textLang: String(textLang).slice(0, 8) }),
      },
    })
  }
  async function voiceStt({ audioBase64 = '', ext = 'webm', language = '', model = '' } = {}) {
    return await voiceCall('/qqai/voice/stt', {
      method: 'POST',
      body: {
        audioBase64: String(audioBase64 ?? ''),
        ext: String(ext ?? 'webm'),
        language: String(language ?? '').slice(0, 16),
        model: String(model ?? '').slice(0, 80),
      },
    })
  }

  // -------------------------------------------------- 录制 / 回放 / 注入 ----

  const inboxFile = () => config.logs?.inbox || (config.cwd ? join(config.cwd, 'qq-inbox.jsonl') : '')
  const injectFile = () => config.logs?.inject || (config.cwd ? join(config.cwd, 'qq-inject.jsonl') : '')
  const trashDir = () => (config.cwd ? join(config.cwd, 'qq-trash') : '')

  /** Recently recorded inbound frames (what the bridge actually received). */
  function inboxList({ limit = 50 } = {}) {
    const file = inboxFile()
    const present = Boolean(file) && existsSync(file)
    const all = present ? readInbox(file, { limit: 500 }) : []
    const capped = all.slice(-Math.min(500, Math.max(1, Number(limit) || 50)))
    return {
      file,
      exists: present,
      recorded: all.length,
      queued: countLines(injectFile()),
      entries: capped.map((entry, index) => ({
        index: all.length - capped.length + index,
        ts: entry.ts,
        at: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
        kind: entry.kind,
        text: describeFrame(entry),
        messageId: entry.frame?.messageId ?? '',
        chatKey: entry.frame?.groupId ? `g:${entry.frame.groupId}` : (entry.frame?.userId ? `u:${entry.frame.userId}` : ''),
        frame: entry.frame,
      })),
    }
  }

  /** Offline dry-run replay of recorded (or hand-made) frames. */
  async function replay({ entries = null, indices = null, limit = 5, replyText = '', overrides = {}, budgetMs = 20000 } = {}) {
    const list = Array.isArray(entries) && entries.length > 0 ? entries : selectEntries(indices, limit)
    if (list.length === 0) return { ok: false, reason: '没有可回放的记录（qq-inbox.jsonl 为空或未启用录制）' }
    const replayer = replayerFor()
    const hints = runtime()?.replayHints ?? null
    let report
    try {
      report = await replayer.run({ entries: list, replyText, overrides, hints, budgetMs, maxEntries: 20 })
    } catch (error) {
      return { ok: false, reason: `回放执行失败：${error.message}` }
    }
    lastReplaySummary = {
      at: now(),
      ok: report.ok,
      reason: report.reason ?? '',
      durationMs: report.durationMs,
      totals: report.totals,
      safety: report.safety,
      sandbox: report.sandbox,
      entries: (report.results ?? []).length,
    }
    return { ok: report.ok, reason: report.ok ? '' : (report.reason ?? '回放中有条目出错'), report, text: report.text, totals: report.totals, warnings: report.warnings, sandbox: report.sandbox }
  }

  function selectEntries(indices, limit) {
    const all = inboxList({ limit: 500 }).entries
    if (!all.length) return []
    if (Array.isArray(indices) && indices.length > 0) {
      const wanted = new Set(indices.map((index) => Number(index)).filter((index) => Number.isInteger(index) && index >= 0))
      return all.filter((item) => wanted.has(item.index)).slice(0, 20)
    }
    return all.slice(-Math.min(20, Math.max(1, Number(limit) || 5)))
  }

  function replayerFor() {
    if (!replayer) {
      replayer = createReplayer({
        pluginRoot: config.pluginRoot || defaultPluginRoot(),
        sourceCwd: config.cwd || '',
        botQq: runtime()?.replayHints?.botQq ?? 0,
        logger: deps.logger ?? console,
        deps,
      })
    }
    return replayer
  }

  /**
   * Queue one synthetic frame for the live bridge's injector. The line is validated
   * with the exact same parser the bridge uses, so a bad spec is rejected here with
   * a Chinese reason instead of silently doing nothing later.
   */
  function inject(spec = {}) {
    const file = injectFile()
    if (!file) return { ok: false, reason: '未配置注入文件路径（控制台配置缺少 cwd）' }
    const botQq = runtime()?.replayHints?.botQq ?? 0
    let parsed
    try {
      parsed = parseInjectionLine(JSON.stringify(spec), { botQq })
    } catch (error) {
      return { ok: false, reason: `注入参数不合法：${error.message}` }
    }
    const run = runtime()
    if (run && run.injection && run.injection.enabled === false) {
      // 不静默失败：通道没开就直说，并给出该改哪个开关。
      return { ok: false, reason: '桥的注入通道当前未开启（需在插件配置里打开 injectEnabled=true 并重启宿主）', parsed: parsed.frame }
    }
    const line = JSON.stringify({ ...spec, __queuedAt: Date.now() })
    if (!appendCappedLine(file, line, { maxBytes: 1024 * 1024, keepBytes: 128 * 1024 })) {
      return { ok: false, reason: `写入注入文件失败：${file}` }
    }
    return {
      ok: true,
      reason: `已入队（桥每 ${run?.injection?.intervalMs ?? 2000}ms 轮询一次，dry-run=${run?.injection?.dryRun !== false ? '开' : '关'}）`,
      file,
      preview: describeFrame({ kind: parsed.kind, frame: parsed.frame }),
      dryRun: run?.injection?.dryRun !== false,
    }
  }

  /** Clear the injection queue (moved to the local trash, never deleted). */
  function clearQueue() {
    const file = injectFile()
    if (!file || !existsSync(file)) return { ok: false, reason: '注入队列本来就是空的' }
    const moved = moveToTrash(file, trashDir())
    return moved
      ? { ok: true, reason: `注入队列已移入回收站：${moved}` }
      : { ok: false, reason: `无法移动 ${file}（可能被占用，已保持原样）` }
  }

  /**
   * 历史归档目录。优先级：运行快照里桥自己写出的生效目录 > 控制台配置的显式覆盖 > <cwd>/qq-history。
   * 为什么先看快照：`historyArchiveDir` 是**插件**的配置键，住在 profile 的 cordis.patch.yml 里，
   * 控制台进程读不到；只看控制台配置就会在用户自定义目录时显示 0 个文件还自称"群里 /找 用的就是它"。
   */
  function archiveDir() {
    const fromRuntime = runtime()?.archive
    if (fromRuntime && typeof fromRuntime.dir === 'string' && fromRuntime.dir.trim() !== '') return fromRuntime.dir
    const candidate = typeof config.historyArchiveDir === 'string' && config.historyArchiveDir.trim() !== ''
      ? config.historyArchiveDir
      // 兼容早期控制台里可能写过的旧键（插件 schema 里没有 historyDir，仅作回落）
      : (typeof config.historyDir === 'string' && config.historyDir.trim() !== '' ? config.historyDir : '')
    return candidate || join(config.cwd || process.cwd(), 'qq-history')
  }

  /** 「群资产」页：归档概览（文件数/体积/最早最新/回收目录）。只读本机文件，不碰宿主进程。 */
  function archiveStats() {
    const dir = archiveDir()
    try {
      const archive = new HistoryArchive({ dir })
      const stats = archive.stats()
      let trashDirs = []
      try {
        const trashRoot = join(config.cwd || process.cwd(), 'qq-trash')
        trashDirs = existsSync(trashRoot) ? readdirSync(trashRoot).sort().slice(-7) : []
      } catch { /* 回收目录不可读就当没有 */ }
      return { ok: true, ...stats, dir, exists: existsSync(dir), trashDirs }
    } catch (error) {
      return { ok: false, reason: `读取归档失败：${error.message}`, dir }
    }
  }

  /**
   * 归档检索：刻意复用插件同一套 HistoryArchive，控制台里搜出来的口径与群里 `/找` 完全一致。
   */
  function archiveSearch(query, { days = 7, limit = 20, chatKey = '' } = {}) {
    const keyword = String(query ?? '').trim()
    if (keyword === '') return { ok: false, reason: '请给出关键词' }
    try {
      const archive = new HistoryArchive({ dir: archiveDir() })
      const result = archive.search(keyword, { days, limit, chatKey })
      return { ok: true, query: keyword, days, limit, chatKey, ...result }
    } catch (error) {
      return { ok: false, reason: `检索失败：${error.message}` }
    }
  }

  /**
   * 「性能」面板（v0.5.5）：把 trace 事件喂给纯计算模块 control/lib/perf.mjs，
   * 得到 P50/P95 端到端延迟、阶段耗时画像与失败画像。控制台自己不做统计口径的二次发明。
   */
  function perf({ limit = 5000, chatKey = '', windowMinutes = 0 } = {}) {
    const events = readTraceFile(config.logs?.trace ?? '', { readFile: deps.readFile })
    const cutoff = windowMinutes > 0 ? now() - windowMinutes * 60_000 : 0
    const scoped = cutoff > 0 ? events.filter((event) => Number(event?.ts) >= cutoff) : events
    const capped = scoped.slice(-Math.max(100, Math.min(20000, Number(limit) || 5000)))
    return { ok: true, ...perfReport(capped, { chatKey, now: now() }), windowMinutes }
  }

  /** 「定时任务」面板：播报任务 / webhook 来源 / 掉线自愈 / 注入队列。 */
  function jobsView() {
    return { ok: true, ...jobsReport(runtime(), { now: now() }) }
  }

  /** 「群配置」面板：每个群的生效开关 + 白名单 + 最近回合 + 挂在该群上的定时任务。 */
  function groups() {
    return { ok: true, ...groupsReport(runtime(), { now: now() }) }
  }

  /**
   * NapCat WebUI 的**带 token** 地址（v0.5.9）。
   *
   * 为什么需要它：控制台「QQ助手账号」原来指向 `http://127.0.0.1:6099`，而 NapCat 的 WebUI
   * 自己也要 token（存在 `bootmain/config/webui.json`）——不带 token 点进去只会看到
   * 「token 无效」。这里按 `napcatQr` 推出同一份配置目录去读它。
   *
   * 安全口径：token **只在这次响应里返回**，不写进运行快照、不进诊断包、不落日志；
   * 接口本身与控制台其它接口一样受 token + 同源校验保护。
   */
  function napcatWebui() {
    const qr = String(config.napcatQr ?? '')
    if (qr === '') return { ok: false, url: '', reason: '未配置 NapCat 二维码路径（napcatQr），无法定位 webui.json' }
    // 路径必须是**绝对路径且至少三层**（…/bootmain/cache/qrcode.png）：否则 `qrcode.png`
    // 这种相对路径会被 dirname 两次算到别处去，读出不相干文件的 token（审查提的 P3）。
    const dir = dirname(dirname(qr))
    const segments = dir.split(/[\\/]/).filter(Boolean)
    if (!isAbsolute(qr) || segments.length < 2) {
      return { ok: false, url: '', reason: `napcatQr 不是可用的绝对路径（${qr}），无法定位 bootmain/config/webui.json` }
    }
    const file = join(dir, 'config', 'webui.json')
    let parsed = null
    try {
      parsed = JSON.parse((deps.readFile ?? readFileSync)(file, 'utf8'))
    } catch (error) {
      return { ok: false, url: '', reason: `读不到 NapCat WebUI 配置（${file}）：${error.code ?? error.message}` }
    }
    const token = String(parsed?.token ?? '').trim()
    // 端口以 webui.json 里的为准（用户在 NapCat 里改过端口时 config.ports 会过时）。
    const port = Number(parsed?.port) || Number(config.ports?.napcat) || 6099
    // `/webui/` **带尾斜杠**、token 走 `?token=`：这是 NapCat 4.18.28 前端实测的形状
    // （`static/assets/web_login-iVdMgBJV.js` 读 `location.search` 的 token 后自动登录）。
    // 不写尾斜杠会先吃一个 301 才到同一处；`/webui/?token=` 是插件面板与这里共用的写法。
    if (token === '') return { ok: false, url: `http://127.0.0.1:${port}/webui/`, reason: 'webui.json 里没有 token（可能未启用鉴权）' }
    return { ok: true, url: `http://127.0.0.1:${port}/webui/?token=${encodeURIComponent(token)}`, reason: '' }
  }

  return {
    status, startHost, stopHost, freePort, startNapcat, stopNapcat, startTts, stopTts, stopAll,
    restartNapcatLogin, qr, napcatWebui,
    napcatQrFile: () => config.napcatQr ?? '',
    traceStats,
    // v0.7.11：账号中心（本地网站）。每次调用都重读 webui.json —— 用户可能刚在别处改过 token/端口。
    accounts: createAccountsApi({ napcatBat: config.napcatBat }),
    traceEvents, traceChain, runtime, diagnose, exportBundle, acceptance, healthReport,
    settingsSnapshot, recordSettingsChange, settingsHistory,
    voiceStatus, voiceTts, voiceStt,
    inboxList, replay, inject, clearQueue, archiveStats, archiveSearch,
    perf, jobsView, groups,
    // 每个调用方（每个 SSE 连接）拿一份独立 tailer：共用模块级单例会让两个面板互相"偷"事件，
    // 也会让同一进程里的第二个 supervisor 读到别人的事件文件。
    tailer: () => createTraceTailer(config.logs?.trace ?? ''),
    logFile: (name) => {
      if (name === 'trace') return config.logs?.trace ?? ''
      if (name === 'runtime') return config.logs?.runtime ?? ''
      if (name === 'audit') return config.logs?.audit ?? ''
      return config.logs?.[name] ?? ''
    },
  }
}
