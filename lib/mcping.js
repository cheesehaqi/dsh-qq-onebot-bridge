/**
 * Minecraft Java Edition Server List Ping (SLP) client: protocol encoding,
 * JSON status parsing and a dependency-free TCP probe built on node:net.
 * Everything here is offline-friendly and never throws to the caller.
 */
import { createConnection } from 'node:net'

const DEFAULT_PORT = 25565
const DEFAULT_TIMEOUT = 5000
const MAX_BODY = 2 * 1024 * 1024

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** VarInt 编码（32 位，负数按补码处理，最长 5 字节）。 */
export function encodeVarInt(value) {
  let rest = Number(value) | 0
  const bytes = []
  do {
    let byte = rest & 0x7f
    rest >>>= 7
    if (rest !== 0) byte |= 0x80
    bytes.push(byte)
  } while (rest !== 0)
  return Buffer.from(bytes)
}

/** VarInt 解码；截断或超过 5 字节时返回 { value: 0, size: 0 }。 */
export function decodeVarInt(buffer, offset = 0) {
  if (!Buffer.isBuffer(buffer)) return { value: 0, size: 0 }
  let value = 0
  for (let i = 0; i < 5; i += 1) {
    const pos = offset + i
    if (pos < 0 || pos >= buffer.length) return { value: 0, size: 0 }
    const byte = buffer[pos]
    value |= (byte & 0x7f) << (7 * i)
    if ((byte & 0x80) === 0) return { value: value | 0, size: i + 1 }
  }
  return { value: 0, size: 0 }
}

/** 带 VarInt 长度前缀的完整数据包。 */
function frame(payload) {
  return Buffer.concat([encodeVarInt(payload.length), payload])
}

function uint16be(value) {
  const buf = Buffer.allocUnsafe(2)
  buf.writeUInt16BE(value & 0xffff, 0)
  return buf
}

function safePort(port) {
  const value = Number(port)
  if (!Number.isInteger(value) || value < 1 || value > 65535) return DEFAULT_PORT
  return value
}

/**
 * Handshake 包（packet id 0x00 + protocol + host 长度前缀字符串 + port 大端 uint16 + next state 1）。
 * 返回值已带长度前缀，可直接写进 socket。
 */
export function buildHandshake(host, port, protocolVersion = 47) {
  const hostBuf = Buffer.from(String(host ?? ''), 'utf8')
  const payload = Buffer.concat([
    encodeVarInt(0x00),
    encodeVarInt(Number(protocolVersion) | 0),
    encodeVarInt(hostBuf.length),
    hostBuf,
    uint16be(safePort(port)),
    encodeVarInt(1),
  ])
  return frame(payload)
}

/** Status Request 包（packet id 0x00，空载荷）。 */
export function buildStatusRequest() {
  return frame(encodeVarInt(0x00))
}

/** Flatten a chat component (string / { text, extra }) into plain text. */
function flattenMotd(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (Array.isArray(node)) return node.map(flattenMotd).join('')
  if (typeof node === 'object') {
    let out = flattenMotd(node.text)
    if (Array.isArray(node.extra)) out += node.extra.map(flattenMotd).join('')
    if (out === '' && typeof node.translate === 'string') out = node.translate
    return out
  }
  return ''
}

/**
 * 解析 status 响应 JSON；缺字段一律容错为默认值。
 * 返回 { version, protocol, max, online, sample, motd, favicon, raw }。
 */
