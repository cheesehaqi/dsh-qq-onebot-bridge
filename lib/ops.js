/**
 * 群运营工具箱（ops）：原生签到 / 群待办 / @全体余量 / 禁言名单 / 批量踢 /
 * 群资料 / 入群与发言策略 / 文件整理 / 相册上传 / 群运营周报。
 *
 * ── 真机探针结论（2026-09-14，静态读 `NapCat/bootmain/napcat.mjs`，QQ 9.9.32-50969）──
 * 本模块所有 action 名与参数形状都来自那次探针，逐条如下（→ 右边是探针给出的 schema）：
 *   - `set_group_sign` / `send_group_sign`（群打卡）        → { group_id }
 *   - `get_group_at_all_remain`（@全体余量）                → { group_id } → { can_at_all, remain_at_all_count_for_group, remain_at_all_count_for_uin }
 *   - `get_group_shut_list`（禁言名单）                     → { group_id } → [{ user_id, nickname, shut_up_time }]
 *   - `set_group_kick_members`（**原生批量踢**）             → { group_id, user_id: string[], reject_add_request? }
 *   - `set_group_todo` / `complete_group_todo` / `cancel_group_todo`（群待办）
 *                                                          → { group_id, message_id? , message_seq? }
 *   - `move_group_file` / `rename_group_file`（文件整理）     → { group_id, file_id, current_parent_directory, target_parent_directory | new_name }
 *   - `trans_group_file` / `delete_group_file`              → { group_id, file_id }
 *   - `create_group_file_folder`                            → { group_id, folder_name | name }
 *   - `upload_image_to_qun_album`（相册上传）                → { group_id, album_id, album_name, file }
 *   - `get_qun_album_list` / `get_group_album_media_list`   → { group_id, attach_info? } / { group_id, album_id, attach_info? }
 *   - `get_group_info_ex` / `get_group_detail_info`（群资料） → { group_id }
 *   - `set_group_name` / `set_group_remark` / `set_group_portrait` → { group_id, group_name | remark | file }
 *   - `set_group_member_permissions`（发言/功能策略，**局部更新**：没传的项保持不变）
 *                                                          → { group_id, allow_member_upload_album?, allow_member_temporary_session?, allow_member_create_group? }
 *   - `set_group_new_member_history_visibility`             → { group_id, visible }
 *   - `get_group_ignored_notifies`（被忽略的入群申请/邀请）  → {} → { invited_requests, join_requests }
 *
 * ── 本模块的边界 ──
 * 与 engage.js 一样：**只做纯计算**，绝不自己发 QQ。`plan*` 返回
 * `{ ok, action, params, reason }`，由 bridge 走 ActionGate、注入拦截、限流与 trace；
 * 统计与周报只碰注入进来的本地数据。所有依赖可注入，完全脱离 bridge/网络/真实时钟可测。
 */

/** 群打卡（原生签到）的 action 名：两个名字 NapCat 都支持，用 set_ 这个。 */
export const SIGN_ACTION = 'set_group_sign'

/** 群待办的三种操作 → action 名。 */
export const TODO_ACTIONS = Object.freeze({
  set: 'set_group_todo',
  complete: 'complete_group_todo',
  cancel: 'cancel_group_todo',
})

/** 文件整理的操作 → action 名。 */
export const FILE_ACTIONS = Object.freeze({
  move: 'move_group_file',
  rename: 'rename_group_file',
  trans: 'trans_group_file',
  remove: 'delete_group_file',
  mkdir: 'create_group_file_folder',
})

/** 群资料可改的项 → action 名。 */
export const PROFILE_ACTIONS = Object.freeze({
  name: 'set_group_name',
  remark: 'set_group_remark',
  portrait: 'set_group_portrait',
})

/** 单次批量踢的人数上限（QQ 服务端对一次请求的容忍度有限，宁可分多次也不发超大批量）。 */
export const MAX_KICK_BATCH = 20

