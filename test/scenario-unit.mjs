/**
 * 注入场景库 + 回放 diff 的单测（v0.5.5 阶段 4）。
 * 全是纯计算：不写文件、不连宿主、不依赖第三方库。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SCENARIOS, buildScenario, listScenarios } from '../control/lib/scenarios.mjs'
import { diffReplays, textSimilarity } from '../control/lib/replaydiff.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// —— 1. 场景清单 ——
const list = listScenarios()
check('场景清单非空且带中文名', list.length >= 15 && list.every((s) => s.name.length > 0), `len=${list.length}`)
check('每个场景都有 id/kind/note', list.every((s) => s.id && s.kind && s.note), JSON.stringify(list[0]))
check('每个场景都声明了必填参数', list.every((s) => Array.isArray(s.needs) && s.needs.length > 0))
check('清单不泄露 build 函数（可 JSON 化）', list.every((s) => s.build === undefined) && JSON.stringify(list).length > 100)
check('场景 id 唯一', new Set(list.map((s) => s.id)).size === list.length)
check('覆盖了消息/通知/请求三类', new Set(list.map((s) => s.kind)).size === 3, [...new Set(list.map((s) => s.kind))].join(','))

// —— 2. 生成 spec：常见场景 ——
const mention = buildScenario('group-mention', { groupId: 2002, userId: 10001 })
check('群 @我 场景生成 message spec', mention.ok === true && mention.spec.kind === 'message' && mention.spec.groupId === 2002 && mention.spec.atMe === true, JSON.stringify(mention.spec))
check('未给文本时用演示文本（不空手注入）', mention.spec.text.length > 0)
const custom = buildScenario('group-mention', { groupId: 2002, userId: 10001, text: '自定义文本' })
check('给了文本就用给的', custom.spec.text === '自定义文本')
const chat = buildScenario('group-chat', { groupId: 2002, userId: 10001 })
check('普通聊天场景 atMe=false（专验门控）', chat.spec.atMe === false)
const recall = buildScenario('group-recall', { groupId: 2002, userId: 10001 })
check('撤回场景是 notice 且带 messageId', recall.ok && recall.spec.kind === 'notice' && recall.spec.noticeType === 'group_recall' && recall.spec.messageId, JSON.stringify(recall.spec))
const poke = buildScenario('poke', { groupId: 2002, userId: 10001 })
check('戳一戳场景是 notify/poke', poke.ok && poke.spec.kind === 'notice' && poke.spec.subType === 'poke', JSON.stringify(poke.spec))
const req = buildScenario('join-request', { groupId: 2002, userId: 10001 })
check('入群申请场景是 request group/add', req.ok && req.spec.kind === 'request' && req.spec.requestType === 'group', JSON.stringify(req.spec))
const friend = buildScenario('friend-request', { userId: 10001 })
check('加好友场景不需要 groupId', friend.ok === true && friend.spec.requestType === 'friend', JSON.stringify(friend.spec))
const emoji = buildScenario('emoji-like', { groupId: 2002, userId: 10001 })
check('表情回应场景带 likes/isAdd（统计链路才能验到）',
  emoji.ok && Array.isArray(emoji.spec.likes) && emoji.spec.likes[0].emoji_id === '128077' && emoji.spec.isAdd === true,
  JSON.stringify(emoji.spec))
const forward = buildScenario('forward-card', { groupId: 2002, userId: 10001 })
check('转发场景带 forwardText（注入才能确定性覆盖）', forward.ok && forward.spec.forwards.length === 1 && forward.spec.forwardText.length > 0)
const kick = buildScenario('admin-kick', { groupId: 2002, userId: 10001 })
check('管理员命令场景默认给一个目标 QQ', kick.ok && /^\/kick \d+$/.test(kick.spec.text), kick.spec.text)
const longText = buildScenario('long-text', { groupId: 2002, userId: 10001, length: 200 })
check('超长消息场景按参数生成（且夹在合理区间）', longText.ok && longText.spec.text.length === 200, String(longText.spec.text.length))
check('超长消息参数越界也被夹住',
  buildScenario('long-text', { groupId: 2002, userId: 10001, length: 99999 }).spec.text.length === 4000,
  String(buildScenario('long-text', { groupId: 2002, userId: 10001, length: 99999 }).spec.text.length))

// —— 3. 缺参数与未知场景：中文原因、不猜默认值 ——
const missingGroup = buildScenario('group-mention', { userId: 10001 })
check('缺 groupId → ok=false 且点名缺什么', missingGroup.ok === false && missingGroup.reason.includes('groupId'), missingGroup.reason)
check('缺 userId → 同样点名', buildScenario('private-text', {}).reason.includes('userId'), buildScenario('private-text', {}).reason)
check('未知场景 → 提示去看清单', buildScenario('nope', {}).reason.includes('/api/scenarios'), buildScenario('nope', {}).reason)
check('全部场景在缺参数时都拒绝（不会生成半成品）',
  list.every((s) => buildScenario(s.id, {}).ok === false), JSON.stringify(list.filter((s) => buildScenario(s.id, {}).ok === true).map((s) => s.id)))
check('全参数齐备时都能生成 spec',
  list.every((s) => buildScenario(s.id, { groupId: 2002, userId: 10001, target: 10002 }).ok === true),
  JSON.stringify(list.filter((s) => buildScenario(s.id, { groupId: 2002, userId: 10001, target: 10002 }).ok !== true).map((s) => s.id)))
check('返回里带回场景名与说明（前端能直接显示）', mention.scenario.name.length > 0 && mention.scenario.note.length > 0, JSON.stringify(mention.scenario))
check('参数里的对象不会进注入帧（只认字符串/数字）',
  buildScenario('group-mention', { groupId: 2002, userId: 10001, evil: { a: 1 } }).spec.evil === undefined)

// —— 4. 文本相似度 ——
check('完全相同 → 1', textSimilarity('你好世界', '你好世界') === 1)
check('完全不同 → 0', textSimilarity('abcd', 'wxyz') === 0)
check('一边为空 → 0', textSimilarity('', 'abc') === 0 && textSimilarity('abc', '') === 0)
const similar = textSimilarity('今天群里最好笑的一句话', '今天群里最好笑的一句话！')
check('措辞微调 → 高相似度（不会误判成行为变化）', similar > 0.8, String(similar))
check('换了主题 → 低相似度', textSimilarity('今天吃什么', '服务器宕机了') < 0.3, String(textSimilarity('今天吃什么', '服务器宕机了')))

// —— 5. 回放 diff ——
const baseline = {
  results: [
    { index: 0, entry: { chatKey: 'g:2002', text: '你好' }, decision: true, reply: '你好呀～', reason: '' },
    { index: 1, entry: { chatKey: 'g:2002', text: '机器人' }, decision: false, reason: '没 @ 机器人（replyOnlyWhenMentioned）', reply: '' },
    { index: 2, entry: { chatKey: 'g:2002', text: '关键词触发' }, decision: false, reason: '没有命中关键词', reply: '' },
  ],
}
const variant = {
  results: [
    { index: 0, entry: { chatKey: 'g:2002', text: '你好' }, decision: true, reply: '你好呀～', reason: '' },
    { index: 1, entry: { chatKey: 'g:2002', text: '机器人' }, decision: false, reason: '没 @ 机器人（replyOnlyWhenMentioned）', reply: '' },
    { index: 2, entry: { chatKey: 'g:2002', text: '关键词触发' }, decision: true, reply: '命中了关键词，这是固定回复', reason: '' },
  ],
}
const diff = diffReplays(baseline, variant)
check('diff 统计总数与变化数', diff.total === 3 && diff.changed === 1 && diff.unchanged === 2, JSON.stringify({ total: diff.total, changed: diff.changed }))
const changedRow = diff.rows.find((row) => row.index === '2')
check('diff 标出决策变化', changedRow.changeKind === 'decision' && changedRow.changed === true, JSON.stringify(changedRow))
check('diff 并排给出两侧结果', changedRow.baseline.replied === false && changedRow.variant.replied === true, JSON.stringify(changedRow))
check('diff 给一句人话总结', diff.summary.includes('1/3') && diff.summary.includes('决策变了'), diff.summary)
check('byKind 按变化类型计数', diff.byKind.decision === 1, JSON.stringify(diff.byKind))
const sameDiff = diffReplays(baseline, baseline)
check('两次完全相同 → 说明行为一致', sameDiff.changed === 0 && sameDiff.summary.includes('行为一致'), sameDiff.summary)
const reasonDiff = diffReplays(baseline, { results: [
  { index: 0, entry: {}, decision: true, reply: '你好呀～' },
  { index: 1, entry: {}, decision: false, reason: '换了理由', reply: '' },
  { index: 2, entry: {}, decision: false, reason: '没有命中关键词', reply: '' },
] })
check('原因变化被单独识别', reasonDiff.rows.find((r) => r.index === '1').changeKind === 'reason', JSON.stringify(reasonDiff.rows.map((r) => r.changeKind)))
const replyDiff = diffReplays(baseline, { results: [
  { index: 0, entry: {}, decision: true, reply: '你好呀，今天想聊点什么？' },
  { index: 1, entry: {}, decision: false, reason: '没 @ 机器人（replyOnlyWhenMentioned）', reply: '' },
  { index: 2, entry: {}, decision: false, reason: '没有命中关键词', reply: '' },
] })
const replyRow = replyDiff.rows.find((r) => r.index === '0')
// 相似度只是"措辞微调还是完全换了"的参考：长度差很多时 Dice 系数本来就低，
// 所以这里断言的是"落在 0..1 之间且不是完全相同"，而不是拍一个具体阈值。
check('回复文本变化带相似度（0..1 之间且非 1）',
  replyRow.changeKind === 'reply' && replyRow.similarity > 0 && replyRow.similarity < 1,
  JSON.stringify(replyRow))
check('空输入给中文说明', diffReplays(null, null).summary.includes('没有可对比的结果'), diffReplays(null, null).summary)
check('一侧缺结果 → 标成 unknown 而不是"变了"',
  diffReplays(baseline, { results: [] }).rows.every((row) => row.changeKind === 'unknown' && row.changed === false),
  JSON.stringify(diffReplays(baseline, { results: [] }).rows.map((r) => r.changeKind)))
check('接受数组形态的 results（不是只有对象形态）',
  diffReplays([{ index: 0, decision: true, reply: 'a' }], [{ index: 0, decision: false, reason: 'x' }]).changed === 1)
check('limit 生效', diffReplays(baseline, variant, { limit: 1 }).total === 1)
check('行里带上下文文本（便于人读）', diff.rows[0].text.length > 0, JSON.stringify(diff.rows[0]))

// —— 6. 红线：两个模块都是纯的 ——
const here = dirname(fileURLToPath(import.meta.url))
for (const rel of ['scenarios.mjs', 'replaydiff.mjs']) {
  const source = readFileSync(join(here, '..', 'control', 'lib', rel), 'utf8')
  check(`${rel} 零 import`, source.split('\n').filter((line) => /^\s*import\s/.test(line)).length === 0)
  check(`${rel} 不读文件/不联网`, !/readFileSync|writeFileSync|fetch\s*\(|node:fs|node:http/.test(source))
}
check('场景总数与断言里的期望一致', SCENARIOS.length === list.length)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
