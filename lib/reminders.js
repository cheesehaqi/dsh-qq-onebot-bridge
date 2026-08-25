/**
 * Natural-language-ish reminder parsing for QQ messages (Chinese).
 * Supported patterns:
 *   - relative: "30分钟后", "2小时后", "3天后", "45秒后"
 *   - absolute: "明天9:00", "后天 20:30", "今天15点", "9点30分", "9点半", "8:00"
 * Requires a reminder keyword (提醒/记得/喊我/叫我/别忘了).
 */

const KEYWORD = /提醒|记得|喊我|叫我|别忘了/

export function parseReminder(text, requireKeyword = true) {
  const t = String(text ?? '').trim()
  if (t === '') return null
  if (requireKeyword && !KEYWORD.test(t)) return null

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

  // 提取提醒内容：剥掉 @、时间短语与命令词
  let content = t
    .replace(/\[CQ:at[^\]]*\]/g, '')
    .replace(/@[^\s，。！？,.!?]*/g, '')
    .replace(/\d+(?:\.\d+)?\s*(?:秒|分钟|小时|天)后/g, '')
    .replace(/(?:今天|明天|后天)?\s*(?:\d{1,2}[:：]\d{1,2}|\d{1,2}点(?:半|\d{1,2}分?)?)/g, '')
    .replace(/(?:请|帮我|记得|别忘了)?\s*提醒(?:我|一下|你)?/g, '')
    .replace(/[喊叫]我/g, '')
    .replace(/^[\s，。：:、]+|[\s，。：:、]+$/g, '')
  if (content === '') content = '时间到了'

  return { dueAt, content }
}
