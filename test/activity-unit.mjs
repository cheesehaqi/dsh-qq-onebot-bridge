/**
 * 群活跃看板：聚合与归档读取的纯函数测试。
 *
 * 口径：只认 `g:<群>` / `u:<人>`；只统计时间窗内；只返回计数与名字，不碰消息原文。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activityDayKey, aggregateActivity, readActivity, startOfLocalDay } from '../control/lib/activity.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS', name, extra) }
  else { failed += 1; console.log('FAIL', name, extra) }
}

const now = new Date(2026, 10, 10, 12, 0, 0).getTime()
const today = activityDayKey(now)
const yesterday = activityDayKey(now - 86_400_000)
const old = activityDayKey(now - 40 * 86_400_000)

const records = [
  { ts: now - 1000, chatKey: 'g:100', userId: 1001, name: '阿甲', text: '不该被读到' },
  { ts: now - 2000, chatKey: 'g:100', userId: 1001, name: '阿甲', text: '不该被读到' },
  { ts: now - 3000, chatKey: 'g:100', userId: 1002, name: '阿乙', text: '不该被读到' },
  { ts: now - 86_400_000, chatKey: 'g:100', userId: 1001, name: '阿甲', text: '不该被读到' },
  { ts: now - 4000, chatKey: 'g:200', userId: 1003, name: '阿丙', text: '不该被读到' },
  { ts: now - 5000, chatKey: 'u:9001', userId: 9001, name: '私聊', text: '不该被读到' },
  { ts: now - 40 * 86_400_000, chatKey: 'g:100', userId: 1001, name: '阿甲', text: '不该被读到' },
  { ts: 'bad', chatKey: 'g:100', userId: 1001 },
  { ts: now, chatKey: 'weird', userId: 1001 },
]
const result = aggregateActivity(records, { days: 7, now, topMembers: 2 })
check('只统计时间窗内的合法会话键', result.total === 6, String(result.total))
check('群与私聊分开', result.groups.length === 2 && result.privates.length === 1, `${result.groups.length}/${result.privates.length}`)
check('按消息量降序：g:100 有 4 条', result.groups[0].chatKey === 'g:100' && result.groups[0].total === 4, JSON.stringify(result.groups[0]))
check('最活跃成员取前 2：阿甲 3 条', result.groups[0].topMembers[0].name === '阿甲' && result.groups[0].topMembers[0].count === 3, JSON.stringify(result.groups[0].topMembers))
check('daily 固定 7 天且今天/昨天有数', result.groups[0].daily.length === 7
  && result.groups[0].daily.find((day) => day.day === today).count === 3
  && result.groups[0].daily.find((day) => day.day === yesterday).count === 1, JSON.stringify(result.groups[0].daily))
check('不返回消息原文', !JSON.stringify(result).includes('不该被读到'))

// 读盘：只读时间窗内的日期文件，坏行跳过，不存在目录不抛错
const dir = mkdtempSync(join(tmpdir(), 'qq-activity-'))
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `${today}.jsonl`), [
  JSON.stringify({ ts: now - 1000, chatKey: 'g:300', userId: 1, name: '甲', text: 'x' }),
  JSON.stringify({ ts: now - 2000, chatKey: 'g:300', userId: 1, name: '甲', text: 'x' }),
  '{坏行',
].join('\n'), 'utf8')
writeFileSync(join(dir, `${yesterday}.jsonl`), JSON.stringify({ ts: now - 86_400_000, chatKey: 'g:300', userId: 2, name: '乙', text: 'x' }) + '\n', 'utf8')
writeFileSync(join(dir, `${old}.jsonl`), JSON.stringify({ ts: now - 40 * 86_400_000, chatKey: 'g:300', userId: 3, name: '丙', text: 'x' }) + '\n', 'utf8')

const read = readActivity(dir, { days: 7, now })
check('读取只扫时间窗内的文件', read.scanned.files === 2 && read.groups.length === 1, JSON.stringify(read.scanned))
check('读取聚合 3 条（坏行跳过）', read.groups[0].total === 3, String(read.groups[0]?.total))
check('缺失目录返回空而不是抛错', (() => {
  const missing = readActivity(join(dir, 'nope'), { days: 7, now })
  return missing.ok === true && missing.missing === true && missing.chats.length === 0
})())
check('时间窗夹在 1–30 天', aggregateActivity([], { days: -5, now }).days === 1 && aggregateActivity([], { days: 99, now }).days === 30)
check('startOfLocalDay 归零到当天 0 点', new Date(startOfLocalDay(now)).getHours() === 0)

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
