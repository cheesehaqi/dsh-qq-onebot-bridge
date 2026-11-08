/**
 * 语音模块的**调试逻辑**（TTS 试听 / STT 试转写）。
 *
 * 为什么单独一个模块：语音这条链路是「配置 × 本机服务 × 外部供应商」的组合，
 * 出问题时用户看到的只有"没声音 / 没转写"，而真正的卡点可能是
 *   · 开关关着（ttsEnabled / sttEnabled，默认都关）
 *   · 本地 TTS 没配参考音频（GPT-SoVITS 必填）
 *   · 云 TTS/STT 没配 API Key
 *   · 宿主里没有 `speechToText` 服务（DSH 的「语音输入」bundle 没启用）
 * 这里把这些判断做成**纯函数**：每个卡点都返回一句人话 + 该去哪里开，
 * 这样面板/控制台/单测看到的是同一份口径。
 *
 * 合成与转写本身需要副作用（HTTP / ffmpeg / 宿主服务），全部**可注入**，
 * 因此单测不需要联网、不需要 ffmpeg、也不需要真的 DSH 宿主。
 */
import { basename } from 'node:path'
import { DEFAULT_STT_LANGUAGE, explainDshError, toWav16k, transcribeViaDsh } from './stt.js'
import { synthesizeTts } from './tts.js'
import { shiftPitch } from './audio-fx.js'

/** 一次试听最多合成多少字（防止把一篇文档丢给付费接口）。 */
export const VOICE_TEST_MAX_CHARS = 500

/** 上传/录音的原始音频上限（字节）。浏览器端也会先拦一次，这里是服务端的真门禁。 */
export const VOICE_AUDIO_MAX_BYTES = 6 * 1024 * 1024

const blocker = (code, reason, hint) => ({ code, reason, hint })

/**
 * 语音模块此刻能不能测：`{ tts, stt }`，各自 `{ enabled, provider, ready, blockers[] }`。
 *
 * @param config      生效中的插件配置（与 lib/index.js 的 schema 同一个对象）
 * @param hostService 宿主里有没有 `speechToText` 服务（`ctx.get('speechToText')`）
 */
export function checkVoiceReadiness(config = {}, { hostService = false } = {}) {
  const ttsEnabled = config.ttsEnabled === true
  const ttsProvider = String(config.ttsProvider || 'azure')
  const ttsBlockers = []
  if (!ttsEnabled) {
    ttsBlockers.push(blocker('tts-disabled', '语音回复（ttsEnabled）是关的', '设置 → 语音回复 打开后再试'))
  }
  if (ttsProvider === 'local') {
    if (String(config.ttsLocalRefAudio ?? '').trim() === '') {
      ttsBlockers.push(blocker('tts-no-ref', '本地 TTS 没配参考音频（ttsLocalRefAudio）',
        'GPT-SoVITS 克隆音色必须有 3–10 秒的参考 wav：在设置里填它的绝对路径'))
    }
    if (String(config.ttsLocalUrl ?? '').trim() === '') {
      ttsBlockers.push(blocker('tts-no-url', '本地 TTS 没配地址（ttsLocalUrl）', '默认是 http://127.0.0.1:9880（GPT-SoVITS api_v2）'))
    }
  } else if (ttsProvider === 'openai' || ttsProvider === 'azure') {
    if (String(config.ttsApiKey ?? '').trim() === '') {
      ttsBlockers.push(blocker('tts-no-key', `云端 TTS（${ttsProvider}）没配 API Key（ttsApiKey）`,
        ttsProvider === 'azure' ? '填 Azure Speech 的 key（ttsApiKey）' : '填 OpenAI 兼容接口的 key（ttsApiKey）'))
    }
  } else {
    ttsBlockers.push(blocker('tts-provider', `未知的 ttsProvider：${ttsProvider}`, '只能是 local / openai / azure'))
  }

  const sttEnabled = config.sttEnabled === true
  const sttProvider = String(config.sttProvider || 'dsh')
  const sttBlockers = []
  if (!sttEnabled) {
    sttBlockers.push(blocker('stt-disabled', '语音转文字（sttEnabled）是关的', '设置 → 语音转文字 打开后再试'))
  }
  if (sttProvider === 'dsh') {
    if (hostService !== true) {
      sttBlockers.push(blocker('stt-no-service', '宿主里没有 speechToText 服务',
        'profile 里启用实验性的「语音输入」bundle（@deepseek-ai/dsh-experimental-voice-input-bundle）并重启宿主；'
        + '首次使用会下载本地 SenseVoice 模型'))
    }
  } else if (sttProvider === 'cloud') {
    if (String(config.sttApiKey ?? '').trim() === '') {
      sttBlockers.push(blocker('stt-no-key', '云端 STT 没配 API Key（sttApiKey）', '填智谱 GLM-ASR / SiliconFlow 的 key'))
    }
    if (String(config.sttBaseUrl ?? '').trim() === '') {
      sttBlockers.push(blocker('stt-no-base', '云端 STT 没配接口地址（sttBaseUrl）', '填 OpenAI 兼容的 /audio/transcriptions 基地址'))
    }
  } else {
    sttBlockers.push(blocker('stt-provider', `未知的 sttProvider：${sttProvider}`, '只能是 dsh / cloud'))
  }

  return {
    tts: { enabled: ttsEnabled, provider: ttsProvider, ready: ttsBlockers.length === 0, blockers: ttsBlockers },
    stt: { enabled: sttEnabled, provider: sttProvider, ready: sttBlockers.length === 0, blockers: sttBlockers },
  }
}

