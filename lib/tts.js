/**
 * TTS synthesis: Azure Speech (SSML), any OpenAI-compatible /audio/speech endpoint,
 * or a local GPT-SoVITS api_v2 server (zero-shot voice cloning).
 * Returns { audio: Buffer, format: 'mp3' | 'wav' }.
 */

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Build Azure Speech SSML.
 *
 * `prosody` 支持 `{ rate, pitch, volume }`（试听页的细调参数）：
 *   rate   语速，百分比（-50…100）→ `<prosody rate="+10%">`
 *   pitch  音调，半音（-12…12）  → `<prosody pitch="+2st">`
 *   volume 音量，百分比（-50…50） → `<prosody volume="-10%">`
 * style 用官方要求的 `<mstts:express-as>` 包一层（`<voice style>` 并不是合法 SSML）。
 */
export function buildAzureSsml(text, voice, style, prosody = {}) {
  const body = escapeXml(text)
  const attrs = []
  const percent = (value) => `${Number(value) >= 0 ? '+' : ''}${Number(value)}%`
  if (prosody.rate !== undefined && prosody.rate !== null) attrs.push(`rate="${percent(prosody.rate)}"`)
  if (prosody.pitch !== undefined && prosody.pitch !== null) attrs.push(`pitch="${Number(prosody.pitch) >= 0 ? '+' : ''}${Number(prosody.pitch)}st"`)
  if (prosody.volume !== undefined && prosody.volume !== null) attrs.push(`volume="${percent(prosody.volume)}"`)
  const spoken = attrs.length > 0 ? `<prosody ${attrs.join(' ')}>${body}</prosody>` : body
  const voiced = style ? `<mstts:express-as style="${escapeXml(style)}">${spoken}</mstts:express-as>` : spoken
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="${escapeXml(voice)}">${voiced}</voice></speak>`
}

/**
 * Build the JSON body for a GPT-SoVITS api_v2 POST /tts request (pure, testable).
 *
 * `overrides` 是试听页的**按次覆盖**（参考音频/参考文本/采样参数/语速/种子…）：
 * 只有显式给到的键才会进请求体，没给的一律回落到插件配置 —— 老版本 GPT-SoVITS
 * 不认识某些键时也不会因为多出来的字段报错。
 */
export function buildLocalTtsRequest(config, text, overrides = {}) {
  const body = {
    text,
    text_lang: overrides.textLang || config.ttsLocalTextLang || 'zh',
    ref_audio_path: overrides.refAudio || config.ttsLocalRefAudio || '',
    prompt_text: overrides.refText !== undefined && overrides.refText !== ''
      ? overrides.refText
      : (config.ttsLocalPromptText || ''),
    prompt_lang: overrides.refLang || config.ttsLocalPromptLang || 'zh',
    media_type: 'wav',
    streaming_mode: 0,
  }
  if (overrides.localSpeed !== undefined) body.speed_factor = overrides.localSpeed
  if (overrides.temperature !== undefined) body.temperature = overrides.temperature
  if (overrides.topK !== undefined) body.top_k = overrides.topK
  if (overrides.topP !== undefined) body.top_p = overrides.topP
  if (overrides.repetitionPenalty !== undefined) body.repetition_penalty = overrides.repetitionPenalty
  if (overrides.seed !== undefined) body.seed = overrides.seed
  return body
}

/**
 * Synthesize text to audio bytes according to the bridge TTS config.
 * `fetchImpl` 可注入：控制台的「语音调试」与单测都不该真发网络请求。
 * `overrides` 是试听页的按次覆盖（见 buildLocalTtsRequest / buildAzureSsml）。
 */
export async function synthesizeTts(config, text, { fetchImpl = fetch, overrides = {} } = {}) {
  if (config.ttsProvider === 'openai') {
    const base = String(config.ttsBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
    const payload = {
      model: config.ttsModel || 'tts-1',
      voice: overrides.voice || config.ttsVoice || 'alloy',
      input: text,
    }
    // OpenAI 兼容的 /audio/speech 支持 speed（0.25–4）；没给就不带这个字段
    if (overrides.speed !== undefined) payload.speed = overrides.speed
    const response = await fetchImpl(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ttsApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error(`TTS HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`)
    return { audio: Buffer.from(await response.arrayBuffer()), format: 'mp3' }
  }
  if (config.ttsProvider === 'local') {
    // Local GPT-SoVITS api_v2: POST /tts returns raw wav bytes (or a JSON error).
    const base = String(config.ttsLocalUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '')
    const response = await fetchImpl(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildLocalTtsRequest(config, text, overrides)),
      signal: AbortSignal.timeout(120000),
    })
    if (!response.ok) {
      let detail = ''
      try { detail = (await response.json()).message ?? '' } catch { detail = await response.text().catch(() => '') }
      throw new Error(`本地 TTS HTTP ${response.status}: ${String(detail).slice(0, 120)}`)
    }
    return { audio: Buffer.from(await response.arrayBuffer()), format: 'wav' }
  }
  // Azure Speech REST (SSML)
  const region = config.ttsAzureRegion || 'eastasia'
  const voice = overrides.voice || config.ttsVoice || 'zh-CN-XiaoxiaoNeural'
  const style = overrides.azureStyle !== undefined ? overrides.azureStyle : (config.ttsStyle || '')
  const response = await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.ttsApiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'dsh-qq-onebot-bridge',
    },
    body: buildAzureSsml(text, voice, style, {
      rate: overrides.azureRate,
      pitch: overrides.azurePitch,
      volume: overrides.azureVolume,
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) throw new Error(`Azure TTS HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`)
  return { audio: Buffer.from(await response.arrayBuffer()), format: 'mp3' }
}
