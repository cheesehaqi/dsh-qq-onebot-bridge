/**
 * 群关键词订阅：命令解析、存储上限/去重/删除、匹配与冷却。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WATCH_COOLDOWN_MS, WatchStore, findWatchMatches, parseWatchCommand } from '../lib/watch.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS', name, extra) }
  else { failed += 1; console.log('FAIL', name, extra) }
}

check('订阅命令：添加', parseWatchCommand('/订阅 显卡')?.action === 'add' && parseWatchCommand('/订阅 显卡')?.keyword === '显卡')
check('订阅命令：列表', parseWatchCommand('/订阅')?.action === 'list' && parseWatchCommand('/订阅 列表')?.action === 'list')
check('订阅命令：取消', parseWatchCommand('/取消订阅 显卡')?.action === 'remove' && parseWatchCommand('/取消订阅 显卡')?.keyword === '显卡')
check('订阅命令：非命令返回 null', parseWatchCommand('订阅 显卡') === null)

const dir = mkdtempSync(join(tmpdir(), 'qq-watch-'))
const store = new WatchStore(dir)
check('订阅：添加成功并落盘', store.add('g:1', { keyword: '显卡', userId: 1, name: '甲' }).ok === true
  && new WatchStore(dir).list('g:1').length === 1)
check('订阅：同人同词去重', store.add('g:1', { keyword: '显卡', userId: 1 }).ok === false)
check('订阅：短词拒绝', store.add('g:1', { keyword: 'a', userId: 1 }).ok === false)
check('订阅：不同人可订阅同词', store.add('g:1', { keyword: '显卡', userId: 2 }).ok === true)
check('订阅：列表隔离', store.list('g:2').length === 0)
const matches = findWatchMatches(store.list('g:1'), '今天显卡降价了', { senderId: 9, now: 10 * 60_000 })
check('匹配：命中并排除发送者', matches.length === 2 && matches.every((item) => item.keyword === '显卡'))
check('匹配：发送者自己不发', findWatchMatches(store.list('g:1'), '显卡', { senderId: 1, now: 10 * 60_000 }).every((item) => item.userId !== 1))
store.touch('g:1', [matches[0].id], 10 * 60_000)
check('匹配：冷却期内不重复', findWatchMatches(store.list('g:1'), '显卡', { senderId: 9, now: 10 * 60_000 + 1000 }).length === 1)
check('匹配：冷却过期后再提醒', findWatchMatches(store.list('g:1'), '显卡', { senderId: 9, now: 10 * 60_000 + WATCH_COOLDOWN_MS }).length === 2)
check('取消：删除成功', store.remove('g:1', { keyword: '显卡', userId: 1 }).ok === true && store.list('g:1').length === 1)
check('取消：不存在报原因', store.remove('g:1', { keyword: '不存在', userId: 1 }).ok === false)

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
