/**
 * Transport-level tests for the OneBot reverse-WS server: inbound message /
 * notice / request frames plus every write-action payload. Runs its own server
 * and client in-process, so no DSH host and no external OneBot implementation.
 */
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { OneBotServer, parseNotice, parseRequest } from '../lib/onebot.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ---- pure frame parsing ----
const groupReq = parseRequest({ post_type: 'request', request_type: 'group', sub_type: 'add', user_id: 1001, group_id: 2002, comment: '求进群', flag: 'flag-1' })
check('parseRequest 群请求', groupReq.requestType === 'group' && groupReq.userId === 1001 && groupReq.groupId === 2002 && groupReq.flag === 'flag-1')
check('parseRequest 保留验证消息', groupReq.comment === '求进群')
const friendReq = parseRequest({ post_type: 'request', request_type: 'friend', user_id: 1003, flag: 'f2' })
check('parseRequest 好友请求', friendReq.requestType === 'friend' && friendReq.groupId === 0)
check('parseRequest 非请求帧返回 null', parseRequest({ post_type: 'message' }) === null)
check('parseRequest 空输入返回 null', parseRequest(null) === null)
const recall = parseNotice({ post_type: 'notice', notice_type: 'group_recall', group_id: 9, user_id: 5, operator_id: 6, message_id: 777 })
check('parseNotice 撤回携带 messageId', recall.messageId === 777 && recall.noticeType === 'group_recall')
check('parseNotice 撤回携带 operatorId', recall.operatorId === 6)
check('parseNotice 非 notice 返回 null', parseNotice({ post_type: 'message' }) === null)

// ---- live transport ----
const port = 16600 + Math.floor(Math.random() * 300)
const logger = { info() {}, warn() {}, error() {} }
const server = new OneBotServer({ host: '127.0.0.1', port, accessToken: '', botQq: 12345 }, logger)

const events = { message: [], notice: [], request: [] }
server.on('message', (message) => events.message.push(message))
server.on('notice', (notice) => events.notice.push(notice))
server.on('request', (request) => events.request.push(request))

const started = await server.start()
// v0.5.9：start() 返回结果对象（旧实现返回 void，且端口被占时会挂死 + 抛未捕获错误）。
check('start() 成功时返回 { ok: true }', started?.ok === true, JSON.stringify(started))
const client = new WebSocket(`ws://127.0.0.1:${port}`)
await once(client, 'open')
await new Promise((resolve) => setTimeout(resolve, 50))

const frames = []
client.on('message', (raw) => {
  const frame = JSON.parse(String(raw))
  frames.push(frame)
  client.send(JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo, data: { message_id: 4242 } }))
})

const socket = server.currentSocket()
check('连接后 currentSocket 可用', socket !== null)

/** Send one API call and assert the frame the server produced. */
async function expectFrame(name, call, assert, expectedData) {
  const before = frames.length
  const data = await call()
  const frame = frames[before]
  const ok = frame !== undefined && assert(frame)
  check(name, ok, frame ? JSON.stringify(frame.params).slice(0, 80) : 'no frame')
  if (expectedData !== undefined) check(`${name}（返回值）`, data !== undefined && data.message_id === expectedData, JSON.stringify(data))
}

