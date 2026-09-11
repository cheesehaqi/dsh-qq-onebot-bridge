/**
 * Points economy (积分经济): per-chat balances, transfers, daily bonuses and a
 * leaderboard, stored as one small JSON file per chat so it survives restarts.
 *
 * Storage file (JSON, one file per chat key):
 * {
 *   "balances": { "2000000001": 12 },
 *   "names": { "2000000001": "小明" },
 *   "daily": { "2000000001": { "bonus": "2026-09-13", "messages": 7, "msgDate": "2026-09-13" } }
 * }
 *
 * Writes are atomic: a temp file in the same directory is flushed, then
 * renameSync replaces the target (rmSync({ force: true }) first, because
 * Windows renameSync cannot overwrite an existing file).
 * Intentionally dependency-free so it can be unit-tested without the bridge.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function pad(n) { return String(n).padStart(2, '0') }

/** 本地日期字符串（YYYY-MM-DD），用于「每自然日」判定。 */
function localDate(now) {
  const d = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now())
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function emptyBook() {
  return { balances: {}, names: {}, daily: {} }
}

function safeInt(value) {
  const n = Number(value)
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}

export class PointsStore {
  #dir = ''

  constructor(dir) {
    this.#dir = String(dir ?? '')
  }

  /** 会话文件路径：把 chatKey 里的非法字符换成下划线。 */
  file(chatKey) {
    return join(this.#dir, `${String(chatKey ?? '').replace(/[^\w-]/g, '_')}.json`)
  }

  /** 读账本；文件缺失或损坏时返回空账本（不抛异常）。 */
  #read(chatKey) {
    try {
      const data = JSON.parse(readFileSync(this.file(chatKey), 'utf8'))
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return emptyBook()
      const book = emptyBook()
      if (data.balances && typeof data.balances === 'object') {
        for (const [userId, points] of Object.entries(data.balances)) {
          const n = safeInt(points)
          if (n !== null) book.balances[String(userId)] = n
        }
      }
      if (data.names && typeof data.names === 'object') {
        for (const [userId, name] of Object.entries(data.names)) book.names[String(userId)] = String(name ?? '')
      }
      if (data.daily && typeof data.daily === 'object') {
        for (const [userId, entry] of Object.entries(data.daily)) {
          if (entry === null || typeof entry !== 'object') continue
          book.daily[String(userId)] = {
            bonus: String(entry.bonus ?? ''),
            messages: safeInt(entry.messages) ?? 0,
            msgDate: String(entry.msgDate ?? ''),
          }
        }
      }
      return book
    } catch {
      return emptyBook()
    }
  }

  /** 原子写账本：先写同目录临时文件再 rename，顺带清理可能残留的临时文件。 */
  #write(chatKey, book) {
    try {
      mkdirSync(this.#dir, { recursive: true })
      const target = this.file(chatKey)
      const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      writeFileSync(tmp, JSON.stringify(book, null, 2), 'utf8')
      try { rmSync(target, { force: true }) } catch { /* best effort */ }
      renameSync(tmp, target)
      return true
    } catch {
      return false
    }
  }

