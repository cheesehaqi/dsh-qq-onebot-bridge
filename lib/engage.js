/**
 * 互动（engage）：让机器人「点一下就完事」——戳一戳 / 正在输入 / 表情回应 / 点赞 / 标记已读。
 *
 * ── 真机探针结论（2026-09-14，静态读 `NapCat/bootmain/napcat.mjs`，QQ 9.9.32-50969）──
 * 支持（action 名 → 参数）：
 *   - `group_poke` / `friend_poke` / `send_poke`：{ group_id?, user_id?, target_id? }
 *   - `set_input_status`：{ user_id, event_type }（**只走私聊 C2C**，群聊无此能力）
 *   - `set_msg_emoji_like`：{ message_id, emoji_id, set? }（message_id 必须是**短 ID**）
 *   - `get_emoji_likes`：{ group_id?, message_id, emoji_id, emoji_type?, count? } → { emoji_like_list:[{user_id,nick_name}] }
 *   - `fetch_emoji_like`：{ message_id, emojiId, emojiType, count?, cookie? } → { emojiLikesList:[{tinyId,nickName,headUrl}], ... }
 *   - `send_like`：{ user_id, times? }（失败码 1400：频率过快或用户不存在）
 *   - `mark_group_msg_as_read` / `mark_private_msg_as_read` / `mark_msg_as_read`：{ group_id? , user_id? }（**按会话**，不按单条消息）
 * 入站事件：
 *   - `notice.group_msg_emoji_like`：{ group_id, user_id, message_id, likes, is_add, message_seq }
 *   - `notice.notify/poke`：{ user_id, target_id, sender_id, raw_info }
 *   - `notice.notify/input_status`：{ user_id, event_type, status_text, group_id }
 * **不支持**：发送内联按钮。该构建里 `"keyboard"` / `"button"` 段名出现 **0 次**，
 * OB11 段枚举只有 text/image/music/video/record/file/at/reply/json/face/mface/markdown/
 * node/forward/xml/poke/dice/rps/miniapp/contact/location/onlinefile/flashtransfer；
 * 只有 `click_inline_keyboard_button`（点**别人**发的按钮）。所以「点一下就完事」
 * 用「戳一戳 + 表情回应 + 点赞」这套真实可用的轻互动来实现，不做发按钮。
 *
 * ── 本模块的边界 ──
 * 只做**纯计算 + 本地状态**，绝不直接发 QQ：
 *   `plan*` 一律返回 `{ ok, action, params, reason }`，由 bridge 走 ActionGate、
 *   注入拦截、限流与 trace；统计类只碰注入进来的本地 JSON 存储。
 * 所有依赖（now）都可注入，因此可以完全脱离 bridge、网络与真实时钟单测。
 */

/** 戳一戳的 action 名（群聊 / 私聊）。 */
export const POKE_ACTIONS = Object.freeze({ group: 'group_poke', private: 'friend_poke' })

/** 标记已读的 action 名（群聊 / 私聊）。 */
export const MARK_READ_ACTIONS = Object.freeze({ group: 'mark_group_msg_as_read', private: 'mark_private_msg_as_read' })

/** 输入状态事件类型（NapCat：1 = 正在输入，其余按停止输入处理）。 */
export const INPUT_STATUS_EVENT = Object.freeze({ typing: 1, stop: 2 })

/** 默认的表情回应 id：128077 = 👍（十进制码点，见 emojiGlyph）。 */
export const DEFAULT_EMOJI_ID = '128077'

/** `send_like` 单次可点的最大次数（QQ 客户端上限就是 10）。 */
export const MAX_LIKE_TIMES = 10

/** 统计里最多保留多少条消息（超出按时间淘汰最旧的）。 */
const DEFAULT_MAX_MESSAGES = 500

/** 每条消息的每个表情最多记住多少个回应者。 */
const DEFAULT_MAX_USERS_PER_EMOJI = 200

/** 一小时 / 一天 / 一分钟的毫秒数。 */
const MINUTE_MS = 60_000
const HOUR_MS = 3600_000
const DAY_MS = 86_400_000

