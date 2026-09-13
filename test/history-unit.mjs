/** Unit tests for recent-message normalization (get_group_msg_history / get_friend_msg_history) and line formatting. */
import { normalizeHistoryMessages, formatHistoryLines } from '../lib/history.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// —— 1. 段类型转换：一段一段验，任何一段错了都能一眼看出是哪一种 ——
const segments = normalizeHistoryMessages([{
  message_id: 1, user_id: 10001, sender: { card: '小明' }, time: 1700000000,
  message: [
    { type: 'at', data: { qq: '10000' } },
    { type: 'text', data: { text: '你好' } },
    { type: 'image', data: { file: 'a.jpg' } },
    { type: 'mface', data: {} },
    { type: 'record', data: {} },
    { type: 'file', data: { name: '报告.pdf' } },
    { type: 'face', data: { id: 1 } },
    { type: 'forward', data: { id: 'x' } },
  ],
}]).messages[0]
check('段:at', segments.text.includes('@10000'), segments.text)
check('段:文本', segments.text.includes('你好'))
check('段:image/mface 同为[图片]', (segments.text.match(/\[图片\]/g) ?? []).length === 2, segments.text)
check('段:record→[语音]', segments.text.includes('[语音]'))
check('段:file 带名', segments.text.includes('[文件 报告.pdf]'))
check('段:face→[表情]', segments.text.includes('[表情]'))
check('段:forward→[转发记录]', segments.text.includes('[转发记录]'))

const unknownSeg = normalizeHistoryMessages([{
  message_id: 2, user_id: 1, sender: { nickname: '甲' }, time: 1,
  message: [{ type: 'reply', data: { id: '9' } }, { type: 'json', data: { data: '{}' } }, { type: 'xml', data: {} }, { type: 'poke', data: {} }, { type: 'weird_future_type', data: {} }, { type: 'text', data: { text: '正文' } }],
}]).messages[0]
check('忽略 reply/json/xml/poke 与未知段', unknownSeg.text === '正文', JSON.stringify(unknownSeg.text))

const atName = normalizeHistoryMessages([{
  message_id: 3, user_id: 1, sender: { nickname: '甲' }, time: 1,
  message: [{ type: 'at', data: { qq: '10000', name: '小鲸鱼' } }],
}]).messages[0]
check('at 段优先用显示名', atName.text === '@小鲸鱼', atName.text)

const atEmpty = normalizeHistoryMessages([{
  message_id: 4, user_id: 1, sender: { nickname: '甲' }, time: 1,
  message: [{ type: 'at', data: {} }],
}]).messages[0]
check('at 段缺 qq/name 退化成 @', atEmpty.text === '@', JSON.stringify(atEmpty.text))

const fileNoName = normalizeHistoryMessages([{
  message_id: 5, user_id: 1, sender: { nickname: '甲' }, time: 1,
  message: [{ type: 'file', data: {} }],
}]).messages[0]
check('file 段无名→[文件]', fileNoName.text === '[文件]', fileNoName.text)

const spaced = normalizeHistoryMessages([{
  message_id: 6, user_id: 1, sender: { nickname: '甲' }, time: 1,
  message: [{ type: 'text', data: { text: '  你好   世界\u3000\u3000啊  ' } }],
}]).messages[0]
check('连续空白含全角压成一个并 trim', spaced.text === '你好 世界 啊', JSON.stringify(spaced.text))

const strBody = normalizeHistoryMessages([{ message_id: 7, user_id: 1, sender: { nickname: '甲' }, time: 1, message: '  字符串消息  ' }]).messages[0]
check('message 是字符串', strBody.text === '字符串消息', JSON.stringify(strBody.text))

