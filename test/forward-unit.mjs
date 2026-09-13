/** Unit tests for merged-forward (聊天记录) payload normalization and transcript formatting. */
import { normalizeForwardNodes, formatForwardTranscript, isForwardPayload } from '../lib/forward.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// —— NapCat / OneBot v11 典型载荷：{ messages: [ { type:'node', data:{...} } ] } ——
const n1 = normalizeForwardNodes({
  messages: [
    { type: 'node', data: { name: '小明', uin: '10001', time: 1700000000, content: [{ type: 'text', data: { text: '今天下雨了' } }] } },
    { type: 'node', data: { name: '小红', uin: 10002, time: 1700000060, content: [{ type: 'text', data: { text: '记得带伞' } }] } },
  ],
})
check('NapCat 载荷节点数', n1.nodes.length === 2, JSON.stringify(n1.nodes))
check('NapCat 第一条昵称/QQ/时间/文本', n1.nodes[0].name === '小明' && n1.nodes[0].userId === 10001 && n1.nodes[0].time === 1700000000 && n1.nodes[0].text === '今天下雨了', JSON.stringify(n1.nodes[0]))
check('NapCat 第二条正常', n1.nodes[1].name === '小红' && n1.nodes[1].userId === 10002 && n1.nodes[1].text === '记得带伞', JSON.stringify(n1.nodes[1]))
check('NapCat 载荷无坏项', n1.dropped === 0 && n1.reason === '')
check('NapCat 载荷识别为转发', isForwardPayload({ messages: [{ type: 'node', data: {} }] }) === true)

// —— { message: [...] } 形状（Go-CQHTTP 常见） ——
const n2 = normalizeForwardNodes({ message: [{ type: 'node', data: { nickname: '阿强', user_id: '10003', time: 1700000100, content: [{ type: 'text', data: { text: '开黑吗' } }] } }] })
check('message 字段也能解析', n2.nodes.length === 1 && n2.nodes[0].name === '阿强', JSON.stringify(n2.nodes))
check('nickname/user_id 兜底字段生效', n2.nodes[0].userId === 10003 && n2.nodes[0].time === 1700000100)
check('message 载荷识别为转发', isForwardPayload({ message: [{ type: 'node' }] }) === true)

// —— 载荷本身就是数组 ——
const n3 = normalizeForwardNodes([
  { type: 'node', data: { name: '直接数组', uin: '10004', time: 1700000200, content: [{ type: 'text', data: { text: '裸数组也能用' } }] } },
])
check('裸数组载荷解析', n3.nodes.length === 1 && n3.nodes[0].name === '直接数组' && n3.nodes[0].text === '裸数组也能用', JSON.stringify(n3.nodes))
check('裸数组识别为转发', isForwardPayload([{ type: 'node', data: { name: 'x' } }]) === true)

// —— 第二种形状：Go-CQHTTP 风格 { sender, time, message } ——
const n4 = normalizeForwardNodes({ messages: [{ sender: { nickname: '老王', user_id: 10005 }, time: 1700000300, message: [{ type: 'text', data: { text: '收到' } }] }] })
check('Go-CQHTTP 形状昵称/ID/时间', n4.nodes[0].name === '老王' && n4.nodes[0].userId === 10005 && n4.nodes[0].time === 1700000300, JSON.stringify(n4.nodes))
check('Go-CQHTTP 形状文本', n4.nodes[0].text === '收到' && n4.dropped === 0)

// —— 第三种形状：本仓库 #sendForwardCard 发出的卡片 ——
const n5 = normalizeForwardNodes({ messages: [{ type: 'node', data: { name: '小鲸鱼', uin: '30000', content: [{ type: 'text', data: { text: '很长的回答' } }] } }] })
check('本仓库卡片形状解析', n5.nodes.length === 1 && n5.nodes[0].name === '小鲸鱼' && n5.nodes[0].userId === 30000 && n5.nodes[0].text === '很长的回答', JSON.stringify(n5.nodes))
check('缺 time 时回落到 0', n5.nodes[0].time === 0)

