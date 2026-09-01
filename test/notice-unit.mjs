/** Unit tests for OneBot notice parsing (poke / member join). */
import { parseNotice } from '../lib/onebot.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// 群戳一戳
const poke = parseNotice({
  post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
  user_id: 10001, target_id: 3030856788, group_id: 740179707, self_id: 3030856788,
})
check('poke 解析 noticeType', poke.noticeType === 'notify' && poke.subType === 'poke', JSON.stringify(poke))
check('poke 解析 user/target', poke.userId === 10001 && poke.targetId === 3030856788)
check('poke 解析 groupId', poke.groupId === 740179707)

// 私聊戳一戳（无 group_id）
const poke2 = parseNotice({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 10001, target_id: 3030856788 })
check('私聊 poke 无 groupId', poke2.groupId === undefined && poke2.noticeType === 'notify')

// 入群
const join = parseNotice({
  post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve',
  group_id: 740179707, user_id: 20002, operator_id: 10001, self_id: 3030856788,
})
check('入群 noticeType', join.noticeType === 'group_increase', JSON.stringify(join))
check('入群 user/operator', join.userId === 20002 && join.operatorId === 10001)

// 退群
const leave = parseNotice({ post_type: 'notice', notice_type: 'group_decrease', group_id: 740179707, user_id: 20002 })
check('退群 noticeType', leave.noticeType === 'group_decrease' && leave.groupId === 740179707)

// 非 notice 帧
check('message 帧返回 null', parseNotice({ post_type: 'message', message_type: 'group' }) === null)
check('空对象返回 null', parseNotice(null) === null && parseNotice({}) === null)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
