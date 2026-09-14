/**
 * 回放 diff（v0.5.5 阶段 4）：把两次离线回放的结果并排对比。
 *
 * 用途非常具体：控制台的离线回放支持"覆盖任意插件配置键"（试配置）。
 * 那么"把 keywordEnabled 打开会怎样""把白名单收窄之后哪些消息会被丢"
 * 这类问题，答案不该靠人肉读两屏结果——这里把两次回放的结果机械地比出差异：
 *   · 决策变了（会回复 ↔ 静默）
 *   · 静默原因变了
 *   · 回复文本变了（给出相似度，避免因为模型措辞不同就误判成"行为变了"）
 *
 * 输入形状与 `api.replay()` 的返回保持一致（`{ results: [ { index, entry, decision, reason, reply, ... } ] }`），
 * 但这里对缺字段一律宽容处理：拿不到的项标成"未知"，绝不编造。
 */

/** 把回放结果归一化成"按序号索引"的查找表。 */
function indexResults(payload) {
  const map = new Map()
  const results = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload) ? payload : []
  results.forEach((item, position) => {
    if (!item || typeof item !== 'object') return
    const key = item.index !== undefined && item.index !== null ? String(item.index) : `#${position}`
    map.set(key, item)
  })
  return map
}

/** 一条回放结果的三个可比较字段。 */
function normalizeSide(item) {
  if (!item || typeof item !== 'object') return { known: false, replied: null, reason: '', reply: '' }
  const reply = String(item.reply ?? item.replyText ?? item.text ?? '')
  // decision 字段在不同版本里叫法不同：先认显式字段，再回落到"有没有回复文本"。
  const explicit = item.decision ?? item.wouldReply ?? item.replied
  const replied = typeof explicit === 'boolean' ? explicit : (item.reply !== undefined || item.replyText !== undefined ? reply !== '' : null)
  return {
    known: true,
    replied,
    reason: String(item.reason ?? item.silentReason ?? '').trim(),
    reply,
  }
}

/** 文本相似度（按字符 bigram 的 Dice 系数，0..1）：只用来判断"措辞变了"还是"完全换了"。 */
export function textSimilarity(a, b) {
  const left = String(a ?? '')
  const right = String(b ?? '')
  if (left === right) return 1
  if (left === '' || right === '') return 0
  const grams = (text) => {
    const set = new Map()
    for (let i = 0; i < text.length - 1; i++) {
      const gram = text.slice(i, i + 2)
      set.set(gram, (set.get(gram) ?? 0) + 1)
    }
    return set
  }
  const a1 = grams(left)
  const b1 = grams(right)
  let overlap = 0
  let total = 0
  for (const [gram, count] of a1) {
    total += count
    const other = b1.get(gram)
    if (other !== undefined) overlap += Math.min(count, other)
  }
  for (const count of b1.values()) total += count
  return total === 0 ? 1 : (2 * overlap) / total
}

/**
 * 对比两次回放。
 * 返回 `{ total, changed, unchanged, rows, summary }`：
 * `rows` 里每条都带 `changed`、`changeKind`（decision/reason/reply/identical/unknown）与相似度。
 */
export function diffReplays(baseline, variant, { limit = 200 } = {}) {
  const left = indexResults(baseline)
  const right = indexResults(variant)
  const keys = [...new Set([...left.keys(), ...right.keys()])]
  const rows = []
  for (const key of keys.slice(0, Math.max(1, Math.trunc(Number(limit) || 200)))) {
    const a = normalizeSide(left.get(key))
    const b = normalizeSide(right.get(key))
    const entry = left.get(key)?.entry ?? right.get(key)?.entry ?? null
    const text = String(entry?.text ?? entry?.frame?.text ?? '')
    let changeKind = 'identical'
    if (!a.known || !b.known) changeKind = 'unknown'
    else if (a.replied !== b.replied) changeKind = 'decision'
    else if (a.reason !== b.reason) changeKind = 'reason'
    else if (a.reply !== b.reply) changeKind = 'reply'
    rows.push({
      index: key,
      chatKey: String(entry?.chatKey ?? entry?.frame?.chatKey ?? ''),
      text: text.length > 60 ? `${text.slice(0, 60)}…` : text,
      changeKind,
      changed: changeKind !== 'identical' && changeKind !== 'unknown',
      baseline: { replied: a.replied, reason: a.reason, reply: a.reply.slice(0, 120) },
      variant: { replied: b.replied, reason: b.reason, reply: b.reply.slice(0, 120) },
      similarity: changeKind === 'reply' ? Number(textSimilarity(a.reply, b.reply).toFixed(3)) : (a.reply === b.reply ? 1 : 0),
    })
  }
  const changed = rows.filter((row) => row.changed)
  const byKind = changed.reduce((acc, row) => {
    acc[row.changeKind] = (acc[row.changeKind] ?? 0) + 1
    return acc
  }, {})
  const summary = rows.length === 0
    ? '两次回放都没有可对比的结果（先跑一次回放，或用同一批消息重跑）'
    : changed.length === 0
      ? `两条配置下行为一致：${rows.length} 条消息的决策、原因与回复都相同`
      : `有 ${changed.length}/${rows.length} 条不一样：`
        + [byKind.decision ? `决策变了 ${byKind.decision} 条` : '', byKind.reason ? `原因变了 ${byKind.reason} 条` : '', byKind.reply ? `回复文本变了 ${byKind.reply} 条` : '']
          .filter(Boolean).join('，')
  return { total: rows.length, changed: changed.length, unchanged: rows.length - changed.length, byKind, rows, summary }
}