// —— 2. 显示名优先级与各字段兜底 ——
const named = normalizeHistoryMessages([
  { message_id: 10, user_id: 101, sender: { card: '群名片', nickname: '昵称' }, time: 1700000100, message: '卡片优先' },
  { message_id: 11, user_id: 102, sender: { card: '   ', nickname: '只有昵称' }, time: 1700000101, message: '昵称兜底' },
  { message_id: 12, user_id: 103, sender: {}, time: 1700000102, message: '退到QQ号' },
  { message_id: 13, user_id: 104, time: 1700000103, message: '连 sender 都没有' },
]).messages
check('sender.card 优先于 nickname', named[0].name === '群名片', named[0].name)
check('card 是空白串时退到 nickname', named[1].name === '只有昵称', JSON.stringify(named[1].name))
check('无卡片无昵称退到 QQ<id>', named[2].name === 'QQ103', named[2].name)
check('完全没有 sender 也用 QQ<id>', named[3].name === 'QQ104', named[3].name)
check('userId 正常取到', named[0].userId === 101 && named[3].userId === 104)

const badFields = normalizeHistoryMessages([{ message_id: null, user_id: '不是数字', sender: {}, time: 'abc', message: '兜底字段' }]).messages[0]
check('message_id 拿不到用空串', badFields.id === '', JSON.stringify(badFields.id))
check('user_id 非法归 0', badFields.userId === 0, String(badFields.userId))
check('time 非法归 0', badFields.time === 0, String(badFields.time))
check('无有效 userId 时昵称=未知用户', badFields.name === '未知用户', badFields.name)
check('message_id 是数字时转字符串', normalizeHistoryMessages([{ message_id: 4242, user_id: 1, time: 1, message: 'x' }]).messages[0].id === '4242')

const noTime = normalizeHistoryMessages([{ message_id: 20, user_id: 200, message: '没有时间字段' }]).messages[0]
check('缺 time 回落到 0', noTime.time === 0 && noTime.text === '没有时间字段', JSON.stringify(noTime))

// —— 3. raw_message 只作兜底 ——
const rawFallback = normalizeHistoryMessages([{ message_id: 30, user_id: 301, sender: { nickname: '甲' }, time: 1700000200, raw_message: '  原始文本兜底  ' }]).messages[0]
check('message 缺失时用 raw_message', rawFallback.text === '原始文本兜底', JSON.stringify(rawFallback.text))

const rawNotPreferred = normalizeHistoryMessages([{ message_id: 31, user_id: 302, time: 1, message: '结构化的', raw_message: '原始的' }]).messages[0]
check('message 存在时不看 raw_message', rawNotPreferred.text === '结构化的', rawNotPreferred.text)

const emptySegs = normalizeHistoryMessages([{ message_id: 32, user_id: 303, time: 1, message: [], raw_message: '空段数组的兜底' }]).messages[0]
check('message 是空数组时 raw_message 兜底', emptySegs.text === '空段数组的兜底', emptySegs.text)

const onlyReply = normalizeHistoryMessages([{ message_id: 33, user_id: 304, time: 1, message: [{ type: 'reply', data: { id: '1' } }], raw_message: '被引用的原文' }]).messages[0]
check('只有 reply 段时也用 raw_message 兜底', onlyReply.text === '被引用的原文', onlyReply.text)

// —— 4. 坏项计数：绝不抛错 ——
const broken = normalizeHistoryMessages([
  null,
  undefined,
  123,
  'not-an-object',
  {},
  { message_id: 40, user_id: 401, time: 1700000300, message: '唯一的好消息' },
])
check('坏项计入 dropped', broken.dropped === 5, String(broken.dropped))
check('坏项被跳过、好消息保留', broken.messages.length === 1 && broken.messages[0].text === '唯一的好消息')
check('有可解析条目时 reason 为空', broken.reason === '', JSON.stringify(broken.reason))

// 坏项排在 limit 之外的极端情形：limit=1 时只看得到第一条
check('limit 之外不做解析', normalizeHistoryMessages([null, null, { message_id: 41, user_id: 1, message: 'x' }], { limit: 1 }).dropped === 1)

const allBroken = normalizeHistoryMessages([null, 5, 'x', {}])
check('全是坏项 → dropped 计数', allBroken.dropped === 4 && allBroken.messages.length === 0, JSON.stringify(allBroken))
check('全是坏项 → 中文原因', allBroken.reason === '消息列表无法解析', JSON.stringify(allBroken.reason))

