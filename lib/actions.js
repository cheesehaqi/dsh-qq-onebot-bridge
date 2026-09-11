/**
 * Write-action gate: every risky OneBot write action (ban / kick / notice /
 * essence / card / file upload / forward ...) goes through one token bucket
 * plus a per-day cap and an audit log, so adding new features can never
 * silently multiply the account's risk surface. Read-only actions bypass it.
 */
import { appendCappedLine } from './store.js'

const MINUTE = 60_000

/** Built-in per-action caps (per minute / per day) — deliberately conservative. */
export const DEFAULT_ACTION_LIMITS = {
  default: { perMinute: 10, perDay: 300 },
  send_like: { perMinute: 1, perDay: 10 },
  set_group_ban: { perMinute: 3, perDay: 60 },
  set_group_kick: { perMinute: 2, perDay: 20 },
  set_group_whole_ban: { perMinute: 1, perDay: 10 },
  set_group_card: { perMinute: 3, perDay: 30 },
  set_group_special_title: { perMinute: 2, perDay: 20 },
  _send_group_notice: { perMinute: 1, perDay: 5 },
  set_essence_msg: { perMinute: 3, perDay: 30 },
  send_group_forward_msg: { perMinute: 2, perDay: 30 },
  send_private_forward_msg: { perMinute: 2, perDay: 30 },
  delete_msg: { perMinute: 10, perDay: 200 },
  upload_group_file: { perMinute: 2, perDay: 30 },
  upload_private_file: { perMinute: 2, perDay: 30 },
  set_group_add_request: { perMinute: 3, perDay: 60 },
  set_friend_add_request: { perMinute: 3, perDay: 60 },
  set_msg_emoji_like: { perMinute: 3, perDay: 50 },
}

function dayKey(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class ActionGate {
  /**
   * @param auditFile absolute path of the audit log ('' disables logging)
   * @param limits overrides merged over DEFAULT_ACTION_LIMITS
   * @param perMinute/perDay global caps across ALL write actions (0 = unlimited)
   */
  constructor({ auditFile = '', limits = {}, perMinute = 0, perDay = 0, now = () => Date.now() } = {}) {
    this.auditFile = auditFile
    this.limits = { ...DEFAULT_ACTION_LIMITS, ...limits }
    this.globalPerMinute = Math.max(0, Number(perMinute) || 0)
    this.globalPerDay = Math.max(0, Number(perDay) || 0)
    this.now = now
    this.buckets = new Map()   // "action|key" -> { times: number[], day: string, dayCount: number }
    this.global = { times: [], day: '', dayCount: 0 }
    this.denied = 0
  }

  #limitFor(action) {
    return { ...(this.limits.default ?? { perMinute: 10, perDay: 300 }), ...(this.limits[action] ?? {}) }
  }

  #bucket(action, key, now) {
    const id = `${action}|${key}`
    let bucket = this.buckets.get(id)
    const day = dayKey(now)
    if (bucket === undefined) {
      bucket = { times: [], day, dayCount: 0 }
      this.buckets.set(id, bucket)
    }
    if (bucket.day !== day) {
      bucket.day = day
      bucket.dayCount = 0
    }
    bucket.times = bucket.times.filter((t) => now - t < MINUTE)
    if (this.buckets.size > 500) this.#sweep(now)
    return bucket
  }

  #sweep(now) {
    for (const [id, bucket] of this.buckets) {
      if (bucket.times.every((t) => now - t >= MINUTE * 5)) this.buckets.delete(id)
    }
  }

  /** Would this write action be allowed right now? Never throws. */
  check(action, key = '') {
    const now = this.now()
    const limit = this.#limitFor(action)
    const bucket = this.#bucket(action, key, now)
    const day = dayKey(now)
    if (this.global.day !== day) this.global.dayCount = 0
    this.global.day = day
    this.global.times = this.global.times.filter((t) => now - t < MINUTE)
    if (limit.perMinute > 0 && bucket.times.length >= limit.perMinute) {
      return { ok: false, reason: `${action} 每分钟上限 ${limit.perMinute} 次`, retryAfterMs: MINUTE - (now - bucket.times[0]) }
    }
    if (limit.perDay > 0 && bucket.dayCount >= limit.perDay) {
      return { ok: false, reason: `${action} 今日上限 ${limit.perDay} 次`, retryAfterMs: 0 }
    }
    if (this.globalPerMinute > 0 && this.global.times.length >= this.globalPerMinute) {
      return { ok: false, reason: `全局每分钟写操作上限 ${this.globalPerMinute} 次`, retryAfterMs: MINUTE - (now - this.global.times[0]) }
    }
    if (this.globalPerDay > 0 && this.global.dayCount >= this.globalPerDay) {
      return { ok: false, reason: `全局每日写操作上限 ${this.globalPerDay} 次`, retryAfterMs: 0 }
    }
    return { ok: true, reason: '', retryAfterMs: 0 }
  }

  /** Record one accepted write action (call right before performing it). */
  commit(action, key = '', detail = '') {
    const now = this.now()
    const bucket = this.#bucket(action, key, now)
    bucket.times.push(now)
    bucket.dayCount += 1
    this.global.times.push(now)
    this.global.dayCount += 1
    if (this.auditFile) {
      appendCappedLine(this.auditFile, `${new Date(now).toISOString()} ${action} ${key}${detail ? ` ${detail}` : ''}`)
    }
  }

  /**
   * Gate + execute: `fn` only runs when the action is allowed.
   * Returns `{ ok, skipped, reason, value }`; `fn` errors propagate.
   */
  async run(action, key, detail, fn) {
    const verdict = this.check(action, key)
    if (!verdict.ok) {
      this.denied += 1
      if (this.auditFile) {
        appendCappedLine(this.auditFile, `${new Date(this.now()).toISOString()} DENIED ${action} ${key} reason=${verdict.reason}`)
      }
      return { ok: false, skipped: true, reason: verdict.reason, value: undefined }
    }
    this.commit(action, key, detail)
    const value = await fn()
    return { ok: true, skipped: false, reason: '', value }
  }

  /** Small diagnostic snapshot for /health. */
  snapshot() {
    const actions = []
    for (const [id, bucket] of this.buckets) {
      if (bucket.times.length === 0 && bucket.dayCount === 0) continue
      const [action] = id.split('|')
      actions.push({ action, lastMinute: bucket.times.length, today: bucket.dayCount })
    }
    return { denied: this.denied, tracked: this.buckets.size, actions: actions.slice(0, 20) }
  }
}
