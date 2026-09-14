/**
 * 入站 webhook 的**接收层**：只绑本机地址的 HTTP 端口，做鉴权 / 限频 / 体积上限，
 * 通过后把 payload 交给注入的 onEvent 回调（由桥去发 QQ）——本模块**不发 QQ**。
 *
 * 安全模型（刻意保守，与 control/lib/server.mjs 一致）：
 *   - 默认只绑 127.0.0.1，外部网络访问不到；
 *   - 每个来源必须配 token 或 secret 二选一，**两者都缺的来源在构造时就被剔除**，
 *     连路由都不会注册（绝不出现"开放端点"）；
 *   - 比较一律走 crypto.timingSafeEqual（长度不等也先 hash 到等长，避免抛错）；
 *   - 体积超限立刻回 413 并销毁连接，不再继续累积内存；
 *   - 每来源每分钟限频，超限回 429。
 *
 * 鉴权时机：token 只需要请求头/查询串，可以**读体前**判定；secret 是 GitHub 风格
 * 的 HMAC，必须对**原始请求体**算，所以只能**读体后**判定。两者都是先读完再判，
 * 顺序上不会让未鉴权的内容流到 onEvent（读体期间只是在缓冲区里躺着）。
 *
 * 本模块只用 Node 内置模块，可脱离桥单测（自起随机端口 + 真实 fetch）。
 */
import { createServer } from 'node:http'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** 默认体积上限：64 KiB。 */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024

/** 默认限频：每来源每分钟 30 次。 */
const DEFAULT_RATE_PER_MINUTE = 30

/** 限频窗口长度（毫秒）。 */
const RATE_WINDOW_MS = 60_000

/** 错误信息截断长度（放进 JSON reason，别把整页堆栈甩给外部系统）。 */
const REASON_LIMIT = 200

/** 路由前缀。 */
const HOOK_PREFIX = '/hook/'

// ------------------------------------------------------------- 工具函数 ----

/** 定长比较：两边各自 SHA-256 成等长摘要再比，长度不同也不会抛错。 */
function safeEqual(a, b) {
  const left = createHash('sha256').update(String(a ?? ''), 'utf8').digest()
  const right = createHash('sha256').update(String(b ?? ''), 'utf8').digest()
  return timingSafeEqual(left, right)
}

/**
 * GitHub 风格签名校验：`X-Hub-Signature-256: sha256=<hex>`，
 * 对**原始请求体字节**做 HMAC-SHA256（必须用原始串，不能重新序列化后再算）。
 */
function verifyHubSignature(raw, secret, header) {
  const presented = typeof header === 'string' ? header.trim() : ''
  if (!presented) return false
  const expected = `sha256=${createHmac('sha256', String(secret)).update(String(raw ?? ''), 'utf8').digest('hex')}`
  return safeEqual(expected, presented)
}