/** 周报里统计的运营事件种类（key → 中文名）。 */
export const OPS_EVENT_NAMES = Object.freeze({
  sign: '群打卡',
  join: '入群',
  leave: '退群',
  kick: '踢出',
  mute: '禁言',
  unmute: '解除禁言',
  notice: '群公告',
  todo: '群待办',
  fileOp: '文件整理',
  albumUpload: '相册上传',
  reaction: '表情回应',
  message: '消息',
})

/** 一周的毫秒数（周报默认窗口）。 */
const WEEK_MS = 7 * 86_400_000

/** 目标 QQ 是否合法（与 bridge 里的仓库约定一致：5–11 位数字）。 */
export function isValidQq(value) {
  const raw = String(value ?? '').trim()
  return /^\d{5,11}$/.test(raw) && Number(raw) > 0
}

/**
 * 群号是否合法：4–12 位数字——与 bridge 里 `#routeFromChatKey` 的会话键约定
 * （`/^([gu]):(\d{4,12})$/`）保持一致，避免同一套代码里出现两个群号口径。
 */
export function isValidGroupId(value) {
  const raw = String(value ?? '').trim()
  return /^\d{4,12}$/.test(raw)
}

/**
 * 把一串目标归一化成去重后的 QQ 列表。
 * 接受数组、空白/逗号分隔的字符串；非法的**不静默丢掉**——返回 invalid 让调用方说明。
 */
export function normalizeTargets(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\s,，、]+/)
  const valid = []
  const invalid = []
  for (const item of raw) {
    const value = String(item ?? '').trim()
    if (value === '') continue
    if (isValidQq(value)) {
      if (!valid.includes(value)) valid.push(value)
    } else if (!invalid.includes(value)) {
      invalid.push(value)
    }
  }
  return { valid, invalid }
}

/** 规划一次群打卡（原生签到）。 */
export function planGroupSign({ groupId } = {}) {
  if (!isValidGroupId(groupId)) return { ok: false, action: '', params: null, reason: `群号不合法：${String(groupId ?? '')}` }
  return { ok: true, action: SIGN_ACTION, params: { group_id: String(groupId) }, reason: '' }
}

/**
 * 规划一次批量踢人（原生 `set_group_kick_members`，一次请求多个 QQ）。
 * 超过上限时**不自动截断**，而是返回 exceeded 让调用方决定分批——静默少踢几个是最坏的失败方式。
 */
export function planKickMembers({ groupId, userIds, rejectAddRequest = false, max = MAX_KICK_BATCH } = {}) {
  if (!isValidGroupId(groupId)) return { ok: false, action: '', params: null, reason: `群号不合法：${String(groupId ?? '')}` }
  const { valid, invalid } = normalizeTargets(userIds)
  if (valid.length === 0) {
    return { ok: false, action: '', params: null, reason: invalid.length > 0 ? `没有合法 QQ 号：${invalid.join('、')}` : '没有给出要踢的 QQ 号' }
  }
  const limit = Math.max(1, Math.trunc(Number(max) || MAX_KICK_BATCH))
  if (valid.length > limit) {
    return {
      ok: false, action: '', params: null, exceeded: true, valid,
      reason: `一次最多踢 ${limit} 人，你给了 ${valid.length} 人（会分批执行，不是少踢）`,
    }
  }
  return {
    ok: true,
    action: 'set_group_kick_members',
    params: { group_id: String(groupId), user_id: valid, reject_add_request: rejectAddRequest === true },
    reason: '',
    invalid,
  }
}

/** 按上限把目标切成多批（调用方逐批走闸门；永不丢弃目标）。 */
export function batchTargets(userIds, max = MAX_KICK_BATCH) {
  const { valid } = normalizeTargets(userIds)
  const limit = Math.max(1, Math.trunc(Number(max) || MAX_KICK_BATCH))
  const batches = []
  for (let i = 0; i < valid.length; i += limit) batches.push(valid.slice(i, i + limit))
  return batches
}

/**
 * 规划一次群待办操作（设置/完成/取消）。
 * 探针给出的入参是 `{ group_id, message_id?, message_seq? }`——两者给一个即可。
 */
