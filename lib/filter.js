/**
 * Chat moderation helpers: sensitive-word filtering (敏感词过滤) and flood detection (刷屏检测).
 * Intentionally dependency-free so both can be unit-tested without the bridge.
 */
import { readFileSync } from 'node:fs'

const REGEX_PREFIX = 're:'

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function toList(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined || value === '') return []
  return [value]
}

function miss() {
  return { hit: false, word: '', isRegex: false }
}

/** Compile one word-list line; returns null for blank/comment lines and never throws. */
function parseLine(line) {
  const text = String(line ?? '').trim()
  if (text === '' || text.startsWith('#')) return null
  if (text.startsWith(REGEX_PREFIX)) {
    const source = text.slice(REGEX_PREFIX.length).trim()
    if (source === '') return { kind: 'invalid', text }
    try { return { kind: 'pattern', text, source, re: new RegExp(source, 'i') } } catch { return { kind: 'invalid', text } }
  }
  return { kind: 'word', text }
}

/**
 * Parse a word-list text block into { words, patterns, invalid }.
 * One entry per line; "#" starts a comment, blank lines are ignored,
 * "re:<src>" compiles to a case-insensitive RegExp, and broken regexes
 * land in `invalid` instead of throwing.
 */
export function parseWordList(text) {
  const words = []
  const patterns = []
  const invalid = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const entry = parseLine(line)
    if (!entry) continue
    if (entry.kind === 'word') words.push(entry.text)
    else if (entry.kind === 'pattern') patterns.push(entry.re)
    else invalid.push(entry.text)
  }
  return { words, patterns, invalid }
}

/**
 * Sensitive-word filter with an allow list (白名单).
 * Plain words match by case-insensitive `includes`; both lists also accept
 * "re:" prefixed regular expressions. A whitelist hit always wins.
 */
export class WordFilter {
  #words = []
  #patterns = []
  #allowWords = []
  #allowPatterns = []

  constructor({ words = [], whitelist = [] } = {}) {
    for (const word of toList(words)) this.#add(word, false)
    for (const word of toList(whitelist)) this.#add(word, true)
  }

