/**
 * 设置项变更历史（控制台，2026-11-08 之后的第二件 control-only 功能）。
 *
 * 为什么要有它：控制台能改的东西里，**路径配置**（`qq-control.json`）和**账号/网络配置**
 * （NapCat 的 `webui.json` / `onebot11_<uin>.json`）都是"改完即生效、出错很难回想"的东西。
 * 之前只有账号页里一份 localStorage 的「操作记录」（刷新换台机器就没了，而且只记"点了什么"，
 * 不记"哪个键从什么变成了什么"）。
 *
 * 这里补的是**服务端、可持久、带 old→new 的变更历史**：
 *   · 控制台写设置的几个入口（路径配置 / WebUI 配置 / 网络配置）走同一个包装：
 *     动作前拍一份设置文件快照、动作后再拍一份 → 机械 diff → 追加一行 JSONL；
 *   · 页面只读：按关键词过滤、复制文本，不提供"还原"（还原设置是危险动作，
 *     真要还原请用已有的配置备份功能，它会把原文件先复制成 .bak）。
 *
 * 纯函数：快照由调用方注入，因此 diff/脱敏/截断/过滤的每条分支都能在没有文件系统时断言。
 */

/** 历史文件格式版本（改字段时 +1，读取端按版本兼容）。 */
export const HISTORY_VERSION = 1

/** 单条记录最多保留多少处变更（再多就写 truncated，避免一行 JSONL 失控）。 */
export const MAX_CHANGES = 40

/** 单个值最多留多少字符（路径/URL 足够，日志式的长文本不该进历史）。 */
export const MAX_VALUE_CHARS = 240

/** 键名命中这些词的，值一律写成 ***（token / secret / 各种 key）。 */
export const SECRET_PATTERN = /(token|secret|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|credential|cookie|authorization|sign)/i

/** 记录里允许出现的文件（其余文件即使被写到也不进历史）。 */
export const WATCHED_FILES = [
  { name: 'qq-control.json', pattern: /^qq-control\.json$/ },
  { name: 'webui.json', pattern: /^webui\.json$/ },
  { name: 'onebot11_<uin>.json', pattern: /^onebot11_\d+\.json$/ },
  { name: 'napcat_<uin>.json', pattern: /^napcat_\d+\.json$/ },
]

/** 某个键路径是否属于"密钥类"（按最后一段判断，避免 `tokenTimeout` 之类误伤）。 */
export function isSecretKey(path) {
  const last = String(path ?? '').split('.').pop() ?? ''
  return SECRET_PATTERN.test(last)
}

/** 展示用：超长值截断；密钥类的值永不落盘。 */
export function displayValue(path, value) {
  if (isSecretKey(path)) return '***'
  if (value === undefined) return ''
  if (typeof value === 'string') return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value
  if (value === null) return 'null'
  if (typeof value === 'object') {
    const text = JSON.stringify(value)
    return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text
  }
  return String(value)
}

/**
 * 把一份设置对象压成 `键路径 → 叶子值`。
 * 数组按下标展开（`clients[0].url`），这样"删掉第 2 条 WS 地址"能指名道姓；
 * 层数超过 `maxDepth` 的子树整体当字符串（防止恶意/异常深的结构把历史撑爆）。
 */
