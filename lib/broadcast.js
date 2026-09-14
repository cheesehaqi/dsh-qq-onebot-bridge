/**
 * 定时播报（broadcast）：按配置把 RSS 订阅 / 天气 / MC 服务器状态定时发到指定 QQ 会话。
 *
 * 本模块只做**调度 + 取数 + 排版**三件事，**不直接发 QQ**：
 * 渲染好的文本交给注入的 `send(chat, text)`，由 bridge 负责 trace、限流与注入拦截。
 * 因此这里零第三方依赖、零全局状态，send / fetchImpl / now / log / pingMc / timers /
 * formatFeed 全部可注入，可以完全脱离 bridge（也脱离网络与真实时钟）单测。
 *
 * RSS 解析刻意**不在这里做**：lib/feed.js 并行开发，两边保持零耦合 ——
 * 这里只接受注入的 `formatFeed(xml, job) -> { text, ids }`，
 * 并且**绝不 import 另一个模块**；没注入就按“未配置 RSS 解析器”记为失败。
 *
 * 三条硬约束（bridge 接线时必须依赖）：
 * 1. 失败绝不让进程崩：取数/发送的异常一律就地捕获，写成中文 reason 交给 log('error', ...)；
 * 2. 不发空消息：只有拿到非空文本才调 send；
 * 3. 间隔类任务按“上次**计划**时间 + 间隔”递推，执行耗时不会让排期逐次漂移。
 */

/** 正文超长时追加的提示语（与 lib/assets.js、lib/forward.js 用同一句）。 */
const TRUNCATED_MARK = '…（内容过长已截断）'

/** formatWeather 的 maxChars 默认值。 */
const DEFAULT_MAX_CHARS = 400

/** `everyMinutes` 的下限：小于它（或非有限数）一律按 5 分钟。 */
const MIN_EVERY_MINUTES = 5

/** setTimeout 的延迟上限（2^31-1 ms ≈ 24.8 天）；超过会溢出成立即触发。 */
const MAX_TIMER_DELAY = 2147483647

/** 抓取 RSS / 天气时带的 UA（与 lib/tts.js 一致）。 */
const USER_AGENT = 'dsh-qq-onebot-bridge'

/** 单次 HTTP 请求的超时时间。 */
const FETCH_TIMEOUT_MS = 15000

/** 每个任务最多记住的已播报条目 id（防止长期运行无限增长）。 */
const MAX_SEEN_IDS = 200

/** 落盘状态的版本号，将来换结构时用来做兼容判断。 */
const SNAPSHOT_VERSION = 1

/** `0=周日 … 6=周六`。 */
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 播报类型 → 中文名（describeJob 用）。 */
const KIND_NAMES = { rss: 'RSS 播报', weather: '天气', mc: 'MC 服务器' }

/**
 * WMO weather_code → { emoji, text }。至少覆盖 Open-Meteo 会返回的全部常用码，
 * 未知码统一落到 `未知天气`（❓）。
 */
const WEATHER_CODES = new Map([
  [0, { emoji: '☀', text: '晴' }],
  [1, { emoji: '🌤', text: '晴间多云' }],
  [2, { emoji: '🌤', text: '多云' }],
  [3, { emoji: '☁', text: '阴' }],
  [45, { emoji: '🌫', text: '雾' }],
  [48, { emoji: '🌫', text: '雾凇' }],
  [51, { emoji: '🌦', text: '小毛毛雨' }],
  [53, { emoji: '🌦', text: '毛毛雨' }],
  [55, { emoji: '🌧', text: '大毛毛雨' }],
  [56, { emoji: '🌧', text: '冻毛毛雨' }],
  [57, { emoji: '🌧', text: '强冻毛毛雨' }],
  [61, { emoji: '🌦', text: '小雨' }],
  [63, { emoji: '🌧', text: '中雨' }],
  [65, { emoji: '🌧', text: '大雨' }],
  [66, { emoji: '🌧', text: '冻雨' }],
  [67, { emoji: '🌧', text: '强冻雨' }],
  [71, { emoji: '🌨', text: '小雪' }],
  [73, { emoji: '🌨', text: '中雪' }],
  [75, { emoji: '❄', text: '大雪' }],
  [77, { emoji: '🌨', text: '雪粒' }],
  [80, { emoji: '🌦', text: '小阵雨' }],
  [81, { emoji: '🌧', text: '中阵雨' }],
  [82, { emoji: '⛈', text: '强阵雨' }],
  [85, { emoji: '🌨', text: '小阵雪' }],
  [86, { emoji: '❄', text: '大阵雪' }],
  [95, { emoji: '⛈', text: '雷阵雨' }],
  [96, { emoji: '⛈', text: '雷阵雨伴冰雹' }],
  [99, { emoji: '⛈', text: '强雷阵雨伴冰雹' }],
])

