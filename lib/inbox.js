/**
 * Inbound recording + event injection (v0.4 stage 3: "可复现").
 *
 * Recording: every frame the bridge receives is appended to `qq-inbox.jsonl` in a
 * serializable, replayable shape (no sockets, no functions), so any past message
 * can later be replayed offline through the real pipeline.
 *
 * Injection: the console writes a compact spec into `qq-inject.jsonl`; the bridge
 * polls it and feeds the expanded frame into the normal pipeline — by default in
 * dry-run, so a debug injection never reaches QQ.
 *
 * Dependency-free and injectable for tests.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { appendCappedLine } from './store.js'

/** Fields of an inbound event that are safe (and useful) to persist. */
export const FRAME_FIELDS = {
  message: ['messageType', 'userId', 'groupId', 'text', 'atMe', 'ats', 'reply', 'records', 'images', 'files', 'messageId', 'senderName'],
  notice: ['noticeType', 'subType', 'groupId', 'userId', 'targetId', 'operatorId', 'messageId', 'selfId', 'duration'],
  request: ['requestType', 'subType', 'userId', 'groupId', 'comment', 'flag', 'name', 'selfId'],
}

/**
 * Serialize one inbound event for the inbox file (drops sockets and unknowns).
 * `redact` masks digit runs of 6+ so a shared inbox file carries no real QQ ids.
 */
export function serializeFrame(kind, frame, { redact = false, now = Date.now() } = {}) {
  const fields = FRAME_FIELDS[kind]
  if (!fields) throw new Error(`unknown frame kind: ${kind}`)
  const body = {}
  for (const field of fields) {
    const value = frame?.[field]
    if (value === undefined || value === null) continue
    if (field === 'text' && typeof value === 'string') body[field] = value.slice(0, 2000)
    else body[field] = value
  }
  const entry = { v: 1, ts: now, kind, frame: body }
  if (redact) entry.frame = redactFrame(body)
  return JSON.stringify(entry)
}

/** Mask long digit runs (QQ ids) while keeping the shape readable. */
export function redactFrame(frame) {
  const walk = (value) => {
    if (typeof value === 'string') return value.replace(/\d{6,}/g, (digits) => `${digits.slice(0, 2)}${'*'.repeat(Math.max(1, digits.length - 2))}`)
    if (typeof value === 'number') {
      const text = String(value)
      return text.length >= 6 ? Number(`${text.slice(0, 2)}${'0'.repeat(text.length - 2)}`) : value
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, item] of Object.entries(value)) out[key] = walk(item)
      return out
    }
    return value
  }
  return walk(frame)
}

/** Append one frame to the inbox file (size-capped rotation, never throws). */
export class InboxRecorder {
  constructor({ file = '', enabled = true, redact = false, maxBytes = 2 * 1024 * 1024, keepBytes = 256 * 1024, now = () => Date.now() } = {}) {
    this.file = file
    this.enabled = enabled !== false
    this.redact = redact === true
    this.maxBytes = maxBytes
    this.keepBytes = keepBytes
    this.now = now
    this.count = 0
    this.dropped = 0
  }

  setEnabled(enabled) { this.enabled = enabled !== false }

  record(kind, frame) {
    if (!this.enabled || !this.file) return false
    try {
      const line = serializeFrame(kind, frame, { redact: this.redact, now: this.now() })
      if (appendCappedLine(this.file, line, { maxBytes: this.maxBytes, keepBytes: this.keepBytes })) {
        this.count += 1
        return true
      }
      this.dropped += 1
      return false
    } catch {
      this.dropped += 1
      return false
    }
  }

  summary() {
    return { enabled: this.enabled, file: this.file, redact: this.redact, recorded: this.count, dropped: this.dropped }
  }
}

