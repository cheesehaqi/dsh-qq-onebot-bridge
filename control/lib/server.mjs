/**
 * HTTP surface of the standalone QQ bot console.
 *
 * Security model (this thing can start and kill processes, so it is deliberate):
 *   - binds 127.0.0.1 only;
 *   - every /api/* call needs the console token (query `token` or `X-Control-Token`);
 *   - a request that carries an `Origin` header must come from the console page
 *     itself, which blocks cross-site requests from any other web page;
 *   - the only kill-able PIDs are the ones the supervisor guard rail approves.
 *
 * The supervisor is injected, so the whole surface can be tested over real HTTP
 * without touching the machine.
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tailLines } from './supervisor.mjs'
import { FREEABLE_PORTS } from './config.mjs'
import { buildScenario, listScenarios } from './scenarios.mjs'
import { diffReplays } from './replaydiff.mjs'

const MAX_BODY_BYTES = 64 * 1024
const LOG_NAMES = ['hostOut', 'hostErr', 'bridge', 'trace', 'audit', 'runtime']
const CONFIG_KEYS = ['cwd', 'dshBin', 'nodeExe', 'napcatBat', 'ttsBat']

export function createToken() {
  return randomBytes(18).toString('base64url')
}

function json(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let tooLarge = false
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // 之前直接 request.destroy()，客户端只会看到连接被重置；改成读完余量后回 413
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooLarge) { resolve({ __tooLarge: true }); return }
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch { resolve(null) }
    })
    request.on('error', () => resolve(null))
  })
}

/** Origin check: only the console page (same 127.0.0.1 port) may drive the API. */
export function originAllowed(origin, port) {
  if (!origin) return true   // curl / scripts without Origin are gated by the token instead
  try {
    const url = new URL(origin)
    const hostOk = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    return hostOk && Number(url.port || 80) === Number(port)
  } catch {
    return false
  }
}

/**
 * @param config  resolved control config (paths + ports)
 * @param token   console token; requests must present it
 * @param api     supervisor (createSupervisor(...)) or a stub in tests
 * @param ui      HTML served at "/"
 */
