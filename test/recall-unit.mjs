/** Unit tests for the anti-recall cache and notice formatting (no network). */
import { RecallCache, formatRecallNotice, isRecallNotice } from '../lib/recall.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

function entry(messageId, over = {}) {
  return { messageId, userId: 10001, name: '小明', text: '今晚八点开黑', ...over }
}

// ---------- 记录 / 命中 / 移除 ----------
const cache = new RecallCache()
const stored = cache.remember('g:100', entry('m1'))
check('remember 返回规范化条目', stored?.messageId === 'm1' && stored.name === '小明', JSON.stringify(stored))
check('remember 后可统计数量', cache.size('g:100') === 1)
check('last 返回最近一条', cache.last('g:100')?.messageId === 'm1')
const hit = cache.recall('g:100', 'm1')
check('recall 命中返回条目', hit?.messageId === 'm1' && hit.text === '今晚八点开黑', JSON.stringify(hit))
check('命中后从缓存移除', cache.size('g:100') === 0 && cache.recall('g:100', 'm1') === null)
check('未命中返回 null', cache.recall('g:100', 'nope') === null && cache.recall('g:404', 'm1') === null)
check('空 messageId 不记录', cache.remember('g:100', { text: '无 id' }) === null && cache.size('g:100') === 0)

// 不同会话互不干扰
cache.remember('g:100', entry('a1'))
cache.remember('u:200', entry('b1', { name: '小红', text: '私聊内容' }))
check('会话隔离', cache.size('g:100') === 1 && cache.size('u:200') === 1)
check('会话各自 last', cache.last('g:100')?.messageId === 'a1' && cache.last('u:200')?.messageId === 'b1')
check('last 空会话返回 null', cache.last('g:404') === null)

// ---------- 同 id 覆盖 ----------
const idem = new RecallCache()
idem.remember('g:1', entry('m1', { text: '旧内容', name: '小明' }))
idem.remember('g:1', entry('m1', { text: '新内容', name: '小明明' }))
check('同 messageId 覆盖不重复插入', idem.size('g:1') === 1)
check('同 messageId 内容被更新', idem.last('g:1')?.text === '新内容' && idem.last('g:1')?.name === '小明明', JSON.stringify(idem.last('g:1')))

// ---------- maxPerChat 截断 ----------
const small = new RecallCache({ maxPerChat: 3 })
for (let i = 1; i <= 5; i++) small.remember('g:2', entry(`m${i}`, { text: `第${i}条` }))
check('超过 maxPerChat 只保留上限条数', small.size('g:2') === 3, `size=${small.size('g:2')}`)
check('截断丢弃最旧的', small.recall('g:2', 'm1') === null && small.recall('g:2', 'm2') === null)
check('保留最新的三条', small.recall('g:2', 'm5')?.text === '第5条' && small.recall('g:2', 'm3')?.text === '第3条')

// 覆盖更新不应触发额外截断
const over = new RecallCache({ maxPerChat: 2 })
over.remember('g:3', entry('x1'))
over.remember('g:3', entry('x2'))
over.remember('g:3', entry('x1', { text: '更新后的第一条' }))
check('覆盖更新保持条数', over.size('g:3') === 2)
check('覆盖更新不改变最新顺序', over.last('g:3')?.messageId === 'x1')
over.remember('g:3', entry('x3'))
check('覆盖后再插入仍按上限截断', over.size('g:3') === 2 && over.recall('g:3', 'x2') === null)

// ---------- 按时间 prune ----------
const aging = new RecallCache({ maxAgeMs: 1000, now: () => 5000 })
aging.remember('g:4', entry('old', { at: 3000 })) // 距 5000 为 2000 → 过期
aging.remember('g:4', entry('fresh', { at: 4500 })) // 距 5000 为 500 → 保留
const pruned = aging.prune(5000)
check('prune 返回清理条数', pruned === 1, `removed=${pruned}`)
check('prune 保留未过期条目', aging.size('g:4') === 1 && aging.last('g:4')?.messageId === 'fresh')
check('全部过期后清理整个会话', aging.prune(10_000) === 1 && aging.size('g:4') === 0)
const aging2 = new RecallCache({ maxAgeMs: 10, now: () => 1_000_000 })
aging2.remember('g:9', entry('t1')) // 未显式传 at → 用注入时钟
check('prune 默认按注入时钟判断', aging2.prune() === 0)
const aging3 = new RecallCache({ maxAgeMs: 10, now: () => 1_000_000 })
aging3.remember('g:9', entry('t1', { at: 1_000_000 - 11 }))
check('默认 prune 清理过期条目', aging3.prune() === 1)

// 边界：正好等于 maxAgeMs 不算过期
const edge = new RecallCache({ maxAgeMs: 1000 })
edge.remember('g:5', entry('e1', { at: 1000 }))
check('恰好等于 maxAgeMs 不过期', edge.prune(2000) === 0 && edge.size('g:5') === 1)

// ---------- clear ----------
const clearable = new RecallCache()
clearable.remember('g:6', entry('c1'))
clearable.remember('g:7', entry('c2'))
clearable.clear('g:6')
check('clear 只清指定会话', clearable.size('g:6') === 0 && clearable.size('g:7') === 1)
clearable.clear()
check('clear 无参数清空全部', clearable.size('g:7') === 0)

