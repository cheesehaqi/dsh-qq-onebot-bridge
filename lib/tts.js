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

export function buildAzureSsml(text, voice, style) {
  const styleAttr = style ? ` style="${escapeXml(style)}"` : ''
  return `<speak version="1.0" xml:lang="zh-CN"><voice name="${escapeXml(voice)}"${styleAttr}>${escapeXml(text)}</voice></speak>`
}

/** Build the JSON body for a GPT-SoVITS api_v2 POST /tts request (pure, testable). */
export function buildLocalTtsRequest(config, text) {
  return {
    text,
    text_lang: config.ttsLocalTextLang || 'zh',
    ref_audio_path: config.ttsLocalRefAudio || '',
    prompt_text: config.ttsLocalPromptText || '',
    prompt_lang: config.ttsLocalPromptLang || 'zh',
    media_type: 'wav',
    streaming_mode: 0,
  }
}

/** Synthesize text to audio bytes according to the bridge TTS config. */
export async function synthesizeTts(config, text) {
  if (config.ttsProvider === 'openai') {
    const base = String(config.ttsBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
    const response = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ttsApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: config.ttsModel || 'tts-1', voice: config.ttsVoice || 'alloy', input: text }),
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error(`TTS HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`)
    return { audio: Buffer.from(await response.arrayBuffer()), format: 'mp3' }
  }
  if (config.ttsProvider === 'local') {
    // Local GPT-SoVITS api_v2: POST /tts returns raw wav bytes (or a JSON error).
    const base = String(config.ttsLocalUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '')
    const response = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildLocalTtsRequest(config, text)),
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
  const voice = config.ttsVoice || 'zh-CN-XiaoxiaoNeural'
  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.ttsApiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'dsh-qq-onebot-bridge',
    },
    body: buildAzureSsml(text, voice, config.ttsStyle || ''),
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) throw new Error(`Azure TTS HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`)
  return { audio: Buffer.from(await response.arrayBuffer()), format: 'mp3' }
}
