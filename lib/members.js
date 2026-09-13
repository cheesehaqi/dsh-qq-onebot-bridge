/**
 * 群成员查询的纯逻辑：命令解析 + 中文文案格式化。
 *
 * 这里不碰网络、不碰 OneBot、不做任何 IO：真实数据由 bridge 调
 * get_group_member_list / get_group_member_info 拿到后传进来，
 * 所以整个模块可以脱离 bridge 单测。
 *
 * 注意：OneBot 的 join_time / last_sent_time / shut_up_timestamp 都是**秒**级
 * 时间戳（0 表示"没有"），比较时统一乘 1000 换成毫秒。
 */

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 身份标签：owner→群主、admin→管理员、其它/缺失→成员；自己再加（我）。 */
export function roleLabel(role, isSelf = false) {
  const base = role === 'owner' ? '群主' : role === 'admin' ? '管理员' : '成员'
  return isSelf === true ? `${base}（我）` : base
}

/** 显示名：群名片优先，其次昵称，都没有就退到 QQ 号（不写死任何真实号码）。 */
function displayName(member) {
  const card = String(member?.card ?? '').trim()
  if (card) return card
  const nickname = String(member?.nickname ?? '').trim()
  if (nickname) return nickname
  return `QQ${member?.user_id ?? 0}`
}

/** 等级归一化成数字：level 常是字符串数字，缺失/非数字按 0（排最后）。 */
function levelOf(member) {
  const value = Number.parseInt(String(member?.level ?? '').trim(), 10)
  return Number.isFinite(value) ? value : 0
}

/** 身份排序档位：群主 0、管理员 1、其它 2。 */
function roleRank(role) {
  return role === 'owner' ? 0 : role === 'admin' ? 1 : 2
}

/** 判断某个 QQ 号是不是"我"：selfId 为 0 或成员号非法时一律不算。 */
function isSelfId(userId, selfId) {
  const mine = Number(userId)
  const self = Number(selfId)
  return Number.isFinite(mine) && mine > 0 && mine === self
}

