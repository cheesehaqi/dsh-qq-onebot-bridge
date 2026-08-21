/** Unit-test quote (reply) segment parsing. */
import { parseMessage } from '../lib/onebot.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// array form with reply segment
const r1 = parseMessage([{ type: 'reply', data: { id: '12345', text: '鍘熸秷鎭憳瑕? } }, { type: 'text', data: { text: '鐪嬬湅杩欎釜' } }], 0)
check('array reply id', r1.reply?.messageId === '12345', JSON.stringify(r1.reply))
check('array reply text', r1.reply?.text === '鍘熸秷鎭憳瑕?)
check('array text stripped', r1.text === '鐪嬬湅杩欎釜', r1.text)

// string form with CQ reply code
const r2 = parseMessage('[CQ:reply,id=999,text=寮曠敤鍐呭][CQ:at,qq=10001] 鍒嗘瀽涓?, 10001)
check('string reply id', r2.reply?.messageId === '999', JSON.stringify(r2.reply))
check('string reply text', r2.reply?.text === '寮曠敤鍐呭')
check('string at parsed', r2.ats.includes(10001), JSON.stringify(r2.ats))
check('string text stripped', r2.text === '鍒嗘瀽涓?, r2.text)

// no reply
const r3 = parseMessage('鏅€氭秷鎭?, 0)
check('no reply', r3.reply === null, JSON.stringify(r3.reply))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