/** 未知 weather_code 的兜底（测试里锁死）。 */
const UNKNOWN_WEATHER = { emoji: '❓', text: '未知天气' }

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 数值兜底：非有限数（含 null/''/'abc'/NaN）→ null，方便调用方区分“没有”和 0。 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 非负整数计数兜底（快照恢复用）。 */
function toCount(value) {
  const n = toNumber(value)
  return n === null || n < 0 ? 0 : Math.trunc(n)
}

/** 错误 → 中文可读原因；超时类错误单独说成“请求超时”。 */
function messageOf(error) {
  const name = (error && typeof error === 'object') ? String(error.name ?? '') : ''
  if (name === 'TimeoutError' || name === 'AbortError') return '请求超时'
  if (error instanceof Error && error.message) return error.message
  const text = String(error ?? '').trim()
  return text === '' ? '未知错误' : text
}

/** 响应状态码兜底：拿不到就写“无响应”。 */
function statusOf(response) {
  const status = toNumber(response?.status)
  return status === null || status <= 0 ? '无响应' : status
}

/** 解析 `HH:MM`（同时接受 `H:MM` 与全角冒号）；非法/缺失 → null。 */
function parseClock(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim().replace(/：/g, ':')
  const matched = /^(\d{1,2}):(\d{1,2})$/.exec(text)
  if (!matched) return null
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

/**
 * `everyMinutes` 归一化：没配 → null（表示走 `at` 定时）；
 * 配了但非有限数或小于 5 → 按 5（挡住 0 / NaN / 'abc'，否则会变成死循环式连发）。
 */
function resolveEveryMinutes(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return MIN_EVERY_MINUTES
  return n < MIN_EVERY_MINUTES ? MIN_EVERY_MINUTES : Math.floor(n)
}

/**
 * `weekdays` 归一化：非数组或过滤后为空 → null（表示每天）；
 * 否则返回去重升序的 `0..6` 数组。
 */
function normalizeWeekdays(value) {
  if (!Array.isArray(value)) return null
  const days = []
  for (const raw of value) {
    const n = toNumber(raw)
    if (n === null || !Number.isInteger(n) || n < 0 || n > 6) continue
    if (!days.includes(n)) days.push(n)
  }
  if (days.length === 0) return null
  return days.sort((a, b) => a - b)
}

/** 会话 key → 中文：`g:123456` → `群 123456`，`u:789` → `私聊 789`。 */
function describeChat(chat) {
  const raw = String(chat ?? '').trim()
  if (raw === '') return '未知会话'
  const matched = /^([gu]):(.*)$/i.exec(raw)
  if (!matched) return raw
  const id = matched[2].trim()
  const prefix = matched[1].toLowerCase() === 'g' ? '群' : '私聊'
  return id === '' ? prefix : `${prefix} ${id}`
}

/** 排期 → 中文：`每 30 分钟` / `每天 08:00` / `每天 08:00（周一、周三）`。 */
function describeSchedule(job) {
  const every = resolveEveryMinutes(job?.everyMinutes)
  if (every !== null) return `每 ${every} 分钟`
  const clock = parseClock(job?.at)
  if (!clock) return '未设置时间'
  const time = `${pad2(clock.hour)}:${pad2(clock.minute)}`
  const days = normalizeWeekdays(job?.weekdays)
  if (days === null) return `每天 ${time}`
  return `每天 ${time}（${days.map((day) => WEEKDAY_NAMES[day]).join('、')}）`
}

/** 温度排版：有限数保留一位小数且去掉 `.0`；否则 `--`。 */
function formatTemp(value) {
  const n = toNumber(value)
  if (n === null) return '--'
  return n.toFixed(1).replace(/\.0$/, '')
}

/** 百分比排版：四舍五入到整数；否则 `--`。 */
function formatPercent(value) {
  const n = toNumber(value)
  return n === null ? '--' : `${Math.round(n)}%`
}

/** `daily.xxx[0]`：非数组/空数组 → undefined（交给 formatTemp 兜底）。 */
function firstOf(value) {
  return Array.isArray(value) ? value[0] : undefined
}

/** weather_code → { emoji, text }；未知码兜底 `未知天气`。 */
function weatherInfoOf(code) {
  const n = toNumber(code)
  if (n === null) return UNKNOWN_WEATHER
  return WEATHER_CODES.get(Math.trunc(n)) ?? UNKNOWN_WEATHER
}

/** maxChars 防御性取值：非有限数或 < 1 → 400。 */
function normalizeMaxChars(value) {
  const n = toNumber(value)
  return n === null || n < 1 ? DEFAULT_MAX_CHARS : Math.floor(n)
}

/** 把延迟夹到 `[0, 2^31-1]`：setTimeout 超过约 24.8 天会溢出成立即触发。 */
function clampDelay(delay) {
  const n = toNumber(delay)
  if (n === null || n < 0) return 0
  return Math.min(n, MAX_TIMER_DELAY)
}

/** 带超时的 AbortSignal；老运行时没有 `AbortSignal.timeout` 就退化成不带超时。 */
function timeoutSignal(ms = FETCH_TIMEOUT_MS) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms)
    }
  } catch {
    /* 退化成不带超时：网络层自己会失败，这里绝不能因为超时能力缺失而抛错 */
  }
  return null
}

