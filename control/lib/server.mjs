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
