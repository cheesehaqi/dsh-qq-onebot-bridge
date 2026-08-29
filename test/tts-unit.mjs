/** Unit tests for TTS helpers (no network). */
import { buildAzureSsml, buildLocalTtsRequest } from '../lib/tts.js'

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

// Local GPT-SoVITS payload
const local = buildLocalTtsRequest({ ttsLocalRefAudio: 'D:/voice/xiaojingyu.wav', ttsLocalPromptText: '大家好，我是小鲸鱼', ttsLocalTextLang: 'zh', ttsLocalPromptLang: 'zh' }, '你好呀')
check('local 请求含 ref 音频路径', local.ref_audio_path === 'D:/voice/xiaojingyu.wav', JSON.stringify(local))
check('local 请求含提示文本', local.prompt_text === '大家好，我是小鲸鱼')
check('local 请求 wav + 非流式', local.media_type === 'wav' && local.streaming_mode === 0)
check('local 请求语言默认 zh', local.text_lang === 'zh' && local.prompt_lang === 'zh')
check('local 请求透传文本', local.text === '你好呀')

const localDefaults = buildLocalTtsRequest({}, '测试')
check('local 缺省值兜底', localDefaults.ref_audio_path === '' && localDefaults.text_lang === 'zh' && localDefaults.media_type === 'wav')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
