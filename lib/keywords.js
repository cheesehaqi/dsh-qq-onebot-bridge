/**
 * Keyword auto-reply store (关键词问答库): a fully local trigger → reply table.
 * Answers are served straight from disk so they cost zero model tokens.
 *
 * Storage file (JSON):
 * {
 *   "version": 1,
 *   "global": [ { "trigger": "你好", "match": "contains", "reply": ["你好呀～"],
 *                 "image": "", "scope": "all", "cooldownSeconds": 0 } ],
 *   "chats":  { "g:123456": [ { "trigger": "^早安$", "match": "regex", "reply": ["早上好！"] } ] }
 * }
 *
 * Entry fields:
 *   trigger         匹配词（必填）
 *   match           'exact' | 'contains' | 'regex'（缺省 contains）
 *   reply           string[]，随机取一条
 *   image           图片地址/CQ 码，可为空
 *   scope           'all' | 'group' | 'private'（缺省 all）
 *   cooldownSeconds 同一 chats + trigger 的冷却秒数（缺省 0）
 *
 * Matching priority: exact > contains > regex，同级按 trigger 长度降序；
 * 聊天级条目优于全局条目；以 "/" 开头的命令与空文本永不参与匹配。
 * Intentionally dependency-free so it can be unit-tested without the bridge.
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'

const VERSION = 1
const MATCH_TYPES = ['exact', 'contains', 'regex']
const SCOPES = ['all', 'group', 'private']
const RANK = { exact: 0, contains: 1, regex: 2 }

function emptyData() {
  return { version: VERSION, global: [], chats: {} }
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) return []
  return [value]
}

/** 归一化单个条目；缺 trigger 或既无 reply 又无 image 时返回 null。 */
export function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const trigger = String(raw.trigger ?? '').trim()
  if (trigger === '') return null
  const match = MATCH_TYPES.includes(raw.match) ? raw.match : 'contains'
  const reply = asArray(raw.reply).map((item) => String(item ?? '')).filter((item) => item !== '')
  const image = String(raw.image ?? '').trim()
  if (reply.length === 0 && image === '') return null
  const scope = SCOPES.includes(raw.scope) ? raw.scope : 'all'
  const rawCooldown = Number(raw.cooldownSeconds ?? 0)
  const cooldownSeconds = Number.isFinite(rawCooldown) && rawCooldown > 0 ? rawCooldown : 0
  return { trigger, match, reply, image, scope, cooldownSeconds }
}

/** 归一化整个库结构；chatKey 条目带上来源标记 scope（不写回文件）。 */
function normalizeData(raw) {
  const out = emptyData()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  out.version = Number.isFinite(Number(raw.version)) ? Number(raw.version) : VERSION
  out.global = asArray(raw.global)
    .map((entry) => normalizeEntry(entry))
    .filter(Boolean)
    .map((entry) => ({ ...entry, source: 'global' }))
  const chats = raw.chats
  if (chats !== null && typeof chats === 'object' && !Array.isArray(chats)) {
    for (const [key, list] of Object.entries(chats)) {
      const entries = asArray(list)
        .map((entry) => normalizeEntry(entry))
        .filter(Boolean)
        .map((entry) => ({ ...entry, source: 'chat' }))
      if (entries.length > 0) out.chats[String(key)] = entries
    }
  }
  return out
}

/** 剥掉内存专用的 source 标记，得到可写回文件的原始结构。 */
function toStored(data) {
  const clean = (entry) => ({
    trigger: entry.trigger,
    match: entry.match,
    reply: entry.reply,
    image: entry.image,
    scope: entry.scope,
    cooldownSeconds: entry.cooldownSeconds,
  })
  const chats = {}
  for (const [key, list] of Object.entries(data.chats ?? {})) chats[key] = list.map(clean)
  return { version: data.version ?? VERSION, global: (data.global ?? []).map(clean), chats }
}

/** 解析管理员命令：/kw add 触发词 回复、/词库 add 你好 你好呀、/kw del 触发词、/kw list。 */
export function parseKeywordCommand(text) {
  const t = String(text ?? '').trim()
  const m = /^\/(?:kw|keyword|词库|关键词)\s+(\S+)\s*([\s\S]*)$/i.exec(t)
  if (!m) return null
  const action = m[1].toLowerCase()
  const body = m[2].trim()
  if (action === 'list') return { action: 'list', trigger: '', reply: '' }
  if (action !== 'add' && action !== 'del' && action !== 'remove') return null
  const parts = /^(\S+)\s*([\s\S]*)$/.exec(body)
  const trigger = parts ? parts[1] : ''
  if (trigger === '') return null
  const reply = parts ? parts[2].trim() : ''
  if (action === 'add') return { action: 'add', trigger, reply }
  return { action: 'remove', trigger, reply: '' }
}

export class KeywordStore {
  #file = ''
  #mtimeMs = -1
  #missing = false
  #data = emptyData()
  #cooldown = new Map()

  constructor(file) {
    this.#file = String(file ?? '')
  }

