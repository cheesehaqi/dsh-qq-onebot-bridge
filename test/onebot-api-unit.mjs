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

await server.start()
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

client.close()
await server.stop()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
