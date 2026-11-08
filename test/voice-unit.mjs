/**
 * 「语音调试（TTS / STT）」测试。
 *
 * 四层：
 *   ① 纯逻辑（lib/voice.js）：就绪判断（开关/参考音频/密钥/宿主服务）、状态不含密钥、
 *      试合成与试转写的成功与失败分支、错误翻译；
 *   ② 宿主路由（lib/voice-routes.js）：/qqai/voice/{status,tts,stt} 的契约、同源/JSON/大小门禁；
 *   ③ 控制台代理（control）：supervisor 从宿主日志里取 token 再转发；server 的三个 /api 路由
 *      （含"音频体放大到 9 MB、其它接口仍 64 KB"这条边界）；
 *   ④ 页面：控制台「语音调试」卡的元素/函数/录音与试听接线。
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlServer, createToken, readUi } from '../control/lib/server.mjs'
import { createSupervisor } from '../control/lib/supervisor.mjs'
import { mountQqAiPanel } from '../lib/settings-routes.js'
import { decodeWav16, encodeWav16, pitchFactor, shiftPitch } from '../lib/audio-fx.js'
import {
  VOICE_AUDIO_MAX_BYTES, VOICE_TEST_MAX_CHARS, checkVoiceReadiness, explainVoiceError, normalizeTtsOverrides,
  synthesizeForTest, transcribeForTest, voiceStatus,
} from '../lib/voice.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// -------------------------------------------------------------- 夹具 ----
function makeWav(samples = 320) {
  const data = Buffer.alloc(samples * 2)
  const out = Buffer.alloc(44 + data.length)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + data.length, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(16000, 24)
  out.writeUInt32LE(32000, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(data.length, 40)
  return out
}
/** 带音高的测试音频（用来验证移调真的把基频改了）。 */
function toneWav(seconds = 0.5, hz = 220, rate = 16000, channels = 1) {
  const frames = Math.round(rate * seconds)
  const samples = new Float32Array(frames * channels)
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.sin((2 * Math.PI * hz * frame) / rate) * 0.3
    for (let channel = 0; channel < channels; channel += 1) samples[frame * channels + channel] = value
  }
  return encodeWav16(samples, channels, rate)
}
const fakeService = (text = '你好，这是一段测试语音') => ({
  resolve: (spec) => spec,
  transcribe: async () => ({ text, audioSeconds: 1.5, inferenceSeconds: 0.2 }),
})
const jsonResponse = (payload, { status = 200, ok = true } = {}) => ({
  ok,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
})
const audioResponse = (bytes) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
  text: async () => '',
})

// ------------------------------------------------------- ① 纯逻辑 ----
const LOCAL_OK = {
  ttsEnabled: true, ttsProvider: 'local', ttsLocalUrl: 'http://127.0.0.1:9880',
  ttsLocalRefAudio: 'D:/voice/ref.wav', ttsLocalTextLang: 'zh',
  sttEnabled: true, sttProvider: 'dsh', sttLanguage: 'auto', ffmpegPath: 'ffmpeg',
}
const localReady = checkVoiceReadiness(LOCAL_OK, { hostService: true })
check('本机 TTS + 宿主 STT 就绪', localReady.tts.ready === true && localReady.stt.ready === true)
check('不知道宿主服务时 STT 未就绪', checkVoiceReadiness(LOCAL_OK, { hostService: false }).stt.ready === false)

const ttsOff = checkVoiceReadiness({ ...LOCAL_OK, ttsEnabled: false }, { hostService: true })
check('TTS 开关关着 → 未就绪并指名 ttsEnabled', ttsOff.tts.blockers.some((item) => item.code === 'tts-disabled' && item.reason.includes('ttsEnabled')))
check('TTS 关着时仍给出"去哪儿开"', ttsOff.tts.blockers[0].hint.includes('设置'))

const noRef = checkVoiceReadiness({ ...LOCAL_OK, ttsLocalRefAudio: '' }, { hostService: true })
check('本地 TTS 缺参考音频 → 指名 ttsLocalRefAudio', noRef.tts.blockers.some((item) => item.code === 'tts-no-ref' && item.reason.includes('ttsLocalRefAudio')))
const azureNoKey = checkVoiceReadiness({ ...LOCAL_OK, ttsProvider: 'azure', ttsApiKey: '' }, { hostService: true })
check('云端 TTS 缺 key → 未就绪', azureNoKey.tts.ready === false && azureNoKey.tts.blockers.some((item) => item.code === 'tts-no-key'))
check('云端 TTS 有 key → 就绪', checkVoiceReadiness({ ...LOCAL_OK, ttsProvider: 'openai', ttsApiKey: 'sk-x' }, { hostService: true }).tts.ready === true)
check('未知 provider 不会假装就绪', checkVoiceReadiness({ ...LOCAL_OK, ttsProvider: 'nope' }, { hostService: true }).tts.ready === false)

const sttNoService = checkVoiceReadiness(LOCAL_OK, { hostService: false })
check('STT dsh 没有宿主服务 → 指名「语音输入」bundle', sttNoService.stt.blockers.some((item) => item.code === 'stt-no-service' && item.hint.includes('语音输入')))
const sttCloud = checkVoiceReadiness({ ...LOCAL_OK, sttProvider: 'cloud', sttApiKey: '', sttBaseUrl: '' }, { hostService: false })
check('云端 STT 缺 key/base → 两条都点名', sttCloud.stt.blockers.length === 2 && sttCloud.stt.blockers.every((item) => ['stt-no-key', 'stt-no-base'].includes(item.code)))

const status = voiceStatus({ ...LOCAL_OK, ttsApiKey: 'super-secret-key', sttApiKey: 'another-secret' }, { hostService: true })
check('状态投影：TTS/STT 都就说绪', status.tts.ready === true && status.stt.ready === true && status.hostService === true)
check('状态投影不含任何密钥', !JSON.stringify(status).includes('super-secret-key') && !JSON.stringify(status).includes('another-secret'))
check('状态投影里参考音频只给文件名，不给绝对路径', status.tts.refAudioName === 'ref.wav' && !JSON.stringify(status).includes('D:/voice/ref.wav'))
check('状态投影带上限与模型信息', status.tts.maxChars === VOICE_TEST_MAX_CHARS && status.stt.model.includes('SenseVoice'))

check('错误翻译：超时', explainVoiceError(new Error('The operation was aborted due to timeout'), { phase: 'tts' }).includes('超时'))
check('错误翻译：鉴权', explainVoiceError(new Error('TTS HTTP 401: bad key'), { phase: 'tts' }).includes('鉴权失败'))
check('错误翻译：DSH 服务缺失走 stt.js 的文案', explainVoiceError(new Error('speechToText unavailable'), { phase: 'stt' }).includes('DSH'))