// ---------- toJSON / fromJSON ----------
const src = new RecallCache({ maxPerChat: 2, maxAgeMs: 60_000, now: () => 42 })
src.remember('g:8', entry('j1', { text: '第一条', images: ['https://example.com/1.png'] }))
src.remember('g:8', entry('j2', { text: '第二条' }))
src.remember('g:8', entry('j3', { text: '第三条' }))
src.remember('u:9', entry('p1', { name: '小红', text: '私聊里的图', images: ['https://example.com/p.png'] }))
const dumped = src.toJSON()
check('toJSON 结构完整', dumped.version === 1 && dumped.maxPerChat === 2 && typeof dumped.chats === 'object', JSON.stringify(Object.keys(dumped)))
check('toJSON 保持 maxPerChat 截断', dumped.chats['g:8'].length === 2 && dumped.total === 3)
const restored = RecallCache.fromJSON(JSON.parse(JSON.stringify(dumped)), { maxPerChat: 2, maxAgeMs: 60_000 })
check('fromJSON 恢复条数', restored.size('g:8') === 2 && restored.size('u:9') === 1)
check('fromJSON 往返一致', JSON.stringify(restored.toJSON().chats) === JSON.stringify(dumped.chats), JSON.stringify(restored.toJSON().chats))
check('fromJSON 保留时间戳', restored.last('g:8')?.at === 42 && restored.last('g:8')?.text === '第三条')
check('fromJSON 保留图片', restored.last('u:9')?.images.length === 1 && restored.last('u:9')?.images[0] === 'https://example.com/p.png')
check('fromJSON 恢复后仍可命中/移除', restored.recall('g:8', 'j3')?.messageId === 'j3' && restored.size('g:8') === 1)
const restoredSmall = RecallCache.fromJSON(dumped, { maxPerChat: 1 })
check('fromJSON 遵守传入的 maxPerChat', restoredSmall.size('g:8') === 1 && restoredSmall.recall('g:8', 'j3')?.text === '第三条')
check('fromJSON 容错非法结构', RecallCache.fromJSON(null).size('g:8') === 0 && RecallCache.fromJSON({ chats: { 'g:8': 'oops' } }).size('g:8') === 0)

// ---------- formatRecallNotice ----------
const withImages = cache.remember('g:100', entry('img', { images: ['https://example.com/a.png', 'https://example.com/b.png'] }))
const noticeWithImages = formatRecallNotice(withImages)
check('有图播报含发言人', String(noticeWithImages).includes('🕵️ 小明 撤回了一条消息：'), String(noticeWithImages))
check('有图播报含内容', String(noticeWithImages).includes('内容：今晚八点开黑'))
check('有图播报含图片数量', String(noticeWithImages).includes('（含 2 张图片，已一并补发）'), String(noticeWithImages))
check('播报保留图片供补发', Array.isArray(noticeWithImages.images) && noticeWithImages.images.length === 2)
check('播报内容是纯文本', typeof noticeWithImages.text === 'string' && noticeWithImages.text.split('\n').length === 3)
check('单图文案用「1 张图片」', String(formatRecallNotice(entry('one', { images: ['https://example.com/only.png'] }))).includes('（含 1 张图片，已一并补发）'))
const many = formatRecallNotice(entry('many', { images: ['https://example.com/1.png', 'https://example.com/2.png', 'https://example.com/3.png', 'https://example.com/4.png'] }))
check('超过 3 张只提示总数', String(many).includes('（含 4 张图片，已一并补发）') && many.images.length === 4, String(many))
check('恰好 3 张按总数提示', String(formatRecallNotice(entry('three', { images: ['https://example.com/1.png', 'https://example.com/2.png', 'https://example.com/3.png'] }))).includes('（含 3 张图片，已一并补发）'))

const noImage = formatRecallNotice(entry('plain', { text: '记得带伞' }))
check('无图播报不含图片提示', !String(noImage).includes('张图片') && String(noImage).includes('内容：记得带伞'), String(noImage))
check('无图播报 images 为空数组', Array.isArray(noImage.images) && noImage.images.length === 0)

const emptyText = formatRecallNotice({ messageId: 'e1', userId: 20002, name: '', text: '' })
check('空内容用占位文案', String(emptyText).includes('（内容为空或无法获取）'), String(emptyText))
check('无昵称时用 QQ 号', String(emptyText).includes('🕵️ 20002 撤回了一条消息：'), String(emptyText))
const nullEntry = formatRecallNotice(null)
check('entry 为空也不报错', String(nullEntry).includes('（内容为空或无法获取）') && String(nullEntry).includes('有人'), String(nullEntry))
check('多行文本被压成一行', String(formatRecallNotice(entry('ml', { text: '第一行\n第二行' }))).includes('内容：第一行 第二行'))
check('非 http 图片不计入数量', String(formatRecallNotice(entry('bad', { images: ['file:///tmp/x.png', 'not-a-url'] }))).split('\n').length === 2)
check('可自定义 botName', formatRecallNotice(entry('bn'), { botName: '小助手' }).botName === '小助手')

// ---------- isRecallNotice ----------
check('group_recall 为真', isRecallNotice({ noticeType: 'group_recall', subType: 'recall', groupId: 100000001, userId: 10001, operatorId: 10001, messageId: 12345 }) === true)
check('friend_recall 为真', isRecallNotice({ noticeType: 'friend_recall', userId: 10001, messageId: 999 }) === true)
check('poke 通知为假', isRecallNotice({ noticeType: 'notify', subType: 'poke', userId: 10001 }) === false)
check('入群通知为假', isRecallNotice({ noticeType: 'group_increase', groupId: 100000001, userId: 10001 }) === false)
check('空值/空对象为假', isRecallNotice(null) === false && isRecallNotice(undefined) === false && isRecallNotice({}) === false)
check('缺 noticeType 为假', isRecallNotice({ messageId: 1, userId: 2 }) === false)
check('字符串帧为假', isRecallNotice('group_recall') === false)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