export function flattenSettings(value, prefix = '', out = {}, { maxDepth = 8 } = {}, depth = 0) {
  if (depth > maxDepth) {
    out[prefix || '(root)'] = displayValue(prefix, value)
    return out
  }
  if (Array.isArray(value)) {
    // 根上的空数组/空对象不写占位：这样"文件从无到有"时 diff 出来的是 added，而不是一个假的 removed
    if (value.length === 0) { if (prefix !== '') out[prefix] = '[]'; return out }
    value.forEach((item, index) => flattenSettings(item, prefix === '' ? `[${index}]` : `${prefix}[${index}]`, out, { maxDepth }, depth + 1))
    return out
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    if (keys.length === 0) { if (prefix !== '') out[prefix] = '{}'; return out }
    for (const key of keys) flattenSettings(value[key], prefix === '' ? key : `${prefix}.${key}`, out, { maxDepth }, depth + 1)
    return out
  }
  out[prefix || '(root)'] = value
  return out
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 两份设置对象的机械 diff。
 * @returns {{ changes: {key:string, before:any, after:any, kind:string, secret?:boolean}[], truncated: number }}
 */
export function diffSettings(before, after, { maxChanges = MAX_CHANGES } = {}) {
  // 整份设置为 null = 文件当时不存在：当空快照处理，否则会多出一条假的 "(root) 被删除"
  const flattenForDiff = (value) => (value === null || value === undefined ? {} : flattenSettings(value))
  const left = flattenForDiff(before)
  const right = flattenForDiff(after)
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  const all = []
  for (const key of keys) {
    const hadBefore = Object.prototype.hasOwnProperty.call(left, key)
    const hasAfter = Object.prototype.hasOwnProperty.call(right, key)
    const beforeValue = left[key]
    const afterValue = right[key]
    if (hadBefore && hasAfter && sameValue(beforeValue, afterValue)) continue
    const kind = hadBefore ? (hasAfter ? 'changed' : 'removed') : 'added'
    const secret = isSecretKey(key)
    all.push({
      key,
      kind,
      // 密钥类即使值变了也只写 ***：历史文件会被复制/贴给别人，不能当第二份 token 库
      before: displayValue(key, beforeValue),
      after: displayValue(key, afterValue),
      ...(secret ? { secret: true } : {}),
    })
  }
  return { changes: all.slice(0, maxChanges), truncated: Math.max(0, all.length - maxChanges) }
}

/** 一处变更 → 一行中文（`cwd：D:\a → D:\b`）。 */
export function describeChange(change = {}) {
  const key = String(change.key ?? '')
  const before = String(change.before ?? '')
  const after = String(change.after ?? '')
  if (change.kind === 'added') return `${key}：新增 ${after}`
  if (change.kind === 'removed') return `${key}：删除 ${before}`
  return `${key}：${before} → ${after}`
}

/**
 * 用动作前后的两份快照合成一条历史记录；没有变化时返回 null（不写空行）。
 *
 * @param source 人话来源（如「控制台路径配置」）
 * @param route  触发它的接口（如 `/api/config`）
 * @param before `{ at, files: [{ name, file, exists, data }] }`
 * @param after  同上
 */
export function buildHistoryEntry({ at = Date.now(), source = '', route = '', ok = true, reason = '', before = null, after = null } = {}) {
  const filesOf = (snapshot) => new Map((snapshot?.files ?? []).map((file) => [file.name, file]))
  const leftFiles = filesOf(before)
  const rightFiles = filesOf(after)
  const names = [...new Set([...leftFiles.keys(), ...rightFiles.keys()])].sort()
  const changes = []
  let truncated = 0
  for (const name of names) {
    const leftFile = leftFiles.get(name)
    const rightFile = rightFiles.get(name)
    // 文件从"不存在"变成"存在"时按空对象比，diff 会自然写成 added
    const leftData = leftFile?.exists === true ? (leftFile.data ?? null) : null
    const rightData = rightFile?.exists === true ? (rightFile.data ?? null) : null
    if (leftData === null && rightData === null) continue
    const diff = diffSettings(leftData, rightData, { maxChanges: Math.max(1, MAX_CHANGES - changes.length) })
    for (const change of diff.changes) changes.push({ file: name, ...change })
    truncated += diff.truncated
    if (changes.length >= MAX_CHANGES) break
  }
  if (changes.length === 0) return null
  return {
    v: HISTORY_VERSION,
    at,
    source: String(source).slice(0, 80),
    route: String(route).slice(0, 120),
    ok: ok !== false,
    reason: String(reason ?? '').slice(0, 200),
    files: names.filter((name) => (leftFiles.get(name)?.exists === true) || (rightFiles.get(name)?.exists === true)),
    changes: changes.slice(0, MAX_CHANGES),
    ...(truncated > 0 ? { truncated } : {}),
  }
}

/** 关键词过滤（来源 / 路由 / 文件名 / 键名 / 旧值 / 新值都参与，大小写不敏感）。 */
export function filterHistory(entries = [], { q = '', source = '', limit = 100 } = {}) {
  const needle = String(q ?? '').trim().toLowerCase()
  const from = String(source ?? '').trim()
  const matched = (entries ?? []).filter((entry) => {
    if (!entry || typeof entry !== 'object') return false
    if (from !== '' && !String(entry.source ?? '').startsWith(from)) return false
    if (needle === '') return true
    const haystack = [
      entry.source, entry.route, entry.reason,
      ...(entry.changes ?? []).flatMap((change) => [change.file, change.key, change.before, change.after]),
    ].join(' ').toLowerCase()
    return haystack.includes(needle)
  })
  const capped = Math.max(1, Number(limit) || 100)
  return matched.slice(-capped).reverse()
}

/** 逐行解析（容忍坏行：写历史时崩过一半不应该让整页打不开）。 */
export function parseHistory(text = '') {
  const entries = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line)
      if (entry && typeof entry === 'object' && Array.isArray(entry.changes)) entries.push(entry)
    } catch { /* 坏行跳过 */ }
  }
  return entries
}

const stampOf = (ts) => {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 可读文本（页面「复制」/贴 issue 用）。 */
export function formatHistory(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return '（还没有设置变更记录）'
  const lines = [`设置项变更历史（最近 ${entries.length} 条）`]
  for (const entry of entries) {
    const result = entry.ok === false ? `失败：${entry.reason || '原因未记录'}` : '成功'
    lines.push(`${stampOf(entry.at)} · ${entry.source || entry.route || '未知来源'} · ${result}`)
    for (const change of entry.changes ?? []) {
      lines.push(`  ${change.file} · ${describeChange(change)}`)
    }
    if (entry.truncated > 0) lines.push(`  …另有 ${entry.truncated} 处变更未记录`)
  }
  return lines.join('\n')
}
