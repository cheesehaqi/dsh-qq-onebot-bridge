/** Unit tests for fortune module: 人品 / 抽签 / 塔罗 (no network). */
import {
  dailyFortune, drawLot, drawTarot,
  formatFortune, formatLot, formatTarot,
  todayKey, parseFortuneIntent
} from '../lib/fortune.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const DAY_A = new Date(2024, 4, 1, 10, 0, 0) // 本地时间 2024-05-01
const DAY_B = new Date(2024, 4, 2, 10, 0, 0) // 本地时间 2024-05-02
const DAY_C = new Date(2025, 0, 9, 23, 59, 0)

const TAROT_NAMES = [
  '愚者', '魔术师', '女祭司', '皇后', '皇帝', '教皇', '恋人', '战车', '力量', '隐者', '命运之轮',
  '正义', '倒吊人', '死神', '节制', '恶魔', '高塔', '星星', '月亮', '太阳', '审判', '世界'
]

// todayKey
check('todayKey 本地日期格式', todayKey(DAY_A) === '2024-05-01', todayKey(DAY_A))
check('todayKey 补零', todayKey(DAY_C) === '2025-01-09', todayKey(DAY_C))

// dailyFortune 确定性
const f1 = dailyFortune('10001', '小明', DAY_A)
const f2 = dailyFortune('10001', '小明', DAY_A)
check('人品 同输入两次结果完全一致', JSON.stringify(f1) === JSON.stringify(f2), JSON.stringify(f1))
check('人品 分数是 0-100 整数', Number.isInteger(f1.score) && f1.score >= 0 && f1.score <= 100, String(f1.score))
check('人品 幸运数字 1-99 整数', Number.isInteger(f1.luckyNumber) && f1.luckyNumber >= 1 && f1.luckyNumber <= 99, String(f1.luckyNumber))
check('人品 幸运色非空', typeof f1.luckyColor === 'string' && f1.luckyColor.length > 0, f1.luckyColor)
check('人品 点评非空', typeof f1.comment === 'string' && f1.comment.length > 0)
check('人品 换天会变', f1.score !== dailyFortune('10001', '小明', DAY_B).score
  || f1.comment !== dailyFortune('10001', '小明', DAY_B).comment, `${f1.score} vs ${dailyFortune('10001', '小明', DAY_B).score}`)
check('人品 换用户会变', f1.score !== dailyFortune('10002', '小红', DAY_A).score
  || f1.luckyColor !== dailyFortune('10002', '小红', DAY_A).luckyColor)
check('人品 name 前缀进点评', dailyFortune('10001', '小明', DAY_A).comment.startsWith('小明：'), f1.comment)
check('人品 空 name 不加前缀', !dailyFortune('10001', '', DAY_A).comment.includes('：'))

// 分档合法 + 覆盖各档
const expectedLabel = (s) => (s >= 90 ? '大吉' : s >= 75 ? '中吉' : s >= 55 ? '小吉' : s >= 30 ? '末吉' : '凶')
const sample = Array.from({ length: 1000 }, (_, i) => dailyFortune(`u${i}`, '', new Date(2024, 4, 1 + (i % 28), 9, 0, 0)))
const scores = sample.map((r) => r.score)
check('人品 分档阈值正确', sample.every((r) => r.label === expectedLabel(r.score)))
check('人品 1000 次抽样分数全部在范围内', scores.every((s) => Number.isInteger(s) && s >= 0 && s <= 100))
check('人品 覆盖多个档位', new Set(scores.map(expectedLabel)).size >= 3, String(new Set(scores.map(expectedLabel)).size))

// drawLot
const l1 = drawLot('10001', DAY_A)
const l2 = drawLot('10001', DAY_A)
check('抽签 同一人同一天完全一致', JSON.stringify(l1) === JSON.stringify(l2), `${l1.level}/${l1.title}`)
check('抽签 字段完整', typeof l1.level === 'string' && typeof l1.title === 'string'
  && typeof l1.poem === 'string' && typeof l1.advice === 'string' && l1.poem.length > 0)