/** Parse inbox JSONL text into entries (skips partial/broken lines). */
export function parseInbox(text, { kind = '', limit = 0 } = {}) {
  const entries = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    try {
      const entry = JSON.parse(trimmed)
      if (!entry || typeof entry.ts !== 'number' || !entry.frame) continue
      if (kind && entry.kind !== kind) continue
      entries.push(entry)
    } catch { /* 轮转可能截断首行 */ }
  }
  return limit > 0 ? entries.slice(-limit) : entries
}

/** Read the tail of the inbox file and list entries (newest last). */
export function readInbox(file, { limit = 50, kind = '', readFile = readFileSync, maxBytes = 1024 * 1024 } = {}) {
  let text = ''
  try { text = readFile(file, 'utf8') } catch { return [] }
  if (text.length > maxBytes) text = text.slice(-maxBytes)
  return parseInbox(text, { kind, limit })
}

/** Count complete non-empty lines in a JSONL queue file (0 when unreadable). */
export function countLines(file, { readFile = readFileSync } = {}) {
  try {
    return String(readFile(file, 'utf8')).split(/\r?\n/).filter((line) => line.trim().length > 0).length
  } catch {
    return 0
  }
}

/** Compact human description of one recorded frame (for the console list). */
export function describeFrame(entry) {
  const frame = entry?.frame ?? {}
  if (entry?.kind === 'message') {
    const where = frame.messageType === 'group' ? `群 ${frame.groupId}` : '私聊'
    return `${where} · ${frame.userId}${frame.atMe ? ' · @我' : ''}：${String(frame.text ?? '').slice(0, 60) || '（无文本）'}`
  }
  if (entry?.kind === 'notice') return `${frame.noticeType}/${frame.subType} · 群 ${frame.groupId ?? '-'} · 用户 ${frame.userId ?? '-'}`
  return `${frame.requestType}/${frame.subType} · 群 ${frame.groupId ?? '-'} · 用户 ${frame.userId ?? '-'}`
}

/**
 * Expand an injection spec (what the console/UI submits) into a normal inbound
 * event. Throws with a Chinese reason when the spec cannot be turned into one.
 *
 * spec: { kind:'message'|'notice'|'request', text, groupId, userId, atMe, images,
 *         records, files, replyMessageId, replyText, noticeType, subType,
 *         requestType, comment, flag }
 */
export function expandInjection(spec = {}, { botQq = 0, now = Date.now() } = {}) {
  const kind = spec.kind ?? 'message'
  const userId = Number(spec.userId) || 0
  if (!Number.isFinite(userId) || userId <= 0) throw new Error('请提供 userId（发消息的 QQ 号）')

  if (kind === 'notice') {
    const noticeType = String(spec.noticeType ?? 'notify').trim()
    const subType = String(spec.subType ?? (noticeType === 'notify' ? 'poke' : '')).trim()
    const groupId = Number(spec.groupId) || 0
    if (!groupId && noticeType !== 'friend_recall') throw new Error('notice 注入需要 groupId（好友撤回除外）')
    return { kind, frame: { noticeType, subType, groupId, userId, operatorId: userId, targetId: botQq, messageId: spec.messageId ?? `inject-${now}`, selfId: botQq } }
  }

  if (kind === 'request') {
    const requestType = spec.requestType === 'friend' ? 'friend' : 'group'
    const groupId = requestType === 'group' ? Number(spec.groupId) || 0 : 0
    if (requestType === 'group' && !groupId) throw new Error('群请求注入需要 groupId')
    return { kind, frame: { requestType, subType: spec.subType ?? 'add', userId, groupId, comment: String(spec.comment ?? ''), flag: String(spec.flag ?? `inject-${now}`), name: '' } }
  }

  const groupId = Number(spec.groupId) || 0
  const text = String(spec.text ?? '')
  const images = Array.isArray(spec.images) ? spec.images.map((url) => ({ kind: 'image', url: String(url), file: '' })) : []
  const records = Array.isArray(spec.records) ? spec.records.map((file) => ({ file: String(file), url: '' })) : []
  const files = Array.isArray(spec.files) ? spec.files.map((name) => ({ name: String(name), url: '', file: '' })) : []
  if (!text && images.length === 0 && records.length === 0 && files.length === 0) throw new Error('消息注入至少要有文本或图片/语音/文件')
  const reply = spec.replyMessageId ? { messageId: String(spec.replyMessageId), text: String(spec.replyText ?? '') } : null
  const atMe = spec.atMe === undefined ? Boolean(groupId) : spec.atMe === true
  return {
    kind,
    frame: {
      messageType: groupId ? 'group' : 'private',
      userId,
      groupId: groupId || undefined,
      text,
      atMe,
      ats: atMe && botQq ? [botQq] : [],
      reply,
      records,
      images,
      files,
      messageId: spec.messageId ?? `inject-${now}`,
      senderName: String(spec.senderName ?? '注入器'),
    },
  }
}

