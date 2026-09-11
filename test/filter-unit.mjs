/** Unit tests for sensitive-word filtering and flood detection (no network, no bridge). */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FloodGuard, WordFilter, parseFilterCommand, parseWordList, pickPunishment } from '../lib/filter.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ---------- parseWordList ----------
const listText = [
  '# 这是注释，不该进词表',
  '广告',
  '',
  '  加群  ',
  're:傻[逼比]',
  're:^代练',
  're:([unclosed',
].join('\n')
const parsed = parseWordList(listText)
check('parseWordList 提取纯词', parsed.words.length === 2 && parsed.words[0] === '广告', JSON.stringify(parsed.words))
check('parseWordList 去首尾空白', parsed.words[1] === '加群')
check('parseWordList 提取正则', parsed.patterns.length === 2 && parsed.patterns[0] instanceof RegExp)
check('parseWordList 正则大小写不敏感', parsed.patterns.every((re) => re.flags.includes('i')))
check('parseWordList 注释与空行忽略', !parsed.words.some((w) => w.startsWith('#')))
check('parseWordList 非法正则进 invalid', parsed.invalid.length === 1 && parsed.invalid[0] === 're:([unclosed', JSON.stringify(parsed.invalid))
check('parseWordList 空输入不崩溃', parseWordList('').words.length === 0 && parseWordList(undefined).invalid.length === 0)
check('parseWordList 仅 re: 前缀视为非法', parseWordList('re:').invalid.length === 1)

// ---------- WordFilter ----------
const filter = new WordFilter({ words: ['广告', 'free vpn', 're:傻[逼比]'], whitelist: ['广告位', 're:^官方公告'] })
check('size 统计词与正则', filter.size === 3, String(filter.size))
const hitWord = filter.check('这里发个广告')
check('纯词命中', hitWord.hit === true)
check('命中返回词与 isRegex=false', hitWord.word === '广告' && hitWord.isRegex === false, JSON.stringify(hitWord))
const hitUpper = filter.check('Get FREE VPN now')
check('大小写不敏感命中', hitUpper.hit === true && hitUpper.word === 'free vpn', JSON.stringify(hitUpper))
const hitRegex = filter.check('你真是个傻逼')
check('正则命中且 isRegex=true', hitRegex.hit === true && hitRegex.isRegex === true, JSON.stringify(hitRegex))
check('正则命中返回正则源串', hitRegex.word === '傻[逼比]', hitRegex.word)
const missWord = filter.check('今天天气不错')
check('未命中 hit=false', missWord.hit === false && missWord.word === '' && missWord.isRegex === false)
check('空文本与 null 不命中', filter.check('').hit === false && filter.check(null).hit === false)
check('白名单纯词放行', filter.check('本群广告位出租').hit === false)
check('白名单正则放行', filter.check('官方公告：明天维护').hit === false)
check('白名单优先于黑名单', filter.check('广告位旁边的广告').hit === false)
check('空过滤器不命中', new WordFilter().size === 0 && new WordFilter().check('广告').hit === false)
check('构造函数接受字符串词', new WordFilter({ words: '刷屏' }).check('别刷屏了').hit === true)

// ---------- WordFilter.fromFile ----------
const dir = mkdtempSync(join(tmpdir(), 'qq-filter-test-'))
const wordFile = join(dir, 'words.txt')
writeFileSync(wordFile, '# 注释\n赌博\nre:外[挂卦]\nre:(bad\n', 'utf8')
const fromFile = WordFilter.fromFile(wordFile)
check('fromFile 载入词与正则', fromFile.size === 2, String(fromFile.size))
check('fromFile 词可命中', fromFile.check('有人在赌博').hit === true)
check('fromFile 正则可命中', fromFile.check('有人在卖外卦').isRegex === true)
check('fromFile 非法正则被跳过', fromFile.check('re:(bad').hit === false)
const missing = WordFilter.fromFile(join(dir, 'nope.txt'))
check('fromFile 文件不存在返回空过滤器', missing.size === 0 && missing.check('赌博').hit === false)
rmSync(dir, { recursive: true, force: true })

// ---------- parseFilterCommand ----------
check('/屏蔽 add 词', JSON.stringify(parseFilterCommand('/屏蔽 add 测试')) === JSON.stringify({ action: 'add', word: '测试' }))
check('/badword add 词', parseFilterCommand('/badword add 赌博')?.action === 'add' && parseFilterCommand('/badword add 赌博')?.word === '赌博')
check('/屏蔽 del 词', parseFilterCommand('/屏蔽 del 测试')?.action === 'del')
check('/屏蔽 list', parseFilterCommand('/屏蔽 list')?.action === 'list' && parseFilterCommand('/屏蔽 list')?.word === '')
check('/badword list', parseFilterCommand('/badword list')?.action === 'list')
check('命令大小写不敏感', parseFilterCommand('/屏蔽 ADD 空格')?.action === 'add')
check('无斜杠也识别', parseFilterCommand('屏蔽 add 广告')?.action === 'add')
check('删除别名 remove', parseFilterCommand('/屏蔽 remove "带引号"')?.word === '带引号')
check('add 缺词返回 null', parseFilterCommand('/屏蔽 add') === null)
check('普通聊天返回 null', parseFilterCommand('大家早上好') === null)
check('空文本返回 null', parseFilterCommand('') === null && parseFilterCommand(undefined) === null)

