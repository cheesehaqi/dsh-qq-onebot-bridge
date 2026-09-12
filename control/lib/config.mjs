/**
 * Control-console configuration: one source of truth for every port and every
 * executable the console manages. Everything is auto-detected with overrides,
 * so the same file works on another machine without editing code.
 *
 * Config file: <repo>/qq-control.json   (machine-local, git-ignored)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'

/** Ports the console cares about. 6700 is pinned by the OneBot client config. */
export const DEFAULT_PORTS = {
  control: 8799,   // this console itself (127.0.0.1 only)
  host: 3080,      // dsh web host: bot console UI + HTTP API
  onebot: 6700,    // reverse WebSocket the bridge listens on (NapCat connects)
  napcat: 6099,    // NapCat WebUI (QR login)
  tts: 9880,       // local GPT-SoVITS service (optional)
}

/** Human-readable labels used by the UI and the CLI summary. */
export const PORT_LABELS = {
  control: '控制台',
  host: 'DSH 宿主（机器人控制台）',
  onebot: 'OneBot 反向 WS（桥监听）',
  napcat: 'NapCat WebUI（扫码）',
  tts: 'GPT-SoVITS 本地语音',
}

/** Ports the console is allowed to free by killing the occupying process. */
export const FREEABLE_PORTS = ['host', 'onebot', 'napcat', 'tts']

const DEFAULTS = {
  cwd: '',
  nodeExe: '',
  dshBin: '',
  napcatBat: '',
  napcatQr: '',
  ttsBat: '',
  pluginRoot: '',
  logs: { hostOut: '', hostErr: '', bridge: '' },
  extraDirs: [],
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (existsSync(candidate)) return resolve(candidate)
    } catch { /* ignore */ }
  }
  return ''
}

