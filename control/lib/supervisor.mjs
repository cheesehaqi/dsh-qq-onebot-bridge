/**
 * Supervision primitives for the standalone QQ bot console.
 *
 * Every function is pure or takes its side effects by injection (`exec`, `spawn`,
 * `readFile`, `now`) so the whole layer is unit-testable without touching the
 * real machine, and the console can never invent a target it was not configured
 * to touch (see `assertKillAllowed`).
 */
import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PORT_LABELS, configWarnings } from './config.mjs'
import { createTraceTailer, filterEvents, formatChain, groupChains, readRuntime, readTraceFile, summarizeEvents } from './trace.mjs'
import { formatDiagnose, runDiagnose } from './diagnose.mjs'
import { buildZip, fileEntry } from './zip.mjs'
import { createReplayer } from './replay.mjs'
import { buildAcceptance, formatAcceptance } from './acceptance.mjs'
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

/** Parse `tasklist /FO CSV /NH` output into a pid → image-name map. */
export function parseTasklist(text) {
  const map = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cells = line.match(/"([^"]*)"/g)
    if (!cells || cells.length < 2) continue
    const name = cells[0].replace(/"/g, '')
    const pid = Number(cells[1].replace(/"/g, ''))
    if (Number.isFinite(pid)) map.set(pid, name)
  }
  return map
}

/** Combine netstat + tasklist into one row per watched port. */
export function summarizePorts(netstatRows, taskMap, ports, labels = {}) {
  return Object.entries(ports).map(([name, port]) => {
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
 * NapCat 加载器进程名（重启时**只允许**结束这些，以及它们 /T 带出来的子进程）。
 *
 * 为什么不再有 `QQ.exe`：按镜像名杀 QQ 会连**用户自己的 QQ 客户端**一起杀掉
 * （真机上就有 `D:\yingyong(应用）\QQ.exe` 在跑）。加载器的子进程用 `taskkill /PID … /T`
 * 连带结束即可，不需要、也不允许按名字杀 QQ。
 */
export const NAPCAT_LOADER_NAMES = ['napcatwinbootmain.exe', 'napcat.exe', 'napcatshell.exe']

/** PowerShell 单引号字符串转义（路径里有 `'` 时脚本会解析失败，必须成对写）。 */
function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/**
 * 组装「提权启动 NapCat」的命令（纯函数，不执行，便于单测）。
 *
 * 为什么必须提权：NapCat 的 launcher.bat 自己会检查管理员权限，非管理员时它靠
 * `wt.exe` 自提权重启；实测这台机器上那条路会静默失败（启动器秒退、什么都不做），
 * 所以由控制台主动 `-Verb RunAs` 拉起，代价只是用户要点一次 UAC。
 *
 * 为什么用 `call "<path>"` 而不是 `"<path>"`：cmd 有一条众所周知的引号剥离规则——
 * 命令行里恰好两个引号、且引号内不是"存在的可执行文件"时会把首尾引号去掉。
 * 真机验证过：`cmd /c "C:\Program Files (x86)\NapCat\bootmain\napcat.bat"` 会因路径里的
 * 括号被判成「不是可执行文件」而**静默不执行**（而 startDetached 丢弃了输出，界面照样显示成功）。
 * 加 `call` 后引号不会再被剥离。
 */
export function napcatLaunchCommand(bat, { powershell = 'powershell.exe' } = {}) {
  const path = String(bat ?? '').trim()
  if (path === '') return { ok: false, command: '', args: [], reason: '未配置 NapCat 启动脚本（napcatBat）' }
  const inner = `call "${path.replace(/"/g, '')}"`
  const script = `Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c',${psQuote(inner)}) -WorkingDirectory ${psQuote(dirname(path))} -Verb RunAs`
  return { ok: true, command: powershell, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], reason: '' }
}

/**
 * 组装「重启登录流程」的命令：先结束 NapCat 加载器（连同它的子进程），再重新走启动脚本。
 *
 * 三条硬规则（每条都对应一次真机/审查结论）：
 * 1. **按 PID 杀，不按镜像名杀**：`taskkill /IM QQ.exe` 会连用户自己的 QQ 一起杀
 *    （真机上就有非提权的个人 QQ 在跑）；只对加载器 PID 用 `/T /F`，子进程连带结束。
 * 2. **必须拿到加载器 PID**：拿不到就拒绝执行（在 supervisor 那层拦），绝不退回"按名杀"。
 * 3. **清理与启动在同一个提权进程里**：QQ 是提权拉起的，非提权 taskkill 会被拒绝访问，
 *    结果就是"旧的没杀掉又拉一个新的"。
 */
export function napcatRestartCommand(bat, pids, { powershell = 'powershell.exe' } = {}) {
  const path = String(bat ?? '').trim()
  if (path === '') return { ok: false, command: '', args: [], reason: '未配置 NapCat 启动脚本（napcatBat）' }
  const list = (Array.isArray(pids) ? pids : [pids]).map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid) && pid > 0)
  if (list.length === 0) {
    return { ok: false, command: '', args: [], reason: '没有拿到 NapCat 加载器的 PID，拒绝执行（按进程名杀会把你自己开的 QQ 也杀掉）' }
  }
  const kills = list.map((pid) => `taskkill /PID ${pid} /T /F`).join(' & ')
  const inner = `${kills} & timeout /t 3 >nul & call "${path.replace(/"/g, '')}"`
  const script = `Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c',${psQuote(inner)}) -WorkingDirectory ${psQuote(dirname(path))} -Verb RunAs`
  return { ok: true, command: powershell, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], reason: '', pids: list }
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

/** NapCat's own loader/launcher executables (never the personal QQ client). */
export const NAPCAT_LOADER_RE = /napcat/i
/** The QQ client executables (managed only when a NapCat loader is present). */
export const QQ_CLIENT_RE = /^qq(ex)?\.exe$/i

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

  async function startNapcat() {
    if (!config.napcatBat) return { ok: false, reason: '未配置 NapCat 启动脚本（napcatBat）' }
    if (!fileExists(config.napcatBat, deps)) return { ok: false, reason: `NapCat 启动脚本不存在：${config.napcatBat}` }
    const plan = napcatLaunchCommand(config.napcatBat)
    if (plan.ok !== true) return { ok: false, reason: plan.reason }
    try {
      const { pid } = startDetached({ command: plan.command, args: plan.args, cwd: config.cwd || undefined, spawnImpl })
      // 旧实现跑的是 napcat.bat（无参数、不提权），实测秒退什么都不做；提示里把该做的事说清楚。
      return { ok: true, pid, reason: '已请求提权启动 NapCat：请在 UAC 弹窗点「是」，二维码刷新后 2 分钟内扫掉' }
    } catch (error) {
      return { ok: false, reason: `启动失败：${error.message}` }
    }
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
    if (!config.napcatBat) return { ok: false, reason: '未配置 NapCat 启动脚本（napcatBat）' }
    if (!fileExists(config.napcatBat, deps)) return { ok: false, reason: `NapCat 启动脚本不存在：${config.napcatBat}（先杀后启会什么都起不来，已拒绝）` }
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
    const plan = napcatRestartCommand(config.napcatBat, loaders.map((entry) => entry.pid))
    if (plan.ok !== true) return { ok: false, reason: plan.reason }
    try {
      const { pid } = startDetached({ command: plan.command, args: plan.args, cwd: config.cwd || undefined, spawnImpl })
      const names = loaders.map((entry) => `${entry.name ?? 'napcat'}#${entry.pid}`).join('、')
      return { ok: true, pid, reason: `已请求提权重启登录流程：只结束 ${names}（连同其子进程），不会碰你自己的 QQ。UAC 点「是」后等二维码刷新，2 分钟内扫掉` }
    } catch (error) {
      return { ok: false, reason: `重启失败：${error.message}` }
    }
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
  async function acceptance() {
    const report = buildAcceptance({
      events: traceEvents({ limit: 500 }),
      runtime: runtime(),
      inbox: inboxList({ limit: 1 }),
      lastReplay: lastReplaySummary,
      lastExport: lastExportSummary,
      diagnosis: await diagnose(),
      exportSources: exportSources(),
      sandboxCount: sandboxCount(),
      now: now(),
    })
    return { ok: report.ok, report, text: formatAcceptance(report), verdict: report.verdict, totals: report.totals }
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

  return {
    status, startHost, stopHost, freePort, startNapcat, stopNapcat, startTts, stopTts, stopAll,
    restartNapcatLogin, qr,
    traceEvents, traceChain, runtime, diagnose, exportBundle, acceptance,
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
