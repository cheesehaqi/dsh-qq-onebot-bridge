/**
 * Natural-language-ish reminder parsing for QQ messages (Chinese).
 * Supported patterns:
 *   - relative: "30分钟后", "2小时后", "3天后", "45秒后"
 *   - absolute: "明天9:00", "后天 20:30", "今天15点", "9点30分", "9点半", "8:00"
 *   - recurring: "每天8点", "每周一9点", "每个工作日下午3点"
 * Requires a reminder keyword (提醒/记得/喊我/叫我/别忘了), unless the text
 * already carries an explicit 每… schedule.
 */

const KEYWORD = /提醒|记得|喊我|叫我|别忘了/
const RECURRING = /每(?:天|日|周|星期|礼拜|个工作日)/

/** 剥掉 @、时间短语与命令词，留下提醒内容。 */
export function extractReminderContent(text) {
  const content = String(text ?? '')
    .replace(/\[CQ:at[^\]]*\]/g, '')
    .replace(/@[^\s，。！？,.!?]*/g, '')
    .replace(/\d+(?:\.\d+)?\s*(?:秒|分钟|小时|天)后/g, '')
    .replace(/(?:今天|明天|后天)?\s*(?:\d{1,2}[:：]\d{1,2}|\d{1,2}点(?:半|\d{1,2}分?)?)/g, '')
    .replace(/每(?:天|日|周|星期|礼拜|个工作日)[一二三四五六日天1-7]?\s*(?:早上|上午|中午|下午|傍晚|晚上|夜里)?\s*(?:\d{1,2}[:：]\d{1,2}|\d{1,2}点(?:半|\d{1,2}分?)?)?/g, '')
    .replace(/(?:请|帮我|记得|别忘了)?\s*提醒(?:我|一下|你)?/g, '')
    .replace(/[喊叫]我/g, '')
    .replace(/^[\s，。：:、]+|[\s，。：:、]+$/g, '')
  return content === '' ? '时间到了' : content
}

export function parseReminder(text, requireKeyword = true) {
  const t = String(text ?? '').trim()
  if (t === '') return null
  if (requireKeyword && !KEYWORD.test(t)) return null
  // 重复提醒交给 parseRecurringReminder，避免把「每天8点」当成一次性提醒。
  if (RECURRING.test(t)) return null

  let dueAt = null

  // 相对时间：N 秒/分钟/小时/天 后
  const rel = /(\d+(?:\.\d+)?)\s*(秒|分钟|小时|天)后/.exec(t)
  if (rel) {
    const n = Number(rel[1])
    const ms = rel[2] === '秒' ? n * 1000
      : rel[2] === '分钟' ? n * 60_000
      : rel[2] === '小时' ? n * 3_600_000
      : n * 86_400_000
    if (!Number.isFinite(ms) || ms <= 0) return null
    dueAt = Date.now() + ms
  } else {
    // 绝对时间
    const dayOff = /后天/.test(t) ? 2 : /明天/.test(t) ? 1 : /今天/.test(t) ? 0 : -1
    const hm = /(\d{1,2})[:：](\d{1,2})/.exec(t)
    const hmCn = /(\d{1,2})点(半|(\d{1,2})分?)?/.exec(t)
    if (hm || hmCn) {
      const hh = Number((hm ?? hmCn)[1])
      const mm = hm ? Number(hm[2]) : ((hmCn[2] === '半') ? 30 : Number(hmCn[3] ?? 0))
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
      const now = new Date()
      const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (dayOff >= 0 ? dayOff : 0), hh, mm, 0, 0)
      if (dayOff < 0 && base.getTime() <= now.getTime()) base.setDate(base.getDate() + 1)
      dueAt = base.getTime()
    }
  }
  if (dueAt === null) return null

  return { dueAt, content: extractReminderContent(t) }
}

/**
 * 解析重复提醒：「每天8点」「每周一9点」「每个工作日下午3点」
 * → { kind: 'daily'|'weekly'|'weekday', hour, minute, weekday?, content } | null
 */
export function parseRecurrence(text) {
  const t = String(text ?? '').trim()
  if (t === '' || !RECURRING.test(t)) return null
  const weekly = /每(?:周|星期|礼拜)([一二三四五六日天1-7])/.exec(t)
  const weekday = /每个工作日/.test(t)
  const hm = /(\d{1,2})[:：](\d{1,2})/.exec(t)
  const hmCn = /(\d{1,2})点(半|(\d{1,2})分?)?/.exec(t)
  if (!hm && !hmCn) return null
  let hour = Number((hm ?? hmCn)[1])
  const minute = hm ? Number(hm[2]) : (hmCn[2] === '半' ? 30 : Number(hmCn[3] ?? 0))
  const period = /(早上|上午|中午|下午|傍晚|晚上|夜里)/.exec(t)
  if (period && hour < 12) {
    const name = period[1]
    if (name === '下午' || name === '傍晚' || name === '晚上' || name === '夜里') hour += 12
    else if (name === '中午' && hour < 11) hour += 12
  }
  if (hour > 23 || minute > 59) return null
  if (weekly) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0 }
    const weekdayNum = map[weekly[1]]
    if (weekdayNum === undefined) return null
    return { kind: 'weekly', weekday: weekdayNum, hour, minute }
  }
  if (weekday) return { kind: 'weekday', hour, minute }
  return { kind: 'daily', hour, minute }
}

/** 下一次触发时间（严格大于 now）；8 天内找不到返回 null。 */
export function nextRecurrenceAt(rule, now = Date.now()) {
  if (!rule || typeof rule.hour !== 'number') return null
  const base = new Date(now)
  for (let offset = 0; offset < 8; offset++) {
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, rule.hour, rule.minute ?? 0, 0, 0)
    if (candidate.getTime() <= now) continue
    if (rule.kind === 'weekly' && candidate.getDay() !== rule.weekday) continue
    if (rule.kind === 'weekday' && (candidate.getDay() === 0 || candidate.getDay() === 6)) continue
    return candidate.getTime()
  }
  return null
}

/** 重复规则的中文描述（用于列表与回执）。 */
export function describeRecurrence(rule) {
  if (!rule) return ''
  const hh = String(rule.hour).padStart(2, '0')
  const mm = String(rule.minute ?? 0).padStart(2, '0')
  const time = `${hh}:${mm}`
  if (rule.kind === 'weekly') {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `每${weekdays[rule.weekday] ?? ''} ${time}`
  }
  if (rule.kind === 'weekday') return `每个工作日 ${time}`
  return `每天 ${time}`
}

/** 一次性解析：重复规则优先，其次一次性提醒。返回带 nextAt 的统一结构。 */
export function parseRecurringReminder(text, requireKeyword = true, now = Date.now()) {
  const t = String(text ?? '').trim()
  if (t === '') return null
  const rule = parseRecurrence(t)
  if (!rule) return null
  if (requireKeyword && !KEYWORD.test(t) && !RECURRING.test(t)) return null
  const nextAt = nextRecurrenceAt(rule, now)
  if (nextAt === null) return null
  return { ...rule, nextAt, content: extractReminderContent(t) }
}
