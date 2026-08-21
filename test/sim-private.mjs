/** Verify: private chat fully ignored; group @mention still replied. */
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://127.0.0.1:6700/')
let replies = 0
const timer = setTimeout(() => {
  console.log(`RESULT: ${replies} replies`)
  console.log(replies === 1 ? 'PASS: 私聊被忽略，群@仍有回复' : 'FAIL: 期望恰好 1 条回复')
  process.exit(replies === 1 ? 0 : 1)
}, 55000)

ws.on('open', async () => {
  console.log('connected')
  // 1) private message -> must be ignored
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 999888, message: '私聊测试，应该被忽略', message_id: 201 }))
  await new Promise((r) => setTimeout(r, 7000))
  // 2) group message with @ -> must be replied
  console.log('7s 后发送群 @ 消息')
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 888001, user_id: 777001,
    message: '[CQ:at,qq=10001] 请说：私聊屏蔽生效',
    message_id: 202,
  }))
})

ws.on('message', (data) => {
  const frame = JSON.parse(String(data))
  if (frame.action) {
    replies++
    console.log(`reply #${replies}: [${frame.action}] ${frame.params?.message ?? ''}`.slice(0, 120))
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: frame.echo }))
  }
})

ws.on('error', (e) => { console.log('WS error:', e.message); process.exit(1) })