// ---- 细调参数校验 ----
const normalized = normalizeTtsOverrides({ voice: '  nova  ', speed: '1.3', topK: '15', seed: '42', refText: ' 参考 ', empty: '' })
check('细调：字符串去空白、空值丢弃', normalized.voice === 'nova' && normalized.refText === '参考' && normalized.empty === undefined)
check('细调：数值转成数字', normalized.speed === 1.3 && normalized.topK === 15 && normalized.seed === 42)
const rejects = (raw, label) => { try { normalizeTtsOverrides(raw); return false } catch (error) { return error.message.includes(label) } }
check('细调：语速越界被拒（带字段名）', rejects({ speed: 9 }, '语速倍率'))
check('细调：top_k 必须是整数', rejects({ topK: 2.5 }, 'top_k'))
check('细调：音调越界被拒', rejects({ azurePitch: 20 }, '音调'))
check('细调：temperature 越界被拒', rejects({ temperature: 0 }, 'temperature'))
check('细调：种子允许 -1（随机）', normalizeTtsOverrides({ seed: -1 }).seed === -1)

// ---- 试合成 ----
const localFetch = (calls) => async (url, options) => { calls.push({ url, options }); return audioResponse([1, 2, 3, 4]) }
const fetched = []
const ttsOk = await synthesizeForTest({ config: LOCAL_OK, text: '  你好  ', fetchImpl: localFetch(fetched) })
check('本地 TTS 合成成功并返回音频字节', ttsOk.audio.length === 4 && ttsOk.format === 'wav' && ttsOk.provider === 'local')
check('合成会去掉首尾空白再发', JSON.parse(fetched[0].options.body).text === '你好')
const overrideFetched = []
const overrideResult = await synthesizeForTest({
  config: { ...LOCAL_OK, ttsProvider: 'openai', ttsApiKey: 'k' },
  text: 'hello', voice: 'nova', fetchImpl: localFetch(overrideFetched),
})
check('细调：音色覆盖进请求体', JSON.parse(overrideFetched[0].options.body).voice === 'nova', overrideFetched[0].options.body)
check('细调：结果回带本次用的音色', overrideResult.voice === 'nova' && overrideResult.provider === 'openai')
const langFetched = []
await synthesizeForTest({ config: LOCAL_OK, text: 'hi', textLang: 'ja', fetchImpl: localFetch(langFetched) })
check('细调：本地文本语言覆盖进 text_lang', JSON.parse(langFetched[0].options.body).text_lang === 'ja', langFetched[0].options.body)

// 细调：本地 GPT-SoVITS 的采样/语速/参考音频覆盖
const localTuneFetched = []
const localTune = await synthesizeForTest({
  config: LOCAL_OK,
  text: 'hi',
  overrides: { refAudio: 'D:/voice/other.wav', refText: '另一段参考', refLang: 'ja', localSpeed: 1.2, temperature: 0.8, topK: 20, topP: 0.9, repetitionPenalty: 1.2, seed: 42 },
  fetchImpl: localFetch(localTuneFetched),
})
const localBody = JSON.parse(localTuneFetched[0].options.body)
check('细调：参考音频/文本/语言进请求体',
  localBody.ref_audio_path === 'D:/voice/other.wav' && localBody.prompt_text === '另一段参考' && localBody.prompt_lang === 'ja')
check('细调：GPT-SoVITS 采样与语速进请求体',
  localBody.speed_factor === 1.2 && localBody.temperature === 0.8 && localBody.top_k === 20
  && localBody.top_p === 0.9 && localBody.repetition_penalty === 1.2 && localBody.seed === 42, JSON.stringify(localBody))
check('细调：结果回带本次参数', localTune.params.localSpeed === 1.2 && localTune.params.seed === 42)

// 细调：Azure 的 prosody（语速/音调/音量）与 style
const azureFetched = []
await synthesizeForTest({
  config: { ...LOCAL_OK, ttsProvider: 'azure', ttsApiKey: 'k' },
  text: 'hi',
  overrides: { voice: 'zh-CN-YunxiNeural', azureStyle: 'cheerful', azureRate: 10, azurePitch: -2, azureVolume: -10 },
  fetchImpl: async (url, options) => { azureFetched.push({ url, options }); return audioResponse([1, 2]) },
})
const ssml = azureFetched[0].options.body
check('细调：Azure SSML 带语速/音调/音量',
  ssml.includes('rate="+10%"') && ssml.includes('pitch="-2st"') && ssml.includes('volume="-10%"'), ssml)
check('细调：Azure style 用 mstts:express-as', ssml.includes('mstts:express-as') && ssml.includes('style="cheerful"'))
check('细调：Azure 音色覆盖生效', ssml.includes('name="zh-CN-YunxiNeural"'))

// 细调：音调（本地/OpenAI 没有原生音调参数 → 内置"重采样 + WSOLA"变调，只变调、时长基本不变）
check('移调：半音→倍率（+12 = 2×，-12 = 0.5×）',
  Math.abs(pitchFactor(12) - 2) < 1e-9 && Math.abs(pitchFactor(-12) - 0.5) < 1e-9)
const tone = toneWav(0.6, 220)
const toneInfo = decodeWav16(tone)
const pitchedTone = await shiftPitch({ buffer: tone, format: 'wav', semitones: 12, tmpDir: tmpdir() })
const pitchedInfo = decodeWav16(pitchedTone.audio)
const freqOf = (info) => {
  const frames = info.samples.length / info.channels
  const from = Math.floor(frames * 0.2)
  const to = Math.floor(frames * 0.8)
  let crossings = 0
  let previous = info.samples[from * info.channels]
  for (let frame = from + 1; frame < to; frame += 1) {
    const value = info.samples[frame * info.channels]
    if ((previous <= 0 && value > 0) || (previous >= 0 && value < 0)) crossings += 1
    previous = value
  }
  return (crossings / 2) / ((to - from) / info.sampleRate)
}
const baseHz = freqOf(toneInfo)
const shiftedHz = freqOf(pitchedInfo)
check('移调：+12 半音后基频约翻倍', shiftedHz > baseHz * 1.85 && shiftedHz < baseHz * 2.15, `${baseHz.toFixed(1)} → ${shiftedHz.toFixed(1)}`)
const inSeconds = (toneInfo.samples.length / toneInfo.channels) / toneInfo.sampleRate
const outSeconds = (pitchedInfo.samples.length / pitchedInfo.channels) / pitchedInfo.sampleRate
check('移调：时长基本不变（±5%）', Math.abs(outSeconds - inSeconds) / inSeconds < 0.05, `${inSeconds.toFixed(3)}s → ${outSeconds.toFixed(3)}s`)
check('移调：采样率与声道保持', pitchedInfo.sampleRate === toneInfo.sampleRate && pitchedInfo.channels === toneInfo.channels)
check('移调：音调 0 原样返回', (await shiftPitch({ buffer: tone, format: 'wav', semitones: 0 })).audio.equals(tone))
check('移调：越界被拒', await (async () => {
  try { await shiftPitch({ buffer: tone, semitones: 13 }); return false } catch { return true }
})())
check('细调：音调越界被拒', (() => { try { normalizeTtsOverrides({ pitch: 13 }); return false } catch (error) { return error.message.includes('音调') } })())
// mp3 输入：只用 ffmpeg 解码（不依赖 asetrate/atempo 滤镜）
const mp3DecodeArgs = []
const mp3Run = async (command, args) => {
  mp3DecodeArgs.push({ command, args })
  writeFileSync(args[args.length - 1], tone)
}
const fromMp3 = await shiftPitch({ buffer: Buffer.from('fake-mp3'), format: 'mp3', semitones: 3, tmpDir: tmpdir(), run: mp3Run })
check('移调：mp3 先解码再变调（不需要 ffmpeg 滤镜）',
  mp3DecodeArgs.length === 1 && mp3DecodeArgs[0].args.includes('pcm_s16le')
  && !mp3DecodeArgs[0].args.includes('-filter:a') && fromMp3.format === 'wav', JSON.stringify(mp3DecodeArgs[0]?.args))

