/**
 * 可替换的视频理解后端：Qwen / OpenAI 兼容视觉接口（吃联系表）和 Gemini 原生视频。
 *
 * 只负责“把证据发给模型、拿回一段文字”；配置、降级、密钥都不在这里。
 * 所有网络调用都接受 fetchImpl，方便单测；失败抛出可读中文原因。
 */
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

export const DEFAULT_VIDEO_PROMPT = [
  '请用中文描述这段视频里实际发生了什么。',
  '按时间顺序给出关键动作/场景变化，带大概秒数；',
  '如果有说话、音乐、音效或明显语气，也指出来。',
  '只描述你能从画面/声音确认的内容，不要编造。',
].join('')

const MAX_IMAGES = 2

function qwenBaseOf(baseUrl) {
  return String(baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '')
}

function geminiBaseOf(baseUrl) {
  return String(baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '').replace(/\/v1beta$/, '')
}

function qwenModelOf(model) {
  return String(model || 'qwen-vl-max')
}

function geminiModelOf(model) {
  return String(model || 'gemini-2.0-flash')
}

function promptOf(prompt) {
  const text = String(prompt ?? '').trim()
  return text === '' ? DEFAULT_VIDEO_PROMPT : text
}

function imageDataUrl(file) {
  const data = readFileSync(file)
  const ext = String(file).toLowerCase().split('.').pop()
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${data.toString('base64')}`
}

function textFromContent(content) {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : String(part?.text ?? ''))).join('').trim()
  }
  return ''
}

/**
 * 控制台「测试连接」：不传视频，只验证 Key/Base/Model 能不能通。
 * local/command 不产生网络请求，直接说明它们会在收到视频时工作。
 */
export async function testVideoProvider({
  provider = 'local',
  baseUrl = '',
  model = '',
  apiKey = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  const kind = String(provider || 'local').toLowerCase()
  if (kind === 'local') return { ok: true, provider: 'local', text: '本地抽帧不需要 API Key（收到视频时直接跑 ffmpeg）' }
  if (kind === 'command') return { ok: true, provider: 'command', text: '外部分析器会在收到视频时执行；这里不启动命令' }
  const key = String(apiKey ?? '').trim()
  if (key === '') throw new Error('未配置视频模型 API Key')
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch')
  if (kind === 'qwen') {
    const response = await fetchImpl(`${qwenBaseOf(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: qwenModelOf(model), messages: [{ role: 'user', content: '只回复 OK' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Qwen 测试 HTTP ${response.status}：${detail.slice(0, 200)}`)
    }
    const data = await response.json().catch(() => null)
    return { ok: true, provider: 'qwen', text: `Qwen 连通：${textFromContent(data?.choices?.[0]?.message?.content) || '（空回复）'}` }
  }
  if (kind === 'gemini') {
    const response = await fetchImpl(`${geminiBaseOf(baseUrl)}/v1beta/models/${encodeURIComponent(geminiModelOf(model))}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ text: '只回复 OK' }] }] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Gemini 测试 HTTP ${response.status}：${detail.slice(0, 200)}`)
    }
    const data = await response.json().catch(() => null)
    const text = (data?.candidates?.[0]?.content?.parts ?? []).map((part) => String(part?.text ?? '')).join('').trim()
    return { ok: true, provider: 'gemini', text: `Gemini 连通：${text || '（空回复）'}` }
  }
  throw new Error(`不认识的视频后端：${kind}`)
}

/**
 * Qwen / 任意 OpenAI 兼容视觉接口：把联系表作为 image_url 发过去。
 * baseUrl 应包含 /v1（DashScope: https://dashscope.aliyuncs.com/compatible-mode/v1）。
 */
export async function describeWithQwen({
  baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey,
  model = 'qwen-vl-max',
  images = [],
  transcript = '',
  prompt = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
} = {}) {
  const key = String(apiKey ?? '').trim()
  if (key === '') throw new Error('未配置视频模型 API Key')
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch')
  const files = (Array.isArray(images) ? images : []).filter((file) => {
    try { return statSync(file).isFile() && statSync(file).size > 0 } catch { return false }
  }).slice(0, MAX_IMAGES)
  if (files.length === 0) throw new Error('没有可发送的联系表/帧')
  const content = [
    { type: 'text', text: promptOf(prompt) },
    ...files.map((file) => ({ type: 'image_url', image_url: { url: imageDataUrl(file) } })),
  ]
  if (String(transcript).trim() !== '') {
    content.push({ type: 'text', text: `音轨转写（只作参考，不要照抄）：\n${String(transcript).slice(0, 4000)}` })
  }
  const url = `${qwenBaseOf(baseUrl)}/chat/completions`
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0.2 }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`视觉接口 HTTP ${response.status}：${detail.slice(0, 200)}`)
  }
  const data = await response.json().catch(() => null)
  const text = textFromContent(data?.choices?.[0]?.message?.content)
  if (text === '') throw new Error('视觉接口没有返回文字')
  return text
}

/**
 * Gemini 原生视频：Files API 上传 → 等 ACTIVE → generateContent 带 file_data。
 * 这是唯一会把“整段视频（含音轨）”交给外部模型的后端；密钥和文件都不会落到控制台。
 */
export async function describeWithGemini({
  apiKey,
  baseUrl = 'https://generativelanguage.googleapis.com',
  model = 'gemini-2.0-flash',
  videoPath,
  mimeType = 'video/mp4',
  prompt = '',
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 180_000,
} = {}) {
  const key = String(apiKey ?? '').trim()
  if (key === '') throw new Error('未配置 Gemini API Key')
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch')
  if (!videoPath) throw new Error('没有视频文件')
  const size = statSync(videoPath).size
  if (size <= 0) throw new Error('视频文件是空的')
  const base = geminiBaseOf(baseUrl)
  const headers = { 'x-goog-api-key': key }

  // 1) 开始 resumable upload
  const start = await fetchImpl(`${base}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      ...headers,
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(size),
      'x-goog-upload-header-content-type': mimeType,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: basename(String(videoPath)).slice(0, 120) } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!start.ok) {
    const detail = await start.text().catch(() => '')
    throw new Error(`Gemini 上传初始化 HTTP ${start.status}：${detail.slice(0, 200)}`)
  }
  const uploadUrl = start.headers.get('x-goog-upload-url')
  if (!uploadUrl) throw new Error('Gemini 没有返回 upload url')

  // 2) 上传字节并 finalize
  const upload = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: {
      ...headers,
      'x-goog-upload-offset': '0',
      'x-goog-upload-command': 'upload, finalize',
      'content-type': mimeType,
    },
    body: readFileSync(videoPath),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!upload.ok) {
    const detail = await upload.text().catch(() => '')
    throw new Error(`Gemini 上传 HTTP ${upload.status}：${detail.slice(0, 200)}`)
  }
  let file = (await upload.json().catch(() => null))?.file
  if (!file?.name || !file?.uri) throw new Error('Gemini 上传没有返回 file uri')

  // 3) 等文件 ACTIVE（视频转码需要时间）
  for (let attempt = 0; attempt < 30 && file.state !== 'ACTIVE'; attempt += 1) {
    await sleepImpl(1000)
    const poll = await fetchImpl(`${base}/v1beta/${file.name}`, { headers, signal: AbortSignal.timeout(30_000) })
    if (!poll.ok) throw new Error(`Gemini 文件状态 HTTP ${poll.status}`)
    const next = (await poll.json().catch(() => null))?.file
    if (next) file = next
  }
  if (file.state !== 'ACTIVE') throw new Error(`Gemini 文件没有就绪（state=${file.state || 'unknown'}）`)

  // 4) generateContent
  const response = await fetchImpl(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { file_data: { mime_type: mimeType, file_uri: file.uri } },
          { text: promptOf(prompt) },
        ],
      }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Gemini generateContent HTTP ${response.status}：${detail.slice(0, 200)}`)
  }
  const data = await response.json().catch(() => null)
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((part) => String(part?.text ?? '')).join('').trim()
  if (text === '') throw new Error('Gemini 没有返回文字')

  // 清理远端文件（失败不影响结果）
  try { await fetchImpl(`${base}/v1beta/${file.name}`, { method: 'DELETE', headers }) } catch { /* best effort */ }
  return text
}
