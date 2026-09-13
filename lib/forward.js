/**
 * Merged-forward ("chat record" / 合并转发) payload normalization.
 *
 * A QQ merged-forward card arrives as an OneBot v11 segment `{ type: 'forward', data: { id } }`;
 * the content itself only comes back from the `get_forward_msg` action. Different
 * implementations answer with different shapes (NapCat / OneBot v11 `{ messages: [...] }`,
 * Go-CQHTTP `{ message: [...] }`, a bare array, or a dry-run stub), so this module owns the
 * tolerant normalization plus the model-facing plain-text rendering.
 *
 * Pure functions only: no IO, no network, no timers.
 */

/** 段类型 → 占位文本（内容取不到时用）。 */
const SEGMENT_LABELS = {
  image: '[图片]',
  mface: '[图片]',
  record: '[语音]',
  video: '[视频]',
  face: '[表情]',
  forward: '[转发记录]',
  // 节点里再套转发：只标记，不递归展开（递归可能炸栈、也可能被服务端按层数限流）
}

/** 截断时追加的提示语。 */
const TRUNCATED_MARK = '…（内容过长已截断）'

/**
 * 单个段（segment）转纯文本。未知类型返回空串而不是抛错：
 * 真实载荷里混着 reply/json/xml/poke 等段是常态，一个看不懂的段不该毁掉整条记录。
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

/** 段数组（或直接的字符串）转一段展示文本：段间单空格，连续空白压缩成一个。 */
function segmentsToText(content) {
  if (typeof content === 'string') return collapse(content)
  if (!Array.isArray(content)) return ''
  return collapse(content.map((seg) => segmentText(seg)).filter((part) => part !== '').join(' '))
}

/** 多个连续空白（含全角空格）压成单个半角空格并 trim。 */
function collapse(value) {
  return String(value ?? '').replace(/[\s\u3000]+/g, ' ').trim()
}

/** 可选的数值参数：非有限数或 < 1 时回落到默认值。 */
function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

/** 可选的字符串参数：空串/非字符串时回落到默认值。 */
function nonEmptyString(value, fallback) {
  return (typeof value === 'string' && value.trim() !== '') ? value : fallback
}

/** 归一化单个节点：兼容 v11 node 形状、Go-CQHTTP 形状、以及本仓库自己发出的卡片形状。 */
function normalizeNode(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    const text = collapse(raw)
    if (text === '') return null
    return { name: '未知用户', userId: 0, time: 0, text }
  }
  if (typeof raw !== 'object') return null

  const data = (raw.data && typeof raw.data === 'object') ? raw.data : raw
  const sender = (raw.sender && typeof raw.sender === 'object')
    ? raw.sender
    : ((data.sender && typeof data.sender === 'object') ? data.sender : {})

  // content 与 message 谁在就用谁（v11 用 content，Go-CQHTTP 用 message）
  const content = data.content !== undefined ? data.content
    : (data.message !== undefined ? data.message
      : (raw.content !== undefined ? raw.content : raw.message))

  const nameRaw = data.name ?? data.nickname ?? sender.nickname ?? sender.card ?? sender.name
  const qqRaw = data.uin ?? data.user_id ?? sender.user_id ?? sender.uin
  const timeRaw = data.time ?? sender.time ?? raw.time
  const timeNum = Number(timeRaw)

  const text = segmentsToText(content)
  // 文本为空但字段结构可辨识时仍保留节点（空内容会在排版阶段被跳过），
  // 完全看不出是节点的对象才算坏项。
  const recognizable = content !== undefined || data.name !== undefined || data.nickname !== undefined
    || data.uin !== undefined || data.user_id !== undefined || sender.user_id !== undefined
  if (!recognizable && text === '') return null

  const name = (nameRaw === undefined || nameRaw === null || String(nameRaw).trim() === '')
    ? '未知用户'
    : collapse(nameRaw)
  const userId = Number.isFinite(Number(qqRaw)) ? Number(qqRaw) : 0

  return { name, userId, time: Number.isFinite(timeNum) ? timeNum : 0, text }
}

/** 从任意载荷里挖出节点数组；挖不到返回 null。 */
function nodesArray(data) {
  if (Array.isArray(data)) return data
  if (data === null || typeof data !== 'object') return null
  if (data.dryRun === true) return null
  if (Array.isArray(data.messages)) return data.messages
  if (Array.isArray(data.message)) return data.message
  return null
}

/**
 * 规范化 `get_forward_msg` 的返回载荷。
 * 容错 `{ messages: [...] }` / `{ message: [...] }` / 裸数组 / dry-run 空响应；
 * 坏项计数进 `dropped` 并跳过，绝不抛错。
 * @returns {{ nodes: Array<{ name: string, userId: number, time: number, text: string }>, dropped: number, reason: string }}
 */
export function normalizeForwardNodes(data) {
  const raw = nodesArray(data)
  if (raw === null) return { nodes: [], dropped: 0, reason: '载荷为空或不是转发内容' }

  const nodes = []
  let dropped = 0
  for (const item of raw) {
    const node = normalizeNode(item)
    if (node === null) dropped++
    else nodes.push(node)
  }
  // 数组存在但一条都没解析出来：也给出中文原因，方便上层日志与诊断页直接展示
  const reason = (nodes.length === 0 && dropped > 0) ? '转发内容无法解析' : ''
  return { nodes, dropped, reason }
}

/**
 * 判断载荷是否像一次真正的转发响应。
 * dry-run 响应（{dryRun:true}）、null、字符串、空对象、空数组都算「不是」。
 */
export function isForwardPayload(data) {
  const raw = nodesArray(data)
  return Array.isArray(raw) && raw.length > 0
}

/**
 * 把规范化后的节点排版成给模型看的纯文本。
 * @param {Array} nodes normalizeForwardNodes 的结果
 * @param {{ maxNodes?: number, maxChars?: number, title?: string }} [options]
 * @returns {{ text: string, used: number, total: number, truncated: boolean, chars: number }}
 */
export function formatForwardTranscript(nodes, options) {
  const opts = (options && typeof options === 'object') ? options : {}
  const maxNodes = positiveNumber(opts.maxNodes, 50)
  const maxChars = positiveNumber(opts.maxChars, 4000)
  const title = nonEmptyString(opts.title, '转发聊天记录')

  const list = Array.isArray(nodes) ? nodes : []
  const total = list.length

  // 内容为空的节点不占行（total 仍按传入节点数算）
  const rows = []
  for (const node of list) {
    if (node === null || typeof node !== 'object') continue
    const text = collapse(node.text)
    if (text === '') continue
    const name = (node.name === undefined || node.name === null || String(node.name).trim() === '')
      ? '未知用户'
      : collapse(node.name)
    rows.push(`${name}: ${text}`)
  }

  const nodeTruncated = rows.length > maxNodes
  const shown = nodeTruncated ? rows.slice(0, maxNodes) : rows

  const header = nodeTruncated ? `[${title} 共 ${total} 条，显示前 ${shown.length} 条]` : `[${title} 共 ${total} 条]`
  let body = shown.join('\n')

  let charTruncated = false
  if (body.length > maxChars) {
    body = body.slice(0, maxChars)
    charTruncated = true
  }

  let text = body === '' ? header : `${header}\n${body}`
  if (charTruncated) text += TRUNCATED_MARK

  return {
    text,
    used: shown.length,
    total,
    truncated: nodeTruncated || charTruncated,
    chars: text.length,
  }
}
