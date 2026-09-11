/** Unit tests for in-group mini-games: idiom chain, guess-the-number, intent parsing (no network). */
import { DEFAULT_IDIOMS, IdiomChain, GuessNumber, parseGameStartIntent, parseGameStopIntent } from '../lib/games.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// 约定（与 lib/games.js 一致）：chain.current 是「玩家现在该接的那一句」，
// 因此答对的成语首字必须等于 chain.current 的首字。

// ---------- 内置词库 ----------
check('词库规模 ≥ 200', DEFAULT_IDIOMS.length >= 200, `count=${DEFAULT_IDIOMS.length}`)
check('词库全部为 4 字（4 个汉字）', DEFAULT_IDIOMS.every((w) => /^[\u4e00-\u9fa5]{4}$/.test(w)), `bad=${JSON.stringify(DEFAULT_IDIOMS.filter((w) => !/^[\u4e00-\u9fa5]{4}$/.test(w)))}`)
check('词库无重复', new Set(DEFAULT_IDIOMS).size === DEFAULT_IDIOMS.length, `unique=${new Set(DEFAULT_IDIOMS).size}`)
const heads = new Set(DEFAULT_IDIOMS.map((w) => w[0]))
const covered = ['一', '不', '天', '心', '大', '人', '山', '水', '风', '花', '日', '月', '生', '无', '有', '自', '中', '上', '下', '来', '去', '千', '万', '马', '龙', '鱼']
check('常见首字全覆盖', covered.every((c) => heads.has(c)), `missing=${JSON.stringify(covered.filter((c) => !heads.has(c)))}`)
check('多数成语可以接下去', DEFAULT_IDIOMS.filter((w) => heads.has(w[3])).length / DEFAULT_IDIOMS.length >= 0.5)
check('词库包含常用接龙词', ['一鸣惊人', '人山人海', '海阔天空', '空前绝后', '后来居上'].every((w) => DEFAULT_IDIOMS.includes(w)))

// ---------- 开局 ----------
const chain = new IdiomChain()
check('未开局 active=false', chain.active === false && chain.current === '')
const notStarted = chain.tryAnswer('一心一意')
check('未开局提示先开始', notStarted.ok === false && /没有在玩接龙/.test(notStarted.reason) && notStarted.next === '', notStarted.reason)

const first = chain.start(() => 0)
check('start 返回词库首个', first === DEFAULT_IDIOMS[0], first)
check('start 后 active=true', chain.active === true && chain.current === first)
check('开局成语在词库内', DEFAULT_IDIOMS.includes(first))
check('开局成语已标记已用', chain.usedCount === 1)

const started = chain.tryAnswer(first)
check('开局成语不能直接当答案（首字不符）', started.ok === false && started.reason === '首字要接「人」哦', started.reason)

// ---------- 四类失败 reason ----------
const wrongLen = chain.tryAnswer('一心一')
check('非四字被拒', wrongLen.ok === false && wrongLen.reason === '这不是四字成语哦' && wrongLen.next === '', wrongLen.reason)
const notInDict = chain.tryAnswer('人猫狗兔')
check('词库外成语被拒', notInDict.ok === false && notInDict.reason === '词库里没有这个成语', notInDict.reason)
const wrongHead = chain.tryAnswer('一心一意')
check('首字不符被拒', wrongHead.ok === false && wrongHead.reason === '首字要接「人」哦', wrongHead.reason)

// 同音不同字不算接上（该接「人」，用同音的「仁」开头也不行）
const chain2 = new IdiomChain()
chain2.start(() => 0) // 一鸣惊人 → 该接「人」
const homophone = chain2.tryAnswer('仁至义尽')
check('同音字（仁/人）不算接上', homophone.ok === false && homophone.reason === '首字要接「人」哦', homophone.reason)

// ---------- 接龙成功 ----------
const okFirst = chain2.tryAnswer('人山人海')
check('接上末字则成功', okFirst.ok === true && okFirst.reason === '接上啦', okFirst.reason)
check('成功时给出下一句', typeof okFirst.next === 'string' && okFirst.next.length === 4 && okFirst.next[0] === '海', okFirst.next)
check('下一句也在词库内', DEFAULT_IDIOMS.includes(okFirst.next))
check('成功后可继续（active 保持）', chain2.active === true && chain2.current === okFirst.next)
check('开局+玩家+机器人三句都计入已用', chain2.usedCount === 3)

