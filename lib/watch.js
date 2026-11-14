/**
 * 群关键词订阅：成员订阅一个词，群里有人说到时私聊提醒。
 * 纯存储 + 纯匹配，不发消息；bridge 负责 OneBot 投递。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const WATCH_MAX_PER_USER = 20
export const WATCH_COOLDOWN_MS = 5 * 60_000

/** `/订阅 关键词`、`/订阅列表`、`/取消订阅 关键词`。 */
export function parseWatchCommand(text) {
  const source = String(text ?? '').trim()
  const cancel = /^[\/／](?:取消订阅|取消watch)\s+(.+)$/i.exec(source)
  if (cancel) return { action: 'remove', keyword: cancel[1].trim().slice(0, 30) }
  const matched = /^[\/／](?:订阅|watch)(?:\s+(.*))?$/.exec(source)
  if (!matched) return null
  const arg = String(matched[1] ?? '').trim()
  if (arg === '' || /^(?:列表|list)$/i.test(arg)) return { action: 'list' }
  const remove = /^(?:取消|删除|del|remove)\s+(.+)$/i.exec(arg)
  if (remove) return { action: 'remove', keyword: remove[1].trim().slice(0, 30) }
  return { action: 'add', keyword: arg.slice(0, 30) }
}

export class WatchStore {
  constructor(directory) {
    this.directory = directory
  }

  #file(chatKey) {
    return join(this.directory, `${String(chatKey).replace(/[^\w-]/g, '_')}.json`)
  }

  list(chatKey) {
    try {
      const data = JSON.parse(readFileSync(this.#file(chatKey), 'utf8'))
      return Array.isArray(data) ? data.filter((item) => item && typeof item.keyword === 'string' && Number.isFinite(Number(item.userId))) : []
    } catch {
      return []
    }
  }

  #save(chatKey, list) {
    try {
      mkdirSync(this.directory, { recursive: true })
      writeFileSync(this.#file(chatKey), JSON.stringify(list, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  }

  add(chatKey, { keyword, userId, name = '' } = {}) {
    const word = String(keyword ?? '').trim().slice(0, 30)
    const uid = Number(userId)
    if (word.length < 2) return { ok: false, reason: '关键词至少 2 个字' }
    if (!Number.isFinite(uid)) return { ok: false, reason: '缺少用户 ID' }
    const list = this.list(chatKey)
    if (list.some((item) => Number(item.userId) === uid && String(item.keyword).toLowerCase() === word.toLowerCase())) {
      return { ok: false, reason: '你已经订阅过这个词了' }
    }
    if (list.filter((item) => Number(item.userId) === uid).length >= WATCH_MAX_PER_USER) {
      return { ok: false, reason: `每人最多订阅 ${WATCH_MAX_PER_USER} 个词` }
    }
    const item = { id: `${uid}-${Date.now().toString(36)}`, userId: uid, name: String(name || '').slice(0, 40), keyword: word, createdAt: Date.now(), lastAt: 0 }
    if (!this.#save(chatKey, [...list, item])) return { ok: false, reason: '订阅保存失败（目录不可写）' }
    return { ok: true, item }
  }

  remove(chatKey, { keyword, userId } = {}) {
    const word = String(keyword ?? '').trim().toLowerCase()
    const uid = Number(userId)
    const list = this.list(chatKey)
    const next = list.filter((item) => !(Number(item.userId) === uid && String(item.keyword).toLowerCase() === word))
    if (next.length === list.length) return { ok: false, reason: '没有找到这条订阅' }
    return { ok: this.#save(chatKey, next), removed: list.length - next.length }
  }

  touch(chatKey, ids, at = Date.now()) {
    const wanted = new Set((ids ?? []).map(String))
    const list = this.list(chatKey).map((item) => (wanted.has(String(item.id)) ? { ...item, lastAt: at } : item))
    this.#save(chatKey, list)
  }
}

/** 找出当前消息命中的订阅；跳过发送者自己、冷却中的、空关键词。 */
export function findWatchMatches(entries, text, { senderId = 0, cooldownMs = WATCH_COOLDOWN_MS, now = Date.now() } = {}) {
  const haystack = String(text ?? '').toLowerCase()
  if (haystack.trim() === '') return []
  return (entries ?? []).filter((entry) => {
    if (!entry || Number(entry.userId) === Number(senderId)) return false
    const word = String(entry.keyword ?? '').trim().toLowerCase()
    if (word.length < 2 || !haystack.includes(word)) return false
    return now - (Number(entry.lastAt) || 0) >= cooldownMs
  })
}
