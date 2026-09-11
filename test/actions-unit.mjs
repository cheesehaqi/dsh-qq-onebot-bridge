/** Unit tests for the write-action gate and the atomic JSON store (no network). */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActionGate, DEFAULT_ACTION_LIMITS } from '../lib/actions.js'
import { JsonStore, readJson, writeJsonAtomic, appendCappedLine } from '../lib/store.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-actions-test-'))
const auditFile = join(dir, 'qq-actions.log')

// ---- ActionGate ----
let clock = 1_700_000_000_000
const gate = new ActionGate({ auditFile, limits: { custom: { perMinute: 2, perDay: 3 } }, perMinute: 0, perDay: 0, now: () => clock })

check('首次检查放行', gate.check('custom', 'g:1').ok === true)
gate.commit('custom', 'g:1', 'first')
check('一次后仍放行', gate.check('custom', 'g:1').ok === true)
gate.commit('custom', 'g:1', 'second')
const third = gate.check('custom', 'g:1')
check('每分钟上限拒绝第三次', third.ok === false && third.reason.includes('每分钟'), JSON.stringify(third))

clock += 61_000
check('窗口过去后恢复', gate.check('custom', 'g:1').ok === true)
gate.commit('custom', 'g:1', 'third')
const fourth = gate.check('custom', 'g:1')
check('每日上限仍生效', fourth.ok === false && fourth.reason.includes('今日'), JSON.stringify(fourth))

// 不同会话互不影响
check('不同 chatKey 互不影响', gate.check('custom', 'g:2').ok === true)

// 默认限额表
const gate2 = new ActionGate({ now: () => clock })
check('send_like 默认每分钟 1 次', DEFAULT_ACTION_LIMITS.send_like.perMinute === 1)
gate2.commit('send_like', 'u:1')
check('send_like 第二次被拒', gate2.check('send_like', 'u:1').ok === false)
check('未知动作走 default 限额', gate2.check('some_new_action', 'g:9').ok === true)

// 全局闸门
const gate3 = new ActionGate({ perMinute: 2, perDay: 100, now: () => clock })
gate3.commit('a', 'k1')
gate3.commit('b', 'k2')
const globalDenied = gate3.check('c', 'k3')
check('全局每分钟上限生效', globalDenied.ok === false && globalDenied.reason.includes('全局'), JSON.stringify(globalDenied))
clock += 61_000
check('全局窗口滚动后恢复', gate3.check('c', 'k3').ok === true)

// run()：允许时执行、拒绝时跳过
const gate4 = new ActionGate({ auditFile, limits: { blocked: { perMinute: 0, perDay: 1 } }, now: () => clock })
let calls = 0
const first = await gate4.run('blocked', 'g:5', 'x', async () => { calls++; return 'done' })
const second = await gate4.run('blocked', 'g:5', 'x', async () => { calls++; return 'done' })
check('run 允许时执行一次', first.ok === true && first.value === 'done' && calls === 1)
check('run 拒绝时跳过', second.ok === false && second.skipped === true && calls === 1)
check('run 拒绝计数', gate4.denied === 1)

// fn 抛错要冒泡
let threw = false
try {
  await gate4.run('unknown', 'g:5', '', async () => { throw new Error('boom') })
} catch { threw = true }
check('run 内部异常冒泡', threw)

// 审计日志
const log = readFileSync(auditFile, 'utf8')
check('审计日志记录动作', log.includes('custom g:1 first'))
check('审计日志记录拒绝', log.includes('DENIED'))
check('snapshot 统计动作数', gate4.snapshot().tracked >= 1 && typeof gate4.snapshot().denied === 'number')

// ---- JsonStore / 原子写 ----
const storeFile = join(dir, 'nested', 'qq-sessions.json')
const store = new JsonStore(storeFile, { fallback: {} })
check('缺失文件返回 fallback', Object.keys(store.read()).length === 0)
store.mutate((data) => { data['g:1'] = 'qq-abc' })
check('mutate 后写入文件', JSON.parse(readFileSync(storeFile, 'utf8'))['g:1'] === 'qq-abc')
check('新建实例能读回', new JsonStore(storeFile, { fallback: {} }).read()['g:1'] === 'qq-abc')

// 外部改动后自动重载
clock += 1000
writeFileSync(storeFile, JSON.stringify({ 'g:2': 'qq-def' }), 'utf8')
check('文件变化后重载', store.read()['g:2'] === 'qq-def')

// 损坏 JSON 容错
writeFileSync(storeFile, '{ broken', 'utf8')
check('损坏 JSON 返回 fallback', Object.keys(store.read()).length === 0)
check('readJson 容错', readJson(join(dir, 'missing.json'), { ok: 1 }).ok === 1)

// 原子写不产生临时残留
const atomicFile = join(dir, 'atomic.json')
writeJsonAtomic(atomicFile, { a: 1 })
const leftovers = readFileSync(atomicFile, 'utf8')
check('原子写内容正确', JSON.parse(leftovers).a === 1)
check('原子写无 .tmp 残留', !readFileSync(atomicFile, 'utf8').includes('.tmp'))

// clear
store.write({ x: 1 })
store.clear()
check('clear 删除文件', (() => { try { statSync(storeFile); return false } catch { return true } })())

// appendCappedLine 轮转
const capFile = join(dir, 'cap.log')
for (let i = 0; i < 40; i++) appendCappedLine(capFile, `line-${i}-${'x'.repeat(50)}`, { maxBytes: 500, keepBytes: 200 })
const capSize = statSync(capFile).size
check('日志轮转后体积受限', capSize < 1000, `${capSize} bytes`)

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