/**
 * 把一个十进制数字转成「人看得懂的东西」：
 * - 128077 → 👍（Unicode 码点写法，NapCat 的表情回应 id 就是码点）
 * - "4" 这类 QQ 经典表情短 ID 没有 Unicode 映射 → 显示 `#4`
 * - 非数字原样返回，空值给 `?`
 */
export function emojiGlyph(emojiId) {
  const raw = String(emojiId ?? '').trim()
  if (raw === '') return '?'
  if (!/^\d+$/.test(raw)) return raw
  const code = Number(raw)
  if (code >= 0x2190 && code <= 0x1faff) {
    try {
      return String.fromCodePoint(code)
    } catch {
      return `#${raw}`
    }
  }
  return `#${raw}`
}

/** 目标 QQ 是否可用（正整数或数字字符串；0 / 空 / 非数字都不认）。 */
export function isValidUserId(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return false
  if (!/^\d+$/.test(raw)) return false
  return Number(raw) > 0
}

/**
 * 规划一次戳一戳。
 * 群聊走 `group_poke`（需要 group_id + 目标）；私聊走 `friend_poke`（只要目标）。
 * 缺目标时报「戳一戳需要明确的目标 QQ」——绝不退回「戳机器人自己」这种猜测。
 */
export function planPoke({ groupId, userId, targetId } = {}) {
  if (!isValidUserId(targetId)) return { ok: false, action: '', params: null, reason: '戳一戳需要明确的目标 QQ' }
  if (groupId !== undefined && groupId !== null && String(groupId).trim() !== '') {
    if (!isValidUserId(groupId)) return { ok: false, action: '', params: null, reason: `群号不合法：${String(groupId)}` }
    return { ok: true, action: POKE_ACTIONS.group, params: { group_id: String(groupId), user_id: String(targetId) }, reason: '' }
  }
  return { ok: true, action: POKE_ACTIONS.private, params: { user_id: String(targetId) }, reason: '' }
}

/**
 * 规划一次表情回应（贴表情）。
 * `set:false` 表示取消——与 NapCat 的 `set` 字段一致（缺省为 true）。
 */
export function planEmojiLike({ messageId, emojiId = DEFAULT_EMOJI_ID, set = true } = {}) {
  const id = String(messageId ?? '').trim()
  if (id === '') return { ok: false, action: '', params: null, reason: '贴表情需要消息 ID' }
  const emoji = String(emojiId ?? '').trim() || DEFAULT_EMOJI_ID
  if (!/^\d+$/.test(emoji)) return { ok: false, action: '', params: null, reason: `表情 ID 必须是数字（收到：${emoji}）` }
  return { ok: true, action: 'set_msg_emoji_like', params: { message_id: id, emoji_id: emoji, set: set !== false }, reason: '' }
}

/**
 * 规划一次标记已读。NapCat 是按**会话**标记，不是按单条消息，
 * 所以必须给出 group_id 或 user_id；两个都没有时如实报原因。
 */
export function planMarkRead({ groupId, userId } = {}) {
  const g = groupId === undefined || groupId === null ? '' : String(groupId).trim()
  const u = userId === undefined || userId === null ? '' : String(userId).trim()
  if (g !== '' && isValidUserId(g)) return { ok: true, action: MARK_READ_ACTIONS.group, params: { group_id: g }, reason: '' }
  if (u !== '' && isValidUserId(u)) return { ok: true, action: MARK_READ_ACTIONS.private, params: { user_id: u }, reason: '' }
  return { ok: false, action: '', params: null, reason: '标记已读需要 group_id 或 user_id（NapCat 按会话标记，不按单条消息）' }
}

/**
 * 规划一次点赞。次数夹在 1..MAX_LIKE_TIMES；`times` 非数字按 1。
 * 返回里带 `clamped` 表示「要的次数和实际要发的次数不一样」，便于 trace 如实记录。
 */