check('rawList 非数组（null）', JSON.stringify(normalizeHistoryMessages(null)) === JSON.stringify({ messages: [], dropped: 0, reason: '载荷为空或不是消息列表' }))
check('rawList 非数组（对象）', normalizeHistoryMessages({ messages: [1] }).messages.length === 0)
check('rawList 非数组（字符串）', normalizeHistoryMessages('nope').reason === '载荷为空或不是消息列表')
check('空数组 → dropped 0 / reason 空', normalizeHistoryMessages([]).dropped === 0 && normalizeHistoryMessages([]).reason === '')
check('不传 options 也能跑', normalizeHistoryMessages([{ message_id: 42, user_id: 1, message: '默认参数' }]).messages.length === 1)

// —— 5. limit 条数上限（不计入 dropped） ——
const many = Array.from({ length: 60 }, (_, i) => ({ message_id: 1000 + i, user_id: 900, sender: { nickname: '刷屏' }, time: 1700001000 + i, message: `第${i}条` }))
const capped = normalizeHistoryMessages(many, { limit: 20 })
check('limit 生效：只保留 20 条', capped.messages.length === 20, String(capped.messages.length))
check('limit 生效：保留的是最新的一批', capped.messages[0].text === '第0条' && capped.messages[19].text === '第19条', capped.messages[19]?.text)
check('被 limit 丢掉的不计 dropped', capped.dropped === 0, String(capped.dropped))

const limitDefault = normalizeHistoryMessages(Array.from({ length: 25 }, (_, i) => ({ message_id: i, user_id: 1, time: 1, message: 'm' + i })))
check('默认 limit 为 20', limitDefault.messages.length === 20 && limitDefault.dropped === 0, String(limitDefault.messages.length))
check('limit: 0 回落默认 20', normalizeHistoryMessages(many, { limit: 0 }).messages.length === 20, String(normalizeHistoryMessages(many, { limit: 0 }).messages.length))
check('limit: NaN 回落默认 20', normalizeHistoryMessages(many, { limit: NaN }).messages.length === 20)
check('limit: Infinity 回落默认 20', normalizeHistoryMessages(many, { limit: Infinity }).messages.length === 20)
check('limit: -3 回落默认 20', normalizeHistoryMessages(many, { limit: -3 }).messages.length === 20)
check('limit: 5.9 向下取整为 5', normalizeHistoryMessages(many, { limit: 5.9 }).messages.length === 5)

// —— 6. 单条 maxChars 截断 ——
const longOne = normalizeHistoryMessages([{ message_id: 50, user_id: 500, sender: { nickname: '话痨' }, time: 1700000400, message: 'A'.repeat(500) }], { maxChars: 100 }).messages[0]
check('单条文本按 maxChars 截断', longOne.text.startsWith('A'.repeat(100)) && longOne.text.includes('…（过长已截断）'), `len=${longOne.text.length}`)
check('单条截断后长度=上限+提示语', longOne.text.length === 100 + '…（过长已截断）'.length, String(longOne.text.length))
const shortOne = normalizeHistoryMessages([{ message_id: 51, user_id: 501, time: 1, message: '短消息' }], { maxChars: 100 }).messages[0]
check('未超上限不加提示语', shortOne.text === '短消息' && !shortOne.text.includes('已截断'), shortOne.text)
check('maxChars: -5 回落默认 2000', !normalizeHistoryMessages([{ message_id: 52, user_id: 502, time: 1, message: 'B'.repeat(2500) }], { maxChars: -5 }).messages[0].text.includes('已截断') || normalizeHistoryMessages([{ message_id: 53, user_id: 503, time: 1, message: 'B'.repeat(2500) }], { maxChars: -5 }).messages[0].text.length === 2000 + '…（过长已截断）'.length)
check('maxChars: NaN 回落默认 2000', normalizeHistoryMessages([{ message_id: 54, user_id: 504, time: 1, message: 'C'.repeat(30) }], { maxChars: NaN }).messages[0].text === 'C'.repeat(30))
check('botQq 传了也不影响结果', normalizeHistoryMessages(many, { limit: 3, botQq: 900 }).messages.length === 3)

