/** Unit tests for the group activity stats store and its formatters (no network). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatsStore, dayKey, formatActivity, formatHonor, pickReportTargets } from '../lib/stats.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-stats-test-'))
const store = new StatsStore(dir, { keepDays: 3 })
const day1 = new Date(2026, 8, 11, 12, 0, 0).getTime() // 2026-09-11
const day2 = day1 + 86_400_000
const day3 = day2 + 86_400_000
const day4 = day3 + 86_400_000

check('dayKey 本地日期', dayKey(day1) === '2026-09-11', dayKey(day1))
check('无记录时榜单为空', store.top('g:1', { now: day1 }).length === 0)
check('无记录时总数为 0', store.total('g:1', day1) === 0)

check('第一条发言计数 1', store.record('g:1', 111, '小明', day1) === 1)
check('第二条发言计数 2', store.record('g:1', 111, '小明', day1) === 2)
store.record('g:1', 222, '小红', day1)
store.record('g:1', 333, '', day1)
check('当日总数 4', store.total('g:1', day1) === 4)

const top1 = store.top('g:1', { now: day1 })
check('榜单排序正确', top1[0].userId === '111' && top1[0].count === 2, JSON.stringify(top1))
check('榜单带昵称', top1[0].name === '小明')
check('无昵称回退到 QQ 号', top1.find((row) => row.userId === '333').name === '333')

// 跨天
store.record('g:1', 222, '小红', day2)
store.record('g:1', 222, '小红', day2)
const topDay2 = store.top('g:1', { now: day2 })
check('单日榜单只看当天', topDay2.length === 1 && topDay2[0].userId === '222' && topDay2[0].count === 2, JSON.stringify(topDay2))
const topBoth = store.top('g:1', { days: 2, now: day2 })
check('多日累计', topBoth.find((row) => row.userId === '111').count === 2 && topBoth.find((row) => row.userId === '222').count === 3, JSON.stringify(topBoth))
check('榜单 limit 生效', store.top('g:1', { days: 2, limit: 1, now: day2 }).length === 1)

// 会话隔离
store.record('g:2', 999, '别的群', day1)
check('不同会话互不影响', store.top('g:2', { now: day1 }).length === 1 && store.top('g:1', { now: day1 }).length === 3)

// 持久化 + 日期裁剪
const reopened = new StatsStore(dir, { keepDays: 3 })
check('重新打开仍能读到', reopened.total('g:1', day1) === 4)
reopened.record('g:1', 111, '小明', day2)
reopened.record('g:1', 111, '小明', day3)
reopened.record('g:1', 111, '小明', day4)
const days = reopened.dayList('g:1')
check('按 keepDays 裁剪旧日期', days.length <= 3 && !days.includes('2026-09-11'), days.join(','))

// 文案
check('formatActivity 空态', formatActivity([]).includes('还没有统计到发言'))
const text = formatActivity(top1)
check('formatActivity 含前三名奖牌', text.includes('🥇') && text.includes('🥈') && text.includes('🥉'), text.replace(/\n/g, ' | '))
check('formatActivity 含条数', text.includes('2 条'))

// 群荣誉
check('formatHonor 空值容错', formatHonor(null).includes('拿不到'))
check('formatHonor 龙王', formatHonor({ current_talkative: [{ name: '小明' }] }).includes('龙王：小明'))
const honorText = formatHonor({
  current_talkative: [{ name: 'A' }],
  current_performer: [{ name: 'B' }],
  current_legend: [{ name: 'C' }],
  current_emotion: [{ name: 'D' }],
}, { groupName: '测试群' })
check('formatHonor 多段', ['龙王：A', '群聊之火：B', '群聊炽焰：C', '快乐源泉：D'].every((line) => honorText.includes(line)), honorText.replace(/\n/g, ' | '))
check('formatHonor 群名', honorText.includes('测试群'))
check('formatHonor 缺字段只显示已有', formatHonor({ current_emotion: [{ user_id: 42 }] }).includes('快乐源泉：42'))

// ---- 日报目标选择 ----
check('无配置时回落到群白名单', JSON.stringify(pickReportTargets({ allowGroups: [1, 2] })) === JSON.stringify(['g:1', 'g:2']))
check('显式配置优先于白名单', JSON.stringify(pickReportTargets({ configured: ['g:9'], allowGroups: [1] })) === JSON.stringify(['g:9']))
check('自助开关与配置合并去重', JSON.stringify(pickReportTargets({ configured: [9], optIn: ['g:9', 'g:10'] })) === JSON.stringify(['g:9', 'g:10']))
check('数字补 g: 前缀', pickReportTargets({ configured: [100000001] })[0] === 'g:100000001')
check('空字符串被忽略', pickReportTargets({ configured: ['', '  '], allowGroups: [5] }).join(',') === 'g:5')

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
