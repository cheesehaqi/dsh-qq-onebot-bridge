/**
 * 群聊/私聊消息的**归档**（历史检索底座）：把每条消息落盘成按天分片的
 * `YYYY-MM-DD.jsonl`，供 `/找 关键词` 在本地翻旧账。
 *
 * 为什么另起一套而不是复用 lib/inbox.js：`qq-inbox.jsonl` 有 2 MiB 轮转上限，
 * 它的定位是"给模型回放最近几条"，写满就被截断；检索需要的是**不会被轮转吃掉**的
 * 长期归档，所以这里按天切片、永不自截断（过期分片只是被移到回收站）。
 *
 * 设计取舍：
 * - **按本地日期分片**（不是 UTC）：东八区凌晨 0~8 点的消息若按 UTC 算会被塞进
 *   前一天的文件，"最近 N 天"的检索窗口就会莫名其妙漏掉当天。日期格式化自备，
 *   不用 `toISOString()`。
 * - **过期只移不删**：`prune()` 把过期分片搬到回收站目录（未给 `trashDir` 时是
 *   `dir` 同级的 `qq-trash/<当天>/`），与 lib/store.js 的删除策略一致。
 * - **落盘行是自包含的纯文本**：`archiveLine()` 把空白压平、2000 字截断，
 *   保证"一条记录一行"，换行符永远不会把一条消息劈成两行、毁掉按行解析。
 * - **检索从新到旧**：只扫 `days` 天的分片，读满 `limit` 条就提前收工，
 *   所以 `scanned` 是"真正读了多少行"，越新的数据越快命中。
 *
 * 与 lib/history.js 是**同族但独立**的模块（那边是 OneBot 历史消息的规范化与排版）：
 * 容错取向一致，但刻意不互相 import，任一方改动都不会牵连另一方。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 单条文本落盘上限（字符）。 */
const MAX_TEXT_CHARS = 2000
/** 单次检索最多接受多少个检索词（挡住病态超长关键词）；超出部分忽略。 */
const MAX_TERMS = 8
/** 单个分片最多读多少行（挡住畸形巨型文件的极端情况）。 */
const MAX_LINES_PER_FILE = 200000
/** 分片文件名形状：`YYYY-MM-DD.jsonl`。 */
const SHARD_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
/** 默认保留天数。 */
const DEFAULT_KEEP_DAYS = 90
/** 默认单次检索条数。 */
const DEFAULT_LIMIT = 20
/** 默认检索窗口天数。 */
const DEFAULT_DAYS = 7

const pad2 = (n) => String(n).padStart(2, '0')

/** 归一化数值字段：非有限数（NaN / Infinity / 'abc' / undefined）→ 0。 */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 归一化字符串字段：非字符串或缺失 → ''。 */
function str(value) {
  return typeof value === 'string' ? value : ''
}

/** 压平空白：换行/制表/连续空格/全角空格 → 单个半角空格，并 trim。 */
function collapse(value) {
  return String(value ?? '').replace(/[\s\u3000]+/g, ' ').trim()
}

/** 硬截断到 `max` 字符；超出时补省略号（未超出返回原文）。 */
function clip(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 本地日期 → `YYYY-MM-DD`。
 * 刻意不用 `toISOString()`：那个是 UTC 日期，东八区凌晨的消息会落到前一天的分片里。
 */
function dayOf(date) {
  const d = (date instanceof Date) ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return dayOf(new Date())
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 偏移 `offset` 天后的日期字符串（本地时区，按"日期"加减，不踩夏令时的坑）。 */
function dayOffset(baseMs, offset) {
  const d = new Date(num(baseMs))
  if (Number.isNaN(d.getTime())) return dayOf(new Date())
  d.setDate(d.getDate() + offset)
  return dayOf(d)
}

/** `YYYY-MM-DD` 字符串是否合法（同时挡住 '2026-13-45' 这类形状对但值不对的）。 */
function isValidDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const probe = new Date(y, m - 1, d)
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d
}

/** 把分片内容按行解析成记录，坏行跳过（不抛错）。返回 { records, lines }。 */
function readShard(file) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return { records: [], lines: 0 } }
  // CRLF 文件同样按行切开（\r 会被 JSON.parse 当空白吃掉，但统一剥掉更稳）
  const lines = text.split('\n')
  let count = 0
  const records = []
  for (const raw of lines) {
    if (count >= MAX_LINES_PER_FILE) break
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() === '') continue
    count++
    const record = parseArchiveLine(line)
    if (record !== null) records.push(record)
  }
  return { records, lines: count }
}

/**
 * 把一条记录序列化成单行 JSON（**不含换行符**）。
 * 文本里的换行会被替换成空格、连续空白压成一个，并截断到 2000 字。
 * @param {{ ts?: number, chatKey?: string, userId?: number, name?: string, kind?: string, text?: string }} record
 * @returns {string}
 */
