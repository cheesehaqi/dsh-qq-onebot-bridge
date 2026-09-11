/** Unit tests for the join-request guard: queue, challenge, answers and expiry (no network). */
import { JoinGuard, buildVerifyQuestion, checkVerifyAnswer, formatJoinPrompt, formatPendingList, normalizeAnswer, parseVerifyCommand } from '../lib/verify.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ---- 验证题 ----
const q = buildVerifyQuestion(() => 0)
check('题目格式', /^请回答：(\d+) \+ (\d+) = /.test(q.question), q.question)
check('答案与题目一致', (() => {
  const m = /(\d+) \+ (\d+)/.exec(q.question)
  return Number(m[1]) + Number(m[2]) === Number(q.answer)
})(), `${q.question} → ${q.answer}`)
check('固定 rng 输出确定', buildVerifyQuestion(() => 0).answer === q.answer)
check('不同 rng 输出不同', buildVerifyQuestion(() => 0.99).answer !== q.answer)

// ---- 答案归一化 ----
check('全角数字可识别', normalizeAnswer('１９') === '19')
check('带前缀可识别', normalizeAnswer('答案是：19') === '19')
check('句末标点忽略', normalizeAnswer(' 19。 ') === '19')
check('错误答案不通过', checkVerifyAnswer({ answer: '19' }, '20') === false)
check('缺失条目返回 false', checkVerifyAnswer(null, '19') === false)
check('正确作答通过', checkVerifyAnswer({ answer: '19' }, '答案是 19！') === true)

// ---- 队列 ----
let clock = 1_700_000_000_000
const guard = new JoinGuard({ timeoutSeconds: 300, maxPending: 3, rng: () => 0, now: () => clock })
check('空队列 size=0', guard.size === 0 && guard.list().length === 0)
const first = guard.addRequest({ flag: 'f1', userId: 1001, groupId: 2002, comment: '求进群' })
check('登记返回 id=1', first.id === 1 && first.entry.userId === 1001)
check('登记自带验证题', typeof first.question === 'string' && first.answer === q.answer)
const second = guard.addRequest({ flag: 'f2', userId: 1002 })
check('id 递增', second.id === 2)
check('size 正确', guard.size === 2)
check('缺 flag 返回 null', guard.addRequest({ userId: 1003 }) === null)

const listed = guard.list()
check('list 含剩余秒数', listed.length === 2 && listed[0].remainingSeconds === 300, JSON.stringify(listed[0]))
check('list 按 id 升序', listed[0].id === 1 && listed[1].id === 2)

// 队列上限
guard.addRequest({ flag: 'f3', userId: 1003 })
check('队列满后拒绝新请求', guard.addRequest({ flag: 'f4', userId: 1004 }) === null && guard.size === 3)

// 查找与处理
check('按 id 查找', guard.find(1)?.flag === 'f1')
check('按 flag 查找', guard.find('f2')?.userId === 1002)
check('找不到返回 null', guard.find(99) === null && guard.find('') === null)
const resolved = guard.resolve(1, true, { reason: 'ok' })
check('resolve 按 id 成功', resolved.ok === true && resolved.entry.flag === 'f1')
check('resolve 后出队', guard.size === 2 && guard.find(1) === null)
const resolvedByFlag = guard.resolve('f2', false, { reason: '广告号' })
check('resolve 按 flag 成功', resolvedByFlag.ok === true && resolvedByFlag.approved === false && resolvedByFlag.reason === '广告号')
check('重复处理报错', guard.resolve(1, true).ok === false && guard.resolve(1, true).error === '没有这个待处理请求')

// 超时清理
clock += 299_000
check('未到期不清理', guard.expire().length === 0 && guard.size === 1)
clock += 2_000
const expired = guard.expire()
check('到期被清理', expired.length === 1 && expired[0].flag === 'f3' && guard.size === 0)
check('过期条目 v0 不在列表中', guard.list().length === 0)

// clear
guard.addRequest({ flag: 'f9', userId: 1009 })
guard.clear()
check('clear 清空队列', guard.size === 0)

// ---- 命令解析 ----
check('/同意 1', (() => { const c = parseVerifyCommand('/同意 1'); return c.action === 'approve' && c.target === '1' })())
check('/通过 3', parseVerifyCommand('/通过 3').action === 'approve')
check('/批准 2', parseVerifyCommand('/批准 2').action === 'approve')
check('/拒绝 2', (() => { const c = parseVerifyCommand('/拒绝 2'); return c.action === 'reject' && c.target === '2' })())
check('/驳回 2', parseVerifyCommand('/驳回 2').action === 'reject')
check('/同意 all', parseVerifyCommand('/同意 all').target === 'all')
check('/待审', (() => { const c = parseVerifyCommand('/待审'); return c.action === 'list' && c.target === '' })())
check('/审核', parseVerifyCommand('/审核').action === 'list')
check('/同意（无序号）', (() => { const c = parseVerifyCommand('/同意'); return c.action === 'approve' && c.target === '' })())
check('无关文本返回 null', parseVerifyCommand('同意一下') === null && parseVerifyCommand('') === null)

// ---- 文案 ----
check('空列表文案', formatPendingList([]).includes('暂无待处理请求'))
const listText = formatPendingList(listed)
check('列表含序号与剩余时间', listText.includes('#1') && listText.includes('剩余'), listText.replace(/\n/g, ' | '))
const prompt = formatJoinPrompt({ ...first.entry }, { groupName: '测试群' })
check('提示含群名与命令', prompt.includes('测试群') && prompt.includes('/同意 1'), prompt.replace(/\n/g, ' | '))
check('好友请求文案', formatJoinPrompt({ ...second.entry }).includes('加好友'))
check('空条目返回空串', formatJoinPrompt(null) === '')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
