/**
 * Dice module (骰子 / 随机决定 / 随机抽人): command parsing plus pure helpers.
 * All randomness is injected via an `rng` parameter (default Math.random) so the
 * logic stays unit-testable without network or global mocking.
 *
 * Supported dice syntax: `.r 3d6` `/r 2d20+3` `3d6` `d6` `掷骰 2d6` `骰子 1d100` `roll 3d6-1`
 *   count 缺省 1，modifier 可正可负；count ≤ 100、faces ≤ 1000，超限或垃圾输入返回 null。
 */
import { parseFortuneIntent } from './fortune.js'

export { parseFortuneIntent }

const DICE_RE = /^(\d*)[dD](\d+)([+-]\d+)?$/
const MAX_COUNT = 100
const MAX_FACES = 1000

/** 解析骰子指令；非法输入返回 null。 */
export function parseDice(text) {
  const t = String(text ?? '').trim()
  if (t === '') return null
  const m = /^(?:[.\/／]\s*(?:\.?roll|\.?r)\b|(?:roll|掷骰|骰子|扔骰子|投骰))[\s:：]*(.*)$/i.exec(t)
  const body = (m ? m[1] : t).trim()
  if (body === '') return null
  const dm = DICE_RE.exec(body)
  if (!dm) return null
  const count = dm[1] === '' ? 1 : Number(dm[1])
  const faces = Number(dm[2])
  const modifier = dm[3] ? Number(dm[3]) : 0
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) return null
  if (!Number.isInteger(faces) || faces < 1 || faces > MAX_FACES) return null
  if (!Number.isInteger(modifier)) return null
  return { count, faces, modifier }
}

/** 掷骰；rng() 期望返回 [0,1)。total = sum(rolls) + modifier。 */
export function rollDice(spec, rng = Math.random) {
  const count = Math.trunc(Number(spec?.count)) || 1
  const faces = Math.trunc(Number(spec?.faces)) || 1
  const modifier = Math.trunc(Number(spec?.modifier)) || 0
  const rand = typeof rng === 'function' ? rng : Math.random
  const rolls = []
  for (let i = 0; i < count; i++) {
    const v = Number(rand())
    const frac = Number.isFinite(v) ? Math.min(Math.max(v, 0), 0.999999999) : 0
    rolls.push(1 + Math.floor(frac * faces))
  }
  const total = rolls.reduce((a, b) => a + b, 0) + modifier
  return { rolls, total, spec: { count, faces, modifier } }
}

/** 掷骰结果文案（单骰多面也好看）。 */
export function formatRoll(result) {
  const { rolls = [], total = 0 } = result ?? {}
  const spec = result?.spec ?? { count: rolls.length || 1, faces: 1, modifier: 0 }
  const label = `${spec.count}d${spec.faces}`
  const mod = spec.modifier > 0 ? ` + ${spec.modifier}` : spec.modifier < 0 ? ` - ${Math.abs(spec.modifier)}` : ''
  if (rolls.length <= 1) {
    const line = `🎲 ${label} = ${rolls[0] ?? 0}${mod} = ${total}`
    return spec.faces === 100 && (rolls[0] ?? 0) === 100 ? `${line}\n💯 大成功！` : line
  }
  return `🎲 ${label} = [${rolls.join(', ')}]${mod} = ${total}`
}

const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const PICK_RE = /^(?:\/|／)?\s*(?:帮我)?(?:随机选|随机抽|抽签?选|抽|随机|选)\s*(?:择)?\s*/
const MAX_PICK_ITEMS = 30

function parseCountToken(token) {
  if (!token) return 1
  if (/^\d+$/.test(token)) {
    const n = Number(token)
    return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null
  }
  const m = /^([一两二三四五六七八九十])\s*个?$/.exec(token)
  if (m) return CN_NUM[m[1]] ?? null
  return null
}

function splitItems(body) {
  if (/[、,，:：]/.test(body)) {
    return body
      .replace(/[\s、,，:：]+/g, '\u0001')
      .split('\u0001')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return body.split(/\s+/).map((s) => s.trim()).filter(Boolean)
}

/** 解析随机抽取指令；items 需 2..30 项，否则返回 null。 */
export function parsePickCommand(text) {
  const t = String(text ?? '').trim()
  if (t === '') return null
  const m = PICK_RE.exec(t)
  if (!m) return null
  let body = t.slice(m[0].length).replace(/^[\s:：、,，]+/, '').trim()
  if (body === '') return null
  let count = 1
  const cm = /^(\d+|[一两二三四五六七八九十])\s*个?\s*[\s:：、,，]*/.exec(body)
  if (cm) {
    const n = parseCountToken(cm[1])
    if (n === null) return null
    count = n
    body = body.slice(cm[0].length).trim()
  }
  const items = splitItems(body)
  if (items.length < 2 || items.length > MAX_PICK_ITEMS) return null
  return { count, items }
}

/** 不重复随机抽取；count 超过长度时返回全部打乱，count < 1 按 1 处理。 */
export function pickRandom(items, count, rng = Math.random) {
  const list = Array.isArray(items) ? items.slice() : []
  const rand = typeof rng === 'function' ? rng : Math.random
  const size = Math.min(Math.max(Math.trunc(Number(count)) || 1, 1), list.length)
  for (let i = list.length - 1; i > 0; i--) {
    const v = Number(rand())
    const frac = Number.isFinite(v) ? Math.min(Math.max(v, 0), 0.999999999) : 0
    const j = Math.floor(frac * (i + 1))
    const tmp = list[i]
    list[i] = list[j]
    list[j] = tmp
  }
  return list.slice(0, size)
}

/** 随机抽取结果文案。 */
export function formatPick(picked, items = []) {
  const list = Array.isArray(picked) ? picked : []
  if (list.length === 0) return '🎯 没得抽，先给我几个选项吧'
  if (list.length === 1) {
    const base = `🎯 抽中了：${list[0]}`
    return items.length > list.length ? `${base}\n（候选 ${items.length} 个，胜负已定，认命吧）` : base
  }
  return `🎯 抽中 ${list.length} 个：${list.join('、')}`
}

/** 是否为骰子意图（可解析即算）。 */
export function isDiceIntent(text) {
  return parseDice(text) !== null
}
