/**
 * lib/broadcast.js 单元测试。
 *
 * 全部用**假的** timers / now / fetchImpl / send：不联网、不真等待、不依赖真实时钟，
 * 所以断言是确定性的（也能在 CI 里秒过）。
 *
 * 「到点触发」的模拟方式：把 `{ setTimeout, clearTimeout }` 注入 Broadcaster，
 * 假定时器只把 `{ fn, at }` 记进 pending 表（at = 虚拟时钟 + 延迟），
 * 由 advance(ms) 手动把虚拟时钟推到目标时刻，取出所有到点的任务，
 * **把时钟停在它的计划时刻**后 await 掉回调返回的 Promise（Broadcaster 的定时器
 * 回调就是 `() => this.fire(entry)`，返回的 Promise 一直等到重新排期完成），
 * 这样一步就能看到「跑任务 → 记结果 → 重排下一次」的完整效果。
 */
import { Broadcaster, describeJob, formatWeather, nextRunAt } from '../lib/broadcast.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const TRUNCATED_MARK = '…（内容过长已截断）'
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const MAX_TIMER_DELAY = 2147483647

/** 2026-09-11 10:00 本地时间（周五），全文件共用的基准时刻。 */
const BASE = new Date(2026, 8, 11, 10, 0, 0).getTime()

/** 假时钟 + 假定时器：手动推进，同步跑完异步任务。 */
function createFakeClock(startAt = BASE) {
  let clock = startAt
  let seq = 0
  const pending = new Map()
  const timers = {
    setTimeout(fn, delay) {
      const id = ++seq
      const value = Number(delay)
      const ms = Number.isFinite(value) && value > 0 ? value : 0
      pending.set(id, { fn, at: clock + ms, delay: ms })
      return id
    },
    clearTimeout(id) { pending.delete(id) },
  }
  function earliest(target) {
    let best = null
    for (const [id, task] of pending) {
      if (task.at > target) continue
      if (best === null || task.at < best.task.at || (task.at === best.task.at && id < best.id)) {
        best = { id, task }
      }
    }
    return best
  }
  return {
    timers,
    now: () => clock,
    pending: () => pending.size,
    pendingDelays: () => [...pending.values()].map((task) => task.delay),
    pendingAts: () => [...pending.values()].map((task) => task.at).sort((a, b) => a - b),
    async advance(ms) {
      const target = clock + ms
      for (let guard = 0; guard < 1000; guard++) {
        const next = earliest(target)
        if (next === null) break
        pending.delete(next.id)
        clock = Math.max(clock, next.task.at)
        await next.task.fn()
      }
      if (clock < target) clock = target
      return clock
    },
  }
}

function createSend() {
  const sent = []
  const send = async (chat, text) => { sent.push({ chat, text }) }
  return { send, sent }
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload },
    async text() { return JSON.stringify(payload) },
  }
}

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body },
    async json() { return JSON.parse(body) },
  }
}

/** 记录每次调用的假 fetch；handler 可以按 URL 分发，也可以直接抛错。 */
function createFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  return { fetchImpl, calls }
}

const WEATHER_DATA = {
  current: { temperature_2m: 24.3, weather_code: 2 },
  daily: {
    temperature_2m_max: [29.1],
    temperature_2m_min: [21.4],
    precipitation_probability_max: [30],
  },
}

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast'

function weatherFetch(data = WEATHER_DATA, status = 200) {
  return createFetch(() => jsonResponse(data, status))
}

// ---------------------------------------------------------------- nextRunAt

check('每天模式：早于当日时刻 → 当天', nextRunAt({ at: '20:00' }, BASE) === new Date(2026, 8, 11, 20, 0, 0).getTime(),
  new Date(nextRunAt({ at: '20:00' }, BASE)).toString())
check('每天模式：晚于当日时刻 → 次日', nextRunAt({ at: '08:00' }, BASE) === new Date(2026, 8, 12, 8, 0, 0).getTime(),
  new Date(nextRunAt({ at: '08:00' }, BASE)).toString())
check('H:MM 单位数小时被接受', nextRunAt({ at: '8:05' }, BASE) === new Date(2026, 8, 12, 8, 5, 0).getTime())
check('H:MM 单位数分钟被接受（当天 09:07 已过 → 次日）',
  nextRunAt({ at: '9:7' }, BASE) === new Date(2026, 8, 12, 9, 7, 0).getTime())
check('at 恰好等于 now 的时刻 → 严格晚于 now（次日）',
  nextRunAt({ at: '10:00' }, BASE) === new Date(2026, 8, 12, 10, 0, 0).getTime())
check('at 早一分钟 → 当天', nextRunAt({ at: '09:59' }, BASE) === new Date(2026, 8, 12, 9, 59, 0).getTime())