// —— 7. formatHistoryLines：排序 / 截断 / 我 / 时间格式 ——
const ooo = formatHistoryLines([
  { id: 'c', userId: 3, name: '丙', time: 1700003000, text: '第三句' },
  { id: 'a', userId: 1, name: '甲', time: 1700001000, text: '第一句' },
  { id: 'b', userId: 2, name: '乙', time: 1700002000, text: '第二句' },
])
check('按 time 升序排序', ooo.text.indexOf('第一句') < ooo.text.indexOf('第二句') && ooo.text.indexOf('第二句') < ooo.text.indexOf('第三句'), JSON.stringify(ooo.text))
check('used/total/chars', ooo.used === 3 && ooo.total === 3 && ooo.chars === ooo.text.length)
check('未超 limit 时不标 truncated', ooo.truncated === false)
check('首行含标题与总数', ooo.text.split('\n')[0] === '[最近消息 共 3 条]', ooo.text.split('\n')[0])

const zeroFirst = formatHistoryLines([
  { id: 'z', userId: 4, name: '丁', time: 1700004000, text: '有时间' },
  { id: 'y', userId: 5, name: '戊', time: 0, text: '没有时间' },
])
check('time=0 排最前', zeroFirst.text.indexOf('没有时间') < zeroFirst.text.indexOf('有时间'), JSON.stringify(zeroFirst.text))
check('time=0 显示 --:--', zeroFirst.text.includes('--:-- 戊: 没有时间'), JSON.stringify(zeroFirst.text))

const sameTime = formatHistoryLines([
  { id: 'p', userId: 1, name: '甲', time: 1700005000, text: '先来的' },
  { id: 'q', userId: 2, name: '乙', time: 1700005000, text: '后来的' },
])
check('同一时间保持传入顺序（稳定排序）', sameTime.text.indexOf('先来的') < sameTime.text.indexOf('后来的'), JSON.stringify(sameTime.text))