export function planSendLike({ userId, times = 1, max = MAX_LIKE_TIMES } = {}) {
  if (!isValidUserId(userId)) return { ok: false, action: '', params: null, reason: '点赞需要明确的目标 QQ', clamped: false }
  // Number(Symbol()) 会抛 TypeError（审查提的 O6），所以先按类型挡住再转换。
  const toInt = (value, fallback) => (typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN) || fallback
  const limit = Math.max(1, Math.min(MAX_LIKE_TIMES, toInt(max, MAX_LIKE_TIMES)))
  const wantedOk = Number.isFinite(toInt(times, Number.NaN)) ? Math.trunc(toInt(times, 1)) : 1
  const count = Math.max(1, Math.min(limit, wantedOk))
  return {
    ok: true,
    action: 'send_like',
    params: { user_id: String(userId), times: count },
    reason: '',
    clamped: count !== wantedOk,
  }
}

/**
 * 规划一次「正在输入」。NapCat 的 `set_input_status` 只走私聊 C2C，
 * 群聊调用会直接失败，所以这里先如实拒绝，不让调用白跑一趟。
 */
export function planInputStatus({ userId, eventType = INPUT_STATUS_EVENT.typing, isGroup = false } = {}) {
  if (isGroup) return { ok: false, action: '', params: null, reason: 'set_input_status 只支持私聊（NapCat 走 C2C 会话，群聊无此能力）' }
  if (!isValidUserId(userId)) return { ok: false, action: '', params: null, reason: '正在输入需要一个明确的私聊对象 QQ' }
  const type = Number(eventType) === INPUT_STATUS_EVENT.stop ? INPUT_STATUS_EVENT.stop : INPUT_STATUS_EVENT.typing
  return { ok: true, action: 'set_input_status', params: { user_id: String(userId), event_type: type }, reason: '' }
}

/** event_type → 中文（trace 与日志用）。 */
export function describeInputStatus(eventType) {
  const type = Number(eventType)
  if (type === INPUT_STATUS_EVENT.typing) return '正在输入'
  if (type === INPUT_STATUS_EVENT.stop) return '停止输入'
  return `未知输入状态（event_type=${String(eventType)}）`
}

/** 是不是「对方正在输入」的 notice。 */
export function isInputStatusNotice(notice) {
  return notice?.noticeType === 'notify' && notice?.subType === 'input_status'
}

/** 是不是表情回应 notice。 */
export function isEmojiLikeNotice(notice) {
  return notice?.noticeType === 'group_msg_emoji_like'
}

/**
 * 把「对方正在输入」渲染成一行中文。status_text 由对方客户端决定，非空就用它；
 * 但它自己常常已经带了省略号（NapCat 默认就是「对方正在输入...」），
 * 所以只在结尾没有标点时才补一个 `…`，避免出现「对方正在输入...…」这种双标点。
 */
export function formatInputStatusNotice(notice) {
  const who = String(notice?.userId ?? '') || '某人'
  const text = String(notice?.statusText ?? '').trim() || describeInputStatus(notice?.eventType ?? INPUT_STATUS_EVENT.typing)
  const tail = /[.…。！？!?~～]$/.test(text) ? '' : '…'
  return `${who} ${text}${tail}`
}

/**
 * 归一化 `likes` 字段。真机给的形状是 `[{ emoji_id, count }]`，
 * 但为了不被上游小改动打断，这里同时接受对象字典与纯字符串数组：
 *   [{emoji_id:'128077',count:2}] / { '128077': 2 } / ['128077'] → [{ emojiId:'128077', count:2 }]
 * 解析不出任何条目时返回空数组，由调用方给出「没有 likes 字段」这类真实 reason。
 */
export function normalizeEmojiLikes(likes) {
  const out = new Map()
  if (Array.isArray(likes)) {
    for (const item of likes) {
      if (item === null || item === undefined) continue
      if (typeof item === 'object') {
        const id = String(item.emoji_id ?? item.emojiId ?? item.id ?? '').trim()
        if (id === '') continue
        const count = Number(item.count)
        out.set(id, (out.get(id) ?? 0) + (Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1))
      } else {
        const id = String(item).trim()
        if (id === '') continue
        out.set(id, (out.get(id) ?? 0) + 1)
      }
    }
  } else if (likes && typeof likes === 'object') {
    for (const [id, count] of Object.entries(likes)) {
      const key = String(id).trim()
      if (key === '') continue
      const value = Number(count)
      out.set(key, (out.get(key) ?? 0) + (Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1))
    }
  }
  return [...out.entries()].map(([emojiId, count]) => ({ emojiId, count }))
}