check('weekdays 过滤：周五 18:00 且 weekdays=[1] → 下周一',
  nextRunAt({ at: '18:00', weekdays: [1] }, BASE) === new Date(2026, 8, 14, 18, 0, 0).getTime(),
  new Date(nextRunAt({ at: '18:00', weekdays: [1] }, BASE)).toString())
check('weekdays 过滤：今天已过 → 下周同一天',
  nextRunAt({ at: '08:00', weekdays: [5] }, BASE) === new Date(2026, 8, 18, 8, 0, 0).getTime())
check('weekdays 过滤：今天还没到 → 就是今天',
  nextRunAt({ at: '20:00', weekdays: [5] }, BASE) === new Date(2026, 8, 11, 20, 0, 0).getTime())
check('weekdays 过滤：周日=0', nextRunAt({ at: '12:00', weekdays: [0] }, BASE) === new Date(2026, 8, 13, 12, 0, 0).getTime())
check('weekdays 为空数组 → 每天', nextRunAt({ at: '20:00', weekdays: [] }, BASE) === new Date(2026, 8, 11, 20, 0, 0).getTime())
check('weekdays 非数组 → 每天', nextRunAt({ at: '20:00', weekdays: '1,3' }, BASE) === new Date(2026, 8, 11, 20, 0, 0).getTime())
check('weekdays 全是非法值 → 每天', nextRunAt({ at: '20:00', weekdays: [9, -1, 'x'] }, BASE) === new Date(2026, 8, 11, 20, 0, 0).getTime())

check('everyMinutes=30 → now + 30 分钟', nextRunAt({ everyMinutes: 30 }, BASE) === BASE + 30 * MIN)
check('everyMinutes=5（等于下限）保留', nextRunAt({ everyMinutes: 5 }, BASE) === BASE + 5 * MIN)
check('everyMinutes 下限夹取：3 → 5', nextRunAt({ everyMinutes: 3 }, BASE) === BASE + 5 * MIN)
check('everyMinutes 下限夹取：0 → 5', nextRunAt({ everyMinutes: 0 }, BASE) === BASE + 5 * MIN)
check('everyMinutes 非有限数 → 5', nextRunAt({ everyMinutes: NaN }, BASE) === BASE + 5 * MIN)
check('everyMinutes 非数字 → 5', nextRunAt({ everyMinutes: 'abc' }, BASE) === BASE + 5 * MIN)
check('everyMinutes 优先于 at', nextRunAt({ everyMinutes: 10, at: '23:59' }, BASE) === BASE + 10 * MIN)

check('enabled:false → null', nextRunAt({ enabled: false, at: '20:00' }, BASE) === null)
check('enabled:false 且 everyMinutes → null', nextRunAt({ enabled: false, everyMinutes: 10 }, BASE) === null)
check('at 非法（25:00）→ null', nextRunAt({ at: '25:00' }, BASE) === null)
check('at 非法（10:99）→ null', nextRunAt({ at: '10:99' }, BASE) === null)
check('at 非法（abc）→ null', nextRunAt({ at: 'abc' }, BASE) === null)
check('at 缺失 → null', nextRunAt({}, BASE) === null)
check('空 job → null', nextRunAt(null, BASE) === null)
check('job 非对象 → null', nextRunAt('20:00', BASE) === null)
check('now 非法时退化成真实时钟而不是崩', Number.isFinite(nextRunAt({ everyMinutes: 5 }, NaN)))

// ---------------------------------------------------------------- describeJob

check('describeJob：RSS + 群 + 间隔',
  describeJob({ kind: 'rss', chat: 'g:123456', url: 'u', everyMinutes: 30 }) === 'RSS 播报 → 群 123456，每 30 分钟',
  describeJob({ kind: 'rss', chat: 'g:123456', url: 'u', everyMinutes: 30 }))
check('describeJob：天气 + 群 + 每天定点 + 星期',
  describeJob({ kind: 'weather', chat: 'g:123456', at: '08:00', weekdays: [1, 3] }) === '天气 → 群 123456，每天 08:00（周一、周三）',
  describeJob({ kind: 'weather', chat: 'g:123456', at: '08:00', weekdays: [1, 3] }))
check('describeJob：MC + 私聊 + 每天定点',
  describeJob({ kind: 'mc', chat: 'u:789', at: '18:00' }) === 'MC 服务器 → 私聊 789，每天 18:00',
  describeJob({ kind: 'mc', chat: 'u:789', at: '18:00' }))
