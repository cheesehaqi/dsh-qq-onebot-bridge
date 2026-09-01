/**
 * Daily check-in (每日签到): per-chat streak tracking with file persistence.
 * Intentionally dependency-free so it can be unit-tested without the bridge.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function pad(n) { return String(n).padStart(2, '0') }

export class CheckinStore {
  constructor(dir) {
    this.dir = dir
  }

  #file(chatKey) {
    return join(this.dir, `${String(chatKey).replace(/[^\w-]/g, '_')}.json`)
  }

  #load(chatKey) {
    try { return JSON.parse(readFileSync(this.#file(chatKey), 'utf8')) } catch { return {} }
  }

  #save(chatKey, data) {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.#file(chatKey), JSON.stringify(data), 'utf8')
  }

  static today() {
    const d = new Date()
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  static yesterday() {
    const d = new Date(Date.now() - 86_400_000)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  /** 签到一次；返回 { firstToday, streak, total }。 */
  checkin(chatKey, userId, name = '') {
    const data = this.#load(chatKey)
    const entry = data[userId] ?? { name: '', total: 0, streak: 0, last: '' }
    const today = CheckinStore.today()
    if (entry.last === today) return { firstToday: false, streak: entry.streak, total: entry.total }
    entry.name = name || entry.name || String(userId)
    entry.streak = entry.last === CheckinStore.yesterday() ? entry.streak + 1 : 1
    entry.total += 1
    entry.last = today
    data[userId] = entry
    this.#save(chatKey, data)
    return { firstToday: true, streak: entry.streak, total: entry.total }
  }

  /** 排行榜（按连续天数、累计天数降序）；today 标记今日已签。 */
  board(chatKey, limit = 10) {
    const data = this.#load(chatKey)
    const today = CheckinStore.today()
    return Object.entries(data)
      .map(([userId, e]) => ({ userId, name: e.name || userId, streak: e.streak ?? 0, total: e.total ?? 0, today: e.last === today }))
      .sort((a, b) => b.streak - a.streak || b.total - a.total)
      .slice(0, Math.max(1, Number(limit) || 10))
  }
}

/** 是否为签到意图（整句等于关键词，或带感叹号）。 */
export function isCheckinIntent(text, keyword = '签到') {
  const t = String(text).trim()
  const kw = String(keyword).trim()
  if (!kw || t === '') return false
  return t === kw || t === `${kw}！` || t === `${kw}!` || t === `${kw}。`
}

/** 是否为排行榜意图。 */
export function isCheckinBoardIntent(text) {
  const t = String(text).trim()
  return t === '签到榜' || t === '签到排行' || t === '/签到榜'
}