// 合成链路：TTS 返回 WAV 时音调生效（不需要 ffmpeg）
const pitched = await synthesizeForTest({
  config: LOCAL_OK, text: 'hi', overrides: { pitch: 12 }, tmpDir: tmpdir(),
  fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => tone.buffer.slice(tone.byteOffset, tone.byteOffset + tone.byteLength), text: async () => '' }),
})
const pitchedSynth = decodeWav16(pitched.audio)
check('细调：合成结果按音调变调并回带参数',
  pitched.params.pitch === 12 && pitched.format === 'wav'
  && Math.abs((pitchedSynth.samples.length / pitchedSynth.channels) / pitchedSynth.sampleRate - inSeconds) < 0.05)
const noPitchRun = async () => { throw new Error('音调 0 不该走 ffmpeg') }
const unchangedPitch = await synthesizeForTest({
  config: LOCAL_OK, text: 'hi', overrides: { pitch: 0 }, tmpDir: tmpdir(), run: noPitchRun,
  fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => tone.buffer.slice(tone.byteOffset, tone.byteOffset + tone.byteLength), text: async () => '' }),
})
check('细调：音调 0 不跑 ffmpeg、原样返回', unchangedPitch.params.pitch === 0 && unchangedPitch.audio.equals(tone))

const openaiTuneFetched = []
await synthesizeForTest({
  config: { ...LOCAL_OK, ttsProvider: 'openai', ttsApiKey: 'k' },
  text: 'hi',
  overrides: { voice: 'nova', speed: 1.3 },
  fetchImpl: async (url, options) => { openaiTuneFetched.push({ url, options }); return audioResponse([1]) },
})
const openaiBody = JSON.parse(openaiTuneFetched[0].options.body)
check('细调：OpenAI speed 进请求体', openaiBody.speed === 1.3 && openaiBody.voice === 'nova')
const openaiNoSpeed = []
await synthesizeForTest({ config: { ...LOCAL_OK, ttsProvider: 'openai', ttsApiKey: 'k' }, text: 'hi', fetchImpl: async (url, options) => { openaiNoSpeed.push(options); return audioResponse([1]) } })
check('细调：没给 speed 就不带这个字段', JSON.parse(openaiNoSpeed[0].body).speed === undefined)
await (async () => {
  try { await synthesizeForTest({ config: LOCAL_OK, text: '   ', fetchImpl: localFetch([]) }); check('空文本被拒', false) }
  catch (error) { check('空文本被拒', error.message.includes('空的')) }
})()
await (async () => {
  try { await synthesizeForTest({ config: LOCAL_OK, text: 'x'.repeat(VOICE_TEST_MAX_CHARS + 1), fetchImpl: localFetch([]) }); check('超长文本被拒', false) }
  catch (error) { check('超长文本被拒', error.message.includes(`最多 ${VOICE_TEST_MAX_CHARS} 字`)) }
})()
await (async () => {
  try { await synthesizeForTest({ config: { ...LOCAL_OK, ttsLocalRefAudio: '' }, text: 'hi', fetchImpl: localFetch([]) }); check('未就绪时合成前就拒绝', false) }
  catch (error) { check('未就绪时合成前就拒绝', error.message.includes('ttsLocalRefAudio')) }
})()
const badKeyFetch = async () => ({ ok: false, status: 401, text: async () => 'invalid key' })
await (async () => {
  try { await synthesizeForTest({ config: { ...LOCAL_OK, ttsProvider: 'openai', ttsApiKey: 'k' }, text: 'hi', fetchImpl: badKeyFetch }); check('上游 401 被翻成人话', false) }
  catch (error) { check('上游 401 被翻成人话', error.message.includes('鉴权失败') && error.message.includes('401')) }
})()

// ---- 试转写 ----
const wav = makeWav()
const wavRun = async (command, args) => { writeFileSync(args[args.length - 1], wav) }
const sttOk = await transcribeForTest({
  config: LOCAL_OK, audioBase64: Buffer.from('fake-webm-bytes').toString('base64'), ext: 'webm',
  service: fakeService(), tmpDir: tmpdir(), run: wavRun,
})
check('STT(dsh) 成功：返回文本与尺寸', sttOk.text.includes('测试语音') && sttOk.provider === 'dsh' && sttOk.wavBytes === wav.length)
check('STT(dsh) 记录原始字节数', sttOk.bytes === Buffer.from('fake-webm-bytes').length)
const seenSpecs = []
const captureService = { resolve: (spec) => { seenSpecs.push(spec); return spec }, transcribe: async () => ({ text: 'ok' }) }
const langOverride = await transcribeForTest({
  config: LOCAL_OK, audioBase64: 'YQ==', ext: 'webm', service: captureService, run: wavRun, language: 'ja',
})
check('细调：STT 语言覆盖传给宿主服务', seenSpecs[0].language === 'ja' && langOverride.language === 'ja')
await transcribeForTest({ config: LOCAL_OK, audioBase64: 'YQ==', ext: 'webm', service: captureService, run: wavRun })
check('细调：不覆盖时用配置里的语言', seenSpecs[1].language === 'auto')
await (async () => {
  try {
    await transcribeForTest({ config: LOCAL_OK, audioBase64: '', ext: 'webm', service: fakeService(), run: wavRun })
    check('空音频被拒', false)
  } catch (error) { check('空音频被拒', error.message.includes('音频是空的')) }
})()
await (async () => {
  try {
    await transcribeForTest({ config: { ...LOCAL_OK, sttEnabled: false }, audioBase64: 'YQ==', ext: 'webm', service: fakeService(), run: wavRun })
    check('STT 关着时提前拒绝', false)
  } catch (error) { check('STT 关着时提前拒绝', error.message.includes('sttEnabled')) }
})()
await (async () => {
  try {
    await transcribeForTest({ config: LOCAL_OK, audioBase64: 'YQ==', ext: 'webm', service: null, run: wavRun })
    check('缺少宿主服务时提前拒绝', false)
  } catch (error) { check('缺少宿主服务时提前拒绝', error.message.includes('speechToText')) }
})()
const emptyService = { resolve: (spec) => spec, transcribe: async () => ({ text: '' }) }
await (async () => {
  try {
    await transcribeForTest({ config: LOCAL_OK, audioBase64: 'YQ==', ext: 'webm', service: emptyService, run: wavRun })
    check('识别结果为空时说明原因', false)
  } catch (error) { check('识别结果为空时说明原因', error.message.includes('空文本') || error.message.includes('为空')) }
})()
const cloudCalls = []
const cloudFetch = async (url, options) => { cloudCalls.push({ url, options }); return jsonResponse({ text: '云端转写结果' }) }
const cloudOk = await transcribeForTest({
  config: { ...LOCAL_OK, sttProvider: 'cloud', sttApiKey: 'k', sttBaseUrl: 'https://stt.example/v1' },
  audioBase64: 'YQ==', ext: 'wav', fetchImpl: cloudFetch,
})
check('STT(cloud) 成功并打到 /audio/transcriptions', cloudOk.text === '云端转写结果' && cloudCalls[0].url === 'https://stt.example/v1/audio/transcriptions')
const cloudModel = await transcribeForTest({
  config: { ...LOCAL_OK, sttProvider: 'cloud', sttApiKey: 'k', sttBaseUrl: 'https://stt.example/v1' },
  audioBase64: 'YQ==', ext: 'wav', language: 'auto', model: 'custom-asr', fetchImpl: cloudFetch,
})
check('细调：云端 STT 模型覆盖并回带', cloudModel.model === 'custom-asr')

