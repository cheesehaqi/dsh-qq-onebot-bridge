/**
 * 最近消息（`get_group_msg_history` / `get_friend_msg_history`）的纯逻辑：
 * 原始消息列表规范化 + 给模型看的纯文本排版。
 *
 * 这里不碰网络、不碰 fs、不碰 OneBot 客户端：bridge 拉回载荷后把 `messages` 数组
 * 传进来，所以整个模块可以脱离 bridge 单测。
 *
 * 与 lib/forward.js 是**同族但独立**的两个模块（那边是合并转发 `get_forward_msg`）：
 * 排版取舍参照它，但刻意不互相 import，任一方改动都不会牵连另一方。
 *
 * 注意：OneBot 的 `time` 是**秒**级时间戳（0 表示"没有"），本模块只做 `HH:mm` 展示。
 */

/** 段类型 → 占位文本（内容取不到时用）。 */
const SEGMENT_LABELS = {
  image: '[图片]',
  mface: '[图片]',
  record: '[语音]',
  face: '[表情]',
  forward: '[转发记录]',
  // reply / json / xml / poke / video 等段故意不给占位：它们对"读懂最近聊了什么"没帮助，
  // 硬塞进来只会让每行都拖一串噪音。未知类型同样返回空串，绝不当成错误。
}

/** 单条文本截断时追加的提示语。 */
const TRUNCATED_MARK = '…（过长已截断）'
/** 正文（多行排版）截断时追加的提示语。 */
const BODY_TRUNCATED_MARK = '…（内容过长已截断）'

/**
 * 单个段（segment）转纯文本。未知类型返回空串而不是抛错：
 * 真实载荷里混着 reply / json / xml / poke 段是常态，一个看不懂的段不该毁掉整条记录。
 */
function segmentText(seg) {
  if (seg === null || seg === undefined) return ''
  if (typeof seg === 'string') return seg
  if (typeof seg !== 'object') return String(seg)
  const type = typeof seg.type === 'string' ? seg.type : ''
  const data = (seg.data && typeof seg.data === 'object') ? seg.data : {}
  switch (type) {
    case 'text':
      return String(data.text ?? '')
    case 'at': {
      // at 段优先用显示名（NapCat 会给 name），拿不到就退化成 QQ 号
      const name = data.name ?? data.nickname ?? data.card
      const qq = data.qq ?? data.user_id ?? data.target
      const label = (name === undefined || name === null || name === '') ? qq : name
      return `@${label === undefined || label === null || label === '' ? '' : String(label)}`
    }
    case 'file': {
      const name = data.name ?? data.file ?? data.file_name
      return (name === undefined || name === null || name === '') ? '[文件]' : `[文件 ${String(name)}]`
    }
    default:
      return SEGMENT_LABELS[type] ?? ''
  }
}

/** 消息体（段数组或字符串）转展示文本：段间单空格，连续空白压缩成一个。 */
function contentToText(content) {
  if (typeof content === 'string') return collapse(content)
  if (!Array.isArray(content)) return ''
  return collapse(content.map((seg) => segmentText(seg)).filter((part) => part !== '').join(' '))
}

/** 多个连续空白（含全角空格）压成单个半角空格并 trim。 */
function collapse(value) {
  return String(value ?? '').replace(/[\s\u3000]+/g, ' ').trim()
}

/** 取第一个非空字符串候选（空白串算空）。 */
function firstNonEmpty(...candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue
    const text = String(candidate).trim()
    if (text !== '') return text
  }
  return ''
}

/** 可选的数值参数：非有限数或 < 1 时回落到默认值（挡住 0 / NaN / 'abc' / undefined）。 */
function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

/** 按上限硬截断纯文本，截断时追加提示语（未截断返回原文）。 */
function clipText(value, maxChars) {
  const text = String(value ?? '')
  return text.length > maxChars ? text.slice(0, maxChars) + TRUNCATED_MARK : text
}

/** 显示名：群名片优先 → 昵称 → `QQ<userId>`；连 userId 都没有才用「未知用户」。 */
function resolveName(sender, userId) {
  const name = firstNonEmpty(sender.card, sender.nickname)
  if (name !== '') return name
  return userId > 0 ? `QQ${userId}` : '未知用户'
}

/** 段数组 / 字符串 / 兜底原文 → 单条消息文本。 */
function messageTextOf(message, rawMessage) {
  if (message !== undefined && message !== null) {
    const text = contentToText(message)
    if (text !== '') return text
    // message 存在却解析不出内容（空数组、纯 reply/unknown 段）不算错：
    // 有 raw_message 兜底就用兜底，否则交给排版阶段当空行跳过。
    return typeof rawMessage === 'string' ? collapse(rawMessage) : ''
  }
  return typeof rawMessage === 'string' ? collapse(rawMessage) : ''
}

/** 归一化单条原始消息；坏项返回 null（由调用方计数）。 */
function normalizeMessage(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null

  const sender = (raw.sender && typeof raw.sender === 'object') ? raw.sender : {}
  const rawId = (raw.message_id ?? raw.messageId)
  const rawUserId = (raw.user_id ?? raw.userId)
  const rawTime = raw.time

  const message = raw.message
  const rawMessage = raw.raw_message
  const hasContent = message !== undefined || rawMessage !== undefined
  const recognizable = hasContent || rawId !== undefined || rawUserId !== undefined
    || rawTime !== undefined || sender.user_id !== undefined
    || sender.nickname !== undefined || sender.card !== undefined
  // 完全看不出是消息的对象（{} / 只有 type、post_type 的事件）算坏项
  if (!recognizable) return null

  const userIdNum = Number(rawUserId)
  const userId = Number.isFinite(userIdNum) ? userIdNum : 0
  const timeNum = Number(rawTime)

  return {
    id: (rawId === undefined || rawId === null) ? '' : String(rawId),
    userId,
    name: resolveName(sender, userId),
    time: Number.isFinite(timeNum) ? timeNum : 0,
    text: messageTextOf(message, rawMessage),
  }
}