/**
 * 下一次触发时间。
 * - `enabled === false` → null；
 * - 配了 `everyMinutes` → `now + everyMinutes * 60000`（下限 5 分钟）。
 *   注意：**调度器自己记录上次运行时间来递推间隔**，本函数只按传入的 `now` 算下一次；
 * - 否则看 `at: 'HH:MM'`（本地时间，`H:MM` 也接受）→ 严格晚于 `now` 的最近一次；
 *   `weekdays` 非空时只在这些星期触发，为空/非数组 → 每天；
 * - `at` 非法或缺失且没有 `everyMinutes` → null。
 * @returns {number|null} 毫秒时间戳
 */
export function nextRunAt(job, now = Date.now()) {
  const target = (job && typeof job === 'object') ? job : {}
  if (target.enabled === false) return null

  const base = toNumber(now)
  const from = base === null ? Date.now() : base

  const every = resolveEveryMinutes(target.everyMinutes)
  if (every !== null) return from + every * 60_000

  const clock = parseClock(target.at)
  if (!clock) return null
  const days = normalizeWeekdays(target.weekdays)

  const start = new Date(from)
  // 最多向后找 8 天：weekdays 非空时一周内必有解，每天模式一天内必有解。
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(
      start.getFullYear(), start.getMonth(), start.getDate() + offset,
      clock.hour, clock.minute, 0, 0,
    )
    const at = candidate.getTime()
    if (!Number.isFinite(at) || at <= from) continue
    if (days !== null && !days.includes(candidate.getDay())) continue
    return at
  }
  return null
}

/**
 * 任务的中文一句话描述。
 * 形如 `RSS 播报 → 群 123456，每 30 分钟`、`天气 → 群 123456，每天 08:00（周一、周三）`；
 * `enabled === false` 时整句前缀加 `（已停用）`。
 */
export function describeJob(job) {
  const target = (job && typeof job === 'object') ? job : {}
  const kindName = KIND_NAMES[target.kind] ?? '播报'
  const body = `${kindName} → ${describeChat(target.chat)}，${describeSchedule(target)}`
  return target.enabled === false ? `（已停用）${body}` : body
}

/**
 * Open-Meteo `/v1/forecast` 响应 → 中文文本。
 *
 * 字段缺失/非数值一律兜底成 `--`（天气现象兜底成 `未知天气`），
 * `data` 不是对象也不抛错；超出 `maxChars` 截断并追加 `…（内容过长已截断）`
 * （截断标记**不计入** maxChars，与 lib/assets.js 的既有行为一致）。
 * @returns {string}
 */