await expectFrame('delete_msg 负载', () => server.deleteMsg(socket, 55), (f) => f.action === 'delete_msg' && f.params.message_id === 55, 4242)
await expectFrame('set_group_ban 负载', () => server.setGroupBan(socket, 9, 5, 60), (f) => f.action === 'set_group_ban' && f.params.duration === 60 && f.params.user_id === 5)
await expectFrame('set_group_card 负载', () => server.setGroupCard(socket, 9, 5, '新名字'), (f) => f.action === 'set_group_card' && f.params.card === '新名字')
await expectFrame('set_group_whole_ban 负载', () => server.setGroupWholeBan(socket, 9, true), (f) => f.action === 'set_group_whole_ban' && f.params.enable === true)
await expectFrame('set_essence_msg 负载', () => server.setEssenceMsg(socket, 77), (f) => f.action === 'set_essence_msg' && f.params.message_id === 77)
await expectFrame('_send_group_notice 负载', () => server.sendGroupNotice(socket, 9, '公告内容'), (f) => f.action === '_send_group_notice' && f.params.content === '公告内容')
await expectFrame('send_group_forward_msg 负载', () => server.sendForwardMsg(socket, 'group', 9, [{ type: 'node' }]), (f) => f.action === 'send_group_forward_msg' && Array.isArray(f.params.messages))
await expectFrame('send_private_forward_msg 负载', () => server.sendForwardMsg(socket, 'private', 5, [{ type: 'node' }]), (f) => f.action === 'send_private_forward_msg' && f.params.user_id === 5)
await expectFrame('upload_group_file 负载', () => server.uploadFile(socket, 'group', 9, 'D:/x/a.zip', 'a.zip'), (f) => f.action === 'upload_group_file' && f.params.file === 'D:/x/a.zip' && f.params.name === 'a.zip')
await expectFrame('upload_private_file 负载', () => server.uploadFile(socket, 'private', 5, 'D:/x/a.zip'), (f) => f.action === 'upload_private_file' && f.params.user_id === 5)
await expectFrame('set_group_add_request 负载', () => server.setGroupAddRequest(socket, 'flag-9', 'add', true, 'ok'), (f) => f.action === 'set_group_add_request' && f.params.flag === 'flag-9' && f.params.approve === true)
await expectFrame('set_friend_add_request 负载', () => server.setFriendAddRequest(socket, 'flag-8', false), (f) => f.action === 'set_friend_add_request' && f.params.approve === false)
await expectFrame('get_group_member_list 负载', () => server.getGroupMemberList(socket, 9), (f) => f.action === 'get_group_member_list' && f.params.group_id === 9)
await expectFrame('get_group_honor_info 负载', () => server.getGroupHonorInfo(socket, 9, 'talk'), (f) => f.action === 'get_group_honor_info' && f.params.type === 'talk')
await expectFrame('set_msg_emoji_like 负载', () => server.setMsgEmojiLike(socket, 12, 128077), (f) => f.action === 'set_msg_emoji_like' && f.params.emoji_id === 128077)
await expectFrame('get_version_info 负载', () => server.getVersionInfo(socket), (f) => f.action === 'get_version_info')
await expectFrame('get_group_notice 负载', () => server.getGroupNotice(socket, 9), (f) => f.action === '_get_group_notice' && f.params.group_id === 9)
await expectFrame('get_group_msg_history 负载', () => server.getGroupMsgHistory(socket, 9, 100, 5), (f) => f.action === 'get_group_msg_history' && f.params.count === 5)

// ---- v0.5.8 新动作：**线路级**负载（真正的组装在 lib/onebot.js，mock 层断言不了它）----
// 探针红线：`enable` 省略时 NapCat 按 false 处理（= 静默撤管理员），
// 所以这里必须看到 enable **始终存在**，撤管理员时是 false 而不是缺字段。
await expectFrame('set_group_admin 设管理员', () => server.setGroupAdmin(socket, 9, 1001, true),
  (f) => f.action === 'set_group_admin' && f.params.group_id === '9' && f.params.user_id === '1001' && f.params.enable === true)
await expectFrame('set_group_admin 撤管理员带显式 false', () => server.setGroupAdmin(socket, 9, 1001, false),
  (f) => f.action === 'set_group_admin' && Object.hasOwn(f.params, 'enable') && f.params.enable === false)
await expectFrame('set_group_admin 传非布尔也只发布尔', () => server.setGroupAdmin(socket, 9, 1001, 'yes'),
  (f) => f.params.enable === false)
await expectFrame('set_group_member_invite_policy 负载', () => server.setGroupMemberInvitePolicy(socket, 9, 'no_approval_under_100'),
  (f) => f.action === 'set_group_member_invite_policy' && f.params.policy === 'no_approval_under_100' && f.params.group_id === '9')
// 探针：只有 4/5 会连问题/答案一起写；1–3 夹带字段等于往群设置里写脏数据。
await expectFrame('set_group_add_option 取值 3 不带问题/答案', () => server.setGroupAddOption(socket, 9, 3, { question: '不该出现', answer: '也不该' }),
  (f) => f.action === 'set_group_add_option' && f.params.add_type === 3 && !('group_question' in f.params) && !('group_answer' in f.params))
await expectFrame('set_group_add_option 取值 4 带问题+答案', () => server.setGroupAddOption(socket, 9, 4, { question: '口令？', answer: '鲸鱼' }),
  (f) => f.params.add_type === 4 && f.params.group_question === '口令？' && f.params.group_answer === '鲸鱼')
