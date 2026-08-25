/**
 * OneBot v11 transport: reverse-WebSocket server.
 *
 * The plugin listens on 127.0.0.1:<port>; a OneBot implementation
 * (LLOneBot / OpenShamrock / NapCat / Lagrange / go-cqhttp) connects TO us
 * using its `ws-reverse://` configuration. Every accepted connection is one
 * bot instance.
 */
import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'

const ACTION_TIMEOUT_MS = 10_000

export function parseMessage(rawMessage, botQq) {
  let text = ''
  const ats = []
  const records = []
  const images = []
  let reply = null
  if (typeof rawMessage === 'string') {
    const atRe = /\[CQ:at,qq=(\d+)(?:,name=([^\]]*))?\]/g
    let match
    while ((match = atRe.exec(rawMessage)) !== null) ats.push(Number(match[1]))
    const replyMatch = /\[CQ:reply,id=([^,\]]+)(?:,text=([^\]]*))?\]/.exec(rawMessage)
    if (replyMatch) reply = { messageId: replyMatch[1], text: replyMatch[2] ?? '' }
    const recordRe = /\[CQ:record,([^\]]*)\]/g
    while ((match = recordRe.exec(rawMessage)) !== null) {
      const file = /(?:^|,)file=([^,\]]+)/.exec(match[1])
      const url = /(?:^|,)url=([^,\]]+)/.exec(match[1])
      records.push({ file: file ? file[1] : '', url: url ? url[1] : '' })
    }
    const imageRe = /\[CQ:(image|mface),([^\]]*)\]/g
    while ((match = imageRe.exec(rawMessage)) !== null) {
      const url = /(?:^|,)url=([^,\]]+)/.exec(match[2])
      images.push({ kind: match[1], url: url ? url[1] : '', file: '' })
    }
    text = stripCq(rawMessage.replace(/\[CQ:at[^\]]*\]/g, ' ').replace(/\[CQ:reply[^\]]*\]/g, ' '))
  } else if (Array.isArray(rawMessage)) {
    const parts = []
    for (const segment of rawMessage) {
      if (!segment || typeof segment !== 'object') continue
      if (segment.type === 'text') parts.push((segment.data && segment.data.text) ?? '')
      else if (segment.type === 'at') ats.push(Number((segment.data && segment.data.qq) ?? 0))
      else if (segment.type === 'reply') {
        reply = { messageId: segment.data?.id ?? '', text: segment.data?.text ?? '' }
      } else if (segment.type === 'record') {
        records.push({
          file: segment.data?.file ?? '',
          url: segment.data?.url ?? '',
          path: segment.data?.path ?? '',
        })
      } else if (segment.type === 'image' || segment.type === 'mface') {
        images.push({
          kind: segment.type,
          url: segment.data?.url ?? '',
          file: segment.data?.file ?? '',
          summary: segment.data?.summary ?? '',
        })
      }
    }
    text = parts.join(' ')
  }
  return { text: text.replace(/\s+/g, ' ').trim(), ats, records, images, reply }
}

