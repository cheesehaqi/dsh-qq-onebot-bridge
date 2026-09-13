/** Unit tests for inbound recording + event injection (no bridge, no network). */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FRAME_FIELDS, InboxRecorder, countLines, createLineTailer, describeFrame, expandInjection,
  parseInbox, parseInjectionLine, readInbox, redactFrame, serializeFrame,
} from '../lib/inbox.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
function throws(fn, needle) {
  try { fn(); return false } catch (error) { return needle ? String(error.message).includes(needle) : true }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-inbox-test-'))
let clock = 1_700_000_000_000
const tick = () => (clock += 1000)

// ---- 字段白名单与序列化 ----
check('三种事件都有字段白名单', FRAME_FIELDS.message.length >= 10 && FRAME_FIELDS.notice.length >= 6 && FRAME_FIELDS.request.length >= 6)
check('白名单含关键字段', FRAME_FIELDS.message.includes('atMe') && FRAME_FIELDS.notice.includes('subType') && FRAME_FIELDS.request.includes('flag'))

const rawMsg = {
  messageType: 'group', userId: 1001, groupId: 2002, text: '你好', atMe: true,
  ats: [999], reply: { messageId: 'r1', text: '之前' }, records: [], images: ['http://x/1.png'],
  files: [], messageId: 'm1', senderName: '张三',
  socket: { destroy() {} }, raw: { big: true }, extra: '不该被写入',
}
const line = serializeFrame('message', rawMsg, { now: tick() })
const parsedLine = JSON.parse(line)
check('序列化产出可 JSON.parse 的单行', !line.includes('\n') && parsedLine.v === 1 && parsedLine.kind === 'message')
check('序列化记录时间戳', parsedLine.ts === clock)
check('丢弃 socket/未知字段', parsedLine.frame.socket === undefined && parsedLine.frame.raw === undefined && parsedLine.frame.extra === undefined)
check('保留业务字段', parsedLine.frame.text === '你好' && parsedLine.frame.atMe === true && parsedLine.frame.images[0] === 'http://x/1.png')
check('undefined 字段被跳过', serializeFrame('message', { userId: 1, groupId: undefined }).includes('groupId') === false)
check('超长文本截断到 2000 字', JSON.parse(serializeFrame('message', { userId: 1, text: 'a'.repeat(5000) })).frame.text.length === 2000)
check('未知 kind 抛错', throws(() => serializeFrame('unknown', {}), 'unknown frame kind'))
check('缺失 frame 不抛错且为空对象', JSON.parse(serializeFrame('notice', undefined)).frame.noticeType === undefined)

// ---- 脱敏 ----
check('字符串中的长号码被掩码', redactFrame({ userId: '2000000001' }).userId === '20********')
check('短字符串不受影响', redactFrame({ text: 'abc123' }).text === 'abc123')
check('数字号码保留前两位', redactFrame({ groupId: 100000001 }).groupId === 100000000)
check('小数字不变', redactFrame({ n: 12345 }).n === 12345)
check('数组元素递归脱敏', redactFrame({ ats: [3000000001] }).ats[0] === 3000000000)
check('嵌套对象递归脱敏', redactFrame({ reply: { messageId: '1234567', text: 'x' } }).reply.messageId === '12*****')
check('布尔与 null 原样返回', redactFrame({ a: true, b: null }).a === true && redactFrame({ b: null }).b === null)
const redacted = JSON.parse(serializeFrame('message', { ...rawMsg, userId: 2000000001, groupId: 100000001 }, { redact: true, now: tick() }))
check('序列化时可开启脱敏（数字 QQ 号）', redacted.frame.userId === 2000000000 && redacted.frame.groupId === 100000000, `${redacted.frame.userId}/${redacted.frame.groupId}`)
check('脱敏后仍可读文本', redacted.frame.text === '你好')
check('脱敏模式下短 id 保持原样（无法识别即不误伤）', JSON.parse(serializeFrame('message', { userId: 1001 }, { redact: true })).frame.userId === 1001)
check('countLines 统计非空行', (() => {
  const f = join(dir, 'count.jsonl')
  writeFileSync(f, 'a\n\nb\n', 'utf8')
  return countLines(f) === 2 && countLines(join(dir, 'missing.jsonl')) === 0 && countLines(f, { readFile: () => { throw new Error('x') } }) === 0
})())

// ---- InboxRecorder ----
const recFile = join(dir, 'qq-inbox.jsonl')
const rec = new InboxRecorder({ file: recFile, now: tick })
check('record 写入成功返回 true', rec.record('message', rawMsg) === true && rec.count === 1)
check('summary 暴露文件与计数', rec.summary().file === recFile && rec.summary().recorded === 1 && rec.summary().dropped === 0)
check('summary 标记脱敏开关', new InboxRecorder({ file: recFile, redact: true }).summary().redact === true)
check('落盘内容可直接解析', readInbox(recFile).length === 1)
check('未启用时返回 false 且不写盘', new InboxRecorder({ file: join(dir, 'off.jsonl'), enabled: false }).record('message', rawMsg) === false)
check('无文件路径时不写盘', new InboxRecorder({ file: '' }).record('message', rawMsg) === false)
const toggled = new InboxRecorder({ file: join(dir, 'toggle.jsonl') })
toggled.setEnabled(false)
check('setEnabled(false) 后不写入', toggled.record('message', rawMsg) === false && toggled.count === 0)
toggled.setEnabled(true)
check('setEnabled(true) 后恢复写入', toggled.record('message', rawMsg) === true && toggled.count === 1)
const broken = new InboxRecorder({ file: join(dir, 'sub', 'deep', 'x.jsonl') })
check('自动创建上级目录', broken.record('message', rawMsg) === true)
const badRec = new InboxRecorder({ file: join(dir, 'nokind.jsonl') })
check('非法 kind 被吞掉并计入 dropped', badRec.record('nope', rawMsg) === false && badRec.dropped === 1)
const rotFile = join(dir, 'rotate.jsonl')
const rot = new InboxRecorder({ file: rotFile, maxBytes: 2 * 1024, keepBytes: 256, now: tick })
for (let i = 0; i < 40; i++) rot.record('message', { userId: 1001, groupId: 2002, text: `填充 ${i} ${'x'.repeat(120)}` })
const rotSize = readFileSync(rotFile, 'utf8').length
check('轮转后文件仍小于上限', rotSize <= 2 * 1024 + 400, String(rotSize))
check('轮转后保住最新记录', readInbox(rotFile, { limit: 1 })[0].frame.text.includes('填充 39'))
check('轮转不影响计数', rot.count === 40)

// ---- parseInbox / readInbox ----
const good = JSON.stringify({ v: 1, ts: 1, kind: 'message', frame: { text: 'a' } })
const goodNotice = JSON.stringify({ v: 1, ts: 2, kind: 'notice', frame: { noticeType: 'notify' } })
const messy = [`${good}`, '', '   ', '不是 JSON', '{"v":1,"ts":3}', '{半行', goodNotice, '{"v":1,"frame":{}}', '[]'].join('\n')
check('跳过空行与坏行', parseInbox(messy).length === 2)
check('缺 ts 或 frame 的条目被丢弃', parseInbox(messy).every((e) => typeof e.ts === 'number' && e.frame))
check('kind 过滤生效', parseInbox(messy, { kind: 'notice' }).length === 1 && parseInbox(messy, { kind: 'request' }).length === 0)
check('limit 取最新若干条', parseInbox(messy, { limit: 1 })[0].ts === 2)
check('空文本安全', parseInbox('').length === 0 && parseInbox(null).length === 0 && parseInbox(undefined).length === 0)
check('读取不存在文件返回空数组', readInbox(join(dir, 'nope.jsonl')).length === 0)
check('readInbox 默认只取尾部', readInbox(rotFile, { limit: 3 }).length === 3)
check('readInbox 支持自定义读函数', readInbox('x', { readFile: () => good }).length === 1)
check('readInbox maxBytes 截断后仍可解析', readInbox(recFile, { maxBytes: 40 }).length <= 1)
check('readInbox kind 过滤', readInbox(recFile, { kind: 'notice' }).length === 0)

// ---- describeFrame ----
check('群消息描述含群号与文本', describeFrame({ kind: 'message', frame: { messageType: 'group', groupId: 2002, userId: 1001, text: '你好' } }) === '群 2002 · 1001：你好')
check('@我 被标注', describeFrame({ kind: 'message', frame: { messageType: 'group', groupId: 2002, userId: 1001, atMe: true, text: 'hi' } }).includes('@我'))
check('私聊描述', describeFrame({ kind: 'message', frame: { messageType: 'private', userId: 1001, text: 'hi' } }).startsWith('私聊 ·'))
check('无文本时给出占位', describeFrame({ kind: 'message', frame: { messageType: 'private', userId: 1 } }).includes('（无文本）'))
check('长文本截断到 60 字', describeFrame({ kind: 'message', frame: { messageType: 'private', userId: 1, text: 'x'.repeat(200) } }).length < 100)
check('通知描述', describeFrame({ kind: 'notice', frame: { noticeType: 'notify', subType: 'poke', groupId: 2002, userId: 1001 } }) === 'notify/poke · 群 2002 · 用户 1001')
check('请求描述', describeFrame({ kind: 'request', frame: { requestType: 'group', subType: 'add', groupId: 2002, userId: 1001 } }) === 'group/add · 群 2002 · 用户 1001')
check('缺字段的通知不抛错', describeFrame({ kind: 'notice', frame: {} }).includes('-'))
check('空条目不抛错', describeFrame(undefined) !== '')

// ---- expandInjection ----
const group = expandInjection({ text: '你好', groupId: 2002, userId: 1001 }, { botQq: 999, now: tick() })
check('群消息默认 @ 机器人', group.kind === 'message' && group.frame.messageType === 'group' && group.frame.atMe === true && group.frame.ats[0] === 999)
check('注入消息带唯一 messageId', group.frame.messageId === `inject-${clock}`)
check('注入消息带默认昵称', group.frame.senderName === '注入器')
check('注入消息结构完整', Array.isArray(group.frame.images) && group.frame.records.length === 0 && group.frame.files.length === 0 && group.frame.reply === null)
const groupNoAt = expandInjection({ text: 'hi', groupId: 2002, userId: 1001, atMe: false }, { botQq: 999 })
check('atMe:false 时不 @ 机器人', groupNoAt.frame.atMe === false && groupNoAt.frame.ats.length === 0)
const priv = expandInjection({ text: 'hi', userId: 1001 }, { botQq: 999 })
check('无群号即私聊且不 @', priv.frame.messageType === 'private' && priv.frame.groupId === undefined && priv.frame.atMe === false)
const imgOnly = expandInjection({ groupId: 2002, userId: 1001, images: ['http://x/1.png'] }, { botQq: 999 })
check('纯图片消息可注入', imgOnly.frame.images.length === 1 && imgOnly.frame.images[0].kind === 'image' && imgOnly.frame.text === '')
const reply = expandInjection({ text: 'hi', groupId: 2002, userId: 1001, replyMessageId: 'r9', replyText: '被引用' }, { botQq: 999 })
check('引用消息被展开', reply.frame.reply.messageId === 'r9' && reply.frame.reply.text === '被引用')
const voiced = expandInjection({ groupId: 2002, userId: 1001, records: ['a.silk'], files: ['b.txt'] }, { botQq: 999 })
check('语音与文件被展开', voiced.frame.records[0].file === 'a.silk' && voiced.frame.files[0].name === 'b.txt')
check('缺 userId 抛中文错', throws(() => expandInjection({ text: 'hi', groupId: 2002 }), 'userId'))
check('userId 为 0 抛错', throws(() => expandInjection({ text: 'hi', userId: 0 }), 'userId'))
check('空消息抛中文错', throws(() => expandInjection({ userId: 1001, groupId: 2002 }), '至少要有文本'))
check('可选 messageId/senderName 生效', expandInjection({ text: 'x', userId: 1, messageId: 'm9', senderName: '测试' }).frame.messageId === 'm9')
const fwd = expandInjection({ groupId: 2002, userId: 1001, forwards: ['f1'], forwardText: '小明: 你好' }, { botQq: 999 })
check('转发卡片 id 被展开', fwd.frame.forwards.length === 1 && fwd.frame.forwards[0].id === 'f1')
check('注入可携带预展开的转发正文', fwd.frame.forwardText === '小明: 你好')
check('只给 forwards 也算有内容', expandInjection({ userId: 1001, forwards: ['f2'] }).frame.forwards[0].id === 'f2')
check('forwards 为空数组时仍按空消息报错', throws(() => expandInjection({ userId: 1001, forwards: [] }), '至少要有文本'))
check('转发正文超长被截断', expandInjection({ userId: 1001, forwards: ['f3'], forwardText: 'x'.repeat(5000) }).frame.forwardText.length === 4000)
check('空 spec 抛错而非崩溃', throws(() => expandInjection(), 'userId'))

const poke = expandInjection({ kind: 'notice', noticeType: 'notify', subType: 'poke', groupId: 2002, userId: 1001 }, { botQq: 999, now: tick() })
check('通知注入默认 target 为机器人', poke.kind === 'notice' && poke.frame.targetId === 999 && poke.frame.operatorId === 1001)
check('通知注入带 selfId', poke.frame.selfId === 999)
const autoSub = expandInjection({ kind: 'notice', noticeType: 'notify', groupId: 2002, userId: 1001 }, { botQq: 999 })
check('notify 默认子类型 poke', autoSub.frame.subType === 'poke')
const recallNotice = expandInjection({ kind: 'notice', noticeType: 'friend_recall', userId: 1001 }, { botQq: 999 })
check('好友撤回允许无群号', recallNotice.frame.noticeType === 'friend_recall' && recallNotice.frame.groupId === 0)
check('群通知缺 groupId 抛错', throws(() => expandInjection({ kind: 'notice', noticeType: 'group_recall', userId: 1001 }), 'groupId'))

const reqGroup = expandInjection({ kind: 'request', requestType: 'group', groupId: 2002, userId: 1001, comment: '求进群' }, { now: tick() })
check('群请求注入', reqGroup.kind === 'request' && reqGroup.frame.requestType === 'group' && reqGroup.frame.subType === 'add' && reqGroup.frame.comment === '求进群')
check('请求默认 flag 唯一', reqGroup.frame.flag === `inject-${clock}`)
const reqFriend = expandInjection({ kind: 'request', requestType: 'friend', userId: 1001 }, { now: tick() })
check('好友请求无需群号', reqFriend.frame.requestType === 'friend' && reqFriend.frame.groupId === 0)
check('群请求缺 groupId 抛错', throws(() => expandInjection({ kind: 'request', userId: 1001 }), '群请求注入需要 groupId'))

// ---- 注入行的端到端形状：注入 → 记录 → 解析 ----
const injFile = join(dir, 'roundtrip.jsonl')
const injRec = new InboxRecorder({ file: injFile, now: tick })
const expanded = parseInjectionLine(JSON.stringify({ text: '回放我', groupId: 2002, userId: 1001 }), { botQq: 999, now: tick() })
check('注入行可被解析成事件', expanded.kind === 'message' && expanded.frame.text === '回放我')
check('注入事件可被原样记录', injRec.record(expanded.kind, expanded.frame) === true)
const back = readInbox(injFile, { limit: 1 })[0]
check('记录-解析往返一致', back.frame.text === '回放我' && back.frame.groupId === 2002 && back.frame.messageId === expanded.frame.messageId)
check('坏 JSON 注入行抛中文错', throws(() => parseInjectionLine('{oops'), '合法 JSON'))
check('非对象注入行抛错', throws(() => parseInjectionLine('[1,2]'), 'JSON 对象'))
check('数字注入行抛错', throws(() => parseInjectionLine('42'), 'JSON 对象'))

// ---- createLineTailer ----
const tailFile = join(dir, 'tail.jsonl')
const tailer = createLineTailer(tailFile)
check('文件不存在时 poll 返回空', tailer.poll().length === 0)
check('文件不存在时位置停在 0（等首行，不吞掉）', tailer.position === 0)
writeFileSync(tailFile, 'old-1\nold-2\n', 'utf8')
check('队列文件随后才出现时，其内容算新行（注入通道主路径）', JSON.stringify(tailer.poll()) === '["old-1","old-2"]', JSON.stringify(tailer.poll()))
appendFileSync(tailFile, 'new-1\n', 'utf8')
check('只返回新追加的行', JSON.stringify(tailer.poll()) === '["new-1"]')
check('位置随读取推进', tailer.position === Buffer.byteLength('old-1\nold-2\nnew-1\n'), String(tailer.position))
check('无新增时返回空数组', tailer.poll().length === 0)
// 已存在的文件（生产主场景：桥重启时会话前先有历史行）——用独立文件避免互相干扰
const armedFile = join(dir, 'armed.jsonl')
writeFileSync(armedFile, 'history-1\nhistory-2\n', 'utf8')
const existing = createLineTailer(armedFile)
check('已存在的文件从末尾起读（重启不重放历史）', existing.poll().length === 0 && existing.position === statSync(armedFile).size)
appendFileSync(armedFile, 'after-arm\n', 'utf8')
check('已存在文件的后续追加照常读到', JSON.stringify(existing.poll()) === '["after-arm"]')
appendFileSync(tailFile, '\n\nnew-2\n', 'utf8')
check('忽略空行', JSON.stringify(tailer.poll()) === '["new-2"]')
const fromStart = createLineTailer(tailFile, { initialOffset: 0 })
const history = fromStart.poll()
check('initialOffset=0 时读取全部历史行', history.length === 4, JSON.stringify(history))
appendFileSync(tailFile, 'new-3\n', 'utf8')
check('从 0 开始后仍可增量', JSON.stringify(fromStart.poll()) === '["new-3"]')
fromStart.reset()
appendFileSync(tailFile, 'after-reset\n', 'utf8')
check('reset 跳到末尾后只读新行', JSON.stringify(fromStart.poll()) === '["after-reset"]')
writeFileSync(tailFile, 'truncated\n', 'utf8')
check('文件被替换后把新内容当新行（清空队列后仍能消费）', JSON.stringify(tailer.poll()) === '["truncated"]')
appendFileSync(tailFile, 'brand-new\n', 'utf8')
check('截断后仍能继续增量读取', JSON.stringify(tailer.poll()) === '["brand-new"]')
const gone = createLineTailer(join(dir, 'gone.jsonl'))
gone.poll()
check('文件不存在时位置为 0 而不是 null', gone.position === 0)
writeFileSync(join(dir, 'gone.jsonl'), 'appeared\n', 'utf8')
check('文件随后出现时能读到首行（注入队列场景）', JSON.stringify(gone.poll()) === '["appeared"]')

// 队列文件"先不存在、后被控制台创建"是本功能的主路径，单独回归
const lateFile = join(dir, 'late.jsonl')
const late = createLineTailer(lateFile)
late.reset(true)
check('对不存在的队列文件 reset(true) 后位置为 0', late.position === 0)
writeFileSync(lateFile, '{"text":"第一条注入","userId":1001}\n', 'utf8')
const firstLine = late.poll()
check('队列文件首次创建时首行必须被读到', firstLine.length === 1 && JSON.parse(firstLine[0]).text === '第一条注入', JSON.stringify(firstLine))
appendFileSync(lateFile, '{"text":"第二条注入","userId":1001}\n', 'utf8')
check('之后继续增量读取', late.poll().length === 1)

// 半行容错：正在写入的行先缓冲，绝不以半截 JSON 交出去
const tornFile = join(dir, 'torn.jsonl')
writeFileSync(tornFile, '', 'utf8')
const torn = createLineTailer(tornFile)
torn.poll()
const fullLine = JSON.stringify({ text: '完整注入', groupId: 2002, userId: 1001 })
appendFileSync(tornFile, fullLine.slice(0, 20), 'utf8')
check('写入中途的半行不被交出', torn.poll().length === 0)
check('半行暂存在 pendingBytes', torn.pendingBytes === Buffer.byteLength(fullLine.slice(0, 20)), String(torn.pendingBytes))
appendFileSync(tornFile, `${fullLine.slice(20)}\n`, 'utf8')
const healed = torn.poll()
check('补齐换行后交回完整行', healed.length === 1 && healed[0] === fullLine)
check('完整行可被解析成注入事件', parseInjectionLine(healed[0], { botQq: 999 }).frame.text === '完整注入')
check('缓冲清空', torn.pendingBytes === 0)
appendFileSync(tornFile, 'no-newline-yet', 'utf8')
check('无换行的尾部继续缓冲', torn.poll().length === 0 && torn.pendingBytes === Buffer.byteLength('no-newline-yet'), String(torn.pendingBytes))
appendFileSync(tornFile, '\n', 'utf8')
check('补上换行后立即交付', JSON.stringify(torn.poll()) === '["no-newline-yet"]')
// 启动时不能重放历史注入：默认从"最后一个完整行之后"开始
writeFileSync(tornFile, 'old-a\nold-b\n', 'utf8')
const fresh = createLineTailer(tornFile)
check('新建 tailer 默认从末尾起读（不重放历史）', fresh.poll().length === 0)
appendFileSync(tornFile, 'live\n', 'utf8')
check('只在追加后交付新行', JSON.stringify(fresh.poll()) === '["live"]')
writeFileSync(tornFile, 'old-a\nold-b\n半截未写完', 'utf8')
const afterTorn = createLineTailer(tornFile)
check('末尾半行被缓冲而非当成完整行交付', afterTorn.poll().length === 0 && afterTorn.pendingBytes > 0, String(afterTorn.pendingBytes))
appendFileSync(tornFile, '\nlive-2\n', 'utf8')
check('半行补全后作为完整行交付，且历史行未被重放', JSON.stringify(afterTorn.poll()) === JSON.stringify(['半截未写完', 'live-2']))
torn.reset(false)
const allLines = torn.poll()
check('reset(false) 从头读取全部行', allLines.length === 4, JSON.stringify(allLines))
torn.reset(true)
check('reset(true) 跳回末尾且不重放', torn.poll().length === 0 && torn.position === Buffer.byteLength(readFileSync(tornFile, 'utf8')), String(torn.position))
appendFileSync(tornFile, 'post-reset\n', 'utf8')
check('reset(true) 之后仍能读到新行', JSON.stringify(torn.poll()) === '["post-reset"]')
torn.reset(false)
appendFileSync(tornFile, 'after-rewind\n', 'utf8')
const replayed = torn.poll()
check('reset(false) 之后读到全量加新行', replayed.length === 6, JSON.stringify(replayed))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