await expectFrame('set_group_add_option 取值 5 答案强制空串', () => server.setGroupAddOption(socket, 9, 5, { question: '口令？', answer: '给了也不要' }),
  (f) => f.params.add_type === 5 && f.params.group_question === '口令？' && f.params.group_answer === '')
await expectFrame('get_group_signed_list 负载', () => server.getGroupSignedList(socket, 9),
  (f) => f.action === 'get_group_signed_list' && f.params.group_id === '9')
await expectFrame('get_group_system_msg 负载', () => server.getGroupSystemMsg(socket, 50),
  (f) => f.action === 'get_group_system_msg' && f.params.count === 50)
await expectFrame('get_doubt_friends_add_request 负载', () => server.getDoubtFriendsAddRequest(socket, 30),
  (f) => f.action === 'get_doubt_friends_add_request' && f.params.count === 30)
// 探针：可疑好友只能同意（approve 被 NapCat 忽略）→ 这里**不该**出现 approve 字段。
await expectFrame('set_doubt_friends_add_request 只带 flag', () => server.setDoubtFriendsAddRequest(socket, 'uid-abc'),
  (f) => f.action === 'set_doubt_friends_add_request' && f.params.flag === 'uid-abc' && !('approve' in f.params))
await expectFrame('get_group_list 负载（控制台/群发现用）', () => server.getGroupSystemMsg(socket, 1),
  (f) => f.action === 'get_group_system_msg' && f.params.count === 1)
check('每次调用 echo 唯一', new Set(frames.map((f) => f.echo)).size === frames.length)

// ---- inbound frames ----
client.send(JSON.stringify({
  post_type: 'message', message_type: 'group', group_id: 2002, user_id: 1001, message_id: 31,
  sender: { card: '小明' }, message: '[CQ:at,qq=12345] 你好',
}))
client.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_recall', group_id: 2002, user_id: 1001, operator_id: 1001, message_id: 31 }))
client.send(JSON.stringify({ post_type: 'request', request_type: 'group', sub_type: 'add', user_id: 1001, group_id: 2002, comment: '答案：19', flag: 'req-1' }))
await new Promise((resolve) => setTimeout(resolve, 80))

check('收到群消息事件且识别 @', events.message.length === 1 && events.message[0].atMe === true && events.message[0].text === '你好')
check('收到撤回 notice 事件', events.notice.length === 1 && events.notice[0].messageId === 31)
check('收到入群请求事件', events.request.length === 1 && events.request[0].flag === 'req-1' && events.request[0].comment === '答案：19')

// ---- v0.5.9：端口被占时必须"如实返回失败"，不许挂死、不许抛未捕获错误 ----
// 场景：web 宿主与官方桌面端（Electron）同时跑同一份配置，只有一个能绑上 6700。
{
  const second = new OneBotServer({ host: '127.0.0.1', port, accessToken: '', botQq: 12345 }, logger)
  const errors = []
  let unhandled = null
  const onUncaught = (error) => { unhandled = error }
  process.once('uncaughtException', onUncaught)
  second.on('server-error', (error) => errors.push(error))
  const result = await second.start()
  await new Promise((resolve) => setTimeout(resolve, 50))
  process.removeListener('uncaughtException', onUncaught)
  check('端口被占时 start() 返回 ok:false 而不是挂死', result?.ok === false, JSON.stringify(result))
  check('端口被占的错误码是 EADDRINUSE', result?.code === 'EADDRINUSE', String(result?.code))
  check('端口被占时走 server-error 事件（不抛 uncaughtException）', unhandled === null && errors.length === 1, unhandled ? String(unhandled.message) : `server-error=${errors.length}`)
  await second.stop()
  // 第一个实例必须毫发无损：再走一次请求-响应
  const before = frames.length
  await server.getVersionInfo(socket)
  check('端口冲突之后原实例仍能正常工作', frames.length === before + 1, `frames=${frames.length - before}`)
}
{
  // 重试路径：同一个 server 反复 start()，最后一次仍应给出同样的结论（不泄漏、不抛）。
  const retry = new OneBotServer({ host: '127.0.0.1', port, accessToken: '', botQq: 12345 }, logger)
  const first = await retry.start()
  const secondTry = await retry.start()
  check('连续两次 start() 都返回失败且结论一致',
    first?.ok === false && secondTry?.ok === false && secondTry?.code === 'EADDRINUSE',
    JSON.stringify([first, secondTry]))
  await retry.stop()
}

client.close()
await server.stop()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
