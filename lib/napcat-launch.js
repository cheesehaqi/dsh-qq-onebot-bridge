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
 * 为什么要判断（2026-10-04 真机）：宿主**本来就是管理员**时（从管理员终端起的），
 * `Start-Process -Verb RunAs` **不弹 UAC**、直接执行——用户以为"没反应"，其实已经在跑了；
 * 反过来非管理员时这台机器上的策略是 `ConsentPromptBehaviorAdmin=0`（提权**不提示**），
 * 于是也**不会有弹窗**、照样静默执行。两条分支各打一个标记（`QAI-ELEVATED` / `QAI-RUNAS`），
 * 调用方能把真实分支回给界面（这就是"无静默分支必带 reason"）。
 *
 * 🔴 **绝不能只靠 `-WorkingDirectory`**（2026-10-04 真机事故的根因）：
 * `-Verb RunAs` 提权出来的进程**拿不到我们给的工作目录**，`cmd.exe` 的 `%cd%` 会变成
 * `C:\Windows\System32`；而 `launcher.bat` 是用 `%cd%` 拼自己的路径的
 * （`%cd%\NapCatWinBootMain.exe` 等）⇒ 它去找 `System32\NapCatWinBootMain.exe`，
 * 报一句 `is not recognized...` 就退出，**窗口是隐藏的，界面上什么都看不到**。
 * 所以命令里必须自己 `cd /d "<脚本目录>"`（launcher.bat 的作者自提权时也是这么写的）。
 */
function wrapLaunch(shimPath) {
  // **只用一次 Start-Process**（参数走 splatting：非管理员时补一个 Verb='RunAs'）。
  // 不能写两条各自带完整命令的分支：那样命令文本里会出现两遍启动脚本 / 两遍 taskkill，
  // 控制台那条"不会没杀掉又拉一个"的守卫会红，而且以后改一处漏一处。
  //
  // 为什么是 `cmd.exe /c <垫片路径>` 而不是直接 `<垫片路径>`：**真机实测过**——
  // 直接对 `.cmd` 用 `-Verb RunAs` 时，提权那一跳有时**什么都不做**（垫片没跑、日志没生成、
  // 进程表里也没有），而且 powershell 退出码还是 0，界面上完全看不出问题。
  // 经 cmd 转发这一种在非管理员上下文里实测能跑通（垫片留下 marker），所以固定用它。
  // 注意参数只有一个**纯路径**，没有嵌套引号——这条命令里不允许再塞复杂内层命令（那是上一版的坑）。
  return [
    '$admin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    `$p = @{ FilePath = 'cmd.exe'; ArgumentList = @('/c',${psQuote(shimPath)}); PassThru = $true }`,
    "if ($admin) { Write-Output 'QAI-ELEVATED' } else { Write-Output 'QAI-RUNAS'; $p.Verb = 'RunAs' }",
    'Start-Process @p | Out-Null',
  ].join('; ')
}

/**
 * 生成**垫片脚本**（`.cmd`）：所有"脏活"都写进这个文件，提权那条命令只负责执行它一个。
 *
 * 为什么必须垫片（2026-10-04 真机事故的最终根因）：把复杂内层命令
 * （`cd /d "…" && call "…" >> "…" 2>&1`）塞进 `cmd /c`、再经 `Start-Process -ArgumentList`
 * 交给提权进程时，**引号会被打乱**——内层命令**根本没有执行**（连重定向的日志文件都没生成），
 * 而 powershell 退出码还是 0，界面上就是"点了没反应"。垫片把所有引号关在自己文件里，
 * 外层只传一个路径，没有任何嵌套引号。
 *
 * 垫片还要负责两件必须做的事（都在真机上踩过）：
 *   ① `cd /d "<脚本目录>"`：**提权后 `%cd%` 会变成 `C:\Windows\System32`**，而 launcher.bat
 *      用 `%cd%` 拼自己的路径（`%cd%\NapCatWinBootMain.exe` 等）⇒ 它会去找
 *      `System32\NapCatWinBootMain.exe`，报一句 `is not recognized...` 就退出；
 *   ② `>> "<日志>" 2>&1`：提权窗口是隐藏的，不重定向就**没人看得见它报了什么**。
 */