/**
 * 表情回应统计（本地状态，可按群/会话查询）。
 *
 * 记忆结构：messageId → { chatKey, groupId, ownerId, at, emojis: Map<emojiId, Map<userId, name>> }。
 * 用「谁点过」的集合而不是计数器，所以同一个人重复点同一个表情不会把统计刷上去，
 * 撤回（is_add=false）也能精确地只去掉那个人。
 */
export class ReactionStats {
  constructor({ maxMessages = DEFAULT_MAX_MESSAGES, maxUsersPerEmoji = DEFAULT_MAX_USERS_PER_EMOJI } = {}) {
    this.maxMessages = Math.max(1, Math.trunc(Number(maxMessages) || DEFAULT_MAX_MESSAGES))
    this.maxUsersPerEmoji = Math.max(1, Math.trunc(Number(maxUsersPerEmoji) || DEFAULT_MAX_USERS_PER_EMOJI))
    /** @type {Map<string, {chatKey:string, groupId:string, ownerId:string, at:number, emojis:Map<string, Map<string,string>>}>} */
    this.messages = new Map()
  }

  get size() {
    return this.messages.size
  }

  /**
   * 记一条表情回应通知。
   * 返回 { ok, reason, messageId, emojiId, count, added, removed, total }；
   * 缺消息 ID / 没有 likes 时 ok=false 且 reason 说明真实原因（调用方写进 trace）。
   */
  apply(notice, now = Date.now()) {
    const messageId = String(notice?.messageId ?? '').trim()
    if (messageId === '') return { ok: false, reason: '表情回应通知缺少 message_id', messageId: '', emojiId: '', count: 0, added: 0, removed: 0, total: 0 }
    const likes = normalizeEmojiLikes(notice?.likes)
    if (likes.length === 0) return { ok: false, reason: '表情回应通知没有可解析的 likes 字段', messageId, emojiId: '', count: 0, added: 0, removed: 0, total: 0 }
    const userId = String(notice?.userId ?? '').trim()
    if (userId === '') return { ok: false, reason: '表情回应通知缺少 user_id（不知道是谁点的）', messageId, emojiId: '', count: 0, added: 0, removed: 0, total: 0 }

    const groupId = notice?.groupId === undefined || notice?.groupId === null ? '' : String(notice.groupId)
    const chatKey = groupId === '' ? `u:${userId}` : `g:${groupId}`
    const add = notice?.isAdd !== false
    let entry = this.messages.get(messageId)
    if (!entry) {
      entry = { chatKey, groupId, ownerId: '', at: now, emojis: new Map() }
      this.messages.set(messageId, entry)
    }
    entry.at = now
    entry.chatKey = chatKey
    if (groupId !== '') entry.groupId = groupId

    let added = 0
    let removed = 0
    let lastEmoji = ''
    for (const like of likes) {
      lastEmoji = like.emojiId
      let users = entry.emojis.get(like.emojiId)
      if (!users) {
        if (!add) continue
        users = new Map()
        entry.emojis.set(like.emojiId, users)
      }
      if (add) {
        if (!users.has(userId) && users.size < this.maxUsersPerEmoji) {
          users.set(userId, String(notice?.senderName ?? notice?.name ?? ''))
          added++
        }
      } else if (users.delete(userId)) {
        removed++
        if (users.size === 0) entry.emojis.delete(like.emojiId)
      }
    }
    this.#prune(now)
    return {
      ok: true,
      reason: '',
      messageId,
      emojiId: lastEmoji,
      count: likes.reduce((sum, like) => sum + like.count, 0),
      added,
      removed,
      total: this.totalFor(messageId),
    }
  }

