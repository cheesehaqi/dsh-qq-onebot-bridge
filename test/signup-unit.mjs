/**
 * 群活动报名：命令解析、开始/报名/取消/列表/结束、持久化。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SIGNUP_MAX_ENTRIES, SignupStore, parseSignupCommand } from '../lib/signup.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS', name, extra) }
  else { failed += 1; console.log('FAIL', name, extra) }
}

check('报名命令：开始带活动名', parseSignupCommand('/报名 周末爬山')?.action === 'start' && parseSignupCommand('/报名 周末爬山')?.title === '周末爬山')
check('报名命令：无参数=报名', parseSignupCommand('/报名')?.action === 'join')
check('报名命令：列表', parseSignupCommand('/报名列表')?.action === 'list' && parseSignupCommand('/报名 列表')?.action === 'list')
check('报名命令：结束', parseSignupCommand('/报名结束')?.action === 'close')
check('报名命令：取消', parseSignupCommand('/取消报名')?.action === 'leave')
check('报名命令：非命令返回 null', parseSignupCommand('报名 周末爬山') === null)
check('报名命令：活动名过长报错', Boolean(parseSignupCommand(`/报名 ${'x'.repeat(41)}`)?.error))

const dir = mkdtempSync(join(tmpdir(), 'qq-signup-'))
const store = new SignupStore(dir)
const started = store.start('g:1', { title: '周末爬山', creatorId: 1, creatorName: '甲' })
check('报名：开始并落盘', started.ok === true && new SignupStore(dir).load('g:1')?.title === '周末爬山')
check('报名：重复开始被拒', store.start('g:1', { title: '另一个', creatorId: 2 }).ok === false)
check('报名：加入成功并编号', store.join('g:1', { userId: 2, name: '乙' }).index === 1)
check('报名：重复加入被拒', store.join('g:1', { userId: 2, name: '乙' }).ok === false)
check('报名：列表保留名字', store.load('g:1').entries[0].name === '乙')
check('报名：非发起人不能结束', store.close('g:1', { userId: 2 }).ok === false)
check('报名：取消成功', store.leave('g:1', { userId: 2 }).ok === true && store.load('g:1').entries.length === 0)
check('报名：发起人结束', store.close('g:1', { userId: 1 }).ok === true && store.load('g:1').closed === true)
check('报名：结束后不能再加入', store.join('g:1', { userId: 3 }).ok === false)
check('报名：人数上限常量', SIGNUP_MAX_ENTRIES >= 10)

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