export function archiveLine(record) {
  const source = (record !== null && typeof record === 'object') ? record : {}
  // 字段顺序固定：ts 最前，方便肉眼看文件时快速定位时间
  const normalized = {
    ts: num(source.ts),
    chatKey: str(source.chatKey),
    userId: num(source.userId),
    name: str(source.name),
    kind: str(source.kind),
    text: clip(collapse(source.text), MAX_TEXT_CHARS),
  }
  try {
    return JSON.stringify(normalized)
  } catch {
    // 理论上进不来（字段都归一化过），兜底也保持"一行"契约，绝不抛错
    return JSON.stringify({ ts: 0, chatKey: '', userId: 0, name: '', kind: '', text: '' })
  }
}

/**
 * 解析一行归档。**坏行一律返回 null，绝不抛错**：
 * 手工编辑、半截写入、旧版本格式、非对象（数组/字符串/数字）、关键字段全缺的行
 * 都当作"没有这条"，交给调用方跳过。
 *
 * 数值字段归一化（`ts` / `userId` 非有限数 → 0），字符串字段缺失 → `''`；
 * 多余的未知字段原样留着，方便以后扩展而不丢数据。
 * @param {string} line
 * @returns {{ ts: number, chatKey: string, userId: number, name: string, kind: string, text: string }|null}
 */
export function parseArchiveLine(line) {
  if (typeof line !== 'string') return null
  const text = line.trim()
  if (text === '') return null
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  // 数组 / null / 字符串 / 数字都不是记录
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  // 关键字段一个都没有 → 不是归档行（挡住 `{}` 和随便一个 JSON 对象）
  const hasKey = data.chatKey !== undefined || data.ts !== undefined
    || data.userId !== undefined || data.text !== undefined
  if (!hasKey) return null
  return {
    ...data,
    ts: num(data.ts),
    chatKey: str(data.chatKey),
    userId: num(data.userId),
    name: str(data.name),
    kind: str(data.kind),
    text: str(data.text),
  }
}

/**
 * 把一个文件搬进回收站目录（`<trashDir>/<当天>/<文件名>`），**永不删除**。
 * 同名冲突时追加 `.1` / `.2` 后缀，绝不覆盖已有的备份。
 * 返回新路径；失败返回 ''（此时原文件必须原样留着）。
 */
function moveIntoTrash(file, trashDir, nowMs) {
  try {
    if (!trashDir) return ''
    const bucket = join(trashDir, dayOf(nowMs))
    mkdirSync(bucket, { recursive: true })
    const leaf = basename(file)
    const dot = leaf.lastIndexOf('.')
    const stem = dot > 0 ? leaf.slice(0, dot) : leaf
    const ext = dot > 0 ? leaf.slice(dot) : ''
    let dest = join(bucket, leaf)
    let n = 1
    while (existsSync(dest)) {
      dest = join(bucket, `${stem}.${n}${ext}`)
      n += 1
    }
    renameSync(file, dest)
    return dest
  } catch {
    return ''
  }
}

/**
 * 按天分片的本地消息归档。
 *
 * 所有 fs 操作都是"尽力而为"：失败不抛错，只是返回 false / 跳过。
 * 归档是旁路功能，绝不能把桥的主流程带崩。
 */
export class HistoryArchive {
  /**
   * @param {{ dir?: string, keepDays?: number, now?: () => number }} [options]
   *   dir 归档目录（惰性创建）；keepDays 保留天数（默认 90，<0 按 0 算）；
   *   now 注入当前时间（测试用）。
   */
  constructor(options = {}) {
    const opts = (options !== null && typeof options === 'object') ? options : {}
    this.dir = typeof opts.dir === 'string' ? opts.dir : ''
    this.keepDays = Math.max(0, Math.floor(num(opts.keepDays === undefined ? DEFAULT_KEEP_DAYS : opts.keepDays)))
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.ready = false
  }

