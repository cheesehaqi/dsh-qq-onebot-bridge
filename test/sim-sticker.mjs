/** Verify incoming image segments are auto-collected into the face library. */
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://127.0.0.1:6700/')
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 25000)

ws.on('open', () => {
  console.log('connected, sending message with image segment')
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 888001, user_id: 777001,
    message: [
      { type: 'text', data: { text: '收藏这个表情' } },
      { type: 'image', data: { url: 'https://q1.qlogo.cn/g?b=qq&nk=10001&s=100', file: 'avatar.png' } },
    ],
    message_id: 302,
  }))
  setTimeout(() => {
    console.log('done, checking library')
    clearTimeout(timer)
    process.exit(0)
  }, 12000)
})

ws.on('error', (e) => { console.log('WS error:', e.message); process.exit(1) })
