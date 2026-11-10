/**
 * 群活跃看板：只读 `qq-history/YYYY-MM-DD.jsonl` 的**聚合计数**。
 *
 * 刻意不返回消息原文：控制台只需要"哪个群这几天说了多少、谁最活跃"，
 * 返回 text 等于把私聊内容又搬进另一个页面。这里只保留 chatKey / userId / name / ts。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const pad = (value) => String(value).padStart(2, '0')
const DAY_MS = 86_400_000

export const ACTIVITY_MAX_DAYS = 30

/** 本地时区日期键（与桥的 history 归档同名）。 */
export function activityDayKey(ts) {
  const date = new Date(Number(ts))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 本地时区当天 0 点。 */
export function startOfLocalDay(now = Date.now()) {
  const date = new Date(Number(now))
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * 聚合记录（纯函数）。
 * @param {Array<{ts:number, chatKey:string, userId?:number, name?:string}>} records
 * @param {{days?:number, now?:number, topMembers?:number}} options
 */
export function aggregateActivity(records, { days = 7, now = Date.now(), topMembers = 3 } = {}) {
  const span = Math.max(1, Math.min(ACTIVITY_MAX_DAYS, Math.floor(Number(days) || 7)))
  const since = startOfLocalDay(now) - (span - 1) * DAY_MS
  const chats = new Map()
  let total = 0
  for (const record of Array.isArray(records) ? records : []) {
    const ts = Number(record?.ts)
    const chatKey = String(record?.chatKey ?? '')
    if (!Number.isFinite(ts) || ts < since) continue
    if (!/^[gu]:\d+$/.test(chatKey)) continue
    const day = activityDayKey(ts)
    let entry = chats.get(chatKey)
    if (!entry) {
      entry = {
        chatKey,
        kind: chatKey.startsWith('g:') ? 'group' : 'private',
        total: 0,
        lastAt: 0,
        days: new Map(),
        members: new Map(),
      }
      chats.set(chatKey, entry)
    }
    entry.total += 1
    entry.lastAt = Math.max(entry.lastAt, ts)
    entry.days.set(day, (entry.days.get(day) ?? 0) + 1)
    const userId = Number(record?.userId) || 0
    if (userId > 0) {
      const member = entry.members.get(userId) ?? { userId, name: '', count: 0 }
      member.count += 1
      if (typeof record?.name === 'string' && record.name.trim() !== '') member.name = record.name.trim()
      entry.members.set(userId, member)
    }
    total += 1
  }
  const dayKeys = []
  for (let offset = span - 1; offset >= 0; offset -= 1) dayKeys.push(activityDayKey(startOfLocalDay(now) - offset * DAY_MS))
  const result = [...chats.values()].map((entry) => ({
    chatKey: entry.chatKey,
    kind: entry.kind,
    total: entry.total,
    lastAt: entry.lastAt,
    daily: dayKeys.map((day) => ({ day, count: entry.days.get(day) ?? 0 })),
    topMembers: [...entry.members.values()]
      .sort((a, b) => b.count - a.count || a.userId - b.userId)
      .slice(0, Math.max(1, topMembers))
      .map((member) => ({ userId: member.userId, name: member.name, count: member.count })),
  })).sort((a, b) => b.total - a.total || a.chatKey.localeCompare(b.chatKey))
  return {
    since,
    days: span,
    total,
    groups: result.filter((entry) => entry.kind === 'group'),
    privates: result.filter((entry) => entry.kind === 'private'),
    chats: result,
  }
}

/**
 * 从归档目录读取最近 N 天并聚合。
 * 读不到/没开归档都返回 `ok:true` + 空列表，让页面显示"没有数据"而不是报错。
 */
export function readActivity(dir, { days = 7, now = Date.now(), maxLines = 200_000 } = {}) {
  const span = Math.max(1, Math.min(ACTIVITY_MAX_DAYS, Math.floor(Number(days) || 7)))
  const since = startOfLocalDay(now) - (span - 1) * DAY_MS
  const firstDay = activityDayKey(since)
  const records = []
  let files = 0
  let lines = 0
  let truncated = false
  try {
    if (statSync(dir).isDirectory() !== true) throw new Error('not a directory')
    const names = readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) >= firstDay)
      .sort()
    files = names.length
    for (const name of names) {
      const text = readFileSync(join(dir, name), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue
        if (lines >= maxLines) { truncated = true; break }
        lines += 1
        try {
          const record = JSON.parse(line)
          if (record && typeof record === 'object') records.push(record)
        } catch { /* 坏行跳过 */ }
      }
      if (truncated) break
    }
  } catch {
    return {
      ok: true, dir, days: span, since, missing: true,
      total: 0, groups: [], privates: [], chats: [],
      scanned: { files: 0, lines: 0, truncated: false },
    }
  }
  const result = aggregateActivity(records, { days: span, now })
  return { ok: true, dir, missing: false, ...result, scanned: { files, lines, truncated } }
}