  /** 当前时间（归一化，挡住注入的假时钟返回垃圾）。 */
  #nowMs() {
    let value = 0
    try { value = this.now() } catch { value = 0 }
    if (!Number.isFinite(Number(value))) value = 0
    return num(value)
  }

  /** 惰性创建归档目录（失败返回 false，不抛错）。 */
  #ensureDir() {
    if (this.ready) return true
    if (this.dir === '') return false
    try {
      mkdirSync(this.dir, { recursive: true })
      this.ready = true
      return true
    } catch {
      return false
    }
  }

  /** 一条记录所属的分片文件（日期取自记录自身 `ts`，缺失才回落到"现在"）。 */
  #fileFor(record, nowMs) {
    const ts = num(record && record.ts)
    return join(this.dir, `${dayOf(ts > 0 ? ts : nowMs)}.jsonl`)
  }

  /** 目录下的分片文件名，**按文件名升序**（时间序），目录不存在 → []。 */
  #shardNames() {
    let names = []
    try { names = readdirSync(this.dir) } catch { return [] }
    return names.filter((name) => SHARD_RE.test(name)).sort()
  }

  /**
   * 追加一条记录到它所属的那一天的分片。
   * @returns {boolean} 是否写入成功（失败返回 false，绝不抛错）
   */
  append(record) {
    if (record === null || typeof record !== 'object') return false
    if (!this.#ensureDir()) return false
    let line = ''
    try { line = archiveLine(record) } catch { return false }
    try {
      appendFileSync(this.#fileFor(record, this.#nowMs()), `${line}\n`, 'utf8')
      return true
    } catch {
      return false
    }
  }

  /**
   * 在最近 `days` 天的分片里检索。
   *
   * 关键词大小写不敏感，空格分隔的多个词是 **AND** 关系（全部命中才算）。
   * 分片从新到旧读，命中按时间新→旧返回，最多 `limit` 条。
   *
   * @param {string} keyword
   * @param {{ days?: number, limit?: number, chatKey?: string }} [options]
   * @returns {{ hits: Array<object>, scanned: number, files: string[], truncated: boolean }}
   *   scanned 是真正读过的行数（坏行也算，因为确实读了一行）；
   *   files 是读过的分片文件名（新→旧）；truncated 表示是否因 limit 被截断。
   */
  search(keyword, options) {
    const empty = { hits: [], scanned: 0, files: [], truncated: false }
    // 关键词为空/非字符串 → 空结果（在碰 fs 之前就返回）
    if (typeof keyword !== 'string' || keyword.trim() === '') return empty

    const opts = (options !== null && typeof options === 'object') ? options : {}
    const limit = Math.floor(num(opts.limit)) >= 1 ? Math.floor(num(opts.limit)) : DEFAULT_LIMIT
    const days = Math.floor(num(opts.days)) >= 1 ? Math.floor(num(opts.days)) : DEFAULT_DAYS
    const chatKey = typeof opts.chatKey === 'string' ? opts.chatKey : ''

    const terms = collapse(keyword).toLowerCase().split(' ').filter((term) => term !== '').slice(0, MAX_TERMS)
    if (terms.length === 0) return empty

    const base = this.#nowMs()
    // 当天 + 前 days-1 天，新 → 旧
    const wanted = []
    for (let offset = 0; offset < days; offset++) wanted.push(dayOffset(base, -offset))

    const files = []
    const seen = new Set()
    const hits = []
    let scanned = 0
    let truncated = false
    let full = false

    outer: for (const day of wanted) {
      const name = `${day}.jsonl`
      if (seen.has(name)) continue
      seen.add(name)
      const { records, lines } = readShard(join(this.dir, name))
      // 只有真的读到东西才算"读过的文件"，目录不存在/文件缺失不进 files
      if (lines === 0) continue
      files.push(name)
      scanned += lines
      // 同一文件内后写的 ts 更大：倒序读即天然的新→旧
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i]
        if (chatKey !== '' && record.chatKey !== chatKey) continue
        const haystack = `${record.text} ${record.name}`.toLowerCase()
        if (!terms.every((term) => haystack.includes(term))) continue
        if (hits.length >= limit) { truncated = true; full = true; break outer }
        hits.push(record)
      }
    }

    return { hits, scanned, files, truncated }
  }

  /**
   * 把早于 `keepDays` 的分片**移走**（搬到回收站，绝不直接删除）。
   *
   * @param {{ trashDir?: string }} [options] trashDir 为空时用 `dir` 同级的 `qq-trash/<当天>/`
   * @returns {{ moved: string[], kept: number }} moved 是成功搬走的文件名（升序）；kept 是留在原地的分片数
   */
  prune(options) {
    const opts = (options !== null && typeof options === 'object') ? options : {}
    const nowMs = this.#nowMs()
    const names = this.#shardNames()
    // 今天是第 0 天：keepDays=90 表示"保留今天+前 89 天"，第 90 天及更早搬走
    const cutoff = dayOffset(nowMs, -this.keepDays)
    const trashDir = (typeof opts.trashDir === 'string' && opts.trashDir !== '')
      ? opts.trashDir
      : join(dirname(this.dir), 'qq-trash')

    const moved = []
    let kept = 0
    for (const name of names) {
      const day = name.slice(0, -'.jsonl'.length)
      // 不合法日期的分片不动它（免得把别人的文件搬走）
      if (!isValidDay(day) || day >= cutoff) { kept++; continue }
      const dest = moveIntoTrash(join(this.dir, name), trashDir, nowMs)
      if (dest === '') { kept++; continue }
      moved.push(name)
    }
    return { moved, kept }
  }

  /**
   * 归档概览：分片数、总字节、最早/最新的分片日期。
   * 只按文件名排序取首尾，不解析任何内容。
   * @returns {{ dir: string, files: number, bytes: number, oldest: string, newest: string }}
   */
  stats() {
    const names = this.#shardNames()
    let bytes = 0
    for (const name of names) {
      try { bytes += statSync(join(this.dir, name)).size } catch { /* 单个文件读不到就跳过 */ }
    }
    return {
      dir: this.dir,
      files: names.length,
      bytes,
      // 文件名升序 = 时间升序，所以首=最早、尾=最新
      oldest: names.length > 0 ? names[0].slice(0, 10) : '',
      newest: names.length > 0 ? names[names.length - 1].slice(0, 10) : '',
    }
  }
}
