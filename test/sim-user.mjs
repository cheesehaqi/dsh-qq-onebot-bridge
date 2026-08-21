/** Simulate a QQ user sending a message and collect the agent reply. */
import wsPackage from 'ws'
const { WebSocket } = wsPackage

const ws = new WebSocket('ws://127.0.0.1:6700/')
const replies = []
const timer = setTimeout(() => {
  console.log('TIMEOUT 75s, replies:', replies.length)
  console.log(replies.join('\n'))
  process.exit(1)
}, 75000)

ws.on('open', () => {
  console.log('connected, sending message')
  ws.send(JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    user_id: 999888,
    message: '璇峰洖澶嶏細妗ユ祴璇曟垚鍔燂紝骞惰涓変釜瀛楃殑鍚嶅瓧',
    message_id: 42,
  }))
})

ws.on('message', (data) => {
  const frame = JSON.parse(String(data))
  if (frame.action) {
    replies.push(`[${frame.action}] ${frame.params?.message ?? ''}`.slice(0, 200))
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: frame.echo }))
    clearTimeout(timer)
    console.log('GOT REPLY:')
    console.log(replies.join('\n'))
    ws.close()
    process.exit(0)
  }
})

ws.on('error', (e) => { console.log('WS error:', e.message); process.exit(1) })