export function parseStatusJson(text) {
  let raw = text
  if (typeof text === 'string') {
    try { raw = JSON.parse(text) } catch { raw = {} }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {}

  const version = raw.version && typeof raw.version === 'object' ? String(raw.version.name ?? '') : ''
  const protocol = Math.trunc(num(raw.version && typeof raw.version === 'object' ? raw.version.protocol : 0, 0))
  const players = raw.players && typeof raw.players === 'object' ? raw.players : {}
  const sample = Array.isArray(players.sample)
    ? players.sample.map((item) => (typeof item === 'string' ? item : String(item?.name ?? ''))).filter((name) => name !== '')
    : []

  return {
    version,
    protocol,
    max: Math.trunc(num(players.max, 0)),
    online: Math.trunc(num(players.online, 0)),
    sample,
    motd: flattenMotd(raw.description),
    favicon: typeof raw.favicon === 'string' && raw.favicon.length > 0,
    raw,
  }
}

/** 空状态模板，保证离线结果字段形状与在线结果一致。 */
function emptyStatus() {
  return { version: '', protocol: 0, max: 0, online: 0, sample: [], motd: '', favicon: false, raw: {} }
}

/** 把 socket 错误码翻译成中文短句。 */
function errorText(code) {
  switch (code) {
    case 'ECONNREFUSED': return '连接被拒绝，服务器未开启或端口不对'
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return '域名解析失败，请检查服务器地址'
    case 'ETIMEDOUT': return '连接超时，服务器无响应'
    case 'ECONNRESET': return '连接被服务器重置'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return '网络不可达，请检查网络'
    case 'EPIPE': return '连接已断开'
    default: return `连接失败（${code || '未知错误'}）`
  }
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** 从已缓冲的数据里尝试读出一个完整 status 响应。 */
function readStatus(buffer) {
  if (buffer.length === 0) return { needMore: true }
  const length = decodeVarInt(buffer, 0)
  if (length.size === 0) {
    if (buffer.length >= 5) return { error: '返回数据格式不正确' }
    return { needMore: true }
  }
  if (length.value < 0 || length.value > MAX_BODY) return { error: '返回数据异常' }
  const total = length.size + length.value
  if (buffer.length < total) return { needMore: true }
  const body = buffer.subarray(length.size, total)
  const id = decodeVarInt(body, 0)
  if (id.size === 0 || id.value !== 0x00) return { error: '返回数据格式不正确' }
  const payload = parseJsonObject(body.subarray(id.size).toString('utf8'))
  if (!payload) return { error: '返回数据解析失败' }
  return { status: parseStatusJson(payload) }
}

/**
 * 查询 Minecraft Java 版服务器状态。
 * 任何失败（超时、连不上、解析失败）都返回 online:false + 中文 error，绝不 throw。
 * 成功时 online 为布尔标记，status 里的在线人数改放在 players:{online,max}。
 */
export function pingMcServer(host, port = DEFAULT_PORT, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const started = Date.now()
    const target = String(host ?? '').trim()
    const limit = Math.max(50, Math.trunc(num(timeoutMs, DEFAULT_TIMEOUT)))
    const offline = (error) => ({ ...emptyStatus(), online: false, latencyMs: Date.now() - started, error })

    if (target === '') { resolve(offline('服务器地址为空')); return }
    const portNum = Number(port)
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) { resolve(offline('端口无效，应为 1-65535')); return }

    let socket = null
    try {
      socket = createConnection({ host: target, port: portNum })
    } catch {
      resolve(offline('连接失败，地址无效'))
      return
    }

    let settled = false
    let hardTimer = null
    let buffer = Buffer.alloc(0)

    const finish = (value) => {
      if (settled) return
      settled = true
      if (hardTimer) clearTimeout(hardTimer)
      try { socket.destroy() } catch { /* already gone */ }
      resolve(value)
    }

    socket.setTimeout(limit)
    hardTimer = setTimeout(() => finish(offline('连接超时，服务器无响应')), limit + 200)

    socket.on('timeout', () => finish(offline('连接超时，服务器无响应')))
    socket.on('error', (err) => finish(offline(errorText(err?.code))))
    socket.on('close', () => finish(offline('连接已被服务器关闭')))
    socket.on('connect', () => {
      try {
        socket.write(Buffer.concat([buildHandshake(target, portNum), buildStatusRequest()]))
      } catch {
        finish(offline('发送查询请求失败'))
      }
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const parsed = readStatus(buffer)
      if (parsed.error) { finish(offline(parsed.error)); return }
      if (parsed.status) {
        const status = parsed.status
        finish({
          ...status,
          online: true,
          players: { online: status.online, max: status.max },
          latencyMs: Date.now() - started,
          error: '',
        })
      }
    })
  })
}

