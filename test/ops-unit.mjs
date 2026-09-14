/**
 * lib/ops.js 单测：群运营工具箱的纯规划器、渲染器与周报计数。
 *
 * 断言里的 action 名与参数形状全部来自**真机静态探针**
 * （NapCat bootmain/napcat.mjs，QQ 9.9.32-50969），逐条对应 lib/ops.js 头部的探针表。
 * 不联网、不依赖第三方库。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  FILE_ACTIONS,
  MAX_KICK_BATCH,
  OPS_EVENT_NAMES,
  OpsCounters,
  PROFILE_ACTIONS,
  SIGN_ACTION,
  TODO_ACTIONS,
  batchTargets,
  formatAlbumMediaList,
  formatAtAllRemain,
  formatFileOp,
  formatGroupInfoEx,
  formatIgnoredNotifies,
  formatShutList,
  formatShutRemain,
  formatWeeklyReport,
  isValidGroupId,
  isValidQq,
  normalizeTargets,
  parseOpsArgs,
  parseToggle,
  planAlbumUpload,
  planFileOp,
  planGroupSign,
  planHistoryVisibility,
  planKickMembers,
  planMemberPermissions,
  planProfileChange,
  planTodo,
  weekWindowMs,
} from '../lib/ops.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// —— 1. 合法性判定 ——
check('isValidQq 认 5–11 位', isValidQq('10001') && isValidQq('12345678901'))
check('isValidQq 拒短号与 0', !isValidQq('1000') && !isValidQq('0') && !isValidQq('abc'))
check('isValidGroupId 4–12 位（与会话键约定一致）',
  isValidGroupId('2002') && isValidGroupId('123456789012') && !isValidGroupId('123') && !isValidGroupId('1234567890123'),
  `2002=${isValidGroupId('2002')} 13位=${isValidGroupId('1234567890123')}`)

// —— 2. 目标归一化：非法项不静默丢弃 ——
const normalized = normalizeTargets('10001, 10002、10003 abc 10001')
check('normalizeTargets 去重并保序', normalized.valid.join(',') === '10001,10002,10003', normalized.valid.join(','))
check('normalizeTargets 非法项单独返回（不静默丢）', normalized.invalid.join(',') === 'abc', normalized.invalid.join(','))
check('normalizeTargets 接受数组', normalizeTargets(['10001', 10002]).valid.length === 2)
check('normalizeTargets 空输入给空结果', normalizeTargets('').valid.length === 0)

// —— 3. 群打卡（原生签到） ——
const sign = planGroupSign({ groupId: 2002 })
check('planGroupSign action = set_group_sign', sign.ok && sign.action === SIGN_ACTION, sign.action)
check('planGroupSign 参数只有 group_id', JSON.stringify(sign.params) === '{"group_id":"2002"}', JSON.stringify(sign.params))
check('planGroupSign 群号非法 → 真实 reason',
  planGroupSign({ groupId: 'x' }).ok === false && planGroupSign({ groupId: 'x' }).reason.includes('群号不合法'),
  planGroupSign({ groupId: 'x' }).reason)

// —— 4. 批量踢：原生一次多号 + 分批不丢人 ——
const kick = planKickMembers({ groupId: 2002, userIds: '10001 10002' })
check('planKickMembers action = set_group_kick_members', kick.ok && kick.action === 'set_group_kick_members', kick.action)
check('planKickMembers 参数是 user_id 数组', Array.isArray(kick.params.user_id) && kick.params.user_id.length === 2, JSON.stringify(kick.params))
check('planKickMembers 默认不拒绝再加群', kick.params.reject_add_request === false)
check('planKickMembers 可要求拒绝再加群',
  planKickMembers({ groupId: 2002, userIds: '10001', rejectAddRequest: true }).params.reject_add_request === true)
check('planKickMembers 全是非法号 → reason 带原值',
  planKickMembers({ groupId: 2002, userIds: 'abc' }).reason.includes('abc'), planKickMembers({ groupId: 2002, userIds: 'abc' }).reason)
check('planKickMembers 没给号 → reason 说清',
  planKickMembers({ groupId: 2002 }).reason.includes('没有给出'), planKickMembers({ groupId: 2002 }).reason)
const over = planKickMembers({ groupId: 2002, userIds: '10001 10002 10003', max: 2 })
check('planKickMembers 超上限不静默截断（exceeded + 完整名单）',
  over.ok === false && over.exceeded === true && over.valid.length === 3, JSON.stringify(over))
check('batchTargets 分批且不丢人', JSON.stringify(batchTargets('10001 10002 10003', 2)) === '[["10001","10002"],["10003"]]', JSON.stringify(batchTargets('10001 10002 10003', 2)))
check('batchTargets 上限默认 20', batchTargets(Array.from({ length: 45 }, (_, i) => String(10000 + i))).length === 3, String(batchTargets(Array.from({ length: 45 }, (_, i) => String(10000 + i))).length))
check('MAX_KICK_BATCH 是 20', MAX_KICK_BATCH === 20, String(MAX_KICK_BATCH))
check('planKickMembers 目标里的非法项如实带出',
  planKickMembers({ groupId: 2002, userIds: '10001 abc' }).invalid.join(',') === 'abc')

// —— 5. 群待办 ——
check('planTodo set action', planTodo({ groupId: 2002, kind: 'set', messageId: '99' }).action === TODO_ACTIONS.set)
check('planTodo complete action', planTodo({ groupId: 2002, kind: 'complete', messageId: '99' }).action === TODO_ACTIONS.complete)
check('planTodo cancel action', planTodo({ groupId: 2002, kind: 'cancel', messageId: '99' }).action === TODO_ACTIONS.cancel)
check('planTodo 用 message_seq 也可以',
  planTodo({ groupId: 2002, kind: 'set', messageSeq: '123' }).params.message_seq === '123')
check('planTodo 两者都给时都带上',
  JSON.stringify(planTodo({ groupId: 2002, kind: 'set', messageId: '9', messageSeq: '1' }).params) === '{"group_id":"2002","message_seq":"1","message_id":"9"}',
  JSON.stringify(planTodo({ groupId: 2002, kind: 'set', messageId: '9', messageSeq: '1' }).params))
check('planTodo 缺消息标识 → reason 提示引用消息',
  planTodo({ groupId: 2002, kind: 'set' }).reason.includes('引用一条消息'), planTodo({ groupId: 2002, kind: 'set' }).reason)
check('planTodo 未知 kind → reason 带原值',
  planTodo({ groupId: 2002, kind: 'x', messageId: '1' }).reason.includes('x'), planTodo({ groupId: 2002, kind: 'x', messageId: '1' }).reason)
// 审查 O5：原型链键不能绕过（'constructor' 以前会命中原型拿到函数，action 变成函数）
for (const kind of ['constructor', '__proto__', 'toString', 'valueOf']) {
  const todo = planTodo({ groupId: '123456', kind, messageId: '1' })
  check(`planTodo 拒绝原型键 kind=${kind}`, todo.ok === false && typeof todo.action === 'string', JSON.stringify(todo))
  const fileOp = planFileOp({ groupId: '123456', kind, fileId: '/f' })
  check(`planFileOp 拒绝原型键 kind=${kind}`, fileOp.ok === false && fileOp.action === '', JSON.stringify(fileOp))
  const profile = planProfileChange({ groupId: '123456', kind, value: 'x' })
  check(`planProfileChange 拒绝原型键 kind=${kind}`, profile.ok === false && profile.action === '', JSON.stringify(profile))
}

// —— 6. 文件整理 ——
const mv = planFileOp({ groupId: 2002, kind: 'move', fileId: '/f1', currentParent: '/root', targetParent: '/dst' })
check('planFileOp move action + 参数齐全',
  mv.action === FILE_ACTIONS.move && mv.params.current_parent_directory === '/root' && mv.params.target_parent_directory === '/dst',
  JSON.stringify(mv.params))
check('planFileOp rename 用 new_name',
  planFileOp({ groupId: 2002, kind: 'rename', fileId: '/f1', newName: '新名字.jpg' }).params.new_name === '新名字.jpg')
check('planFileOp rename 缺新名 → reason 说清',
  planFileOp({ groupId: 2002, kind: 'rename', fileId: '/f1' }).reason.includes('新文件名'),
  planFileOp({ groupId: 2002, kind: 'rename', fileId: '/f1' }).reason)
check('planFileOp move 缺目标目录 → reason 提示去看目录 ID',
  planFileOp({ groupId: 2002, kind: 'move', fileId: '/f1' }).reason.includes('目标目录'),
  planFileOp({ groupId: 2002, kind: 'move', fileId: '/f1' }).reason)
check('planFileOp remove/trans 只需 file_id',
  planFileOp({ groupId: 2002, kind: 'remove', fileId: '/f1' }).action === FILE_ACTIONS.remove
  && planFileOp({ groupId: 2002, kind: 'trans', fileId: '/f1' }).action === FILE_ACTIONS.trans)
check('planFileOp 缺 file_id → reason 指出先 /文件',
  planFileOp({ groupId: 2002, kind: 'remove' }).reason.includes('/文件'), planFileOp({ groupId: 2002, kind: 'remove' }).reason)
check('planFileOp mkdir 用 folder_name',
  planFileOp({ groupId: 2002, kind: 'mkdir', folderName: '截图' }).params.folder_name === '截图')
check('planFileOp mkdir 缺名字 → reason 说清',
  planFileOp({ groupId: 2002, kind: 'mkdir' }).reason.includes('名字'), planFileOp({ groupId: 2002, kind: 'mkdir' }).reason)
check('planFileOp mkdir 名字过长 → 拒绝',
  planFileOp({ groupId: 2002, kind: 'mkdir', folderName: 'x'.repeat(61) }).ok === false)
check('planFileOp 未知 kind → reason 带原值',
  planFileOp({ groupId: 2002, kind: 'zzz', fileId: '/f' }).reason.includes('zzz'))

// —— 7. 相册上传（探针确认的 action 名） ——
const up = planAlbumUpload({ groupId: 2002, albumId: 'album_1', albumName: '日常', file: '/tmp/a.jpg' })
check('planAlbumUpload action = upload_image_to_qun_album', up.ok && up.action === 'upload_image_to_qun_album', up.action)
check('planAlbumUpload 参数四件套',
  up.params.album_id === 'album_1' && up.params.album_name === '日常' && up.params.file === '/tmp/a.jpg',
  JSON.stringify(up.params))
check('planAlbumUpload 缺相册 ID → reason 提示先 /相册',
  planAlbumUpload({ groupId: 2002, file: 'a.jpg' }).reason.includes('/相册'), planAlbumUpload({ groupId: 2002, file: 'a.jpg' }).reason)
check('planAlbumUpload 缺图片 → reason 说清',
  planAlbumUpload({ groupId: 2002, albumId: 'a' }).reason.includes('图片'), planAlbumUpload({ groupId: 2002, albumId: 'a' }).reason)

// —— 8. 群资料 ——
check('planProfileChange name action + 字段名 group_name',
  planProfileChange({ groupId: 2002, kind: 'name', value: '新群名' }).action === PROFILE_ACTIONS.name
  && planProfileChange({ groupId: 2002, kind: 'name', value: '新群名' }).params.group_name === '新群名')
check('planProfileChange remark 用 remark 字段',
  planProfileChange({ groupId: 2002, kind: 'remark', value: '备注' }).params.remark === '备注')
check('planProfileChange portrait 用 file 字段',
  planProfileChange({ groupId: 2002, kind: 'portrait', value: 'a.png' }).params.file === 'a.png')
check('planProfileChange 空值 → 拒绝', planProfileChange({ groupId: 2002, kind: 'name', value: '  ' }).ok === false)
check('planProfileChange 群名过长 → 拒绝（上限 30）',
  planProfileChange({ groupId: 2002, kind: 'name', value: 'x'.repeat(31) }).ok === false
  && planProfileChange({ groupId: 2002, kind: 'name', value: 'x'.repeat(30) }).ok === true)

// —— 9. 入群与发言策略 ——
const perm = planMemberPermissions({ groupId: 2002, uploadAlbum: false })
check('planMemberPermissions 只带上显式给出的项（探针说未传的保持不变）',
  Object.keys(perm.params).join(',') === 'group_id,allow_member_upload_album', Object.keys(perm.params).join(','))
check('planMemberPermissions 接受「开/关」中文',
  planMemberPermissions({ groupId: 2002, temporarySession: '关' }).params.allow_member_temporary_session === false)
check('planMemberPermissions 三项同改',
  Object.keys(planMemberPermissions({ groupId: 2002, uploadAlbum: true, temporarySession: false, createGroup: true }).params).length === 4)
check('planMemberPermissions 一项都没给 → 拒绝',
  planMemberPermissions({ groupId: 2002 }).reason.includes('至少要给一个'), planMemberPermissions({ groupId: 2002 }).reason)
check('planHistoryVisibility 开/关映射成布尔',
  planHistoryVisibility({ groupId: 2002, visible: '开' }).params.visible === true
  && planHistoryVisibility({ groupId: 2002, visible: 'off' }).params.visible === false)
check('planHistoryVisibility 缺明确开关 → 拒绝',
  planHistoryVisibility({ groupId: 2002 }).reason.includes('明确'), planHistoryVisibility({ groupId: 2002 }).reason)
check('parseToggle 认常见写法，不认的返回 null',
  parseToggle('on') === true && parseToggle('关') === false && parseToggle('允许') === true && parseToggle('随便') === null)

// —— 10. 渲染器 ——
check('formatAtAllRemain 正常结果',
  formatAtAllRemain({ can_at_all: true, remain_at_all_count_for_group: 3, remain_at_all_count_for_uin: 1 }, { groupId: 2002 }).includes('本群剩余：3 次'),
  formatAtAllRemain({ can_at_all: true, remain_at_all_count_for_group: 3, remain_at_all_count_for_uin: 1 }, { groupId: 2002 }).replace(/\n/g, ' | '))
check('formatAtAllRemain 不可用时给原因提示',
  formatAtAllRemain({ can_at_all: false }, { groupId: 2002 }).includes('次数用完'), formatAtAllRemain({ can_at_all: false }, { groupId: 2002 }).replace(/\n/g, ' | '))
check('formatAtAllRemain 空结果不抛错', formatAtAllRemain(null).includes('没有返回数据'))
const now = 1_800_000_000_000
const shut = formatShutList([
  { user_id: '10001', nickname: '小明', shut_up_time: Math.floor(now / 1000) + 3600 },
  { user_id: '10002', nickname: '小红', shut_up_time: Math.floor(now / 1000) - 10 },
], { groupId: 2002, now })
check('formatShutList 标出已到期人数', shut.includes('其中 1 人已到期'), shut.replace(/\n/g, ' | '))
check('formatShutList 显示昵称与剩余时间', shut.includes('小明') && shut.includes('还剩'), shut.replace(/\n/g, ' | '))
check('formatShutList 空名单给正向结论', formatShutList([], { groupId: 2002 }).includes('没有被禁言'), formatShutList([], { groupId: 2002 }))
check('formatShutRemain 秒/毫秒都认',
  formatShutRemain(Math.floor(now / 1000) + 120, now) === '还剩 2 分钟' && formatShutRemain(now + 7200_000, now) === '还剩 2 小时',
  `${formatShutRemain(Math.floor(now / 1000) + 120, now)} | ${formatShutRemain(now + 7200_000, now)}`)
check('formatShutRemain 过期 → 已解除', formatShutRemain(Math.floor(now / 1000) - 5, now) === '已解除')
const info = formatGroupInfoEx({ groupName: '测试群', memberCount: 42, createTime: 1600000000, groupMemo: 'x'.repeat(100) }, { groupId: 2002 })
check('formatGroupInfoEx 取到群名与人数', info.includes('测试群') && info.includes('42'), info.replace(/\n/g, ' | ').slice(0, 160))
check('formatGroupInfoEx 长描述截断', info.includes('…'), info.replace(/\n/g, ' | ').slice(0, 160))
check('formatGroupInfoEx 认不出字段时至少给群号，不编造别的字段',
  (() => { const t = formatGroupInfoEx({ whatever: 1 }, { groupId: 2002 }); return t.includes('群号：2002') && !t.includes('人数') && !t.includes('群名') })(),
  formatGroupInfoEx({ whatever: 1 }, { groupId: 2002 }).replace(/\n/g, ' | '))
check('formatIgnoredNotifies 空 → 正向结论', formatIgnoredNotifies({}).includes('没有被忽略'))
check('formatIgnoredNotifies 列出申请与邀请',
  formatIgnoredNotifies({ join_requests: [{ requester_uin: 10001, requester_nick: '小明' }], invited_requests: [{ invitor_uin: 10002 }] }).includes('小明'))
const media = formatAlbumMediaList({ media_list: [{ media_id: 'm1', file_name: 'a.jpg' }, { media_id: 'm2' }] })
check('formatAlbumMediaList 列出照片', media.includes('m1') && media.includes('a.jpg'), media.replace(/\n/g, ' | '))
check('formatAlbumMediaList 空相册给正向结论', formatAlbumMediaList({}).includes('还没有照片'))
check('formatFileOp 成功/失败两种文案',
  formatFileOp('move', { ok: true }, 'a → b').startsWith('✅') && formatFileOp('move', { ok: false, reason: '闸门拦下' }).includes('闸门拦下'),
  `${formatFileOp('move', { ok: true })} | ${formatFileOp('move', { ok: false, reason: '闸门拦下' })}`)

// —— 11. 周报计数 ——
const counters = new OpsCounters()
const day = 86_400_000
counters.bump('message', 5, now)
counters.bump('message', 3, now - day)
counters.bump('join', 2, now - 2 * day)
counters.bump('sign', 1, now - 8 * day)
const totals = counters.totals({ days: 7, now })
check('OpsCounters.totals 按窗口合计', totals.message === 8 && totals.join === 2, JSON.stringify(totals))
check('OpsCounters.totals 窗口外的不计入', totals.sign === undefined, JSON.stringify(totals))
check('OpsCounters.totals 未知名也统计', counters.bump('自定义事件', 1, now) === 1 && counters.totals({ days: 1, now })['自定义事件'] === 1)
const series = counters.series({ days: 3, now })
check('OpsCounters.series 给出逐日明细', series.length === 3 && series[2].kinds.message === 5, JSON.stringify(series.map((r) => r.kinds)))
check('OpsCounters.dayKey 用本地日期', OpsCounters.dayKey(now).length === 10 && OpsCounters.dayKey(now).includes('-'))
const snap = counters.snapshot()
const restored = new OpsCounters()
check('OpsCounters snapshot → restore', restored.restore(snap) === counters.days.size && restored.totals({ days: 7, now }).message === 8, `loaded=${restored.restore(snap)}`)
check('OpsCounters restore 坏数据不抛错', new OpsCounters().restore({ days: { a: 'x', b: -1 } }) === 0)
const pruned = new OpsCounters({ maxDays: 3 })
pruned.bump('message', 1, now)
check('OpsCounters prune 保留窗口内、丢掉窗口外',
  pruned.days.size === 1 && pruned.prune(now + 10 * day) === 1 && pruned.days.size === 0, String(pruned.days.size))
const report = formatWeeklyReport({ stats: { message: 8, join: 2, sign: 0 }, series: [{ day: 'a', kinds: { message: 5 } }, { day: 'b', kinds: {} }], days: 7, groupId: 2002, extra: ['· 当前禁言：1 人'] })
check('formatWeeklyReport 用中文事件名', report.includes('消息：8') && report.includes('入群：2'), report.replace(/\n/g, ' | ').slice(0, 200))
check('formatWeeklyReport 零值项不列', !report.includes('群打卡'), report.replace(/\n/g, ' | ').slice(0, 200))
check('formatWeeklyReport 带最忙的一天', report.includes('最忙的一天'), report.replace(/\n/g, ' | ').slice(0, 200))
check('formatWeeklyReport 追加 extra 行', report.includes('当前禁言'))
check('formatWeeklyReport 空数据给中文说明',
  formatWeeklyReport({ stats: {}, groupId: 2002 }).includes('还没有记录到运营事件'), formatWeeklyReport({ stats: {}, groupId: 2002 }).replace(/\n/g, ' | '))
check('formatWeeklyReport 未知事件种类原样列出',
  formatWeeklyReport({ stats: { 自定义事件: 3 }, groupId: 2002 }).includes('自定义事件：3'))
check('OPS_EVENT_NAMES 都带中文名', Object.values(OPS_EVENT_NAMES).every((name) => /[\u4e00-\u9fa5]/.test(name)))
check('weekWindowMs 7 天 = 一周毫秒数', weekWindowMs(7) === 7 * 86_400_000, String(weekWindowMs(7)))

// —— 12. 命令参数解析（空白分隔约定） ——
check('parseOpsArgs 正常取值', parseOpsArgs('/群打卡', '/群打卡').ok === true ? true : parseOpsArgs('/踢 10001', '/踢').arg === '10001')
check('parseOpsArgs 没有空格 → 明确拒绝',
  parseOpsArgs('/踢10001', '/踢').reason.includes('空格'), parseOpsArgs('/踢10001', '/踢').reason)
check('parseOpsArgs 空参数 → 明确拒绝', parseOpsArgs('/踢', '/踢').reason.includes('需要参数'))
check('parseOpsArgs 不是该命令 → 拒绝', parseOpsArgs('/群名 x', '/踢').reason.includes('不是'))

// —— 13. 红线：纯模块，零依赖，不自己发 QQ ——
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'ops.js'), 'utf8')
check('ops.js 零 import（纯模块）', source.split('\n').filter((line) => /^\s*import\s/.test(line)).length === 0)
check('ops.js 不含 fetch', !/\bfetch\s*\(/.test(source))
check('ops.js 不直接发 QQ（无 socket/sendSegments）', !/\bsocket\b|\.sendSegments\(/.test(source))
check('ops.js 不读环境变量/写文件', !/process\.env|writeFileSync|readFileSync/.test(source))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
