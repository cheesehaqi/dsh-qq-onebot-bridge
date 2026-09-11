/** Unit-test reminder time parsing (no network). */
import { describeRecurrence, nextRecurrenceAt, parseRecurrence, parseRecurringReminder, parseReminder } from '../lib/reminders.js'

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

// ---- 重复提醒（v0.3.9）----
const base = new Date(2026, 8, 11, 10, 0, 0).getTime() // 2026-09-11 10:00 周五
const daily = parseRecurrence('每天8点提醒我喝水')
check('每天解析', daily && daily.kind === 'daily' && daily.hour === 8 && daily.minute === 0, JSON.stringify(daily))
check('每个工作日解析', parseRecurrence('每个工作日15点打卡')?.kind === 'weekday')
check('每周一解析', (() => { const r = parseRecurrence('每周一9点开会'); return r?.kind === 'weekly' && r.weekday === 1 && r.hour === 9 })())
check('每周日解析', parseRecurrence('每周日晚上8点')?.weekday === 0)
check('下午修正小时', parseRecurrence('每天下午3点')?.hour === 15)
check('晚上修正小时', parseRecurrence('每天晚上8点半')?.hour === 20 && parseRecurrence('每天晚上8点半')?.minute === 30)
check('缺时间返回 null', parseRecurrence('每天提醒我') === null)
check('非重复返回 null', parseRecurrence('明天9点开会') === null)

check('下一次每天触发', (() => { const at = nextRecurrenceAt({ kind: 'daily', hour: 8, minute: 0 }, base); const d = new Date(at); return d.getDate() === 12 && d.getHours() === 8 })())
check('当天未到则当天触发', (() => { const at = nextRecurrenceAt({ kind: 'daily', hour: 20, minute: 0 }, base); return new Date(at).getDate() === 11 })())
check('每周一从周五看是下周一', (() => { const at = nextRecurrenceAt({ kind: 'weekly', weekday: 1, hour: 9, minute: 0 }, base); const d = new Date(at); return d.getDay() === 1 && d.getDate() === 14 })())
check('工作日跳过周末', (() => { const at = nextRecurrenceAt({ kind: 'weekday', hour: 9, minute: 0 }, new Date(2026, 8, 12, 10, 0, 0).getTime()); return new Date(at).getDay() === 1 })())
check('描述文案', describeRecurrence({ kind: 'daily', hour: 8, minute: 5 }) === '每天 08:05')
check('描述工作日', describeRecurrence({ kind: 'weekday', hour: 15, minute: 0 }) === '每个工作日 15:00')
check('描述每周', describeRecurrence({ kind: 'weekly', weekday: 1, hour: 9, minute: 0 }) === '每周一 09:00')

const recurring = parseRecurringReminder('每天8点提醒我喝水', true, base)
check('重复提醒整体解析', recurring && recurring.kind === 'daily' && recurring.content === '喝水' && recurring.nextAt > base, JSON.stringify(recurring))
check('重复提醒内容剥净', !/每天|提醒|8点/.test(recurring.content), recurring.content)
check('一次性提醒不吃重复语法', parseReminder('每天8点提醒我喝水', true) === null)
check('无重复语法时返回 null', parseRecurringReminder('明天9点开会', false, base) === null)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