const expectedClock = (() => { const d = new Date(1700000000 * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` })()
const clockLine = formatHistoryLines([{ id: 'k', userId: 6, name: '己', time: 1700000000, text: '时钟' }])
check('HH:mm 按本地时区格式化', clockLine.text.includes(`${expectedClock} 己: 时钟`), JSON.stringify(clockLine.text))

const recent = formatHistoryLines(Array.from({ length: 26 }, (_, i) => ({ id: 'm' + i, userId: 7, name: '刷屏', time: 1700010000 + i, text: '第' + i + '条' })))
check('超 limit 时显示最近 M 条（保留末尾）', recent.text.includes('第25条') && !recent.text.includes('第5条'), '第5条是否入榜=' + recent.text.includes('第5条'))
check('超 limit 时 used/truncated', recent.used === 20 && recent.total === 26 && recent.truncated === true)
check('截断提示写「显示最近 20 条」', recent.text.split('\n')[0] === '[最近消息 共 26 条，显示最近 20 条]', recent.text.split('\n')[0])

const selfLines = formatHistoryLines([
  { id: 's1', userId: 10001, name: '小鲸鱼', time: 1700006000, text: '我是机器人' },
  { id: 's2', userId: 10002, name: '小明', time: 1700006060, text: '我是人类' },
], { selfId: 10001 })
check('selfId 命中加（我）', selfLines.text.includes('小鲸鱼（我）: 我是机器人'), JSON.stringify(selfLines.text))
check('selfId 未命中不加（我）', !selfLines.text.includes('小明（我）'))
check('selfId 为 0 时不标（我）', !formatHistoryLines([{ id: 's3', userId: 10002, name: '小明', time: 1700006060, text: 'x' }]).text.includes('（我）'))

const withEmpty = formatHistoryLines([{ id: 'e1', userId: 1, name: '甲', time: 1, text: '有内容' }, { id: 'e2', userId: 1, name: '甲', time: 2, text: '   ' }, { id: 'e3', userId: 1, name: '甲', time: 3, text: '' }])
check('空文本条目跳过（used）', withEmpty.used === 1 && withEmpty.text.split('\n').length === 2, JSON.stringify(withEmpty.text))
check('空文本条目仍计入 total', withEmpty.total === 3, String(withEmpty.total))
check('无正文时只有首行', formatHistoryLines([{ id: 'e4', userId: 1, time: 1, text: '  ' }]).text === '[最近消息 共 1 条]', formatHistoryLines([{ id: 'e4', userId: 1, time: 1, text: '  ' }]).text)
check('自定义 title', formatHistoryLines([{ id: 't', userId: 1, name: '甲', time: 1, text: 'x' }], { title: '本群最近消息' }).text.startsWith('[本群最近消息 共 1 条]'))

const bodyClipped = formatHistoryLines(Array.from({ length: 30 }, (_, i) => ({ id: 'b' + i, userId: 1, name: '甲', time: 1700020000 + i, text: 'X'.repeat(50) })), { limit: 30, maxChars: 120 })
check('正文按 maxChars 截断并提示', bodyClipped.text.includes('…（内容过长已截断）') && bodyClipped.truncated === true, `chars=${bodyClipped.chars}`)
check('截断后 chars 自洽', bodyClipped.chars === bodyClipped.text.length && bodyClipped.used === 30)

const notArray = formatHistoryLines(null)
check('messages 非数组返回空文本', notArray.text === '' && notArray.used === 0 && notArray.total === 0 && notArray.truncated === false, JSON.stringify(notArray))
check('messages 非数组时 chars 为 0', formatHistoryLines('nope').chars === 0)
check('空数组给首行', formatHistoryLines([]).text === '[最近消息 共 0 条]', formatHistoryLines([]).text)
check('formatHistoryLines 的非法 limit 回落', formatHistoryLines(Array.from({ length: 25 }, (_, i) => ({ id: 'n' + i, userId: 1, name: '甲', time: i + 1, text: 'x' })), { limit: NaN }).used === 20)

// —— 8. 端到端：真实形状载荷 → 模型看到的文本 ——
const rawPayload = {
  status: 'ok', retcode: 0,
  data: {
    messages: [
      { message_id: 91001, user_id: 20002, sender: { nickname: '小明', card: '' }, time: 1700030000, message: [{ type: 'text', data: { text: '今晚开黑吗' } }], raw_message: '今晚开黑吗' },
      { message_id: 91002, user_id: 10001, sender: { nickname: '小鲸鱼', card: '机器人' }, time: 1700030060, message: [{ type: 'at', data: { qq: '20002', name: '小明' } }, { type: 'text', data: { text: ' 我在 ' } }], raw_message: '[CQ:at,qq=20002] 我在 ' },
      { message_id: 91003, user_id: 20002, sender: { nickname: '小明' }, time: 1700030120, message: [{ type: 'image', data: { file: 'x.jpg' } }, { type: 'text', data: { text: '发张图' } }], raw_message: '[CQ:image,file=x.jpg]发张图' },
    ],
  },
}
const endToEnd = normalizeHistoryMessages(rawPayload.data.messages, { botQq: 10001, limit: 20, maxChars: 2000 })
const endToEndText = formatHistoryLines(endToEnd.messages, { selfId: 10001, title: '本群最近消息' }).text
check('真实载荷端到端条数', endToEnd.messages.length === 3 && endToEnd.dropped === 0)
check('真实载荷端到端文本', endToEndText.split('\n').length === 4 && endToEndText.includes('小明: 今晚开黑吗') && endToEndText.includes('@小明 我在') && endToEndText.includes('[图片] 发张图'), JSON.stringify(endToEndText))
check('真实载荷里机器人自己标（我）', endToEndText.includes('机器人（我）: @小明 我在'), JSON.stringify(endToEndText))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
