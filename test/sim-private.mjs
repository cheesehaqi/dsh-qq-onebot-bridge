/** Verify: private chat fully ignored; group @mention still replied. */
import wsPackage from 'ws'
const { WebSocket } = wsPackage

const ws = new WebSocket('ws://127.0.0.1:6700/')
let replies = 0
const timer = setTimeout(() => {
  console.log(`RESULT: ${replies} replies`)
  console.log(replies === 1 ? 'PASS: 绉佽亰琚拷鐣ワ紝缇浠嶆湁鍥炲' : 'FAIL: 鏈熸湜鎭板ソ 1 鏉″洖澶?)
  process.exit(replies === 1 ? 0 : 1)
}, 55000)

ws.on('open', async () => {
  console.log('connected')
  // 1) private message -> must be ignored
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 999888, message: '绉佽亰娴嬭瘯锛屽簲琚拷鐣?, message_id: 201 }))
  await new Promise((r) => setTimeout(r, 7000))
  // 2) group message with @ -> must be replied
  console.log('7s 鍚庡彂閫佺兢 @ 娑堟伅')
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 888001, user_id: 777001,
    message: '[CQ:at,qq=10001] 璇疯锛氱鑱婂睆钄界敓鏁?,
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