/**
 * 给界面的**安全投影**：只写描述性字段，绝不放 API Key / token。
 * 参考音频只给文件名，不给完整路径（面板截图/录屏容易带出本机用户名）。
 */
export function voiceStatus(config = {}, { hostService = false } = {}) {
  const readiness = checkVoiceReadiness(config, { hostService })
  return {
    hostService: hostService === true,
    tts: {
      ...readiness.tts,
      voice: String(config.ttsVoice ?? ''),
      localUrl: readiness.tts.provider === 'local' ? String(config.ttsLocalUrl ?? '') : '',
      refAudioName: readiness.tts.provider === 'local' ? basename(String(config.ttsLocalRefAudio ?? '')) : '',
      textLang: String(config.ttsLocalTextLang ?? 'zh'),
      maxChars: VOICE_TEST_MAX_CHARS,
    },
    stt: {
      ...readiness.stt,
      language: String(config.sttLanguage || DEFAULT_STT_LANGUAGE),
      model: readiness.stt.provider === 'cloud' ? String(config.sttModel ?? '') : 'SenseVoice（本地）',
      baseUrl: readiness.stt.provider === 'cloud' ? String(config.sttBaseUrl ?? '') : '',
      maxBytes: VOICE_AUDIO_MAX_BYTES,
    },
  }
}

/** 把异常翻成人话（按阶段给出"下一步"）。 */
export function explainVoiceError(error, { phase = 'tts' } = {}) {
  const message = String(error?.message ?? error ?? '').trim()
  if (/abort|timeout|timed out/i.test(message)) {
    return `${phase === 'tts' ? 'TTS' : 'STT'} 超时：对面服务没在时限内回话（本地服务是不是没启动？）`
  }
  if (/ENOENT|not found|spawn .* ENOENT/i.test(message)) {
    return `${phase === 'tts' ? 'TTS' : 'STT'} 失败：找不到可执行文件（ffmpeg / 服务地址写错了？）`
  }
  if (/401|403|Unauthorized|Forbidden|invalid.*key/i.test(message)) {
    return `${phase === 'tts' ? 'TTS' : 'STT'} 鉴权失败：API Key 不对或没有权限（${message.slice(0, 80)}）`
  }
  if (phase === 'stt' && /speechToText|DSH|unavailable|provider/i.test(message)) return explainDshError(error)
  return `${phase === 'tts' ? 'TTS' : 'STT'} 失败：${message.slice(0, 160) || '未知错误'}`
}

/**
 * 细调参数：把页面传来的"按次覆盖"校验成一份干净的参数表。
 * 规则：字符串去空白并有长度上限；数值必须在物理/接口允许的范围内，
 * 越界就直接拒绝（**不悄悄夹紧** —— 调参时"我设了 3 倍速但实际是 2 倍"比报错更难查）。
 */