function stripCq(text) {
  // Keep CQ:at with names readable; drop image/face/etc. payload noise.
  return String(text)
    .replace(/\[CQ:at,qq=(\d+)(?:,name=([^\]]*))?\]/g, (_m, qq, name) => name ? `@${name}` : `@${qq}`)
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export class OneBotServer extends EventEmitter {
  #wss = null
  #connections = new Map()
  #echo = 0
  #pending = new Map()

  constructor(config, logger) {
    super()
    this.config = config
    this.logger = logger
  }

  start() {
    const { host, port, accessToken } = this.config
    this.#wss = new WebSocketServer({ host, port })
    this.#wss.on('listening', () => {
      this.logger.info(`OneBot reverse-WS listening on ws://${host}:${port}`)
    })
    this.#wss.on('error', (error) => {
      this.logger.error(`OneBot server error: ${error.message}`)
      this.emit('error', error)
    })
    this.#wss.on('connection', (socket, request) => this.#accept(socket, request))
    return new Promise((resolve) => {
      if (this.#wss.address() !== null) resolve()
      else this.#wss.once('listening', resolve)
    })
  }

  async stop() {
    for (const socket of this.#connections.values()) {
      try { socket.close(1000, 'bridge shutdown') } catch {}
    }
    this.#connections.clear()
    if (this.#wss) await new Promise((resolve) => this.#wss.close(() => resolve()))
    this.#wss = null
  }

  #accept(socket, request) {
    const token = extractBearer(request)
    if (this.config.accessToken && token !== this.config.accessToken) {
      this.logger.warn(`OneBot connection rejected (bad access token) from ${request.socket.remoteAddress}`)
      socket.close(4001, 'invalid access token')
      return
    }
    const id = `${request.socket.remoteAddress}:${Date.now()}:${++this.#echo}`
    this.#connections.set(id, socket)
    this.logger.info(`OneBot bot connected (${this.#connections.size} active)`)
    socket.on('message', (data) => this.#onFrame(socket, data))
    socket.on('close', () => {
      this.#connections.delete(id)
      this.logger.info(`OneBot bot disconnected (${this.#connections.size} active)`)
      this.emit('bot-disconnect', socket)
    })
    socket.on('error', () => {})
    this.emit('bot-connect', socket)
  }

  #onFrame(socket, data) {
    let frame
    try { frame = JSON.parse(String(data)) } catch { return }
    if (frame.echo !== undefined) {
      const pending = this.#pending.get(String(frame.echo))
      if (pending) {
        this.#pending.delete(String(frame.echo))
        pending(frame)
      }
      return
    }
    if (frame.post_type === 'message' && frame.message_type) {
      const userId = Number(frame.user_id)
      const messageType = frame.message_type === 'group' ? 'group' : 'private'
      const groupId = messageType === 'group' ? Number(frame.group_id) : undefined
      const parsed = parseMessage(frame.message, this.config.botQq ?? 0)
      if ((parsed.text === '' && parsed.records.length === 0 && parsed.images.length === 0) || !Number.isFinite(userId)) return
      const atMe = messageType === 'group'
        ? (this.config.botQq ?? 0) === 0 || parsed.ats.includes(this.config.botQq)
        : false
      this.emit('message', {
        bot: socket,
        userId,
        messageType,
        groupId,
        text: parsed.text,
        atMe,
        reply: parsed.reply,
        records: parsed.records,
        images: parsed.images,
        messageId: frame.message_id,
        raw: frame,
      })
    }
  }

  sendText(socket, messageType, targetId, text) {
    return this.sendSegments(socket, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  /** Send a message as an array of CQ segments (text/face/image). */
  sendSegments(socket, messageType, targetId, segments) {
    const action = messageType === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = { message: segments }
    if (messageType === 'group') params.group_id = targetId
    else params.user_id = targetId
    return this.#call(socket, action, params)
  }

  /** Fetch the full content of a message by id (for quote/reply resolution). */
  getMsg(socket, messageId) {
    return this.#call(socket, 'get_msg', { message_id: Number(messageId) })
  }

  /** Fetch a voice record (optionally converted) — resolves to data.base64. */
  getRecord(socket, file, outFormat = 'mp3') {
    return this.#call(socket, 'get_record', { file, out_format: outFormat })
  }

  /** The most recently connected open bot socket (for delayed sends after reconnects). */
  currentSocket() {
    for (const socket of this.#connections.values()) {
      if (socket.readyState === socket.OPEN) return socket
    }
    return null
  }

  #call(socket, action, params) {
    const echo = `qq-${++this.#echo}`
    const frame = JSON.stringify({ action, params, echo })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        reject(new Error(`OneBot action ${action} timed out`))
      }, ACTION_TIMEOUT_MS)
      this.#pending.set(echo, (response) => {
        clearTimeout(timer)
        if (response && response.status === 'ok' && response.retcode === 0) resolve(response.data)
        else reject(new Error(`OneBot action ${action} failed: ${JSON.stringify(response)}`))
      })
      if (socket.readyState === socket.OPEN) socket.send(frame)
      else {
        clearTimeout(timer)
        this.#pending.delete(echo)
        console.error(`[qq-bridge] OneBot send failed: action=${action} readyState=${socket.readyState}`)
        reject(new Error('OneBot connection closed'))
      }
    })
  }
}

function extractBearer(request) {
  const header = request.headers && request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
  return ''
}
