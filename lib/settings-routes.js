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
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PANEL_GROUPS, PANEL_KEYS, PANEL_NOTES, panelFooterLinksWithConsole, panelSnapshot, readPatchValue, upsertPatchValue,
} from './panel.js'

const PLUGIN_ID = 'dsh-qq-onebot-bridge'
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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
  response.writeHead(302, { location: napcatWebUiUrl({ pluginRoot, readFile }), 'cache-control': 'no-store' })
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
  } = options
  const patchFile = join(dir ?? profileDirOf(profile, env), 'cordis.patch.yml')
  const sources = panelLinkSources(linkSources)

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
    }
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
    if (status.running) {
      const control = readJsonSafe(join(linkSources.root ?? PLUGIN_ROOT, 'qq-control.json'), readFile)
      const token = typeof control?.token === 'string' ? control.token : ''
      const location = `http://127.0.0.1:${sources.consolePort}/${token ? `?token=${encodeURIComponent(token)}` : ''}`
      response.writeHead(302, { location, 'cache-control': 'no-store' })
      response.end()
      return
    }
    const command = consoleStartCommand(linkSources.root ? { root: linkSources.root } : {})
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

  const registrations = [
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
