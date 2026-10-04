/**
 * NapCat 启动 / 重启登录的**纯逻辑**：启动脚本选哪个、命令怎么拼、哪些进程才算加载器。
 *
 * 为什么单独一个模块：控制台（`control/lib/supervisor.mjs`）和 DSH 设置页的「快捷操作」
 * 都要做同一件事，而这里每一条都是真机踩出来的坑，**两边共用一份**才不会各踩一次：
 *   ① 必须**提权**（launcher.bat 自己检查管理员权限，非管理员时它靠 `wt.exe` 自提权，
 *      实测这台机器上那条路会静默失败）；
 *   ② 目标脚本要用 `call "…"` 包住（cmd 的引号剥离规则会把带括号的路径判成"不是可执行文件"而静默不执行）；
 *   ③ **绝不能按镜像名杀 QQ**（`taskkill /IM QQ.exe` 会连用户自己的 QQ 一起杀掉），
 *      只按加载器 PID `/T /F`；
 *   ④ **启动脚本要挑对的**：配置里这台机器指的是 `napcat.bat`，而它在这版只是
 *      `NapCatWinBootMain.exe` + `pause`（不设 NAPCAT_* 环境变量、不解析 QQ 路径），
 *      实测秒退什么都不做；真正干活的是同目录的 `launcher.bat`。
 *
 * 不执行任何东西：命令怎么拼是纯函数，执行交给调用方（可注入，便于单测）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * NapCat 加载器进程名（重启时**只允许**结束这些，以及它们 `/T` 带出来的子进程）。
 *
 * 为什么不再有 `QQ.exe`：按镜像名杀 QQ 会连**用户自己的 QQ 客户端**一起杀掉
 * （真机上就有一个非提权的个人 QQ 在客户端在跑）。加载器的子进程用 `taskkill /PID … /T`
 * 连带结束即可，不需要、也不允许按名字杀 QQ。
 */
export const NAPCAT_LOADER_NAMES = ['napcatwinbootmain.exe', 'napcat.exe', 'napcatshell.exe']

/** NapCat 自己的加载器/启动器可执行文件（绝不包含个人 QQ 客户端）。 */
export const NAPCAT_LOADER_RE = /napcat/i
/** The QQ client executables (managed only when a NapCat loader is present). */
export const QQ_CLIENT_RE = /^qq(ex)?\.exe$/i

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

/** 从进程表里挑出 NapCat 加载器（按名字匹配 + 只留有效 pid）。 */
export function pickNapcatLoaders(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && NAPCAT_LOADER_RE.test(String(entry.name ?? '')))
    .filter((entry) => Number.isFinite(Number(entry.pid)) && Number(entry.pid) > 0)
    .map((entry) => ({ pid: Number(entry.pid), name: String(entry.name ?? '') }))
}

/** PowerShell 单引号字符串转义（路径里有 `'` 时脚本会解析失败，必须成对写）。 */
export function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/**
 * 挑出真正该执行的启动脚本。
 *
 * 顺序：**同目录的 `launcher.bat` 优先**（它才会设 NAPCAT_* 环境变量、从注册表找 QQ.exe、
 * 写好 `loadNapCat.js` 再拉起加载器），配置里那个 `napcatBat` 作为兜底。
 * 真机上配置指的是 `napcat.bat`——它只是 `NapCatWinBootMain.exe` + `pause`，实测秒退。
 */
export function resolveNapcatLauncher(bat, { exists = existsSync } = {}) {
  const configured = String(bat ?? '').trim()
  if (configured === '') {
    return { ok: false, path: '', switched: false, reason: '未配置 NapCat 启动脚本（napcatBat）' }
  }
  const dir = dirname(configured)
  const launcher = join(dir, 'launcher.bat')
  const base = configured.split(/[\\/]/).pop() ?? configured
  // 本身就叫 launcher.bat（或它不存在）时不做切换，直接用配置里那个。
  if (base.toLowerCase() !== 'launcher.bat' && exists(launcher)) {
    return {
      ok: true,
      path: launcher,
      switched: true,
      reason: `配置里写的是 ${base}，它在这版只拉起加载器、不会设好环境（实测秒退）；已改用同目录的 launcher.bat`,
    }
  }
  if (!exists(configured)) {
    return {
      ok: false,
      path: configured,
      switched: false,
      reason: `NapCat 启动脚本不存在：${configured}（同目录也没找到 launcher.bat）`,
    }
  }
  return { ok: true, path: configured, switched: false, reason: '' }
}

/**
 * 把「启动脚本 → 提权命令」这一段包成一段 PowerShell：**已经是管理员就直接起，不是才 `-Verb RunAs`**。
 *
 * 为什么要判断（2026-10-04 真机）：这台机器上 DSH **宿主本身就是管理员**（从管理员终端起的那种），
 * 这时 `Start-Process -Verb RunAs` **不会弹 UAC**、直接执行——用户以为"没反应"，其实已经在跑了；
 * 反过来，**非管理员**的宿主（比如从资源管理器双击开的桌面端）发 `-Verb RunAs` 时，
 * 这台机器上会**静默拒绝**（连 UAC 都不弹），于是"点了完全没反应"。
 * 所以：① 两条分支都写清楚，别让调用方猜；② 命令里打标记（`QAI-ELEVATED` / `QAI-RUNAS`），
 * 调用方能把真实分支回给界面（这就是"无静默分支必带 reason"）。
 */