/**
 * 规范化 OneBot `get_group_msg_history` / `get_friend_msg_history` 的原始消息列表。
 * 容错 message 是段数组或字符串、sender.card/nickname 任一缺失、raw_message 兜底；
 * 坏项计数进 `dropped` 并跳过，绝不抛错。
 * @param {Array} rawList OneBot 原始消息对象数组
 * @param {{ botQq?: number, limit?: number, maxChars?: number }} [options]
 *   botQq 是机器人自己的 QQ（当前只影响诊断，昵称不特判，`（我）`由排版阶段用 selfId 标）；
 *   limit 最多处理多少条（默认 20），maxChars 单条文本上限（默认 2000）。
 * @returns {{ messages: Array<{ id: string, userId: number, name: string, time: number, text: string }>, dropped: number, reason: string }}
 */
export function normalizeHistoryMessages(rawList, options) {
  if (!Array.isArray(rawList)) return { messages: [], dropped: 0, reason: '载荷为空或不是消息列表' }

  const opts = (options && typeof options === 'object') ? options : {}
  const limit = Math.floor(positiveNumber(opts.limit, 20))
  const maxChars = Math.floor(positiveNumber(opts.maxChars, 2000))

  const messages = []
  let dropped = 0
  // 只处理前 limit 条；被 limit 挡掉的不算坏项（它们是完整消息，只是没有配额）
  for (const raw of rawList.slice(0, limit)) {
    const message = normalizeMessage(raw)
    if (message === null) {
      dropped++
      continue
    }
    message.text = clipText(message.text, maxChars)
    messages.push(message)
  }

  // 数组存在但一条都没解析出来：也给中文原因，方便上层日志与诊断页直接展示
  const reason = (messages.length === 0 && dropped > 0) ? '消息列表无法解析' : ''
  return { messages, dropped, reason }
}

/** 秒级时间戳 → 本地 `HH:mm`；0/缺失/非法 → `--:--`。 */
function clockOf(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return '--:--'
  const date = new Date(value * 1000)
  if (Number.isNaN(date.getTime())) return '--:--'
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 把规范化后的消息排版成给模型看的纯文本。
 * 按 `time` 升序（同一时间保持传入顺序，`time` 为 0 的排最前），超 `limit` 时保留**最近**的几条；
 * 文本为空的条目跳过（`total` 仍按传入条数算）。
 * @param {Array} messages normalizeHistoryMessages 的结果
 * @param {{ limit?: number, maxChars?: number, selfId?: number, title?: string }} [options]
 * @returns {{ text: string, used: number, total: number, truncated: boolean, chars: number }}
 */
export function formatHistoryLines(messages, options) {
  const opts = (options && typeof options === 'object') ? options : {}
  const limit = Math.floor(positiveNumber(opts.limit, 20))
  const maxChars = Math.floor(positiveNumber(opts.maxChars, 2000))
  const selfIdNum = Number(opts.selfId)
  const selfId = Number.isFinite(selfIdNum) && selfIdNum > 0 ? selfIdNum : 0
  const title = (typeof opts.title === 'string' && opts.title.trim() !== '') ? opts.title : '最近消息'

  if (!Array.isArray(messages)) {
    return { text: '', used: 0, total: 0, truncated: false, chars: 0 }
  }

  const total = messages.length
  // 稳定升序：先按 time，再按原始下标，避免依赖引擎排序实现
  const sorted = messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const left = Number(a.message && a.message.time)
      const right = Number(b.message && b.message.time)
      const lt = Number.isFinite(left) ? left : 0
      const rt = Number.isFinite(right) ? right : 0
      return lt === rt ? a.index - b.index : lt - rt
    })

  // 文本为空的条目不占行；坏形状的项同样跳过
  const rows = []
  for (const { message } of sorted) {
    if (message === null || typeof message !== 'object') continue
    const text = collapse(message.text)
    if (text === '') continue
    const name = (message.name === undefined || message.name === null || String(message.name).trim() === '')
      ? '未知用户'
      : collapse(message.name)
    const mine = selfId > 0 && Number(message.userId) === selfId
    rows.push(`${clockOf(message.time)} ${name}${mine ? '（我）' : ''}: ${text}`)
  }

  // 超出上限时丢掉最早的那些，保留最近的 M 条
  const rowTruncated = rows.length > limit
  const shown = rowTruncated ? rows.slice(rows.length - limit) : rows

  const header = rowTruncated
    ? `[${title} 共 ${total} 条，显示最近 ${shown.length} 条]`
    : `[${title} 共 ${total} 条]`
  let body = shown.join('\n')

  let charTruncated = false
  if (body.length > maxChars) {
    body = body.slice(0, maxChars)
    charTruncated = true
  }

  let text = body === '' ? header : `${header}\n${body}`
  if (charTruncated) text += BODY_TRUNCATED_MARK

  return {
    text,
    used: shown.length,
    total,
    truncated: rowTruncated || charTruncated,
    chars: text.length,
  }
}