check('describeJob：weekdays 乱序 → 升序展示',
  describeJob({ kind: 'weather', chat: 'g:1', at: '08:00', weekdays: [3, 1] }).endsWith('（周一、周三）'),
  describeJob({ kind: 'weather', chat: 'g:1', at: '08:00', weekdays: [3, 1] }))
check('describeJob：weekdays 为空 → 每天',
  describeJob({ kind: 'weather', chat: 'g:1', at: '08:00', weekdays: [] }) === '天气 → 群 1，每天 08:00')
check('describeJob：H:MM 补零', describeJob({ kind: 'weather', chat: 'g:1', at: '8:5' }) === '天气 → 群 1，每天 08:05')
check('describeJob：interval 下限夹取写进文案',
  describeJob({ kind: 'rss', chat: 'g:1', everyMinutes: 1 }).endsWith('每 5 分钟'),
  describeJob({ kind: 'rss', chat: 'g:1', everyMinutes: 1 }))
check('describeJob：停用前缀',
  describeJob({ kind: 'weather', chat: 'g:1', at: '08:00', enabled: false }) === '（已停用）天气 → 群 1，每天 08:00',
  describeJob({ kind: 'weather', chat: 'g:1', at: '08:00', enabled: false }))
check('describeJob：未设置时间兜底',
  describeJob({ kind: 'mc', chat: 'g:1' }) === 'MC 服务器 → 群 1，未设置时间',
  describeJob({ kind: 'mc', chat: 'g:1' }))
check('describeJob：未知 kind 兜底', describeJob({ kind: 'zzz', chat: 'g:1', at: '08:00' }).startsWith('播报 →'))
check('describeJob：非法 chat 原样展示', describeJob({ kind: 'mc', chat: 'weird', at: '08:00' }) === 'MC 服务器 → weird，每天 08:00')
check('describeJob：缺 chat 兜底', describeJob({ kind: 'mc', at: '08:00' }) === 'MC 服务器 → 未知会话，每天 08:00')
check('describeJob：空 job 不抛', typeof describeJob(null) === 'string')

// -------------------------------------------------------------- formatWeather

const FULL_WEATHER = [
  '🌤 上海 今日天气',
  '现在 24.3°C 多云',
  '最高 29.1°C / 最低 21.4°C',
  '降水概率 30%',
].join('\n')
check('formatWeather：完整字段逐字一致', formatWeather(WEATHER_DATA, { name: '上海' }) === FULL_WEATHER,
  JSON.stringify(formatWeather(WEATHER_DATA, { name: '上海' })))
check('formatWeather：无 name 时不出现多余空格',
  formatWeather(WEATHER_DATA).startsWith('🌤 今日天气'), formatWeather(WEATHER_DATA).split('\n')[0])
check('formatWeather：name 前后空白被裁掉',
  formatWeather(WEATHER_DATA, { name: '  上海  ' }).startsWith('🌤 上海 今日天气'))
check('formatWeather：整数温度不带 .0（data 里 24 → 24°C）',
  formatWeather({ current: { temperature_2m: 24, weather_code: 0 } }).includes('现在 24°C 晴'))
check('formatWeather：缺温度 → --', formatWeather({ current: { weather_code: 3 } }).includes('现在 --°C 阴'))
check('formatWeather：缺 daily 全部 → 最高/最低/降水都是 --',
  formatWeather({ current: { weather_code: 61 } }).includes('最高 --°C / 最低 --°C')
  && formatWeather({ current: { weather_code: 61 } }).endsWith('降水概率 --'))
check('formatWeather：daily 非对象不抛',
  formatWeather({ current: {}, daily: 'oops' }).includes('最高 --°C / 最低 --°C'))
check('formatWeather：daily 数组为空 → --',
  formatWeather({ current: {}, daily: { temperature_2m_max: [], temperature_2m_min: [] } }).includes('最高 --°C / 最低 --°C'))
check('formatWeather：字符串数值照样认',
  formatWeather({ current: { temperature_2m: '18.5', weather_code: '61' }, daily: { precipitation_probability_max: ['7'] } })
    .includes('现在 18.5°C 小雨') )
check('formatWeather：降水概率四舍五入', formatWeather({ daily: { precipitation_probability_max: [29.6] } }).endsWith('降水概率 30%'))
check('formatWeather：weather_code 缺失 → 未知天气',
  formatWeather({ current: { temperature_2m: 20 } }).includes('现在 20°C 未知天气'))
check('formatWeather：未知 weather_code 999 → 未知天气',
  formatWeather({ current: { weather_code: 999 } }).includes('未知天气'))