/** Byte offset just past the last complete (newline-terminated) line, or file size. */
function endOffset(file, { window = 8192 } = {}) {
  let size = 0
  try { size = statSync(file).size } catch { return null }
  if (size === 0) return 0
  const back = Math.min(size, window)
  const buffer = Buffer.allocUnsafe(back)
  let fd = null
  try {
    fd = openSync(file, 'r')
    readSync(fd, buffer, 0, back, size - back)
  } catch {
    return size
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
  }
  const cut = buffer.lastIndexOf(0x0a)
  return cut < 0 ? size : size - back + cut + 1
}

/**
 * Incremental reader for a JSONL queue (injection file, trace file): returns only
 * the complete lines appended since the previous call.
 *
 * Three properties matter for a debug channel:
 *  - a line that is still being written is buffered, never handed over half-decoded
 *    (so a torn write can never become a garbage injection or duplicate),
 *  - `initialOffset` defaults to "end of file", positioned EAGERLY, so restarting
 *    the bridge does not replay yesterday's injections — while a queue file that
 *    does not exist yet starts at 0, so the very first injection is not swallowed,
 *  - a file that disappears or shrinks is treated as brand new content (read it).
 */
export function createLineTailer(file, { initialOffset = null } = {}) {
  let offset = initialOffset === null ? (endOffset(file) ?? 0) : Math.max(0, initialOffset)
  let pending = Buffer.alloc(0)
  return {
    /** @returns {string[]} newly appended complete non-empty lines */
    poll() {
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        // 文件不存在：从 0 等它出现（否则队列文件第一次被创建时首行会被吞掉）
        offset = 0
        pending = Buffer.alloc(0)
        return []
      }
      if (size < offset) {
        // 被替换/截断：当前内容都是"新的"，从头读
        offset = 0
        pending = Buffer.alloc(0)
      }
      if (size <= offset) return []
      const length = size - offset
      const buffer = Buffer.allocUnsafe(length)
      let fd = null
      try {
        fd = openSync(file, 'r')
        readSync(fd, buffer, 0, length, offset)
      } catch {
        return []
      } finally {
        if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
      }
      offset = size
      const chunk = pending.length > 0 ? Buffer.concat([pending, buffer]) : buffer
      const cut = chunk.lastIndexOf(0x0a)
      if (cut < 0) {
        pending = Buffer.from(chunk)
        return []
      }
      pending = Buffer.from(chunk.subarray(cut + 1))
      return chunk.subarray(0, cut).toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
    },
    reset(toEnd = true) {
      pending = Buffer.alloc(0)
      offset = toEnd ? (endOffset(file) ?? 0) : 0
    },
    get position() { return offset },
    get pendingBytes() { return pending.length },
  }
}

/** Parse one injection line into { kind, frame } (throws with a Chinese reason). */
export function parseInjectionLine(line, { botQq = 0, now = Date.now() } = {}) {
  let spec
  try {
    spec = JSON.parse(String(line))
  } catch {
    throw new Error('注入行不是合法 JSON')
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('注入行必须是 JSON 对象')
  return expandInjection(spec, { botQq, now })
}
