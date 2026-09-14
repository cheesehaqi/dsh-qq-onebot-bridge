/**
 * lib/engage.js 单测：戳一戳 / 正在输入 / 表情回应 / 点赞 / 标记已读的规划、统计与配额。
 *
 * 这些断言全部来自**真机静态探针**（NapCat bootmain/napcat.mjs，QQ 9.9.32-50969）：
 * action 名与参数形状必须与探针结果逐字一致，否则线上会直接报「Action not found」。
 * 不联网、不依赖第三方库。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  DEFAULT_EMOJI_ID,
  EngageQuota,
  INPUT_STATUS_EVENT,
  MARK_READ_ACTIONS,
  MAX_LIKE_TIMES,
  POKE_ACTIONS,
  ReactionStats,
  describeInputStatus,
  emojiGlyph,
  formatEmojiLikes,
  formatInputStatusNotice,
  formatReactionBoard,
  isEmojiLikeNotice,
  isInputStatusNotice,
  isValidUserId,
  normalizeEmojiLikes,
  parseEmojiLikesResult,
  parseEngageArgs,
  planEmojiLike,
  planInputStatus,
  planMarkRead,
  planPoke,
  planSendLike,
} from '../lib/engage.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// —— 1. emojiGlyph：NapCat 的表情回应 id 是十进制码点 ——
check('emojiGlyph 128077 → 👍', emojiGlyph('128077') === '👍', emojiGlyph('128077'))
check('emojiGlyph 128516 → 😄', emojiGlyph(128516) === '😄', emojiGlyph(128516))
check('emojiGlyph 短 ID 显示为 #4', emojiGlyph('4') === '#4', emojiGlyph('4'))
check('emojiGlyph 非数字原样返回', emojiGlyph('abc') === 'abc', emojiGlyph('abc'))
check('emojiGlyph 空值给 ?', emojiGlyph('') === '?' && emojiGlyph(null) === '?', `${emojiGlyph('')}|${emojiGlyph(null)}`)
check('emojiGlyph 越界码点不抛错', emojiGlyph('999999999') === '#999999999', emojiGlyph('999999999'))
check('emojiGlyph 0x2764（❤）走码点', emojiGlyph('10084') === '❤', emojiGlyph('10084'))

// —— 2. isValidUserId：0 / 空 / 非数字都不认 ——
check('isValidUserId 正常 QQ', isValidUserId(123456) === true && isValidUserId('123456') === true)
check('isValidUserId 0 不合法', isValidUserId(0) === false && isValidUserId('0') === false)
check('isValidUserId 空/非数字不合法', isValidUserId('') === false && isValidUserId('abc') === false && isValidUserId(null) === false)

// —— 3. planPoke：群聊 group_poke / 私聊 friend_poke ——
const pokeGroup = planPoke({ groupId: 2002, targetId: 1001 })
check('planPoke 群聊 action = group_poke', pokeGroup.ok && pokeGroup.action === POKE_ACTIONS.group, pokeGroup.action)
check('planPoke 群聊参数形状（group_id + user_id）',
  pokeGroup.params.group_id === '2002' && pokeGroup.params.user_id === '1001',
  JSON.stringify(pokeGroup.params))
const pokePrivate = planPoke({ targetId: '1001' })
check('planPoke 私聊 action = friend_poke', pokePrivate.ok && pokePrivate.action === POKE_ACTIONS.private, pokePrivate.action)
check('planPoke 私聊只带 user_id', pokePrivate.params.user_id === '1001' && pokePrivate.params.group_id === undefined, JSON.stringify(pokePrivate.params))
const pokeNoTarget = planPoke({ groupId: 2002 })
check('planPoke 缺目标 → ok=false + 真实 reason',
  pokeNoTarget.ok === false && pokeNoTarget.reason.includes('目标 QQ'), pokeNoTarget.reason)
const pokeBadGroup = planPoke({ groupId: 'x', targetId: 1001 })
check('planPoke 群号不合法 → reason 带原值', pokeBadGroup.ok === false && pokeBadGroup.reason.includes('x'), pokeBadGroup.reason)
check('planPoke 绝不猜目标（缺 targetId 不会退化成戳自己）', planPoke({}).params === null)

// —— 4. planEmojiLike ——
const like = planEmojiLike({ messageId: 12345 })
check('planEmojiLike action = set_msg_emoji_like', like.ok && like.action === 'set_msg_emoji_like', like.action)
check('planEmojiLike 默认表情是 👍 的码点', like.params.emoji_id === DEFAULT_EMOJI_ID, like.params.emoji_id)
check('planEmojiLike 默认 set=true', like.params.set === true)
check('planEmojiLike 取消回应 set=false', planEmojiLike({ messageId: '1', set: false }).params.set === false)
check('planEmojiLike 缺消息 ID → reason 说清',
  planEmojiLike({}).ok === false && planEmojiLike({}).reason.includes('消息 ID'), planEmojiLike({}).reason)
check('planEmojiLike 表情 ID 非数字 → reason 带原值',
  planEmojiLike({ messageId: '1', emojiId: 'x' }).reason.includes('x'), planEmojiLike({ messageId: '1', emojiId: 'x' }).reason)

// —— 5. planMarkRead：NapCat 按会话标记，不按消息 ——
check('planMarkRead 群 → mark_group_msg_as_read',
  planMarkRead({ groupId: 2002 }).action === MARK_READ_ACTIONS.group, planMarkRead({ groupId: 2002 }).action)
check('planMarkRead 私聊 → mark_private_msg_as_read',
  planMarkRead({ userId: 1001 }).action === MARK_READ_ACTIONS.private, planMarkRead({ userId: 1001 }).action)
check('planMarkRead 群优先于私聊',
  planMarkRead({ groupId: 2002, userId: 1001 }).params.group_id === '2002')
const markNone = planMarkRead({})
check('planMarkRead 两个都没有 → reason 说明是会话级',
  markNone.ok === false && markNone.reason.includes('按会话标记'), markNone.reason)

// —— 6. planSendLike：次数夹紧 + clamped 标志 ——
const like10 = planSendLike({ userId: 1001, times: 10 })
check('planSendLike action = send_like', like10.ok && like10.action === 'send_like', like10.action)
check('planSendLike 次数上限 10', like10.params.times === MAX_LIKE_TIMES, String(like10.params.times))
check('planSendLike 超过上限夹到 10 且 clamped=true',
  planSendLike({ userId: 1001, times: 99 }).params.times === 10 && planSendLike({ userId: 1001, times: 99 }).clamped === true)
check('planSendLike 0 → 1', planSendLike({ userId: 1001, times: 0 }).params.times === 1)
check('planSendLike 非数字 → 1', planSendLike({ userId: 1001, times: 'abc' }).params.times === 1)
check('planSendLike 正常值不标 clamped', planSendLike({ userId: 1001, times: 5 }).clamped === false)
check('planSendLike 缺目标 → reason 说清',
  planSendLike({ times: 5 }).ok === false && planSendLike({ times: 5 }).reason.includes('目标 QQ'), planSendLike({ times: 5 }).reason)
// 审查 O6：Symbol 之类的怪输入不能抛错（Number(Symbol()) 会 TypeError）
check('planSendLike 遇到 Symbol 输入不抛错（退化成 1 次）',
  (() => { try { const r = planSendLike({ userId: 1001, times: Symbol('x') }); return r.ok === true && r.params.times === 1 } catch { return false } })(),
  (() => { try { return JSON.stringify(planSendLike({ userId: 1001, times: Symbol('x') })) } catch (error) { return 'THREW: ' + error.message } })())
check('planSendLike max 是 Symbol 也不抛错',
  (() => { try { return planSendLike({ userId: 1001, times: 3, max: Symbol('m') }).params.times === 3 } catch { return false } })())

// —— 7. planInputStatus：只走私聊 C2C ——
const typing = planInputStatus({ userId: 1001 })
check('planInputStatus action = set_input_status', typing.ok && typing.action === 'set_input_status', typing.action)
check('planInputStatus 默认 event_type=1（正在输入）', typing.params.event_type === INPUT_STATUS_EVENT.typing)
check('planInputStatus 停止输入 event_type=2',
  planInputStatus({ userId: 1001, eventType: 2 }).params.event_type === INPUT_STATUS_EVENT.stop)
const typingGroup = planInputStatus({ userId: 1001, isGroup: true })
check('planInputStatus 群聊直接拒绝（不白跑一趟）',
  typingGroup.ok === false && typingGroup.reason.includes('只支持私聊'), typingGroup.reason)
check('planInputStatus 缺对象 → reason 说清',
  planInputStatus({}).ok === false && planInputStatus({}).reason.includes('私聊对象'), planInputStatus({}).reason)
check('describeInputStatus 1/2/未知',
  describeInputStatus(1) === '正在输入' && describeInputStatus(2) === '停止输入' && describeInputStatus(9).includes('未知'),
  `${describeInputStatus(1)}|${describeInputStatus(2)}|${describeInputStatus(9)}`)

// —— 8. 入站事件识别与渲染 ——
check('isInputStatusNotice 只认 notify/input_status',
  isInputStatusNotice({ noticeType: 'notify', subType: 'input_status' }) === true
  && isInputStatusNotice({ noticeType: 'notify', subType: 'poke' }) === false)
check('isEmojiLikeNotice 只认 group_msg_emoji_like',
  isEmojiLikeNotice({ noticeType: 'group_msg_emoji_like' }) === true
  && isEmojiLikeNotice({ noticeType: 'group_recall' }) === false)
check('formatInputStatusNotice 用对方给的 status_text，且不叠双省略号',
  formatInputStatusNotice({ userId: 1001, eventType: 1, statusText: '对方正在输入...' }) === '1001 对方正在输入...',
  formatInputStatusNotice({ userId: 1001, eventType: 1, statusText: '对方正在输入...' }))
check('formatInputStatusNotice 结尾没标点时才补省略号',
  formatInputStatusNotice({ userId: 1001, eventType: 1, statusText: '敲键盘中' }) === '1001 敲键盘中…',
  formatInputStatusNotice({ userId: 1001, eventType: 1, statusText: '敲键盘中' }))
check('formatInputStatusNotice 缺 status_text 时回落 event_type 文案',
  formatInputStatusNotice({ userId: 1001, eventType: 2 }).includes('停止输入'), formatInputStatusNotice({ userId: 1001, eventType: 2 }))

// —— 9. normalizeEmojiLikes：真机形状 + 容错 ——
const likesArray = normalizeEmojiLikes([{ emoji_id: '128077', count: 2 }, { emoji_id: '4', count: 1 }])
check('normalizeEmojiLikes 数组对象形状', likesArray.length === 2 && likesArray[0].emojiId === '128077' && likesArray[0].count === 2, JSON.stringify(likesArray))
check('normalizeEmojiLikes 对象字典形状',
  normalizeEmojiLikes({ '128077': 3 })[0].count === 3, JSON.stringify(normalizeEmojiLikes({ '128077': 3 })))
check('normalizeEmojiLikes 纯字符串数组按 1 计',
  normalizeEmojiLikes(['128077', '128077'])[0].count === 2, JSON.stringify(normalizeEmojiLikes(['128077', '128077'])))
check('normalizeEmojiLikes 空/非法 → 空数组',
  normalizeEmojiLikes([]).length === 0 && normalizeEmojiLikes(null).length === 0 && normalizeEmojiLikes([{}, null, '']).length === 0)
check('normalizeEmojiLikes 缺 count 按 1', normalizeEmojiLikes([{ emoji_id: '7' }])[0].count === 1)

// —— 10. ReactionStats：去重、撤回、排行、落盘 ——
const stats = new ReactionStats()
const addA = stats.apply({ noticeType: 'group_msg_emoji_like', groupId: 2002, userId: 1001, messageId: '9001', likes: [{ emoji_id: '128077', count: 1 }], isAdd: true }, 1000)
check('ReactionStats 记一条回应成功', addA.ok === true && addA.added === 1 && addA.total === 1, JSON.stringify(addA))
const addA2 = stats.apply({ groupId: 2002, userId: 1001, messageId: '9001', likes: [{ emoji_id: '128077', count: 1 }], isAdd: true }, 2000)
check('ReactionStats 同一人重复点不重复计数', addA2.added === 0 && addA2.total === 1, JSON.stringify(addA2))
const addB = stats.apply({ groupId: 2002, userId: 1002, messageId: '9001', likes: [{ emoji_id: '128077', count: 1 }], isAdd: true, senderName: '小明' }, 3000)
check('ReactionStats 第二个人计数 +1', addB.added === 1 && addB.total === 2, JSON.stringify(addB))
stats.apply({ groupId: 2002, userId: 1003, messageId: '9001', likes: [{ emoji_id: '4', count: 1 }], isAdd: true }, 4000)
check('ReactionStats totalFor 跨表情累加', stats.totalFor('9001') === 3, String(stats.totalFor('9001')))
check('ReactionStats byEmoji 数量多的在前',
  stats.byEmoji('9001')[0].emojiId === '128077' && stats.byEmoji('9001')[0].count === 2, JSON.stringify(stats.byEmoji('9001').map((r) => [r.emojiId, r.count])))
check('ReactionStats byEmoji 带 glyph 与名单',
  stats.byEmoji('9001')[0].glyph === '👍' && stats.byEmoji('9001')[0].users.length === 2, JSON.stringify(stats.byEmoji('9001')[0]))
const removeA = stats.apply({ groupId: 2002, userId: 1001, messageId: '9001', likes: [{ emoji_id: '128077', count: 1 }], isAdd: false }, 5000)
check('ReactionStats 撤回只去掉那个人', removeA.removed === 1 && removeA.total === 2, JSON.stringify(removeA))
check('ReactionStats 撤回后该表情剩 1 人', stats.byEmoji('9001')[0].count === 1, JSON.stringify(stats.byEmoji('9001')[0]))
check('ReactionStats 缺 message_id → 真实 reason',
  stats.apply({ groupId: 2002, userId: 1001, likes: [] }).reason.includes('message_id'), stats.apply({ groupId: 2002, userId: 1001 }).reason)
check('ReactionStats 缺 user_id → 真实 reason',
  stats.apply({ groupId: 2002, messageId: '9002', likes: [{ emoji_id: '4' }] }).reason.includes('user_id'))
check('ReactionStats 无 likes → 真实 reason',
  stats.apply({ groupId: 2002, userId: 1001, messageId: '9002', likes: [] }).reason.includes('likes'))
check('ReactionStats 未记过的消息 totalFor = 0', stats.totalFor('nope') === 0)
check('ReactionStats 未记过的消息 byEmoji = []', stats.byEmoji('nope').length === 0)

// 第二条消息 + 另一个群，用于排行与过滤
stats.apply({ groupId: 2002, userId: 1004, messageId: '9002', likes: [{ emoji_id: '128077' }], isAdd: true }, 6000)
stats.apply({ groupId: 3003, userId: 1005, messageId: '9003', likes: [{ emoji_id: '128077' }], isAdd: true }, 7000)
stats.apply({ groupId: 3003, userId: 1006, messageId: '9003', likes: [{ emoji_id: '128077' }], isAdd: true }, 8000)
const top = stats.topMessages({ limit: 5 })
check('ReactionStats topMessages 按总数排序', top[0].messageId === '9003' && top[0].total === 2, JSON.stringify(top.map((r) => [r.messageId, r.total])))
const topGroup = stats.topMessages({ limit: 5, chatKey: 'g:2002' })
check('ReactionStats topMessages 按会话过滤', topGroup.every((row) => row.chatKey === 'g:2002') && topGroup.length === 2, JSON.stringify(topGroup.map((r) => r.messageId)))
check('ReactionStats topMessages limit 生效', stats.topMessages({ limit: 1 }).length === 1)
const topU = stats.topUsers({ limit: 5 })
check('ReactionStats topUsers 列出点过的人', topU.length === 5, JSON.stringify(topU))
check('ReactionStats topUsers 按会话过滤', stats.topUsers({ chatKey: 'g:3003' }).length === 2, JSON.stringify(stats.topUsers({ chatKey: 'g:3003' })))

const snap = stats.snapshot()
const restored = new ReactionStats()
const loaded = restored.restore(snap)
check('ReactionStats snapshot → restore 条数一致', loaded === stats.size, `loaded=${loaded} size=${stats.size}`)
check('ReactionStats restore 后统计等价', restored.totalFor('9001') === stats.totalFor('9001') && restored.topMessages({ limit: 3 })[0].messageId === top[0].messageId)
check('ReactionStats restore 坏数据不抛错', new ReactionStats().restore({ messages: { a: null } }) === 0)
check('ReactionStats restore 非对象不抛错', new ReactionStats().restore(null) === 0)

// 容量与过期
const capStats = new ReactionStats({ maxMessages: 2 })
capStats.apply({ groupId: 1, userId: 1, messageId: 'a', likes: [{ emoji_id: '4' }] }, 1000)
capStats.apply({ groupId: 1, userId: 1, messageId: 'b', likes: [{ emoji_id: '4' }] }, 2000)
capStats.apply({ groupId: 1, userId: 1, messageId: 'c', likes: [{ emoji_id: '4' }] }, 3000)
check('ReactionStats 超容量淘汰最旧的', capStats.size === 2 && capStats.totalFor('a') === 0 && capStats.totalFor('c') === 1, `size=${capStats.size}`)
const oldStats = new ReactionStats()
oldStats.apply({ groupId: 1, userId: 1, messageId: 'old', likes: [{ emoji_id: '4' }] }, 1_000_000)
check('ReactionStats prune 丢掉过期消息', oldStats.prune(1_000_000 + 31 * 86_400_000) === 1 && oldStats.size === 0, `size=${oldStats.size}`)
const boundedUsers = new ReactionStats({ maxUsersPerEmoji: 1 })
boundedUsers.apply({ groupId: 1, userId: 1, messageId: 'm', likes: [{ emoji_id: '4' }] }, 1)
boundedUsers.apply({ groupId: 1, userId: 2, messageId: 'm', likes: [{ emoji_id: '4' }] }, 2)
check('ReactionStats 单个表情的名单有上限', boundedUsers.totalFor('m') === 1, String(boundedUsers.totalFor('m')))

// —— 11. EngageQuota：每小时 / 每天 ——
const quota = new EngageQuota({ perHour: 2, perDay: 3 })
check('Quota 首次放行', quota.check('k', 1000).ok === true, JSON.stringify(quota.check('k', 1000)))
quota.record('k', 1000)
quota.record('k', 2000)
const qDenied = quota.check('k', 2500, '戳一戳')
check('Quota 每小时上限拦截', qDenied.ok === false && qDenied.reason.includes('每小时上限') && qDenied.used.hour === 2, qDenied.reason)
check('Quota 拒绝文案带 label', qDenied.reason.includes('戳一戳'), qDenied.reason)
check('Quota 一小时后重新放行', quota.check('k', 1000 + 3600_001).ok === true)
quota.record('k', 1000 + 3600_001)
const dayQuota = new EngageQuota({ perDay: 1 })
dayQuota.record('d', 1000)
check('Quota 每天上限拦截', dayQuota.check('d', 2000, '点赞').reason.includes('每天上限'), dayQuota.check('d', 2000, '点赞').reason)
check('Quota 不同 key 互不影响', quota.check('other', 2500).ok === true)
check('Quota 无限额时永远放行', new EngageQuota().check('x', 1).ok === true)
const minuteQuota = new EngageQuota({ perMinute: 1 })
minuteQuota.record('m', 1000)
const minuteDenied = minuteQuota.check('m', 2000, '标记已读')
check('Quota 每分钟上限拦截', minuteDenied.ok === false && minuteDenied.reason.includes('每分钟上限'), minuteDenied.reason)
check('Quota 每分钟窗口用完即恢复', minuteQuota.check('m', 1000 + 60_001).ok === true)
check('Quota used 同时给出分/时/天计数',
  minuteDenied.used.minute === 1 && typeof minuteDenied.used.hour === 'number' && typeof minuteDenied.used.day === 'number',
  JSON.stringify(minuteDenied.used))
const qSnap = quota.snapshot()
const qRestored = new EngageQuota({ perHour: 2, perDay: 3 })
check('Quota snapshot → restore', qRestored.restore(qSnap) === quota.marks.size, `loaded=${qRestored.restore(qSnap)}`)
check('Quota prune 清掉过期记账', new EngageQuota({ perHour: 1 }).prune(0) === 0)
const qPruned = new EngageQuota({ perDay: 1 })
qPruned.record('p', 1)
check('Quota prune 真删掉过期条目', qPruned.prune(1 + 86_400_001) === 1, String(qPruned.marks.size))
check('Quota restore 坏数据不抛错', new EngageQuota().restore({ marks: { a: 'x' } }) === 0)

// —— 12. 榜单与名单渲染 ——
check('formatReactionBoard 空榜给中文说明',
  formatReactionBoard([]).includes('还没有任何表情回应'), formatReactionBoard([]))
const boardText = formatReactionBoard(top, { limit: 2, textOf: (id) => (id === '9003' ? '今天群里最好笑的一句话' : '') })
check('formatReactionBoard 带排名与表情数', boardText.includes('1.') && boardText.includes('👍×2'), boardText.replace(/\n/g, ' | '))
check('formatReactionBoard 带原文摘要', boardText.includes('今天群里最好笑的一句话'), boardText)
check('formatReactionBoard 原文过长会截断', formatReactionBoard(top, { limit: 1, textOf: () => 'x'.repeat(80), maxChars: 10 }).includes('xxxxxxxxxx…'))
check('formatReactionBoard textOf 抛错不影响渲染',
  formatReactionBoard(top, { limit: 1, textOf: () => { throw new Error('boom') } }).includes('1.'))
check('formatEmojiLikes 空给来源说明',
  formatEmojiLikes([], { messageId: '1', source: 'get_emoji_likes' }).includes('get_emoji_likes'),
  formatEmojiLikes([], { messageId: '1', source: 'get_emoji_likes' }))
const likesText = formatEmojiLikes([{ emojiId: '128077', glyph: '👍', count: 2, users: [{ userId: '1001', name: '小明' }, { userId: '1002', name: '' }] }], { messageId: '9001' })
check('formatEmojiLikes 带昵称与 QQ', likesText.includes('小明(1001)') && likesText.includes('1002'), likesText)
check('formatEmojiLikes 超过上限折叠', formatEmojiLikes([{ emojiId: '4', glyph: '#4', count: 3, users: [{ userId: '1' }, { userId: '2' }, { userId: '3' }] }], { messageId: 'm', maxUsers: 1 }).includes('等 3 人'))

// —— 13. parseEmojiLikesResult：get_emoji_likes 的返回值 ——
const parsed = parseEmojiLikesResult({ emoji_like_list: [{ user_id: '1001', nick_name: '小明' }, { tinyId: '1002', nickName: '小红' }, { user_id: '' }] }, { emojiId: '128077' })
check('parseEmojiLikesResult 认出 user_id 与 tinyId', parsed.count === 2 && parsed.users[0].userId === '1001', JSON.stringify(parsed))
check('parseEmojiLikesResult 带 glyph', parsed.glyph === '👍', parsed.glyph)
check('parseEmojiLikesResult 空结果不抛错', parseEmojiLikesResult(null).count === 0 && parseEmojiLikesResult({}).count === 0)

// —— 14. parseEngageArgs：空白分隔约定 ——
check('parseEngageArgs 正常取值', parseEngageArgs('/戳 1001', '/戳').arg === '1001')
check('parseEngageArgs 没有空格 → 明确拒绝',
  parseEngageArgs('/戳1001', '/戳').ok === false && parseEngageArgs('/戳1001', '/戳').reason.includes('空格'),
  parseEngageArgs('/戳1001', '/戳').reason)
check('parseEngageArgs 空参数 → 明确拒绝',
  parseEngageArgs('/点赞', '/点赞').ok === false && parseEngageArgs('/点赞', '/点赞').reason.includes('需要参数'))
check('parseEngageArgs 多空格也能取到',
  parseEngageArgs('/戳   1001', '/戳').arg === '1001')
check('parseEngageArgs 不是该命令 → 拒绝',
  parseEngageArgs('/赞榜', '/戳').reason.includes('不是'), parseEngageArgs('/赞榜', '/戳').reason)

// —— 15. 红线：本模块零依赖、绝不自己发 QQ ——
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'engage.js'), 'utf8')
const importLines = source.split('\n').filter((line) => /^\s*import\s/.test(line))
check('engage.js 零 import（纯模块，不依赖任何东西）', importLines.length === 0, importLines.join(' | '))
check('engage.js 不含 fetch（不自己发网络请求）', !/\bfetch\s*\(/.test(source))
check('engage.js 不含 http/https 导入', !/node:(http|https)/.test(source))
check('engage.js 不直接发 QQ（无 socket/ws 调用）', !/\bsocket\b|\.sendSegments\(/.test(source))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