check('formatWeather：未知 code 头部用 ❓', formatWeather({ current: { weather_code: 999 } }).startsWith('❓'))
check('formatWeather：非对象输入不抛', typeof formatWeather(null) === 'string')
check('formatWeather：null 输入全 --', formatWeather(null).includes('现在 --°C 未知天气'))
check('formatWeather：字符串输入不抛', formatWeather('nope').includes('降水概率 --'))
check('formatWeather：数组输入不抛', formatWeather([1, 2, 3]).startsWith('❓ 今日天气'))
check('formatWeather：显式 null 温度 → --',
  formatWeather({ current: { temperature_2m: null, weather_code: 2 } }).includes('现在 --°C 多云'))

const TRUNCATED = formatWeather(WEATHER_DATA, { name: '上海', maxChars: 12 })
check('formatWeather：超长截断加标记', TRUNCATED.endsWith(TRUNCATED_MARK), JSON.stringify(TRUNCATED))
check('formatWeather：截断长度 = maxChars + 标记长度（标记不计入 maxChars）',
  TRUNCATED.length === 12 + TRUNCATED_MARK.length, TRUNCATED.length)
check('formatWeather：maxChars 非法回落 400', !formatWeather(WEATHER_DATA, { maxChars: 0 }).includes(TRUNCATED_MARK))
check('formatWeather：maxChars 非数字回落 400', !formatWeather(WEATHER_DATA, { maxChars: 'many' }).includes(TRUNCATED_MARK))
check('formatWeather：足够大的 maxChars 不截断', !formatWeather(WEATHER_DATA, { maxChars: 9999 }).includes(TRUNCATED_MARK))
check('formatWeather：options 非对象不抛', formatWeather(WEATHER_DATA, null).startsWith('🌤 今日天气'))

// WMO 映射表覆盖（每个码都必须有中文，不能落到“未知天气”）
const REQUIRED_CODES = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]
for (const code of REQUIRED_CODES) {
  const line = formatWeather({ current: { weather_code: code, temperature_2m: 1 } }).split('\n')[1]
  check(`weather_code ${code} 有中文映射`, !line.includes('未知天气'), line)
}
check('weather_code 2 → 🌤 多云（与示例一致）',
  formatWeather({ current: { weather_code: 2 } }).split('\n')[1] === '现在 --°C 多云')
check('weather_code 45 → 雾', formatWeather({ current: { weather_code: 45 } }).includes('雾'))
check('weather_code 95 → 雷阵雨', formatWeather({ current: { weather_code: 95 } }).includes('雷阵雨'))

// ---------------------------------------------------------------- Broadcaster

// start() 排期：定点任务 + 间隔任务 + 停用任务
{
  const clock = createFakeClock()
  const { send, sent } = createSend()
  const { fetchImpl } = weatherFetch()
  const broadcaster = new Broadcaster({
    jobs: [
      { id: 'sun', kind: 'weather', chat: 'g:7', name: '上海', latitude: 31.2, longitude: 121.5, at: '20:00' },
      { id: 'news', kind: 'rss', chat: 'g:8', url: 'https://example.com/rss', everyMinutes: 30 },
      { id: 'off', kind: 'mc', chat: 'g:9', address: 'mc.example.com', at: '09:00', enabled: false },
    ],
    send,
    fetchImpl,
    now: clock.now,
    timers: clock.timers,
  })
  broadcaster.start()
  const rows = broadcaster.list()
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
  check('start() 后 list() 长度 = 任务数', rows.length === 3, rows.length)
  check('start() 后定点任务 nextAt = 当天 20:00', byId.sun.nextAt === new Date(2026, 8, 11, 20, 0, 0).getTime(),
    byId.sun.nextAt)
  check('start() 后间隔任务 nextAt = now + 30 分钟', byId.news.nextAt === BASE + 30 * MIN, byId.news.nextAt)
  check('停用任务不排期（nextAt = null）', byId.off.nextAt === null)
  check('停用任务 enabled = false', byId.off.enabled === false)
  check('list() 带 describe', byId.news.describe === 'RSS 播报 → 群 8，每 30 分钟', byId.news.describe)
  check('list() 初始统计为 0', byId.sun.runs === 0 && byId.sun.failures === 0)
  check('list() 初始 lastAt/lastReason 为空', byId.sun.lastAt === null && byId.sun.lastReason === '')
  check('只有两个任务装了定时器', clock.pending() === 2, clock.pending())

  // 推进假时钟 10 小时 → 20:00 到点触发一次
  await clock.advance(10 * HOUR)
  check('到点触发后 send 被调用一次', sent.length === 1, sent.length)
  check('send 收到正确会话', sent[0]?.chat === 'g:7', sent[0]?.chat)
  check('send 文本非空且是天气文案',
    typeof sent[0]?.text === 'string' && sent[0].text.includes('🌤 上海 今日天气'), JSON.stringify(sent[0]?.text))
  check('触发后 runs = 1', broadcaster.list()[0].runs === 1)
  check('触发后 lastAt = 计划时刻', broadcaster.list()[0].lastAt === new Date(2026, 8, 11, 20, 0, 0).getTime(),
    broadcaster.list()[0].lastAt)
  check('触发后 lastReason 为中文', broadcaster.list()[0].lastReason === '已播报', broadcaster.list()[0].lastReason)
  check('触发后重排到次日 20:00',
    broadcaster.list()[0].nextAt === new Date(2026, 8, 12, 20, 0, 0).getTime(), broadcaster.list()[0].nextAt)

  // 再推进 10 小时（还没到次日 20:00）→ 不应再发
  await clock.advance(10 * HOUR)
  check('未到点不重复触发', sent.length === 1, sent.length)

  // stop()：清空定时器
  broadcaster.stop()
  check('stop() 后没有挂起的定时器', clock.pending() === 0, clock.pending())
  check('stop() 后 nextAt 清空', broadcaster.list().every((row) => row.nextAt === null))
  await clock.advance(2 * DAY)
  check('stop() 后推进时间不再触发', sent.length === 1, sent.length)
  let repeated = true
  try { broadcaster.stop(); broadcaster.stop() } catch { repeated = false }
  check('stop() 可重复调用且不抛', repeated)
}