export function planTodo({ groupId, kind = 'set', messageId = '', messageSeq = '' } = {}) {
  const action = TODO_ACTIONS[kind]
  if (!action) return { ok: false, action: '', params: null, reason: `未知的群待办操作：${String(kind)}` }
  if (!isValidGroupId(groupId)) return { ok: false, action: '', params: null, reason: `群号不合法：${String(groupId ?? '')}` }
  const id = String(messageId ?? '').trim()
  const seq = String(messageSeq ?? '').trim()
  if (id === '' && seq === '') return { ok: false, action: '', params: null, reason: '群待办需要消息 ID 或消息序号（引用一条消息再发命令）' }
  const params = { group_id: String(groupId) }
  if (seq !== '') params.message_seq = seq
  if (id !== '') params.message_id = id
  return { ok: true, action, params, reason: '' }
}

/**
 * 规划一次文件整理。
 * `move` 需要目标目录，`rename` 需要新名字，`mkdir` 需要文件夹名——缺什么就报什么。
 */
export function planFileOp({ groupId, kind, fileId = '', currentParent = '', targetParent = '', newName = '', folderName = '' } = {}) {
  const action = FILE_ACTIONS[kind]
  if (!action) return { ok: false, action: '', params: null, reason: `未知的文件操作：${String(kind)}` }
  if (!isValidGroupId(groupId)) return { ok: false, action: '', params: null, reason: `群号不合法：${String(groupId ?? '')}` }
  const id = String(fileId ?? '').trim()
  const base = { group_id: String(groupId) }
  if (kind === 'mkdir') {
    const name = String(folderName ?? '').trim()
    if (name === '') return { ok: false, action: '', params: null, reason: '新建文件夹需要名字' }
    if (name.length > 60) return { ok: false, action: '', params: null, reason: '文件夹名太长（上限 60 字）' }
    return { ok: true, action, params: { ...base, folder_name: name }, reason: '' }
  }
  if (id === '') return { ok: false, action: '', params: null, reason: `${kind === 'move' ? '移动' : kind === 'rename' ? '重命名' : kind === 'trans' ? '转发' : '删除'}文件需要文件 ID（先 /文件 看列表）` }
  if (kind === 'move') {
    const target = String(targetParent ?? '').trim()
    if (target === '') return { ok: false, action: '', params: null, reason: '移动文件需要目标目录 ID（用「/文件 文件夹名」看目录 ID）' }
    return { ok: true, action, params: { ...base, file_id: id, current_parent_directory: String(currentParent ?? ''), target_parent_directory: target }, reason: '' }
  }
  if (kind === 'rename') {
    const name = String(newName ?? '').trim()
    if (name === '') return { ok: false, action: '', params: null, reason: '重命名需要新文件名' }
    if (name.length > 120) return { ok: false, action: '', params: null, reason: '新文件名太长（上限 120 字）' }
    return { ok: true, action, params: { ...base, file_id: id, current_parent_directory: String(currentParent ?? ''), new_name: name }, reason: '' }
  }
  return { ok: true, action, params: { ...base, file_id: id }, reason: '' }
}

/** 规划一次相册上传（探针确认 action 名是 `upload_image_to_qun_album`）。 */
export function planAlbumUpload({ groupId, albumId = '', albumName = '', file = '' } = {}) {
  if (!isValidGroupId(groupId)) return { ok: false, action: '', params: null, reason: `群号不合法：${String(groupId ?? '')}` }
  const id = String(albumId ?? '').trim()
  if (id === '') return { ok: false, action: '', params: null, reason: '上传相册需要相册 ID（先 /相册 看列表）' }
  const path = String(file ?? '').trim()
  if (path === '') return { ok: false, action: '', params: null, reason: '上传相册需要图片（引用一张图片发命令，或给出本地路径）' }
  return { ok: true, action: 'upload_image_to_qun_album', params: { group_id: String(groupId), album_id: id, album_name: String(albumName ?? ''), file: path }, reason: '' }
}

