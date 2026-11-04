/**
 * 账号中心（本地网站的数据层）—— v0.7.11
 *
 * 目标：**不借 NapCat 的网页，也能在本机看到账号、扫码登录、快速登录、设自动登录**。
 * 所有请求都打到本机 NapCat WebUI（`127.0.0.1:6099` 或 `webui.json` 里配的地址），不经过任何第三方。
 *
 * WebUI 的契约**不是标准**（跟 OneBot v11 不同），这里按 NapCat 源码固定下来：
 *
 *   POST /api/auth/login          { hash, totpCode? } → { code:0, data:{ Credential } } | { code:0, data:{ require2FA:true } }
 *   POST /api/QQLogin/CheckLoginStatus   → { code:0, data:{ isLogin, isOffline, ... } }
 *   POST /api/QQLogin/GetQQLoginQrcode   → { code:0, data:{ qrcode } }
 *   ALL  /api/QQLogin/GetQuickLoginList  → { code:0, data:<list> }
 *   POST /api/QQLogin/SetQuickLogin      { uin }
 *   POST /api/QQLogin/GetQuickLoginQQ    → { code:0, data:<uin> }
 *   POST /api/QQLogin/SetQuickLoginQQ    { uin }
 *
 *   · `hash = sha256(token + '.napcat')`（NapCat 的 `generatePasswordHash` 就是这么算的）；
 *   · 之后所有 `/api/*` 都要 `Authorization: Bearer <Credential>`（base64 封的 JSON 凭证，1 小时有效）；
 *   · 响应恒为 HTTP 200，成败看 `code`（0 = 成功）；
 *   · 凭证**只在内存**，不落盘、不进前端；token 也只从 `webui.json` 读到服务端为止。
 *
 * 版本差异：不同 NapCat 版本的 HTTP 方法变过（有 issue 记录 v4.18.x 前端 GET 打到只收 POST 的路由），
 * 所以 `request()` 支持**方法回退**（404 时换 GET/POST 重试一次），并把"这个路由不支持"如实分类。
 */