// 间隔任务：连续触发三次，网格不漂移
{
  const clock = createFakeClock()
  const { send, sent } = createSend()
  const { fetchImpl } = weatherFetch()
  const broadcaster = new Broadcaster({
    jobs: [{ id: 'loop', kind: 'weather', chat: 'g:1', latitude: 1, longitude: 2, everyMinutes: 30 }],
    send,
    fetchImpl,
    now: clock.now,
    timers: clock.timers,
  })
  broadcaster.start()
  const first = broadcaster.list()[0].nextAt
  await clock.advance(30 * MIN)
  const second = broadcaster.list()[0].nextAt
  // 故意"迟到"1 分钟推进：下一次仍要落在网格上（base+60min），而不是 now+30min
  await clock.advance(31 * MIN)
  const third = broadcaster.list()[0].nextAt
  await clock.advance(30 * MIN)
  const fourth = broadcaster.list()[0].nextAt
  check('间隔任务首次排期 = now + 30 分钟', first === BASE + 30 * MIN, first - BASE)
  check('第一次触发后 nextAt = 计划 + 30 分钟', second === BASE + 60 * MIN, second - BASE)
  check('迟到触发后仍对齐网格（不漂移）', third === BASE + 90 * MIN, third - BASE)
  check('连续三次触发后 nextAt = 计划 + 30 分钟',
    fourth - third === 30 * MIN && second - first === 30 * MIN && third - second === 30 * MIN,
    [second - first, third - second, fourth - third])
  // 三次到点各触发一次：base+30、base+60（迟到 1 分钟推进时补触发）、base+90
  check('三次到点各触发一次', sent.length === 3, sent.length)
  check('间隔任务每次文本都非空', sent.every((item) => item.text.length > 0))
}

// 延迟夹取到 [0, 2^31-1]
{
  const clock = createFakeClock()
  const broadcaster = new Broadcaster({
    jobs: [{ id: 'far', kind: 'mc', chat: 'u:1', address: 'mc.example.com', everyMinutes: 100000 }],
    pingMc: () => '✅ 在线',
    now: clock.now,
    timers: clock.timers,
  })
  broadcaster.start()
  check('超长延迟夹到 2^31-1', clock.pendingDelays()[0] === MAX_TIMER_DELAY, clock.pendingDelays()[0])
  check('夹取延迟不改变 nextAt', broadcaster.list()[0].nextAt === BASE + 100000 * MIN)
  broadcaster.stop()
}

// 失败路径：fetch 抛错 → 不发空消息、不发 send、写中文 reason
{
  const clock = createFakeClock()
  const logs = []
  const { send, sent } = createSend()
  const { fetchImpl } = createFetch(() => { throw new Error('网络断了') })
  const broadcaster = new Broadcaster({
    jobs: [{ id: 'boom', kind: 'weather', chat: 'g:3', latitude: 1, longitude: 2, at: '20:00' }],
    send,
    fetchImpl,
    now: clock.now,
    timers: clock.timers,
    log: (level, message) => logs.push({ level, message }),
  })
  broadcaster.start()
  await clock.advance(10 * HOUR)
  const row = broadcaster.list()[0]
  check('fetch 抛错时不发送任何消息', sent.length === 0, sent.length)
  check('fetch 抛错时 ok=false', row.failures === 1 && row.runs === 1)
  check('失败 reason 是中文', row.lastReason === '天气查询失败：网络断了', row.lastReason)
  check('失败 reason 含中文汉字', /[\u4e00-\u9fa5]/.test(row.lastReason))
  check('失败写 error 日志', logs.some((item) => item.level === 'error' && item.message.includes('天气查询失败')))
  check('失败后仍会重排下一次',
    row.nextAt === new Date(2026, 8, 12, 20, 0, 0).getTime(), row.nextAt)
  broadcaster.stop()
}