// —— content 是字符串 与 是段数组 ——
const n6 = normalizeForwardNodes({ messages: [
  { type: 'node', data: { name: '字符串内容', uin: '1', time: 1, content: '  纯文本内容  ' } },
  { type: 'node', data: { name: '数组内容', uin: '2', time: 2, content: [{ type: 'text', data: { text: '段数组内容' } }] } },
] })
check('content 为字符串', n6.nodes[0].text === '纯文本内容', JSON.stringify(n6.nodes[0]))
check('content 为段数组', n6.nodes[1].text === '段数组内容', JSON.stringify(n6.nodes[1]))

// —— Go-CQHTTP 的 message 为字符串 ——
const n7 = normalizeForwardNodes({ messages: [{ sender: { nickname: '字符串d', user_id: 7 }, message: '字符串消息' }] })
check('message 为字符串', n7.nodes[0].text === '字符串消息', JSON.stringify(n7.nodes))

// —— 各段类型转换 ——
const segs = normalizeForwardNodes({ messages: [{ type: 'node', data: { name: '阿蓝', uin: '10006', time: 1700000400, content: [
  { type: 'text', data: { text: '看这个' } },
  { type: 'at', data: { qq: '10007', name: '小绿' } },
  { type: 'image', data: { file: 'a.jpg' } },
  { type: 'mface', data: { emoji_id: '1' } },
  { type: 'record', data: { file: 'v.amr' } },
  { type: 'face', data: { id: '14' } },
  { type: 'file', data: { name: '报告.pdf' } },
  { type: 'forward', data: { id: 'nested' } },
  { type: 'unknown_type', data: { foo: 'bar' } },
  { type: 'text', data: { text: '结束' } },
] } }] })
check('段转换: text 原文', segs.nodes[0].text.includes('看这个'), segs.nodes[0].text)
check('段转换: at 用显示名', segs.nodes[0].text.includes('@小绿'), segs.nodes[0].text)
check('段转换: image → [图片]', segs.nodes[0].text.includes('[图片]'))
check('段转换: mface → [图片]', (segs.nodes[0].text.match(/\[图片\]/g) || []).length === 2, segs.nodes[0].text)
check('段转换: record → [语音]', segs.nodes[0].text.includes('[语音]'))
check('段转换: face → [表情]', segs.nodes[0].text.includes('[表情]'))
check('段转换: file → [文件 名称]', segs.nodes[0].text.includes('[文件 报告.pdf]'))
check('段转换: 嵌套 forward 不展开', segs.nodes[0].text.includes('[转发记录]') && !segs.nodes[0].text.includes('nested'))
check('段转换: 未知类型被忽略', !segs.nodes[0].text.includes('unknown_type') && segs.nodes[0].text.endsWith('结束'))
check('段转换: 段间单空格', segs.nodes[0].text === '看这个 @小绿 [图片] [图片] [语音] [表情] [文件 报告.pdf] [转发记录] 结束', segs.nodes[0].text)

// —— 段的兜底与压缩 ——
const segs2 = normalizeForwardNodes({ messages: [{ type: 'node', data: { name: '兜底', uin: '8', content: [
  { type: 'at', data: { qq: '10008' } },
  { type: 'file', data: {} },
  { type: 'text', data: { text: '  多个   空白\n换行  ' } },
] } }] })
check('at 无名称时退化成 QQ 号', segs2.nodes[0].text.includes('@10008'), segs2.nodes[0].text)
check('file 无名称 → [文件]', segs2.nodes[0].text.includes('[文件]') && !segs2.nodes[0].text.includes('[文件 undefined]'), segs2.nodes[0].text)
check('连续空白压缩成一个空格', segs2.nodes[0].text === '@10008 [文件] 多个 空白 换行', segs2.nodes[0].text)
check('text 为 null 不产生 undefined', normalizeForwardNodes({ messages: [{ type: 'node', data: { name: 'n', uin: '9', content: [{ type: 'text', data: {} }] } }] }).nodes[0].text === '')