/** 秒级时间戳 → 本地 `YYYY-MM-DD HH:mm`；0/缺失/非法 → 未知。 */
function formatTime(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return '未知'
  const date = new Date(value * 1000)
  if (Number.isNaN(date.getTime())) return '未知'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** limit 防御性取值：非有限数或 < 1 时回落到 20（挡住 0/NaN/'abc'/undefined）。 */
function normalizeLimit(limit) {
  const value = Number(limit)
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 20
}

/**
 * 群成员列表文案。
 * 排序：群主 → 管理员 → 其它；同档按 level 数值降序，再按显示名本地化升序。
 * 每行：`1. 群主 显示名(123456)「头衔」[禁言中]`（后两段按需追加）。
 * members 非数组时按空列表处理（同样只给 `群成员 共 0 人`）。
 * now 只用于判定"禁言中"，留出来是为了单测能固定时间。
 */
export function formatMemberList(members, { limit = 20, selfId = 0, groupName = '', now = Date.now() } = {}) {
  const rows = Array.isArray(members) ? members : []
  const cap = normalizeLimit(limit)
  const title = String(groupName ?? '').trim()
  const head = title ? [`【${title}】`] : []
  const total = rows.length
  if (total === 0) {
    return { text: [...head, '群成员 共 0 人'].join('\n'), shown: 0, total: 0, truncated: false }
  }

  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const sorted = [...rows].sort((a, b) => {
    const rank = roleRank(a?.role) - roleRank(b?.role)
    if (rank !== 0) return rank
    const level = levelOf(b) - levelOf(a)
    if (level !== 0) return level
    return displayName(a).localeCompare(displayName(b))
  })

  const shownRows = sorted.slice(0, cap)
  const shown = shownRows.length
  const truncated = total > shown
  const header = truncated ? `群成员 共 ${total} 人（显示前 ${shown} 人）` : `群成员 共 ${total} 人`
  const lines = shownRows.map((member, index) => {
    const role = roleLabel(member?.role, isSelfId(member?.user_id, selfId))
    let line = `${index + 1}. ${role} ${displayName(member)}(${member?.user_id ?? 0})`
    const honor = String(member?.title ?? '').trim()
    if (honor) line += `「${honor}」`
    const until = Number(member?.shut_up_timestamp)
    if (Number.isFinite(until) && until * 1000 > nowMs) line += '[禁言中]'
    return line
  })
  return { text: [...head, header, ...lines].join('\n'), shown, total, truncated }
}

/**
 * 单个成员详情文案（多行）：显示名 / QQ 号 / 身份 / 等级 / 头衔 / 入群时间 /
 * 最后发言 / 禁言状态。空对象或 null 给一句兜底提示。
 */
export function formatMemberInfo(info, { selfId = 0, now = Date.now() } = {}) {
  if (!info || typeof info !== 'object' || Array.isArray(info) || Object.keys(info).length === 0) {
    return '没有查到该成员的信息。'
  }
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const level = String(info.level ?? '').trim()
  const honor = String(info.title ?? '').trim()
  const until = Number(info.shut_up_timestamp)
  const muted = Number.isFinite(until) && until > 0 && until * 1000 > nowMs
  return [
    `显示名：${displayName(info)}`,
    `QQ 号：${info.user_id ?? 0}`,
    `身份：${roleLabel(info.role, isSelfId(info.user_id, selfId))}`,
    `等级：${level || '未知'}`,
    `头衔：${honor || '无'}`,
    `入群时间：${formatTime(info.join_time)}`,
    `最后发言：${formatTime(info.last_sent_time)}`,
    `禁言状态：${muted ? `禁言至 ${formatTime(info.shut_up_timestamp)}` : '未被禁言'}`,
  ].join('\n')
}

/** 从 ats 里挑第一个像 QQ 号的（正整数）；挑不到返回 null。 */
function pickAtId(ats) {
  if (!Array.isArray(ats)) return null
  for (const candidate of ats) {
    const id = Number(candidate)
    if (Number.isInteger(id) && id > 0) return id
  }
  return null
}

/**
 * 判断这条消息是不是成员查询命令，返回 null / { kind: 'list' } /
 * { kind: 'info', userId } / { kind: 'info', name }。
 *
 * 匹配规则（整条消息必须**以 `/成员` 开头**，正文里出现 `/成员` 不算）：
 * 1. `/成员`、`/成员列表`、`/成员 列表`（含前后空白）→ 列表；只有整段恰好是
 *    「列表」才算列表命令，`/成员列表x` 不是；
 * 2. 紧贴写法一律当"要查的目标"处理：`/成员foo` → name='foo'、`/成员列表x`
 *    → name='列表x'、`/成员数` → name='数'（宁可当昵称去查，也不吃掉整条命令）；
 * 3. 这条消息里 @ 了人（ats 有合法 QQ 号）时 @ 优先，无视后面写的文字；
 * 4. `/成员 123456`（纯数字）→ 按 QQ 号查；其它文字 → 去掉开头 @ 后当昵称/群名片，
 *    由调用方去成员列表里匹配；
 * 5. 前缀后面没有可查目标（裸 `/成员`、`/成员@`）→ 回落到列表。
 */
export function parseMemberQuery(text, ats = []) {
  const t = String(text ?? '').trim()
  if (!t.startsWith('/成员')) return null
  const rest = t.slice('/成员'.length).trim()
  if (rest === '列表') return { kind: 'list' }
  const atId = pickAtId(ats)
  if (atId !== null) return { kind: 'info', userId: atId }
  if (rest === '') return { kind: 'list' }
  if (/^\d+$/.test(rest)) return { kind: 'info', userId: Number(rest) }
  const name = rest.replace(/^[@＠]+/, '').trim()
  if (!name) return { kind: 'list' }
  return { kind: 'info', name }
}