check('抽签 换天会变', JSON.stringify(drawLot('10001', DAY_A)) !== JSON.stringify(drawLot('10001', DAY_B)))
check('抽签 签库覆盖多支', new Set(Array.from({ length: 120 }, (_, i) => drawLot(`u${i}`, DAY_A).title)).size >= 6)
check('抽签 等级在合法集合内', ['上上签', '上签', '中签', '下签', '下下签'].includes(l1.level), l1.level)

// drawTarot
const t1 = drawTarot('10001', '今晚吃什么', DAY_A)
const t2 = drawTarot('10001', '今晚吃什么', DAY_A)
check('塔罗 同一人同一天完全一致', JSON.stringify(t1) === JSON.stringify(t2), t1.name)
check('塔罗 牌名来自大阿卡纳', TAROT_NAMES.includes(t1.name), t1.name)
check('塔罗 reversed 是布尔', typeof t1.reversed === 'boolean')
check('塔罗 解读非空', typeof t1.meaning === 'string' && t1.meaning.length > 0)
check('塔罗 回显问题', t1.question === '今晚吃什么')
check('塔罗 无问题时空字符串', drawTarot('10001', '', DAY_A).question === '')
check('塔罗 换天会变', JSON.stringify(drawTarot('10001', 'q', DAY_A)) !== JSON.stringify(drawTarot('10001', 'q', DAY_B)))
check('塔罗 抽到不同牌', new Set(Array.from({ length: 200 }, (_, i) => drawTarot(`u${i}`, '', DAY_A).name)).size >= 15)

// format*
const ff = formatFortune(f1)
check('formatFortune 多行', ff.split('\n').length >= 3)
check('formatFortune 含分数', ff.includes(String(f1.score)))
check('formatFortune 含评级与幸运色', ff.includes(f1.label) && ff.includes(f1.luckyColor))
check('formatFortune 无 markdown 表格', !ff.includes('|--') && !ff.includes('|---'))

const fl = formatLot(l1)
check('formatLot 多行', fl.split('\n').length >= 3)
check('formatLot 含等级与标题', fl.includes(l1.level) && fl.includes(l1.title))
check('formatLot 含解签', fl.includes('解签：'))

const ft = formatTarot(t1)
check('formatTarot 多行', ft.split('\n').length >= 2)
check('formatTarot 含牌名', ft.includes(t1.name))
check('formatTarot 含正逆位', ft.includes(t1.reversed ? '逆位' : '正位'))
check('formatTarot 含问题', ft.includes('今晚吃什么'))

// 意图解析
check('意图 今日人品', parseFortuneIntent('今日人品') === 'fortune')
check('意图 /人品', parseFortuneIntent('/人品') === 'fortune')
check('意图 运势', parseFortuneIntent('运势') === 'fortune')
check('意图 抽签', parseFortuneIntent('抽签') === 'lot')
check('意图 求签', parseFortuneIntent('求签') === 'lot')
check('意图 /抽签', parseFortuneIntent('/抽签') === 'lot')
check('意图 塔罗', parseFortuneIntent('塔罗') === 'tarot')
check('意图 塔罗牌', parseFortuneIntent('塔罗牌') === 'tarot')
check('意图 /塔罗', parseFortuneIntent('/塔罗') === 'tarot')
check('意图 无关文本 null', parseFortuneIntent('今天天气怎么样') === null)
check('意图 空文本 null', parseFortuneIntent('') === null)
check('意图 null 输入不抛异常', parseFortuneIntent(null) === null)
check('意图 含关键词的句子不误判', parseFortuneIntent('我今天人品爆发了，想去抽签玩') === null)

// 非法输入不抛异常
let threw = false
try {
  dailyFortune()
  drawLot(undefined, undefined)
  drawTarot(null, null, null)
  todayKey('not-a-date')
  formatFortune({})
  formatLot({})
  formatTarot({})
} catch { threw = true }
check('非法输入不抛异常', threw === false)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
