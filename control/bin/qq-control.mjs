#!/usr/bin/env node
/**
 * Standalone QQ bot console — its own process, its own port, no DSH dependency.
 *
 *   node control/bin/qq-control.mjs [--port 8799] [--open] [--accounts] [--shortcut] [--print-config]
 *
 * `--accounts` 直接打开「账号中心」（本地页面 `/accounts`）；
 * `--shortcut` 在桌面建一个指向 `control/账号中心.bat` 的快捷方式（双击即可用）。
 *
 * The console only ever touches 127.0.0.1 and requires its token, which is
 * printed on startup (and reused from qq-control.json between runs).
 */
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createToken, createControlServer, readUi } from '../lib/server.mjs'
import { loadControlConfig, saveControlConfig, PORT_LABELS, configWarnings } from '../lib/config.mjs'
import { createSupervisor } from '../lib/supervisor.mjs'
import { openPanel } from '../lib/open.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
// 配置文件位置：--config > QQ_CONTROL_CONFIG 环境变量 > 仓库根目录（默认，双击 bat 即可用）。
// 若以后作为 npm 包装到只读的 node_modules 里，可用前两者指向可写位置。
const configFile = resolve(argOf('config', process.env.QQ_CONTROL_CONFIG || join(repoRoot, 'qq-control.json')))
const uiFile = join(here, '..', 'ui.html')
const accountsUiFile = join(here, '..', 'accounts.html')
const reportUiFile = join(here, '..', 'report.html')
const voiceUiFile = join(here, '..', 'voice.html')

function argOf(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : fallback
}
const wantsOpen = process.argv.includes('--open')
const wantsPrint = process.argv.includes('--print-config')
// v0.7.11：直达账号中心 / 建桌面快捷方式
const wantsAccounts = process.argv.includes('--accounts')
  || process.argv.includes('--open=accounts')
  || process.argv.includes('--open:accounts')
const wantsShortcut = process.argv.includes('--shortcut')
const accountsBat = join(repoRoot, 'control', '账号中心.bat')

/**
 * 在桌面建一个指向「账号中心.bat」的快捷方式（Windows）。
 * 桌面路径**让 PowerShell 自己取**：OneDrive 重定向、中文用户名都不会出岔子。
 */
