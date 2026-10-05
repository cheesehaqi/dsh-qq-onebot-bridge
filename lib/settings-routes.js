/**
 * v0.6：把「QQ助手」面板挂到 DSH 的 HTTP 服务上（客户端 bundle 用 fetch 调这里）。
 *
 * 契约照抄 DSH 自带/已装插件的做法（`dshmarket` 的 routes.js）：
 *   `host.webServer.register({ kind: 'exact', path, handler(request, response) })`
 * 因此这里只用 Node 原生 req/res，不引任何依赖（本插件零第三方依赖的原则不变）。
 *
 * 写入范围**只有 profile 的 cordis.patch.yml 里本插件那一个 config 块**，且只允许面板白名单里的
 * 布尔键；每次写入前留一份 `.bak`，写坏了也能一眼看出来（回滚就是把它拷回去）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PANEL_GROUPS, PANEL_KEYS, PANEL_NOTES, panelFooterLinksWithConsole, panelSnapshot, readPatchValue, upsertPatchValue,
} from './panel.js'
import { parseTasklist, pickNapcatLoaders, planNapcatAction } from './napcat-launch.js'

const PLUGIN_ID = 'dsh-qq-onebot-bridge'
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 跑一条命令并收集输出（失败不抛，返回空 stdout）。
 * 给 `tasklist` 用——只为挑出 NapCat 加载器的 PID；可注入，测试里不会真跑。
 */
function runCommand(exec, command, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    exec(command, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: error === null || error === undefined, stdout: String(stdout ?? '') })
    })
  })
}

/**
 * 起一个进程并把它的输出抓回来（提权启动 NapCat 用）。
 *
 * 🔴 **绝对不要加 `detached: true`**（2026-10-04 真机，Node 26 + Windows 实测）：
 *   同一个 powershell 命令，`detached: true` + 管道时 **exit=0、stdout/stderr 全空，而且命令压根没执行**
 *   （用落盘标记验证过：标记文件都没生成）；去掉 detached 立刻恢复正常（有输出、标记落盘）。
 *   这正是从第一版起"点了启动没反应、界面还说成功"的**总根源**——提权命令从未真正运行过。
 *   矩阵实测：
 *     A 默认           → out="hi-from-ps" ✓
 *     B 只有管道        → out="hi-from-ps" ✓
 *     C windowsHide+管道 → out="hi-from-ps" ✓
 *     D detached+管道    → out=""（且没执行）✗
 *     E D + windowsHide  → out=""（且没执行）✗  ← 插件原来用的就是这个形状
 *   为什么当时以为需要 detached：担心子进程随宿主退出被收走。其实**提权那一跳是 AppInfo 服务拉起的**
 *   （不在我们的 Job 里），我们自己的 powershell 只是发令、一秒内就退出，不需要 detached。
 * `unref()` 仍然保留：发令进程退出后不该拖着宿主的引用计数。
 */
export function spawnDetachedProcess({
  command, args = [], cwd, spawnImpl = spawn, waitMs = 6000,
} = {}) {
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
    child.once('error', (error) => finish({ failed: true, code: -1, message: String(error?.message ?? error) }))
    child.once('exit', (code) => finish({ code: typeof code === 'number' ? code : -1 }))
    // 超时也照常放行：命令可能还挂着（比如等 UAC），我们只是不再等它。
    setTimeout(() => finish({ code: null, timedOut: true }), Math.max(500, waitMs)).unref?.()
  })
}

/** 探一下 127.0.0.1:<port> 有没有人在听（调试台是否已启动）。失败/超时都算"没在跑"，不抛。 */
export function probePort(port, { host = '127.0.0.1', timeout = 400 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ host, port })
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 调试台的启动命令（可复制粘贴；路径取自插件真实位置，不写死）。 */
export function consoleStartCommand({ root = PLUGIN_ROOT } = {}) {
  return `node "${join(root, 'control', 'bin', 'qq-control.mjs')}"`
}

/**
 * 从控制台配置推导 NapCat WebUI 的地址：能读到 webui.json 就带上 token（用户不用手输），
 * 读不到就退回裸地址。token 只在服务端读、只在 302 的 Location 里出现，**不进面板载荷**。
 *
 * `?token=` 的位置与写法是照 NapCat 4.18.28 前端**实测**定的，不是猜的
 * （`static/assets/web_login-iVdMgBJV.js`：读 `location.search` 的 `token` → 有就自动登录）：
 *   - 落点必须是 **`/webui/`（带尾斜杠）**：`/webui` 会被服务端 301 重定向到 `/webui/?token=…`，
 *     多一跳；SPA 的 basename 也是 `/webui/`；
 *   - 参数就是**明文 token**，前端自己算 `SHA256(token + ".napcat")` 再 `POST /api/auth/login`
 *     （实测返回 `{code:0,data:{Credential}}`，带它访问受保护接口成功）——所以**不需要**我们先算 hash。
 */
export function napcatWebUiUrl({ pluginRoot = PLUGIN_ROOT, readFile = readFileSync } = {}) {
  let port = 6099
  try {
    const control = JSON.parse(String(readFile(join(pluginRoot, 'qq-control.json'), 'utf8')))
    const configured = Number(control?.ports?.napcat)
    if (Number.isInteger(configured) && configured > 0 && configured < 65536) port = configured
    const bat = String(control?.napcatBat ?? '')
    if (bat !== '') {
      // NapCat 的 webui.json 就放在启动器同级的 config/ 里（不写死绝对路径，跟着 qq-control.json 走）。
      const webui = JSON.parse(String(readFile(join(dirname(bat), 'config', 'webui.json'), 'utf8')))
      const token = String(webui?.token ?? '')
      if (token !== '') return `http://127.0.0.1:${port}/webui/?token=${encodeURIComponent(token)}`
    }
  } catch { /* 读不到就退回裸地址（用户还能自己在页面里填 token） */ }
  return `http://127.0.0.1:${port}/webui/`
}