  #add(raw, allow) {
    const entry = parseLine(raw)
    if (!entry || entry.kind === 'invalid') return
    if (entry.kind === 'word') {
      const item = { text: entry.text, lower: entry.text.toLowerCase() }
      if (allow) this.#allowWords.push(item)
      else this.#words.push(item)
      return
    }
    if (allow) this.#allowPatterns.push(entry)
    else this.#patterns.push(entry)
  }

  /** Load from a text file; a missing/unreadable file yields an empty filter. */
  static fromFile(file) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return new WordFilter() }
    const { words, patterns } = parseWordList(text)
    return new WordFilter({ words: [...words, ...patterns.map((re) => `${REGEX_PREFIX}${re.source}`)] })
  }

  /** 检测文本：命中返回 { hit, word, isRegex }；白名单命中视为未命中。 */
  check(text) {
    const raw = String(text ?? '')
    if (raw === '') return miss()
    const lower = raw.toLowerCase()
    for (const item of this.#allowWords) if (lower.includes(item.lower)) return miss()
    for (const pattern of this.#allowPatterns) if (pattern.re.test(raw)) return miss()
    for (const item of this.#words) if (lower.includes(item.lower)) return { hit: true, word: item.text, isRegex: false }
    for (const pattern of this.#patterns) if (pattern.re.test(raw)) return { hit: true, word: pattern.source, isRegex: true }
    return miss()
  }

  /** 已配置的词条数（正则算一条，白名单不计入）。 */
  get size() {
    return this.#words.length + this.#patterns.length
  }
}

/**
 * Pure punishment decision helper so the policy is configurable and testable.
 * Returns 'mute' once the strike counter reaches muteAt, otherwise 'warn'.
 */
export function pickPunishment(strike, { warnAt = 1, muteAt = 3 } = {}) {
  const count = Math.max(0, Math.floor(num(strike, 0)))
  const muteLine = Math.max(1, Math.floor(num(muteAt, 3)))
  if (count >= muteLine) return 'mute'
  return 'warn'
}

/**
 * Sliding-window flood guard (刷屏检测).
 * observe() returns 'none' while the window holds <= maxMessages messages,
 * 'warn' for the first over-limit messages and 'mute' once the user has
 * accumulated strikeLimit strikes (window + strike are then reset).
 */
export class FloodGuard {
  #users = new Map()

  constructor({ windowSeconds = 10, maxMessages = 8, muteSeconds = 300, strikeLimit = 3 } = {}) {
    this.windowMs = Math.max(1, Math.floor(num(windowSeconds, 10))) * 1000
    this.maxMessages = Math.max(1, Math.floor(num(maxMessages, 8)))
    this.muteSeconds = Math.max(1, Math.floor(num(muteSeconds, 300)))
    this.strikeLimit = Math.max(1, Math.floor(num(strikeLimit, 3)))
  }

  #key(chatKey, userId) {
    return `${chatKey ?? ''}:${userId ?? ''}`
  }

  /** Drop long-idle entries once the table grows past ~1000 users. */
  #sweep(now) {
    if (this.#users.size <= 1000) return
    const cutoff = now - this.windowMs * this.strikeLimit
    for (const [key, entry] of this.#users) {
      if ((entry.last ?? 0) <= cutoff) this.#users.delete(key)
    }
  }

  /** 记录一条消息；返回 { action, count, muteSeconds, strike }。 */
  observe(chatKey, userId, now = Date.now()) {
    const time = num(now, Date.now())
    const key = this.#key(chatKey, userId)
    const entry = this.#users.get(key) ?? { times: [], strike: 0, last: 0 }
    const cutoff = time - this.windowMs
    entry.times = entry.times.filter((t) => t > cutoff)
    entry.times.push(time)
    entry.last = time
    const count = entry.times.length

    if (count <= this.maxMessages) {
      this.#users.set(key, entry)
      this.#sweep(time)
      return { action: 'none', count, muteSeconds: 0, strike: entry.strike }
    }

    const strike = entry.strike + 1
    if (pickPunishment(strike, { warnAt: 1, muteAt: this.strikeLimit }) === 'mute') {
      entry.times = []
      entry.strike = 0
      this.#users.set(key, entry)
      this.#sweep(time)
      return { action: 'mute', count, muteSeconds: this.muteSeconds, strike: 0 }
    }

    entry.strike = strike
    this.#users.set(key, entry)
    this.#sweep(time)
    return { action: 'warn', count, muteSeconds: 0, strike }
  }

  /** 清空某个用户在某个群的计数与警告次数。 */
  reset(chatKey, userId) {
    this.#users.delete(this.#key(chatKey, userId))
  }

  /** 当前跟踪的用户数（用于内存上限断言）。 */
  get size() {
    return this.#users.size
  }
}

const FILTER_CMD_RE = /^[/!！]?\s*(?:屏蔽|敏感词|badword|filter)\s*[:：]?\s*(add|del|delete|remove|list|添加|删除|列表)\s*[:：]?\s*(.*)$/i

/**
 * 解析屏蔽词管理命令：/屏蔽 add 词、/badword add 词、/屏蔽 del 词、/屏蔽 list。
 * 返回 { action: 'add'|'del'|'list', word }，无法识别时返回 null。
 */
export function parseFilterCommand(text) {
  const matched = FILTER_CMD_RE.exec(String(text ?? '').trim())
  if (!matched) return null
  const verb = matched[1].toLowerCase()
  const word = matched[2].trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  if (verb === 'list' || verb === '列表') return { action: 'list', word: '' }
  const action = verb === 'add' || verb === '添加' ? 'add' : 'del'
  if (word === '') return null
  return { action, word }
}
