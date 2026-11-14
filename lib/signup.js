/**
 * 群活动报名接龙：一个群同时只保留一个活动；报名/取消/列表/结束都落盘。
 * 纯存储与命令解析，不碰 OneBot。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SIGNUP_MAX_ENTRIES = 100

/** `/报名 活动名`、`/报名`、`/报名列表`、`/取消报名`、`/报名结束`。 */
export function parseSignupCommand(text) {
  const source = String(text ?? '').trim()
  if (/^[\/／]取消报名$/.test(source)) return { action: 'leave' }
  if (/^[\/／]报名列表$/.test(source)) return { action: 'list' }
  if (/^[\/／]报名结束$/.test(source)) return { action: 'close' }
  const matched = /^[\/／]报名(?:\s+(.*))?$/.exec(source)
  if (!matched) {
    return null
  }
  const arg = String(matched[1] ?? '').trim()
  if (arg === '' || /^(?:列表|list)$/i.test(arg)) return { action: arg === '' ? 'join' : 'list' }
  if (/^(?:结束|截止|end|close)$/i.test(arg)) return { action: 'close' }
  if (/^(?:取消|退出|cancel|leave)$/i.test(arg)) return { action: 'leave' }
  if (arg.length > 40) return { error: '活动名最多 40 个字' }
  return { action: 'start', title: arg }
}

export class SignupStore {
  constructor(directory) {
    this.directory = directory
  }

  #file(chatKey) {
    return join(this.directory, `${String(chatKey).replace(/[^\w-]/g, '_')}.json`)
  }

  load(chatKey) {
    try {
      const data = JSON.parse(readFileSync(this.#file(chatKey), 'utf8'))
      if (!data || typeof data !== 'object') return null
      return {
        title: String(data.title ?? ''),
        creatorId: Number(data.creatorId) || 0,
        creatorName: String(data.creatorName ?? ''),
        createdAt: Number(data.createdAt) || 0,
        closed: data.closed === true,
        entries: Array.isArray(data.entries) ? data.entries : [],
      }
    } catch {
      return null
    }
  }

  #save(chatKey, data) {
    try {
      mkdirSync(this.directory, { recursive: true })
      writeFileSync(this.#file(chatKey), JSON.stringify(data, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  }

  start(chatKey, { title, creatorId, creatorName = '' } = {}) {
    const text = String(title ?? '').trim().slice(0, 40)
    if (text === '') return { ok: false, reason: '请给出活动名，例如 /报名 周末爬山' }
    const current = this.load(chatKey)
    if (current && current.closed !== true) return { ok: false, reason: `本群已有进行中的报名「${current.title}」，先 /报名结束` }
    const data = { title: text, creatorId: Number(creatorId) || 0, creatorName: String(creatorName || '').slice(0, 40), createdAt: Date.now(), closed: false, entries: [] }
    return this.#save(chatKey, data) ? { ok: true, data } : { ok: false, reason: '报名保存失败（目录不可写）' }
  }

  join(chatKey, { userId, name = '' } = {}) {
    const data = this.load(chatKey)
    if (!data || data.closed === true) return { ok: false, reason: '本群没有进行中的报名' }
    const uid = Number(userId)
    if (!Number.isFinite(uid)) return { ok: false, reason: '缺少用户 ID' }
    if (data.entries.some((item) => Number(item.userId) === uid)) return { ok: false, reason: '你已经报过名了' }
    if (data.entries.length >= SIGNUP_MAX_ENTRIES) return { ok: false, reason: `报名人数已达上限 ${SIGNUP_MAX_ENTRIES}` }
    data.entries.push({ userId: uid, name: String(name || '').slice(0, 40), at: Date.now() })
    return this.#save(chatKey, data) ? { ok: true, data, index: data.entries.length } : { ok: false, reason: '报名保存失败' }
  }

  leave(chatKey, { userId } = {}) {
    const data = this.load(chatKey)
    if (!data) return { ok: false, reason: '本群没有报名' }
    const uid = Number(userId)
    const next = data.entries.filter((item) => Number(item.userId) !== uid)
    if (next.length === data.entries.length) return { ok: false, reason: '你还没有报名' }
    data.entries = next
    return this.#save(chatKey, data) ? { ok: true } : { ok: false, reason: '取消报名保存失败' }
  }

  close(chatKey, { userId, isAdmin = false } = {}) {
    const data = this.load(chatKey)
    if (!data) return { ok: false, reason: '本群没有报名' }
    if (data.closed === true) return { ok: false, reason: '报名已经结束了' }
    if (data.creatorId !== Number(userId) && isAdmin !== true) return { ok: false, reason: '只有发起人或管理员能结束报名' }
    data.closed = true
    return this.#save(chatKey, data) ? { ok: true, data } : { ok: false, reason: '结束报名保存失败' }
  }
}