// ------------------------------------------------------- ② 宿主路由 ----
const dir = mkdtempSync(join(tmpdir(), 'qq-voice-'))
const env = { DSH_HOME: dir }
const registered = []
const fakeHost = {
  webServer: {
    register(route) {
      if (registered.some((item) => item.path === route.path)) throw new Error(`duplicate route ${route.path}`)
      registered.push(route)
      return () => { const at = registered.indexOf(route); if (at >= 0) registered.splice(at, 1) }
    },
  },
  get(name) { return name === 'speechToText' ? fakeService() : undefined },
}
const panelConfig = { ...LOCAL_OK, cwd: dir, ttsApiKey: 'tts-secret' }
const routeFetch = [];
const routeSpecs = []
const routeService = {
  resolve: (spec) => { routeSpecs.push(spec); return spec },
  transcribe: async () => ({ text: '你好，这是一段测试语音' }),
}
const disposePanel = mountQqAiPanel(fakeHost, {
  profile: 'web',
  config: panelConfig,
  defaults: {},
  numberMeta: {},
  env,
  probe: async () => false,
  // 语音调试的副作用全部注入：单测不联网、不跑 ffmpeg
  voiceFetch: async (url, options) => { routeFetch.push({ url, options }); return audioResponse([9, 9, 9]) },
  voiceRun: wavRun,
  voiceGetService: () => routeService,
  voiceTmpDir: dir,
})
check('面板挂载出三条语音调试路由',
  ['/qqai/voice/status', '/qqai/voice/tts', '/qqai/voice/stt'].every((path) => registered.some((route) => route.path === path)),
  registered.map((route) => route.path).join(','))

const makeResponse = () => {
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(body) { out.body = body ?? '' },
  }
}
const fakeRequest = (method, body, headers = {}) => ({
  method,
  headers,
  async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) },
})
const routeOf = (path) => registered.find((route) => route.path === path).handler

const statusRes = makeResponse()
await routeOf('/qqai/voice/status')(fakeRequest('GET'), statusRes)
const statusBody = JSON.parse(statusRes.out.body)
check('宿主状态路由：ok 且带 TTS/STT', statusRes.out.status === 200 && statusBody.ok === true && statusBody.tts && statusBody.stt)
check('宿主状态路由：不含密钥', !statusRes.out.body.includes('tts-secret'))

const ttsRes = makeResponse()
await routeOf('/qqai/voice/tts')(fakeRequest('POST', { text: '你好' }, { 'content-type': 'application/json' }), ttsRes)
const ttsBody = JSON.parse(ttsRes.out.body)
check('宿主 TTS 路由：返回 base64 音频与耗时', ttsRes.out.status === 200 && ttsBody.ok === true && typeof ttsBody.audio === 'string' && ttsBody.bytes === 3)
check('宿主 TTS 路由：真的调了注入的 fetch', routeFetch.length === 1 && routeFetch[0].url.endsWith('/tts'))

const sttRes = makeResponse()
await routeOf('/qqai/voice/stt')(fakeRequest('POST', { audioBase64: Buffer.from('abc').toString('base64'), ext: 'webm' }, { 'content-type': 'application/json' }), sttRes)
const sttBody = JSON.parse(sttRes.out.body)
check('宿主 STT 路由：返回转写文本', sttRes.out.status === 200 && sttBody.ok === true && sttBody.text.includes('测试语音'))

// 细调：TTS 的语言覆盖、STT 的语言覆盖都要一路透传到实际调用
const ttsOverrideRes = makeResponse()
await routeOf('/qqai/voice/tts')(fakeRequest('POST', { text: 'hi', textLang: 'ja', voice: 'ignored' }, { 'content-type': 'application/json' }), ttsOverrideRes)
const ttsOverrideBody = JSON.parse(ttsOverrideRes.out.body)
check('宿主 TTS 路由：语言覆盖进请求体', ttsOverrideBody.textLang === 'ja'
  && JSON.parse(routeFetch.at(-1).options.body).text_lang === 'ja', ttsOverrideBody.textLang)
const tuneRes = makeResponse()
await routeOf('/qqai/voice/tts')(fakeRequest('POST', { text: 'hi', overrides: { localSpeed: 1.2, topK: 9 } }, { 'content-type': 'application/json' }), tuneRes)
const tuneBody = JSON.parse(tuneRes.out.body)
const tuneRequest = JSON.parse(routeFetch.at(-1).options.body)
check('宿主 TTS 路由：细调参数进 GPT-SoVITS 请求体',
  tuneBody.ok === true && tuneRequest.speed_factor === 1.2 && tuneRequest.top_k === 9 && tuneBody.params.topK === 9,
  JSON.stringify(tuneRequest))
const badTuneRes = makeResponse()
await routeOf('/qqai/voice/tts')(fakeRequest('POST', { text: 'hi', overrides: { topK: 999 } }, { 'content-type': 'application/json' }), badTuneRes)
check('宿主 TTS 路由：细调参数越界会明确报错', badTuneRes.out.status === 400
  && JSON.parse(badTuneRes.out.body).reason.includes('top_k'), badTuneRes.out.body)