// HTTP 非 2xx 也算失败
{
  const clock = createFakeClock()
  const { send, sent } = createSend()
  const { fetchImpl } = weatherFetch(WEATHER_DATA, 500)
  const broadcaster = new Broadcaster({
    jobs: [{ id: 'http', kind: 'weather', chat: 'g:3', latitude: 1, longitude: 2, everyMinutes: 10 }],
    send, fetchImpl, now: clock.now, timers: clock.timers,
  })
  const result = await broadcaster.runOnce('http')
  check('HTTP 500 → ok=false', result.ok === false)
  check('HTTP 500 → 中文 reason 带状态码', result.reason === '天气查询失败：HTTP 500', result.reason)
  check('HTTP 500 → 不发消息', sent.length === 0)
  check('HTTP 500 → text 为空串', result.text === '')
}

// 天气任务缺经纬度
{
  const { send, sent } = createSend()
  const broadcaster = new Broadcaster({ jobs: [{ id: 'nolat', kind: 'weather', chat: 'g:1' }], send })
  const result = await broadcaster.runOnce('nolat')
  check('天气任务缺经纬度 → 失败', result.ok === false && result.reason === '天气任务缺少经纬度', result.reason)
  check('缺经纬度时不发消息', sent.length === 0)
}

// runOnce：未知 id
{
  const broadcaster = new Broadcaster({ jobs: [] })
  const result = await broadcaster.runOnce('nope')
  check('未知 id → ok=false', result.ok === false)
  check('未知 id → reason 为「没有这个任务」', result.reason === '没有这个任务', result.reason)
}

// runOnce：manual 立即执行且不改变排期
{
  const clock = createFakeClock()
  const { send, sent } = createSend()
  const { fetchImpl, calls } = weatherFetch()
  const broadcaster = new Broadcaster({
    jobs: [{ id: 'manual', kind: 'weather', chat: 'u:9', name: '上海', latitude: 31.2, longitude: 121.5, at: '20:00' }],
    send, fetchImpl, now: clock.now, timers: clock.timers,
  })
  broadcaster.start()
  const before = broadcaster.list()[0].nextAt
  const result = await broadcaster.runOnce('manual', { manual: true })
  check('runOnce 立即执行并返回 ok', result.ok === true, result.reason)
  check('runOnce 拿到非空文本', result.text.includes('🌤 上海 今日天气'))
  check('runOnce 触发 send', sent.length === 1 && sent[0].chat === 'u:9', JSON.stringify(sent[0]))
  check('manual 不改变排期', broadcaster.list()[0].nextAt === before, broadcaster.list()[0].nextAt)
  check('manual 记入 runs', broadcaster.list()[0].runs === 1)
  check('天气请求 URL 正确',
    calls[0].url === `${WEATHER_URL}?latitude=31.2&longitude=121.5`
      + '&current=temperature_2m,weather_code'
      + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&timezone=auto',
    calls[0].url)
  broadcaster.stop()
}

