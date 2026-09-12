#!/usr/bin/env node
/**
 * Standalone QQ bot console — its own process, its own port, no DSH dependency.
 *
 *   node control/bin/qq-control.mjs [--port 8799] [--open] [--print-config]
 *
 * The console only ever touches 127.0.0.1 and requires its token, which is
 * printed on startup (and reused from qq-control.json between runs).
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createToken, createControlServer, readUi } from '../lib/server.mjs'
import { loadControlConfig, saveControlConfig, PORT_LABELS, configWarnings } from '../lib/config.mjs'
import { createSupervisor } from '../lib/supervisor.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
// 配置文件位置：--config > QQ_CONTROL_CONFIG 环境变量 > 仓库根目录（默认，双击 bat 即可用）。
// 若以后作为 npm 包装到只读的 node_modules 里，可用前两者指向可写位置。
const configFile = resolve(argOf('config', process.env.QQ_CONTROL_CONFIG || join(repoRoot, 'qq-control.json')))
const uiFile = join(here, '..', 'ui.html')

function argOf(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : fallback
}
const wantsOpen = process.argv.includes('--open')
const wantsPrint = process.argv.includes('--print-config')
const portOverride = Number(argOf('port', '0'))

const { config } = loadControlConfig(configFile)
if (Number.isInteger(portOverride) && portOverride > 0) config.ports.control = portOverride

// 控制台 token 持久化：同一个文件里保存，避免每次都要从日志里找 URL。
config.token = config.token || createToken()
saveControlConfig(configFile, config)

if (wantsPrint) {
  console.log(JSON.stringify(config, null, 2))
  process.exit(0)
}

const api = createSupervisor(config)
const server = createControlServer({
  config,
  token: config.token,
  api,
  ui: readUi(uiFile),
  saveConfig: (patch) => {
    Object.assign(config, patch)
    if (patch.ports) config.ports = { ...config.ports, ...patch.ports }
    return saveControlConfig(configFile, config)
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
  const url = `http://127.0.0.1:${config.ports.control}/?token=${config.token}`
  console.log('🐋 小鲸鱼控制台已启动')
  console.log(`   控制台：${url}`)
  console.log(`   配置文件：${configFile}`)
  console.log(`   受管端口：${Object.entries(config.ports).map(([name, port]) => `${PORT_LABELS[name] ?? name}=${port}`).join('  ')}`)
  console.log(`   宿主命令：${config.nodeExe} ${config.dshBin} web --no-open`)
  const warnings = configWarnings(config)
  if (warnings.length > 0) {
    console.log('   ⚠️ 配置提醒：')
    for (const warning of warnings) console.log(`      · ${warning}`)
  }
  console.log('   按 Ctrl+C 退出（不影响已启动的宿主）')
  if (wantsOpen) {
    try { spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref() } catch { /* 忽略打开失败 */ }
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n控制台已退出（宿主进程保持运行）')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500)
  })
}