// ---------- pickPunishment ----------
check('strike=1 警告', pickPunishment(1) === 'warn')
check('strike=2 警告', pickPunishment(2) === 'warn')
check('strike=3 禁言', pickPunishment(3) === 'mute')
check('strike=9 仍禁言', pickPunishment(9) === 'mute')
check('strike=0 默认警告', pickPunishment(0) === 'warn')
check('非法 strike 不崩溃', pickPunishment(undefined) === 'warn' && pickPunishment('abc') === 'warn')
check('自定义 muteAt=2', pickPunishment(2, { muteAt: 2 }) === 'mute' && pickPunishment(1, { muteAt: 2 }) === 'warn')
check('自定义 muteAt=5 延迟禁言', pickPunishment(3, { muteAt: 5 }) === 'warn')

// ---------- FloodGuard ----------
const t0 = 1_700_000_000_000
const guard = new FloodGuard({ windowSeconds: 10, maxMessages: 3, muteSeconds: 60, strikeLimit: 3 })
const f1 = guard.observe('g:1', 100, t0)
check('窗口内第 1 条 none', f1.action === 'none' && f1.count === 1, JSON.stringify(f1))
check('窗口内第 2 条 none', guard.observe('g:1', 100, t0 + 1).action === 'none')
const f3 = guard.observe('g:1', 100, t0 + 2)
check('窗口内第 3 条 none', f3.action === 'none' && f3.count === 3)
const f4 = guard.observe('g:1', 100, t0 + 3)
check('首次超限 warn', f4.action === 'warn' && f4.count === 4, JSON.stringify(f4))
check('首次超限 strike=1', f4.strike === 1)
check('首次超限 muteSeconds=0', f4.muteSeconds === 0)
const f5 = guard.observe('g:1', 100, t0 + 4)
check('再次超限 strike=2', f5.action === 'warn' && f5.strike === 2, JSON.stringify(f5))
const f6 = guard.observe('g:1', 100, t0 + 5)
check('累计 strikeLimit 触发 mute', f6.action === 'mute', JSON.stringify(f6))
check('mute 返回 muteSeconds', f6.muteSeconds === 60)
check('mute 后 strike 归零', f6.strike === 0)
const f7 = guard.observe('g:1', 100, t0 + 6)
check('mute 后窗口重置', f7.action === 'none' && f7.count === 1, JSON.stringify(f7))
guard.observe('g:1', 100, t0 + 7)
guard.observe('g:1', 100, t0 + 8)
const f10 = guard.observe('g:1', 100, t0 + 9)
check('mute 后 strike 从零重新累计', f10.action === 'warn' && f10.strike === 1, JSON.stringify(f10))
check('不同用户互不影响', guard.observe('g:1', 200, t0 + 9).action === 'none')
check('不同群互不影响', guard.observe('g:2', 100, t0 + 9).action === 'none')

const other = new FloodGuard({ windowSeconds: 10, maxMessages: 2, muteSeconds: 30, strikeLimit: 3 })
other.observe('g:exp', 300, t0)
other.observe('g:exp', 300, t0 + 1)
const expiredStrike = other.observe('g:exp', 300, t0 + 2)
check('准备态 strike=1', expiredStrike.action === 'warn' && expiredStrike.strike === 1)
const expired = other.observe('g:exp', 300, t0 + 11_000)
check('窗口过期后计数清零', expired.action === 'none' && expired.count === 1, JSON.stringify(expired))
check('窗口过期后保留 strike', expired.strike === 1)
other.reset('g:exp', 300)
const afterReset = other.observe('g:exp', 300, t0 + 11_001)
check('reset 清空计数与 strike', afterReset.count === 1 && afterReset.strike === 0, JSON.stringify(afterReset))

const big = new FloodGuard({ windowSeconds: 10, maxMessages: 5, strikeLimit: 3 })
for (let i = 0; i < 1200; i++) big.observe('g:big', `u${i}`, t0)
check('大量用户后 Map 被跟踪', big.size > 1000, String(big.size))
const late = big.observe('g:big', 'newbie', t0 + 600_000)
check('过期条目被清理，Map 不无限增长', big.size <= 10, String(big.size))
check('清理后新用户重新计数', late.action === 'none' && late.count === 1, JSON.stringify(late))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