// RSS：去重 + UA + 超时信号 + 默认未配置解析器
{
  const clock = createFakeClock()
  const { send, sent } = createSend()
  const { fetchImpl, calls } = createFetch(() => textResponse('<rss><item>hello</item></rss>'))
  const broadcaster = new Broadcaster({
    jobs: [{ id: 'feed', kind: 'rss', chat: 'g:5', url: 'https://example.com/feed.xml', everyMinutes: 30 }],
    send,
    fetchImpl,
    now: clock.now,
    timers: clock.timers,
    formatFeed: async (xml, job) => ({ text: `新条目：${job.id}`, ids: ['post-1'] }),
  })
  const first = await broadcaster.runOnce('feed')
  check('RSS 首次播报 ok', first.ok === true, first.reason)
  check('RSS 首次播报发出文本', sent.length === 1 && sent[0].text === '新条目：feed', JSON.stringify(sent[0]))
  check('RSS 请求带 User-Agent',
    calls[0].init.headers['User-Agent'] === 'dsh-qq-onebot-bridge', JSON.stringify(calls[0].init.headers))
  const signal = calls[0].init.signal
  check('RSS 请求带超时 AbortSignal',
    signal !== undefined && typeof signal.aborted === 'boolean')
  const second = await broadcaster.runOnce('feed')
  check('RSS 同一 id 第二次 → 没有新条目', second.reason === '没有新条目', second.reason)
  check('RSS 第二次不发消息', sent.length === 1, sent.length)
  check('RSS 第二次 ok 仍为 true（不是失败）', second.ok === true)
  check('RSS 第二次 text 为空', second.text === '')
  check('RSS 已播报条目记入快照', broadcaster.snapshot().jobs.feed.seen.join(',') === 'post-1')

  const { fetchImpl: fetch2 } = createFetch(() => { throw new Error('超时了') })
  const failing = new Broadcaster({
    jobs: [{ id: 'feed2', kind: 'rss', chat: 'g:5', url: 'https://example.com/feed.xml' }],
    send, fetchImpl: fetch2,
  })
  const failed = await failing.runOnce('feed2')
  check('RSS 抓取失败 → ok=false', failed.ok === false)
  check('RSS 抓取失败 → 中文 reason', failed.reason === 'RSS 抓取失败：超时了', failed.reason)
  check('RSS 抓取失败 → 不发消息', sent.length === 1, sent.length)

  const { fetchImpl: fetch3 } = createFetch(() => textResponse('<rss/>'))
  const noParser = new Broadcaster({
    jobs: [{ id: 'feed3', kind: 'rss', chat: 'g:5', url: 'https://example.com/feed.xml' }],
    send, fetchImpl: fetch3,
  })
  const missing = await noParser.runOnce('feed3')
  check('没注入 formatFeed → 未配置 RSS 解析器', missing.reason === '未配置 RSS 解析器', missing.reason)
  check('没注入 formatFeed → ok=false', missing.ok === false)
  check('没注入 formatFeed → 不发消息', sent.length === 1, sent.length)

  const { fetchImpl: fetch4 } = createFetch(() => textResponse('<rss/>'))
  const broken = new Broadcaster({
    jobs: [{ id: 'feed4', kind: 'rss', chat: 'g:5', url: 'https://example.com/feed.xml' }],
    send, fetchImpl: fetch4,
    formatFeed: () => { throw new Error('解析炸了') },
  })
  const thrown = await broken.runOnce('feed4')
  check('formatFeed 抛错被兜住 → 中文 reason',
    thrown.ok === false && thrown.reason === 'RSS 解析失败：解析炸了', thrown.reason)

  const { fetchImpl: fetch5 } = createFetch(() => textResponse('<rss/>'))
  const empty = new Broadcaster({
    jobs: [{ id: 'feed5', kind: 'rss', chat: 'g:5', url: 'https://example.com/feed.xml' }],
    send, fetchImpl: fetch5,
    formatFeed: () => ({ text: '', ids: ['x'], reason: '' }),
  })
  const emptyResult = await empty.runOnce('feed5')
  check('有 id 但正文为空 → 记为失败且不发消息',
    emptyResult.ok === false && emptyResult.reason === 'RSS 解析结果为空', emptyResult.reason)
}

// MC：未注入 / 字符串 / 对象 / 抛错
{
  const { send, sent } = createSend()
  const noPing = new Broadcaster({ jobs: [{ id: 'mc0', kind: 'mc', chat: 'g:1', address: 'mc.example.com' }], send })
  const missing = await noPing.runOnce('mc0')
  check('未注入 pingMc → 未配置 MC 查询', missing.reason === '未配置 MC 查询', missing.reason)
  check('未注入 pingMc → ok=false 且不发消息', missing.ok === false && sent.length === 0)

  const textPing = new Broadcaster({
    jobs: [{ id: 'mc1', kind: 'mc', chat: 'g:1', address: 'mc.example.com', everyMinutes: 10 }],
    send,
    pingMc: (address) => `✅ ${address} 在线`,
  })
  const okResult = await textPing.runOnce('mc1')
  check('pingMc 返回字符串 → 发出去', okResult.ok === true && sent[0].text === '✅ mc.example.com 在线', JSON.stringify(sent[0]))
  check('pingMc 只收到地址参数', okResult.text.includes('mc.example.com'))

  const objectPing = new Broadcaster({
    jobs: [{ id: 'mc2', kind: 'mc', chat: 'g:1', address: 'mc.example.com' }],
    send,
    pingMc: () => ({ text: '', reason: '服务器离线' }),
  })
  const offline = await objectPing.runOnce('mc2')
  check('pingMc 返回 {text:空,reason} → 失败并沿用中文 reason',
    offline.ok === false && offline.reason === '服务器离线', offline.reason)
  check('离线时不发消息', sent.length === 1, sent.length)

  const throwPing = new Broadcaster({
    jobs: [{ id: 'mc3', kind: 'mc', chat: 'g:1', address: 'mc.example.com' }],
    send,
    pingMc: () => { throw new Error('连不上') },
  })
  const failedPing = await throwPing.runOnce('mc3')
  check('pingMc 抛错被兜住 → 中文 reason',
    failedPing.ok === false && failedPing.reason === 'MC 查询失败：连不上', failedPing.reason)
  check('pingMc 抛错时不发消息', sent.length === 1, sent.length)
}

