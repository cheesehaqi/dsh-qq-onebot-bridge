/**
 * 诊断包脱敏（分享安全）。
 *
 * 诊断包里天然含有隐私：`qq-trace.jsonl` 有会话键（`g:<群号>` / `u:<QQ 号>`）和入站
 * 消息原文，`qq-inbox.jsonl` 更是整条消息记录，宿主/调试日志里也可能夹着号码。
 * 「导出诊断包」这个功能的使用场景就是**发给别人看**，所以必须提供一条脱敏通路。
 *
 * 三档处理（纯函数，可测）：
 *   - 数字：≥ 6 位的整数（QQ 号）保留前两位、其余补 0，长度不变（便于判断是不是同一个实体）
 *   - 字符串：把其中 6 位以上的数字串同样掩码（会话键 `g:100000001` → `g:10*******`）
 *   - 文本字段（`text`）：整段替换为「[已脱敏 N 字]」，只留长度，不留内容
 */
export const REDACTED_TEXT = (length) => `[已脱敏 ${length} 字]`

/**
 * 数值字段白名单：这些是**时间戳/度量**，掩码它们会把时间线毁掉（审计发现脱敏后所有 ts 都变成
 * 1700000000000，排查价值归零），所以按字段名跳过。
 */
const NUMERIC_KEEP = new Set([
  'ts', 'at', 'ms', 'bytes', 'size', 'updatedAt', 'startedAt', 'lastAt', 'lastTurnAt', 'dueAt',
  'intervalMs', 'uptimeSeconds', 'consumed', 'queued', 'count', 'total', 'limit', 'v',
])

/** 会把原文带出去的字段名（值整体替换为长度占位）。 */
const TEXT_KEYS = new Set(['text', 'content', 'message', 'reason', 'detail', 'comment', 'line', 'senderName', 'name', 'title', 'question'])

/** 掩码一个数字串：保留前两位，其余按位替换（长度不变）。半角/全角数字都处理。 */
export function maskDigits(value) {
  return String(value).replace(/[\d０-９]{6,}/g, (digits) => `${digits.slice(0, 2)}${'*'.repeat(digits.length - 2)}`)
}

/** 数字型 QQ 号：保留前两位、其余补 0（`100000001` → `100000000`）。 */
export function maskNumber(value) {
  const text = String(value)
  return text.length >= 6 ? Number(`${text.slice(0, 2)}${'0'.repeat(text.length - 2)}`) : value
}

/** 递归脱敏一个结构（对象/数组/字符串/数字/键名）。 */
export function redactObject(value) {
  if (Array.isArray(value)) return value.map((item) => redactObject(item))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const safeKey = maskDigits(key)   // 键名本身也可能是 QQ 号（如积分/统计里以号做键）
      if (typeof item === 'string' && TEXT_KEYS.has(key)) { out[safeKey] = REDACTED_TEXT(item.length); continue }
      if (NUMERIC_KEEP.has(key)) { out[safeKey] = item; continue }
      out[safeKey] = redactObject(item)
    }
    return out
  }
  if (typeof value === 'number') return maskNumber(value)
  if (typeof value === 'string') return maskDigits(value)
  return value
}

/** 脱敏一行 JSONL（解析失败的行退化为纯文本掩码）。 */
export function redactJsonLine(line) {
  const trimmed = String(line).trim()
  if (!trimmed) return line
  try {
    return JSON.stringify(redactObject(JSON.parse(trimmed)))
  } catch {
    return maskDigits(line)
  }
}

/** 脱敏整份 JSONL 文本（逐行）。 */
export function redactJsonl(text) {
  return String(text).split(/\r?\n/).map((line) => redactJsonLine(line)).join('\n')
}

/**
 * 按文件类型选择脱敏方式：
 *   - `.jsonl`：逐行按结构脱敏（事件/录制文件）
 *   - `.json`：整体按结构脱敏（运行快照/体检报告）
 *   - 其它（调试/宿主日志）：掩码数字 **并且**把每行冒号后面的正文替换成长度占位——
 *     桥的调试日志里就写着入站消息原文（审计发现原来是原样打包出去的）。
 */
export function redactByKind(name, text) {
  if (/\.jsonl$/i.test(name)) return redactJsonl(text)
  if (/\.json$/i.test(name)) {
    try { return `${JSON.stringify(redactObject(JSON.parse(text)), null, 2)}\n` } catch { return redactLog(text) }
  }
  return redactLog(text)
}

/** 日志脱敏：数字掩码 + 冒号后的正文替换为长度占位（保留时间戳/阶段，去掉内容）。 */
export function redactLog(text) {
  return String(text).split(/\r?\n/).map((line) => {
    const masked = maskDigits(line)
    const cut = masked.indexOf(': ')
    if (cut < 0 || masked.length - cut - 2 < 8) return masked
    const head = masked.slice(0, cut + 2)
    const tail = masked.slice(cut + 2)
    return `${head}${REDACTED_TEXT(tail.length)}`
  }).join('\n')
}

/** 一次脱敏的统计（放进入包清单，让拿到包的人知道被处理过）。 */
export function redactionNote() {
  return {
    redacted: true,
    policy: 'QQ 号按位掩码（保留前两位，含全角数字与键名）；text/content/reason 等字段整体替换为长度；日志行冒号后的正文替换为长度；时间戳与计数类字段保持不变以保留时间线',
    generatedAt: new Date().toISOString(),
  }
}
