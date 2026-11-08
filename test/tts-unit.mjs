/** Unit tests for TTS helpers (no network). */
import { buildAzureSsml, buildLocalTtsRequest, synthesizeTts } from '../lib/tts.js'

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
check('local 默认不带采样参数', localDefaults.speed_factor === undefined && localDefaults.top_k === undefined && localDefaults.seed === undefined)

// v0.8.5+「细调」：SSML 的 prosody 与本地采样参数
const tunedSsml = buildAzureSsml('测试', 'zh-CN-YunxiNeural', 'cheerful', { rate: 10, pitch: -2, volume: -10 })
check('SSML 细调：语速/音调/音量进 prosody',
  tunedSsml.includes('rate="+10%"') && tunedSsml.includes('pitch="-2st"') && tunedSsml.includes('volume="-10%"'), tunedSsml)
check('SSML 细调：style 走 mstts:express-as', tunedSsml.includes('mstts:express-as') && tunedSsml.includes('style="cheerful"'), tunedSsml)
check('SSML 细调：没有 prosody 参数时不加 prosody 标签', !buildAzureSsml('测试', 'v', '').includes('<prosody'))
const tunedLocal = buildLocalTtsRequest({ ttsLocalRefAudio: 'D:/voice/a.wav', ttsLocalPromptText: '旧参考' }, '你好', {
  refAudio: 'D:/voice/b.wav', refText: '新参考', refLang: 'ja',
  localSpeed: 1.2, temperature: 0.8, topK: 20, topP: 0.9, repetitionPenalty: 1.2, seed: 42,
})
check('local 细调：参考音频/参考文本/参考语言可覆盖',
  tunedLocal.ref_audio_path === 'D:/voice/b.wav' && tunedLocal.prompt_text === '新参考' && tunedLocal.prompt_lang === 'ja')
check('local 细调：采样参数/语速/种子进请求体',
  tunedLocal.speed_factor === 1.2 && tunedLocal.temperature === 0.8 && tunedLocal.top_k === 20
  && tunedLocal.top_p === 0.9 && tunedLocal.repetition_penalty === 1.2 && tunedLocal.seed === 42, JSON.stringify(tunedLocal))

// synthesizeTts：OpenAI 兼容接口的 speed（没给就不带）
const openaiCalls = []
const fakeFetch = async (url, options) => {
  openaiCalls.push({ url, options })
  return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2]).buffer, text: async () => '' }
}
await synthesizeTts({ ttsProvider: 'openai', ttsApiKey: 'k' }, 'hi', { fetchImpl: fakeFetch, overrides: { voice: 'nova', speed: 1.4 } })
check('OpenAI 细调：voice/speed 进请求体',
  JSON.parse(openaiCalls[0].options.body).voice === 'nova' && JSON.parse(openaiCalls[0].options.body).speed === 1.4)
await synthesizeTts({ ttsProvider: 'openai', ttsApiKey: 'k' }, 'hi', { fetchImpl: fakeFetch })
check('OpenAI 默认不带 speed', JSON.parse(openaiCalls[1].options.body).speed === undefined)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