  /** 某条消息收到的表情总数（按「谁点过」去重后的唯一用户数）。 */
  totalFor(messageId) {
    const entry = this.messages.get(String(messageId ?? '').trim())
    if (!entry) return 0
    let total = 0
    for (const users of entry.emojis.values()) total += users.size
    return total
  }

  /** 某条消息按表情分组的明细，数量多的在前。 */
  byEmoji(messageId) {
    const entry = this.messages.get(String(messageId ?? '').trim())
    if (!entry) return []
    return [...entry.emojis.entries()]
      .map(([emojiId, users]) => ({ emojiId, glyph: emojiGlyph(emojiId), count: users.size, users: [...users.entries()].map(([userId, name]) => ({ userId, name })) }))
      .sort((a, b) => b.count - a.count || a.emojiId.localeCompare(b.emojiId))
  }

  /** 被表情回应最多的消息（可按 chatKey 过滤），带每个表情的分组。 */
  topMessages({ limit = 10, chatKey = '' } = {}) {
    const rows = []
    for (const [messageId, entry] of this.messages.entries()) {
      if (chatKey !== '' && entry.chatKey !== chatKey) continue
      const emojis = this.byEmoji(messageId)
      const total = emojis.reduce((sum, item) => sum + item.count, 0)
      if (total === 0) continue
      rows.push({ messageId, chatKey: entry.chatKey, groupId: entry.groupId, at: entry.at, total, emojis })
    }
    rows.sort((a, b) => b.total - a.total || b.at - a.at || a.messageId.localeCompare(b.messageId))
    return rows.slice(0, Math.max(1, Math.trunc(Number(limit) || 10)))
  }

  /** 最活跃的「点赞的人」（按他点过的消息-表情数去重计数）。 */
  topUsers({ limit = 10, chatKey = '' } = {}) {
    const tally = new Map()
    for (const entry of this.messages.values()) {
      if (chatKey !== '' && entry.chatKey !== chatKey) continue
      for (const users of entry.emojis.values()) {
        for (const userId of users.keys()) tally.set(userId, (tally.get(userId) ?? 0) + 1)
      }
    }
    return [...tally.entries()]
      .map(([userId, total]) => ({ userId, total }))
      .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId))
      .slice(0, Math.max(1, Math.trunc(Number(limit) || 10)))
  }

  /** 丢掉超过保留期（默认 30 天）或超出容量上限的消息。 */
  prune(now = Date.now(), keepMs = 30 * DAY_MS) {
    return this.#prune(now, keepMs)
  }

  #prune(now = Date.now(), keepMs = 30 * DAY_MS) {
    let dropped = 0
    for (const [messageId, entry] of this.messages.entries()) {
      if (now - entry.at > keepMs) {
        this.messages.delete(messageId)
        dropped++
      }
    }
    if (this.messages.size > this.maxMessages) {
      const sorted = [...this.messages.entries()].sort((a, b) => a[1].at - b[1].at)
      const excess = this.messages.size - this.maxMessages
      for (let i = 0; i < excess; i++) {
        this.messages.delete(sorted[i][0])
        dropped++
      }
    }
    return dropped
  }

  /** 落盘用的纯对象（JsonStore 直接存这个）。 */
  snapshot() {
    const messages = {}
    for (const [messageId, entry] of this.messages.entries()) {
      const emojis = {}
      for (const [emojiId, users] of entry.emojis.entries()) emojis[emojiId] = Object.fromEntries(users)
      messages[messageId] = { chatKey: entry.chatKey, groupId: entry.groupId, ownerId: entry.ownerId, at: entry.at, emojis }
    }
    return { version: 1, messages }
  }

  /** 从 snapshot() 恢复；结构不认识就当成空（不抛错，避免坏文件把机器人带崩）。 */
  restore(data) {
    this.messages.clear()
    const messages = data?.messages
    if (!messages || typeof messages !== 'object') return 0
    let loaded = 0
    for (const [messageId, entry] of Object.entries(messages)) {
      if (!entry || typeof entry !== 'object') continue
      const emojis = new Map()
      for (const [emojiId, users] of Object.entries(entry.emojis ?? {})) {
        if (!users || typeof users !== 'object') continue
        const map = new Map()
        for (const [userId, name] of Object.entries(users)) map.set(userId, String(name ?? ''))
        if (map.size > 0) emojis.set(String(emojiId), map)
      }
      this.messages.set(String(messageId), {
        chatKey: String(entry.chatKey ?? ''),
        groupId: String(entry.groupId ?? ''),
        ownerId: String(entry.ownerId ?? ''),
        at: Number(entry.at) || 0,
        emojis,
      })
      loaded++
    }
    return loaded
  }
}

