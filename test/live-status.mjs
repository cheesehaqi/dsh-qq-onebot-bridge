/** End-to-end smoke: connect to the live bridge on 6700 and send /status. */
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://127.0.0.1:6700/')
let done = false
const timer = setTimeout(() => { console.log('TIMEOUT: no reply in 10s'); process.exit(1) }, 10000)

ws.on('open', () => {
  console.log('connected to bridge')
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 123456, message: '/status', message_id: 1 }))
})

ws.on('message', (data) => {
  const frame = JSON.parse(String(data))
  if (frame.action) {
    console.log('bridge action:', frame.action, 'params:', JSON.stringify(frame.params))
    done = true
    clearTimeout(timer)
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo: frame.echo }))
    ws.close()
    process.exit(0)
  }
})

ws.on('error', (e) => { console.log('WS error:', e.message); process.exit(1) })