  /** 按 mtimeMs 缓存加载；文件不存在或 JSON 损坏时返回空库且不抛异常。 */
  load(force = false) {
    if (!this.#file) return this.#data
    let stat = null
    try {
      stat = statSync(this.#file)
    } catch {
      stat = null
    }
    if (stat === null) {
      // 文件不存在视为空库；只重置一次，避免丢掉内存里刚 add 的条目。
      if (!this.#missing) {
        this.#missing = true
        this.#mtimeMs = -1
        this.#data = emptyData()
      }
      return this.#data
    }
    this.#missing = false
    if (force !== true && stat.mtimeMs === this.#mtimeMs) return this.#data
    try {
      const raw = readFileSync(this.#file, 'utf8')
      this.#data = normalizeData(JSON.parse(raw))
      this.#mtimeMs = stat.mtimeMs
    } catch {
      this.#data = emptyData()
      this.#mtimeMs = stat.mtimeMs
      try { copyFileSync(this.#file, `${this.#file}.broken`) } catch { /* best effort */ }
    }
    return this.#data
  }

  #prune(now) {
    for (const [key, at] of this.#cooldown) {
      if (now - at > 3_600_000) this.#cooldown.delete(key)
    }
  }

  /** 匹配一条回复；命中返回 { reply, image, trigger }，否则 null。 */
  match(text, { chatKey = '', isGroup = false, now = Date.now(), rng = Math.random } = {}) {
    const t = String(text ?? '').trim()
    if (t === '' || t.startsWith('/')) return null
    const key = String(chatKey ?? '')
    const data = this.load()
    const pick = typeof rng === 'function' ? rng : Math.random
    this.#prune(now)

    const hits = []
    const collect = (list, source) => {
      for (const entry of list ?? []) {
        if (entry.scope === 'group' && isGroup !== true) continue
        if (entry.scope === 'private' && isGroup === true) continue
        if (!matchesText(entry, t)) continue
        hits.push({ entry, source })
      }
    }
    collect(data.chats[key], 'chat')
    collect(data.global, 'global')
    hits.sort((a, b) => RANK[a.entry.match] - RANK[b.entry.match]
      || b.entry.trigger.length - a.entry.trigger.length
      || (a.source === b.source ? 0 : a.source === 'chat' ? -1 : 1))
    const hit = hits[0]
    if (!hit) return null

    const entry = hit.entry
    const coolKey = `${key}\u0000${entry.trigger}`
    if (entry.cooldownSeconds > 0) {
      const last = this.#cooldown.get(coolKey)
      if (Number.isFinite(last) && now - last < entry.cooldownSeconds * 1000) return null
      this.#cooldown.set(coolKey, now)
    }
    const list = entry.reply.filter((item) => item !== '')
    return { reply: list.length > 0 ? list[Math.floor(pick() * list.length)] ?? list[0] : '', image: entry.image, trigger: entry.trigger }
  }

  /** 归一化后的条目数组（含来源标记 scope: 'global' | 'chat'）。 */
  list(chatKey = '') {
    const data = this.load()
    return [...(data.chats[String(chatKey ?? '')] ?? []), ...data.global]
  }

  /** 新增条目（同 trigger 覆盖）；非法条目返回 false。 */
  add(entry, chatKey = '') {
    const normalized = normalizeEntry(entry)
    if (normalized === null) return false
    const data = this.load()
    const key = String(chatKey ?? '')
    const stored = { ...normalized, source: key === '' ? 'global' : 'chat' }
    if (key === '') {
      data.global = [...data.global.filter((item) => item.trigger !== normalized.trigger), stored]
    } else {
      const list = (data.chats[key] ?? []).filter((item) => item.trigger !== normalized.trigger)
      data.chats[key] = [...list, stored]
    }
    return true
  }

  /** 删除条目（聊天级优先，其次全局）；删除成功返回 true。 */
  remove(trigger, chatKey = '') {
    const want = String(trigger ?? '').trim()
    if (want === '') return false
    const data = this.load()
    const key = String(chatKey ?? '')
    const scopes = key === '' ? ['global'] : [key, 'global']
    for (const scope of scopes) {
      const list = scope === 'global' ? data.global : (data.chats[scope] ?? [])
      const next = list.filter((item) => item.trigger !== want)
      if (next.length !== list.length) {
        if (scope === 'global') data.global = next
        else data.chats[scope] = next
        return true
      }
    }
    return false
  }

  /** 写回文件（保留容错：写失败只返回 false，不抛异常）。 */
  save() {
    if (!this.#file) return false
    try {
      if (!existsSync(this.#file)) this.load(true)
      writeFileSync(this.#file, JSON.stringify(toStored(this.#data), null, 2), 'utf8')
      try { this.#mtimeMs = statSync(this.#file).mtimeMs } catch { this.#mtimeMs = -1 }
      return true
    } catch {
      return false
    }
  }
}

/** 单条条目的匹配判定（exact 用整句相等，contains 用子串，regex 用正则）。 */
function matchesText(entry, text) {
  try {
    if (entry.match === 'exact') return text === entry.trigger
    if (entry.match === 'regex') return new RegExp(entry.trigger, 'i').test(text)
    return text.includes(entry.trigger)
  } catch {
    return false
  }
}