/** 规划一次群资料修改（群名 / 备注 / 头像）。 */
export function planProfileChange({ groupId, kind = 'name', value = '' } = {}) {
  const action = PROFILE_ACTIONS[kind]
  if (!action) return { ok: false, action: '', params: null, reason: `未知的群资料项：${String(kind)}` }
  if (!isValidGroupId(groupId)) return { ok: false, action: '', params: null, reason: `群号不合法：${String(groupId ?? '')}` }
  const text = String(value ?? '').trim()
  if (text === '') return { ok: false, action: '', params: null, reason: `${kind === 'name' ? '群名' : kind === 'remark' ? '群备注' : '群头像'}不能为空` }
  if (kind === 'name') {
    if (text.length > 30) return { ok: false, action: '', params: null, reason: '群名太长（上限 30 字）' }
    return { ok: true, action, params: { group_id: String(groupId), group_name: text }, reason: '' }
  }
  if (kind === 'remark') {
    if (text.length > 60) return { ok: false, action: '', params: null, reason: '群备注太长（上限 60 字）' }
    return { ok: true, action, params: { group_id: String(groupId), remark: text }, reason: '' }
  }
  if (text.length > 200) return { ok: false, action: '', params: null, reason: '头像只能是图片路径/名称，太长了' }
  return { ok: true, action, params: { group_id: String(groupId), file: text }, reason: '' }
}

/**
 * 规划一次群成员功能权限修改。
 * 探针明确写了「未传入的项目保持不变」，所以这里只放**显式给出**的项——
 * 把没提到的项塞成 false 会静默关掉用户没打算关的权限。
 */
export function planMemberPermissions({ groupId, uploadAlbum, temporarySession, createGroup } = {}) {
  if (!isValidGroupId(groupId)) return { ok: false, action: '', params: null, reason: `群号不合法：${String(groupId ?? '')}` }
  const params = { group_id: String(groupId) }
  let touched = 0
  for (const [key, value] of [['allow_member_upload_album', uploadAlbum], ['allow_member_temporary_session', temporarySession], ['allow_member_create_group', createGroup]]) {
    if (value === undefined || value === null) continue
    params[key] = value === true || value === 'true' || value === 'on' || value === '开'
    touched++
  }
  if (touched === 0) return { ok: false, action: '', params: null, reason: '至少要给一个要改的权限（相册上传 / 临时会话 / 发起新群聊）' }
  return { ok: true, action: 'set_group_member_permissions', params, reason: '' }
}

/** 规划一次「新成员历史消息可见性」修改。 */
export function planHistoryVisibility({ groupId, visible } = {}) {
  if (!isValidGroupId(groupId)) return { ok: false, action: '', params: null, reason: `群号不合法：${String(groupId ?? '')}` }
  if (visible === undefined || visible === null) return { ok: false, action: '', params: null, reason: '可见性需要明确的开或关' }
  const on = visible === true || visible === 'true' || visible === 'on' || visible === '开'
  return { ok: true, action: 'set_group_new_member_history_visibility', params: { group_id: String(groupId), visible: on }, reason: '' }
}

/** 解析「开/关」这类开关词（不认的词返回 null，让调用方提示用法）。 */
export function parseToggle(word) {
  const raw = String(word ?? '').trim().toLowerCase()
  if (['on', 'true', '1', '开', '开启', '允许'].includes(raw)) return true
  if (['off', 'false', '0', '关', '关闭', '禁止'].includes(raw)) return false
  return null
}

