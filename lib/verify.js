/**
 * Join-request verification (入群/加好友审批): a pending queue with an
 * arithmetic challenge, admin-facing rendering and expiry. Pure logic — the
 * bridge owns all messaging — so it stays unit-testable.
 */

/** Build an arithmetic challenge: { question, answer }. */
export function buildVerifyQuestion(rng = Math.random) {
  const pick = typeof rng === 'function' ? rng : Math.random
  const a = 2 + Math.floor(pick() * 97)
  const b = 2 + Math.floor(pick() * 97)
  return { question: `请回答：${a} + ${b} = ?（用于确认你不是广告号）`, answer: String(a + b) }
}

const FULL_WIDTH = '０１２３４５６７８９'

/** Normalize a user-typed answer: full-width digits/spaces, prefixes and punctuation. */
export function normalizeAnswer(text) {
  return String(text ?? '')
    .replace(/[０-９]/g, (ch) => String(FULL_WIDTH.indexOf(ch)))
    .replace(/[\u3000\s]/g, '')
    .replace(/^(?:(?:答案|回答|结果|是|等于)\s*[:：]?\s*)+/, '')
    .replace(/[。.!！?？,，、]+$/g, '')
    .trim()
}

/** True when the typed text answers the entry's question correctly. */
export function checkVerifyAnswer(entry, text) {
  if (!entry || !entry.answer) return false
  return normalizeAnswer(text) === normalizeAnswer(entry.answer)
}

export class JoinGuard {
  constructor({ timeoutSeconds = 300, maxPending = 20, rng = Math.random, now = () => Date.now() } = {}) {
    this.timeoutMs = Math.max(30, Number(timeoutSeconds) || 300) * 1000
    this.maxPending = Math.max(1, Number(maxPending) || 20)
    this.rng = rng
    this.now = now
    this.seq = 0
    this.entries = new Map()   // id -> entry
  }

  get size() {
    return this.entries.size
  }

  /** 登记一条请求；队列满或参数不合法返回 null。 */
  addRequest({ flag, userId, groupId = 0, subType = 'add', comment = '', name = '', now = this.now() }) {
    if (!flag) return null
    if (this.entries.size >= this.maxPending) return null
    const challenge = buildVerifyQuestion(this.rng)
    const id = ++this.seq
    const entry = {
      id,
      flag: String(flag),
      userId: Number(userId) || 0,
      groupId: Number(groupId) || 0,
      subType: String(subType || 'add'),
      comment: String(comment ?? ''),
      name: String(name ?? ''),
      question: challenge.question,
      answer: challenge.answer,
      createdAt: now,
      expiresAt: now + this.timeoutMs,
    }
    this.entries.set(id, entry)
    return { id, question: entry.question, answer: entry.answer, entry }
  }

  /** 仍在等待的条目（含剩余秒数），按 id 升序。 */
  list(now = this.now()) {
    return [...this.entries.values()]
      .filter((entry) => entry.expiresAt > now)
      .sort((a, b) => a.id - b.id)
      .map((entry) => ({ ...entry, remainingSeconds: Math.max(0, Math.round((entry.expiresAt - now) / 1000)) }))
  }

  find(idOrFlag) {
    if (idOrFlag === undefined || idOrFlag === null || idOrFlag === '') return null
    const asNumber = Number(idOrFlag)
    if (Number.isFinite(asNumber) && this.entries.has(asNumber)) return this.entries.get(asNumber)
    for (const entry of this.entries.values()) if (entry.flag === String(idOrFlag)) return entry
    return null
  }

  /** 处理一条请求（按 id 或 flag）；返回 { ok, error, entry }。 */
  resolve(idOrFlag, approved, { reason = '' } = {}) {
    const entry = this.find(idOrFlag)
    if (!entry) return { ok: false, error: '没有这个待处理请求', entry: null }
    this.entries.delete(entry.id)
    return { ok: true, error: '', approved: Boolean(approved), reason: String(reason ?? ''), entry }
  }

  /** 清理超时条目，返回被清理的数组。 */
  expire(now = this.now()) {
    const expired = []
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        expired.push(entry)
        this.entries.delete(id)
      }
    }
    return expired
  }

  clear() {
    this.entries.clear()
  }
}

/** 解析管理员审批命令：/同意 1、/通过 3、/拒绝 2、/同意 all、/待审。 */
export function parseVerifyCommand(text) {
  const t = String(text ?? '').trim()
  if (t === '') return null
  const list = /^[\/／]?(待审|审核|待处理列表|待处理)$/.exec(t)
  if (list) return { action: 'list', target: '' }
  const m = /^[\/／]?(同意|通过|批准|拒绝|驳回)\s*([0-9]+|all|全部)?$/.exec(t)
  if (!m) return null
  const approve = m[1] === '同意' || m[1] === '通过' || m[1] === '批准'
  const target = m[2] === 'all' || m[2] === '全部' ? 'all' : (m[2] ?? '')
  return { action: approve ? 'approve' : 'reject', target }
}

/** 待处理列表文案（给管理员看）。 */
export function formatPendingList(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '📭 暂无待处理请求。'
  const lines = entries.map((entry) => {
    const where = entry.groupId ? `群 ${entry.groupId}` : '加好友'
    const comment = entry.comment ? `｜留言：${entry.comment.slice(0, 30)}` : ''
    return `· #${entry.id} ${entry.userId} ${where}${comment}｜剩余 ${entry.remainingSeconds}s`
  })
  return `📥 待处理请求（${entries.length}）\n${lines.join('\n')}\n回复「/同意 序号」或「/拒绝 序号」处理。`
}

/** 单条请求的提示文案（推送给管理员）。 */
export function formatJoinPrompt(entry, { groupName = '' } = {}) {
  if (!entry) return ''
  const where = entry.groupId ? `群「${groupName || entry.groupId}」` : '加好友'
  const comment = entry.comment ? `\n验证消息：${entry.comment.slice(0, 60)}` : ''
  return `🔔 新请求 #${entry.id}：${entry.userId} 申请加入${where}${comment}\n验证问题：${entry.question}\n回复「/同意 ${entry.id}」或「/拒绝 ${entry.id}」。`
}