const sttOverrideRes = makeResponse()
await routeOf('/qqai/voice/stt')(fakeRequest('POST', { audioBase64: 'YQ==', ext: 'webm', language: 'ja' }, { 'content-type': 'application/json' }), sttOverrideRes)
const sttOverrideBody = JSON.parse(sttOverrideRes.out.body)
check('宿主 STT 路由：语言覆盖传到宿主服务', sttOverrideBody.language === 'ja' && routeSpecs.at(-1).language === 'ja', JSON.stringify(routeSpecs.at(-1)))

const crossRes = makeResponse()
await routeOf('/qqai/voice/tts')(fakeRequest('POST', { text: 'x' }, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }), crossRes)
check('宿主路由拒绝跨站写', crossRes.out.status === 403)
const typeRes = makeResponse()
await routeOf('/qqai/voice/tts')(fakeRequest('POST', { text: 'x' }, { 'content-type': 'text/plain' }), typeRes)
check('宿主路由只收 application/json', typeRes.out.status === 403)
const methodRes = makeResponse()
await routeOf('/qqai/voice/tts')(fakeRequest('GET'), methodRes)
check('宿主 TTS 只接受 POST', methodRes.out.status === 405)
const hugeRes = makeResponse()
await routeOf('/qqai/voice/tts')(fakeRequest('POST', { text: 'x'.repeat(70 * 1024) }, { 'content-type': 'application/json' }), hugeRes)
check('宿主 TTS 拒绝超大请求体', hugeRes.out.status === 413)
disposePanel()

// --------------------------------------------------- ③ 控制台代理 ----
const proxyDir = mkdtempSync(join(tmpdir(), 'qq-voice-proxy-'))
const calls = []
const hostServer = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  calls.push({ path: url.pathname, token: url.searchParams.get('token'), body: Buffer.concat(chunks).toString('utf8') })
  const send = (payload) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)) }
  if (url.pathname === '/qqai/voice/status') return send({ ok: true, tts: { ready: true }, stt: { ready: true }, hostService: true })
  if (url.pathname === '/qqai/voice/tts') return send({ ok: true, audio: 'AAAA', format: 'wav', bytes: 3, ms: 12, provider: 'local' })
  if (url.pathname === '/qqai/voice/stt') return send({ ok: true, text: '你好', provider: 'dsh', bytes: 3, wavBytes: 10, ms: 20 })
  if (url.pathname === '/qqai/panel/set-batch') return send({ ok: true, changed: true, keys: ['ttsEnabled'] })
  send({ ok: false, reason: 'unknown' })
})
await new Promise((resolve) => hostServer.listen(0, '127.0.0.1', resolve))
const hostPort = hostServer.address().port
const hostLog = join(proxyDir, 'qq-host-out.log')
writeFileSync(hostLog, `Web UI: http://127.0.0.1:${hostPort}/?token=host-token-1\n`, 'utf8')
const supConfig = {
  cwd: proxyDir,
  ports: { control: 18813, host: hostPort, onebot: 6700, napcat: 6099, tts: 9880 },
  logs: { hostOut: hostLog, trace: join(proxyDir, 'qq-trace.jsonl'), runtime: join(proxyDir, 'qq-runtime.json'), audit: join(proxyDir, 'a.log'), inbox: join(proxyDir, 'i.jsonl'), inject: join(proxyDir, 'j.jsonl'), bridge: join(proxyDir, 'b.log') },
  napcatBat: '',
}
const noExec = (command, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  if (command === 'netstat') return done(null, '', '')
  if (command === 'tasklist') return done(null, '', '')
  return done(new Error('not stubbed'), '', '')
}
const sup = createSupervisor(supConfig, { exec: noExec, logger: { info() {}, warn() {}, error() {} } })
const proxiedStatus = await sup.voiceStatus()
check('代理：状态从宿主取回', proxiedStatus.ok === true && proxiedStatus.hostService === true)
check('代理：请求带上宿主 token', calls.at(-1).token === 'host-token-1', calls.at(-1).token)
const proxiedTts = await sup.voiceTts({ text: '你好呀' })
check('代理：TTS 透传结果', proxiedTts.ok === true && proxiedTts.audio === 'AAAA' && proxiedTts.provider === 'local')
check('代理：TTS 请求体带着文本', JSON.parse(calls.at(-1).body).text === '你好呀')
const proxiedStt = await sup.voiceStt({ audioBase64: 'YWJj', ext: 'ogg' })
check('代理：STT 透传结果', proxiedStt.ok === true && proxiedStt.text === '你好')
check('代理：STT 请求体带 ext', JSON.parse(calls.at(-1).body).ext === 'ogg')
await sup.voiceTts({ text: 'x', voice: 'nova', textLang: 'ja' })
const proxyTtsOverride = JSON.parse(calls.at(-1).body)
check('代理：音色/语言覆盖也转发给宿主', proxyTtsOverride.voice === 'nova' && proxyTtsOverride.textLang === 'ja', calls.at(-1).body)
await sup.voiceTts({ text: 'x', overrides: { temperature: 0.8, topK: 12, speed: 1.2 } })
const proxyTune = JSON.parse(calls.at(-1).body)
check('代理：overrides 整包转发给宿主', proxyTune.overrides && proxyTune.overrides.temperature === 0.8
  && proxyTune.overrides.topK === 12 && proxyTune.overrides.speed === 1.2, calls.at(-1).body)
await sup.voiceStt({ audioBase64: 'YWJj', ext: 'ogg', language: 'ja' })
check('代理：STT 语言覆盖也转发给宿主', JSON.parse(calls.at(-1).body).language === 'ja')
await sup.voiceStt({ audioBase64: 'YWJj', ext: 'ogg', model: 'custom-asr' })
check('代理：STT 模型覆盖也转发给宿主', JSON.parse(calls.at(-1).body).model === 'custom-asr')
const toggled = await sup.voiceToggle({ tts: true })
const toggleCall = calls.at(-1)
check('代理：语音开关写宿主 /qqai/panel/set-batch',
  toggled.ok === true && toggleCall.path === '/qqai/panel/set-batch'
  && JSON.parse(toggleCall.body).entries.some((entry) => entry.key === 'ttsEnabled' && entry.value === true)
  && toggleCall.token === 'host-token-1', toggleCall.body)
const toggledProvider = await sup.voiceToggle({ ttsProvider: 'local' })
check('代理：切换 TTS 后端写 ttsProvider',
  toggledProvider.ok === true
  && JSON.parse(calls.at(-1).body).entries.some((entry) => entry.key === 'ttsProvider' && entry.value === 'local'),
  calls.at(-1).body)