export function normalizeTtsOverrides(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  const strings = {
    voice: 80, textLang: 8, azureStyle: 40, refAudio: 400, refText: 300, refLang: 8,
  }
  for (const [key, maxChars] of Object.entries(strings)) {
    if (source[key] === undefined || source[key] === null) continue
    const text = String(source[key]).trim()
    if (text === '') continue
    out[key] = text.slice(0, maxChars)
  }
  const numbers = {
    azureRate: { min: -50, max: 100, integer: true, label: '语速(%)' },
    azurePitch: { min: -12, max: 12, label: '音调(st)' },
    azureVolume: { min: -50, max: 50, integer: true, label: '音量(%)' },
    pitch: { min: -12, max: 12, label: '音调(半音)' },
    speed: { min: 0.25, max: 4, label: '语速倍率' },
    localSpeed: { min: 0.5, max: 2, label: 'GPT-SoVITS 语速' },
    temperature: { min: 0.01, max: 2, label: 'temperature' },
    topK: { min: 1, max: 100, integer: true, label: 'top_k' },
    topP: { min: 0, max: 1, label: 'top_p' },
    repetitionPenalty: { min: 0.5, max: 2, label: '重复惩罚' },
    seed: { min: -1, max: 2147483647, integer: true, label: '种子' },
  }
  for (const [key, rule] of Object.entries(numbers)) {
    if (source[key] === undefined || source[key] === null || source[key] === '') continue
    const value = Number(source[key])
    if (!Number.isFinite(value) || value < rule.min || value > rule.max || (rule.integer && Number.isInteger(value) === false)) {
      throw new Error(`${rule.label} 必须是 ${rule.min}–${rule.max}${rule.integer ? ' 的整数' : ''}（收到 ${source[key]}）`)
    }
    out[key] = value
  }
  return out
}

/**
 * 试合成一段话（**不会发给 QQ**，只把音频字节交回给界面试听）。
 *
 * `overrides` 是本次调试的临时覆盖（细调音色/语速/音调/采样参数/参考音频…），不写回配置：
 *   · Azure：voice / azureStyle / azureRate(%) / azurePitch(st) / azureVolume(%)
 *   · OpenAI 兼容：voice / speed(0.25–4)
 *   · GPT-SoVITS：voice 不参与；textLang / refAudio / refText / refLang / localSpeed /
 *     temperature / topK / topP / repetitionPenalty / seed
 * @returns {Promise<{ audio: Buffer, format: string, bytes: number, ms: number, provider: string, voice: string, textLang: string, params: object }>}
 */
export async function synthesizeForTest({
  config = {}, text = '', overrides = null, voice = '', textLang = '', tmpDir = '', run = undefined, fetchImpl = fetch,
} = {}) {
  const clean = String(text ?? '').trim()
  if (clean === '') throw new Error('要合成的文字是空的')
  if (clean.length > VOICE_TEST_MAX_CHARS) {
    throw new Error(`文字太长：最多 ${VOICE_TEST_MAX_CHARS} 字（收到 ${clean.length} 字）`)
  }
  const raw = { ...(overrides && typeof overrides === 'object' ? overrides : {}) }
  if (String(voice ?? '').trim() !== '') raw.voice = voice
  if (String(textLang ?? '').trim() !== '') raw.textLang = textLang
  const params = normalizeTtsOverrides(raw)

  // 就绪判断要用"覆盖后的配置"：例如配置里没填参考音频，但这次试听填了，就不该拦。
  const effective = { ...config }
  if (params.voice) effective.ttsVoice = params.voice
  if (params.textLang) effective.ttsLocalTextLang = params.textLang
  if (params.refAudio) effective.ttsLocalRefAudio = params.refAudio
  if (params.refText !== undefined) effective.ttsLocalPromptText = params.refText
  if (params.refLang) effective.ttsLocalPromptLang = params.refLang
  if (params.azureStyle !== undefined) effective.ttsStyle = params.azureStyle
  const readiness = checkVoiceReadiness(effective)
  if (readiness.tts.ready !== true) {
    const first = readiness.tts.blockers[0]
    throw new Error(`${first.reason}；${first.hint}`)
  }
  const startedAt = Date.now()
  try {
    const { audio, format } = await synthesizeTts(effective, clean, { fetchImpl, overrides: params })
    // 音调：Azure 用原生 SSML（params.azurePitch），其它 provider 没有音调参数 → 这里用 ffmpeg 移调（只变调不变时长）
    const finalAudio = params.pitch !== undefined
      ? await shiftPitch({
        buffer: audio,
        format,
        semitones: params.pitch,
        ffmpegPath: String(config.ffmpegPath || 'ffmpeg'),
        tmpDir: tmpDir === '' ? process.cwd() : tmpDir,
        ...(typeof run === 'function' ? { run } : {}),
      })
      : { audio, format }
    return {
      audio: finalAudio.audio,
      format: finalAudio.format,
      bytes: finalAudio.audio.length,
      ms: Date.now() - startedAt,
      provider: readiness.tts.provider,
      voice: String(effective.ttsVoice ?? ''),
      textLang: String(effective.ttsLocalTextLang ?? ''),
      params,
    }
  } catch (error) {
    throw new Error(explainVoiceError(error, { phase: 'tts' }))
  }
}