export function createControlServer({ config, token, api, ui = '', uiFile = '', accountsUi = '', accountsUiFile = '', saveConfig = null, logger = console }) {
  const port = config.ports?.control ?? 8799

  /**
   * 页面文件的**热读取**：mtime 变了才重新读盘。
   * 为什么要它：控制台是独立进程，页面在启动时读进内存 —— 改完 HTML 必须重启才生效，
   * 这个坑我们自己踩了三次（改完看不到效果 / 接口 405 / 旧页面）。生产上零成本（一次 stat）。
   */
  const pageCache = new Map()
  const freshPage = (file, fallback) => {
    if (!file) return fallback
    try {
      const stamp = statSync(file).mtimeMs
      const cached = pageCache.get(file)
      if (cached !== undefined && cached.stamp === stamp) return cached.text
      const text = readFileSync(file, 'utf8')
      pageCache.set(file, { stamp, text })
      return text
    } catch {
      return fallback
    }
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    const path = url.pathname

    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(freshPage(uiFile, ui))
      return
    }

    // v0.7.11：账号中心（本地页面，同源；token 由页面从 ?token= 读，API 仍逐个校验）
    if (request.method === 'GET' && (path === '/accounts' || path === '/accounts.html')) {
      if (accountsUi === '') {
        json(response, 404, { ok: false, reason: '这个版本没有账号页' })
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(freshPage(accountsUiFile, accountsUi))
      return
    }

    if (!path.startsWith('/api/')) {
      json(response, 404, { ok: false, reason: 'not found' })
      return
    }

    const presented = url.searchParams.get('token') ?? request.headers['x-control-token'] ?? ''
    if (presented !== token) {
      json(response, 401, { ok: false, reason: 'token 无效' })
      return
    }
    if (!originAllowed(request.headers.origin, port)) {
      json(response, 403, { ok: false, reason: 'Origin 不被允许（拒绝跨站请求）' })
      return
    }

    try {
      if (request.method === 'GET' && path === '/api/status') {
        json(response, 200, { ok: true, ...(await api.status()) })
        return
      }
      if (request.method === 'GET' && path === '/api/logs') {
        const name = url.searchParams.get('name') ?? 'hostOut'
        if (!LOG_NAMES.includes(name)) {
          json(response, 400, { ok: false, reason: `日志名必须是 ${LOG_NAMES.join('/')}` })
          return
        }
        const lines = Math.min(1000, Math.max(10, Number(url.searchParams.get('lines')) || 200))
        json(response, 200, { ok: true, name, lines: tailLines(api.logFile(name), lines) })
        return
      }
      if (request.method === 'GET' && path === '/api/trace') {
        const traceId = url.searchParams.get('traceId') ?? ''
        if (traceId) {
          const chain = api.traceChain(traceId)
          json(response, 200, { ok: true, traceId, chain })
          return
        }
        const okParam = url.searchParams.get('ok')
        const events = api.traceEvents({
          limit: Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 300)),
          chatKey: url.searchParams.get('chatKey') ?? '',
          level: url.searchParams.get('level') ?? '',
          stage: url.searchParams.get('stage') ?? '',
          ok: okParam === null || okParam === '' ? null : okParam === 'false' ? false : true,
        })
        json(response, 200, { ok: true, events, summary: api.summarize ? api.summarize(events) : undefined })
        return
      }
      if (request.method === 'GET' && path === '/api/inbox') {
        const limit = Number(url.searchParams.get('limit')) || 50
        json(response, 200, { ok: true, ...api.inboxList({ limit }) })
        return
      }
      if (request.method === 'GET' && path === '/api/archive') {
        const query = (url.searchParams.get('q') ?? '').trim()
        const days = Math.min(3650, Math.max(1, Number(url.searchParams.get('days')) || 7))
        if (query === '') {
          json(response, 200, { ok: true, ...(await api.archiveStats()) })
          return
        }
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20))
        const chatKey = (url.searchParams.get('chatKey') ?? '').trim()
        json(response, 200, { ok: true, days, ...(await api.archiveSearch(query, { days, limit, chatKey })) })
        return
      }
      if (request.method === 'GET' && path === '/api/runtime') {
        json(response, 200, { ok: true, runtime: api.runtime() })
        return
      }
      // v0.5.5「控制台看得见」：性能面板（P50/P95）、定时任务面板、群配置页。
      if (request.method === 'GET' && path === '/api/perf') {
        if (typeof api.perf !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台不支持性能面板' })
          return
        }
        const limit = Math.min(20000, Math.max(100, Number(url.searchParams.get('limit')) || 5000))
        const windowMinutes = Math.min(1440, Math.max(0, Number(url.searchParams.get('window')) || 0))
        // 必须 await：supervisor 这三个方法都是 async，直接序列化 Promise 会得到空对象（实测踩过）。
        json(response, 200, await api.perf({ limit, chatKey: (url.searchParams.get('chatKey') ?? '').trim(), windowMinutes }))
        return
      }
      if (request.method === 'GET' && path === '/api/jobs') {
        if (typeof api.jobsView !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台不支持定时任务面板' })
          return
        }
        json(response, 200, await api.jobsView())
        return
      }
      if (request.method === 'GET' && path === '/api/groups') {
        if (typeof api.groups !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台不支持群配置页' })
          return
        }
        json(response, 200, await api.groups())
        return
      }
      // 注入场景库：只返回清单（生成 spec 走 POST /api/inject 的 scenario 字段，逻辑在纯模块里测）
      if (request.method === 'GET' && path === '/api/scenarios') {
        json(response, 200, { ok: true, scenarios: listScenarios() })
        return
      }
      // 登录二维码：直接给前端 dataUrl + 新鲜度，省得再开一个端口去看图
      if (request.method === 'GET' && path === '/api/qr') {
        if (typeof api.qr !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台不支持二维码查看' })
          return
        }
        json(response, 200, await api.qr())
        return
      }
      // NapCat WebUI 的带 token 地址：避免「QQ助手账号」点进去只看到「token 无效」
      // （NapCat 的 WebUI 有自己的 token，存在 bootmain/config/webui.json）。
      // v0.7.11 隐私收紧：NapCat 的 token 不进 JSON，改成 302 跳转（页面用 window.open 打开这个地址）
    if (request.method === 'GET' && path === '/api/napcat/open') {
      const info = typeof api.napcatWebui === 'function' ? api.napcatWebui() : { ok: false }
      if (info.ok !== true || !info.url) { json(response, 200, { ok: false, reason: '拿不到 NapCat WebUI 地址' }); return }
      let target = info.url
      try {
        const parsed = new URL(info.url)
        const page = url.searchParams.get('page') ?? ''
        if (page === 'plugin_store') parsed.pathname = '/webui/plugin_store'
        target = parsed.toString()
      } catch { /* 解析失败就用原地址 */ }
      response.writeHead(302, { location: target, 'cache-control': 'no-store' })
      response.end()
      return
    }

    if (request.method === 'GET' && path === '/api/napcat/webui') {
      // v0.7.11 隐私收紧：**不返回 token**，只给不带 token 的地址；要打开带 token 的页面用 /api/napcat/open
      const info = typeof api.napcatWebui === 'function' ? api.napcatWebui() : { ok: false, reason: '当前控制台不支持该接口' }
      if (info.ok !== true) { json(response, 200, { ok: false, reason: info.reason ?? '拿不到 NapCat WebUI 地址' }); return }
      let bare = ''
      try { const parsed = new URL(info.url); parsed.search = ''; bare = parsed.toString() } catch { bare = String(info.url) }
      json(response, 200, { ok: true, url: bare, hasToken: true, reason: '要带 token 打开请用 /api/napcat/open（302）' })
      return
    }
    } catch (error) {
      logger?.error?.(`control api ${path} failed: ${error.message}`)
      json(response, 500, { ok: false, reason: `内部错误：${error.message}` })
    }
  })
}

/** Read the UI file (kept separate so the server stays testable without it). */
export function readUi(file) {
  try { return readFileSync(file, 'utf8') } catch { return '<h1>UI 文件缺失</h1>' }
}