/** Newest `@deepseek-ai/dsh` bin.js under the usual npx cache roots. */
export function detectDshBin({ roots = [], readdir = readdirSync, exists = existsSync } = {}) {
  const found = []
  for (const root of roots) {
    if (!root) continue
    let entries = []
    try { entries = readdir(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (exists(candidate)) found.push(candidate)
    }
  }
  if (found.length === 0) return ''
  found.sort((a, b) => {
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
  })
  return resolve(found[0])
}

/**
 * npx cache roots worth probing, derived from the ENVIRONMENT and the location of
 * the running node — never from a hardcoded absolute path (a published plugin must
 * not carry the author's `C:\Users\<name>` or `D:\...` layout).
 */
export function npxCacheRoots({ env = process.env, execPath = process.execPath } = {}) {
  const home = env.USERPROFILE || env.HOME || ''
  const localAppData = env.LOCALAPPDATA || (home ? join(home, 'AppData', 'Local') : '')
  const roamingAppData = env.APPDATA || (home ? join(home, 'AppData', 'Roaming') : '')
  const roots = []
  const push = (value) => { if (value && !roots.includes(value)) roots.push(value) }
  // 1) 显式覆盖优先
  for (const key of ['DSH_NPX_CACHE', 'npm_config_cache', 'NPM_CONFIG_CACHE']) {
    const value = env[key]
    if (!value) continue
    push(value.endsWith('_npx') ? value : join(value, '_npx'))
  }
  // 2) npm 默认缓存位置
  if (localAppData) push(join(localAppData, 'npm-cache', '_npx'))
  if (roamingAppData) push(join(roamingAppData, 'npm-cache', '_npx'))
  // 3) 以 node 自身位置为锚：<node>\..\_npx、<node>\node_cache\_npx、<盘>:\nodejs\node_cache\_npx
  try {
    const nodeDir = dirname(execPath)
    const driveRoot = parse(execPath).root
    push(join(nodeDir, '_npx'))
    push(join(nodeDir, 'node_cache', '_npx'))
    if (driveRoot) {
      push(join(driveRoot, 'nodejs', 'node_cache', '_npx'))
      push(join(driveRoot, 'node_cache', '_npx'))
    }
  } catch { /* 拿不到 node 位置就只用环境变量 */ }
  return roots
}

/** Fill in everything that can be discovered on this machine. */
export function detectPaths(config = {}, { env = process.env, exists = existsSync, readdir = readdirSync } = {}) {
  const home = env.USERPROFILE || env.HOME || ''
  const localAppData = env.LOCALAPPDATA || (home ? join(home, 'AppData', 'Local') : '')
  // cwd 只能来自配置或环境变量（默认当前目录）：插件不该假设任何人的工作目录路径
  const cwd = config.cwd || env.DSH_QQ_CWD || process.cwd()

  const dshBin = firstExisting([
    config.dshBin,
    env.DSH_WEB_BIN,
    detectDshBin({ roots: npxCacheRoots({ env }), readdir, exists }),
    join(localAppData, 'Programs', 'DSH Desktop', 'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ])

  const napcatBat = firstExisting([
    config.napcatBat,
    localAppData ? join(localAppData, 'Programs', 'NapCat', 'bootmain', 'napcat.bat') : '',
    env.ProgramFiles ? join(env.ProgramFiles, 'NapCat', 'bootmain', 'napcat.bat') : '',
    env['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'NapCat', 'bootmain', 'napcat.bat') : '',
    home ? join(home, '.dsh-qq', 'napcat.bat') : '',
  ])
  const napcatQr = firstExisting([
    config.napcatQr,
    napcatBat ? join(dirname(napcatBat), 'cache', 'qrcode.png') : '',
  ])
  const ttsBat = firstExisting([
    config.ttsBat,
    cwd ? join(cwd, 'GPT-SoVITS', 'TTS控制.bat') : '',
  ])

  return {
    ...DEFAULTS,
    ...config,
    cwd,
    nodeExe: config.nodeExe || process.execPath,
    dshBin,
    napcatBat,
    napcatQr,
    ttsBat,
    logs: {
      hostOut: config.logs?.hostOut || (cwd ? join(cwd, 'qq-host-out.log') : ''),
      hostErr: config.logs?.hostErr || (cwd ? join(cwd, 'qq-host-err.log') : ''),
      bridge: config.logs?.bridge || (cwd ? join(cwd, 'qq-bridge-debug.log') : ''),
      trace: config.logs?.trace || (cwd ? join(cwd, 'qq-trace.jsonl') : ''),
      audit: config.logs?.audit || (cwd ? join(cwd, 'qq-actions.log') : ''),
      runtime: config.logs?.runtime || (cwd ? join(cwd, 'qq-runtime.json') : ''),
      // 录制（收到的每条消息）与注入队列（控制台写、桥轮询读）
      inbox: config.logs?.inbox || (cwd ? join(cwd, 'qq-inbox.jsonl') : ''),
      inject: config.logs?.inject || (cwd ? join(cwd, 'qq-inject.jsonl') : ''),
    },
    ports: { ...DEFAULT_PORTS, ...(config.ports ?? {}) },
    extraDirs: Array.isArray(config.extraDirs) ? config.extraDirs : [],
  }
}

/** Load a config file (missing/corrupt files fall back to auto-detection). */
export function loadControlConfig(file, options = {}) {
  let raw = {}
  try { raw = JSON.parse(readFileSync(file, 'utf8')) ?? {} } catch { raw = {} }
  return { file, config: detectPaths(raw, options) }
}

export function saveControlConfig(file, config) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** Non-fatal problems worth showing in the UI (missing binaries, bad ports). */
export function configWarnings(config) {
  const warnings = []
  for (const [name, value] of Object.entries(config.ports ?? {})) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) warnings.push(`端口配置非法：${name}=${value}`)
  }
  if (!config.nodeExe) warnings.push('找不到 node 可执行文件（nodeExe）')
  else if (!existsSync(config.nodeExe)) warnings.push(`node 可执行文件不存在：${config.nodeExe}`)
  if (!config.dshBin) warnings.push('找不到 dsh bin.js（无法启动宿主，可用 dshBin 手动指定）')
  else if (!existsSync(config.dshBin)) warnings.push(`dsh bin.js 不存在：${config.dshBin}`)
  if (!config.napcatBat) warnings.push('找不到 NapCat 启动脚本（napcatBat）')
  if (!config.cwd) warnings.push('未设置宿主工作目录（cwd）')
  return warnings
}