export function formatWeather(data, options = {}) {
  const opts = (options && typeof options === 'object') ? options : {}
  const source = (data && typeof data === 'object') ? data : {}
  const current = (source.current && typeof source.current === 'object') ? source.current : {}
  const daily = (source.daily && typeof source.daily === 'object') ? source.daily : {}

  const info = weatherInfoOf(current.weather_code)
  const name = typeof opts.name === 'string' ? opts.name.trim() : ''
  const lines = [
    `${info.emoji}${name === '' ? '' : ` ${name}`} 今日天气`,
    `现在 ${formatTemp(current.temperature_2m)}°C ${info.text}`,
    `最高 ${formatTemp(firstOf(daily.temperature_2m_max))}°C / 最低 ${formatTemp(firstOf(daily.temperature_2m_min))}°C`,
    `降水概率 ${formatPercent(firstOf(daily.precipitation_probability_max))}`,
  ]

  let text = lines.join('\n')
  const maxChars = normalizeMaxChars(opts.maxChars)
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}${TRUNCATED_MARK}`
  return text
}

/** 默认的 RSS 排版：没注入 formatFeed 就是没配置解析器，按失败处理（不发空消息）。 */
function defaultFormatFeed() {
  return { text: '', ids: [], reason: '未配置 RSS 解析器', failed: true }
}

/**
 * 定时播报调度器。
 *
 * 职责边界：**只负责排期、取数、排版**，拿到非空文本后交给注入的 `send(chat, text)`；
 * trace / 限流 / 注入拦截全部由 bridge 的 send 负责，这里不重复实现。
 */
export class Broadcaster {
  #jobs = new Map()
  #send
  #fetch
  #now
  #log
  #pingMc
  #timers
  #formatFeed
  #running = false

  /**
   * @param {object} options
   * @param {Array<object>} [options.jobs] 任务数组（见 nextRunAt / describeJob）
   * @param {(chat: string, text: string) => Promise<any>} [options.send] 发送函数（调用方保证不抛，这里仍会 try/catch 记 reason）
   * @param {Function} [options.fetchImpl] 默认 globalThis.fetch
   * @param {() => number} [options.now] 默认 Date.now
   * @param {(level: string, message: string) => void} [options.log] 默认空函数
   * @param {(address: string) => any} [options.pingMc] 可选：mc 类任务取状态文本（字符串或 { text, reason }）
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers] 可选：注入假定时器（单测用）
   * @param {(xml: string, job: object) => any} [options.formatFeed] 可选：RSS 排版（lib/feed.js 侧注入）
   */
  constructor(options = {}) {
    const opts = (options && typeof options === 'object') ? options : {}

    this.#send = typeof opts.send === 'function' ? opts.send : async () => {}
    const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch
    this.#fetch = typeof fetchImpl === 'function' ? fetchImpl : null

    const nowImpl = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.#now = () => {
      const value = toNumber(nowImpl())
      return value === null ? Date.now() : value
    }

    this.#log = typeof opts.log === 'function' ? opts.log : () => {}
    this.#pingMc = typeof opts.pingMc === 'function' ? opts.pingMc : null
    this.#formatFeed = typeof opts.formatFeed === 'function' ? opts.formatFeed : defaultFormatFeed

    const timers = (opts.timers && typeof opts.timers === 'object') ? opts.timers : {}
    this.#timers = {
      setTimeout: typeof timers.setTimeout === 'function' ? timers.setTimeout.bind(timers) : globalThis.setTimeout,
      clearTimeout: typeof timers.clearTimeout === 'function' ? timers.clearTimeout.bind(timers) : globalThis.clearTimeout,
    }

    const jobs = Array.isArray(opts.jobs) ? opts.jobs : []
    jobs.forEach((job, index) => {
      const raw = (job && typeof job === 'object') ? job : {}
      const id = String(raw.id ?? '').trim() || `job-${index + 1}`
      if (this.#jobs.has(id)) {
        this.#log('warn', `[播报] 任务 id 重复，已忽略后一个：${id}`)
        return
      }
      this.#jobs.set(id, {
        id,
        job: raw,
        timer: null,
        nextAt: null,
        lastAt: null,
        lastReason: '',
        runs: 0,
        failures: 0,
        seen: new Set(),
      })
    })
  }

  /**
   * 为每个启用的任务排一个定时器。
   * 延迟用 `nextRunAt(job, now()) - now()`，并夹到 `[0, 2^31-1]`。
   * 重复调用是安全的：会先 stop() 掉旧定时器再重排。
   */
  start() {
    this.stop()
    this.#running = true
    let armed = 0
    const now = this.#now()
    for (const entry of this.#jobs.values()) {
      if (entry.job?.enabled === false) {
        entry.nextAt = null
        continue
      }
      this.#arm(entry, nextRunAt(entry.job, now))
      if (entry.nextAt !== null) armed++
    }
    this.#log('info', `[播报] 已排期 ${armed} 个任务`)
    return this
  }

  /** 清掉所有定时器；可重复调用（幂等）。 */
  stop() {
    this.#running = false
    for (const entry of this.#jobs.values()) {
      if (entry.timer !== null) {
        try {
          this.#timers.clearTimeout(entry.timer)
        } catch {
          /* 假定时器/已触发的句柄可能不接受 clear：停表本身绝不能抛 */
        }
        entry.timer = null
      }
      entry.nextAt = null
    }
    return this
  }

  /** 任务视图（给控制台/诊断用）：排期、上次结果与统计。 */
  list() {
    return [...this.#jobs.values()].map((entry) => ({
      id: entry.id,
      kind: String(entry.job?.kind ?? ''),
      chat: String(entry.job?.chat ?? ''),
      enabled: entry.job?.enabled !== false,
      describe: describeJob(entry.job),
      nextAt: entry.nextAt,
      lastAt: entry.lastAt,
      lastReason: entry.lastReason,
      runs: entry.runs,
      failures: entry.failures,
    }))
  }

  /**
   * 立刻跑一次（不改变排期：`manual` 只影响日志文案）。
   * @returns {Promise<{ ok: boolean, reason: string, text: string }>}
   */
  async runOnce(id, options = {}) {
    const manual = (options && typeof options === 'object' && options.manual === true)
    const key = String(id ?? '')
    const entry = this.#jobs.get(key)
    if (!entry) {
      this.#log('warn', `[播报] 没有这个任务：${key}`)
      return { ok: false, reason: '没有这个任务', text: '' }
    }

    const job = (entry.job && typeof entry.job === 'object') ? entry.job : {}
    const label = manual ? '手动执行' : '定时触发'
    let text = ''
    let reason = ''
    let freshIds = []
    let ok = true

    try {
      const collected = await this.#collect(job, entry)
      text = collected.text
      reason = collected.reason
      freshIds = collected.ids
      if (collected.failed === true) ok = false
    } catch (error) {
      ok = false
      text = ''
      reason = `播报失败：${messageOf(error)}`
    }

    // 只有拿到非空文本才发：绝不给群里发一条空消息。
    if (ok && text !== '') {
      try {
        await this.#send(job.chat, text)
        if (reason === '') reason = '已播报'
      } catch (error) {
        ok = false
        reason = `发送失败：${messageOf(error)}`
      }
    }

    // 发送成功后才记 seen，失败下次还能重播。
    if (ok && freshIds.length > 0) this.#rememberSeen(entry, freshIds)

    entry.runs++
    if (!ok) entry.failures++
    entry.lastAt = this.#now()
    entry.lastReason = reason

    if (ok) this.#log('info', `[播报] ${entry.id} ${label}完成：${reason}`)
    else this.#log('error', `[播报] ${entry.id} ${label}失败：${reason}`)

    return { ok, reason, text }
  }

  /** 可 JSON 序列化的状态（bridge 会落盘，重启后不重复播报）。 */
  snapshot() {
    const jobs = {}
    for (const entry of this.#jobs.values()) {
      jobs[entry.id] = {
        seen: [...entry.seen],
        lastAt: entry.lastAt,
        lastReason: entry.lastReason,
        runs: entry.runs,
        failures: entry.failures,
      }
    }
    return { version: SNAPSHOT_VERSION, jobs }
  }

  /** 恢复 snapshot() 的内容；只认已知任务的 id，坏数据一律跳过而不是抛错。 */
  restore(state) {
    const source = (state && typeof state === 'object') ? state : {}
    const jobs = (source.jobs && typeof source.jobs === 'object') ? source.jobs : {}
    for (const [id, entry] of this.#jobs) {
      const saved = jobs[id]
      if (!saved || typeof saved !== 'object') continue
      if (Array.isArray(saved.seen)) {
        const seen = saved.seen
          .map((value) => String(value ?? '').trim())
          .filter((value) => value !== '')
          .slice(-MAX_SEEN_IDS)
        entry.seen = new Set(seen)
      }
      const lastAt = toNumber(saved.lastAt)
      entry.lastAt = lastAt === null ? null : lastAt
      entry.lastReason = typeof saved.lastReason === 'string' ? saved.lastReason : ''
      entry.runs = toCount(saved.runs)
      entry.failures = toCount(saved.failures)
    }
    return this
  }

  /** 到点触发：跑任务 → 重新排下一次（间隔类按“上次计划时间 + 间隔”递推）。 */
  async fire(entry) {
    entry.timer = null
    if (!this.#running) return
    if (this.#jobs.get(entry.id) !== entry) return
    const plannedAt = entry.nextAt
    try {
      await this.runOnce(entry.id)
    } catch (error) {
      // runOnce 内部已经兜底，这里是最后一道保险：定时器回调绝不能让进程崩。
      entry.failures++
      entry.lastReason = `播报异常：${messageOf(error)}`
      this.#log('error', `[播报] ${entry.id} 定时触发异常：${messageOf(error)}`)
    }
    this.#armAfter(entry, plannedAt)
  }

  /** 记 seen id，并按 MAX_SEEN_IDS 丢弃最旧的。 */
  #rememberSeen(entry, ids) {
    for (const id of ids) entry.seen.add(id)
    while (entry.seen.size > MAX_SEEN_IDS) {
      const oldest = entry.seen.values().next().value
      entry.seen.delete(oldest)
    }
  }

  /** 装表：夹取延迟并记住 nextAt；nextAt 为 null 表示这个任务没有下一次。 */
  #arm(entry, nextAt) {
    if (entry.timer !== null) {
      try {
        this.#timers.clearTimeout(entry.timer)
      } catch {
        /* 同上：重排时清不掉旧表也不能抛 */
      }
      entry.timer = null
    }
    const at = toNumber(nextAt)
    entry.nextAt = at
    if (at === null || !this.#running) return
    const delay = clampDelay(at - this.#now())
    entry.timer = this.#timers.setTimeout(() => this.fire(entry), delay)
  }

  /**
   * 触发之后重新排下一次。
   * - 间隔类：`上次计划时间 + 间隔`（executed 慢也不会逐次漂移）；睡过头就按整间隔跳到未来；
   * - 定点类：以 `max(now, 上次计划时间)` 为基准取下一次，保证一定会往后走。
   */
  #armAfter(entry, plannedAt) {
    if (!this.#running || entry.job?.enabled === false) {
      entry.nextAt = null
      entry.timer = null
      return
    }
    const now = this.#now()
    const planned = toNumber(plannedAt)
    const every = resolveEveryMinutes(entry.job?.everyMinutes)

    if (every !== null) {
      const span = every * 60_000
      let nextAt = (planned === null ? now : planned) + span
      if (nextAt <= now) {
        const missed = Math.ceil((now - nextAt) / span)
        nextAt += missed * span
      }
      this.#arm(entry, nextAt)
      return
    }

    const base = planned === null ? now : Math.max(now, planned)
    this.#arm(entry, nextRunAt(entry.job, base))
  }

  /** 按 kind 取数 + 排版；统一返回 `{ text, ids, reason, failed }`。 */
  async #collect(job, entry) {
    const kind = String(job?.kind ?? '').trim().toLowerCase()
    if (kind === 'rss') return this.#collectRss(job, entry)
    if (kind === 'weather') return this.#collectWeather(job)
    if (kind === 'mc') return this.#collectMc(job)
    return { text: '', ids: [], reason: `未知的播报类型：${kind === '' ? '(空)' : kind}`, failed: true }
  }

  /** RSS：抓正文 → 交给注入的 formatFeed 排版 → 按条目 id 去重。 */
  async #collectRss(job, entry) {
    const url = String(job?.url ?? '').trim()
    if (url === '') return { text: '', ids: [], reason: 'RSS 任务缺少订阅地址', failed: true }

    let xml = ''
    try {
      const response = await this.#request(url)
      if (!response || response.ok === false) {
        return { text: '', ids: [], reason: `RSS 抓取失败：HTTP ${statusOf(response)}`, failed: true }
      }
      if (typeof response.text === 'function') {
        const body = await response.text()
        xml = typeof body === 'string' ? body : String(body ?? '')
      }
    } catch (error) {
      return { text: '', ids: [], reason: `RSS 抓取失败：${messageOf(error)}`, failed: true }
    }

    let parsed = null
    try {
      parsed = await this.#formatFeed(xml, job)
    } catch (error) {
      return { text: '', ids: [], reason: `RSS 解析失败：${messageOf(error)}`, failed: true }
    }
    if (parsed && typeof parsed === 'object' && parsed.failed === true) {
      const given = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
      return { text: '', ids: [], reason: given === '' ? 'RSS 解析失败' : given, failed: true }
    }

    const text = (parsed && typeof parsed.text === 'string') ? parsed.text.trim() : ''
    const ids = Array.isArray(parsed?.ids)
      ? parsed.ids.map((value) => String(value ?? '').trim()).filter((value) => value !== '')
      : []

    if (ids.length === 0) {
      // 排版器没给条目 id：无法去重，有正文就照发。
      if (text === '') return { text: '', ids: [], reason: '没有新条目', failed: false }
      return { text, ids: [], reason: '', failed: false }
    }

    const fresh = ids.filter((id) => !entry.seen.has(id))
    if (fresh.length === 0) return { text: '', ids: [], reason: '没有新条目', failed: false }
    if (text === '') return { text: '', ids: [], reason: 'RSS 解析结果为空', failed: true }
    return { text, ids: fresh, reason: '', failed: false }
  }

  /** 天气：Open-Meteo 免 key 接口 → formatWeather。 */
  async #collectWeather(job) {
    const latitude = toNumber(job?.latitude)
    const longitude = toNumber(job?.longitude)
    if (latitude === null || longitude === null) {
      return { text: '', ids: [], reason: '天气任务缺少经纬度', failed: true }
    }
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${latitude}&longitude=${longitude}`
      + '&current=temperature_2m,weather_code'
      + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&timezone=auto'

    let data = null
    try {
      const response = await this.#request(url)
      if (!response || response.ok === false) {
        return { text: '', ids: [], reason: `天气查询失败：HTTP ${statusOf(response)}`, failed: true }
      }
      data = typeof response.json === 'function' ? await response.json() : null
    } catch (error) {
      return { text: '', ids: [], reason: `天气查询失败：${messageOf(error)}`, failed: true }
    }
    if (!data || typeof data !== 'object') {
      return { text: '', ids: [], reason: '天气查询失败：响应不是 JSON', failed: true }
    }

    const name = String(job?.name ?? job?.city ?? '').trim()
    const text = formatWeather(data, { name, maxChars: job?.maxChars })
    return { text, ids: [], reason: '', failed: false }
  }

  /** MC：交给注入的 pingMc（返回字符串或 { text, reason }）。 */
  async #collectMc(job) {
    if (typeof this.#pingMc !== 'function') {
      return { text: '', ids: [], reason: '未配置 MC 查询', failed: true }
    }
    const address = String(job?.address ?? '').trim()
    if (address === '') return { text: '', ids: [], reason: 'MC 任务缺少服务器地址', failed: true }

    let result = null
    try {
      result = await this.#pingMc(address)
    } catch (error) {
      return { text: '', ids: [], reason: `MC 查询失败：${messageOf(error)}`, failed: true }
    }

    if (typeof result === 'string') {
      const text = result.trim()
      if (text === '') return { text: '', ids: [], reason: 'MC 查询没有返回内容', failed: true }
      return { text, ids: [], reason: '', failed: false }
    }

    const text = (result && typeof result === 'object' && typeof result.text === 'string')
      ? result.text.trim()
      : ''
    const reason = (result && typeof result === 'object' && typeof result.reason === 'string')
      ? result.reason.trim()
      : ''
    // 拿不到文本就是失败（离线/超时都算），但 reason 尽量用注入方给的中文原因。
    if (text === '') {
      return { text: '', ids: [], reason: reason === '' ? 'MC 查询没有返回内容' : reason, failed: true }
    }
    return { text, ids: [], reason, failed: result?.ok === false }
  }

  /** 统一的 HTTP 入口：带 UA 与 15s 超时，绝不因为缺 fetch 而抛错到上层。 */
  async #request(url) {
    if (typeof this.#fetch !== 'function') throw new Error('当前运行环境没有 fetch')
    const init = { headers: { 'User-Agent': USER_AGENT } }
    const signal = timeoutSignal()
    if (signal) init.signal = signal
    return this.#fetch(url, init)
  }
}