/**
 * 按 key 计数的滑动窗口配额（每小时 / 每天），用于戳一戳、贴表情、点赞这类写操作限流。
 * 与 auto-heal 的「冷却 + 每小时上限」同源，但这里把窗口计数抽出来复用。
 */
export class EngageQuota {
  constructor({ perMinute = 0, perHour = 0, perDay = 0 } = {}) {
    this.perMinute = Math.max(0, Math.trunc(Number(perMinute) || 0))
    this.perHour = Math.max(0, Math.trunc(Number(perHour) || 0))
    this.perDay = Math.max(0, Math.trunc(Number(perDay) || 0))
    /** @type {Map<string, number[]>} */
    this.marks = new Map()
  }

  #count(key, now, windowMs) {
    const list = this.marks.get(key) ?? []
    return list.filter((at) => now - at < windowMs).length
  }

  /**
   * 能不能再做一次。`label` 只用于中文提示（不带 label 时退回 key）。
   * 每次拒绝都给出「已经用了几次、上限几次」的真实信息。
   */
  check(key, now = Date.now(), label = '') {
    const name = label || key
    const minute = this.perMinute > 0 ? this.#count(key, now, MINUTE_MS) : 0
    const hour = this.perHour > 0 ? this.#count(key, now, HOUR_MS) : 0
    const day = this.perDay > 0 ? this.#count(key, now, DAY_MS) : 0
    if (this.perMinute > 0 && minute >= this.perMinute) return { ok: false, reason: `${name} 已达每分钟上限（${minute}/${this.perMinute} 次）`, used: { minute, hour, day } }
    if (this.perHour > 0 && hour >= this.perHour) return { ok: false, reason: `${name} 已达每小时上限（${hour}/${this.perHour} 次）`, used: { minute, hour, day } }
    if (this.perDay > 0 && day >= this.perDay) return { ok: false, reason: `${name} 已达每天上限（${day}/${this.perDay} 次）`, used: { minute, hour, day } }
    return { ok: true, reason: '', used: { minute, hour, day } }
  }

  /** 记一次成功（写操作真的发出去了才记）。 */
  record(key, now = Date.now()) {
    const list = this.marks.get(key) ?? []
    list.push(now)
    this.marks.set(key, list.filter((at) => now - at < DAY_MS))
  }

  /** 清掉过期记账，避免长跑内存增长。 */
  prune(now = Date.now()) {
    let dropped = 0
    for (const [key, list] of this.marks.entries()) {
      const kept = list.filter((at) => now - at < DAY_MS)
      dropped += list.length - kept.length
      if (kept.length === 0) this.marks.delete(key)
      else this.marks.set(key, kept)
    }
    return dropped
  }

  snapshot() {
    return { version: 1, perMinute: this.perMinute, perHour: this.perHour, perDay: this.perDay, marks: Object.fromEntries(this.marks) }
  }

  restore(data) {
    this.marks.clear()
    const marks = data?.marks
    if (!marks || typeof marks !== 'object') return 0
    let loaded = 0
    for (const [key, list] of Object.entries(marks)) {
      if (!Array.isArray(list)) continue
      const kept = list.map((at) => Number(at)).filter((at) => Number.isFinite(at))
      if (kept.length === 0) continue
      this.marks.set(String(key), kept)
      loaded++
    }
    return loaded
  }
}