// 未知 kind
{
  const broadcaster = new Broadcaster({ jobs: [{ id: 'weird', kind: 'zzz', chat: 'g:1' }] })
  const result = await broadcaster.runOnce('weird')
  check('未知 kind → 中文 reason', result.ok === false && result.reason === '未知的播报类型：zzz', result.reason)
}

// send 自己抛错（调用方保证不抛，但这里仍要兜住）
{
  const broadcaster = new Broadcaster({
    jobs: [{ id: 's', kind: 'mc', chat: 'g:1', address: 'a' }],
    send: async () => { throw new Error('通道关闭') },
    pingMc: () => 'ok',
  })
  const result = await broadcaster.runOnce('s')
  check('send 抛错 → ok=false 且中文 reason',
    result.ok === false && result.reason === '发送失败：通道关闭', result.reason)
  check('send 抛错 → 记入 failures', broadcaster.list()[0].failures === 1)
}

// snapshot / restore 往返
{
  const clock = createFakeClock()
  const { send, sent } = createSend()
  const { fetchImpl } = createFetch(() => textResponse('<rss/>'))
  const jobs = [{ id: 'feed', kind: 'rss', chat: 'g:5', url: 'https://example.com/feed.xml', everyMinutes: 30 }]
  const make = (sink) => new Broadcaster({
    jobs, send: sink, fetchImpl, now: clock.now, timers: clock.timers,
    formatFeed: () => ({ text: '新条目', ids: ['a', 'b'] }),
  })
  const first = make(send)
  await first.runOnce('feed')
  const snap = first.snapshot()
  const roundTrip = JSON.parse(JSON.stringify(snap))
  check('snapshot 可 JSON 序列化', roundTrip.jobs.feed.seen.length === 2, JSON.stringify(roundTrip.jobs.feed.seen))
  check('snapshot 带 lastAt/统计', roundTrip.jobs.feed.runs === 1 && roundTrip.jobs.feed.failures === 0
    && roundTrip.jobs.feed.lastAt === BASE)

  const sent2 = []
  const second = make(async (chat, text) => { sent2.push({ chat, text }) })
  second.restore(roundTrip)
  check('restore 恢复 seen', second.snapshot().jobs.feed.seen.length === 2)
  check('restore 恢复统计', second.list()[0].runs === 1 && second.list()[0].lastAt === BASE)
  const repeated = await second.runOnce('feed')
  check('restore 往返后不重复播报', repeated.reason === '没有新条目' && sent2.length === 0, repeated.reason)
  check('restore 之前旧实例只发过一次', sent.length === 1)

  let survived = true
  try {
    second.restore(null)
    second.restore({})
    second.restore({ jobs: { unknown: 5, feed: 'oops' } })
    second.restore({ jobs: { feed: { seen: [1, null, '', 'c'], runs: -3, failures: 'x', lastAt: 'bad' } } })
  } catch { survived = false }
  check('restore 遇到坏数据不抛', survived)
  check('restore 过滤空 id', second.snapshot().jobs.feed.seen.join(',') === '1,c', JSON.stringify(second.snapshot().jobs.feed.seen))
  check('restore 非法计数回落 0', second.list()[0].runs === 0 && second.list()[0].failures === 0)
  check('restore 非法 lastAt 回落 null', second.list()[0].lastAt === null)
}

// 构造器防御
{
  let survived = true
  try {
    const bare = new Broadcaster()
    bare.start()
    bare.stop()
    check('无参数构造后 list() 为空', bare.list().length === 0)
    check('无参数构造后 runOnce 返回原因', (await bare.runOnce('x')).reason === '没有这个任务')
  } catch { survived = false }
  check('构造器对脏参数不抛', survived)

  const dup = new Broadcaster({ jobs: [{ id: 'same', kind: 'mc', chat: 'g:1' }, { id: 'same', kind: 'mc', chat: 'g:2' }] })
  check('重复 id 只保留第一个', dup.list().length === 1 && dup.list()[0].chat === 'g:1')
  const auto = new Broadcaster({ jobs: [{ kind: 'mc', chat: 'g:1' }] })
  check('缺 id 时自动编号', auto.list()[0].id === 'job-1', auto.list()[0].id)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