// 多步接龙：自定义词库让每一步的唯一候选确定
const chain3 = new IdiomChain({ words: ['一鸣惊人', '人山人海', '海阔天空', '空前绝后'] })
const f3 = chain3.start(() => 0) // 一鸣惊人
const r1 = chain3.tryAnswer('人山人海')
check('第一步 一鸣惊人→人山人海', f3 === '一鸣惊人' && r1.ok === true && r1.next === '海阔天空', JSON.stringify(r1))
const r2 = chain3.tryAnswer('空前绝后')
check('第二步 海阔天空→空前绝后（接不上时收官）', r2.ok === true && r2.reason === '接得漂亮，不过我想不出下一个啦' && r2.next === '', JSON.stringify(r2))
check('三步后已用集合为 4', chain3.usedCount === 4)

// 已用过的成语被拒：构造一条能绕回同一个首字的链
const repeatCheck = new IdiomChain({ words: ['天马行空', '空前绝后', '后发制人', '人山人海', '海阔天空'] })
repeatCheck.start(() => 0) // 天马行空 → 该接「空」
const stepOne = repeatCheck.tryAnswer('空前绝后') // → 后发制人
check('已用链第一步成功', stepOne.ok === true && stepOne.next === '后发制人', JSON.stringify(stepOne))
const stepTwo = repeatCheck.tryAnswer('人山人海') // → 海阔天空
check('已用链第二步成功', stepTwo.ok === true && stepTwo.next === '海阔天空', JSON.stringify(stepTwo))
const repeat = repeatCheck.tryAnswer('空前绝后')
check('重复使用被拒（此刻该接「空」而该词已用）', repeat.ok === false && repeat.reason === '这个已经用过啦', repeat.reason)
const wrongHead2 = repeatCheck.tryAnswer('天马行空')
check('首字不符仍优先给出提示', wrongHead2.ok === false && wrongHead2.reason === '首字要接「空」哦', wrongHead2.reason)

// 词库接不下去：ok=true 但 next 为空
const tiny = new IdiomChain({ words: ['一鸣惊人', '人山人海'] })
tiny.start(() => 0)
const deadEnd = tiny.tryAnswer('人山人海')
check('词库接不下去仍算接对', deadEnd.ok === true && deadEnd.next === '', JSON.stringify(deadEnd))
check('接不下去时给出提示语', /我想不出下一个/.test(deadEnd.reason), deadEnd.reason)

// ---------- 超时（注入可控 now） ----------
const fast = new IdiomChain({ words: ['一鸣惊人', '一举两得', '得心应手', '手忙脚乱'] })
let clock = 1_000_000
const timed = new IdiomChain({ words: ['一鸣惊人', '人山人海', '海阔天空', '空前绝后'], timeoutMs: 60_000, now: () => clock })
timed.start(() => 0) // 一鸣惊人 → 该接「人」
check('超时窗口内可以接', timed.tryAnswer('人山人海').ok === true)
clock += 60_000
check('恰好等于 timeoutMs 不算超时', timed.tryAnswer('空前绝后').ok === true)
clock += 60_001
const expired = timed.tryAnswer('人山人海')
check('超时后提示接龙超时啦', expired.ok === false && expired.reason === '接龙超时啦', expired.reason)
check('超时后自动结束本局', timed.active === false)
check('超时窗口与注入时钟无关（默认 now）', fast.start(() => 0) === '一鸣惊人')

// ---------- stop ----------
const stoppable = new IdiomChain()
stoppable.start(() => 0)
stoppable.stop()
check('stop 后 active=false 且清空已用', stoppable.active === false && stoppable.usedCount === 0 && stoppable.current === '')

// ---------- 猜数字 ----------
const g1 = new GuessNumber({ min: 1, max: 100, maxTries: 10, rng: () => 0.5 })
check('答案在范围内', g1.reveal() >= 1 && g1.reveal() <= 100)
check('新游戏 active=true', new GuessNumber().active === true)
check('区间下界可命中', new GuessNumber({ min: 1, max: 100, rng: () => 0 }).reveal() === 1)