/**
 * 试转写一段音频（浏览器录音 / 上传的文件都走这里）。
 *
 * @param audioBase64 音频字节的 base64
 * @param ext         扩展名提示（webm / ogg / wav / mp3 / amr / silk…；ffmpeg 按内容嗅探，ext 只决定临时文件名）
 * @param language    本次的语言覆盖（auto/zh/en/yue/ja/ko；空 = 用配置里的 sttLanguage）
 * @param service     宿主的 speechToText 服务（sttProvider=dsh 时必需）
 * @param tmpDir      ffmpeg 临时目录
 * @param run         ffmpeg 执行器（默认 execFile；单测注入假实现）
 * @returns {Promise<{ text: string, provider: string, bytes: number, wavBytes: number, ms: number }>}
 */
export async function transcribeForTest({
  config = {}, audioBase64 = '', ext = 'webm', language = '', model = '', service = null,
  tmpDir = '', run = undefined, fetchImpl = fetch,
} = {}) {
  const buffer = Buffer.from(String(audioBase64 ?? ''), 'base64')
  if (buffer.length === 0) throw new Error('音频是空的：录一段或选一个音频文件')
  if (buffer.length > VOICE_AUDIO_MAX_BYTES) {
    throw new Error(`音频太大：上限 ${Math.round(VOICE_AUDIO_MAX_BYTES / 1024 / 1024)} MB（收到 ${(buffer.length / 1024 / 1024).toFixed(1)} MB）`)
  }
  const provider = String(config.sttProvider || 'dsh')
  const cleanLanguage = String(language ?? '').trim().slice(0, 16) || String(config.sttLanguage || DEFAULT_STT_LANGUAGE)
  const cleanModel = String(model ?? '').trim().slice(0, 80) || String(config.sttModel || 'glm-asr-2512')
  const readiness = checkVoiceReadiness(config, { hostService: Boolean(service) })
  if (readiness.stt.ready !== true) {
    const first = readiness.stt.blockers[0]
    throw new Error(`${first.reason}；${first.hint}`)
  }
  const startedAt = Date.now()
  try {
    if (provider === 'cloud') {
      return await transcribeViaCloud({ config, buffer, ext, startedAt, fetchImpl, model: cleanModel, language: cleanLanguage })
    }
    const wav = await toWav16k({
      buffer,
      ext,
      ffmpegPath: String(config.ffmpegPath || 'ffmpeg'),
      tmpDir: tmpDir === '' ? process.cwd() : tmpDir,
      ...(typeof run === 'function' ? { run } : {}),
    })
    const text = await transcribeViaDsh({ service, wav, language: cleanLanguage })
    return { text, provider: 'dsh', language: cleanLanguage, model: '', bytes: buffer.length, wavBytes: wav.length, ms: Date.now() - startedAt }
  } catch (error) {
    throw new Error(explainVoiceError(error, { phase: 'stt' }))
  }
}

/** 云端 STT（OpenAI 兼容 /audio/transcriptions），与桥里的实现同口径。 */
async function transcribeViaCloud({ config, buffer, ext, startedAt, fetchImpl = fetch, model = '', language = '' }) {
  const base = String(config.sttBaseUrl || '').replace(/\/+$/, '')
  if (base === '') throw new Error('未配置 sttBaseUrl')
  const suffix = String(ext || 'webm').toLowerCase() === 'wav' ? 'wav' : 'mp3'
  const mime = suffix === 'wav' ? 'audio/wav' : 'audio/mpeg'
  const form = new FormData()
  form.append('model', model || String(config.sttModel || 'glm-asr-2512'))
  if (language !== '' && language !== 'auto') form.append('language', language)
  form.append('file', new Blob([buffer], { type: mime }), `audio.${suffix}`)
  const response = await fetchImpl(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${String(config.sttApiKey ?? '')}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200)
    throw new Error(`STT HTTP ${response.status}: ${detail}`)
  }
  const data = await response.json()
  const text = String(data?.text ?? '').trim()
  if (text === '') throw new Error(`STT 返回为空: ${JSON.stringify(data).slice(0, 120)}`)
  return { text, provider: 'cloud', language, model, bytes: buffer.length, wavBytes: 0, ms: Date.now() - startedAt }
}