import { createHash } from 'node:crypto'
import { spawn , execFileSync } from 'node:child_process'
import { mkdirSync, copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** NapCat WebUI 的端点（按源码固定；`method` 只是首选，失败会回退）。 */
export const WEBUI_ROUTES = Object.freeze({
  login: { path: '/api/auth/login', method: 'POST' },
  status: { path: '/api/QQLogin/CheckLoginStatus', method: 'POST' },
  qrcode: { path: '/api/QQLogin/GetQQLoginQrcode', method: 'POST' },
  quickList: { path: '/api/QQLogin/GetQuickLoginList', method: 'GET' },
  quickLogin: { path: '/api/QQLogin/SetQuickLogin', method: 'POST' },
  getAutoLogin: { path: '/api/QQLogin/GetQuickLoginQQ', method: 'POST' },
  setAutoLogin: { path: '/api/QQLogin/SetQuickLoginQQ', method: 'POST' },
  refreshQr: { path: '/api/QQLogin/RefreshQRcode', method: 'POST' },
  // 只读信息（页面顶部"这是哪个 NapCat / QQ"）
  restart: { path: '/api/QQLogin/RestartNapCat', method: 'POST' },
  napcatVersion: { path: '/api/base/GetNapCatVersion', method: 'GET' },
  qqVersion: { path: '/api/base/QQVersion', method: 'GET' },
  sysStatus: { path: '/api/base/GetSysStatusRealTime', method: 'GET', sse: true },
  guidBackups: { path: '/api/QQLogin/GetGUIDBackups', method: 'POST' },
  loginInfo: { path: '/api/QQLogin/GetQQLoginInfo', method: 'POST' },
  logList: { path: '/api/Log/GetLogList', method: 'GET' },
  logFile: { path: '/api/Log/GetLog', method: 'GET' },
  logLive: { path: '/api/Log/GetLogRealTime', method: 'GET', sse: true },
  pluginList: { path: '/api/Plugin/List', method: 'GET' },
  fileHash: { path: '/api/base/GetNapCatFileHash', method: 'GET' },
  latestTag: { path: '/api/base/getLatestTag', method: 'GET' },
  mirrors: { path: '/api/base/getMirrors', method: 'GET' },
  storeList: { path: '/api/Plugin/Store/List', method: 'GET' },
  pluginStatus: { path: '/api/Plugin/SetStatus', method: 'POST' },
  pluginUninstall: { path: '/api/Plugin/Uninstall', method: 'POST' },
})

/** `sha256(token + '.napcat')` —— 与 NapCat `AuthHelper.generatePasswordHash` 同算法。 */
export function hashWebUiToken(token) {
  return createHash('sha256').update(`${String(token ?? '')}.napcat`).digest('hex')
}

/** token 只用来"你填的是哪个"，前端展示一律打码。 */
export function maskToken(token) {
  const text = String(token ?? '')
  if (text === '') return ''
  if (text.length <= 6) return '***'
  return `${text.slice(0, 3)}…${text.slice(-2)}（${text.length} 位）`
}

/** NapCat 的 `bootmain/config` 目录（由启动脚本推出；配置里也能直接给）。 */
export function napcatConfigDir({ napcatBat = '' } = {}) {
  return napcatBat === '' ? '' : join(dirname(napcatBat), 'config')
}

/**
 * 读 `webui.json`。**返回给调用方的对象里带 token**，所以只能在服务端用；
 * 给前端的数据必须经过 `publicWebUiConfig()`。
 */
export function readWebUiConfig({ napcatBat = '', file = '', readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  const configDir = napcatConfigDir({ napcatBat })
  const path = file !== '' ? file : (configDir === '' ? '' : join(configDir, 'webui.json'))
  const base = { path, exists: false, host: '', port: 0, token: '', url: '', autoLoginAccount: '', enable2FA: false, reason: '' }
  if (path === '' || existsSync(path) === false) {
    return { ...base, reason: '没找到 webui.json（NapCat 还没装，或启动脚本路径不对）' }
  }
  try {
    const json = JSON.parse(readFile(path))
    const host = String(json.host ?? '') === '::' ? '127.0.0.1' : String(json.host ?? '127.0.0.1')
    const port = Number(json.port) || 0
    const token = String(json.token ?? '')
    return {
      ...base,
      exists: true,
      host: host === '' || host === '0.0.0.0' ? '127.0.0.1' : host,
      port,
      token,
      url: port > 0 ? `http://${host === '' ? '127.0.0.1' : host}:${port}` : '',
      autoLoginAccount: String(json.autoLoginAccount ?? ''),
      enable2FA: json.enable2FA === true,
      reason: '',
    }
  } catch (error) {
    return { ...base, exists: true, reason: `webui.json 读不出来：${String(error?.message ?? error).slice(0, 80)}` }
  }
}

/** 给前端的安全投影：**绝不带 token**。 */
export function publicWebUiConfig(config = {}) {
  return {
    exists: config.exists === true,
    host: config.host ?? '',
    port: Number(config.port) || 0,
    url: config.url ?? '',
    tokenMasked: maskToken(config.token),
    hasToken: String(config.token ?? '') !== '',
    autoLoginAccount: config.autoLoginAccount ?? '',
    enable2FA: config.enable2FA === true,
    reason: config.reason ?? '',
  }
}

/**
 * 从 `bootmain/config` 里列出账号：`onebot11_<uin>.json` / `napcat_<uin>.json` 的文件名就是 QQ 号。
 * `instance` 预留：将来多实例并行时同一个 uin 可以有多个（不同目录/端口）。
 */
export function listAccounts({ napcatBat = '', dir = '', readdir = (path) => readdirSync(path) } = {}) {
  const configDir = dir !== '' ? dir : napcatConfigDir({ napcatBat })
  if (configDir === '' || existsSync(configDir) === false) return []
  let names = []
  try { names = readdir(configDir) } catch { return [] }
  const byUin = new Map()
  for (const name of names) {
    const match = /^(onebot11|napcat|napcat_protocol)_(\d{5,12})\.json$/.exec(name)
    if (match === null) continue
    const uin = match[2]
    const row = byUin.get(uin) ?? { uin, instance: 'default', hasOneBotConfig: false, hasNapCatConfig: false, files: [] }
    if (match[1] === 'onebot11') row.hasOneBotConfig = true
    if (match[1] === 'napcat') row.hasNapCatConfig = true
    row.files.push(name)
    byUin.set(uin, row)
  }
  return [...byUin.values()].sort((a, b) => a.uin.localeCompare(b.uin))
}

/**
 * 把一次 WebUI 响应分类成"能不能用、为什么不能用"。
 * 三类值得分开：**连不上**（NapCat 没起）、**没权限**（token 错/凭证过期）、**版本不支持**（路由 404）。
 */
export function classifyWebUiFailure({ status = 0, payload = null, error = null } = {}) {
  if (error !== null && error !== undefined) {
    const message = String(error?.message ?? error)
    if (/ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|EACCES|timed out/i.test(message)) {
      return { kind: 'unreachable', message: '连不上本机 NapCat WebUI（它没在运行，或端口不对）' }
    }
    return { kind: 'error', message }
  }
  if (status === 404) return { kind: 'unsupported', message: '这个 NapCat 版本没有该接口（HTTP 404）' }
  const code = Number(payload?.code)
  const message = String(payload?.message ?? '')
  if (/Unauthorized|token is invalid|token is empty|revoked/i.test(message)) {
    return { kind: 'unauthorized', message: `NapCat 拒绝了凭证：${message}` }
  }
  if (code !== 0) return { kind: 'error', message: message === '' ? `WebUI 返回 code=${payload?.code}` : message }
  return { kind: 'ok', message: '' }
}

/**
 * WebUI 客户端：登录换凭证 → 带 Bearer 调接口；凭证过期自动重登一次。
 * 所有依赖（`fetch`、时钟）都可注入，便于单测。
 */
export function createWebUiClient({
  baseUrl = 'http://127.0.0.1:6099',
  token = '',
  totpCode = '',
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  timeoutMs = 8000,
  // v0.7.11：凭证可以**跨请求复用**（否则开了 2FA 时，每个请求都要重新输 6 位码）。
  credentialSeed = '',
  onCredential = null,
} = {}) {
  let credential = String(credentialSeed ?? '')
  let credentialAt = credential === '' ? 0 : now()
  let require2FA = false
  const stats = { calls: 0, logins: 0, lastError: '' }

  const post = async (path, { method = 'POST', body = null, auth = false } = {}) => {
    const headers = { 'content-type': 'application/json' }
    if (auth && credential !== '') headers.authorization = `Bearer ${credential}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs))
    try {
      stats.calls += 1
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      let payload = null
      try { payload = text === '' ? null : JSON.parse(text) } catch { payload = null }
      return { status: res.status, payload }
    } catch (error) {
      // 网络层失败（NapCat 没起 / 端口不对 / 超时）**不许**冒泡成未捕获异常：
      // 统一交给 classifyWebUiFailure 分类成 `unreachable`，让界面说人话。
      return { status: 0, payload: null, error }
    } finally {
      clearTimeout(timer)
    }
  }

  const login = async () => {
    stats.logins += 1
    const body = { hash: hashWebUiToken(token) }
    if (totpCode !== '') body.totpCode = totpCode
    const { status, payload, error } = await post(WEBUI_ROUTES.login.path, { method: WEBUI_ROUTES.login.method, body })
    const failure = classifyWebUiFailure({ status, payload, error })
    if (failure.kind !== 'ok') return { ok: false, ...failure, require2FA: false }
    if (payload?.data?.require2FA === true) {
      require2FA = true
      return { ok: false, kind: 'need-2fa', message: '这个 WebUI 开了 2FA，需要填 6 位验证码', require2FA: true }
    }
    const next = payload?.data?.Credential
    if (typeof next !== 'string' || next === '') {
      return { ok: false, kind: 'error', message: '登录成功但没拿到凭证（NapCat 版本差异）', require2FA: false }
    }
    credential = next
    credentialAt = now()
    if (typeof onCredential === 'function') {
      try { onCredential(next, credentialAt) } catch { /* 缓存失败不影响本次调用 */ }
    }
    return { ok: true, kind: 'ok', message: '', require2FA: false }
  }

  const request = async (route, { body = null, retryAuth = true, methodFallback = true, query = null } = {}) => {
    const path = query === null ? route.path : `${route.path}?${new URLSearchParams(query).toString()}`
    if (credential === '') {
      const first = await login()
      if (first.ok !== true) return { ok: false, ...first }
    }
    let attempt = await post(path, { method: route.method, body, auth: true })
    let failure = classifyWebUiFailure(attempt)
    // 401 类：凭证过期或换了 token → 重登一次再试（只重试一次，避免死循环）。
    if (failure.kind === 'unauthorized' && retryAuth) {
      credential = ''
      const again = await login()
      if (again.ok !== true) return { ok: false, ...again }
      attempt = await post(path, { method: route.method, body, auth: true })
      failure = classifyWebUiFailure(attempt)
    }
    // 404：这个版本的路由方法可能相反（source 里 get/post 都出现过）→ 换方法再试一次。
    if (failure.kind === 'unsupported' && methodFallback) {
      const other = route.method === 'POST' ? 'GET' : 'POST'
      attempt = await post(path, { method: other, body, auth: true })
      failure = classifyWebUiFailure(attempt)
      if (failure.kind === 'ok') stats.methodFallback = other
    }
    if (failure.kind !== 'ok') {
      stats.lastError = failure.message
      return { ok: false, ...failure }
    }
    return { ok: true, kind: 'ok', message: '', data: attempt.payload?.data ?? null }
  }

  return {
    login,
    request,
    get credential() { return credential },
    get credentialAt() { return credentialAt },
    get require2FA() { return require2FA },
    stats,
    /** 便捷方法：失败时都返回 `{ ok:false, kind, message }`，前端只需看 kind。 */
    status: () => request(WEBUI_ROUTES.status),
    qrcode: () => request(WEBUI_ROUTES.qrcode),
    quickList: () => request(WEBUI_ROUTES.quickList),
    quickLogin: (uin) => request(WEBUI_ROUTES.quickLogin, { body: { uin: String(uin) }, methodFallback: false }),
    getAutoLogin: () => request(WEBUI_ROUTES.getAutoLogin),
    setAutoLogin: (uin) => request(WEBUI_ROUTES.setAutoLogin, { body: { uin: String(uin) }, methodFallback: false }),
    napcatVersion: () => request(WEBUI_ROUTES.napcatVersion),
    qqVersion: () => request(WEBUI_ROUTES.qqVersion),
    /**
     * 系统状态。`GetSysStatusRealTime` 是 **SSE**（`text/event-stream`），不是普通 JSON：
     * 普通 fetch 会一直挂到超时（实测 8s 被 abort），所以这里**读一帧 `data:` 就断开**。
     */
    sysStatus: async () => {
      const route = WEBUI_ROUTES.sysStatus
      const doFetch = async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Math.max(800, timeoutMs))
        try {
          if (credential === '') {
            const first = await login()
            if (first.ok !== true) return { ok: false, ...first }
          }
          return await fetchImpl(`${baseUrl}${route.path}`, {
            method: route.method,
            headers: { authorization: `Bearer ${credential}`, accept: 'text/event-stream' },
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timer)
        }
      }
      let res
      try {
        res = await doFetch()
        if (res && typeof res.ok === 'boolean' && res.ok === false && res.status === 401) {
          credential = ''
          const again = await login()
          if (again.ok !== true) return { ok: false, ...again }
          res = await doFetch()
        }
      } catch (error) {
        const failure = classifyWebUiFailure({ error })
        return { ok: false, ...failure }
      }
      if (res === undefined || res === null) return { ok: false, kind: 'unsupported', message: '这个版本没有系统状态接口' }
      if (typeof res.status === 'number' && res.status === 404) return { ok: false, kind: 'unsupported', message: '这个版本没有系统状态接口（HTTP 404）' }
      try {
        // 优先流式读第一帧；没有 body 的桩实现就退化成整体读文本。
        const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null
        let buffer = ''
        if (reader !== null) {
          const deadline = Date.now() + Math.max(800, timeoutMs)
          while (Date.now() < deadline) {
            const chunk = await reader.read()
            if (chunk.done) break
            buffer += new TextDecoder().decode(chunk.value)
            if (buffer.includes('\n\n')) break
          }
          try { await reader.cancel() } catch { /* 已经关了 */ }
        } else if (typeof res.text === 'function') {
          buffer = await res.text()
        } else if (typeof res.json === 'function') {
          const payload = await res.json()
          return { ok: true, kind: 'ok', message: '', data: payload?.data ?? payload }
        } else {
          return { ok: false, kind: 'unsupported', message: '这个实现没有返回可读的系统状态（既不是流也不是文本）' }
        }
        const line = buffer.split('\n').find((item) => item.startsWith('data:'))
        if (line === undefined) return { ok: false, kind: 'error', message: '系统状态没有返回数据帧' }
        const data = JSON.parse(line.slice(5).trim())
        return { ok: true, kind: 'ok', message: '', data }
      } catch (error) {
        return { ok: false, kind: 'error', message: `系统状态解析失败：${error?.message ?? error}` }
      }
    },
    guidBackups: () => request(WEBUI_ROUTES.guidBackups),
    loginInfo: () => request(WEBUI_ROUTES.loginInfo),
    logList: () => request(WEBUI_ROUTES.logList),
    pluginList: () => request(WEBUI_ROUTES.pluginList),
    fileHash: () => request(WEBUI_ROUTES.fileHash),
    latestTag: () => request(WEBUI_ROUTES.latestTag),
    mirrors: () => request(WEBUI_ROUTES.mirrors),
    setPluginStatus: (id, enable) => request(WEBUI_ROUTES.pluginStatus, { body: { id: String(id), enable: enable === true }, methodFallback: false }),
    uninstallPlugin: (id, cleanData = false) => request(WEBUI_ROUTES.pluginUninstall, { body: { id: String(id), cleanData: cleanData === true }, methodFallback: false }),
    logFile: (id) => request(WEBUI_ROUTES.logFile, { query: { id: String(id) } }),

    /**
     * **实时日志流**：`/api/Log/GetLogRealTime` 是 SSE。这里返回底层 Response，
     * 由控制台服务端把 `data:` 逐行转发给浏览器（浏览器的 EventSource 不能加 Authorization 头）。
     * 调用方负责 `reader.cancel()`。
     */
    async logLive() {
      if (credential === '') {
        const first = await login()
        if (first.ok !== true) return { ok: false, ...first }
      }
      try {
        const res = await fetchImpl(`${baseUrl}${WEBUI_ROUTES.logLive.path}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${credential}`, accept: 'text/event-stream' },
          signal: AbortSignal.timeout(10 * 60 * 1000),
        })
        if (res.status === 404) return { ok: false, kind: 'unsupported', message: '这个版本没有实时日志接口' }
        if (res.status === 401) return { ok: false, kind: 'unauthorized', message: 'NapCat 拒绝了凭证' }
        return { ok: true, kind: 'ok', message: '', response: res }
      } catch (error) {
        return { ok: false, ...classifyWebUiFailure({ error }) }
      }
    },
    restartNapcat: () => request(WEBUI_ROUTES.restart, { methodFallback: false }),
  }
}

/** 一句话状态（控制台顶部/CLI 共用）。 */
export function describeAccountState({ webui = null, status = null, accounts = [] } = {}) {
  if (webui !== null && webui.exists !== true) return webui.reason || '没有 webui.json'
  if (status === null) return '还没查登录状态'
  if (status.ok !== true) return `查不到登录状态：${status.message}`
  const online = status.data?.isLogin === true
  const offline = status.data?.isOffline === true
  const auto = webui?.autoLoginAccount ? `；自动登录 ${webui.autoLoginAccount}` : ''
  const known = accounts.length > 0 ? `；本机 ${accounts.length} 个账号配置` : ''
  return online ? `已登录在线${auto}${known}` : offline ? `已登录但离线${auto}${known}` : `未登录${auto}${known}`
}

/**
 * 控制台用的账号 API：**每次调用都重读 `webui.json`**（用户可能刚改过 token/端口）。
 *
 * 凭证**按 (url + token) 缓存 50 分钟**：
 *   · 不缓存 → 开了 2FA 的 WebUI 每个请求都要重输 6 位码（不可用）；
 *   · 缓存 → 一次 2FA 之后一小时内所有操作都顺；
 *   · token 一改，key 就变，旧凭证自动作废（不会拿旧凭证去撞新配置）。
 */
  /**
   * QQ 头像：由**服务端**去 qlogo 取（浏览器不直连第三方，也就不会把 token 带出去）。
   * 只缓存 1 小时；取不到就如实返回失败，页面回退成鲸鱼表情。
   */
  const avatarCache = new Map()   // uin → { at, contentType, buffer }
  const AVATAR_TTL = 60 * 60 * 1000
  const fetchAvatar = async (uin, doFetch) => {
    const clean = String(uin ?? '')
    if (/^\d{4,12}$/.test(clean) === false) return { ok: false, kind: 'bad-input', message: 'QQ 号格式不对' }
    const cached = avatarCache.get(clean)
    if (cached && Date.now() - cached.at < AVATAR_TTL) return { ok: true, kind: 'ok', ...cached }
    try {
      const url = 'https://q1.qlogo.cn/g?b=qq&nk=' + clean + '&s=160'
      const response = await doFetch(url)
      if (!response.ok) return { ok: false, kind: 'error', message: 'qlogo 返回 ' + response.status }
      const buffer = Buffer.from(await response.arrayBuffer())
      const contentType = response.headers.get('content-type') ?? 'image/jpeg'
      const record = { at: Date.now(), contentType, buffer }
      avatarCache.set(clean, record)
      return { ok: true, kind: 'ok', ...record }
    } catch (error) {
      return { ok: false, kind: 'unreachable', message: '取头像失败：' + String(error?.message ?? error).slice(0, 80) }
    }
  }

  /** 启动 NapCat 用哪个 QQ：优先 autoLoginAccount，其次配置目录里的 onebot11_<uin>.json。 */
/** 仓库根：本文件在 control/lib/ 下，上两级就是根。 */
const repoRoot = () => join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 版本检查的 10 分钟缓存（进程内）。 */
const latestReleaseCache = { value: null, at: 0 }

export function createAccountsApi({ napcatBat = '', webUiFile = '', fetchImpl = undefined } = {}) {
  const readConfig = () => readWebUiConfig({ napcatBat, file: webUiFile })
  /**
   * 启动 NapCat 用哪个 QQ：优先 autoLoginAccount，其次配置目录（含 bootmain/config）里的 onebot11_<uin>.json。
   * ⚠️ 必须定义在工厂内部：它依赖 readConfig；放模块作用域会 ReferenceError，并被 catch 静默吞成空串。
   */
  const readPreferredUin = (extraDirs = []) => {
    try {
      const config = readConfig()
      const dirs = []
      if (config.exists === true) {
        const json = JSON.parse(readFileSync(config.path, 'utf8'))
        if (typeof json.autoLoginAccount === 'string' && /^\d{5,12}$/.test(json.autoLoginAccount)) return json.autoLoginAccount
        dirs.push(dirname(config.path))
      }
      for (const extra of extraDirs) if (typeof extra === 'string' && extra !== '') dirs.push(extra)
      for (const dir of dirs) {
        try {
          const found = readdirSync(dir).find((name) => /^onebot11_(\d{5,12})\.json$/.test(name))
          if (found) return found.replace(/^onebot11_/, '').replace(/\.json$/, '')
        } catch { /* 换下一个目录 */ }
      }
      return ''
    } catch {
      return ''
    }
  }
  const credentials = new Map()   // key: `${url}|${token}` → { credential, at }
  let sysCache = { at: 0, data: null }   // 系统状态（SSE 要等一帧，缓存 20s 免得页面每次等 3 秒）
  const CREDENTIAL_TTL_MS = 50 * 60 * 1000
  const client = (config, { totpCode = '' } = {}) => {
    const key = `${config.url}|${config.token}`
    const cached = credentials.get(key)
    const fresh = cached !== undefined && (Date.now() - cached.at) < CREDENTIAL_TTL_MS
    return createWebUiClient({
      baseUrl: config.url,
      token: config.token,
      ...(totpCode !== '' ? { totpCode } : {}),
      ...(fresh ? { credentialSeed: cached.credential } : {}),
      onCredential: (credential, at) => credentials.set(key, { credential, at }),
      ...(fetchImpl ? { fetchImpl } : {}),
    })
  }
  const guard = (config) => config.exists === true && config.url !== '' && config.token !== ''

  return {
    /** 概览：配置（已脱敏）+ 账号清单；不触发任何网络请求。 */
    summary() {
      const config = readConfig()
      const webui = publicWebUiConfig(config)
      const accounts = listAccounts({ napcatBat, dir: webui.exists ? dirname(config.path) : '' })
      return { ok: webui.exists && webui.hasToken, webui, accounts, state: describeAccountState({ webui, accounts }) }
    },
    async status() {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      return client(config).status()
    },
    async qrcode() {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      return client(config).qrcode()
    },
    async quickList() {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      return client(config).quickList()
    },
    async quickLogin(uin) {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      return client(config).quickLogin(uin)
    },
    async setAutoLogin(uin) {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      return client(config).setAutoLogin(uin)
    },
    /** NapCat 日志：不带 file 返回列表，带 file 返回内容（都只读）。 */
    async logs(file = '') {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      const one = client(config)
      if (String(file) === '') return one.logList()
      return one.logFile(file)
    },
    /** 实时日志：返回底层 Response，由控制台服务端转发 SSE（浏览器 EventSource 加不了 Authorization）。 */
    async logLive() {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      return client(config).logLive()
    },
    /** 启用/停用插件（写操作：只动 NapCat 的插件状态表，不碰插件目录）。 */
    async setPluginStatus(id, enable) {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      if (String(id ?? '') === '') return { ok: false, kind: 'bad-input', message: '缺少插件 id' }
      return client(config).setPluginStatus(id, enable)
    },
    /** 卸载插件（破坏性：界面上必须二次确认）。 */
    async uninstallPlugin(id, cleanData = false) {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      if (String(id ?? '') === '') return { ok: false, kind: 'bad-input', message: '缺少插件 id' }
      return client(config).uninstallPlugin(id, cleanData)
    },
    /** NapCat 的插件列表。 */
    async plugins() {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      const result = await client(config).pluginList()
      // 0.8.2：顺手把插件目录的**结构**带回去（只看一级目录名，不读内容）
      const dir = dirname(config.path)
      const pluginDir = join(dir, 'plugins')
      let tree = { exists: false, dir: pluginDir, entries: [] }
      if (existsSync(pluginDir)) {
        try {
          const names = readdirSync(pluginDir)
          tree = {
            exists: true,
            dir: pluginDir,
            entries: names.slice(0, 50).map((name) => {
              const full = join(pluginDir, name)
              let isDir = false
              let hasConfig = false
              let hasPages = false
              try { isDir = statSync(full).isDirectory() } catch { /* 忽略 */ }
              if (isDir) {
                hasConfig = existsSync(join(full, 'config'))
                hasPages = existsSync(join(full, 'pages'))
              }
              return { name, isDir, hasConfig, hasPages }
            }),
          }
        } catch { /* 读不了就保持空 */ }
      }
      return { ...result, tree }
    },
    /** 插件商店列表（只读；安装请去 NapCat 自己点）。 */
    async store() {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      return client(config).storeList()
    },
    /**
     * 网络配置：读 `onebot11_<uin>.json` 里的 servers 段（真正的"机器人怎么连"就在这）。
     * 只解析、不改写 —— 改配置继续在 NapCat 的界面或文件里做。
     */
    network() {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      if (dir === '') return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置', accounts: [] }
      const rows = []
      for (const account of listAccounts({ dir })) {
        const file = join(dir, `onebot11_${account.uin}.json`)
        if (existsSync(file) === false) continue
        try {
          const json = JSON.parse(readFileSync(file, 'utf8'))
          const servers = Array.isArray(json.network?.websocketServers) ? json.network.websocketServers
            : Array.isArray(json.websocketServers) ? json.websocketServers : []
          const clients = Array.isArray(json.network?.websocketClients) ? json.network.websocketClients
            : Array.isArray(json.websocketClients) ? json.websocketClients : []
          const https = Array.isArray(json.network?.httpServers) ? json.network.httpServers : []
          rows.push({ uin: account.uin, file: `onebot11_${account.uin}.json`, servers, clients, https })
        } catch (error) {
          rows.push({ uin: account.uin, file: `onebot11_${account.uin}.json`, error: String(error?.message ?? error).slice(0, 120), servers: [], clients: [], https: [] })
        }
      }
      return { ok: true, kind: 'ok', message: '', dir, accounts: rows }
    },
    /**
     * **改网络配置**（唯一一处会写 NapCat 文件的入口，所以规矩特别多）：
     *   ① 只碰 `network.websocketClients`（连我们 6700 的那份）与 `websocketServers[].port`；
     *   ② 写之前先把原文件复制成 `onebot11_<uin>.json.bak-<时间戳>`（不删任何东西）；
     *   ③ 校验：URL 必须 ws:// 或 wss://、最多 8 条；端口 1–65535；
     *   ④ 返回 `requiresRestart: true` —— NapCat 要重启才重新读这份配置。
     */
    updateNetwork({ uin, clients = null, serverPort = null, readFile = readFileSync, writeFile = writeFileSync, copyFile = copyFileSync, now = () => Date.now() } = {}) {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      const cleanUin = String(uin ?? '').trim()
      if (!/^\d{5,12}$/.test(cleanUin)) return { ok: false, kind: 'bad-input', message: 'QQ 号格式不对' }
      if (dir === '') return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      const file = join(dir, `onebot11_${cleanUin}.json`)
      if (existsSync(file) === false) return { ok: false, kind: 'not-found', message: `没有这个账号的 OneBot 配置：${file}` }

      let json
      try { json = JSON.parse(readFile(file, 'utf8')) } catch (error) {
        return { ok: false, kind: 'error', message: `配置读不出来（不是合法 JSON）：${String(error?.message ?? error).slice(0, 100)}` }
      }

      // 校验 clients
      let nextClients = null
      if (clients !== null) {
        if (Array.isArray(clients) === false) return { ok: false, kind: 'bad-input', message: 'clients 必须是数组' }
        if (clients.length > 8) return { ok: false, kind: 'bad-input', message: '最多 8 条 WS 客户端地址' }
        nextClients = []
        for (const raw of clients) {
          const url = String(raw ?? '').trim()
          if (url === '') continue
          if (url.length > 300) return { ok: false, kind: 'bad-input', message: '单条地址太长（>300 字）' }
          if (/^wss?:\/\/[^\s]+$/i.test(url) === false) return { ok: false, kind: 'bad-input', message: `地址必须以 ws:// 或 wss:// 开头：${url.slice(0, 80)}` }
          nextClients.push(url)
        }
      }

      // 校验端口
      let nextPort = null
      if (serverPort !== null && serverPort !== '' && serverPort !== undefined) {
        const port = Number(serverPort)
        if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, kind: 'bad-input', message: '端口必须是 1–65535 的整数' }
        nextPort = port
      }

      const network = json.network ?? {}
      const beforeClients = Array.isArray(network.websocketClients) ? network.websocketClients : []
      const beforeServers = Array.isArray(network.websocketServers) ? network.websocketServers : []

      if (nextClients !== null) {
        network.websocketClients = nextClients.map((url) => ({ url, reportSelfMessage: false, token: '', messagePostFormat: 'array', debug: false, heartInterval: 30000, reconnectInterval: 3000, enable: true }))
      }
      if (nextPort !== null && beforeServers.length > 0) {
        network.websocketServers = beforeServers.map((item, index) => (index === 0 ? { ...item, port: nextPort } : item))
      }
      json.network = network

      const backup = `${file}.bak-${new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
      try { copyFile(file, backup) } catch (error) {
        return { ok: false, kind: 'error', message: `备份失败，未写入：${String(error?.message ?? error).slice(0, 100)}` }
      }
      try { writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8') } catch (error) {
        return { ok: false, kind: 'error', message: `写回失败（备份仍在 ${backup}）：${String(error?.message ?? error).slice(0, 100)}` }
      }
      return {
        ok: true, kind: 'ok', message: '已写入（要重启 NapCat 才生效）',
        file, backup, requiresRestart: true,
        before: { clients: beforeClients.map((item) => item.url ?? ''), serverPort: beforeServers[0]?.port ?? null },
        after: { clients: nextClients ?? beforeClients.map((item) => item.url ?? ''), serverPort: nextPort ?? beforeServers[0]?.port ?? null },
      }
    },
    /**
     * **整组替换** WS 客户端（对应页面上的 新建 / 删除 / 启停 / 编辑）。
     * 与 updateNetwork 的区别：那个是"按 URL 列表整体覆盖"，这里是"带 name/enable 的条目"，
     * 并且只改 websocketClients 一个数组，其它网络段原样不动。
     * 规矩：校验 URL 与条数 → 备份 .bak → 写入；任何一步失败都不写。
     */
    saveNetworkClients({ uin, clients = [], now = () => Date.now() } = {}) {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      if (dir === '') return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      const clean = String(uin ?? '').trim()
      if (!/^\d{5,12}$/.test(clean)) return { ok: false, kind: 'bad-input', message: 'QQ 号格式不对' }
      if (Array.isArray(clients) === false) return { ok: false, kind: 'bad-input', message: 'clients 必须是数组' }
      if (clients.length > 8) return { ok: false, kind: 'bad-input', message: '最多 8 条 WS 客户端' }
      const file = join(dir, 'onebot11_' + clean + '.json')
      if (existsSync(file) === false) return { ok: false, kind: 'not-found', message: '没有这个账号的 OneBot 配置：' + file }

      const next = []
      for (const item of clients) {
        const url = String(item?.url ?? '').trim()
        if (url === '') continue
        if (url.length > 300) return { ok: false, kind: 'bad-input', message: '单条地址太长（>300 字）' }
        if (/^wss?:\/\/[^\s]+$/i.test(url) === false) return { ok: false, kind: 'bad-input', message: '地址必须以 ws:// 或 wss:// 开头：' + url.slice(0, 80) }
        next.push({
          name: String(item?.name ?? '').trim() || ('ws-' + (next.length + 1)),
          url,
          enable: item?.enable !== false,
          reportSelfMessage: false, token: '', messagePostFormat: 'array', debug: false, heartInterval: 30000, reconnectInterval: 3000,
        })
      }

      let json
      try { json = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
        return { ok: false, kind: 'error', message: '配置读不出来：' + String(error?.message ?? error).slice(0, 100) }
      }
      const network = json.network ?? {}
      const kept = Array.isArray(network.websocketClients) ? network.websocketClients : []
      // 保留每条原有但界面上没暴露的字段（token / 心跳等），按 URL 匹配
      const merged = next.map((entry) => {
        const old = kept.find((item) => String(item.url ?? '') === entry.url)
        return old ? { ...old, name: entry.name, enable: entry.enable, url: entry.url } : entry
      })
      network.websocketClients = merged
      json.network = network

      const backup = file + '.bak-' + new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
      try { copyFileSync(file, backup) } catch (error) {
        return { ok: false, kind: 'error', message: '备份失败，未写入：' + String(error?.message ?? error).slice(0, 100) }
      }
      try { writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8') } catch (error) {
        return { ok: false, kind: 'error', message: '写入失败（备份在 ' + backup + '）：' + String(error?.message ?? error).slice(0, 100) }
      }
      return { ok: true, kind: 'ok', message: '已写入 ' + merged.length + ' 条（重启 NapCat 生效）', file, backup, requiresRestart: true, count: merged.length }
    },
    /**
     * **整组替换** Websocket 服务器段（端口 / 名称 / 启停）。
     * 与客户端那条路同规格：校验 → 备份 .bak → 写入；只动 network.websocketServers。
     */
    saveNetworkServers({ uin, servers = [], now = () => Date.now() } = {}) {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      if (dir === '') return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      const clean = String(uin ?? '').trim()
      if (!/^\d{5,12}$/.test(clean)) return { ok: false, kind: 'bad-input', message: 'QQ 号格式不对' }
      if (Array.isArray(servers) === false) return { ok: false, kind: 'bad-input', message: 'servers 必须是数组' }
      if (servers.length > 4) return { ok: false, kind: 'bad-input', message: '最多 4 个 WS 服务器' }
      const file = join(dir, 'onebot11_' + clean + '.json')
      if (existsSync(file) === false) return { ok: false, kind: 'not-found', message: '没有这个账号的 OneBot 配置：' + file }

      const next = []
      for (const item of servers) {
        const port = Number(item?.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, kind: 'bad-input', message: '端口必须是 1–65535 的整数（' + String(item?.port) + '）' }
        const name = String(item?.name ?? '').trim() || ('ws-server-' + (next.length + 1))
        if (name.length > 40) return { ok: false, kind: 'bad-input', message: '名称太长（≤40 字）' }
        const host = String(item?.host ?? '').trim()
        if (host.length > 64) return { ok: false, kind: 'bad-input', message: '监听地址太长（≤64 字）' }
        next.push({ name, port, host, enable: item?.enable !== false })
      }

      let json
      try { json = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
        return { ok: false, kind: 'error', message: '配置读不出来：' + String(error?.message ?? error).slice(0, 100) }
      }
      const network = json.network ?? {}
      const kept = Array.isArray(network.websocketServers) ? network.websocketServers : []
      network.websocketServers = next.map((entry, index) => ({ ...(kept[index] ?? {}), name: entry.name, port: entry.port, host: entry.host, enable: entry.enable }))
      json.network = network

      const backup = file + '.bak-' + new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
      try { copyFileSync(file, backup) } catch (error) {
        return { ok: false, kind: 'error', message: '备份失败，未写入：' + String(error?.message ?? error).slice(0, 100) }
      }
      try { writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8') } catch (error) {
        return { ok: false, kind: 'error', message: '写入失败（备份在 ' + backup + '）：' + String(error?.message ?? error).slice(0, 100) }
      }
      return { ok: true, kind: 'ok', message: '已写入 ' + next.length + ' 个 WS 服务器（重启 NapCat 生效）', file, backup, requiresRestart: true, count: next.length }
    },

    /** 整组替换 HTTP 服务器段（名称 / 端口 / 监听 / 启停）；规则与 WS 服务器一致。 */
    saveNetworkHttpServers({ uin, servers = [], now = () => Date.now() } = {}) {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      if (dir === '') return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      const clean = String(uin ?? '').trim()
      if (!/^\d{5,12}$/.test(clean)) return { ok: false, kind: 'bad-input', message: 'QQ 号格式不对' }
      if (Array.isArray(servers) === false) return { ok: false, kind: 'bad-input', message: 'servers 必须是数组' }
      if (servers.length > 4) return { ok: false, kind: 'bad-input', message: '最多 4 个 HTTP 服务器' }
      const file = join(dir, 'onebot11_' + clean + '.json')
      if (existsSync(file) === false) return { ok: false, kind: 'not-found', message: '没有这个账号的 OneBot 配置：' + file }

      const next = []
      for (const item of servers) {
        const port = Number(item?.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, kind: 'bad-input', message: '端口必须是 1–65535 的整数（' + String(item?.port) + '）' }
        const name = String(item?.name ?? '').trim() || ('http-server-' + (next.length + 1))
        if (name.length > 40) return { ok: false, kind: 'bad-input', message: '名称太长（≤40 字）' }
        const host = String(item?.host ?? '').trim()
        if (host.length > 64) return { ok: false, kind: 'bad-input', message: '监听地址太长（≤64 字）' }
        next.push({ name, port, host, enable: item?.enable !== false })
      }

      let json
      try { json = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
        return { ok: false, kind: 'error', message: '配置读不出来：' + String(error?.message ?? error).slice(0, 100) }
      }
      const network = json.network ?? {}
      const kept = Array.isArray(network.httpServers) ? network.httpServers : []
      network.httpServers = next.map((entry, index) => ({ ...(kept[index] ?? {}), name: entry.name, port: entry.port, host: entry.host, enable: entry.enable }))
      json.network = network

      const backup = file + '.bak-' + new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
      try { copyFileSync(file, backup) } catch (error) {
        return { ok: false, kind: 'error', message: '备份失败，未写入：' + String(error?.message ?? error).slice(0, 100) }
      }
      try { writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8') } catch (error) {
        return { ok: false, kind: 'error', message: '写入失败（备份在 ' + backup + '）：' + String(error?.message ?? error).slice(0, 100) }
      }
      return { ok: true, kind: 'ok', message: '已写入 ' + next.length + ' 个 HTTP 服务器（重启 NapCat 生效）', file, backup, requiresRestart: true, count: next.length }
    },

    /**
     * 改 webui.json 的**端口与监听地址**（唯一允许动的两项）。
     * 规矩：
     *   ① 地址只接受回环（127.0.0.1 / ::1 / localhost）—— 不允许 0.0.0.0，避免把面板暴露到局域网；
     *   ② 端口 1–65535，且不能等于控制台自己的端口（会打架）；
     *   ③ 写前备份 `webui.json.bak-<时间戳>`，备份失败就不写；
     *   ④ 返回 requiresRestart:true —— NapCat 重启后才生效。
     * 2FA 与 token **不在这里改**：前者改错会把主人锁在门外，后者是凭据本身。
     */
    updateWebUiConfig({ port = null, host = null, copyFile = copyFileSync, now = () => Date.now() } = {}) {
      const config = readConfig()
      if (config.exists !== true) return { ok: false, kind: 'no-config', message: config.reason || '找不到 webui.json' }
      let json
      try { json = JSON.parse(readFileSync(config.path, 'utf8')) } catch (error) {
        return { ok: false, kind: 'error', message: 'webui.json 不是合法 JSON：' + String(error?.message ?? error).slice(0, 80) }
      }
      const before_ = { host: json.host ?? '', port: json.port ?? null }

      let nextPort = before_.port
      if (port !== null && port !== undefined && port !== '') {
        const value = Number(port)
        if (!Number.isInteger(value) || value < 1 || value > 65535) return { ok: false, kind: 'bad-input', message: '端口必须是 1–65535 的整数' }
        nextPort = value
      }
      let nextHost = before_.host
      if (host !== null && host !== undefined && host !== '') {
        const value = String(host).trim()
        const loopback = new Set(['127.0.0.1', '::1', 'localhost', '::'])
        if (!loopback.has(value)) {
          return { ok: false, kind: 'bad-input', message: '只允许回环地址（127.0.0.1 / ::1 / localhost），不允许对外监听' }
        }
        nextHost = value
      }
      if (nextPort === before_.port && nextHost === before_.host) {
        return { ok: false, kind: 'no-change', message: '没有变化，未写入' }
      }
      json.port = nextPort
      json.host = nextHost

      const backup = config.path + '.bak-' + new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
      try { copyFile(config.path, backup) } catch (error) {
        return { ok: false, kind: 'error', message: '备份失败，未写入：' + String(error?.message ?? error).slice(0, 80) }
      }
      try { writeFileSync(config.path, JSON.stringify(json, null, 2) + '\n', 'utf8') } catch (error) {
        return { ok: false, kind: 'error', message: '写入失败（备份在 ' + backup + '）：' + String(error?.message ?? error).slice(0, 80) }
      }
      return {
        ok: true, kind: 'ok', message: '已写入（重启 NapCat 生效）',
        file: config.path, backup, requiresRestart: true, before: before_, after: { host: nextHost, port: nextPort },
      }
    },
    /** config 目录（给"在资源管理器里打开"用）。 */
    /**
     * 配置备份列表（`*.bak-*`）：我们自己每次写配置前都会留一份，这里让人看得到、能还原。
     * 只认 config 目录下一层、且文件名里含 `.bak-` 的文件。
     */
    listBackups() {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      if (dir === '') return { ok: false, kind: 'no-config', message: '找不到 config 目录', backups: [] }
      let names = []
      try { names = readdirSync(dir) } catch (error) {
        return { ok: false, kind: 'error', message: String(error?.message ?? error).slice(0, 100), backups: [] }
      }
      const backups = names
        .filter((name) => name.includes('.bak-'))
        .map((name) => {
          const full = join(dir, name)
          let size = 0
          let mtime = 0
          try { const info = statSync(full); size = info.size; mtime = info.mtimeMs } catch { /* 忽略 */ }
          const [base, stamp = ''] = name.split('.bak-')
          return { name, base, stamp, size, mtime, dir }
        })
        .sort((a, b) => b.mtime - a.mtime)
      return { ok: true, kind: 'ok', message: '', dir, backups }
    },

    /**
     * 还原备份：把 `<base>.bak-<stamp>` 覆盖回 `<base>`。
     * 还原前**先把当前文件另存一份** `.pre-restore-<时间>`，所以还原本身也可撤销。
     */
    restoreBackup(name, { now = () => Date.now() } = {}) {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      const clean = String(name ?? '')
      if (dir === '' || clean === '' || /[\\/]/.test(clean) || clean.includes('..')) {
        return { ok: false, kind: 'bad-input', message: '只接受 config 目录下的备份文件名' }
      }
      if (clean.includes('.bak-') === false) return { ok: false, kind: 'bad-input', message: '这不是备份文件：' + clean }
      const source = join(dir, clean)
      if (existsSync(source) === false) return { ok: false, kind: 'not-found', message: '备份不存在：' + clean }
      const target = join(dir, clean.split('.bak-')[0])
      if (target === source) return { ok: false, kind: 'bad-input', message: '目标与备份同名，拒绝执行' }
      const safety = target + '.pre-restore-' + new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
      try {
        if (existsSync(target)) copyFileSync(target, safety)
        copyFileSync(source, target)
        return { ok: true, kind: 'ok', message: '已还原 ' + clean + ' → ' + clean.split('.bak-')[0] + '；还原前的内容另存为 ' + safety.split(/[\\/]/).pop(), target, safety }
      } catch (error) {
        return { ok: false, kind: 'error', message: '还原失败：' + String(error?.message ?? error).slice(0, 120) }
      }
    },

    /**
     * 删除备份：**不真删** —— 移到 config/_trash/<时间戳>/ 下。
     * （仓库与用户规则都是"删除先进回收站"，这里给配置备份也留同样的后路。）
     */
    trashBackup(name, { now = () => Date.now() } = {}) {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      const clean = String(name ?? '')
      if (dir === '' || clean === '' || /[\\/]/.test(clean) || clean.includes('..')) {
        return { ok: false, kind: 'bad-input', message: '只接受 config 目录下的备份文件名' }
      }
      if (clean.includes('.bak-') === false) return { ok: false, kind: 'bad-input', message: '这不是备份文件：' + clean }
      const source = join(dir, clean)
      if (existsSync(source) === false) return { ok: false, kind: 'not-found', message: '备份不存在：' + clean }
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const trashDir = join(dir, '_trash', stamp)
      try {
        mkdirSync(trashDir, { recursive: true })
        const dest = join(trashDir, clean)
        copyFileSync(source, dest)
        unlinkSync(source)
        return { ok: true, kind: 'ok', message: '已移到 ' + dest, dest }
      } catch (error) {
        return { ok: false, kind: 'error', message: '移入回收失败：' + String(error?.message ?? error).slice(0, 120) }
      }
    },
    /**
     * 版本更新检查：拿 GitHub 最新 release 与本地 package.json 比。
     * 只读、带 10 分钟缓存；网络不通就如实返回原因（不假装"已是最新"）。
     */
    async latestRelease({ fetchImpl = fetch, now = () => Date.now() } = {}) {
      const cache = latestReleaseCache
      if (cache.value !== null && now() - cache.at < 10 * 60 * 1000) return cache.value
      let current = ''
      try {
        const pkg = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8'))
        current = String(pkg.version ?? '')
      } catch { /* 读不到就留空 */ }
      let result
      try {
        const res = await fetchImpl('https://api.github.com/repos/cheesehaqi/dsh-qq-onebot-bridge/releases/latest', {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-qq-control' },
        })
        if (res.ok !== true) throw new Error('HTTP ' + res.status)
        const json = await res.json()
        const latest = String(json.tag_name ?? '').replace(/^v/, '')
        result = {
          ok: true,
          current,
          latest,
          newer: current !== '' && latest !== '' && latest !== current && latest > current,
          url: json.html_url ?? '',
          publishedAt: json.published_at ?? '',
          name: json.name ?? '',
        }
      } catch (error) {
        result = { ok: false, kind: 'offline', message: '查不到最新版本：' + String(error?.message ?? error).slice(0, 120), current }
      }
      latestReleaseCache.value = result
      latestReleaseCache.at = now()
      return result
    },

    /**
     * 端口占用：把 onebot11 配置里出现的端口逐个查一遍（谁在听、PID 是谁）。
     * 只读 netstat + tasklist，不改任何东西。
     */
    portStatus({ exec = execFileSync } = {}) {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      if (dir === '') return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置', ports: [] }
      const wanted = new Set()
      for (const account of listAccounts({ dir })) {
        const file = join(dir, 'onebot11_' + account.uin + '.json')
        if (existsSync(file) === false) continue
        try {
          const json = JSON.parse(readFileSync(file, 'utf8'))
          const network = json.network ?? {}
          for (const server of network.websocketServers ?? []) if (Number.isFinite(Number(server.port))) wanted.add(Number(server.port))
          for (const server of network.httpServers ?? []) if (Number.isFinite(Number(server.port))) wanted.add(Number(server.port))
          for (const client of network.websocketClients ?? []) {
            const match = /:(\d{2,5})(?:\/|$)/.exec(String(client.url ?? ''))
            if (match) wanted.add(Number(match[1]))
          }
        } catch { /* 单个账号配置坏了不影响其它 */ }
      }
      if (wanted.size === 0) return { ok: true, kind: 'ok', message: '', ports: [] }
      let rows = []
      try {
        const netstat = exec('netstat', ['-ano'], { encoding: 'utf8' })
        const tasklist = exec('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' })
        const names = new Map()
        for (const line of String(tasklist).split('\n')) {
          const parts = line.match(/"([^"]+)","(\d+)"/)
          if (parts) names.set(Number(parts[2]), parts[1])
        }
        rows = String(netstat).split('\n')
          .map((line) => line.trim().split(/\s+/))
          .filter((parts) => parts.length >= 5 && parts[0].toUpperCase() === 'TCP' && parts[3] === 'LISTENING')
          .map((parts) => ({ port: Number(parts[1].split(':').pop()), pid: Number(parts[4]) }))
          .filter((row) => wanted.has(row.port))
          .map((row) => ({ port: row.port, listening: true, pid: row.pid, process: names.get(row.pid) ?? '' }))
      } catch (error) {
        return { ok: false, kind: 'error', message: '读端口失败：' + String(error?.message ?? error).slice(0, 120), ports: [] }
      }
      const seen = new Set(rows.map((row) => row.port))
      for (const port of wanted) if (!seen.has(port)) rows.push({ port, listening: false, pid: 0, process: '' })
      rows.sort((a, b) => a.port - b.port)
      return { ok: true, kind: 'ok', message: '', ports: rows }
    },

    /** 控制台自身：版本 / Node / 平台 / PID / 运行时长 / 端口（只读）。 */
    consoleInfo({ port = 0 } = {}) {
      let version = ''
      try { version = String(JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')).version ?? '') } catch { /* 读不到就空 */ }
      return {
        ok: true,
        version,
        node: process.version,
        platform: process.platform + ' ' + process.arch,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        port,
        cwd: process.cwd(),
      }
    },

    /**
     * 只读预览 napcat.json 的关键项。
     * 安全边界：**只回顶层键值**、**一律截断到 80 字**、命中 /token|secret|password|cookie|key|pass/i 的一律打码。
     */
    napcatConfigPreview() {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      if (dir === '') return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置', file: '', entries: [] }
      const file = join(dir, 'napcat.json')
      if (existsSync(file) === false) return { ok: false, kind: 'not-found', message: '没有 napcat.json', file, entries: [] }
      let json
      try { json = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
        return { ok: false, kind: 'error', message: '解析失败：' + String(error?.message ?? error).slice(0, 100), file, entries: [] }
      }
      if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        return { ok: false, kind: 'error', message: '顶层不是对象', file, entries: [] }
      }
      const secret = /token|secret|password|passwd|cookie|apiKey|apikey|key|auth/i
      const entries = Object.keys(json).sort().slice(0, 60).map((key) => {
        const value = json[key]
        let shown = ''
        if (secret.test(key)) shown = '（已隐藏）'
        else if (value === null) shown = 'null'
        else if (typeof value === 'object') shown = Array.isArray(value) ? '[数组 ' + value.length + ' 项]' : '{对象 ' + Object.keys(value).length + ' 键}'
        else shown = String(value).slice(0, 80)
        return { key, type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, shown }
      })
      return { ok: true, kind: 'ok', message: '', file, entries }
    },

    /**
     * 回收站（config/_trash/<时间戳>/<文件>）：列出我们移进去的旧备份。
     * 只读目录；真正清理走 purgeTrash（送进**系统回收站**，不硬删）。
     */
    trashEntries() {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      if (dir === '') return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置', entries: [] }
      const root = join(dir, '_trash')
      if (existsSync(root) === false) return { ok: true, kind: 'ok', message: '', dir: root, entries: [] }
      const entries = []
      try {
        for (const stamp of readdirSync(root)) {
          const stampDir = join(root, stamp)
          let isDir = false
          try { isDir = statSync(stampDir).isDirectory() } catch { /* 忽略 */ }
          if (isDir === false) continue
          for (const name of readdirSync(stampDir)) {
            const full = join(stampDir, name)
            let size = 0
            let mtime = 0
            try { const info = statSync(full); size = info.size; mtime = info.mtimeMs } catch { /* 忽略 */ }
            entries.push({ rel: stamp + '/' + name, stamp, name, size, mtime })
          }
        }
      } catch (error) {
        return { ok: false, kind: 'error', message: '读回收站失败：' + String(error?.message ?? error).slice(0, 120), entries: [] }
      }
      entries.sort((a, b) => b.mtime - a.mtime)
      return { ok: true, kind: 'ok', message: '', dir: root, entries }
    },

    /** 从回收站还原回 config/（不覆盖：同名存在就加 .restored-时间 后缀）。 */
    restoreTrash({ rel = '', now = () => Date.now() } = {}) {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      const clean = String(rel ?? '').replace(/\\/g, '/')
      if (dir === '' || clean === '' || clean.includes('..')) return { ok: false, kind: 'bad-input', message: '只接受回收站里的相对路径' }
      const source = join(dir, '_trash', clean)
      if (existsSync(source) === false) return { ok: false, kind: 'not-found', message: '回收站里没有：' + clean }
      const base = clean.split('/').pop()
      let target = join(dir, base)
      if (existsSync(target)) target = target + '.restored-' + new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
      try {
        copyFileSync(source, target)
        unlinkSync(source)
        return { ok: true, kind: 'ok', message: '已还原到 ' + target, target }
      } catch (error) {
        return { ok: false, kind: 'error', message: '还原失败：' + String(error?.message ?? error).slice(0, 120) }
      }
    },

    /**
     * 把回收站里的文件送进 **Windows 回收站**（不是硬删除）。
     * 用 Shell.Application 的 InvokeVerb('delete')，失败就如实报错、绝不回退到删除。
     */
    purgeTrash({ rel = '', exec = execFileSync } = {}) {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      const clean = String(rel ?? '').replace(/\\/g, '/')
      if (dir === '' || clean === '' || clean.includes('..')) return { ok: false, kind: 'bad-input', message: '只接受回收站里的相对路径' }
      const target = join(dir, '_trash', clean)
      if (existsSync(target) === false) return { ok: false, kind: 'not-found', message: '回收站里没有：' + clean }
      if (process.platform !== 'win32') return { ok: false, kind: 'unsupported', message: '只有 Windows 支持送系统回收站' }
      const escaped = target.replace(/'/g, "''")
      const script = [
        '$shell = New-Object -ComObject Shell.Application',
        '$item = $shell.Namespace(0).ParseName(\'' + escaped + '\')',
        'if ($item -eq $null) { Write-Error "ParseName failed"; exit 2 }',
        "$item.InvokeVerb('delete')",
      ].join('; ')
      try {
        exec('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
        return { ok: true, kind: 'ok', message: '已送入系统回收站：' + clean }
      } catch (error) {
        return { ok: false, kind: 'error', message: '送回收站失败（未删除任何内容）：' + String(error?.message ?? error).slice(0, 120) }
      }
    },

    /** 确保插件目录存在（config/plugins）：只 mkdir，不下载、不安装。 */
    ensurePluginsDir() {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      if (dir === '') return { ok: false, kind: 'no-config', message: '找不到 config 目录' }
      const target = join(dir, 'plugins')
      if (existsSync(target)) return { ok: true, kind: 'ok', message: '插件目录已存在', dir: target, created: false }
      try {
        mkdirSync(target, { recursive: true })
        return { ok: true, kind: 'ok', message: '已创建插件目录（重启 NapCat 后生效）', dir: target, created: true }
      } catch (error) {
        return { ok: false, kind: 'error', message: '创建失败：' + String(error?.message ?? error).slice(0, 120) }
      }
    },
    configDir() {
      const config = readConfig()
      return config.exists ? dirname(config.path) : ''
    },
    /** 文件管理（只读）：列 config 目录。刻意只列这一层，不做递归、不提供下载任意路径。 */
    files() {
      const config = readConfig()
      const dir = config.exists ? dirname(config.path) : ''
      if (dir === '') return { ok: false, kind: 'no-config', message: '没有可用的 WebUI 配置', dir, entries: [] }
      let names = []
      try { names = readdirSync(dir) } catch (error) { return { ok: false, kind: 'error', message: String(error?.message ?? error), dir, entries: [] } }
      const entries = names.map((name) => {
        try {
          const info = statSync(join(dir, name))
          return { name, size: info.size, isDir: info.isDirectory(), mtime: info.mtimeMs }
        } catch { return { name, size: 0, isDir: false, mtime: 0 } }
      }).sort((a, b) => b.mtime - a.mtime)
      return { ok: true, kind: 'ok', message: '', dir, entries }
    },
    /** 关于：版本哈希 / 最新 tag / 镜像列表（三个都只读，失败互不拖累）。 */
    async about() {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      const one = client(config)
      const [hash, latest, mirrors] = await Promise.all([one.fileHash(), one.latestTag(), one.mirrors()])
      return {
        ok: true, kind: 'ok', message: '',
        data: {
          hash: hash.ok === true ? hash.data : null,
          latestTag: latest.ok === true ? latest.data : null,
          mirrors: mirrors.ok === true ? mirrors.data : null,
        },
        degraded: [hash, latest, mirrors].filter((item) => item.ok !== true).map((item) => item.kind),
      }
    },
    /** 系统状态（CPU/内存）。SSE 首帧要 ~3 秒，这里缓存 20 秒，页面单独异步拉。 */
    async sys() {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      if (Date.now() - sysCache.at < 20_000 && sysCache.data !== null) {
        return { ok: true, kind: 'ok', message: '', data: sysCache.data, cached: true }
      }
      const result = await client(config).sysStatus()
      if (result.ok === true && result.data !== null && result.data !== undefined) sysCache = { at: Date.now(), data: result.data }
      return result
    },
    /** 顶部信息条：NapCat 版本 + QQ 版本（各自失败不互相拖累）。 */
    async meta() {
      const config = readConfig()
      const webui = publicWebUiConfig(config)
      const accounts = listAccounts({ napcatBat, dir: webui.exists ? dirname(config.path) : '' })
      if (!guard(config)) {
        return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置', webui, accounts, versions: {} }
      }
      const one = client(config)
      // 系统状态单独走 `sys()`：它一帧要 3 秒，不能拖慢整页首屏。
      const [napcat, qq] = await Promise.all([one.napcatVersion(), one.qqVersion()])
      const detail = (result, key) => (result.ok === true ? (result.data?.[key] ?? result.data ?? null) : null)
      return {
        ok: true,
        kind: 'ok',
        message: '',
        webui,
        accounts,
        versions: {
          napcat: detail(napcat, 'version'),
          qq: typeof qq.data === 'string' ? qq.data : detail(qq, 'version'),
          sys: null,
        },
        // 系统状态已拆到 `sys()`（SSE 首帧要 3 秒，不能拖慢整页），这里只算版本的可用性。
        degraded: [napcat, qq].filter((result) => result.ok !== true).map((result) => result.kind),
      }
    },
    /** 提交 6 位验证码：用它登录一次并缓存凭证，然后立刻探一次状态。 */
    async setTotp(code) {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      const one = client(config, { totpCode: String(code) })
      const status = await one.status()
      return { ...status, require2FA: one.require2FA }
    },
    /**
     * 重启 NapCat：**先尝试让它自己重启**（走 WebUI 的 RestartNapCat）；
     * 如果它根本没在运行（unreachable），就直接把启动脚本拉起来 —— 否则这个按钮在最需要它的时候没用。
     */
    /** 当前登录账号的头像（服务端代取 qlogo）。 */
    async avatar(uin) {
      const target = uin && String(uin) !== '' ? uin : (readPreferredUin() || '')
      return fetchAvatar(target, fetchImpl ?? fetch)
    },
    async restart() {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      const result = await client(config).restartNapcat()
      if (result.ok === true) return result
      const transient = result.kind === 'unreachable' || result.kind === 'timeout'
      if (transient === false) return result
      if (typeof napcatBat !== 'string' || napcatBat === '') {
        return { ok: false, kind: 'unsupported', message: 'NapCat 没在运行，且没有配置启动脚本（napcatBat）' }
      }
      /**
       * 启动 NapCat 的正确姿势（真机踩过）：
       *   `napcat.bat` 里是 `NapCatWinBootMain.exe` **不带参数** → 只打印 argv[0] 就退出，永远起不来；
       *   `quick.bat` 是 `NapCatWinBootMain.exe <QQ号>` → 能起。
       * 所以这里带 uin 直接调 exe；没有 uin 就退回 launcher.bat（它会自行提权，会弹 UAC，需要人点）。
       */
      const dir = dirname(napcatBat)
      const exe = join(dir, 'NapCatWinBootMain.exe')
      const uin = readPreferredUin([join(dir, 'config')])
      if (existsSync(exe) && uin !== '') {
        try {
          spawn('cmd.exe', ['/c', 'start', '', 'NapCatWinBootMain.exe', uin], { cwd: dir, detached: true, stdio: 'ignore' }).unref()
          return { ok: true, kind: 'ok', message: 'NapCat 没在运行，已用 QQ ' + uin + ' 拉起（会弹一个控制台窗口，等十几秒再刷新）', launched: true, uin }
        } catch (error) {
          return { ok: false, kind: 'error', message: '拉起失败：' + String(error?.message ?? error).slice(0, 120) }
        }
      }
      // 没有 uin 或没有 exe：退回 launcher.bat（可能需要 UAC 提权）
      const launcher = join(dir, 'launcher.bat')
      if (existsSync(launcher)) {
        try {
          spawn(launcher, [], { cwd: dir, detached: true, stdio: 'ignore', shell: true }).unref()
          return { ok: true, kind: 'ok', message: '没有可用的 QQ 号，已调用 launcher.bat（可能弹 UAC，需要你确认）', launched: true, launcher: true }
        } catch (error) {
          return { ok: false, kind: 'error', message: '拉起失败：' + String(error?.message ?? error).slice(0, 120) }
        }
      }
      return { ok: false, kind: 'not-found', message: '既没有 NapCatWinBootMain.exe 也没有 launcher.bat，路径：' + dir }
    },
    /** 当前登录的账号资料（昵称/uin/uid），页面头部用。 */
    async loginInfo() {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      return client(config).loginInfo()
    },
    async guidBackups() {
      const config = readConfig()
      if (!guard(config)) return { ok: false, kind: 'no-config', message: config.reason || '没有可用的 WebUI 配置' }
      return client(config).guidBackups()
    },
  }
}