const badProvider = await sup.voiceToggle({ sttProvider: 'nope' })
check('代理：未知 STT 后端被拒', badProvider.ok === false && badProvider.reason.includes('cloud'))
const valuesWritten = await sup.voiceToggle({ values: { ttsVoice: 'nova', ttsLocalUrl: 'http://127.0.0.1:9880' } })
check('代理：服务配置 values 转发给宿主',
  valuesWritten.ok === true
  && JSON.parse(calls.at(-1).body).entries.some((entry) => entry.key === 'ttsVoice' && entry.value === 'nova'),
  calls.at(-1).body)
const badValueKey = await sup.voiceToggle({ values: { nope: 'x' } })
check('代理：未知服务配置键被拒', badValueKey.ok === false && badValueKey.reason.includes('nope'))
const missingLog = createSupervisor({ ...supConfig, logs: { ...supConfig.logs, hostOut: join(proxyDir, 'nope.log') } }, { exec: noExec, logger: { info() {}, warn() {}, error() {} } })
const missing = await missingLog.voiceStatus()
check('找不到宿主（无日志 + 无候选端口）时说清原因', missing.ok === false && missing.reason.includes('找不到宿主'))

// 日志里没有地址（桌面端自己起的宿主）：从监听端口认出宿主，插件路由不要 token
const scanConfig = { ...supConfig, ports: { ...supConfig.ports, host: 3080 }, logs: { ...supConfig.logs, hostOut: join(proxyDir, 'nope-scan.log') } }
const scanExec = (command, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  if (command === 'netstat') return done(null, `  TCP    127.0.0.1:${hostPort}    0.0.0.0:0    LISTENING    7777\n`, '')
  if (command === 'tasklist') return done(null, '"DeepSeek Harness.exe","7777","Console","1","100 K"\n', '')
  return done(new Error('not stubbed'), '', '')
}
const scanSup = createSupervisor(scanConfig, { exec: scanExec, logger: { info() {}, warn() {}, error() {} } })
const scanned = await scanSup.voiceStatus()
check('代理：日志没有地址时，从监听端口认出宿主', scanned.ok === true && scanned.host === `http://127.0.0.1:${hostPort}`, scanned.host ?? scanned.reason)

// 宿主是旧版（没有语音接口）：404 要指名"重启宿主"，不能报成"连不上"
const oldHost = createServer((request, response) => { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('not found') })
await new Promise((resolve) => oldHost.listen(0, '127.0.0.1', resolve))
const oldPort = oldHost.address().port
const oldExec = (command, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  if (command === 'netstat') return done(null, `  TCP    127.0.0.1:${oldPort}    0.0.0.0:0    LISTENING    8888\n`, '')
  if (command === 'tasklist') return done(null, '"DeepSeek Harness.exe","8888","Console","1","100 K"\n', '')
  return done(new Error('not stubbed'), '', '')
}
const oldSup = createSupervisor({ ...scanConfig, logs: { ...scanConfig.logs, hostOut: join(proxyDir, 'nope-old.log') } }, { exec: oldExec, logger: { info() {}, warn() {}, error() {} } })
const oldResult = await oldSup.voiceStatus()
check('代理：旧版宿主 → 提示重启宿主而不是"连不上"',
  oldResult.ok === false && oldResult.reason.includes('更新前的版本') && oldResult.reason.includes(`127.0.0.1:${oldPort}`), oldResult.reason)
oldHost.close()
hostServer.close()

// ------------------------------------------------- ③b 控制台 HTTP ----
const token = createToken()
const seen = { tts: 0, stt: 0, lastTts: null, lastStt: null, toggle: null }
const server = createControlServer({
  config: supConfig,
  token,
  api: {
    status: async () => ({ ports: [], processes: {}, warnings: [], config: {}, scannedAt: Date.now() }),
    logFile: () => '',
    voiceStatus: async () => ({ ok: true, tts: { ready: true }, stt: { ready: false, blockers: [] }, hostService: true }),
    voiceTts: async (args) => { seen.tts += 1; seen.lastTts = args; return { ok: true, audio: 'AAAA', text: args.text, bytes: 3, ms: 1, format: 'wav', provider: 'local', voice: args.voice, textLang: args.textLang } },
    voiceStt: async (args) => { seen.stt += 1; seen.lastStt = args; return { ok: true, text: `len-${args.audioBase64.length}-${args.ext}-${args.language ?? ''}` } },
    voiceToggle: async (args) => { seen.toggle = args; return { ok: true, changed: true, reason: '已写入配置' } },
  },
  ui: '<h1>console</h1>',
  voiceUi: '<h1>语音页</h1>',
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const statusHttp = await (await fetch(`${base}/api/voice/status?token=${token}`)).json()
check('GET /api/voice/status 透传', statusHttp.ok === true && statusHttp.hostService === true && statusHttp.stt.ready === false)
const voicePage = await fetch(`${base}/voice?token=${token}`)
check('GET /voice 返回独立的语音调试页', voicePage.status === 200 && (await voicePage.text()).includes('语音页')
  && (voicePage.headers.get('content-type') ?? '').includes('text/html'))
const ttsHttp = await (await fetch(`${base}/api/voice/tts?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '测试' }) })).json()
check('POST /api/voice/tts 透传文本', ttsHttp.ok === true && ttsHttp.text === '测试' && seen.tts === 1)
const ttsOverrideHttp = await (await fetch(`${base}/api/voice/tts?token=${token}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hi', voice: 'nova', textLang: 'ja' }),
})).json()
check('接口把音色/语言覆盖转给 supervisor', ttsOverrideHttp.ok === true
  && seen.lastTts.voice === 'nova' && seen.lastTts.textLang === 'ja', JSON.stringify(seen.lastTts))
const tuneHttp = await (await fetch(`${base}/api/voice/tts?token=${token}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'x', overrides: { temperature: 0.7, topK: 8, speed: 1.1 } }),
})).json()
check('接口把细调 overrides 整包转给 supervisor', tuneHttp.ok === true
  && seen.lastTts.overrides.temperature === 0.7 && seen.lastTts.overrides.topK === 8 && seen.lastTts.overrides.speed === 1.1,
  JSON.stringify(seen.lastTts.overrides))
const beforeEmptyTts = seen.tts
const emptyTts = await (await fetch(`${base}/api/voice/tts?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
check('TTS 空文本被接口挡下', emptyTts.ok === false && seen.tts === beforeEmptyTts)
const bigAudio = 'A'.repeat(100 * 1024)
const sttHttp = await (await fetch(`${base}/api/voice/stt?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audioBase64: bigAudio, ext: 'webm', language: 'ja' }) })).json()
check('STT 接受 100 KB 的音频体（> 默认 64 KB 上限）', sttHttp.ok === true && sttHttp.text === `len-${bigAudio.length}-webm-ja`, sttHttp.text)
check('接口把 STT 语言覆盖转给 supervisor', seen.lastStt.language === 'ja')
const toggleHttp = await (await fetch(`${base}/api/voice/toggle?token=${token}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tts: true }),
})).json()
check('接口把语音开关转给 supervisor', toggleHttp.ok === true && seen.toggle && seen.toggle.tts === true, JSON.stringify(seen.toggle))
const providerHttp = await (await fetch(`${base}/api/voice/toggle?token=${token}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ttsProvider: 'local' }),
})).json()
check('接口把 TTS 后端切换转给 supervisor', providerHttp.ok === true && seen.toggle.ttsProvider === 'local', JSON.stringify(seen.toggle))
const valuesHttp = await (await fetch(`${base}/api/voice/toggle?token=${token}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { ttsVoice: 'nova' } }),
})).json()
check('接口把服务配置 values 转给 supervisor', valuesHttp.ok === true && seen.toggle.values?.ttsVoice === 'nova', JSON.stringify(seen.toggle))
const badToggle = await (await fetch(`${base}/api/voice/toggle?token=${token}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
})).json()
check('语音开关空请求被挡下', badToggle.ok === false)
check('语音接口需要 token', (await fetch(`${base}/api/voice/status`)).status === 401)
check('语音接口拒绝跨站 Origin',
  (await fetch(`${base}/api/voice/status?token=${token}`, { headers: { Origin: 'https://evil.example' } })).status === 403)
const hugeBody = await fetch(`${base}/api/voice/stt?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audioBase64: 'A'.repeat(10 * 1024 * 1024), ext: 'webm' }) })
check('STT 音频体上限 9 MB', hugeBody.status === 413)
server.close()