/**
 * 「QQ助手账号」入口：302 到带 token 的 NapCat WebUI（免手抄密钥）。
 *
 * 它和调试台入口一样会**把带 token 的地址交出去**，所以两道闸都不能少：
 *   ① 只允许本机（回环）来源 —— 本机服务不代表"只有我能访问"；
 *   ② 同源守卫 —— 否则任意第三方页面只要 `<a href>`/`fetch` 到这个地址，就能把 token 读走。
 *      面板里点这个链接是**同源导航**（浏览器标 `Sec-Fetch-Site: same-origin`），不会被误伤。
 *
 * `pluginRoot` 必须由调用方传**它自己解析出来的**插件根（`linkSources.root`）：第一版这里漏了，
 * 于是单测里读到了真机的 `qq-control.json`（把本机 NapCat 的 token 带进了断言输出）。
 * `readFile` 同理：注入了假文件系统的调用方不该在账号入口这里又摸到真磁盘。
 */
function accountEntry(request, response, { pluginRoot = PLUGIN_ROOT, readFile = readFileSync } = {}) {
  const remote = String(request.socket?.remoteAddress ?? '')
  const local = remote === '' || remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.')
  if (!local) {
    sendJson(response, 403, { ok: false, reason: '账号入口只允许本机访问（它会把带 token 的地址给你）' })
    return
  }
  const guard = sameSiteGuard(request, { requireJson: false })
  if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
  const url = napcatWebUiUrl({ pluginRoot, readFile })
  /**
   * `?format=json`：把地址**当数据**返回，而不是 302（客户端拿它自己开）。
   *
   * 为什么需要（2026-10-04 真机）：**桌面端主窗口把新窗口一律拒了**——
   *   `setWindowOpenHandler(({url}) => { if (["http:","https:"].includes(protocol)) shell.openExternal(url); return {action:"deny"} })`
   * 面板里的账号入口是**相对地址** `/qqai/account`，在桌面端（渲染基址 `dsh-app://app/`）会被解析成
   * `dsh-app://app/qqai/account` ⇒ 协议不是 http(s)、也不允许开 Electron 窗口 ⇒ **点了什么都没发生**。
   * 现在客户端先取这个 JSON，再 `window.open(绝对 http 地址)`：那个地址是 http，桌面端会把它交给系统浏览器。
   * token 仍然只在服务端读、只出现在这一次响应里（不进面板载荷）。
   */
  if (String(request.url ?? '').includes('format=json')) {
    sendJson(response, 200, { ok: true, url })
    return
  }
  response.writeHead(302, { location: url, 'cache-control': 'no-store' })
  response.end()
}

/**
 * 同源守卫：本机端口不等于"只有我能访问"——浏览器会把**第三方页面**发起的请求带到这里。
 *
 * 第二轮对抗性审查用真实 http server 证明了两个绕过口子，这里都堵掉了：
 *   ① **"没有 Content-Type 就当本机脚本放行"** —— 不带 Content-Type 的 POST 属于 CORS **简单请求**，
 *      连预检都不发，于是"要求 application/json"这道闸形同虚设。现在**必须**是 JSON
 *      （curl/脚本也一样，加 `-H 'content-type: application/json'`）。
 *   ② **"Origin 的 hostname 等于请求 Host 就信"** —— DNS rebinding（`evil.com` 解析到 127.0.0.1）
 *      正好满足；`chrome-extension://`、`file://`、`data:` 这类非 http 协议也被一并信任了。
 *      现在只放行三种：`sec-fetch-site: same-origin`（浏览器自己打的标，页面改不了）、
 *      Origin 的 scheme+host+port 与请求 Host **完全一致**、DSH 自家协议 `dsh-*://`（桌面端）。
 */
export function sameSiteGuard(request, { requireJson = true } = {}) {
  const headers = request.headers ?? {}
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return { ok: false, reason: '拒绝跨站请求（sec-fetch-site: cross-site）' }
  if (requireJson) {
    const type = String(headers['content-type'] ?? '').toLowerCase()
    if (!type.includes('application/json')) {
      return { ok: false, reason: `写操作只接受 application/json（收到 ${type || '没有 Content-Type'}）` }
    }
  }
  const origin = String(headers.origin ?? '')
  if (origin === '') {
    /**
     * **导航请求（点链接 / 地址栏）不带 Origin** —— 这是 2026-10-04 真机"点了没反应"的根因：
     * 浏览器点 `<a href="/qqai/account">` 时发的是
     * `Sec-Fetch-Site: same-origin` + `Sec-Fetch-Mode: navigate`，**没有 Origin**；
     * 而这里原来只放行 `''` 与 `none`，于是正常点击被判成"来源不明的请求" → **403**，
     * 面板里「QQ助手账号」和「调试台」两个入口全点不动（我当时的 smoke 手动补了 `Origin`，
     * 正好从另一条分支出去了，所以没测出来 —— 现在测试里专门钉了导航形状的请求头）。
     *
     * 放行三种，语义都是"浏览器担保它跟本页面同源、或用户自己敲的地址"：
     *   - `same-origin`：页面里点链接（就是我们要支持的那种）
     *   - `none`：地址栏直达 / 书签
     *   - `''`：根本没有 Sec-Fetch-* 的老浏览器与 curl / 本机脚本
     * 仍然拒绝 `cross-site`（上面已拦）与 `same-site`（同站不同端口，比如本机别的服务）；
     * 注意 `Sec-Fetch-*` 是浏览器自己打的标，页面脚本改不了，所以这仍是可信信号。
     */
    if (site === '' || site === 'none' || site === 'same-origin') return { ok: true, reason: '' }
    return { ok: false, reason: `拒绝来源不明的请求（sec-fetch-site: ${site}）` }
  }
  let url = null
  try { url = new URL(origin) } catch { return { ok: false, reason: `Origin 不是合法地址：${origin}` } }
  if (url.protocol.startsWith('dsh-')) return { ok: true, reason: '' }  // 桌面端 dsh-app://
  /**
   * `sec-fetch-site: same-origin` **单独就够**：它是浏览器按*发起方 URL* 算出来的，页面脚本改不了，
   * 跨站页面打过来必然是 `cross-site`（上面已拦）。所以即使 Origin 与 Host 对不上也放行——
   * 这不是漏洞而是**有意留的口子**：反向代理部署时 Host 可能是内网地址、Origin 是公网域名，
   * 两者本来就不相等（平台自己也有 `--trusted-host` 这一档）。
   * 2026-10-04 我一度想收紧成"以 Origin 为准"，核对后**没有改**：真实浏览器发不出
   * "Origin=evil.example + same-origin 标记"这种自相矛盾的请求，改了只会误伤代理场景。
   * 测试里把这条语义显式钉住了（`sameSiteGuard` 那段）。
   */
  if (site === 'same-origin') return { ok: true, reason: '' }           // 浏览器担保的同源
  const requestHost = String(headers.host ?? '')
  const at = requestHost.lastIndexOf(':')
  const hostName = at === -1 ? requestHost : requestHost.slice(0, at)
  const hostPort = at === -1 ? '' : requestHost.slice(at + 1)
  const originPort = url.port !== '' ? url.port : (url.protocol === 'https:' ? '443' : '80')
  if (hostName !== '' && url.hostname === hostName && (hostPort === '' || hostPort === originPort)) {
    return { ok: true, reason: '' }
  }
  return { ok: false, reason: `Origin 不被允许（拒绝跨站请求）：${origin}` }
}

