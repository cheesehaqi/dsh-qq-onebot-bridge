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
    // v0.7.11 隐私收紧：NapCat token 不进 JSON，改 302 跳转（token 只在服务端拼接）
    if (request.method === 'GET' && path === '/api/napcat/open') {
      const unsupported = typeof api.napcatWebui !== 'function'
      if (unsupported) { json(response, 200, { ok: false, reason: '当前控制台不支持该接口' }); return }
      const info = await api.napcatWebui()
      if (info.ok !== true || !info.url) { json(response, 200, { ok: false, reason: '拿不到 NapCat WebUI 地址' }); return }
      let target = info.url
      try {
        const parsed = new URL(info.url)
        if (url.searchParams.get('page') === 'plugin_store') parsed.pathname = '/webui/plugin_store'
        target = parsed.toString()
      } catch { /* 解析失败用原地址 */ }
      response.writeHead(302, { location: target, 'cache-control': 'no-store' })
      response.end()
      return
    }

    if (request.method === 'GET' && path === '/api/napcat/webui') {
      // 隐私收紧：只给不带 token 的地址；要带 token 打开请用 /api/napcat/open（302）
      if (typeof api.napcatWebui !== 'function') { json(response, 200, { ok: false, reason: '当前控制台不支持该接口' }); return }
      const info = await api.napcatWebui()
      if (info.ok !== true) { json(response, 200, { ok: false, reason: info.reason ?? '拿不到 NapCat WebUI 地址' }); return }
      let bare = info.url
      try { const parsed = new URL(info.url); parsed.search = ''; bare = parsed.toString() } catch { /* 原样 */ }
      json(response, 200, { ok: true, url: bare, hasToken: true, reason: '要带 token 打开请用 /api/napcat/open（302）' })
      return
    }
      /**
       * v0.7.11 账号中心（本地网站）：概览/登录状态/二维码/快速登录列表。
       * 全部只读；`webui.json` 的 token 只在服务端用，响应里只有打码形态。
       */
      if (request.method === 'GET' && path === '/api/accounts') {
        if (typeof api.accounts?.summary !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台不支持账号中心' })
          return
        }
        json(response, 200, api.accounts.summary())
        return
      }
      if (request.method === 'GET' && path === '/api/accounts/status') {
        json(response, 200, await api.accounts.status())
        return
      }
      if (request.method === 'GET' && path === '/api/accounts/qr') {
        json(response, 200, await api.accounts.qrcode())
        return
      }
      if (request.method === 'GET' && path === '/api/accounts/quick') {
        json(response, 200, await api.accounts.quickList())
        return
      }
      // v0.7.11：当前登录账号资料（昵称 / uin / uid）
      if (request.method === 'GET' && path === '/api/accounts/info') {
        json(response, 200, await api.accounts.loginInfo())
        return
      }
      // v0.7.11：页面顶部信息条（NapCat 版本 / QQ 版本 / 系统状态 / 账号清单）
      if (request.method === 'GET' && path === '/api/accounts/meta') {
        json(response, 200, await api.accounts.meta())
        return
      }
      if (request.method === 'GET' && path === '/api/accounts/guid') {
        json(response, 200, await api.accounts.guidBackups())
        return
      }
      // v0.7.11 实时日志：把 NapCat 的 SSE 逐帧转给浏览器（EventSource 加不了 Authorization）
      if (request.method === 'GET' && path === '/api/accounts/logs/live') {
        const opened = await api.accounts.logLive()
        if (opened.ok !== true) {
          json(response, 200, { ok: false, kind: opened.kind, message: opened.message })
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
        response.write(': connected\n\n')
        const reader = opened.response.body?.getReader?.()
        if (!reader) {
          response.write('data: {"line":"（该版本实时日志不可读）"}\n\n')
          response.end()
          return
        }
        const decoder = new TextDecoder()
        let closed = false
        request.on('close', () => { closed = true; try { reader.cancel() } catch { /* 已关 */ } })
        try {
          while (closed !== true) {
            const chunk = await reader.read()
            if (chunk.done === true) break
            const text = decoder.decode(chunk.value, { stream: true })
            for (const line of text.split('\n')) {
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (payload === '') continue
              response.write(`data: ${JSON.stringify({ line: payload })}\n\n`)
            }
          }
        } catch { /* 客户端断开是正常路径 */ }
        try { reader.cancel() } catch { /* 已关 */ }
        response.end()
        return
      }
      // v0.7.11：系统状态（CPU/内存），页面异步拉，免得首屏等 3 秒
      if (request.method === 'GET' && path === '/api/accounts/sys') {
        json(response, 200, await api.accounts.sys())
        return
      }
      // v0.7.11：登录二维码图片（NapCat 每刷新一次就重写 cache/qrcode.png，直接发文件最省事）
      if (request.method === 'GET' && path === '/api/accounts/qr-image') {
        const file = api.napcatQrFile?.() ?? ''
        if (file === '') { json(response, 200, { ok: false, reason: '没有配置二维码路径' }); return }
        try {
          const image = readFileSync(file)
          response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': String(image.length) })
          response.end(image)
        } catch (error) {
          json(response, 200, { ok: false, reason: `读二维码失败：${error?.message ?? error}` })
        }
        return
      }
      // QQ 头像（服务端代取，浏览器不直连第三方）
      if (request.method === 'GET' && path === '/api/accounts/avatar') {
        const result = typeof api.accounts?.avatar === 'function'
          ? await api.accounts.avatar(url.searchParams.get('uin') ?? '')
          : { ok: false, reason: '当前控制台不支持头像' }
        if (result.ok !== true) { json(response, 200, { ok: false, reason: result.message ?? '取不到头像' }); return }
        response.writeHead(200, {
          'content-type': result.contentType || 'image/jpeg',
          'cache-control': 'private, max-age=3600',
          'content-length': String(result.buffer.length),
        })
        response.end(result.buffer)
        return
      }
      // 文件管理：在**本机资源管理器**里打开 config 目录（不经浏览器，目录内容不暴露成 HTTP）
      if (request.method === 'GET' && path === '/api/accounts/open-folder') {
        const base = typeof api.accounts?.configDir === 'function' ? api.accounts.configDir() : ''
        // 允许打开 config 下的固定子目录（插件目录），其余一律走 base，避免任意路径
        const which = url.searchParams.get('target') === 'plugins' ? 'plugins' : ''
        let dir = base
        if (which === 'plugins' && base !== '') {
          const candidates = [join(base, 'plugins'), join(base, '..', 'plugins')]
          // 都没有就退回 bootmain 根目录（插件目录由 NapCat 的插件系统在加载时创建）
          dir = candidates.find((candidate) => existsSync(candidate)) ?? join(base, '..')
        }
        if (dir === '') { json(response, 200, { ok: false, reason: '找不到 config 目录（webui.json 没解析出来）' }); return }
        if (existsSync(dir) === false) { json(response, 200, { ok: false, reason: '目录不存在：' + dir }); return }
        try {
          if (process.platform === 'win32') {
            // ① Shell COM：会给窗口激活权限，通常能弹到最前
            const quoted = dir.replace(/'/g, "''")
            const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `(New-Object -ComObject Shell.Application).Explore('${quoted}')`], { detached: true, stdio: 'ignore' })
            ps.unref()
            // ② 兜底：COM 不可用时用 cmd start（可能仍在后台）
            setTimeout(() => { try { spawn('cmd.exe', ['/c', 'start', '', dir], { detached: true, stdio: 'ignore' }).unref() } catch { /* 忽略 */ } }, 1200)
          } else if (process.platform === 'darwin') spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref()
          else spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref()
          json(response, 200, { ok: true, reason: '已打开', dir })
        } catch (error) {
          json(response, 200, { ok: false, reason: '打开失败：' + String(error?.message ?? error) })
        }
        return
      }
      // v0.7.11：网络配置 / 文件管理（都只读）
      if (request.method === 'GET' && path === '/api/accounts/network') {
        json(response, 200, api.accounts.network())
        return
      }
      if (request.method === 'GET' && path === '/api/accounts/files') {
        json(response, 200, api.accounts.files())
        return
      }
      // v0.7.11：运行统计（读本地 trace）/ 插件列表 / 关于
      if (request.method === 'GET' && path === '/api/accounts/stats') {
        if (typeof api.traceStats !== 'function') { json(response, 200, { ok: false, reason: '当前控制台不支持统计' }); return }
        const traceLines = Math.min(20000, Math.max(200, Number(url.searchParams.get('lines')) || 2000))
        json(response, 200, await api.traceStats({ lines: traceLines }))
        return
      }
      if (request.method === 'GET' && path === '/api/accounts/plugins') {
        json(response, 200, await api.accounts.plugins())
        return
      }
      if (request.method === 'GET' && path === '/api/accounts/about') {
        json(response, 200, await api.accounts.about())
        return
      }
      // v0.7.11 日志窗口：NapCat 的日志（不带 file 给列表，带 file 给内容）
      if (request.method === 'GET' && path === '/api/accounts/logs') {
        json(response, 200, await api.accounts.logs(url.searchParams.get('file') ?? ''))
        return
      }
      // 0.8.1：配置备份的列表 / 还原 / 删除（删除是移到 config/_trash）
      // 0.8.3：版本更新检查 / 端口占用
      if (request.method === 'GET' && path === '/api/accounts/console') {
        if (typeof api.accounts?.consoleInfo !== 'function') { json(response, 200, { ok: false, reason: '当前控制台不支持该接口' }); return }
        json(response, 200, api.accounts.consoleInfo({ port: config?.ports?.control ?? 0 }))
        return
      }

      if (request.method === 'GET' && path === '/api/accounts/release') {
        if (typeof api.accounts?.latestRelease !== 'function') { json(response, 200, { ok: false, reason: '当前控制台不支持版本检查' }); return }
        json(response, 200, await api.accounts.latestRelease())
        return
      }
      if (request.method === 'GET' && path === '/api/accounts/ports') {
        if (typeof api.accounts?.portStatus !== 'function') { json(response, 200, { ok: false, reason: '当前控制台不支持端口检查', ports: [] }); return }
        json(response, 200, api.accounts.portStatus())
        return
      }

      if (request.method === 'GET' && path === '/api/accounts/backups') {
        if (typeof api.accounts?.listBackups !== 'function') { json(response, 200, { ok: false, reason: '当前控制台不支持备份管理', backups: [] }); return }
        json(response, 200, api.accounts.listBackups())
        return
      }

      if (request.method === 'GET' && path === '/api/diagnose') {
        const result = await api.diagnose()
        json(response, 200, { ok: true, ...result })
        return
      }
      if (request.method === 'GET' && path === '/api/acceptance') {
        if (typeof api.acceptance !== 'function') {
          json(response, 200, { ok: false, reason: '当前控制台不支持验收台' })
          return
        }
        const result = await api.acceptance()
        json(response, 200, { ok: result.ok, report: result.report, text: result.text, verdict: result.verdict, totals: result.totals })
        return
      }
      if (request.method === 'GET' && path === '/api/export') {
        // redact=1 → 分享安全通路：QQ 号掩码、消息原文只留长度（诊断包的使用场景就是发给别人）
        const redact = ['1', 'true', 'yes'].includes(String(url.searchParams.get('redact') ?? '').toLowerCase())
        const bundle = await api.exportBundle({ redact })
        response.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${bundle.filename}"`,
          'content-length': String(bundle.buffer.length),
          'cache-control': 'no-store',
          'x-redacted': redact ? '1' : '0',
        })
        response.end(bundle.buffer)
        return
      }
      if (request.method === 'GET' && path === '/api/stream') {
        // Server-Sent Events: push new trace events as the bridge writes them.
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        response.write('retry: 3000\n\n')
        const tailer = api.tailer()
        let closed = false
        const timer = setInterval(() => {
          if (closed) return
          try {
            const events = tailer.poll()
            for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
            response.write(': ping\n\n')
          } catch (error) {
            logger?.warn?.(`trace stream failed: ${error.message}`)
          }
        }, 1000)
        request.on('close', () => {
          closed = true
          clearInterval(timer)
        })
        return
      }
      if (request.method === 'POST') {
        const body = await readBody(request)
        if (body?.__tooLarge === true) {
          json(response, 413, { ok: false, reason: `请求体过大（上限 ${Math.round(MAX_BODY_BYTES / 1024)} KiB）` })
          return
        }
        if (body === null) {
          json(response, 400, { ok: false, reason: '请求体不是合法 JSON 或过大' })
          return
        }
        const actions = {
          '/api/host/start': () => api.startHost(),
          '/api/host/stop': () => api.stopHost(),
          '/api/host/restart': async () => {
            const stopped = await api.stopHost()
            await new Promise((resolve) => setTimeout(resolve, 1500))
            const started = await api.startHost()
            return { ok: started.ok, reason: `${stopped.ok || !stopped.ok ? stopped.reason : ''}；${started.reason}`.replace(/^；/, '') }
          },
          '/api/napcat/start': () => api.startNapcat(),
          // 重启登录流程：会先结束 NapCat 加载器与它注入的 QQ（护栏在 supervisor 里）
          '/api/napcat/restart': () => {
            if (typeof api.restartNapcatLogin !== 'function') return { ok: false, reason: '当前控制台不支持重启登录流程' }
            return api.restartNapcatLogin()
          },
          '/api/napcat/stop': () => api.stopNapcat(),
          // v0.7.11：账号中心的两个写操作（都只是让 NapCat 干活，不碰 QQ 数据）
          '/api/accounts/quick-login': () => {
            if (typeof api.accounts?.quickLogin !== 'function') return { ok: false, message: '当前控制台不支持账号中心' }
            const uin = String(body.uin ?? '').trim()
            if (!/^\d{5,12}$/.test(uin)) return { ok: false, message: 'QQ 号格式不对' }
            return api.accounts.quickLogin(uin)
          },
          '/api/accounts/auto': () => {
            if (typeof api.accounts?.setAutoLogin !== 'function') return { ok: false, message: '当前控制台不支持账号中心' }
            const uin = String(body.uin ?? '').trim()
            if (uin !== '' && !/^\d{5,12}$/.test(uin)) return { ok: false, message: 'QQ 号格式不对（留空 = 取消自动登录）' }
            return api.accounts.setAutoLogin(uin)
          },
          // 网络配置：整组替换 WS 客户端（新建/删除/启停/编辑）
          '/api/accounts/network/save': () => {
            if (typeof api.accounts?.saveNetworkClients !== 'function') return { ok: false, message: '当前控制台不支持保存网络配置' }
            return api.accounts.saveNetworkClients({ uin: String(body.uin ?? '').trim(), clients: Array.isArray(body.clients) ? body.clients : [] })
          },
          // 0.8.1：HTTP 服务器段整组替换
          '/api/accounts/network/http': () => {
            if (typeof api.accounts?.saveNetworkHttpServers !== 'function') return { ok: false, message: '当前控制台不支持保存 HTTP 服务器' }
            return api.accounts.saveNetworkHttpServers({ uin: String(body.uin ?? '').trim(), servers: Array.isArray(body.servers) ? body.servers : [] })
          },
          // 0.8.1：WS 服务器段整组替换
          '/api/accounts/network/servers': () => {
            if (typeof api.accounts?.saveNetworkServers !== 'function') return { ok: false, message: '当前控制台不支持保存 WS 服务器' }
            return api.accounts.saveNetworkServers({ uin: String(body.uin ?? '').trim(), servers: Array.isArray(body.servers) ? body.servers : [] })
          },
          // 0.8.1：备份还原 / 移入回收
          '/api/accounts/backups/restore': () => {
            if (typeof api.accounts?.restoreBackup !== 'function') return { ok: false, message: '当前控制台不支持还原备份' }
            return api.accounts.restoreBackup(String(body.name ?? ''))
          },
          '/api/accounts/backups/trash': () => {
            if (typeof api.accounts?.trashBackup !== 'function') return { ok: false, message: '当前控制台不支持删除备份' }
            return api.accounts.trashBackup(String(body.name ?? ''))
          },
          // 插件：建目录（只 mkdir）
          '/api/accounts/plugins/mkdir': () => {
            if (typeof api.accounts?.ensurePluginsDir !== 'function') return { ok: false, message: '当前控制台不支持创建插件目录' }
            return api.accounts.ensurePluginsDir()
          },
          // webui.json：只改端口与回环地址（2FA / token 不给改）
          '/api/accounts/config': () => {
            if (typeof api.accounts?.updateWebUiConfig !== 'function') return { ok: false, message: '当前控制台不支持改这份配置' }
            return api.accounts.updateWebUiConfig({ port: body.port ?? null, host: body.host ?? null })
          },
          // 插件：启用/停用 + 卸载（卸载是破坏性的，界面二次确认）
          '/api/accounts/plugins/status': () => {
            if (typeof api.accounts?.setPluginStatus !== 'function') return { ok: false, message: '当前控制台不支持插件操作' }
            const id = String(body.id ?? '').trim()
            if (id === '') return { ok: false, message: '缺少插件 id' }
            return api.accounts.setPluginStatus(id, body.enable === true)
          },
          '/api/accounts/plugins/uninstall': () => {
            if (typeof api.accounts?.uninstallPlugin !== 'function') return { ok: false, message: '当前控制台不支持卸载插件' }
            const id = String(body.id ?? '').trim()
            if (id === '') return { ok: false, message: '缺少插件 id' }
            return api.accounts.uninstallPlugin(id, body.cleanData === true)
          },
          // 网络配置（唯一会写 NapCat 文件的入口：先备份，再校验，再写）
          '/api/accounts/network': () => {
            if (typeof api.accounts?.updateNetwork !== 'function') return { ok: false, message: '当前控制台不支持编辑网络配置' }
            return api.accounts.updateNetwork({
              uin: String(body.uin ?? '').trim(),
              clients: Array.isArray(body.clients) ? body.clients : null,
              serverPort: body.serverPort ?? null,
            })
          },
          '/api/accounts/restart': () => {
            if (typeof api.accounts?.restart !== 'function') return { ok: false, message: '当前控制台不支持账号中心' }
            return api.accounts.restart()
          },
          // 2FA：把 6 位码交给 NapCat 换一次凭证（凭证在服务端缓存 50 分钟，之后一小时内不用再输）
          '/api/accounts/2fa': () => {
            if (typeof api.accounts?.setTotp !== 'function') return { ok: false, message: '当前控制台不支持 2FA' }
            const code = String(body.code ?? '').trim()
            if (!/^\d{6}$/.test(code)) return { ok: false, message: '验证码必须是 6 位数字' }
            return api.accounts.setTotp(code)
          },
          '/api/tts/start': () => api.startTts(),
          '/api/tts/stop': () => api.stopTts(),
          '/api/all/stop': () => api.stopAll(),
          // 释放端口：只允许释放**受管端口**（FREEABLE_PORTS）。否则 token 持有者能借它
          // 杀掉任意占用者的进程（审查复现过 {"name":"control"} → 杀掉别的 8799 占用者）。
          '/api/port/free': () => {
            const name = String(body.name ?? '').trim()
            if (!FREEABLE_PORTS.includes(name)) {
              return { ok: false, reason: `只能释放受管端口：${FREEABLE_PORTS.join(' / ')}（收到「${name}」）` }
            }
            return api.freePort(name)
          },
          // 离线回放：在沙箱里跑真实管线，dry-run 拦截一切出站
          '/api/replay': () => {
            if (typeof api.replay !== 'function') return { ok: false, reason: '当前控制台不支持回放' }
            const indices = Array.isArray(body.indices) ? body.indices.slice(0, 20) : null
            const entries = Array.isArray(body.entries) ? body.entries.slice(0, 20) : null
            const overrides = body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides) ? body.overrides : {}
            return api.replay({
              indices,
              entries,
              limit: Number(body.limit) || 5,
              replyText: typeof body.replyText === 'string' ? body.replyText.slice(0, 500) : '',
              overrides,
              budgetMs: Math.min(60000, Math.max(1000, Number(body.budgetMs) || 20000)),
            })
          },
          // 事件注入：写一行到注入队列，桥按间隔轮询后走真实管线（默认 dry-run）
          '/api/inject': () => {
            if (typeof api.inject !== 'function') return { ok: false, reason: '当前控制台不支持注入' }
            // 场景库：传 scenario 时由纯模块生成 spec（参数校验也在那边，缺什么说什么）
            if (typeof body.scenario === 'string' && body.scenario.trim() !== '') {
              const built = buildScenario(body.scenario, body.params && typeof body.params === 'object' ? body.params : {})
              if (built.ok !== true) return built
              return api.inject(built.spec)
            }
            return api.inject(body.spec && typeof body.spec === 'object' ? body.spec : body)
          },
          // 回放 diff：同一批消息跑两次（基线 + 覆盖配置），机械地比出差异
          '/api/replay-diff': async () => {
            if (typeof api.replay !== 'function') return { ok: false, reason: '当前控制台不支持回放' }
            const indices = Array.isArray(body.indices) ? body.indices.slice(0, 20) : null
            const entries = Array.isArray(body.entries) ? body.entries.slice(0, 20) : null
            const limit = Number(body.limit) || 5
            const baselineOverrides = body.baseline && typeof body.baseline === 'object' && !Array.isArray(body.baseline) ? body.baseline : {}
            const variantOverrides = body.variant && typeof body.variant === 'object' && !Array.isArray(body.variant) ? body.variant : null
            if (variantOverrides === null || Object.keys(variantOverrides).length === 0) {
              return { ok: false, reason: '请给出要对比的配置覆盖（variant，例如 {"keywordEnabled": true}）' }
            }
            const baseline = await api.replay({ indices, entries, limit, replyText: '', overrides: baselineOverrides, budgetMs: 20000 })
            const variant = await api.replay({ indices, entries, limit, replyText: '', overrides: variantOverrides, budgetMs: 20000 })
            const diff = diffReplays(baseline, variant)
            return { ok: true, variant: variantOverrides, ...diff }
          },
          '/api/queue/clear': () => {
            if (typeof api.clearQueue !== 'function') return { ok: false, reason: '当前控制台不支持清空队列' }
            return api.clearQueue()
          },
          '/api/config': () => {
            if (typeof saveConfig !== 'function') return { ok: false, reason: '配置保存不可用' }
            const patch = {}
            for (const key of CONFIG_KEYS) if (typeof body[key] === 'string' && body[key].trim()) patch[key] = body[key].trim()
            if (body.ports && typeof body.ports === 'object') {
              patch.ports = { ...config.ports }
              for (const [name, value] of Object.entries(body.ports)) {
                const port = Number(value)
                if (Number.isInteger(port) && port >= 1 && port <= 65535) patch.ports[name] = port
              }
            }
            if (Object.keys(patch).length === 0) return { ok: false, reason: '没有可更新的字段' }
            const ok = saveConfig(patch)
            return { ok, reason: ok ? '配置已保存（重启控制台后完全生效）' : '配置写入失败' }
          },
        }
        const action = actions[path]
        if (!action) {
          json(response, 404, { ok: false, reason: '未知接口' })
          return
        }
        const result = await action()
        json(response, 200, { ok: result?.ok !== false, ...result })
        return
      }
      json(response, 405, { ok: false, reason: 'method not allowed' })
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