const legacy = createControlServer({ config: supConfig, token, api: { status: async () => ({}), logFile: () => '' }, ui: '' })
await new Promise((resolve) => legacy.listen(0, '127.0.0.1', resolve))
const legacyStatus = await (await fetch(`http://127.0.0.1:${legacy.address().port}/api/voice/status?token=${token}`)).json()
check('旧控制台给出可读的不支持原因', legacyStatus.ok === false && legacyStatus.reason.includes('语音调试'))
const legacyTts = await (await fetch(`http://127.0.0.1:${legacy.address().port}/api/voice/tts?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }) })).json()
check('旧控制台的 TTS 写接口也给出原因', legacyTts.ok === false && legacyTts.reason.includes('语音调试'))
const legacyVoicePage = await fetch(`http://127.0.0.1:${legacy.address().port}/voice?token=${token}`)
const legacyVoiceBody = await legacyVoicePage.json()
check('旧控制台没有语音页时明确 404', legacyVoicePage.status === 404 && legacyVoiceBody.reason.includes('没有语音调试页'))
legacy.close()

// ---------------------------------------------------------- ④ 页面 ----
const voicePageHtml = readUi(join(import.meta.dirname, '..', 'control', 'voice.html'))
for (const id of ['voiceStatus', 'voiceText', 'voiceVoice', 'voiceTextLang', 'voiceTtsState', 'voiceTtsOut',
  'voiceAttempts', 'voiceLang', 'voiceRecBtn', 'voiceFile', 'voiceSttState', 'voiceSttOut', 'verdictPill', 'tokenHint', 'pageErrors']) {
  if (!voicePageHtml.includes(`id="${id}"`)) { failed++; console.log('FAIL', `语音页缺少元素 #${id}`) }
}
check('语音调试是独立页面（/voice）', voicePageHtml.includes('语音调试') && voicePageHtml.includes("api('/api/voice/status')"))
const pageScript = /<script>([\s\S]*)<\/script>/.exec(voicePageHtml)?.[1] ?? ''
for (const fn of ['loadVoiceStatus', 'renderStatus', 'testTts', 'toggleRecord', 'sendFile', 'transcribeBase64', 'blobToBase64', 'base64ToBlob', 'renderAttempts']) {
  if (!new RegExp(`(async )?function ${fn}\\(`).test(pageScript)) { failed++; console.log('FAIL', `语音页缺少函数 ${fn}`) }
}
check('语音页函数齐全', true)
check('状态 pill 用「未启用 / 部分未启用」，不再写「都没启用」',
  pageScript.includes("'未启用'") && pageScript.includes("'部分未启用'") && !pageScript.includes('都没启用'))
check('语音开关有控件并接到 /api/voice/toggle',
  voicePageHtml.includes('id="ttsEnabledToggle"') && voicePageHtml.includes('id="sttEnabledToggle"')
  && pageScript.includes('function toggleVoice(') && pageScript.includes("api('/api/voice/toggle'")
  && pageScript.includes('ttsToggle.checked = tts.enabled === true'))
check('切换后自动刷新状态（宿主热重载 2–3 秒）',
  /setTimeout\(\(\) => loadVoiceStatus\(false\), 3500\)/.test(pageScript))
check('可切换 TTS/STT 后端（下拉 + 写入链路）',
  voicePageHtml.includes('id="ttsProviderSelect"') && voicePageHtml.includes('id="sttProviderSelect"')
  && pageScript.includes('function setVoiceProvider(') && pageScript.includes('ttsProvider: value')
  && pageScript.includes('ttsProviderSelect.value = String(tts.provider'))
check('服务配置可编辑（非密钥）并走 values 写入',
  ['cfgTtsVoice', 'cfgTtsModel', 'cfgTtsLocalUrl', 'cfgTtsLocalRefAudio', 'cfgTtsLocalPromptText', 'cfgSttModel']
    .every((id) => voicePageHtml.includes(`id="${id}"`))
  && pageScript.includes('function saveVoiceConfig(') && pageScript.includes('values })'))
check('语音页可直接启停本机语音服务（仅 local 后端）',
  voicePageHtml.includes('id="voiceServiceStart"') && voicePageHtml.includes('id="voiceServiceStop"')
  && pageScript.includes('function startVoiceService(') && pageScript.includes('function stopVoiceService(')
  && pageScript.includes("api('/api/tts/start'") && pageScript.includes("api('/api/tts/stop'")
  && pageScript.includes('button.disabled = !local'))
check('语音页脚本可解析', (() => { try { new Function(pageScript); return true } catch { return false } })())
check('页面请求三个语音接口',
  pageScript.includes("api('/api/voice/status')") && pageScript.includes("api('/api/voice/tts'") && pageScript.includes("api('/api/voice/stt'"))
const TUNE_IDS = ['voiceVoice', 'voiceTextLang', 'voiceLang', 'sttModel', 'pitch',
  'azureStyle', 'azureRate', 'azureVolume', 'openaiSpeed',
  'refAudio', 'refText', 'refLang', 'localSpeed', 'temperature', 'topK', 'topP', 'repetitionPenalty', 'seed']
for (const id of TUNE_IDS) {
  if (!voicePageHtml.includes(`id="${id}"`)) { failed++; console.log('FAIL', `语音页缺少细调控件 #${id}`) }
}
check('细调：基础 + 高级参数控件齐全（音色/语言/模型/音调/语速/采样/参考音频）', true)
for (const fn of ['collectTtsOverrides', 'resetTtsTune', 'paramsSummary', 'applyTtsFields', 'shortPath']) {
  if (!new RegExp(`(async )?function ${fn}\\(`).test(pageScript)) { failed++; console.log('FAIL', `语音页缺少函数 ${fn}`) }
}
check('细调：参数收集/重置/摘要函数齐全', true)
check('细调：TTS 请求体带 overrides 整包', pageScript.includes('JSON.stringify({ text, overrides })'))
check('细调：STT 请求体带语言与模型', pageScript.includes('JSON.stringify({ audioBase64: base64, ext, language, model:'))
check('细调：按 provider 显示对应参数', pageScript.includes("voiceProvider === 'azure'")
  && pageScript.includes("voiceProvider === 'openai'") && pageScript.includes("voiceProvider === 'local'"))
check('细调：越界由宿主校验，页面不偷偷夹紧', pageScript.includes('交给宿主侧校验'))
check('语言只保留中/英/日', ['中文', 'English', '日本語'].every((label) => voicePageHtml.includes(label))
  && !voicePageHtml.includes('粤语') && !voicePageHtml.includes('한국어'))
check('语言默认“自动”（TTS 与 STT 都是 auto）',
  (voicePageHtml.match(/<option value="auto">语言：自动<\/option>/g) ?? []).length === 2)
check('音调：Azure 走 prosody、其它 provider 走内置变调',
  pageScript.includes("voiceProvider === 'azure' ? 'azurePitch' : 'pitch'") && voicePageHtml.includes('内置变调'))
check('页面解释 16kHz 的来历（DSH 本地识别的硬要求）',
  voicePageHtml.includes('只接受') && voicePageHtml.includes('16kHz') && voicePageHtml.includes('训练采样率'))
for (const id of ['presetSelect', 'presetFile']) {
  if (!voicePageHtml.includes(`id="${id}"`)) { failed++; console.log('FAIL', `语音页缺少预设控件 #${id}`) }
}
check('导入是按钮（有框）且在导出左边',
  voicePageHtml.includes("onclick=\"document.getElementById('presetFile').click()\">导入</button>")
  && voicePageHtml.indexOf('>导入</button>') < voicePageHtml.indexOf('>导出</button>')
  && !voicePageHtml.includes('<label class="meta" style="margin:0;cursor:pointer">'))
check('细调预设：localStorage + 版本 1 + 读写/导入导出齐全',
  pageScript.includes("const PRESET_KEY = 'qq-voice-presets-v1'")
  && pageScript.includes('const PRESET_VERSION = 1')
  && ['readPresets', 'writePresets', 'renderPresetOptions', 'applyOverrides', 'savePreset', 'applyPreset', 'deletePreset', 'exportPresets', 'importPresets']
    .every((fn) => new RegExp(`function ${fn}\\(`).test(pageScript)))
check('上次试听参数会记住并自动恢复',
  pageScript.includes("const LAST_TUNE_KEY = 'qq-voice-tune-last-v1'")
  && /rememberLastTune\(result\.provider/.test(pageScript) && /restoreLastTune\(tts\)/.test(pageScript))
check('预设只影响试听（不写配置、不发 QQ）',
  !/api\('\/api\/(config|send)/.test(pageScript) && pageScript.includes('只影响这次试听'))
check('试听可下载/复制参数/复制对比表',
  ['copyText', 'paramsJson', 'downloadAttempt', 'copyAttemptParams', 'copyAttemptsTable', 'copyLastTtsParams']
    .every((fn) => new RegExp(`function ${fn}\\(`).test(pageScript))
  && pageScript.includes('复制对比表') && pageScript.includes('download="voice-attempt-'))
check('Ctrl+Enter 直接合成', /event\.key === 'Enter'/.test(pageScript)
  && /addEventListener\('keydown'/.test(pageScript) && pageScript.includes("document.getElementById('voiceText')"))
check('卡点全部列出（不只第一条）',
  /function blockerHints\(part\)/.test(pageScript) && /\(part && part\.blockers\) \|\| \[\]\)\.map/.test(pageScript)
  && !pageScript.includes('blockerTextOf'))
check('状态自动刷新：15 秒轮询 + 切回/聚焦立即刷新',
  pageScript.includes("setInterval(() => { if (!document.hidden) loadVoiceStatus(false); }, 15000)")
  && pageScript.includes("addEventListener('visibilitychange'")
  && pageScript.includes("window.addEventListener('focus'"))
check('TTS 结果会显示实际采样率（WAV 头解析）',
  pageScript.includes('function wavSpec') && pageScript.includes('wavSpec(result.audio)'))
check('试听保留最近 5 条用于 A/B（并释放旧 URL）',
  pageScript.includes('ATTEMPT_LIMIT = 5') && pageScript.includes('URL.revokeObjectURL'))
check('TTS 结果用 audio 标签试听', pageScript.includes('<audio controls autoplay') && pageScript.includes('URL.createObjectURL'))
check('STT 支持录音（getUserMedia + MediaRecorder）', pageScript.includes('navigator.mediaDevices.getUserMedia') && pageScript.includes('new MediaRecorder'))
check('STT 支持选文件（FileReader 转 base64）', pageScript.includes('readAsDataURL') && pageScript.includes('sendFile'))
check('录音结束会关掉麦克风', pageScript.includes('getTracks().forEach'))
check('结果文本统一转义', /escapeHtml\(result\.text/.test(pageScript) && /escapeHtml\(item\.text/.test(pageScript))
check('页面只调用 /api/voice（没有发 QQ 的旁路）', !/api\('\/api\/(inject|send|host|napcat|config)/.test(pageScript))
check('没有 token 时给出说明', pageScript.includes("getElementById('tokenHint').style.display = ''"))
const consoleUi = readUi(join(import.meta.dirname, '..', 'control', 'ui.html'))
check('语音调试是控制台里的一个分组（不再单开一页）',
  consoleUi.includes('data-tab="voice"') && consoleUi.includes('id="voiceFrame"') && consoleUi.includes('语音调试')
  && !consoleUi.includes('class="navitem voiceLink"')
  && !/<header>[\s\S]*?语音调试[\s\S]*?<\/header>/.test(consoleUi))
check('iframe 懒加载并带 token / embed 参数',
  /function loadVoiceFrame\(\)/.test(consoleUi)
  && consoleUi.includes("'/voice?embed=1'") && consoleUi.includes('encodeURIComponent(token)'))
check('语音页支持 embed 模式（隐藏大标题与回控制台）',
  voicePageHtml.includes("classList.add('embed')") && voicePageHtml.includes('body.embed header .brand'))
check('控制台不再内嵌语音卡（已挪到独立页）', !consoleUi.includes('id="voiceText"') && !consoleUi.includes('function loadVoice('))

rmSync(dir, { recursive: true, force: true })
rmSync(proxyDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
