/**
 * Supervision primitives for the standalone QQ bot console.
 *
 * Every function is pure or takes its side effects by injection (`exec`, `spawn`,
 * `readFile`, `now`) so the whole layer is unit-testable without touching the
 * real machine, and the console can never invent a target it was not configured
 * to touch (see `assertKillAllowed`).
 */
import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs'
import { PORT_LABELS, configWarnings } from './config.mjs'

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
    return { exists: true, ageSeconds, fresh: ageSeconds < 300, mtimeMs: info.mtimeMs }
  } catch {
    return { exists: false, ageSeconds: -1, fresh: false, mtimeMs: 0 }
  }
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

  const portRow = (snapshot, name) => (snapshot.ports ?? []).find((item) => item.name === name)

  async function status() {
    const snapshot = await inspectNow()
    const hostLog = tailLines(config.logs?.hostOut, 120, deps).join('\n')
    return {
      ...snapshot,
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
    try {
      const { pid } = startDetached({
        command: 'cmd.exe',
        args: ['/c', 'start', '', config.napcatBat],
        cwd: config.cwd || undefined,
        spawnImpl,
      })
      return { ok: true, pid, reason: '已请求启动 NapCat（若窗口未出现，请用管理员身份运行控制台）' }
    } catch (error) {
      return { ok: false, reason: `启动失败：${error.message}` }
    }
  }

  async function stopNapcat() {
    const snapshot = await inspectNow()
    const targets = new Map()
    // 只结束 NapCat 加载器（taskkill /T 会连带它启动的 QQ 子进程）；
    // 个人 QQ 客户端（没有 NapCat 加载器时的 QQ.exe）绝不触碰。
    for (const entry of snapshot.processes.napcatLoaders ?? []) targets.set(entry.pid, entry.name)
    const napcatPort = portRow(snapshot, 'napcat')
    if (napcatPort?.listening && napcatPort.pid) targets.set(napcatPort.pid, napcatPort.process)
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

  return { status, startHost, stopHost, freePort, startNapcat, stopNapcat, startTts, stopTts, stopAll, logFile: (name) => config.logs?.[name] ?? '' }
}
