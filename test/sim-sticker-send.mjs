/** Verify sending a saved sticker (image segment with local file path) end-to-end. */
import wsPackage from 'ws'
const { WebSocket } = wsPackage

const ws = new WebSocket('ws://127.0.0.1:6700/')
const timer = setTimeout(() => { console.log('TIMEOUT 90s'); process.exit(1) }, 90000)

ws.on('open', () => {
  console.log('connected, asking agent to send sticker 姊楀浘')
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 888001, user_id: 777001,
    message: '[CQ:at,qq=10001] 璇疯皟鐢?qq_face_send 鍙戦€佹敹钘忕殑銆屾鍥俱€?,
    message_id: 401,
  }))
})

ws.on('message', (data) => {
  const frame = JSON.parse(String(data))
  if (frame.action) {
    console.log('REPLY message:', JSON.stringify(frame.params.message))
    const segments = frame.params.message || []
    const hasImage = segments.some((s) => s.type === 'image')
    console.log(hasImage ? 'PASS: 鏀惰棌鍥?image 娈?宸插彂鍑? : 'checking text reply...')
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: frame.echo }))
    if (hasImage) { clearTimeout(timer); process.exit(0) }
  }
})

ws.on('error', (e) => { console.log('WS error:', e.message); process.exit(1) })
