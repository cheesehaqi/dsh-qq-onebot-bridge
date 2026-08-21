/** Verify [face:xxx] markers in agent replies become CQ face segments. */
import wsPackage from 'ws'
const { WebSocket } = wsPackage

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
    message: '[CQ:at,qq=10001] 璇峰洖澶嶏細鏀跺埌[face:榧撴帉]锛屽彟澶朳face:寰瑧]',
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
      console.log('PASS: 琛ㄦ儏娈靛凡鏇挎崲锛堥紦鎺?2銆佸井绗?4锛?)
      clearTimeout(timer)
      process.exit(0)
    }
  }
})

ws.on('error', (e) => { console.log('WS error:', e.message); process.exit(1) })
