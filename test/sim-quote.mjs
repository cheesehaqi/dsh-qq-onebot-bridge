/** Verify quoted messages don't break the flow (graceful fallback). */
import wsPackage from 'ws'
const { WebSocket } = wsPackage

const ws = new WebSocket('ws://127.0.0.1:6700/')
const timer = setTimeout(() => { console.log('TIMEOUT 75s'); process.exit(1) }, 75000)

ws.on('open', () => {
  console.log('connected, sending message with reply segment')
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 888001, user_id: 777001,
    message: [
      { type: 'reply', data: { id: '999999', text: '铏氭瀯鐨勫紩鐢ㄦ秷鎭? } },
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: '璇峰洖澶嶏細寮曠敤娴嬭瘯閫氳繃' } },
    ],
    message_id: 501,
  }))
})

ws.on('message', (data) => {
  const frame = JSON.parse(String(data))
  if (frame.action === 'get_msg') {
    console.log('bridge asked get_msg for', frame.params?.message_id, '- responding with mock quoted message')
    ws.send(JSON.stringify({
      status: 'ok', retcode: 0,
      data: { message_id: frame.params.message_id, message: [{ type: 'text', data: { text: '杩欐槸琚紩鐢ㄧ殑鍘熷娑堟伅鍐呭' } }] },
      echo: frame.echo,
    }))
    return
  }
  if (frame.action) {
    console.log('REPLY:', JSON.stringify(frame.params?.message ?? frame.params).slice(0, 200))
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: frame.echo }))
    clearTimeout(timer)
    console.log('PASS: 甯﹀紩鐢ㄦ秷鎭祦绋嬫甯革紙agent 宸插洖澶嶏級')
    process.exit(0)
  }
})

ws.on('error', (e) => { console.log('WS error:', e.message); process.exit(1) })
