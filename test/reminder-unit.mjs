/** Unit-test reminder time parsing (no network). */
import { parseReminder } from '../lib/reminders.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const now = Date.now()
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

// relative offsets
const r1 = parseReminder('30分钟后提醒我喝水', true)
check('30分钟相对时间', r1 && Math.abs(r1.dueAt - now - 30 * MIN) < 5_000, r1 && r1.dueAt - now)
check('30分钟内容提取', r1?.content === '喝水', r1?.content)

const r2 = parseReminder('提醒我 2小时后写周报', true)
check('2小时相对时间', r2 && Math.abs(r2.dueAt - now - 2 * HOUR) < 5_000)
check('2小时内容提取', r2?.content === '写周报', r2?.content)

const r3 = parseReminder('45秒后提醒测试', true)
check('45秒相对时间', r3 && Math.abs(r3.dueAt - now - 45_000) < 2_000)
check('45秒内容提取', r3?.content === '测试', r3?.content)

// absolute times
const r4 = parseReminder('后天 20:30 提醒我生日', true)
const d4 = r4 ? new Date(r4.dueAt) : null
check('后天20:30', r4 && d4.getHours() === 20 && d4.getMinutes() === 30 && d4.getDate() === new Date(now + 2 * DAY).getDate(), d4 && d4.toString())

const r5 = parseReminder('9点半喊我吃饭', true)
const d5 = r5 ? new Date(r5.dueAt) : null
check('9点半', r5 && d5.getHours() === 9 && d5.getMinutes() === 30, d5 && d5.toString())
check('9点半内容提取', r5?.content === '吃饭', r5?.content)

// keyword-free (group @ mention)
const r6 = parseReminder('明天9点开会', false)
check('无关键词但允许（群@）', r6 && r6.content === '开会', JSON.stringify(r6))

// keyword required (private)
check('私聊无关键词不识别', parseReminder('明天9点开会', true) === null)

// non-reminder text
check('普通消息不识别', parseReminder('随便聊聊今天天气', false) === null)
check('无时间短语但有词不识别', parseReminder('提醒我别忘了吃饭', true) === null)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
