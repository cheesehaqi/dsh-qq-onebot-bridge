/** Protocol smoke test: fake OneBot client connects and exchanges frames. */
import { WebSocket } from 'ws'
import { OneBotServer } from '../lib/onebot.js'

const logger = { info: (m) => console.log('[server]', m), warn: console.warn, error: console.error }
const server = new OneBotServer({ host: '127.0.0.1', port: 6799, accessToken: 'test-token' }, logger)

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

server.on('message', async (message) => {
  check('message event parsed', message.userId === 123456 && message.messageType === 'private', JSON.stringify(message.userId))
  check('CQ code stripped / text extracted', message.text === '你好 世界', JSON.stringify(message.text))
  await server.sendText(message.bot, 'private', message.userId, '回复文本')
})

server.on('bot-connect', (socket) => {
  console.log('bot connected')
})

await server.start()
const ws = new WebSocket('ws://127.0.0.1:6799/', { headers: { authorization: 'Bearer test-token' } })

let received = 0
ws.on('message', (data) => {
  const frame = JSON.parse(String(data))
  if (frame.action) {
    received++
    check('send_private_msg action', frame.action === 'send_private_msg' && frame.params.user_id === 123456 && Array.isArray(frame.params.message) && frame.params.message[0]?.data?.text === '回复文本')
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: frame.echo }))
  }
})

await new Promise((resolve) => ws.on('open', resolve))
ws.send(JSON.stringify({
  post_type: 'message',
  message_type: 'private',
  user_id: 123456,
  message: '你好 [CQ:at,qq=789,name=小明] 世界 [CQ:image,file=xx.png]',
  message_id: 999,
}))

await new Promise((resolve) => setTimeout(resolve, 1200))
ws.close()
await server.stop()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
