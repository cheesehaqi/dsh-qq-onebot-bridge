/**
 * Group activity statistics: per-chat, per-day message counters used by /统计
 * (activity leaderboard) and the daily report. File-backed and dependency-free
 * so it can be unit-tested without a bridge.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function pad(n) { return String(n).padStart(2, '0') }

export function dayKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export class StatsStore {
  constructor(dir, { keepDays = 30 } = {}) {
    this.dir = dir
    this.keepDays = Math.max(1, Number(keepDays) || 30)
  }

  #file(chatKey) {
    return join(this.dir, `${String(chatKey).replace(/[^\w-]/g, '_')}.json`)
  }

  #load(chatKey) {
    try {
      const data = JSON.parse(readFileSync(this.#file(chatKey), 'utf8'))
      if (!data || typeof data !== 'object') return { days: {}, names: {} }
      return { days: data.days ?? {}, names: data.names ?? {} }
    } catch {
      return { days: {}, names: {} }
    }
  }

  #save(chatKey, data) {
    try {
      mkdirSync(this.dir, { recursive: true })
      const file = this.#file(chatKey)
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data), 'utf8')
      try {
        renameSync(tmp, file)
      } catch {
        rmSync(file, { force: true })
        renameSync(tmp, file)
      }
      return true
    } catch {
      return false
    }
  }

  /** 记一条发言；返回当天该成员的累计条数。 */
  record(chatKey, userId, name = '', now = Date.now()) {
    const data = this.#load(chatKey)
    const day = dayKey(now)
    const bucket = data.days[day] ?? {}
    bucket[String(userId)] = (bucket[String(userId)] ?? 0) + 1
    data.days[day] = bucket
    if (name) data.names[String(userId)] = name
    this.#pruneDays(data, now)
    this.#save(chatKey, data)
    return bucket[String(userId)]
  }

  #pruneDays(data, now) {
    const keys = Object.keys(data.days).sort()
    if (keys.length <= this.keepDays) return
    for (const key of keys.slice(0, keys.length - this.keepDays)) delete data.days[key]
  }

  /** 最近 days 天的活跃榜：[{ userId, name, count }] 降序。 */
  top(chatKey, { days = 1, limit = 10, now = Date.now() } = {}) {
    const data = this.#load(chatKey)
    const wanted = new Set()
    for (let offset = 0; offset < Math.max(1, days); offset++) {
      wanted.add(dayKey(new Date(now - offset * 86_400_000)))
    }
    const totals = new Map()
    for (const [day, bucket] of Object.entries(data.days)) {
      if (!wanted.has(day)) continue
      for (const [userId, count] of Object.entries(bucket)) {
        totals.set(userId, (totals.get(userId) ?? 0) + Number(count || 0))
      }
    }
    return [...totals.entries()]
      .map(([userId, count]) => ({ userId, name: data.names[userId] || userId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, Math.max(1, limit))
  }

  /** 某一天的群总发言数。 */
  total(chatKey, now = Date.now()) {
    const data = this.#load(chatKey)
    const bucket = data.days[dayKey(now)] ?? {}
    return Object.values(bucket).reduce((sum, value) => sum + Number(value || 0), 0)
  }

  /** 有记录的日期（升序）。 */
  dayList(chatKey) {
    return Object.keys(this.#load(chatKey).days).sort()
  }
}

/** 归一化每日日报的目标会话：显式配置/自助开关优先，否则回落到群白名单。 */
export function pickReportTargets({ configured = [], optIn = [], allowGroups = [] } = {}) {
  const collected = new Set()
  const add = (value) => {
    const text = String(value ?? '').trim()
    if (text) collected.add(text.startsWith('g:') ? text : `g:${text}`)
  }
  for (const value of configured) add(value)
  for (const value of optIn) add(value)
  if (collected.size > 0) return [...collected]
  return (allowGroups ?? []).map((id) => `g:${id}`)
}

/** 中文活跃榜文案。 */
export function formatActivity(rows, { title = '📊 群活跃榜', label = '条' } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return `${title}\n还没有统计到发言～`
  const lines = rows.map((row, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`
    return `${medal} ${row.name} ${row.count} ${label}`
  })
  return `${title}\n${lines.join('\n')}`
}

/** 把 OneBot 群荣誉数据整理成中文文案。 */
export function formatHonor(info, { groupName = '' } = {}) {
  if (!info || typeof info !== 'object') return '暂时拿不到群荣誉数据。'
  const sections = []
  const pick = (list) => (Array.isArray(list) ? list.slice(0, 3).map((item) => item?.name ?? item?.user_id ?? '未知').join('、') : '')
  const talk = pick(info.current_talkative ?? info.currentTalkative)
  const performer = pick(info.current_performer ?? info.currentPerformer)
  const legend = pick(info.current_legend ?? info.currentLegend)
  const emotion = pick(info.current_emotion ?? info.currentEmotion)
  if (talk) sections.push(`🔥 龙王：${talk}`)
  if (performer) sections.push(`🌟 群聊之火：${performer}`)
  if (legend) sections.push(`🏆 群聊炽焰：${legend}`)
  if (emotion) sections.push(`😄 快乐源泉：${emotion}`)
  if (sections.length === 0) return '暂时拿不到群荣誉数据。'
  return `🏅 ${groupName ? `${groupName} ` : ''}群荣誉\n${sections.join('\n')}`
}
