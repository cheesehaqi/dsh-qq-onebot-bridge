/** Unit tests for dice module: 骰子 / 随机决定 / 随机抽人 (no network). */
import {
  parseDice, rollDice, formatRoll,
  parsePickCommand, pickRandom, formatPick,
  isDiceIntent, parseFortuneIntent
} from '../lib/dice.js'
import { parseFortuneIntent as fortuneIntent } from '../lib/fortune.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const HALF = () => 0.5       // 每颗骰子取中点：d6 -> 4、d20 -> 11、d100 -> 51
const ZERO = () => 0         // 每颗骰子取最小：1

// parseDice 正向
const p1 = parseDice('.r 3d6')
check('.r 3d6 解析', p1?.count === 3 && p1?.faces === 6 && p1?.modifier === 0, JSON.stringify(p1))
const p2 = parseDice('/r 2d20+3')
check('/r 2d20+3 解析（带正修正）', p2?.count === 2 && p2?.faces === 20 && p2?.modifier === 3, JSON.stringify(p2))
check('3d6 裸写法', JSON.stringify(parseDice('3d6')) === JSON.stringify({ count: 3, faces: 6, modifier: 0 }))
check('d6 缺省 count=1', parseDice('d6')?.count === 1 && parseDice('d6')?.faces === 6)
check('掷骰 2d6', parseDice('掷骰 2d6')?.count === 2)
check('骰子 1d100', parseDice('骰子 1d100')?.faces === 100)
check('roll 3d6-1（负修正）', parseDice('roll 3d6-1')?.modifier === -1, JSON.stringify(parseDice('roll 3d6-1')))
check('前缀与骰式之间有空格', parseDice('/r   4d8')?.count === 4)
check('大小写混写 2D10', parseDice('2D10')?.faces === 10)

// parseDice 边界与非法输入
check('count 上限 100 通过', parseDice('100d6')?.count === 100)
check('count 101 超限返回 null', parseDice('101d6') === null)
check('faces 上限 1000 通过', parseDice('1d1000')?.faces === 1000)
check('faces 1001 超限返回 null', parseDice('1d1001') === null)
check('faces 0 非法', parseDice('1d0') === null)
const garbage = ['', '   ', '你好', 'd', 'd6x', '3d', 'abc', '3x6', '/status', '签到', '3d6+', '++3d6', '3 d 6']
check('垃圾输入全部返回 null 且不抛异常', garbage.every((g) => parseDice(g) === null), garbage.join('|'))
check('undefined/null 不抛异常', parseDice(undefined) === null && parseDice(null) === null)
check('大数溢出保护', parseDice('99999999d99999999') === null)

// rollDice 固定 rng 验证 total
const r1 = rollDice(parseDice('3d6'), HALF)
check('rollDice 3d6 rng=0.5 点数 [4,4,4]', JSON.stringify(r1.rolls) === '[4,4,4]', JSON.stringify(r1.rolls))
check('rollDice 3d6 total=12', r1.total === 12, String(r1.total))
check('rollDice total = sum + modifier', r1.total === r1.rolls.reduce((a, b) => a + b, 0) + r1.spec.modifier)
const r2 = rollDice(parseDice('/r 2d20+3'), HALF)
check('rollDice 2d20+3 total=25', r2.total === 25 && r2.rolls.length === 2, JSON.stringify(r2))
const r3 = rollDice(parseDice('roll 3d6-1'), HALF)
check('rollDice 3d6-1 total=11', r3.total === 11, String(r3.total))
const r4 = rollDice({ count: 2, faces: 6, modifier: 0 }, ZERO)
check('rollDice rng=0 取最小值', JSON.stringify(r4.rolls) === '[1,1]' && r4.total === 2, JSON.stringify(r4))
check('rollDice 回显 spec', r4.spec.count === 2 && r4.spec.faces === 6 && r4.spec.modifier === 0)
check('rollDice 点数在 1..faces 内', rollDice({ count: 100, faces: 6, modifier: 0 }).rolls.every((v) => v >= 1 && v <= 6))
check('rollDice 默认 rng 不抛异常', typeof rollDice({ count: 1, faces: 6, modifier: 0 }).total === 'number')
const r5 = rollDice(parseDice('1d100'), () => 0.999)
check('rollDice rng≈1 取最大值', r5.rolls[0] === 100, JSON.stringify(r5.rolls))