/** 读一个文件的最后一行（最多 200 字），给"启动脚本报了什么"用；读不到就返回空串。 */
function readTail(file, readFile = readFileSync, maxChars = 200) {
  try {
    const text = String(readFile(file, 'utf8')).trim()
    if (text === '') return ''
    const lastLine = text.split(/\r?\n/).filter((line) => line.trim() !== '').pop() ?? ''
    return lastLine.trim().slice(0, maxChars)
  } catch { return '' }
}

/**
 * 垫片到底跑没跑：看日志里**最后一次心跳行**是不是刚刚写下的。
 *
 * 为什么要这个（2026-10-04 真机假成功）：提权那一跳偶尔会被系统悄悄拦下，垫片根本没执行，
 * 而"6099 在听"这种判据在 NapCat 本来就在运行时**永远为真** ⇒ 界面报成功、实际什么都没发生。
 * 心跳行由垫片自己写（`=== shim start … ===`），是唯一可靠的"命令真的落地了"证据。
 */
export function shimHeartbeatFresh(file, { stat = statSync, readFile = readFileSync, withinMs = 60_000 } = {}) {
  try {
    const info = stat(file)
    // 文件整体没动过 ⇒ 肯定没有新心跳（文件系统的时间戳比解析内容便宜也更可靠）。
    if (Date.now() - Number(info.mtimeMs) > withinMs) return false
    const text = String(readFile(file, 'utf8'))
    return text.split(/\r?\n/).some((line) => line.includes('shim start'))
  } catch { return false }
}

/** 读一个小 JSON（失败就返回 null）：package.json 与 qq-control.json 都用它，读不到不影响面板。 */
function readJsonSafe(file, readFile = readFileSync) {
  try { return JSON.parse(String(readFile(file, 'utf8'))) } catch { return null }
}

/** 面板底部链接的素材：版本与仓库来自 package.json，控制台端口来自 qq-control.json。 */
export function panelLinkSources({ root = PLUGIN_ROOT, readFile = readFileSync } = {}) {
  const pkg = readJsonSafe(join(root, 'package.json'), readFile)
  const control = readJsonSafe(join(root, 'qq-control.json'), readFile)
  const port = Number(control?.ports?.control)
  return {
    version: typeof pkg?.version === 'string' ? pkg.version : '',
    repoUrl: typeof pkg?.repository?.url === 'string' ? pkg.repository.url : '',
    consolePort: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8799,
  }
}

/** 当前宿主进程 booted 的 profile（与 dshmarket 同口径：CLI 的 `--profile <name>`）。 */
export function argvProfile(argv = process.argv) {
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !String(argv[flag + 1]).startsWith('-')) return String(argv[flag + 1])
  return undefined
}

/**
 * 解析宿主真正 booted 的 profile —— **两种宿主两种传法**（真机实测）：
 *   1. CLI：`dsh web --profile desktop` → 取 `--profile` 的值；
 *   2. 官方桌面端：把 **profile 目录当位置参数**传进来，命令行长这样
 *      `"DeepSeek Harness.exe" --expose-internals <…dsh-desktop-host/lib/index.js> <…\app.asar\dsh> C:\Users\<u>\.dsh\profiles\desktop <runtime> …`
 *      —— 一个 `--profile` 都没有。v0.6 第一版只认 ①，于是在桌面端里回落成 `web`，
 *      面板会去改 **web profile** 的配置（用户看着桌面端，改的却是另一个 profile）——必须按路径认。
 *   3. 都不匹配时回落 `web`（CLI 的默认 profile）。
 * @returns {{profile: string, source: 'argv-flag'|'argv-path'|'fallback', dir?: string}}
 */