/**
 * 渲染 `/赞榜`：本群（或本会话）被表情回应最多的消息。
 * `textOf(messageId)` 可选：能拿到原文时顺带显示摘要（拿不到就只显示 ID）。
 */
export function formatReactionBoard(rows, { limit = 10, textOf = null, maxChars = 24 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return '本会话还没有任何表情回应记录（表情统计默认只记 group_msg_emoji_like 通知）'
  const top = rows.slice(0, Math.max(1, Math.trunc(Number(limit) || 10)))
  const lines = [`本会话表情回应榜（共 ${top.length} 条）：`]
  top.forEach((row, index) => {
    const glyphs = (row.emojis ?? []).slice(0, 4).map((item) => `${item.glyph}×${item.count}`).join(' ')
    let summary = ''
    if (typeof textOf === 'function') {
      try {
        const text = String(textOf(row.messageId) ?? '').trim()
        if (text !== '') summary = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
      } catch {
        summary = ''
      }
    }
    const who = row.chatKey?.startsWith('u:') ? '私聊' : '本群'
    lines.push(`${index + 1}. ${glyphs} 共 ${row.total} 个赞${summary === '' ? '' : `｜${summary}`}｜${who}｜消息 ${row.messageId}`)
  })
  return lines.join('\n')
}

/**
 * 渲染 `/谁赞了`：某条消息的表情明细（优先用 `get_emoji_likes` 的真实名单）。
 * `source` 用来在文案里说清数据来源，避免让人以为「榜单」和「实时名单」是同一份数据。
 */
export function formatEmojiLikes(rows, { messageId = '', source = '本地统计', maxUsers = 12 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return `消息 ${messageId} 没有表情回应记录（来源：${source}）`
  const lines = [`消息 ${messageId} 的表情回应（来源：${source}）：`]
  for (const row of rows) {
    const names = (row.users ?? []).slice(0, maxUsers).map((user) => user.name ? `${user.name}(${user.userId})` : String(user.userId))
    const more = (row.users ?? []).length > names.length ? ` 等 ${(row.users ?? []).length} 人` : ''
    lines.push(`  ${row.glyph}×${row.count}${names.length > 0 ? `：${names.join('、')}${more}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * 把 `get_emoji_likes` 的返回值塞进统计结构所需的形状：
 * { emoji_like_list: [{ user_id, nick_name }] } → [{ userId, name }]
 * 上游字段名长短不一（user_id / userId / tinyId），这里都认。
 */
export function parseEmojiLikesResult(result, { emojiId = '' } = {}) {
  const list = Array.isArray(result?.emoji_like_list) ? result.emoji_like_list : []
  const users = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const userId = String(item.user_id ?? item.userId ?? item.tinyId ?? '').trim()
    if (userId === '') continue
    users.push({ userId, name: String(item.nick_name ?? item.nickName ?? '') })
  }
  return { emojiId: String(emojiId ?? ''), glyph: emojiGlyph(emojiId), count: users.length, users }
}

/**
 * 从命令文本里取目标（`/戳 12345`、`/点赞 12345`、`/谁赞了 12345`）。
 * 只认「命令 + 空白 + 参数」的写法（与 v0.4 起所有命令一致的空白分隔约定），
 * 拿到空参数时返回 { ok:false, reason }，由调用方决定是回用法提示还是走「引用/at」解析。
 */
export function parseEngageArgs(text, command) {
  const raw = String(text ?? '')
  const cmd = String(command ?? '')
  if (cmd === '') return { ok: false, arg: '', reason: '内部错误：未指定命令名' }
  const trimmed = raw.trim()
  if (!trimmed.startsWith(cmd)) return { ok: false, arg: '', reason: `不是 ${cmd} 命令` }
  const rest = trimmed.slice(cmd.length)
  if (rest !== '' && !/^\s/.test(rest)) return { ok: false, arg: '', reason: `${cmd} 后面需要空格再接参数` }
  const arg = rest.trim()
  if (arg === '') return { ok: false, arg: '', reason: `${cmd} 需要参数` }
  return { ok: true, arg, reason: '' }
}