/** 时间戳（秒或毫秒）→ 「还剩 1 小时 20 分」；已过期返回「已解除」。 */
export function formatShutRemain(until, now = Date.now()) {
  const value = Number(until)
  if (!Number.isFinite(value) || value <= 0) return '已解除'
  const ms = value > 1e12 ? value : value * 1000
  const left = ms - now
  if (left <= 0) return '已解除'
  const minutes = Math.round(left / 60000)
  if (minutes < 60) return `还剩 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `还剩 ${hours} 小时` : `还剩 ${hours} 小时 ${rest} 分`
}

/** 渲染 `/全体余量`。 */
export function formatAtAllRemain(result, { groupId = '' } = {}) {
  if (!result || typeof result !== 'object') return `群 ${groupId} 的 @全体余量查询没有返回数据`
  const can = result.can_at_all === true
  const group = Number(result.remain_at_all_count_for_group)
  const self = Number(result.remain_at_all_count_for_uin)
  const lines = [`📣 群 ${groupId} 的 @全体：${can ? '当前可用' : '当前不可用'}`]
  lines.push(`· 本群剩余：${Number.isFinite(group) ? group : '未知'} 次`)
  lines.push(`· 我（机器人）剩余：${Number.isFinite(self) ? self : '未知'} 次`)
  if (!can) lines.push('· 不可用时通常是当天次数用完，或群设置里关掉了 @全体')
  return lines.join('\n')
}

/** 渲染 `/禁言名单`。 */
export function formatShutList(list, { groupId = '', now = Date.now(), limit = 30 } = {}) {
  if (!Array.isArray(list) || list.length === 0) return `群 ${groupId} 当前没有被禁言的成员 ✅`
  const active = list.filter((item) => formatShutRemain(item?.shut_up_time, now) !== '已解除')
  const rows = (active.length > 0 ? active : list).slice(0, Math.max(1, Math.trunc(Number(limit) || 30)))
  const lines = [`🔇 群 ${groupId} 禁言名单（${active.length > 0 ? active.length : list.length} 人${active.length > 0 && active.length !== list.length ? `，其中 ${list.length - active.length} 人已到期` : ''}）`]
  for (const item of rows) {
    const userId = String(item?.user_id ?? item?.userId ?? '')
    const name = String(item?.nickname ?? item?.nick_name ?? '').trim()
    lines.push(`· ${userId}${name === '' ? '' : `（${name}）`}：${formatShutRemain(item?.shut_up_time, now)}`)
  }
  if ((active.length > 0 ? active.length : list.length) > rows.length) lines.push(`…还有 ${(active.length > 0 ? active.length : list.length) - rows.length} 人`)
  return lines.join('\n')
}

/** 渲染群详细资料（`get_group_info_ex` 的返回值形状比较自由，能取到多少说多少）。 */
export function formatGroupInfoEx(info, { groupId = '' } = {}) {
  if (!info || typeof info !== 'object') return `群 ${groupId} 没有查到详细资料`
  const pick = (...keys) => {
    for (const key of keys) {
      const value = info[key]
      if (value !== undefined && value !== null && String(value) !== '') return value
    }
    return ''
  }
  const lines = [`🏷 群 ${groupId} 的详细资料`]
  const rows = [
    ['群名', pick('groupName', 'group_name', 'name')],
    ['群号', pick('groupCode', 'group_code', 'group_id') || groupId],
    ['人数', pick('memberCount', 'member_num', 'memberNum', 'maxMemberCount')],
    ['上限', pick('maxMemberCount', 'max_member_count')],
    ['群主', pick('ownerUid', 'owner', 'ownerUin')],
    ['创建时间', pick('createTime', 'create_time')],
    ['描述', pick('groupMemo', 'memo', 'description', 'groupDesc')],
    ['问题', pick('groupQuestion', 'question')],
  ]
  let shown = 0
  for (const [label, value] of rows) {
    if (value === '' || value === undefined) continue
    let text = String(value)
    if (label === '创建时间' && /^\d+$/.test(text)) {
      const ms = Number(text) > 1e12 ? Number(text) : Number(text) * 1000
      text = new Date(ms).toLocaleString('zh-CN', { hour12: false })
    }
    lines.push(`· ${label}：${text.length > 80 ? `${text.slice(0, 80)}…` : text}`)
    shown++
  }
  if (shown === 0) lines.push('· （接口返回里没有可识别的字段）')
  return lines.join('\n')
}

/** 渲染被忽略的入群申请/邀请（`get_group_ignored_notifies`）。 */
export function formatIgnoredNotifies(result, { limit = 10 } = {}) {
  const invited = Array.isArray(result?.invited_requests) ? result.invited_requests.length : 0
  const joins = Array.isArray(result?.join_requests) ? result.join_requests.length : 0
  if (invited === 0 && joins === 0) return '📭 没有被忽略的入群申请或邀请'
  const lines = [`📭 被忽略的入群通知：申请 ${joins} 条，邀请 ${invited} 条`]
  const rows = [...(result?.join_requests ?? []).slice(0, limit), ...(result?.invited_requests ?? []).slice(0, limit)]
  for (const item of rows) {
    const userId = String(item?.requester_uin ?? item?.invitor_uin ?? item?.user_id ?? '')
    const name = String(item?.requester_nick ?? item?.invitor_nick ?? item?.nickname ?? '')
    if (userId === '' && name === '') continue
    lines.push(`· ${userId}${name === '' ? '' : `（${name}）`}`)
  }
  return lines.join('\n')
}

/** 渲染相册媒体列表（`get_group_album_media_list`）。 */
export function formatAlbumMediaList(result, { limit = 10 } = {}) {
  const list = Array.isArray(result?.media_list) ? result.media_list : []
  if (list.length === 0) return '🖼 这个相册还没有照片'
  const rows = list.slice(0, Math.max(1, Math.trunc(Number(limit) || 10)))
  const lines = [`🖼 相册照片（${list.length} 张，显示前 ${rows.length}）`]
  for (const item of rows) {
    const id = String(item?.media_id ?? item?.id ?? '')
    const name = String(item?.file_name ?? item?.name ?? item?.desc ?? '').trim()
    lines.push(`· ${id}${name === '' ? '' : `｜${name}`}`)
  }
  return lines.join('\n')
}

/** 文件操作的统一回执文案。 */
export function formatFileOp(kind, { ok, reason = '' } = {}, detail = '') {
  const names = { move: '移动', rename: '重命名', trans: '转发', remove: '删除', mkdir: '新建文件夹' }
  const name = names[kind] ?? kind
  if (ok !== true) return `⚠️ ${name}失败：${reason || '未知原因'}`
  return `✅ 已${name}${detail === '' ? '' : `：${detail}`}`
}

/**
 * 群运营事件计数（周报的数据源）。
 * 纯内存 + 快照；`bump` 只累加，`snapshot/restore` 落盘，`since` 支持取最近 N 天。
 */
export class OpsCounters {
  constructor({ maxDays = 30 } = {}) {
    this.maxDays = Math.max(1, Math.trunc(Number(maxDays) || 30))
    /** @type {Map<string, number>} `YYYY-MM-DD|kind` -> 次数 */
    this.days = new Map()
  }

  static dayKey(now = Date.now()) {
    const d = new Date(now)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  /** 记一次事件。未知种类也照记（宁可多记，周报里显示原始 key 也不能丢数据）。 */
  bump(kind, count = 1, now = Date.now()) {
    const key = `${OpsCounters.dayKey(now)}|${String(kind ?? '').trim() || 'unknown'}`
    const value = Number(count)
    this.days.set(key, (this.days.get(key) ?? 0) + (Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1))
    this.prune(now)
    return this.days.get(key)
  }

  /** 最近 days 天各事件的合计。 */
  totals({ days = 7, now = Date.now() } = {}) {
    const window = Math.max(1, Math.trunc(Number(days) || 7))
    const cutoff = now - window * 86_400_000
    const totals = {}
    for (const [key, value] of this.days.entries()) {
      const [day, kind] = key.split('|')
      const at = new Date(`${day}T00:00:00`).getTime()
      if (!Number.isFinite(at) || at < cutoff) continue
      totals[kind] = (totals[kind] ?? 0) + value
    }
    return totals
  }

  /** 最近 days 天的逐日明细（日期升序）。 */
  series({ days = 7, now = Date.now() } = {}) {
    const window = Math.max(1, Math.trunc(Number(days) || 7))
    const rows = []
    for (let i = window - 1; i >= 0; i--) {
      const key = OpsCounters.dayKey(now - i * 86_400_000)
      const kinds = {}
      for (const [entryKey, value] of this.days.entries()) {
        const [day, kind] = entryKey.split('|')
        if (day !== key) continue
        kinds[kind] = (kinds[kind] ?? 0) + value
      }
      rows.push({ day: key, kinds })
    }
    return rows
  }

  /** 丢掉超出保留窗口的旧账。 */
  prune(now = Date.now()) {
    const cutoff = now - this.maxDays * 86_400_000
    let dropped = 0
    for (const key of [...this.days.keys()]) {
      const day = key.split('|')[0]
      const at = new Date(`${day}T00:00:00`).getTime()
      if (Number.isFinite(at) && at < cutoff) {
        this.days.delete(key)
        dropped++
      }
    }
    return dropped
  }

  snapshot() {
    return { version: 1, days: Object.fromEntries(this.days) }
  }

  restore(data) {
    this.days.clear()
    const days = data?.days
    if (!days || typeof days !== 'object') return 0
    let loaded = 0
    for (const [key, value] of Object.entries(days)) {
      const count = Number(value)
      if (!Number.isFinite(count) || count <= 0) continue
      this.days.set(String(key), Math.trunc(count))
      loaded++
    }
    return loaded
  }
}

/**
 * 渲染群运营周报。
 * `stats` 是 OpsCounters.totals() 的结果，`extra` 用来补充不在计数里的事实
 * （例如签到榜前几名、当前禁言人数、@全体余量）。
 */
export function formatWeeklyReport({ stats = {}, series = [], days = 7, groupId = '', extra = [] } = {}) {
  const lines = [`📈 群 ${groupId} 运营周报（最近 ${days} 天）`]
  const rows = Object.entries(OPS_EVENT_NAMES)
    .map(([kind, name]) => ({ kind, name, value: Number(stats[kind]) || 0 }))
    .filter((row) => row.value > 0)
  // 未知种类也要列出来（宁可显示原始 key，也不能把已经记下来的数据吞掉）。
  const unknown = Object.keys(stats).filter((kind) => !(kind in OPS_EVENT_NAMES) && Number(stats[kind]) > 0)
  if (rows.length === 0 && unknown.length === 0) {
    lines.push('· 本周还没有记录到运营事件（消息、入群、禁言、打卡等都会计数）')
  } else {
    for (const row of rows.sort((a, b) => b.value - a.value)) lines.push(`· ${row.name}：${row.value}`)
    for (const kind of unknown) lines.push(`· ${kind}：${Number(stats[kind])}`)
  }
  const active = (series ?? []).filter((row) => Object.values(row.kinds ?? {}).some((value) => Number(value) > 0))
  if (active.length > 0) {
    lines.push(`· 有记录的天数：${active.length}/${(series ?? []).length || days}`)
    const busiest = active
      .map((row) => ({ day: row.day, total: Object.values(row.kinds).reduce((sum, value) => sum + Number(value || 0), 0) }))
      .sort((a, b) => b.total - a.total)[0]
    if (busiest) lines.push(`· 最忙的一天：${busiest.day}（${busiest.total} 次）`)
  }
  for (const line of extra) {
    if (typeof line === 'string' && line.trim() !== '') lines.push(line)
  }
  return lines.join('\n')
}

/** 周报窗口的毫秒数（给 bridge 做时间过滤用）。 */
export function weekWindowMs(days = 7) {
  return Math.max(1, Math.trunc(Number(days) || 7)) * WEEK_MS / 7
}

/**
 * 从命令文本里取参数（与仓库其它命令一致的**空白分隔**约定）。
 * 与 engage.js 的同名函数保持同样的语义，只是这里独立一份，避免模块间互相 import。
 */
export function parseOpsArgs(text, command) {
  const raw = String(text ?? '').trim()
  const cmd = String(command ?? '')
  if (cmd === '') return { ok: false, arg: '', reason: '内部错误：未指定命令名' }
  if (!raw.startsWith(cmd)) return { ok: false, arg: '', reason: `不是 ${cmd} 命令` }
  const rest = raw.slice(cmd.length)
  if (rest !== '' && !/^\s/.test(rest)) return { ok: false, arg: '', reason: `${cmd} 后面需要空格再接参数` }
  const arg = rest.trim()
  if (arg === '') return { ok: false, arg: '', reason: `${cmd} 需要参数` }
  return { ok: true, arg, reason: '' }
}
