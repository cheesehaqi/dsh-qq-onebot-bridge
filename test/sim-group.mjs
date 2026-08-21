/** Verify group @-mention behavior: no-mention ignored, mention replied. */
import wsPackage from 'ws'
const { WebSocket } = wsPackage

const ws = new WebSocket('ws://127.0.0.1:6700/')
let replies = 0
const done = new Set()

const timer = setTimeout(() => {
  console.log(`RESULT: ${replies} replies received`)
  console.log(replies === 1 ? 'PASS: 鏃燖娑堟伅琚拷鐣ワ紝@娑堟伅鏈夊洖澶? : 'FAIL: 鏈熸湜鎭板ソ 1 鏉″洖澶?)
  process.exit(replies === 1 ? 0 : 1)
}, 60000)

ws.on('open', async () => {
  console.log('connected')
  // 1) group message WITHOUT mention -> should be ignored
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 888001, user_id: 777001,
    message: '杩欐潯娑堟伅娌℃湁@鏈哄櫒浜猴紝搴旇琚拷鐣?,
    message_id: 101,
  }))
  await new Promise((r) => setTimeout(r, 8000))
  // 2) group message WITH mention of bot 10001 -> should be replied
  console.log('8s 鍚庡彂閫?@鏈哄櫒浜?娑堟伅')
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', group_id: 888001, user_id: 777001,
    message: '[CQ:at,qq=10001,name=灏忛哺楸糫 璇疯锛氬凡鏀跺埌缇ゆ秷鎭?,
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