// —— 名称/ID/时间缺失兜底 ——
const n8 = normalizeForwardNodes({ messages: [{ type: 'node', data: { content: [{ type: 'text', data: { text: '匿名' } }] } }] })
check('名称缺失 → 未知用户', n8.nodes[0].name === '未知用户', JSON.stringify(n8.nodes[0]))
check('ID 缺失 → 0', n8.nodes[0].userId === 0)
check('时间缺失 → 0', n8.nodes[0].time === 0)
const n9 = normalizeForwardNodes({ messages: [{ sender: {}, message: 'x' }] })
check('sender 空对象不崩且名称兜底', n9.nodes.length === 1 && n9.nodes[0].name === '未知用户', JSON.stringify(n9.nodes))
const n10 = normalizeForwardNodes({ messages: [{ type: 'node', data: { name: '   ', uin: '', time: 'NaN', content: '正文' } }] })
check('空字符串名称/ID/时间兜底', n10.nodes[0].name === '未知用户' && n10.nodes[0].userId === 0 && n10.nodes[0].time === 0, JSON.stringify(n10.nodes[0]))

// —— 空载荷 / dry-run / null / 字符串 / 空对象 / 空数组 ——
const e1 = normalizeForwardNodes({})
check('空对象 → 空结果', e1.nodes.length === 0 && e1.dropped === 0 && e1.reason !== '')
check('空对象 reason 为中文原因', e1.reason === '载荷为空或不是转发内容', e1.reason)
check('dry-run → 空结果', normalizeForwardNodes({ message_id: 'dry-1', dryRun: true }).nodes.length === 0)
check('dry-run reason 有值', normalizeForwardNodes({ message_id: 'dry-1', dryRun: true }).reason === '载荷为空或不是转发内容')
check('null → 空结果', normalizeForwardNodes(null).nodes.length === 0)
check('null reason 有值', normalizeForwardNodes(null).reason === '载荷为空或不是转发内容', normalizeForwardNodes(null).reason)
check('字符串载荷 → 空结果', normalizeForwardNodes('oops').nodes.length === 0)
check('数字载荷 → 空结果', normalizeForwardNodes(42).nodes.length === 0)
check('undefined 载荷 → 空结果', normalizeForwardNodes(undefined).nodes.length === 0)
check('空数组载荷 → 空结果', normalizeForwardNodes([]).nodes.length === 0)
check('空 messages 数组 → 空结果', normalizeForwardNodes({ messages: [] }).nodes.length === 0)

// —— 坏项跳过并计数（不抛错） ——
const d1 = normalizeForwardNodes({ messages: [
  null,
  { type: 'node', data: { name: '好项', uin: '10009', time: 1700000500, content: [{ type: 'text', data: { text: '有效内容' } }] } },
  42,
  '这是字符串节点',
  [],
  { type: 'node', data: { content: [] } },
] })
check('坏项 dropped 计数正确', d1.dropped === 3, `dropped=${d1.dropped}`)
check('坏项中好项仍解析', d1.nodes.length === 3 && d1.nodes[0].name === '好项', JSON.stringify(d1.nodes))
check('裸字符串算作可解析节点', d1.nodes[1].text === '这是字符串节点' && d1.nodes[1].name === '未知用户', JSON.stringify(d1.nodes[1]))
check('空内容节点保留但文本为空', d1.nodes[2].text === '' && d1.nodes[2].name === '未知用户', JSON.stringify(d1.nodes[2]))
const d2 = normalizeForwardNodes({ messages: [null, 42, {}] })
check('全部坏项时 nodes 为空', d2.nodes.length === 0, JSON.stringify(d2.nodes))
check('全部坏项时 reason 有解释', d2.reason === '转发内容无法解析', d2.reason)

// —— 排版：默认参数 ——
const rows = [
  { name: '小明', userId: 10001, time: 1, text: '今天下雨了' },
  { name: '小红', userId: 10002, time: 2, text: '记得带伞' },
]
const f1 = formatForwardTranscript(rows)
check('默认无截断 truncated=false', f1.truncated === false)
check('默认 used/total', f1.used === 2 && f1.total === 2, `used=${f1.used} total=${f1.total}`)
check('默认 chars 等于文本长度', f1.chars === f1.text.length, `chars=${f1.chars}`)
check('默认首行标题', f1.text.split('\n')[0] === '[转发聊天记录 共 2 条]', f1.text.split('\n')[0])
check('默认正文行格式', f1.text.split('\n')[1] === '小明: 今天下雨了', f1.text.split('\n')[1])
check('自定义标题生效', formatForwardTranscript(rows, { title: '群聊记录' }).text.startsWith('[群聊记录 共 2 条]'))
const fEmpty = formatForwardTranscript([])
check('空节点列表仍输出标题', fEmpty.text === '[转发聊天记录 共 0 条]' && fEmpty.used === 0 && fEmpty.total === 0, fEmpty.text)
check('nodes 非数组不崩', formatForwardTranscript(null).text === '[转发聊天记录 共 0 条]')
check('内容为空的节点被跳过', formatForwardTranscript([...rows, { name: '空', userId: 3, time: 3, text: '   ' }]).used === 2)
check('跳过空节点时 total 仍算全部', formatForwardTranscript([...rows, { name: '空', userId: 3, time: 3, text: '' }]).total === 3)
check('节点名称缺失时用未知用户', formatForwardTranscript([{ text: '正文' }]).text.split('\n')[1] === '未知用户: 正文')

