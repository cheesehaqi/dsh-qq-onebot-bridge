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
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tailLines } from './supervisor.mjs'

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
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { request.destroy(); resolve(null); return }
      chunks.push(chunk)
    })
    request.on('end', () => {
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
export function createControlServer({ config, token, api, ui = '', saveConfig = null, logger = console }) {
  const port = config.ports?.control ?? 8799

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    const path = url.pathname

    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(ui)
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
      if (request.method === 'GET' && path === '/api/runtime') {
        json(response, 200, { ok: true, runtime: api.runtime() })
        return
      }
      if (request.method === 'GET' && path === '/api/diagnose') {
        const result = await api.diagnose()
        json(response, 200, { ok: true, ...result })
        return
      }
      if (request.method === 'GET' && path === '/api/export') {
        const bundle = await api.exportBundle()
        response.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${bundle.filename}"`,
          'content-length': String(bundle.buffer.length),
          'cache-control': 'no-store',
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
          '/api/napcat/stop': () => api.stopNapcat(),
          '/api/tts/start': () => api.startTts(),
          '/api/tts/stop': () => api.stopTts(),
          '/api/all/stop': () => api.stopAll(),
          '/api/port/free': () => api.freePort(String(body.name ?? '')),
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
