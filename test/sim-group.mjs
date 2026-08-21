/** Verify group @-mention behavior: no-mention ignored, mention replied. */
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://127.0.0.1:6700/')
let replies = 0
const done = new Set()

const timer = setTimeout(() => {
  console.log(`RESULT: ${replies} replies received`)
  console.log(replies === 1 ? 'PASS: 无@消息被忽略，@消息有回复' : 'FAIL: 期望恰好 1 条回复')
  process.exit(replies === 1 ? 0 : 1)
}, 60000)

ws.on('open', async () => {
  console.log('connected')
  // 1) group message WITHOUT mention -> should be ignored
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 888001, user_id: 777001,
    message: '这条消息没有@机器人，应该被忽略',
    message_id: 101,
  }))
  await new Promise((r) => setTimeout(r, 8000))
  // 2) group message WITH mention of bot 10001 -> should be replied
  console.log('8s 后发送 @机器人 消息')
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 888001, user_id: 777001,
    message: '[CQ:at,qq=10001,name=小鲸鱼] 请说：已收到群消息',
    message_id: 102,
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