const g2 = new GuessNumber({ min: 1, max: 100, maxTries: 10, rng: () => 0 }) // 答案 1
const low = g2.guess('20') // 猜 20 偏大
check('猜大了给 smaller 提示', low.ok === false && low.hint === 'smaller' && low.tries === 1, JSON.stringify(low))
const high = g2.guess('80')
check('再猜一次 tries 累加', high.ok === false && high.hint === 'smaller' && high.tries === 2, JSON.stringify(high))
const hit = g2.guess('1')
check('猜中返回 correct', hit.ok === true && hit.hint === 'correct' && hit.answer === 1, JSON.stringify(hit))
check('猜中后 active=false', g2.active === false)
check('猜中后不再受理', g2.guess('2').ok === false && g2.active === false)

const g3 = new GuessNumber({ min: 1, max: 100, maxTries: 10, rng: () => 0 })
const notNumber = g3.guess('一百')
check('非数字输入 ok=false hint 空', notNumber.ok === false && notNumber.hint === '', JSON.stringify(notNumber))
check('非数字输入不计次数', notNumber.tries === 0 && g3.tries === 0)
const emptyGuess = g3.guess('')
check('空输入不计次数', emptyGuess.ok === false && emptyGuess.tries === 0)
const withSlash = g3.guess('/猜 50')
check('带前缀的输入仍可解析', withSlash.tries === 1 && withSlash.hint === 'smaller', JSON.stringify(withSlash))

const g6 = new GuessNumber({ min: 1, max: 100, maxTries: 10, rng: () => 0.99 }) // 答案 100
const g6low = g6.guess('1')
check('猜小了给 bigger 提示', g6low.ok === false && g6low.hint === 'bigger' && g6low.tries === 1, JSON.stringify(g6low))

const g4 = new GuessNumber({ min: 1, max: 100, maxTries: 3, rng: () => 0.99 }) // 答案 100
let outOfRange = null
for (let i = 0; i < 3; i++) outOfRange = g4.guess('999')
check('越界猜测也计数', outOfRange.tries === 3)
check('次数耗尽标记 exhausted', outOfRange.exhausted === true && g4.active === false, JSON.stringify(outOfRange))
check('耗尽后答案可见', outOfRange.answer === 100 && g4.reveal() === 100, String(outOfRange.answer))

const g5 = new GuessNumber({ min: 1, max: 100, maxTries: 2, rng: () => 0 }) // 答案 1
g5.guess('50')
const exhausted = g5.guess('60')
check('次数用尽返回 exhausted 与答案', exhausted.exhausted === true && exhausted.answer === 1 && exhausted.ok === false, JSON.stringify(exhausted))
const bounds = new GuessNumber({ min: 10, max: 20, rng: () => 0 })
check('自定义区间生效', bounds.range.min === 10 && bounds.range.max === 20 && bounds.reveal() === 10)

// ---------- 意图解析 ----------
check('接龙 开局', parseGameStartIntent('接龙') === 'idiom')
check('成语接龙 开局', parseGameStartIntent('成语接龙') === 'idiom')
check('来玩接龙 开局', parseGameStartIntent('来玩接龙') === 'idiom')
check('/接龙 开局', parseGameStartIntent('/接龙') === 'idiom')
check('开启接龙 开局', parseGameStartIntent('开启接龙') === 'idiom')
check('猜数字 开局', parseGameStartIntent('猜数字') === 'guess')
check('玩猜数字 开局', parseGameStartIntent('玩猜数字') === 'guess')
check('/猜数字 开局', parseGameStartIntent('/猜数字') === 'guess')
check('来玩猜数字 开局', parseGameStartIntent('来玩猜数字') === 'guess')
check('无关句子不误判', parseGameStartIntent('投票接龙：今晚吃什么 A 火锅 B 烧烤') === null)
check('含逗号的长句不误判', parseGameStartIntent('我们接龙吧，好不好？') === null)
check('普通聊天不误判', parseGameStartIntent('今天天气不错') === null && parseGameStartIntent('') === null)

check('不玩了 结束', parseGameStopIntent('不玩了') === true)
check('结束游戏 结束', parseGameStopIntent('结束游戏') === true)
check('/结束 结束', parseGameStopIntent('/结束') === true)
check('停止游戏 结束', parseGameStopIntent('停止游戏') === true)
check('不玩啦 结束', parseGameStopIntent('不玩啦') === true)
check('游戏结束 结束', parseGameStopIntent('游戏结束') === true)
check('继续玩不结束', parseGameStopIntent('继续玩') === false && parseGameStopIntent('') === false)
check('无关句子不结束', parseGameStopIntent('我不玩了啦，等等我') === false && parseGameStopIntent('结束了吗') === false)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