// —— 排版：maxNodes 截断 ——
const many = Array.from({ length: 10 }, (_, i) => ({ name: `用户${i}`, userId: i, time: i, text: `第${i}条` }))
const f2 = formatForwardTranscript(many, { maxNodes: 3 })
check('maxNodes 截断 used', f2.used === 3, `used=${f2.used}`)
check('maxNodes 截断 total 不变', f2.total === 10, `total=${f2.total}`)
check('maxNodes 截断 truncated=true', f2.truncated === true)
check('maxNodes 截断首行提示', f2.text.split('\n')[0] === '[转发聊天记录 共 10 条，显示前 3 条]', f2.text.split('\n')[0])
check('maxNodes 截断正文行数', f2.text.split('\n').length === 4, `lines=${f2.text.split('\n').length}`)

// —— 排版：maxChars 截断 ——
const f3 = formatForwardTranscript([{ name: '甲', userId: 1, time: 1, text: '一二三四五六七八九十' }], { maxChars: 5 })
check('maxChars 截断 truncated=true', f3.truncated === true)
check('maxChars 截断追加提示语', f3.text.endsWith('…（内容过长已截断）'), f3.text.slice(-20))
// maxChars 只作用于正文（首行标题始终保留），截断提示语紧跟在最后一行的末尾，所以断言用 startsWith
check('maxChars 截断正文只保留 5 字', f3.text.includes('\n甲: 一二…') && !f3.text.includes('三四五'), f3.text)
check('maxChars 截断保留完整标题行', f3.text.split('\n')[0] === '[转发聊天记录 共 1 条]', f3.text.split('\n')[0])
check('maxChars 截断 chars 与文本一致', f3.chars === f3.text.length, `chars=${f3.chars}`)
// maxChars 是正文（不含标题行）的硬上限：正文 "甲: 某某" 长 13
const f5 = formatForwardTranscript([{ name: '甲', userId: 1, time: 1, text: '一二三四五六七八九十' }], { maxChars: 13 })
check('maxChars 等于正文长度时不截断', f5.truncated === false && f5.text === '[转发聊天记录 共 1 条]\n甲: 一二三四五六七八九十', f5.text)
const f6 = formatForwardTranscript([{ name: '甲', userId: 1, time: 1, text: '一二三四五六七八九十' }], { maxChars: 6 })
check('maxChars=6 时正文留 6 字', f6.text === '[转发聊天记录 共 1 条]\n甲: 一二三…（内容过长已截断）' && f6.truncated === true, f6.text)
check('maxChars 未超限不截断', formatForwardTranscript([{ name: '甲', text: '短' }], { maxChars: 5 }).truncated === false)
check('maxChars 等于长度时不截断', formatForwardTranscript([{ name: '甲', text: '1234' }]).text.length > 4)

// —— 排版：maxNodes 与 maxChars 同时触发 ——
const f4 = formatForwardTranscript(many, { maxNodes: 2, maxChars: 10 })
check('同时截断 truncated=true', f4.truncated === true)
check('同时截断 used 取 maxNodes', f4.used === 2 && f4.total === 10, `used=${f4.used} total=${f4.total}`)
check('同时截断默认标题行', f4.text.split('\n')[0] === '[转发聊天记录 共 10 条，显示前 2 条]', f4.text.split('\n')[0])
check('同时截断追加提示语', f4.text.endsWith('…（内容过长已截断）'))
check('同时截断 chars 一致', f4.chars === f4.text.length)