// formatRoll
const fr1 = formatRoll(r1)
check('formatRoll 多骰含骰式/点数/合计', fr1.includes('3d6') && fr1.includes('4, 4, 4') && fr1.includes('12'), fr1)
check('formatRoll 多骰带修正', formatRoll(rollDice(parseDice('3d6+3'), HALF)).includes('+ 3'))
check('formatRoll 负修正显示减号', formatRoll(rollDice(parseDice('3d6-1'), HALF)).includes('- 1'))
const fr2 = formatRoll(rollDice(parseDice('1d100'), HALF))
check('formatRoll 单骰含点数 51 与合计', fr2.includes('51'), fr2)
check('formatRoll 单骰一行', fr2.split('\n').length === 1)
const fr3 = formatRoll(rollDice(parseDice('1d100'), () => 0.999))
check('formatRoll 1d100=100 提示大成功', fr3.includes('100') && fr3.includes('大成功'), fr3)
check('formatRoll 不抛异常（空对象）', typeof formatRoll({}) === 'string')

// parsePickCommand
const c1 = parsePickCommand('/抽 3 火锅 烧烤 面条')
check('/抽 3 火锅 烧烤 面条', c1?.count === 3 && c1?.items.length === 3 && c1.items[0] === '火锅', JSON.stringify(c1))
const c2 = parsePickCommand('/抽一个 火锅 烧烤')
check('/抽一个 火锅 烧烤（中文数字）', c2?.count === 1 && c2?.items.length === 2 && c2.items[1] === '烧烤', JSON.stringify(c2))
const c3 = parsePickCommand('/随机 火锅、烧烤、面条')
check('/随机 顿号分隔', c3?.count === 1 && c3?.items.length === 3 && c3.items[2] === '面条', JSON.stringify(c3))
const c4 = parsePickCommand('随机选 2 个：A B C')
check('随机选 2 个：A B C', c4?.count === 2 && c4?.items.length === 3 && c4.items[0] === 'A', JSON.stringify(c4))
const c5 = parsePickCommand('/随机 火锅,烧烤，面条')
check('逗号/中文逗号分隔', c5?.items.length === 3, JSON.stringify(c5?.items))
check('默认 count=1', parsePickCommand('/抽 A B')?.count === 1)
const many = Array.from({ length: 30 }, (_, i) => `项${i}`)
check('30 项通过', parsePickCommand(`/抽 ${many.join(' ')}`)?.items.length === 30)
check('31 项超限 null', parsePickCommand(`/抽 ${[...many, '项30'].join(' ')}`) === null)
check('单项不构成抽取 null', parsePickCommand('/抽 火锅') === null)
check('无可选项 null', parsePickCommand('/抽') === null)
check('非抽取指令 null', parsePickCommand('今天天气不错') === null && parsePickCommand('签到') === null)
check('空/undefined 不抛异常', parsePickCommand('') === null && parsePickCommand(undefined) === null && parsePickCommand(null) === null)

// pickRandom
const foods = ['火锅', '烧烤', '面条', '寿司', '饺子']
const picked = pickRandom(foods, 3, HALF)
check('pickRandom 数量正确', picked.length === 3)
check('pickRandom 不重复', new Set(picked).size === picked.length, JSON.stringify(picked))
check('pickRandom 都来自原集合', picked.every((x) => foods.includes(x)))
check('pickRandom 不改动入参', JSON.stringify(foods) === JSON.stringify(['火锅', '烧烤', '面条', '寿司', '饺子']))
check('pickRandom count 超长返回全部打乱', pickRandom(foods, 99, HALF).length === foods.length)
check('pickRandom count<1 按 1 处理', pickRandom(foods, 0, HALF).length === 1 && pickRandom(foods, -5, HALF).length === 1)
check('pickRandom 空数组返回空', pickRandom([], 3, HALF).length === 0)
check('pickRandom 相同 rng 结果可复现', JSON.stringify(pickRandom(foods, 3, HALF)) === JSON.stringify(pickRandom(foods, 3, HALF)))
check('pickRandom 非法入参不抛异常', Array.isArray(pickRandom(undefined, 3)) && Array.isArray(pickRandom(null, null)))

// formatPick
const fp1 = formatPick(['火锅'], foods)
check('formatPick 单项含抽中与结果', fp1.includes('抽中') && fp1.includes('火锅'), fp1.replace(/\n/g, '⏎'))
check('formatPick 多项含数量与顿号', formatPick(['A', 'B'], ['A', 'B', 'C']).includes('A、B'))
check('formatPick 空结果有兜底文案', typeof formatPick([], foods) === 'string' && formatPick([], foods).length > 0)

// 意图判定
check('isDiceIntent 命中骰子', isDiceIntent('/r 2d6') && isDiceIntent('3d6'))
check('isDiceIntent 非骰子不命中', !isDiceIntent('抽签') && !isDiceIntent('你好'))
check('dice 模块转发 parseFortuneIntent', parseFortuneIntent === fortuneIntent
  && parseFortuneIntent('今日人品') === 'fortune' && parseFortuneIntent('塔罗') === 'tarot')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