export function resolveProfile({ argv = process.argv, env = process.env, exists = existsSync } = {}) {
  // ① `--profile <name>` 与 `--profile=<name>`（commander 两种都收）
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '')
    if (arg === '--profile' && index + 1 < argv.length && !String(argv[index + 1]).startsWith('-')) {
      return { profile: String(argv[index + 1]), source: 'argv-flag' }
    }
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length)
      if (value !== '' && !value.startsWith('-')) return { profile: value, source: 'argv-flag' }
    }
  }
  // ② 官方桌面端把 profile **目录**当位置参数传进来（v0.6 真机实测的形态）
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.startsWith('-')) continue
    const match = /^(.*[\\/]profiles[\\/]([^\\/]+))[\\/]?$/.exec(arg)
    if (match) return { profile: match[2], source: 'argv-path', dir: match[1] }
  }
  // ③ 位置参数里直接给 profile 名：**不认**。
  //    第二轮审查核对过 CLI 源码（dsh/lib/bin.js）：profile 只能靠 `--profile` 给，
  //    位置参数是"给被启动 profile 的应用"的普通参数。放宽成"名字存在就认"会把
  //    随便一个应用参数当成 profile，写到另一个配置去——宁可不认，如实回落。
  return { profile: 'web', source: 'fallback' }
}

