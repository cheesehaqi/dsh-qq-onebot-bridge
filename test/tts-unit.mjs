/** Unit tests for TTS helpers (no network). */
import { buildAzureSsml } from '../lib/tts.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const s = buildAzureSsml('你好 1 < 2 & "3"', 'zh-CN-XiaoxiaoNeural', 'chat')
check('SSML 含 voice 名', s.includes('name="zh-CN-XiaoxiaoNeural"'), s)
check('SSML 含 style', s.includes('style="chat"'), s)
check('XML 转义 <', s.includes('1 &lt; 2'), s)
check('XML 转义 &', s.includes('2 &amp; &quot;3&quot;'), s)
check('SSML 外层标签', s.startsWith('<speak') && s.endsWith('</speak>'), s)

const s2 = buildAzureSsml('测试', 'zh-CN-XiaoxiaoNeural', '')
check('空 style 不加属性', !s2.includes('style='), s2)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
