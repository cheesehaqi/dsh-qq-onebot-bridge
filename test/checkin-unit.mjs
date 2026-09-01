/** Unit tests for daily check-in store and intent parsing (no network). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckinStore, isCheckinIntent, isCheckinBoardIntent } from '../lib/checkin.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-checkin-test-'))
const store = new CheckinStore(dir)

// 第一天签到
const r1 = store.checkin('g:100', 111, '小明')
check('首次签到 firstToday', r1.firstToday === true, JSON.stringify(r1))
check('首次签到 streak=1', r1.streak === 1)
check('首次签到 total=1', r1.total === 1)

// 同日重复签到：不重复计数
const r2 = store.checkin('g:100', 111, '小明')
check('同日重复 firstToday=false', r2.firstToday === false)
check('同日重复 streak 不变', r2.streak === 1 && r2.total === 1)

// 换一天（模拟昨天的记录回填后连续签到）
const dataFile = join(dir, 'g_100.json')
const fs = await import('node:fs')
const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
data[111].last = CheckinStore.yesterday()
fs.writeFileSync(dataFile, JSON.stringify(data))
const r3 = store.checkin('g:100', 111, '小明')
check('连续第二天 streak=2', r3.streak === 2, JSON.stringify(r3))
check('连续第二天 total=2', r3.total === 2)

// 断签：把 last 改成两天前，重新签到 streak 重置
const data2 = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
const d = new Date(Date.now() - 3 * 86_400_000)
data2[111].last = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
fs.writeFileSync(dataFile, JSON.stringify(data2))
const r4 = store.checkin('g:100', 111, '小明')
check('断签后 streak 重置为 1', r4.streak === 1)
check('断签后 total 继续累计=3', r4.total === 3)

// 多用户 + 排行榜排序（张三连签 5 天、李四连签 3 天、王五只累计 2 天）
const g2 = new CheckinStore(join(dir, 'g2'))
let lastDay = CheckinStore.yesterday()
for (let i = 0; i < 5; i++) {
  const data3 = (() => { try { return JSON.parse(fs.readFileSync(join(dir, 'g2', 'g_200.json'), 'utf8')) } catch { return {} } })()
  const entry = data3[222] ?? { name: '张三', total: 0, streak: 0, last: '' }
  const day = new Date(Date.now() - (4 - i) * 86_400_000)
  const dayStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  entry.last = dayStr
  entry.streak = i + 1
  entry.total = i + 1
  entry.name = '张三'
  data3[222] = entry
  fs.mkdirSync(join(dir, 'g2'), { recursive: true })
  fs.writeFileSync(join(dir, 'g2', 'g_200.json'), JSON.stringify(data3))
}
g2.checkin('g:200', 222, '张三')
g2.checkin('g:200', 333, '李四')
g2.checkin('g:200', 444, '王五')
const board = g2.board('g:200', 10)
check('排行榜第一名是张三', board[0]?.userId === '222', JSON.stringify(board))
check('排行榜含今日标记', board[0]?.today === true)
check('排行榜按 streak 排序', board[0].streak >= board[1].streak)

// 意图解析
check('签到 命中', isCheckinIntent('签到', '签到'))
check('签到！ 命中', isCheckinIntent('签到！', '签到'))
check('打卡 用自定义关键词', isCheckinIntent('打卡', '打卡'))
check('杂句不命中', !isCheckinIntent('我今天签到过了', '签到'))
check('空文本不命中', !isCheckinIntent('', '签到'))
check('签到榜 命中', isCheckinBoardIntent('签到榜') && isCheckinBoardIntent('/签到榜'))
check('签到排行 命中', isCheckinBoardIntent('签到排行'))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
