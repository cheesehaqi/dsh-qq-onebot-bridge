/** 历史归档单元测试：行格式、按天分片、检索（AND / days / limit）、过期搬迁、统计。 */
import { archiveLine, parseArchiveLine, HistoryArchive } from '../lib/archive.js'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

/** 本地日期 → `YYYY-MM-DD`（故意不用 toISOString，理由同 lib/archive.js）。 */
const localDay = (date) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

const root = mkdtempSync(join(tmpdir(), 'qq-archive-test-'))
try {
  // ============ archiveLine：单行性 / 空白压平 / 截断 ============
  const line1 = archiveLine({ ts: 1, chatKey: 'g:123', userId: 456, name: '小明', kind: 'message', text: '第一行\n第二行' })
  check('archiveLine 不含换行符', !line1.includes('\n') && !line1.includes('\r'), JSON.stringify(line1))
  check('archiveLine 换行被压成空格', parseArchiveLine(line1).text === '第一行 第二行', JSON.stringify(parseArchiveLine(line1).text))

  const messy = archiveLine({ ts: 2, chatKey: 'g:123', userId: 0, name: 'a', kind: 'message', text: '  多个   空白\r\n\t混在\u3000一起  ' })
  check('archiveLine 连续空白压成一个并 trim', parseArchiveLine(messy).text === '多个 空白 混在 一起', JSON.stringify(parseArchiveLine(messy).text))

  check('archiveLine 保留字段往返', JSON.stringify(parseArchiveLine(line1)) === JSON.stringify({ ts: 1, chatKey: 'g:123', userId: 456, name: '小明', kind: 'message', text: '第一行 第二行' }))
  check('archiveLine 缺字段回落默认值', JSON.stringify(parseArchiveLine(archiveLine({}))) === JSON.stringify({ ts: 0, chatKey: '', userId: 0, name: '', kind: '', text: '' }))
  check('archiveLine 非对象入参不抛错', parseArchiveLine(archiveLine(null)).text === '' && parseArchiveLine(archiveLine('x')).chatKey === '')
  check('archiveLine 非数值字段归一为 0', parseArchiveLine(archiveLine({ ts: 'abc', userId: NaN, text: 1 })).ts === 0)
  check('archiveLine 字符串字段非字符串归一为空', parseArchiveLine(archiveLine({ chatKey: 7, name: {}, kind: [], text: 'ok' })).chatKey === '')

  const longText = archiveLine({ ts: 3, text: '字'.repeat(3000) })
  check('archiveLine 文本截断到 2000 字', parseArchiveLine(longText).text.length === 2001, String(parseArchiveLine(longText).text.length))
  check('archiveLine 截断带省略号', parseArchiveLine(longText).text.endsWith('…'))
  check('archiveLine 恰好 2000 字不截断', parseArchiveLine(archiveLine({ ts: 3, text: '字'.repeat(2000) })).text.length === 2000)
  check('archiveLine 截断后仍是单行', !longText.includes('\n'))

  // ============ parseArchiveLine：坏行容错 ============
  check('parseArchiveLine 坏 JSON 返回 null', parseArchiveLine('{不是 json') === null)
  check('parseArchiveLine 截断的半行返回 null', parseArchiveLine('{"ts":1,"text":"半截') === null)
  check('parseArchiveLine 数组返回 null', parseArchiveLine('[1,2,3]') === null)
  check('parseArchiveLine 字面量 null 返回 null', parseArchiveLine('null') === null)
  check('parseArchiveLine 裸数字返回 null', parseArchiveLine('42') === null)
  check('parseArchiveLine 无关键字段返回 null', parseArchiveLine('{"foo":1}') === null)
  check('parseArchiveLine 空串返回 null', parseArchiveLine('') === null && parseArchiveLine('   ') === null)
  check('parseArchiveLine 非字符串返回 null', parseArchiveLine(undefined) === null && parseArchiveLine(123) === null)
  check('parseArchiveLine ts 非有限数归一为 0', parseArchiveLine('{"ts":"x","chatKey":"g:1"}').ts === 0)
  check('parseArchiveLine userId 非有限数归一为 0', parseArchiveLine('{"userId":null,"chatKey":"g:1"}').userId === 0)
  check('parseArchiveLine 字符串字段缺失补空串', parseArchiveLine('{"chatKey":"g:1"}').text === '' && parseArchiveLine('{"chatKey":"g:1"}').kind === '')
  check('parseArchiveLine 保留未知扩展字段', parseArchiveLine('{"chatKey":"g:1","extra":"x"}').extra === 'x')

  // ============ append：落盘位置 / 当天分片 / 跨天分片 ============
  const dirA = join(root, 'a')
  const fixedNow = new Date(2026, 2, 10, 14, 30, 15).getTime()
  const day10 = localDay(new Date(2026, 2, 10))
  const day09 = localDay(new Date(2026, 2, 9))
  const day08 = localDay(new Date(2026, 2, 8))
  const arA = new HistoryArchive({ dir: dirA, keepDays: 90, now: () => fixedNow })

  check('append 返回 true', arA.append({ ts: fixedNow, chatKey: 'g:123', userId: 1, name: '小明', kind: 'message', text: '今天 alpha 记录' }) === true)
  check('append 在 dir 下建出当天分片', existsSync(join(dirA, `${day10}.jsonl`)), `${day10}.jsonl`)

  const arB = new HistoryArchive({ dir: join(root, 'b'), now: () => new Date(2026, 2, 9, 9, 0, 0).getTime() })
  arB.append({ ts: new Date(2026, 2, 9, 9, 0, 0).getTime(), chatKey: 'g:1', name: 'a', text: '昨天' })
  const arC = new HistoryArchive({ dir: join(root, 'b'), now: () => new Date(2026, 2, 8, 9, 0, 0).getTime() })
  arC.append({ ts: new Date(2026, 2, 8, 9, 0, 0).getTime(), chatKey: 'g:1', name: 'a', text: '前天' })
  const bFiles = [existsSync(join(root, 'b', `${day09}.jsonl`)), existsSync(join(root, 'b', `${day08}.jsonl`))]
  check('固定时钟下两条不同天的记录落到两个分片', bFiles[0] && bFiles[1], JSON.stringify(bFiles))
  check('跨天分片文件名正确', new HistoryArchive({ dir: join(root, 'b') }).stats().files === 2)

  const badDirArchive = new HistoryArchive({ dir: join(root, 'not-a-dir') })
  writeFileSync(join(root, 'not-a-dir'), 'x', 'utf8')
  check('append 目录创建失败返回 false 不抛错', badDirArchive.append({ ts: 1, text: 'x' }) === false)
  check('append 非对象返回 false', arA.append(null) === false && arA.append('x') === false)

  // ============ 三天数据：检索用 ============
  const dirD = join(root, 'd')
  const t10 = new Date(2026, 2, 10, 10, 0, 0).getTime()
  const t09 = new Date(2026, 2, 9, 10, 0, 0).getTime()
  const t08 = new Date(2026, 2, 8, 10, 0, 0).getTime()
  const arD = new HistoryArchive({ dir: dirD, keepDays: 90, now: () => fixedNow })

  // 每条记录刻意用互不重叠的关键词（alpha / mochi / 甜点 / omega），
  // 否则一个词同时出现在两条记录里时，AND 与 chatKey 的断言就没法区分"射中了谁"。
  arD.append({ ts: t10, chatKey: 'g:123', userId: 1, name: '小明', kind: 'message', text: '今天 alpha 项目' })
  arD.append({ ts: t10 + 1000, chatKey: 'u:456', userId: 2, name: '小红', kind: 'message', text: '私聊 mOcHi 蛋糕' })
  arD.append({ ts: t09, chatKey: 'g:123', userId: 1, name: '小明', kind: 'message', text: '昨天 甜点 甜点铺' })
  arD.append({ ts: t08, chatKey: 'g:123', userId: 1, name: '小明', kind: 'message', text: '前天 alpha omega' })
  check('三天数据落成三个分片', arD.stats().files === 3, JSON.stringify(arD.stats()))

  const sAlpha = arD.search('ALPHA')
  check('search 大小写不敏感', sAlpha.hits.length === 2, String(sAlpha.hits.length))
  check('search 单关键词命中文本', sAlpha.hits.every((hit) => hit.text.includes('alpha')))
  check('search 结果新→旧排序', sAlpha.hits[0].ts > sAlpha.hits[1].ts && sAlpha.hits[0].ts === t10, JSON.stringify(sAlpha.hits.map((h) => h.ts)))

  const sAnd = arD.search('alpha omega')
  check('search 多词 AND 全部命中才算', sAnd.hits.length === 1 && sAnd.hits[0].ts === t08, JSON.stringify(sAnd.hits.map((h) => h.ts)))
  check('search AND 任一词缺失则不命中', arD.search('alpha 不存在').hits.length === 0)
  check('search AND 词序无关', arD.search('omega alpha').hits.length === 1)
  check('search 命中 name 字段', arD.search('小明 alpha').hits.length === 2 && arD.search('小红 alpha').hits.length === 0)
  check('search 词不会被部分复用', arD.search('alpha 甜点').hits.length === 0)

  const sDays7 = arD.search('alpha', { days: 7 })
  check('search days 覆盖窗口内全部', sDays7.hits.length === 2)
  const sDays2 = arD.search('alpha', { days: 2 })
  check('search days=2 只查最近两天', sDays2.hits.length === 1 && sDays2.hits[0].ts === t10, JSON.stringify(sDays2.hits.map((h) => h.ts)))
  check('search days=1 只看当天', arD.search('alpha', { days: 1 }).hits.length === 1)
  check('search days=2 只读两个分片', sDays2.files.length === 2, JSON.stringify(sDays2.files))
  check('search files 新→旧', sDays2.files[0] === `${day10}.jsonl` && sDays2.files[1] === `${day09}.jsonl`, JSON.stringify(sDays2.files))
  check('search days 非法值回落默认 7', arD.search('alpha', { days: 0 }).hits.length === 2 && arD.search('alpha', { days: NaN }).hits.length === 2)
  check('search scanned 统计读过行数', sDays7.scanned >= 3, String(sDays7.scanned))

  const sChat = arD.search('alpha', { days: 7, chatKey: 'g:123' })
  check('search chatKey 过滤会话', sChat.hits.length === 2 && sChat.hits.every((hit) => hit.chatKey === 'g:123'))
  check('search chatKey 过滤掉其它会话', arD.search('mochi', { days: 7, chatKey: 'g:123' }).hits.length === 0)
  check('search chatKey 精确匹配目标会话', arD.search('mochi', { days: 7, chatKey: 'u:456' }).hits.length === 1 && arD.search('mochi', { days: 7, chatKey: 'g:456' }).hits.length === 0)
  check('search chatKey 空串不过滤', arD.search('mochi', { days: 7, chatKey: '' }).hits.length === 1)
  check('search chatKey 非字符串忽略该过滤', arD.search('mochi', { days: 7, chatKey: 123 }).hits.length === 1)

  const sLimit1 = arD.search('alpha', { days: 7, limit: 1 })
  check('search limit 截断到 1 条', sLimit1.hits.length === 1 && sLimit1.truncated === true, JSON.stringify(sLimit1.hits.map((h) => h.ts)))
  check('search limit 保留最新那条', sLimit1.hits[0].ts === t10)
  check('search 未截断时 truncated=false', sDays7.truncated === false)
  check('search limit 非法值回落 20', arD.search('alpha', { limit: 0, days: 7 }).hits.length === 2 && arD.search('alpha', { limit: -3, days: 7 }).truncated === false)
  check('search limit 非有限数回落 20', arD.search('alpha', { limit: NaN, days: 7 }).hits.length === 2)
  check('search 无命中返回空数组', arD.search('绝不存在的词').hits.length === 0)
  check('search 无命中仍报读过的文件', arD.search('绝不存在的词').files.length === 3, JSON.stringify(arD.search('绝不存在的词').files))

  const emptyShape = arD.search('')
  check('search 空关键词返回空结构', emptyShape.hits.length === 0 && emptyShape.scanned === 0 && emptyShape.files.length === 0 && emptyShape.truncated === false)
  check('search 非字符串关键词返回空结构', arD.search(null).files.length === 0 && arD.search(123).scanned === 0)

  const dirMissing = join(root, 'nope', 'archive')
  const arMissing = new HistoryArchive({ dir: dirMissing, now: () => fixedNow })
  const sMissing = arMissing.search('alpha')
  check('search 目录不存在返回空', sMissing.hits.length === 0 && sMissing.files.length === 0 && sMissing.scanned === 0)
  check('stats 目录不存在不抛错', arMissing.stats().files === 0 && arMissing.stats().bytes === 0 && arMissing.stats().oldest === '')

  // 坏行跳过：手工往当天分片里塞垃圾
  const dirBad = join(root, 'bad')
  mkdirSync(dirBad, { recursive: true })
  const arBad = new HistoryArchive({ dir: dirBad, now: () => fixedNow })
  arBad.append({ ts: fixedNow, chatKey: 'g:1', userId: 1, name: 'a', kind: 'message', text: '好行 clean 目标' })
  appendFileSync(join(dirBad, `${day10}.jsonl`), '{坏 json\n[1,2]\nnull\n{"foo":1}\n\n', 'utf8')
  let sBad = null
  let badThrew = false
  try { sBad = arBad.search('clean') } catch { badThrew = true }
  check('search 遇坏行不抛错', badThrew === false)
  check('search 坏行跳过后仍能命中好行', sBad !== null && sBad.hits.length === 1 && sBad.hits[0].text.includes('clean'))
  check('search scanned 把坏行也计入读过', sBad !== null && sBad.scanned === 5, sBad ? String(sBad.scanned) : 'n/a')

  // ============ prune：只移不删 ============
  const pruneBase = join(root, 'prune')
  const archiveDir = join(pruneBase, 'archive')
  const trashDir = join(pruneBase, 'mytrash')
  const pruner = new HistoryArchive({ dir: archiveDir, keepDays: 3, now: () => fixedNow })
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(join(archiveDir, '2026-01-01.jsonl'), '{}\n', 'utf8')
  writeFileSync(join(archiveDir, '2026-03-09.jsonl'), '{}\n', 'utf8')
  writeFileSync(join(archiveDir, '2026-03-10.jsonl'), '{}\n', 'utf8')
  writeFileSync(join(archiveDir, 'notes.txt'), 'keep me\n', 'utf8')
  const pruned = pruner.prune({ trashDir })
  check('prune 返回结构完整', Array.isArray(pruned.moved) && Number.isFinite(pruned.kept), JSON.stringify(pruned))
  check('prune 移走早于 keepDays 的分片', pruned.moved.length === 1 && pruned.moved[0] === '2026-01-01.jsonl', JSON.stringify(pruned.moved))
  check('prune 原文件已不在归档目录', existsSync(join(archiveDir, '2026-01-01.jsonl')) === false)
  const trashDay = localDay(new Date(fixedNow))
  check('prune 目标文件在回收站当天目录', existsSync(join(trashDir, trashDay, '2026-01-01.jsonl')))
  check('prune 未过期分片保留', existsSync(join(archiveDir, '2026-03-09.jsonl')) && existsSync(join(archiveDir, '2026-03-10.jsonl')))
  check('prune 非分片文件不动', existsSync(join(archiveDir, 'notes.txt')))
  check('prune kept 统计保留分片数', pruned.kept === 2, String(pruned.kept))
  check('prune 后 stats 只剩两个分片', pruner.stats().files === 2 && pruner.stats().oldest === '2026-03-09')

  writeFileSync(join(archiveDir, '2026-01-02.jsonl'), '{}\n', 'utf8')
  const pruned2 = pruner.prune({ trashDir })
  check('prune 二次搬迁拿到新文件', pruned2.moved.length === 1 && pruned2.moved[0] === '2026-01-02.jsonl', JSON.stringify(pruned2.moved))
  check('prune 无过期文件时 moved 为空', pruner.prune({ trashDir }).moved.length === 0)

  const defBase = join(root, 'prunedef')
  const defArchive = join(defBase, 'archive')
  const defPruner = new HistoryArchive({ dir: defArchive, keepDays: 1, now: () => fixedNow })
  mkdirSync(defArchive, { recursive: true })
  writeFileSync(join(defArchive, '2026-02-01.jsonl'), '{}\n', 'utf8')
  writeFileSync(join(defArchive, `${day10}.jsonl`), '{}\n', 'utf8')
  const defPruned = defPruner.prune()
  check('prune 未给 trashDir 时默认同级 qq-trash', defPruned.moved.length === 1 && existsSync(join(defBase, 'qq-trash', trashDay, '2026-02-01.jsonl')), JSON.stringify(defPruned.moved))
  check('prune 默认回收站不在归档目录内', existsSync(join(defArchive, 'qq-trash')) === false)
  check('prune 当天分片永不搬走', existsSync(join(defArchive, `${day10}.jsonl`)))

  // ============ stats ============
  const dirS = join(root, 'stats')
  const arS = new HistoryArchive({ dir: dirS, now: () => fixedNow })
  arS.append({ ts: t08, chatKey: 'g:1', userId: 1, name: 'a', kind: 'message', text: '最早' })
  arS.append({ ts: t09, chatKey: 'g:1', userId: 1, name: 'a', kind: 'message', text: '中间' })
  arS.append({ ts: t10, chatKey: 'g:1', userId: 1, name: 'a', kind: 'message', text: '最新' })
  const st = arS.stats()
  check('stats 字段齐全', typeof st.dir === 'string' && typeof st.files === 'number' && typeof st.bytes === 'number' && typeof st.oldest === 'string' && typeof st.newest === 'string', JSON.stringify(st))
  check('stats 指向归档目录', st.dir === dirS)
  check('stats files 计数正确', st.files === 3, String(st.files))
  check('stats oldest/newest 取首尾', st.oldest === day08 && st.newest === day10, `${st.oldest}..${st.newest}`)
  check('stats bytes 大于 0', st.bytes > 0, String(st.bytes))
  check('stats bytes 与实际文件大小一致', st.bytes === statSync(join(dirS, `${day10}.jsonl`)).size + statSync(join(dirS, `${day09}.jsonl`)).size + statSync(join(dirS, `${day08}.jsonl`)).size)
  check('stats 忽略非分片文件', (() => {
    writeFileSync(join(dirS, 'qq-inbox.jsonl'), 'x'.repeat(10), 'utf8')
    return arS.stats().files === 3
  })())
  check('append 落盘行数与文件内容一致', readFileSync(join(dirS, `${day08}.jsonl`), 'utf8').trimEnd().split('\n').length === 1)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
