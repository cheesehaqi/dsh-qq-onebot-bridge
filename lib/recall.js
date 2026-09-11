/**
 * Anti-recall support (防撤回): an in-memory per-chat message cache plus the Chinese
 * notice text used to re-send a message somebody withdrew.
 *
 * The cache only keeps a small window per chat (maxPerChat) and drops stale entries
 * (maxAgeMs), so a long-running bridge process cannot grow without bound. The host
 * feeds every inbound group/private message into remember() and, when OneBot reports
 * a group_recall / friend_recall notice, pulls the entry out with recall() and sends
 * formatRecallNotice(entry) back to the chat.
 *
 * Pure data structure — no I/O, no timers, no dependencies.
 */

/** Newest-first insertion; replaces an existing entry with the same messageId. */
function insertEntry(list, entry) {
  const index = list.findIndex((item) => item.messageId === entry.messageId)
  if (index >= 0) list.splice(index, 1)
  list.push(entry)
}

/** Trim leading/trailing whitespace and collapse inner line breaks. */
function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** Only http(s) / data URLs count as re-sendable images. */
function isImageUrl(value) {
  const s = String(value ?? '').trim()
  return /^https?:\/\//i.test(s) || /^data:image\//i.test(s)
}

/** 每个群/私聊的防撤回缓存，附带落盘序列化。 */
export class RecallCache {
  #data = new Map()
  #maxPerChat
  #maxAgeMs
  #now

  constructor({ maxPerChat = 50, maxAgeMs = 3600000, now = () => Date.now() } = {}) {
    this.#maxPerChat = Number.isFinite(maxPerChat) && maxPerChat > 0 ? Math.trunc(maxPerChat) : 50
    this.#maxAgeMs = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : 3600000
    this.#now = typeof now === 'function' ? now : () => Date.now()
  }

  get maxPerChat() {
    return this.#maxPerChat
  }

  get maxAgeMs() {
    return this.#maxAgeMs
  }

  /** 记录一条消息；同一 messageId 覆盖更新，超过 maxPerChat 丢弃最旧的。 */
  remember(chatKey, entry) {
    const key = String(chatKey ?? '')
    const raw = entry && typeof entry === 'object' ? entry : {}
    const messageId = String(raw.messageId ?? '').trim()
    if (messageId === '') return null
    const normalized = {
      messageId,
      userId: String(raw.userId ?? ''),
      name: String(raw.name ?? ''),
      text: String(raw.text ?? ''),
      images: Array.isArray(raw.images) ? raw.images.filter(isImageUrl) : [],
      at: Number.isFinite(raw.at) ? Number(raw.at) : this.#now(),
    }
    const list = this.#data.get(key) ?? []
    insertEntry(list, normalized)
    while (list.length > this.#maxPerChat) list.shift()
    this.#data.set(key, list)
    return normalized
  }

  /** 取出并移除一条消息；未命中返回 null。 */
  recall(chatKey, messageId) {
    const key = String(chatKey ?? '')
    const id = String(messageId ?? '')
    const list = this.#data.get(key)
    if (!list || list.length === 0 || id === '') return null
    const index = list.findIndex((item) => item.messageId === id)
    if (index < 0) return null
    const [entry] = list.splice(index, 1)
    if (list.length === 0) this.#data.delete(key)
    return entry
  }

  /** 最近一条（不移除），没有则返回 null。 */
  last(chatKey) {
    const list = this.#data.get(String(chatKey ?? ''))
    if (!list || list.length === 0) return null
    return list[list.length - 1]
  }

  /** 按 maxAgeMs 清理过期条目，返回被清理的条数。 */
  prune(now = this.#now()) {
    const cutoff = Number.isFinite(now) ? now : this.#now()
    let removed = 0
    for (const [key, list] of [...this.#data.entries()]) {
      const kept = list.filter((entry) => cutoff - entry.at <= this.#maxAgeMs)
      removed += list.length - kept.length
      if (kept.length === 0) this.#data.delete(key)
      else this.#data.set(key, kept)
    }
    return removed
  }

  size(chatKey) {
    return this.#data.get(String(chatKey ?? ''))?.length ?? 0
  }

  /** 清空某个会话；不传参数时清空全部。 */
  clear(chatKey) {
    if (chatKey === undefined || chatKey === null) this.#data.clear()
    else this.#data.delete(String(chatKey))
  }

  /** 导出为可 JSON 落盘的结构（每个会话按 maxPerChat 截断）。 */
  toJSON() {
    const chats = {}
    let total = 0
    for (const [key, list] of this.#data) {
      const trimmed = list.slice(-this.#maxPerChat)
      chats[key] = trimmed.map((entry) => ({
        messageId: entry.messageId,
        userId: entry.userId,
        name: entry.name,
        text: entry.text,
        images: [...entry.images],
        at: entry.at,
      }))
      total += trimmed.length
    }
    return { version: 1, maxPerChat: this.#maxPerChat, maxAgeMs: this.#maxAgeMs, savedAt: this.#now(), total, chats }
  }

  /** 从 toJSON() 的结构恢复；结构不合法时返回空缓存。 */
  static fromJSON(data, options = {}) {
    const cache = new RecallCache(options)
    const chats = data && typeof data === 'object' && data.chats && typeof data.chats === 'object' ? data.chats : {}
    for (const [key, list] of Object.entries(chats)) {
      if (!Array.isArray(list)) continue
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue
        cache.remember(key, raw)
      }
    }
    return cache
  }
}

/**
 * 防撤回播报文案（中文）。entry 为空或内容为空时给出占位说明。
 * 返回 { text, images, botName }：text 可当字符串直接用（toString/toJSON 已实现），
 * images 供宿主把图片与文字一并补发。
 */
export function formatRecallNotice(entry, { botName = '机器人' } = {}) {
  const who = cleanText(entry?.name) || cleanText(entry?.userId) || '有人'
  const text = cleanText(entry?.text)
  const images = Array.isArray(entry?.images) ? entry.images.filter(isImageUrl) : []
  const lines = [`🕵️ ${who} 撤回了一条消息：`, `内容：${text || '（内容为空或无法获取）'}`]
  if (images.length === 1) lines.push('（含 1 张图片，已一并补发）')
  else if (images.length > 1) lines.push(`（含 ${images.length} 张图片，已一并补发）`)
  const body = lines.join('\n')
  const name = String(botName ?? '').trim() || '机器人'
  return { text: body, images: [...images], botName: name, toString: () => body, toJSON: () => body }
}

/** 是否为撤回通知（group_recall / friend_recall）。 */
export function isRecallNotice(notice) {
  if (!notice || typeof notice !== 'object') return false
  const type = String(notice.noticeType ?? '')
  return type === 'group_recall' || type === 'friend_recall'
}