function createDesktopShortcut({ name, bat }) {
  if (process.platform !== 'win32') return { ok: false, path: '', reason: '只有 Windows 才有桌面快捷方式' }
  // PowerShell 单引号字符串里**没有转义字符**（`\\` 就是两个反斜杠），所以这里自己转义单引号，
  // 不能用 JSON.stringify —— 那会把 `D:\x\y` 写成 `D:\\x\\y`，快捷方式的"起始位置"就废了。
  const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`
  const ps = [
    '$desktop = [Environment]::GetFolderPath("Desktop")',
    `$path = Join-Path $desktop ${psQuote(`${name}.lnk`)}`,
    '$shell = New-Object -ComObject WScript.Shell',
    '$lnk = $shell.CreateShortcut($path)',
    `$lnk.TargetPath = ${psQuote(bat)}`,
    `$lnk.WorkingDirectory = ${psQuote(dirname(bat))}`,
    '$lnk.IconLocation = "$env:SystemRoot\\System32\\shell32.dll,13"',
    '$lnk.Description = "QQ AI 账号中心（本地页面）"',
    '$lnk.Save()',
    'Write-Output $path',
  ].join('; ')
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
  const path = String(result.stdout ?? '').trim().split('\n').pop() ?? ''
  if (result.status !== 0 || path === '') {
    return { ok: false, path: '', reason: String(result.stderr ?? 'powershell 执行失败').trim().slice(0, 160) }
  }
  return { ok: true, path, reason: '' }
}
const portOverride = Number(argOf('port', '0'))

const { config } = loadControlConfig(configFile)
// `--port` 只对**这一次**生效：不写回配置文件。
// （踩过：测试时用 --port 18803 跑了几次，配置文件被改成 18803，之后双击 bat 直接报"端口被占用"。）
if (Number.isInteger(portOverride) && portOverride > 0) config.ports.control = portOverride

// 控制台 token 持久化：同一个文件里保存，避免每次都要从日志里找 URL。
const previousToken = config.token
config.token = config.token || createToken()
// 只有 token 变了才落盘（端口覆盖不落盘，见上）。
if (portOverride <= 0 || previousToken !== config.token) {
  const toSave = { ...config }
  if (portOverride > 0) toSave.ports = { ...config.ports, control: loadControlConfig(configFile).config.ports.control }
  saveControlConfig(configFile, toSave)
}

if (wantsPrint) {
  console.log(JSON.stringify(config, null, 2))
  process.exit(0)
}

// 落盘时用的"真实"控制台端口：`--port` 只对本次生效，保存别的设置时不能把它写回配置文件。
// （踩过：用 --port 18899 打开界面、随便保存一次路径配置，配置文件就被改成 18899，之后双击 bat 直接端口冲突。）
const persistedControlPort = loadControlConfig(configFile).config.ports.control

// configFile 也交给 supervisor：控制台每次写「路径配置」时，它要靠这个路径拍前后快照，
// 才能把"哪个键从什么改成了什么"记进设置变更历史（qq-settings-history.jsonl）。
const api = createSupervisor(config, { configFile })
const server = createControlServer({
  config,
  token: config.token,
  api,
  ui: readUi(uiFile),
  uiFile,
  // v0.7.11：「账号中心」是控制台里的独立本地页面（同源、同 token），不塞进 DSH 面板 ——
  // 登录这件事常常发生在宿主还没起来的时候。
  accountsUi: readUi(accountsUiFile),
  accountsUiFile,
  // v0.8.5+：「一键体检报告」同样是独立本地页（可打印/复制/深链回控制台），只读。
  reportUi: readUi(reportUiFile),
  reportUiFile,
  // 语音调试单独一页：要反复换音色/语言试听、录一段看转写，塞在总览里会被自动刷新冲掉。
  voiceUi: readUi(voiceUiFile),
  voiceUiFile,
  saveConfig: (patch) => {
    Object.assign(config, patch)
    if (patch.ports) config.ports = { ...config.ports, ...patch.ports }
    // `--port` 是本次运行的临时覆盖：除非这次保存明确改了控制台端口，否则写盘时用启动时文件里的值
    const toSave = { ...config }
    if (portOverride > 0 && !(patch.ports && patch.ports.control !== undefined)) {
      toSave.ports = { ...config.ports, control: persistedControlPort }
    }
    return saveControlConfig(configFile, toSave)
  },
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`✖ 控制台端口 ${config.ports.control} 已被占用，请先释放或改用 --port <其它端口>`)
    process.exit(2)
  }
  console.error(`✖ 控制台启动失败：${error.message}`)
  process.exit(1)
})

server.listen(config.ports.control, '127.0.0.1', () => {
  const rootUrl = `http://127.0.0.1:${config.ports.control}/?token=${config.token}`
  // v0.7.11：`--accounts` 直接落在「账号中心」这一页（登录/扫码都不必先经过总览页）。
  const accountsUrl = `http://127.0.0.1:${config.ports.control}/accounts?token=${config.token}`
  const reportUrl = `http://127.0.0.1:${config.ports.control}/report?token=${config.token}`
  const voiceUrl = `http://127.0.0.1:${config.ports.control}/voice?token=${config.token}`
  const url = wantsAccounts ? accountsUrl : rootUrl
  console.log('🐋 小鲸鱼控制台已启动')
  console.log(`   ${wantsAccounts ? '账号中心' : '控制台'}：${url}`)
  if (!wantsAccounts) console.log(`   账号中心：${accountsUrl}`)
  console.log(`   体检报告：${reportUrl}`)
  console.log(`   语音调试：${voiceUrl}`)
  console.log(`   配置文件：${configFile}`)
  console.log(`   受管端口：${Object.entries(config.ports).map(([name, port]) => `${PORT_LABELS[name] ?? name}=${port}`).join('  ')}`)
  console.log(`   宿主命令：${config.nodeExe} ${config.dshBin} web --no-open`)
  const warnings = configWarnings(config)
  if (warnings.length > 0) {
    console.log('   ⚠️ 配置提醒：')
    for (const warning of warnings) console.log(`      · ${warning}`)
  }
  console.log('   按 Ctrl+C 退出（不影响已启动的宿主）')
  if (wantsShortcut) {
    const made = createDesktopShortcut({ name: 'QQ 账号中心', bat: accountsBat })
    console.log(made.ok ? `   已在桌面创建快捷方式：${made.path}` : `   创建快捷方式失败：${made.reason}`)
    // 只建快捷方式时不要留一个常驻控制台：建完就退出（`npm run shortcut` 应该是"一次性"的）。
    if (!wantsOpen && !wantsAccounts) {
      server.close(() => process.exit(made.ok ? 0 : 1))
      return
    }
  }
  if (wantsOpen || wantsAccounts) {
    const opened = openPanel(url)
    console.log(opened.ok
      ? `   已用${opened.mode === 'app' ? '应用窗口' : '默认浏览器'}打开${wantsAccounts ? '账号中心' : '控制面板'}`
      : '   未能自动打开窗口，请手动访问上面的地址')
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n控制台已退出（宿主进程保持运行）')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500)
  })
}