/** 是否为合法端口号。 */
function isPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** 错误 → 可读单行文本（截断，避免把整页堆栈塞进响应）。 */
function errorText(error) {
  const text = String(error?.message ?? error ?? '未知错误').replace(/[\r\n]+/g, ' ')
  return text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT)}…` : text
}

export class WebhookReceiver {
  /**
   * @param options `{ host='127.0.0.1', port, sources, onEvent, logger, now, maxBodyBytes=65536, ratePerMinute=30 }`
   *   - sources: `[{ name, token, secret, format, chat, template, maxChars }]`
   *   - onEvent: `async ({ source, payload, raw }) => void`（渲染与发送由调用方负责）
   *   - now: 注入时钟（测试用），默认 Date.now
   *   - destroyOnOverflow: 默认 true；413 后销毁连接
   */
  constructor(options = {}) {
    if (!options || typeof options !== 'object') throw new Error('WebhookReceiver 需要 options 对象')
    if (!isPort(options.port)) throw new Error(`WebhookReceiver 需要合法的 port（1-65535），收到：${String(options.port)}`)
    if (options.onEvent !== undefined && typeof options.onEvent !== 'function') throw new Error('WebhookReceiver 的 onEvent 必须是函数')

    this.host = typeof options.host === 'string' && options.host.trim() ? options.host.trim() : '127.0.0.1'
    this.port = Number(options.port)
    this.logger = options.logger ?? null
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : async () => {}
    this.now = typeof options.now === 'function' ? options.now : Date.now

    const maxBodyBytes = Number(options.maxBodyBytes)
    this.maxBodyBytes = Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? Math.floor(maxBodyBytes) : DEFAULT_MAX_BODY_BYTES
    const ratePerMinute = Number(options.ratePerMinute)
    this.ratePerMinute = Number.isFinite(ratePerMinute) && ratePerMinute > 0 ? Math.floor(ratePerMinute) : DEFAULT_RATE_PER_MINUTE
    this.destroyOnOverflow = options.destroyOnOverflow !== false

    /** 来源表：按 name 建索引；无鉴权凭据的项直接不注册路由。 */
    this.sources = new Map()
    const list = Array.isArray(options.sources) ? options.sources : []
    for (const source of list) {
      if (!source || typeof source !== 'object') continue
      const name = typeof source.name === 'string' ? source.name.trim() : ''
      if (!name) {
        this.logger?.warn?.('webhook 来源缺少 name，已忽略')
        continue
      }
      const token = typeof source.token === 'string' ? source.token.trim() : ''
      const secret = typeof source.secret === 'string' ? source.secret.trim() : ''
      if (!token && !secret) {
        // 关键防线：没有 token 也没有 secret = 开放端点，绝不注册
        this.logger?.warn?.(`webhook 来源 ${name} 既没有 token 也没有 secret，已拒绝注册（不会开放该端点）`)
        continue
      }
      this.sources.set(name, {
        config: source,
        name,
        token,
        secret,
        received: 0,
        dropped: 0,
        lastAt: 0,
        hits: [],
      })
    }

    this.server = null
    this.listening = false
    this.connections = new Set()
  }

  /** 启动监听；端口被占用时抛出可读中文错误。 */
  start() {
    if (!this.server) {
      this.server = createServer((request, response) => {
        this.#handle(request, response).catch((error) => {
          this.logger?.error?.(`webhook 处理失败：${errorText(error)}`)
          this.#send(response, 500, { ok: false, reason: `内部错误：${errorText(error)}` })
        })
      })
      this.server.on('connection', (socket) => {
        this.connections.add(socket)
        socket.on('close', () => this.connections.delete(socket))
      })
    }
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.removeListener('error', onError)
        if (error?.code === 'EADDRINUSE') {
          reject(new Error(`webhook 端口 ${this.port} 已被占用，请换一个端口或先停掉占用者`))
          return
        }
        if (error?.code === 'EACCES') {
          reject(new Error(`webhook 端口 ${this.port} 没有监听权限（EACCES）`))
          return
        }
        reject(new Error(`webhook 监听 ${this.host}:${this.port} 失败：${errorText(error)}`))
      }
      this.server.once('error', onError)
      this.server.listen(this.port, this.host, () => {
        this.server?.removeListener('error', onError)
        this.listening = true
        this.logger?.info?.(`webhook 已监听 http://${this.host}:${this.port}（来源 ${this.sources.size} 个）`)
        resolve()
      })
    })
  }

  /** 停止监听：幂等，重复调用不抛错。 */
  async stop() {
    if (!this.server) {
      this.listening = false
      return
    }
    const server = this.server
    const closed = new Promise((resolve) => server.close(() => resolve()))
    // keep-alive 长连接会拖住 close()：主动断开本模块持有的连接
    for (const socket of this.connections) {
      try { socket.destroy() } catch { /* 已断开，忽略 */ }
    }
    this.connections.clear()
    await closed
    this.server = null
    this.listening = false
    this.logger?.info?.('webhook 已停止')
  }

  /** 状态快照：每来源的 received / dropped / lastAt（毫秒）。 */
  status() {
    return {
      listening: this.listening,
      port: this.port,
      sources: [...this.sources.values()].map((entry) => ({
        name: entry.name,
        received: entry.received,
        dropped: entry.dropped,
        lastAt: entry.lastAt,
      })),
    }
  }

  // ------------------------------------------------------------ 内部实现 ----

  /** 统一的 JSON 响应。 */
  #send(response, status, payload) {
    let body = ''
    try { body = JSON.stringify(payload) } catch { body = '{"ok":false,"reason":"响应序列化失败"}' }
    try {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(body)),
      })
      response.end(body)
    } catch { /* 客户端已断开，忽略 */ }
  }

  /** 路由 → 方法 → 来源 → 体积 → 鉴权 → 限频 → 解析 → 回调，异常统一兜底。 */
  async #handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${this.host}:${this.port}`)
    if (!url.pathname.startsWith(HOOK_PREFIX)) {
      this.#send(response, 404, { ok: false, reason: '未知路径' })
      return
    }
    let name = ''
    try { name = decodeURIComponent(url.pathname.slice(HOOK_PREFIX.length)) } catch { name = url.pathname.slice(HOOK_PREFIX.length) }
    const entry = this.sources.get(name)
    if (!entry) {
      this.#send(response, 404, { ok: false, reason: '未知来源' })
      return
    }
    if (request.method !== 'POST') {
      this.#send(response, 405, { ok: false, reason: '只接受 POST' })
      return
    }

    const body = await this.#readBody(request, response)
    if (body.reason) {
      if (body.dropped) entry.dropped++
      this.#send(response, body.status, { ok: false, reason: body.reason })
      return
    }
    if (!this.#authenticate(request, url, entry, body.raw)) {
      entry.dropped++
      this.logger?.warn?.(`webhook 来源 ${name} 鉴权失败`)
      this.#send(response, 401, { ok: false, reason: '鉴权失败' })
      return
    }
    if (!this.#rateAllowed(entry)) {
      entry.dropped++
      this.logger?.warn?.(`webhook 来源 ${name} 触发限频`)
      this.#send(response, 429, { ok: false, reason: '触发限频' })
      return
    }

    let payload = null
    try {
      payload = JSON.parse(body.raw)
    } catch {
      entry.dropped++
      this.#send(response, 400, { ok: false, reason: '请求体不是合法 JSON' })
      return
    }

    try {
      await this.onEvent({ source: entry.config, payload, raw: body.raw })
    } catch (error) {
      entry.dropped++
      this.logger?.warn?.(`webhook 来源 ${name} 处理失败：${errorText(error)}`)
      this.#send(response, 500, { ok: false, reason: `事件处理失败：${errorText(error)}` })
      return
    }

    entry.received++
    entry.lastAt = Number(this.now()) || Date.now()
    this.#send(response, 202, { ok: true })
  }

  /**
   * 鉴权：token（`X-Webhook-Token` 头或 `?token=`）或 GitHub 签名（`X-Hub-Signature-256`），
   * 二者之一通过即可；来源在构造时已保证至少有一个。
   */
  #authenticate(request, url, entry, raw) {
    if (entry.token) {
      const header = request.headers['x-webhook-token']
      const presented = typeof header === 'string' && header !== '' ? header : (url.searchParams.get('token') ?? '')
      if (safeEqual(entry.token, presented)) return true
    }
    if (entry.secret) {
      if (verifyHubSignature(raw, entry.secret, request.headers['x-hub-signature-256'])) return true
    }
    return false
  }

  /**
   * 读请求体：带体积上限。
   * - Content-Length 已超限 → 不看内容直接 413；
   * - 累积超限 → 立刻销毁连接（默认），不再继续接收；
   * - 返回 `{ raw }` 或 `{ status, reason, dropped }`。
   */
  #readBody(request, response) {
    return new Promise((resolve) => {
      const limit = this.maxBodyBytes
      const chunks = []
      let size = 0
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const overflow = () => {
        this.#sendOverflow(request, response)
        finish({ status: 413, reason: `请求体过大（上限 ${limit} 字节）`, dropped: true })
      }
      const declared = Number(request.headers['content-length'])
      if (Number.isFinite(declared) && declared > limit) {
        overflow()
        return
      }
      request.on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > limit) {
          overflow()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        if (settled) return
        finish({ raw: Buffer.concat(chunks).toString('utf8') })
      })
      request.on('error', () => finish({ status: 400, reason: '读取请求体失败', dropped: false }))
      request.on('aborted', () => finish({ status: 400, reason: '客户端中断了请求', dropped: false }))
    })
  }

  /**
   * 体积超限：回 413 之后**立刻停止读取**（request.destroy()），并主动收连接。
   *
   * 为什么收尾用 socket.end() 而不是 socket.destroy()（真机踩过的坑）：
   * `destroy()` 是 abortive close，内核会发 RST，还没被对端读走的 413 响应会被丢掉，
   * 客户端只看到 "fetch failed / connection reset"，等于没告诉它原因。
   * 这里改成等响应写完 → destroy(request) 停止累积 → socket.end() 发 FIN 优雅关闭，
   * 客户端能稳定拿到 413。计时器 unref，不会拖住进程退出。
   */
  #sendOverflow(request, response) {
    const reason = `请求体过大（上限 ${this.maxBodyBytes} 字节）`
    this.#send(response, 413, { ok: false, reason })
    if (!this.destroyOnOverflow) return
    const socket = request.socket
    // 先让已经进来的字节流走（resume 后不再进 chunks 累积），
    // 保证响应字节能完整冲刷出去，再收连接
    try { request.resume() } catch { /* 忽略 */ }
    const finish = () => {
      try { socket?.end() } catch { /* 已断开 */ }
    }
    response.once('finish', finish)
    const guard = setTimeout(finish, 1000)
    guard.unref?.()
    response.once('close', () => clearTimeout(guard))
  }

  /** 滑动窗口限频：保留最近 1 分钟内的命中时间戳。 */
  #rateAllowed(entry) {
    const now = Number(this.now()) || Date.now()
    const cutoff = now - RATE_WINDOW_MS
    while (entry.hits.length > 0 && entry.hits[0] <= cutoff) entry.hits.shift()
    if (entry.hits.length >= this.ratePerMinute) return false
    entry.hits.push(now)
    return true
  }
}