/** profile 目录：`$DSH_HOME/profiles/<name>`（DSH_HOME 未设则 `~/.dsh`）。 */
export function profileDirOf(profile, env = process.env) {
  const home = env.DSH_HOME && String(env.DSH_HOME).trim() !== '' ? String(env.DSH_HOME) : join(homedir(), '.dsh')
  return join(home, 'profiles', profile)
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

async function readBody(request, limitBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 挂载面板路由。
 * @param host  已 `inject` 到 `webServer` 的宿主上下文
 * @param options.profile  当前 profile 名
 * @param options.config   运行中的生效配置（插件自己的 config 对象）
 * @param options.defaults schema 默认值（用于"非默认"提示）
 * @param options.logger   可选日志
 */
export function mountQqAiPanel(host, options = {}) {
  const {
    profile = 'web',
    config = {},
    defaults = {},
    logger = { info() {}, warn() {}, error() {} },
    readFile = readFileSync,
    writeFile = writeFileSync,
    rename = renameSync,
    copy = copyFileSync,
    exists = existsSync,
    ensureDir = (dir) => mkdirSync(dir, { recursive: true }),
    unlink = unlinkSync,
    // env 可注入：测试必须能把 profile 目录指到临时目录，**绝不能**让测试写到真实 profile。
    env = process.env,
    // profile 目录可直接指定（桌面端把目录当位置参数传进来，见 resolveProfile）。
    dir = null,
    // 底部链接可直接覆盖（测试用）；默认从 package.json / qq-control.json 推。
    links = null,
    linkSources = {},
    // 端口探测可注入（测试里用真起一个 server / 指到空端口两种分支）。
    probe = probePort,
    // 快捷操作（启动 NapCat）的副作用可注入：测试**绝不能**真的去拉进程 / 跑 tasklist。
    spawnDetached = spawnDetachedProcess,
    exec = execFile,
    // 二维码那条路由要读图片字节 / 看 mtime：同样可注入（测试不去摸真机磁盘）。
    readBinary = readFileSync,
    stat = statSync,
    // 启动之后等多久去看 6099 有没有起来（测试里给 0，别让单测白等 8 秒）。
    napcatWaitMs = 8000,
  } = options
  const patchFile = join(dir ?? profileDirOf(profile, env), 'cordis.patch.yml')
  const sources = panelLinkSources(linkSources)

  /** NapCat 的端口 / 启动脚本 / 启动日志 / 垫片脚本：都从控制台配置（qq-control.json）推，读不到就回落。 */
  const napcatConfig = () => {
    try {
      const control = JSON.parse(String(readFile(join(linkSources.root ?? PLUGIN_ROOT, 'qq-control.json'), 'utf8')))
      const port = Number(control?.ports?.napcat)
      const cwd = String(control?.cwd ?? '').trim() !== '' ? String(control.cwd) : (linkSources.root ?? PLUGIN_ROOT)
      const bat = String(control?.napcatBat ?? '')
      const qr = String(control?.napcatQr ?? '').trim()
      return {
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 6099,
        bat,
        // 启动脚本的输出写到这里：提权窗口是隐藏的，不重定向就没人看得见它报了什么。
        logFile: join(cwd, 'qq-napcat-launch.log'),
        // 垫片脚本：真正的"脏活"（cd /d + call + 重定向）都写在这个文件里，
        // 提权命令只执行它一个路径——避免把带引号的复杂命令塞进 Start-Process（真机踩过，见 lib 注释）。
        shimFile: join(cwd, 'qq-napcat-launch.cmd'),
        // 二维码图片：配置里写的是首选，没有就按 NapCat 的固定位置推（启动脚本同级的 cache/qrcode.png）。
        qrFile: qr !== '' ? qr : (bat !== '' ? join(dirname(bat), 'cache', 'qrcode.png') : ''),
      }
    } catch {
      const root = linkSources.root ?? PLUGIN_ROOT
      return {
        port: 6099,
        bat: '',
        logFile: join(root, 'qq-napcat-launch.log'),
        shimFile: join(root, 'qq-napcat-launch.cmd'),
        qrFile: '',
      }
    }
  }

  /**
   * 二维码新不新鲜：NapCat 每拿到/刷新一次登录码就会重写 `cache/qrcode.png`，
   * 超过 `QR_STALE_SECONDS` 没动过就说明那已经不是"当前这轮的码"了（跟着控制台的口径走）。
   * 面板直接内嵌这张图，用户就不用去翻窗口或日志——**"没弹出二维码"就是这么解决的**。
   */
  const QR_STALE_SECONDS = 300
  const qrStatus = () => {
    const { qrFile } = napcatConfig()
    if (qrFile === '') return { fresh: false, ageSeconds: -1, file: '' }
    try {
      const info = stat(qrFile)
      const ageSeconds = Math.max(0, Math.round((Date.now() - Number(info.mtimeMs)) / 1000))
      return { fresh: ageSeconds <= QR_STALE_SECONDS, ageSeconds, file: qrFile }
    } catch { return { fresh: false, ageSeconds: -1, file: qrFile } }
  }

  /** NapCat 在不在：探 6099（缓存 2 秒，别每次刷面板都连一遍）。 */
  let napcatProbe = { at: 0, running: false }
  const napcatStatus = async () => {
    if (Date.now() - napcatProbe.at < 2000) return napcatProbe
    const { port } = napcatConfig()
    const running = await probe(port).catch(() => false)
    napcatProbe = { at: Date.now(), running: running === true, port }
    return napcatProbe
  }

  /** 从 `tasklist` 里挑出 NapCat 加载器（重启登录要按 PID 杀，绝不按镜像名杀 QQ）。 */
  const listNapcatLoaders = async () => {
    try {
      const { stdout } = await runCommand(exec, 'tasklist', ['/FO', 'CSV', '/NH'])
      return pickNapcatLoaders([...parseTasklist(stdout).entries()].map(([pid, name]) => ({ pid, name })))
    } catch {
      return []
    }
  }

  /**
   * 调试台（独立控制台）的状态：**它是另一个进程，插件不会替你启动**。
   * 第一版只给了一个裸链接，用户点进去只看到连不上——现在每次读面板都探一次端口（结果缓存 2 秒，
   * 免得面板刷新时反复连），并把"没启动时该跑哪条命令"一并告诉前端。
   */
  let consoleProbe = { at: 0, running: false }
  const consoleStatus = async () => {
    if (Date.now() - consoleProbe.at < 2000) return consoleProbe
    const running = await probe(sources.consolePort).catch(() => false)
    consoleProbe = { at: Date.now(), running: running === true }
    return consoleProbe
  }
  const footerLinksFor = async () => {
    if (Array.isArray(links)) return links
    const status = await consoleStatus()
    return panelFooterLinksWithConsole({
      ...sources,
      consoleRunning: status.running,
      startCommand: consoleStartCommand(linkSources.root ? { root: linkSources.root } : {}),
    })
  }

  /**
   * 原子写：同目录临时文件（随机名 + `wx` + 0600）→ rename 覆盖。
   * 为什么必须：写到一半崩掉会留下**撕裂的 YAML**，而 DSH 下次启动对"存在但解析不了"的 patch
   * 是**直接报错**的（loadOptionalPatches）——那等于把宿主搞挂。
   *
   * 三条被对抗性审查逼出来的规矩：
   *   ① **rename 失败绝不退化成"直接覆盖原名"**：Windows 上 rename 覆盖已存在文件会瞬时
   *      EACCES/EBUSY/EPERM（平台自己的 dsh-atomic-write 为此重试 8 次）。退化成 writeFile
   *      就等于用一条**非原子**的路径去写活配置，还与"原文件未被破坏"的说法自相矛盾。
   *      现在：重试若干次 → 仍失败就**保持原文件不动**、清掉临时文件、如实报错。
   *   ② **临时文件必须清干净**（成功/失败都不留），失败时也别改名叫 `.orphan` 攒垃圾。
   *   ③ **重试要 await，不许忙等**：这是 HTTP 处理器里的路径，同步自旋会把宿主的整个事件循环
   *      按住（实测一次失败写要 ~212ms），期间网页端所有请求都卡住。
   */
  const writeAtomic = async (file, text, { attempts = 8, waitMs = 25 } = {}) => {
    const tmp = `${file}.qqai-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await rename(tmp, file)
        return
      } catch (error) {
        lastError = error
        // 只有"瞬时占用"才值得重试；其余（如目录不存在）立刻放弃。
        const transient = ['EACCES', 'EBUSY', 'EPERM', 'EEXIST'].includes(error?.code)
        if (!transient) break
        await new Promise((resolve) => { setTimeout(resolve, waitMs) })
      }
    }
    try { if (exists(tmp)) await unlink(tmp) } catch { /* 清不掉也不能再抛 */ }
    throw lastError ?? new Error('rename 失败')
  }

  const readPatch = () => {
    if (!exists(patchFile)) return { yaml: null, reason: '' }
    try { return { yaml: String(readFile(patchFile, 'utf8')), reason: '' } } catch (error) {
      logger.warn(`QQ助手 面板：读不到 ${patchFile}：${error.message}`)
      // 读失败 ≠ 文件不存在：报错要说清，否则面板会说"没有配置文件"误导人。
      return { yaml: null, reason: `读配置文件失败：${error.message}` }
    }
  }

  /**
   * 分层警告：DSH 的配置是**分层叠加**的（bundle → profile patch → 家目录 patch → `--patch` 覆盖），
   * 后面的层**整体替换**前面的 config 对象。面板只写 profile 层，所以当家目录 patch 里也有本插件时，
   * 这里必须如实说出来——否则用户会看到"写入成功"却怎么点都没反应（第二轮的 P3 就是这个）。
   * 平台自己的 dsh-config-editor 遇到同样情况是直接抛错的；我们做不到那么强，至少要**说清楚**。
   */
  const hierarchyWarning = () => {
    try {
      const home = env.DSH_HOME && String(env.DSH_HOME).trim() !== '' ? String(env.DSH_HOME) : join(homedir(), '.dsh')
      const homePatch = join(home, 'cordis.patch.yml')
      if (!exists(homePatch)) return ''
      const text = String(readFile(homePatch, 'utf8'))
      if (!text.includes(PLUGIN_ID)) return ''
      return `注意：${homePatch} 里也有 ${PLUGIN_ID} 的配置。DSH 的层叠顺序里**家目录 patch 盖过 profile 层**，`
        + '所以这里写入的开关可能不生效——要改的是那一层（平台自己的配置编辑器遇到这种情况会直接拒绝写入）。'
    } catch { return '' }
  }

  const snapshot = async () => {
    const { yaml, reason } = readPatch()
    const fileValues = {}
    if (yaml !== null) for (const key of PANEL_KEYS) fileValues[key] = readPatchValue(yaml, key, PLUGIN_ID)
    const warning = hierarchyWarning()
    return {
      ...panelSnapshot(config, { defaults, fileValues }),
      profile,
      patchFile,
      patchExists: yaml !== null && reason === '',
      patchReason: reason,
      notes: PANEL_NOTES,
      warnings: warning === '' ? [] : [warning],
      // 「相关链接」整组（第一条就是账号入口）——客户端把它渲染在**标题正下方、开关分组之前**。
      links: await footerLinksFor(),
      // NapCat 的实时状态：客户端拿它决定「启动 NapCat」按钮是禁用还是可点；
      // `qr` 决定要不要在面板里直接把二维码贴出来（"窗口里看不到二维码"就是这么解决的）。
      napcat: {
        running: (await napcatStatus()).running,
        port: napcatConfig().port,
        qr: (() => {
          const qr = qrStatus()
          return { fresh: qr.fresh, ageSeconds: qr.ageSeconds, url: qr.fresh ? '/qqai/napcat/qr' : '' }
        })(),
      },
    }
  }

  /**
   * NapCat 快捷操作：**启动** / **重新登录**（清掉旧加载器再启动）。
   *
   * 为什么要有：以前只能让用户自己去右键"以管理员身份运行 launcher.bat"，
   * 而这台机器上双击自提权是静默失败的——面板里点一下就行。
   * 三条硬规矩（与 lib/napcat-launch.js 里那套共用，别在这里重新发明）：
   *   ① 必须提权（非提权的 launcher.bat 实测秒退）；
   *   ② 启动脚本优先挑同目录的 `launcher.bat`（配置里的 `napcat.bat` 这版只是拉起加载器 + pause）；
   *   ③ 重新登录只按**加载器 PID** 杀，拿不到 PID 就拒绝，绝不按镜像名杀（那会连你自己的 QQ 一起杀）。
   * 这是个**特权动作**（会拉起提权进程、会杀加载器），所以三道门都要过：POST + JSON、同源守卫、只允许回环来源。
   */
  const napcatAction = async (request, response, kind) => {
    if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
    const remote = String(request.socket?.remoteAddress ?? '')
    const local = remote === '' || remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.')
    if (!local) { sendJson(response, 403, { ok: false, reason: '这个动作只允许本机访问' }); return }
    const guard = sameSiteGuard(request)
    if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
    const { port, bat, logFile, shimFile, qrFile } = napcatConfig()
    const running = await probe(port).catch(() => false)
    const loaders = kind === 'relogin' ? await listNapcatLoaders() : []
    const plan = planNapcatAction(kind, { bat, running, loaders, exists, logFile, shimFile, qrFile })
    if (plan.ok !== true) {
      logger.info(`QQ助手 快捷操作：${kind} 被拒 —— ${plan.reason}`)
      sendJson(response, 200, { ok: false, action: kind, reason: plan.reason, note: plan.note ?? '', panel: await snapshot() })
      return
    }
    // 垫片脚本（cd /d + call + 重定向）先落盘，再执行那条"只指向它"的提权命令。
    try {
      writeFile(plan.shim.path, plan.shim.content, 'utf8')
    } catch (error) {
      const reason = `写不了启动垫片 ${plan.shim.path}：${error?.message ?? error}`
      logger.warn(`QQ助手 快捷操作：${kind} 失败 —— ${reason}`)
      sendJson(response, 500, { ok: false, action: kind, started: false, reason, panel: await snapshot() })
      return
    }
    const result = await spawnDetached({ command: plan.command, args: plan.args })
    // 🔴 关键：**别盲报成功**。powershell 立刻非零退出时说明命令根本没发出去；
    //    旧实现把输出吞了（stdio: 'ignore'），界面照样显示"已请求启动"——假成功。
    const said = `${result.stdout ?? ''}`.trim()
    const complained = `${result.stderr ?? ''}`.trim()
    if (result.failed === true || (typeof result.code === 'number' && result.code !== 0)) {
      const detail = (complained || said || result.message || '').split(/\r?\n/).filter(Boolean).slice(0, 3).join(' / ')
      const reason = `启动命令没发出去（powershell 退出码 ${result.code}）`
        + `${detail ? `：${detail}` : '，没有任何错误输出'}`
        + '。请改用管理员身份重开宿主，或手动右键"以管理员身份运行" launcher.bat。'
      logger.warn(`QQ助手 快捷操作：${kind} 失败 —— ${reason}`)
      sendJson(response, 200, { ok: false, action: kind, elevated: said.includes('QAI-ELEVATED'), started: false, reason, panel: await snapshot() })
      return
    }
    // 命令发出去了，**再看结果**：等最多 napcatWaitMs，6099 有没有起来（别让用户对着"已请求"干等）。
    let started = false
    const deadline = Date.now() + Math.max(0, Number(napcatWaitMs) || 0)
    while (Date.now() < deadline && started === false) {
      await new Promise((resolve) => { setTimeout(resolve, 500) })
      started = await probe(port).catch(() => false)
    }
    /**
     * 🔴 **别拿"6099 在听"当成功判据**（2026-10-04 真机抓到的假成功）：NapCat 本来就在跑时，
     * 提权那一跳被系统悄悄拦下、垫片根本没执行，而 6099 一直是通的 ⇒ 界面报"已经起来了"，
     * 用户以为重启成功了，其实什么都没发生（日志里没有新心跳、加载器 PID 也没变）。
     * 所以先看**垫片心跳**：只有垫片真跑起来，才算"命令落地了"。
     */
    const shimRan = shimHeartbeatFresh(logFile, { stat, readFile, withinMs: kind === 'relogin' ? 30_000 : 60_000 })
    const loadersNow = kind === 'relogin' ? await listNapcatLoaders() : []
    const loadersChanged = kind !== 'relogin' || loadersNow.some((entry) => plan.pids?.includes?.(entry.pid) !== true)
    // 启动脚本自己的输出（提权窗口是隐藏的，只有这里能看到它报了什么）。
    const launched = readTail(logFile, readFile)
    const elevated = said.includes('QAI-ELEVATED')
    // 实话实说这两条分支：这台机器上"提权不提示"（ConsentPromptBehaviorAdmin=0），两条都不弹窗。
    const branch = elevated
      ? '当前宿主已是管理员，走 WMI 直接执行（本机策略下提权本来就不弹窗）'
      : '已按提权方式拉起（本机策略是提权不提示，所以看不到 UAC 弹窗）'
    const waited = `${Math.round((Number(napcatWaitMs) || 0) / 1000)} 秒`
    if (shimRan !== true) {
      const reason = `${plan.reason} · ${branch}；但**启动脚本没有留下心跳**（垫片 ${plan.shim.path}，日志 ${logFile}）——`
        + '说明提权那一跳被系统拦下了，这次点击**什么都没发生**。'
        + '请手动右键"以管理员身份运行" launcher.bat，或用管理员身份重开宿主后再试。'
      logger.warn(`QQ助手 快捷操作：${kind} 垫片没跑起来 —— ${launched || '（日志里没有新内容）'}`)
      sendJson(response, 200, {
        ok: false, action: kind, pid: result.pid, elevated, started: false, shimRan: false, reason, panel: await snapshot(),
      })
      return
    }
    const reason = started === true
      ? `NapCat 已经起来了（127.0.0.1:${port} 在听）· ${branch}${plan.note ? ` · ${plan.note}` : ''}`
      : `${plan.reason} · ${branch}；垫片已经执行，但等了 ${waited} 6099 还没起来`
        + `${loadersChanged ? '' : '（加载器 PID 没变 ⇒ 旧的没被杀掉）'}`
        + `${launched === '' ? ` —— 启动脚本没有输出（垫片 ${plan.shim.path}）` : ` —— 启动脚本最后输出：${launched}`}`
        + `。完整细节见 ${logFile}；若脚本输出里是二维码，就点上面的「QQ助手账号」去扫码`
    logger.info(`QQ助手 快捷操作：${kind} ${started ? '成功' : '已发出但未起来'}（pid ${result.pid}）`)
    sendJson(response, 200, {
      ok: true, action: kind, pid: result.pid, elevated, started, reason, note: plan.note ?? '', logFile, panel: await snapshot(),
    })
  }

  /**
   * 调试台入口：**跑着**就 302 到带 token 的地址（token 只在服务端从 qq-control.json 读出，
   * 不进面板载荷、不进页面历史之外的任何地方）；**没跑**就回一页说明怎么启动，
   * 免得用户对着"连不上"发懵（第一版就是这个坑）。
   */
  const consoleEntry = async (request, response) => {
    if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return }
    // 这个入口会把**带 token 的地址**交出去，同样只给同源（任意网页不得拿走它）。
    const guard = sameSiteGuard(request, { requireJson: false })
    if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
    const status = await consoleStatus()
    const wantsJson = String(request.url ?? '').includes('format=json')
    if (status.running) {
      const control = readJsonSafe(join(linkSources.root ?? PLUGIN_ROOT, 'qq-control.json'), readFile)
      const token = typeof control?.token === 'string' ? control.token : ''
      const location = `http://127.0.0.1:${sources.consolePort}/${token ? `?token=${encodeURIComponent(token)}` : ''}`
      // `?format=json` 同账号入口：桌面端开不了 dsh-app:// 新窗口，得由客户端拿绝对 http 地址去开。
      if (wantsJson) { sendJson(response, 200, { ok: true, running: true, url: location }); return }
      response.writeHead(302, { location, 'cache-control': 'no-store' })
      response.end()
      return
    }
    const command = consoleStartCommand(linkSources.root ? { root: linkSources.root } : {})
    if (wantsJson) {
      sendJson(response, 200, { ok: false, running: false, url: '', command, reason: '调试台没有在运行' })
      return
    }
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>调试台未启动</title><style>body{font:14px/1.7 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.2rem;color:#111}
code{background:#f3f4f6;padding:.15rem .4rem;border-radius:4px}pre{background:#f3f4f6;padding:.8rem;border-radius:8px;overflow:auto}
h1{font-size:1.15rem}</style></head><body>
<h1>调试台没有在运行</h1>
<p>调试台（<code>control/</code>）是<strong>独立进程</strong>，端口 <code>127.0.0.1:${sources.consolePort}</code>，
DSH 插件<strong>不会</strong>自动启动它——所以刚才点进来会显示连不上。</p>
<p>在插件目录里跑这一条就会起来（启动后它自己会打印带 token 的地址）：</p>
<pre>${command.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
<p>起来之后再点一次面板里的「调试台」即可直接进入。</p>
</body></html>`
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(html)
  }

  /**
   * 「把二维码贴到面板里」：`GET /qqai/napcat/qr` 直接把 NapCat 写出来的 `cache/qrcode.png` 交给页面。
   *
   * 为什么要这条（用户 2026-10-04 连着两次："没弹出二维码啊"）：NapCat 的码本来只印在它自己的
   * 控制台窗口/日志里；用户看到的往往是**空的窗口**（我们把输出重定向进日志了），于是"没有二维码"。
   * 面板直接把图贴出来，就不用去翻窗口了。
   * 守卫与账号入口同一套（只允许回环 + 同源），因为它读的是本机文件；图片本身不含密钥，但没必要对外。
   */
  const qrEntry = (request, response) => {
    if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return }
    const remote = String(request.socket?.remoteAddress ?? '')
    const local = remote === '' || remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.')
    if (!local) { sendJson(response, 403, { ok: false, reason: '二维码只给本机看' }); return }
    const guard = sameSiteGuard(request, { requireJson: false })
    if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
    const qr = qrStatus()
    if (qr.fresh !== true) {
      sendJson(response, 404, {
        ok: false,
        reason: qr.ageSeconds < 0
          ? `还没有二维码（${qr.file === '' ? '配置里没写 napcatQr，也推不出路径' : `读不到 ${qr.file}`}）：先点「启动 NapCat」`
          : `二维码已经过期（${qr.ageSeconds} 秒前的那张，超过 ${QR_STALE_SECONDS} 秒）——点「重新登录（扫码）」刷新`,
      })
      return
    }
    try {
      const image = readBinary(qr.file)
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': String(image.length) })
      response.end(image)
    } catch (error) {
      sendJson(response, 500, { ok: false, reason: `读二维码失败：${error?.message ?? error}` })
    }
  }

  const registrations = [
    {
      kind: 'exact',
      path: '/qqai/napcat/qr',
      handler: (request, response) => { qrEntry(request, response); return undefined },
    },
    {
      kind: 'exact',
      path: '/qqai/panel',
      // 返回 promise：宿主不关心返回值，但调用方（含单测）可以 await 到真正写完响应。
      handler: (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return undefined }
        return snapshot()
          .then((payload) => sendJson(response, 200, payload))
          .catch((error) => sendJson(response, 500, { ok: false, reason: `读取面板失败：${error?.message ?? error}` }))
      },
    },
    {
      kind: 'exact',
      path: '/qqai/account',
      // 返回 promise：宿主不关心返回值，但调用方（含单测）可以 await 到真正写完响应。
      handler: (request, response) => {
        const ask = { pluginRoot: linkSources.root ?? PLUGIN_ROOT, readFile }
        try {
          return Promise.resolve(accountEntry(request, response, ask))
            .catch((error) => sendJson(response, 500, { ok: false, reason: `账号入口失败：${error?.message ?? error}` }))
        } catch (error) {
          sendJson(response, 500, { ok: false, reason: `账号入口失败：${error?.message ?? error}` })
          return undefined
        }
      },
    },
    {
      kind: 'exact',
      path: '/qqai/console',
      handler: (request, response) => consoleEntry(request, response).catch((error) => {
        sendJson(response, 500, { ok: false, reason: `调试台入口失败：${error?.message ?? error}` })
      }),
    },
    {
      kind: 'exact',
      path: '/qqai/napcat/start',
      handler: (request, response) => napcatAction(request, response, 'start')
        .catch((error) => sendJson(response, 500, { ok: false, reason: `启动失败：${error?.message ?? error}` })),
    },
    {
      kind: 'exact',
      path: '/qqai/napcat/relogin',
      handler: (request, response) => napcatAction(request, response, 'relogin')
        .catch((error) => sendJson(response, 500, { ok: false, reason: `重启登录失败：${error?.message ?? error}` })),
    },
    {
      kind: 'exact',
      path: '/qqai/panel/set',
      handler: async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
        /**
         * 跨站写保护（对抗性审查实测：来自任意网页的 `text/plain` 简单请求可以改配置，无需预检）。
         * 本机服务不能只靠"只有我能访问"——浏览器会把第三方页面的请求带到这里。两道闸：
         *   ① 必须是 JSON 的 Content-Type（`text/plain` 这类 CORS 简单请求直接拒）；
         *   ② `Sec-Fetch-Site` / `Origin` 必须同源（没有 Origin 的本机脚本/curl 放行）。
         */
        const guard = sameSiteGuard(request)
        if (!guard.ok) { sendJson(response, 403, { ok: false, reason: guard.reason }); return }
        let body
        try { body = await readBody(request) } catch (error) {
          sendJson(response, 400, { ok: false, reason: `请求体不是合法 JSON：${error.message}` })
          return
        }
        const key = String(body?.key ?? '')
        const value = body?.value
        if (!PANEL_KEYS.includes(key)) {
          sendJson(response, 400, { ok: false, reason: `不在面板白名单里的键：${key || '(空)'}` })
          return
        }
        if (typeof value !== 'boolean') {
          sendJson(response, 400, { ok: false, reason: '只接受布尔开关（true/false）' })
          return
        }
        const { yaml, reason } = readPatch()
        if (yaml === null) {
          sendJson(response, 400, { ok: false, reason: reason || `这个 profile 还没有配置文件：${patchFile}` })
          return
        }
        const result = upsertPatchValue(yaml, key, value, { pluginId: PLUGIN_ID })
        if (result.ok !== true) {
          sendJson(response, 400, { ok: false, reason: result.reason })
          return
        }
        if (result.changed) {
          try {
            ensureDir(dirname(patchFile))
            copy(patchFile, `${patchFile}.bak-qqai`)
            await writeAtomic(patchFile, result.yaml)
          } catch (error) {
            sendJson(response, 500, { ok: false, reason: `写入失败（原文件保持不动）：${error.message}` })
            return
          }
          logger.info(`QQ助手 面板：${key} → ${value}（写入 ${patchFile}，备份 .bak-qqai）`)
        }
        sendJson(response, 200, {
          ok: true,
          changed: result.changed === true,
          key,
          value,
          profile,
          patchFile,
          note: result.changed ? PANEL_NOTES.apply : result.reason,
          panel: await snapshot(),
        })
      },
    },
  ]

  const disposers = []
  try {
    for (const registration of registrations) disposers.push(host.webServer.register(registration))
  } catch (error) {
    // 注册到一半失败（比如路由撞名）必须把已注册的收回去，否则下次挂载会继续撞。
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 回收失败也只能记一笔 */ }
    }
    throw error
  }
  return () => {
    // 必须注销：配置改动会让 DSH 重建这个插件条目（fiber 重挂），而
    // `webServer.register` 对**重复的 (kind, path) 会直接抛**——不注销的话
    // 第一次改开关就会把面板搞坏。
    for (const dispose of disposers) {
      try { dispose() } catch (error) { logger.warn(`QQ助手 面板路由注销失败：${error?.message ?? error}`) }
    }
  }
}

/** 面板分组（给控制台/文档复用）。 */
export { PANEL_GROUPS }
