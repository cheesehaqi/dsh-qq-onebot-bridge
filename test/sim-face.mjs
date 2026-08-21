/** Verify [face:xxx] markers in agent replies become CQ face segments. */
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://127.0.0.1:6700/')
let replies = []
const timer = setTimeout(() => {
  console.log('TIMEOUT, replies:', JSON.stringify(replies, null, 1))
  process.exit(1)
}, 90000)

ws.on('open', () => {
  console.log('connected')
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 888001, user_id: 777001,
    message: '[CQ:at,qq=10001] 请回复：收到[face:鼓掌]，另外[face:微笑]',
    message_id: 301,
  }))
})

ws.on('message', (data) => {
  const frame = JSON.parse(String(data))
  if (frame.action) {
    replies.push(frame.params)
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: frame.echo }))
    console.log('REPLY message:', JSON.stringify(frame.params.message))
    const faceIds = (frame.params.message || []).filter((s) => s.type === 'face').map((s) => s.data?.id)
    console.log('face ids found:', faceIds.join(','))
    if (faceIds.includes('42') && faceIds.includes('14')) {
      console.log('PASS: 表情段已替换（鼓掌42、微笑14）')
      clearTimeout(timer)
      process.exit(0)
    }
  }
})

ws.on('error', (e) => { console.log('WS error:', e.message); process.exit(1) })