/**
 * 生成中文多行状态文案；离线时给出 error。
 * 既可传 pingMcServer 的结果（online:boolean + players），也可传 parseStatusJson 的结果（online 为人数）。
 */
export function formatMcStatus(result, { address = '' } = {}) {
  const data = result && typeof result === 'object' ? result : {}
  const where = String(address || '').trim() || 'Minecraft 服务器'
  const isOnline = data.online !== false && data.online !== undefined && data.online !== null
  if (!isOnline) {
    return [`❌ ${where} 离线`, `原因：${data.error || '未知错误'}`].join('\n')
  }
  const players = data.players && typeof data.players === 'object' ? data.players : {}
  const count = Math.trunc(num(players.online ?? (typeof data.online === 'number' ? data.online : 0), 0))
  const cap = Math.trunc(num(players.max ?? data.max, 0))
  const lines = [
    `✅ ${where} 在线`,
    `👥 在线人数：${count}/${cap}`,
    `🏷 版本：${data.version || '未知'}（协议 ${Math.trunc(num(data.protocol, 0))}）`,
    `⚡ 延迟：${Math.trunc(num(data.latencyMs, 0))} ms`,
  ]
  const motd = String(data.motd ?? '').replace(/\s+/g, ' ').trim()
  if (motd !== '') lines.push(`📝 ${motd}`)
  const sample = Array.isArray(data.sample) ? data.sample.filter((name) => String(name ?? '') !== '') : []
  if (sample.length > 0) {
    const shown = sample.slice(0, 5).join('、')
    lines.push(`🎮 玩家：${shown}${sample.length > 5 ? ` 等 ${sample.length} 人` : ''}`)
  }
  return lines.join('\n')
}

const MC_NOISE = new Set([
  'status', 'state', 'info', 'list', 'help', 'server', 'serverstatus', 'mc', 'mcstatus',
  '查询', '状态', '列表', '帮助', '服务器',
])

function splitAddress(token) {
  let host = ''
  let portText = ''
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(token)
  if (bracket) {
    host = bracket[1] ?? ''
    portText = bracket[2] ?? ''
  } else {
    const index = token.lastIndexOf(':')
    if (index === -1) {
      host = token
    } else if (token.indexOf(':') === index) {
      host = token.slice(0, index)
      portText = token.slice(index + 1)
      if (portText === '') return null
    } else {
      return null
    }
  }
  host = host.trim()
  if (host === '') return null
  if (portText === '') return { host, port: DEFAULT_PORT }
  if (!/^\d{1,5}$/.test(portText)) return null
  const port = Number(portText)
  if (port < 1 || port > 65535) return null
  return { host, port }
}

/**
 * 解析服务器地址写法：mc.example.com、mc.example.com:25566、/mc 1.2.3.4:25565、
 * mcstatus mc.example.com 等整句。无法解析时返回 null。
 */
export function parseMcAddress(text) {
  let rest = String(text ?? '').trim()
  if (rest === '') return null
  rest = rest.replace(/^[/!！]\s*/, '')
  const enPrefix = /^(?:mcstatus|serverstatus|mc)(?![a-z0-9])[\s:：]+/i
  const zhPrefix = /^(?:服务器状态|查服|查服务器)\s*[:：]?\s*/
  if (enPrefix.test(rest)) rest = rest.replace(enPrefix, '')
  else if (zhPrefix.test(rest)) rest = rest.replace(zhPrefix, '')

  for (const token of rest.split(/\s+/).filter(Boolean)) {
    const cleaned = token.replace(/[，。、,;；)）\]】]+$/, '')
    if (cleaned === '' || MC_NOISE.has(cleaned.toLowerCase())) continue
    return splitAddress(cleaned)
  }
  return null
}
