/**
 * Image generation (生图): any OpenAI-compatible /images/generations endpoint
 * (DALL·E / Zhipu CogView / SiliconFlow...) or a local Stable Diffusion WebUI
 * (AUTOMATIC1111 /sdapi/v1/txt2img). Returns PNG bytes.
 * New backends = one extra branch in generateImage (same contract as TTS).
 */

/** Build the JSON body for an OpenAI-compatible /images/generations request (pure, testable). */
export function buildOpenaiImageRequest(config, prompt) {
  const body = {
    model: config.imageGenModel || 'gpt-image-1',
    prompt,
    n: 1,
    size: config.imageGenSize || '1024x1024',
    response_format: 'b64_json',
  }
  return body
}

/** Parse an OpenAI-compatible image response into { buffer, format } or { url }. */
export function parseOpenaiImageResponse(data) {
  const first = Array.isArray(data && data.data) ? data.data[0] : null
  if (!first) throw new Error('生图服务未返回图片数据')
  if (first.b64_json) return { buffer: Buffer.from(String(first.b64_json), 'base64'), format: 'png' }
  if (first.url) return { url: String(first.url) }
  throw new Error('生图服务响应缺少图片内容')
}

/** Build the JSON body for a local SD WebUI /sdapi/v1/txt2img request (pure, testable). */
export function buildLocalTxt2ImgRequest(config, prompt) {
  const parts = String(config.imageGenSize || '512x512').split('x').map((n) => Number(n))
  return {
    prompt,
    steps: Math.max(1, Math.min(100, Number(config.imageGenSteps) || 20)),
    cfg_scale: Math.max(1, Math.min(30, Number(config.imageGenCfgScale) || 7)),
    sampler_name: config.imageGenSampler || '',
    width: Number.isFinite(parts[0]) && parts[0] > 0 ? parts[0] : 512,
    height: Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : 512,
  }
}

/** Generate an image according to the bridge image-gen config; resolves to { buffer, format }. */
export async function generateImage(config, prompt) {
  if (config.imageGenProvider === 'local') {
    // Local Stable Diffusion WebUI (AUTOMATIC1111-compatible).
    const base = String(config.imageGenBaseUrl || 'http://127.0.0.1:7860').replace(/\/+$/, '')
    const response = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildLocalTxt2ImgRequest(config, prompt)),
      signal: AbortSignal.timeout(180000),
    })
    if (!response.ok) throw new Error(`本地生图 HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`)
    const data = await response.json()
    const b64 = Array.isArray(data && data.images) ? data.images[0] : null
    if (!b64) throw new Error('本地生图服务未返回图片')
    return { buffer: Buffer.from(String(b64), 'base64'), format: 'png' }
  }
  // OpenAI-compatible /images/generations.
  const base = String(config.imageGenBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const response = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.imageGenApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildOpenaiImageRequest(config, prompt)),
    signal: AbortSignal.timeout(180000),
  })
  if (!response.ok) throw new Error(`生图 HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`)
  const data = await response.json()
  const parsed = parseOpenaiImageResponse(data)
  if (parsed.url) {
    const image = await fetch(parsed.url, { signal: AbortSignal.timeout(60_000) })
    if (!image.ok) throw new Error(`下载生成图片失败 HTTP ${image.status}`)
    return { buffer: Buffer.from(await image.arrayBuffer()), format: 'png' }
  }
  return parsed
}