  /** 清理某会话残留的临时文件（best effort，只删自己命名的 .tmp）。 */
  cleanupTemps(chatKey = null) {
    const want = chatKey === null ? null : `${String(chatKey ?? '').replace(/[^\w-]/g, '_')}.json`
    try {
      for (const name of readdirSync(this.#dir)) {
        if (!name.endsWith('.tmp')) continue
        if (want !== null && !name.startsWith(want)) continue
        try { rmSync(join(this.#dir, name), { force: true }) } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
  }

  /** 当前余额；无记录返回 0。 */
  balance(chatKey, userId) {
    const book = this.#read(chatKey)
    return book.balances[String(userId ?? '')] ?? 0
  }

  /** 加减积分；amount 必须是有限整数，负数不得超过余额。返回新余额。 */
  add(chatKey, userId, amount, { name = '', now = Date.now() } = {}) {
    void now
    const delta = safeInt(amount)
    const book = this.#read(chatKey)
    const key = String(userId ?? '')
    const current = book.balances[key] ?? 0
    if (delta === null) return current
    if (name !== '') book.names[key] = String(name)
    if (current + delta < 0) return current
    book.balances[key] = current + delta
    this.#write(chatKey, book)
    return book.balances[key]
  }

  /** 转账；返回 { ok, error, fromBalance, toBalance }，错误文案中文。 */
  transfer(chatKey, fromUserId, toUserId, amount) {
    const from = String(fromUserId ?? '')
    const to = String(toUserId ?? '')
    const book = this.#read(chatKey)
    const fromBalance = book.balances[from] ?? 0
    const toBalance = book.balances[to] ?? 0
    const delta = safeInt(amount)
    const fail = (error) => ({ ok: false, error, fromBalance, toBalance })
    if (from === to) return fail('不能转给自己')
    if (delta === null || delta <= 0) return fail('金额非法')
    if (fromBalance < delta) return fail('余额不足')
    book.balances[from] = fromBalance - delta
    book.balances[to] = toBalance + delta
    this.#write(chatKey, book)
    return { ok: true, error: '', fromBalance: book.balances[from], toBalance: book.balances[to] }
  }

  /** 每日奖励；同一自然日只发一次。 */
  dailyBonus(chatKey, userId, { amount = 1, now = Date.now() } = {}) {
    const key = String(userId ?? '')
    const day = localDate(now)
    const book = this.#read(chatKey)
    const entry = book.daily[key] ?? { bonus: '', messages: 0, msgDate: '' }
    if (entry.bonus === day) return { granted: false, amount: 0 }
    const delta = safeInt(amount)
    const gain = delta === null || delta <= 0 ? 0 : delta
    entry.bonus = day
    book.daily[key] = entry
    book.balances[key] = (book.balances[key] ?? 0) + gain
    this.#write(chatKey, book)
    return { granted: true, amount: gain }
  }

  /** 发言奖励；每自然日封顶 dailyCap 点（默认 20 点/天，配合 amount=1 即 20 次发言）。 */
  messageBonus(chatKey, userId, { amount = 1, dailyCap = 20, now = Date.now() } = {}) {
    const key = String(userId ?? '')
    const day = localDate(now)
    const cap = safeInt(dailyCap)
    const book = this.#read(chatKey)
    const entry = book.daily[key] ?? { bonus: '', messages: 0, msgDate: '' }
    if (entry.msgDate !== day) { entry.msgDate = day; entry.messages = 0 }
    const delta = safeInt(amount)
    const gain = delta === null || delta <= 0 ? 0 : delta
    const ceiling = cap === null || cap < 0 ? Infinity : cap
    if (entry.messages + gain > ceiling) {
      book.daily[key] = entry
      this.#write(chatKey, book)
      return { granted: false, amount: 0 }
    }
    entry.messages += gain
    book.daily[key] = entry
    book.balances[key] = (book.balances[key] ?? 0) + gain
    this.#write(chatKey, book)
    return { granted: true, amount: gain }
  }

  /** 排行榜；按积分降序取前 limit 名。 */
  leaderboard(chatKey, limit = 10) {
    const book = this.#read(chatKey)
    const size = safeInt(limit)
    const max = size === null || size <= 0 ? 10 : size
    return Object.entries(book.balances)
      .map(([userId, points]) => ({ userId, name: book.names[userId] || userId, points }))
      .sort((a, b) => b.points - a.points || String(a.userId).localeCompare(String(b.userId)))
      .slice(0, max)
  }

  /** 记录昵称（不与余额挂钩）。 */
  setName(chatKey, userId, name) {
    const book = this.#read(chatKey)
    book.names[String(userId ?? '')] = String(name ?? '')
    return this.#write(chatKey, book)
  }
}

/** 排行榜中文多行文本，前三名带 🥇🥈🥉。 */
export function formatLeaderboard(rows, title = '💰 积分排行榜') {
  const titleText = String(title ?? '💰 积分排行榜')
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return `${titleText}\n暂无积分记录，快去发言赚积分吧～`
  const medals = ['🥇', '🥈', '🥉']
  const lines = list.map((row, index) => {
    const rank = medals[index] ?? `${index + 1}.`
    const name = String(row?.name ?? '').trim() || String(row?.userId ?? '未知')
    const points = safeInt(row?.points) ?? 0
    return `${rank} ${name} ${points} 分`
  })
  return [titleText, ...lines].join('\n')
}