export function napcatShimScript(bat, { logFile = '', killPids = [] } = {}) {
  const clean = String(bat ?? '').trim().replace(/"/g, '')
  const log = String(logFile ?? '').trim().replace(/"/g, '')
  const redirect = log === '' ? '' : ` >> "${log}" 2>&1`
  const pids = (Array.isArray(killPids) ? killPids : []).map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid) && pid > 0)
  const lines = ['@echo off']
  // 心跳行：垫片只要跑起来就一定留痕——"到底跑没跑"不必再靠猜（真机上吃过这个亏）。
  if (log !== '') lines.push(`echo === shim start %DATE% %TIME% (admin check below) === >> "${log}"`)
  if (pids.length > 0) {
    // 只按**加载器 PID** 杀（连同子进程）：按镜像名杀会连用户自己的 QQ 一起杀掉。
    lines.push(...pids.map((pid) => `taskkill /PID ${pid} /T /F${redirect}`), 'timeout /t 3 >nul')
  }
  lines.push(`cd /d "${dirname(clean)}"`, `call "${clean}"${redirect}`, '')
  return lines.join('\r\n')
}

/** 命令 + 垫片内容：一起交给调用方（调用方负责把垫片原子写到磁盘，再执行命令）。 */
function launchPlan(bat, { powershell = 'powershell.exe', shimFile = '', logFile = '', killPids = [] } = {}) {
  const clean = String(bat ?? '').trim()
  if (clean === '') return { ok: false, command: '', args: [], reason: '未配置 NapCat 启动脚本（napcatBat）' }
  if (String(shimFile ?? '').trim() === '') return { ok: false, command: '', args: [], reason: '缺少垫片脚本路径（shimFile）' }
  return {
    ok: true,
    command: powershell,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrapLaunch(shimFile)],
    reason: '',
    logFile,
    shim: { path: shimFile, content: napcatShimScript(clean, { logFile, killPids }), logFile, killPids },
  }
}

/**
 * 组装「启动 NapCat」的命令（纯函数，不执行，便于单测）。
 *
 * 提权是必须的：launcher.bat 自己会检查管理员权限，非管理员时它靠 `wt.exe` 自提权重启，
 * 而实测这条自提权在这台机器上会静默失败（启动器秒退、什么都不做）。
 * 为什么要垫片、垫片里都做了什么，见 `napcatShimScript` 的注释。
 */
export function napcatLaunchCommand(bat, options = {}) {
  return launchPlan(bat, options)
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
export function napcatRestartCommand(bat, pids, options = {}) {
  const list = (Array.isArray(pids) ? pids : [pids]).map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid) && pid > 0)
  if (list.length === 0) {
    return { ok: false, command: '', args: [], reason: '没有拿到 NapCat 加载器的 PID，拒绝执行（按进程名杀会把你自己开的 QQ 也杀掉）' }
  }
  const plan = launchPlan(bat, { ...options, killPids: list })
  if (plan.ok !== true) return plan
  return { ...plan, pids: list }
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
export function planNapcatAction(kind, { bat = '', running = false, loaders = [], exists, logFile = '', shimFile = '' } = {}) {
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
    const plan = napcatLaunchCommand(chosen.path, { logFile, shimFile })
    if (plan.ok !== true) return { ok: false, reason: plan.reason, note, action: kind }
    return {
      ok: true,
      command: plan.command,
      args: plan.args,
      action: kind,
      note,
      logFile,
      shim: plan.shim,
      // 注意：这里**不说"会弹 UAC"**——这台机器的策略是"提权不提示"，管理员与否都不弹（真机实测）。
      // 到底走的哪条分支由命令打出的 QAI-ELEVATED / QAI-RUNAS 决定，调用方据此补一句实话。
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
    const plan = napcatRestartCommand(chosen.path, list.map((entry) => entry.pid), { logFile, shimFile })
    if (plan.ok !== true) return { ok: false, reason: plan.reason, note, action: kind }
    const names = list.map((entry) => `${entry.name || 'napcat'}#${entry.pid}`).join('、')
    return {
      ok: true,
      command: plan.command,
      args: plan.args,
      action: kind,
      note,
      logFile,
      shim: plan.shim,
      reason: `已请求重启登录：只结束 ${names}（连同其子进程），不会碰你自己的 QQ；随后会重新拉起 NapCat，等二维码刷新后 2 分钟内扫掉`,
    }
  }
  return { ok: false, reason: `不认识的操作：${kind}`, note, action: kind }
}
