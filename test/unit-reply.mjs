/** Unit-test quote (reply) segment parsing. */
import { parseMessage } from '../lib/onebot.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// array form with reply segment
const r1 = parseMessage([{ type: 'reply', data: { id: '12345', text: '原消息摘要' } }, { type: 'text', data: { text: '看看这个' } }], 0)
check('array reply id', r1.reply?.messageId === '12345', JSON.stringify(r1.reply))
check('array reply text', r1.reply?.text === '原消息摘要')
check('array text stripped', r1.text === '看看这个', r1.text)

// string form with CQ reply code
const r2 = parseMessage('[CQ:reply,id=999,text=引用内容][CQ:at,qq=10001] 分析一下', 10001)
check('string reply id', r2.reply?.messageId === '999', JSON.stringify(r2.reply))
check('string reply text', r2.reply?.text === '引用内容')
check('string at parsed', r2.ats.includes(10001), JSON.stringify(r2.ats))
check('string text stripped', r2.text === '分析一下', r2.text)

// no reply
const r3 = parseMessage('普通消息', 0)
check('no reply', r3.reply === null, JSON.stringify(r3.reply))

// 视频段（数组 / CQ 字符串）
const v1 = parseMessage([{ type: 'video', data: { file: 'clip.mp4', url: 'https://example.test/clip.mp4' } }, { type: 'text', data: { text: '看看' } }], 0)
check('array video url/file', v1.videos.length === 1 && v1.videos[0].url.includes('clip.mp4') && v1.videos[0].file === 'clip.mp4', JSON.stringify(v1.videos))
check('array video text 保留', v1.text === '看看', v1.text)
const v2 = parseMessage('[CQ:video,file=clip.mp4,url=https://example.test/clip.mp4]', 0)
check('string video 解析', v2.videos.length === 1 && v2.videos[0].file === 'clip.mp4' && v2.text === '', JSON.stringify(v2.videos))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