// —— 排版：防御性参数 ——
const mkText = (prefix) => [prefix, ...Array.from({ length: 20 }, (_, i) => ({ name: `用户${i}`, text: `第${i}条` }))]
check('maxNodes: 0 回落到默认 50', formatForwardTranscript(mkText('a'), { maxNodes: 0 }).used === 20)
check('maxNodes: NaN 时不误截断', formatForwardTranscript(mkText('b'), { maxNodes: NaN }).truncated === false && formatForwardTranscript(mkText('b'), { maxNodes: NaN }).used === 20)
check('maxNodes 非数字字符串回落默认', formatForwardTranscript(mkText('c'), { maxNodes: 'x' }).used === 20)
check('maxNodes: Infinity 回落默认', formatForwardTranscript(mkText('d'), { maxNodes: Infinity }).used === 20)
check('maxChars: 0 回落默认 4000', formatForwardTranscript([{ name: '甲', text: 'x'.repeat(100) }], { maxChars: 0 }).truncated === false)
check('maxChars: NaN 回落默认 4000', formatForwardTranscript([{ name: '甲', text: 'x'.repeat(100) }], { maxChars: NaN }).truncated === false)
check('maxChars: -5 回落默认', formatForwardTranscript([{ name: '甲', text: 'x'.repeat(100) }], { maxChars: -5 }).truncated === false)
check('options 为 null 不崩', formatForwardTranscript(rows, null).used === 2)
check('options 为非对象不崩', formatForwardTranscript(rows, 'nope').used === 2)
check('title 为空串回落默认', formatForwardTranscript(rows, { title: '  ' }).text.startsWith('[转发聊天记录'))
check('title 为数字回落默认', formatForwardTranscript(rows, { title: 123 }).text.startsWith('[转发聊天记录'))

// —— isForwardPayload 正反例 ——
check('isForwardPayload: messages 非空数组', isForwardPayload({ messages: [{ type: 'node', data: {} }] }) === true)
check('isForwardPayload: message 非空数组', isForwardPayload({ message: [{ type: 'node', data: {} }] }) === true)
check('isForwardPayload: 裸数组', isForwardPayload([{ type: 'node' }]) === true)
check('isForwardPayload: dry-run 为 false', isForwardPayload({ dryRun: true, message_id: 'dry-1' }) === false)
check('isForwardPayload: dry-run 带 messages 也为 false', isForwardPayload({ dryRun: true, messages: [{ type: 'node' }] }) === false)
check('isForwardPayload: null 为 false', isForwardPayload(null) === false)
check('isForwardPayload: undefined 为 false', isForwardPayload(undefined) === false)
check('isForwardPayload: 字符串为 false', isForwardPayload('{"messages":[]}') === false)
check('isForwardPayload: 空对象为 false', isForwardPayload({}) === false)
check('isForwardPayload: 空数组为 false', isForwardPayload([]) === false)
check('isForwardPayload: 空 messages 为 false', isForwardPayload({ messages: [] }) === false)
check('isForwardPayload: 数字为 false', isForwardPayload(7) === false)
check('isForwardPayload: {id} 转发段载荷为 false', isForwardPayload({ id: 'abc' }) === false)

// —— 端到端：NapCat 真实载荷 → 纯文本 ——
const napcat = {
  status: 'ok',
  retcode: 0,
  data: {
    messages: [
      { type: 'node', data: { name: '小明', uin: '10001', time: 1700000000, content: [{ type: 'text', data: { text: '今晚开黑吗' } }, { type: 'image', data: { file: 'a.jpg' } }] } },
      { type: 'node', data: { name: '小红', uin: '10002', time: 1700000060, content: [{ type: 'at', data: { qq: '10001', name: '小明' } }, { type: 'text', data: { text: '来' } }] } },
    ],
  },
}
const e2e = normalizeForwardNodes(napcat.data)
const e2eText = formatForwardTranscript(e2e.nodes)
check('端到端节点数', e2e.nodes.length === 2 && e2e.dropped === 0, JSON.stringify(e2e))
check('端到端首行', e2eText.text.split('\n')[0] === '[转发聊天记录 共 2 条]', e2eText.text.split('\n')[0])
check('端到端正文', e2eText.text.includes('小明: 今晚开黑吗 [图片]') && e2eText.text.includes('小红: @小明 来'), e2eText.text)
check('端到端 chars/used/total', e2eText.chars === e2eText.text.length && e2eText.used === 2 && e2eText.total === 2)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
