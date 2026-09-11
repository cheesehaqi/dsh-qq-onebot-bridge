/** Unit tests for the points economy store and leaderboard formatting (no network). */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PointsStore, formatLeaderboard } from '../lib/points.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const DAY = 86_400_000
const now = new Date()
const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0, 0).getTime()
const day2 = base + DAY
const day3 = base + 2 * DAY

const dir = mkdtempSync(join(tmpdir(), 'qq-points-test-'))
const store = new PointsStore(dir)
const chat = 'g:100'

// 空账本
check('无记录余额为 0', store.balance(chat, '111') === 0)
check('空账本排行榜为空', store.leaderboard(chat).length === 0)
check('setName 可写空账本', store.setName(chat, '111', '小明') === true)

// 加分
const b1 = store.add(chat, '111', 10, { name: '小明' })
check('add 返回新余额 10', b1 === 10, String(b1))
check('add 累加余额 15', store.add(chat, '111', 5) === 15)
check('add 非法金额返回原余额', store.add(chat, '111', 'abc') === 15 && store.add(chat, '111', 1.5) === 15)
check('add 负数减持到 0', store.add(chat, '111', -15) === 0)
check('add 超过余额的负数被拒', store.add(chat, '111', -1) === 0 && store.balance(chat, '111') === 0)

// 转账
store.add(chat, '111', 50)
const okTransfer = store.transfer(chat, '111', '222', 20)
check('转账成功', okTransfer.ok === true && okTransfer.error === '', JSON.stringify(okTransfer))
check('转账后双方余额', store.balance(chat, '111') === 30 && store.balance(chat, '222') === 20)
const selfTransfer = store.transfer(chat, '111', '111', 1)
check('不能转给自己', selfTransfer.ok === false && selfTransfer.error === '不能转给自己')
const badAmount = store.transfer(chat, '111', '222', -5)
check('金额非法（负数）', badAmount.ok === false && badAmount.error === '金额非法')
const badAmount2 = store.transfer(chat, '111', '222', '五块')
check('金额非法（非数字）', badAmount2.ok === false && badAmount2.error === '金额非法')
const poor = store.transfer(chat, '111', '222', 999)
check('余额不足', poor.ok === false && poor.error === '余额不足' && poor.fromBalance === 30)
check('转账失败余额不变', store.balance(chat, '111') === 30 && store.balance(chat, '222') === 20)

// 每日奖励：同一自然日只发一次
const d1 = store.dailyBonus(chat, '333', { amount: 5, now: base })
check('每日奖励首次发放', d1.granted === true && d1.amount === 5, JSON.stringify(d1))
const d2 = store.dailyBonus(chat, '333', { amount: 5, now: base + 3_600_000 })
check('每日奖励同日不重复', d2.granted === false && d2.amount === 0)
check('每日奖励余额只加一次', store.balance(chat, '333') === 5)
const d3 = store.dailyBonus(chat, '333', { amount: 5, now: day2 })
check('每日奖励次日再发', d3.granted === true && d3.amount === 5 && store.balance(chat, '333') === 10)

// 发言积分：每自然日封顶（dailyCap 是每天封顶点数，amount=2 配合 cap=6 即最多 3 次）
let granted = 0
let lastMessage = null
for (let i = 0; i < 5; i++) {
  lastMessage = store.messageBonus(chat, '444', { amount: 2, dailyCap: 6, now: base })
  if (lastMessage.granted) granted++
}
check('发言积分封顶 3 次', granted === 3, JSON.stringify(lastMessage))
check('发言积分达上限不再发', lastMessage.granted === false && lastMessage.amount === 0)
check('发言积分余额正确 6', store.balance(chat, '444') === 6)
const nextDayMessage = store.messageBonus(chat, '444', { amount: 2, dailyCap: 6, now: day3 })
check('发言积分次日重置', nextDayMessage.granted === true && store.balance(chat, '444') === 8)

// 排行榜排序（bbb 99 / 小明 30 / ccc 20 / ddd 6 / eee 8）
store.add(chat, '555', 99, { name: 'bbb' })
store.add(chat, '666', 20, { name: 'ccc' })
store.add(chat, '777', 6)
store.add(chat, '888', 8, { name: 'eee' })
const board = store.leaderboard(chat, 3)
check('排行榜按积分降序', board[0]?.points === 99 && board[1]?.points === 30 && board[2]?.points === 20, JSON.stringify(board))
check('排行榜 limit 生效', board.length === 3)
check('排行榜带昵称', board[0]?.name === 'bbb')
check('未命名用户回退为 userId', store.leaderboard(chat, 20).find((r) => r.userId === '777')?.name === '777')

// 重载：新建同一个 store 实例读同一目录
const reopened = new PointsStore(dir)
check('重载后余额仍在', reopened.balance(chat, '555') === 99)
const file = join(dir, 'g_100.json')
check('数据文件已落盘为 JSON', JSON.parse(readFileSync(file, 'utf8')).balances['555'] === 99)
check('重载后排行榜一致', reopened.leaderboard(chat)[0]?.userId === '555')
const reopenedDaily = reopened.dailyBonus(chat, '333', { amount: 5, now: day2 })
check('重载后当日奖励不重复', reopenedDaily.granted === false)

// 原子写不产生残留临时文件
check('无残留 .tmp 文件', readdirSync(dir).filter((n) => n.endsWith('.tmp')).length === 0, JSON.stringify(readdirSync(dir)))
check('只写出一个会话文件', readdirSync(dir).filter((n) => n.endsWith('.json')).length === 1)

// 损坏文件容错
const brokenDir = mkdtempSync(join(tmpdir(), 'qq-points-broken-'))
writeFileSync(join(brokenDir, 'g_bad.json'), '{ 坏的 JSON', 'utf8')
const broken = new PointsStore(brokenDir)
check('损坏文件余额返回 0', broken.balance('g:bad', '111') === 0)
check('损坏文件排行榜为空', broken.leaderboard('g:bad').length === 0)
check('损坏文件上仍可写入', broken.add('g:bad', '111', 3) === 3 && broken.balance('g:bad', '111') === 3)
check('损坏文件上转账可恢复', broken.transfer('g:bad', '111', '222', 1).ok === true)
rmSync(brokenDir, { recursive: true, force: true })

// 排行榜文案
check('第一名带 🥇', formatLeaderboard([{ userId: '1', name: '甲', points: 30 }]).includes('🥇'))
const text = formatLeaderboard([
  { userId: '1', name: '甲', points: 30 },
  { userId: '2', name: '乙', points: 20 },
  { userId: '3', name: '丙', points: 10 },
])
check('前三名奖牌齐全', text.includes('🥇') && text.includes('🥈') && text.includes('🥉'))
check('排行榜含标题与分数', text.startsWith('💰 积分排行榜') && text.includes('甲 30 分'))
check('第四名用序号', formatLeaderboard([{ userId: '1', name: 'a', points: 4 }, { userId: '2', name: 'b', points: 3 }, { userId: '3', name: 'c', points: 2 }, { userId: '4', name: 'd', points: 1 }]).includes('4. d 1 分'))
check('空榜有中文提示', formatLeaderboard([]).includes('暂无积分记录'))
check('自定义标题生效', formatLeaderboard([], '🏆 群积分').startsWith('🏆 群积分'))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