function wrapLaunch(inner, workingDirectory) {
  // **只用一次 Start-Process**（参数走 splatting：非管理员时补一个 Verb='RunAs'）。
  // 不能写两条各自带完整命令的分支：那样命令文本里会出现两遍启动脚本 / 两遍 taskkill，
  // 控制台那条"不会没杀掉又拉一个"的守卫会红，而且以后改一处漏一处。
  return [
    '$admin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    `$p = @{ FilePath = 'cmd.exe'; ArgumentList = @('/c',${psQuote(inner)}); WorkingDirectory = ${psQuote(workingDirectory)}; PassThru = $true }`,
    "if ($admin) { Write-Output 'QAI-ELEVATED' } else { Write-Output 'QAI-RUNAS'; $p.Verb = 'RunAs' }",
    'Start-Process @p | Out-Null',
  ].join('; ')
}

/**
 * 组装「启动 NapCat」的命令（纯函数，不执行，便于单测）。
 *
 * 为什么必须提权：NapCat 的 launcher.bat 自己会检查管理员权限，非管理员时它靠
 * `wt.exe` 自提权重启；实测这台机器上那条路会静默失败（启动器秒退、什么都不做），
 * 所以主动 `-Verb RunAs` 拉起，代价只是用户要点一次 UAC（宿主已是管理员时连这一步都不用）。
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
  const script = wrapLaunch(inner, dirname(path))
  return { ok: true, command: powershell, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], reason: '' }
}

/**
 * 组装「重启登录流程」的命令：先结束 NapCat 加载器（连同其子进程），再重新走启动脚本。
 *
 * 三条硬规则（每条都对应一次真机/审查结论）：
 * 1. **按 PID 杀，不按镜像名杀**：`taskkill /IM QQ.exe` 会连用户自己的 QQ 一起杀
 *    （真机上就有非提权的个人 QQ 在跑）；只对加载器 PID 用 `/T /F`，子进程连带结束。
 * 2. **必须拿到加载器 PID**：拿不到就拒绝执行（在调用方那层拦），绝不退回"按名杀"。
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
  const script = wrapLaunch(inner, dirname(path))
  return { ok: true, command: powershell, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], reason: '', pids: list }
}

/**
 * 「快捷操作」要执行什么——**纯决策，不执行**（面板的按钮与控制台共用同一套判断）。
 *
 * @param {'start'|'relogin'} kind
 * @param {object} input
 *   - `bat`：配置里的启动脚本（`qq-control.json` 的 `napcatBat`）
 *   - `running`：6099 是否有人在听（只是提示，不作放行依据——别的程序也可能占着它）
 *   - `loaders`：`[{pid,name}]`，从 `tasklist` 里挑出来的 NapCat 加载器
 *   - `exists`：文件存在性判断（测试注入）
 * @returns {{ok:boolean, command?:string, args?:string[], reason:string, note:string, action:string, focus?:string}}
 */
export function planNapcatAction(kind, { bat = '', running = false, loaders = [], exists } = {}) {
  const chosen = resolveNapcatLauncher(bat, exists === undefined ? {} : { exists })
  if (chosen.ok !== true) return { ok: false, reason: chosen.reason, note: '', action: kind }
  const note = chosen.switched ? chosen.reason : ''
  if (kind === 'start') {
    if (running === true) {
      return {
        ok: false,
        reason: 'NapCat 看起来已经在运行（6099 有人在听）。要重新扫码登录，请点「重新登录（清掉旧加载器再启动）」',
        note,
        action: kind,
        focus: 'relogin',
      }
    }
    const plan = napcatLaunchCommand(chosen.path)
    if (plan.ok !== true) return { ok: false, reason: plan.reason, note, action: kind }
    return {
      ok: true,
      command: plan.command,
      args: plan.args,
      action: kind,
      note,
      // 注意：这里**不说"会弹 UAC"**——宿主已经是管理员时根本不会弹（真机实测）。
      // 到底弹没弹由命令打出的 QAI-ELEVATED / QAI-RUNAS 决定，调用方据此补一句实话。
      reason: `已发出启动 NapCat 的命令（${chosen.path.split(/[\\/]/).pop()}）`,
    }
  }
  if (kind === 'relogin') {
    const list = pickNapcatLoaders(loaders)
    if (list.length === 0) {
      return {
        ok: false,
        action: kind,
        note,
        reason: `没有检测到 NapCat 加载器进程（${NAPCAT_LOADER_NAMES.join(' / ')}），拒绝执行：按进程名杀 QQ 会连你自己开的 QQ 一起杀掉。`
          + '请改用「启动 NapCat」，或在任务管理器里结束 NapCatWinBootMain.exe 后再启动',
      }
    }
    const plan = napcatRestartCommand(chosen.path, list.map((entry) => entry.pid))
    if (plan.ok !== true) return { ok: false, reason: plan.reason, note, action: kind }
    const names = list.map((entry) => `${entry.name || 'napcat'}#${entry.pid}`).join('、')
    return {
      ok: true,
      command: plan.command,
      args: plan.args,
      action: kind,
      note,
      reason: `已请求提权重启登录：只结束 ${names}（连同其子进程），不会碰你自己的 QQ。UAC 点「是」后等二维码刷新，2 分钟内扫掉`,
    }
  }
  return { ok: false, reason: `不认识的操作：${kind}`, note, action: kind }
}
