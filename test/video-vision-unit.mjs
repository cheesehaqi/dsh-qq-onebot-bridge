/**
 * 视频模型后端单测：Qwen/OpenAI 兼容（联系表）与 Gemini 原生视频（Files API）。
 * 只打桩 fetch，不发真实网络请求。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeWithGemini, describeWithQwen, testVideoProvider } from '../lib/video-vision.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS', name, extra) }
  else { failed += 1; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-video-vision-'))
const image = join(dir, 'sheet.jpg')
const video = join(dir, 'clip.mp4')
writeFileSync(image, Buffer.from('fake-jpeg'))
writeFileSync(video, Buffer.from('fake-video'))

function fakeResponse({ ok = true, status = 200, json = null, text = '', headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => json,
    text: async () => text,
  }
}

const qwenCalls = []
const qwen = await describeWithQwen({
  baseUrl: 'https://qwen.example/v1',
  apiKey: 'qwen-key',
  model: 'qwen-vl-test',
  images: [image],
  transcript: '他说你好',
  prompt: '描述画面',
  fetchImpl: async (url, init) => {
    qwenCalls.push({ url, init })
    return fakeResponse({ json: { choices: [{ message: { content: '画面里有一张测试图。' } }] } })
  },
})
check('Qwen：拿回文字', qwen === '画面里有一张测试图。')
check('Qwen：请求地址/鉴权/model 正确',
  qwenCalls[0]?.url === 'https://qwen.example/v1/chat/completions'
  && qwenCalls[0]?.init.headers.authorization === 'Bearer qwen-key'
  && JSON.parse(qwenCalls[0]?.init.body).model === 'qwen-vl-test')
check('Qwen：带联系表 + 提示 + 转写',
  (() => {
    const body = JSON.parse(qwenCalls[0].init.body)
    const content = body.messages[0].content
    return content.some((part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/jpeg;base64,'))
      && content.some((part) => part.type === 'text' && part.text === '描述画面')
      && content.some((part) => part.type === 'text' && part.text.includes('他说你好'))
  })())
let noKey = ''
try { await describeWithQwen({ apiKey: '', images: [image] }) } catch (error) { noKey = error.message }
check('Qwen：没有 Key 直接报人话', noKey.includes('API Key'))

const geminiCalls = []
const gemini = await describeWithGemini({
  apiKey: 'gemini-key',
  baseUrl: 'https://gemini.example',
  model: 'gemini-test',
  videoPath: video,
  prompt: '看看这个视频',
  fetchImpl: async (url, init) => {
    geminiCalls.push({ url: String(url), init })
    if (String(url).endsWith('/upload/v1beta/files')) {
      return fakeResponse({ headers: { 'x-goog-upload-url': 'https://upload.example/session' } })
    }
    if (String(url) === 'https://upload.example/session') {
      return fakeResponse({ json: { file: { name: 'files/abc', uri: 'https://files.example/abc', state: 'ACTIVE' } } })
    }
    if (String(url).includes(':generateContent')) {
      return fakeResponse({ json: { candidates: [{ content: { parts: [{ text: '视频里有一张测试卡。' }] } }] } })
    }
    return fakeResponse({ json: {} })
  },
  sleepImpl: async () => {},
})
check('Gemini：拿回文字', gemini === '视频里有一张测试卡。')
check('Gemini：上传初始化带大小/类型/Key', (() => {
  const call = geminiCalls[0]
  return call?.url === 'https://gemini.example/upload/v1beta/files'
    && call.init.headers['x-goog-api-key'] === 'gemini-key'
    && call.init.headers['x-goog-upload-header-content-type'] === 'video/mp4'
    && Number(call.init.headers['x-goog-upload-header-content-length']) > 0
})())
check('Gemini：generateContent 带 file_data + prompt', (() => {
  const call = geminiCalls.find((entry) => entry.url.includes(':generateContent'))
  if (!call) return false
  const body = JSON.parse(call.init.body)
  const parts = body.contents[0].parts
  return parts.some((part) => part.file_data?.file_uri === 'https://files.example/abc')
    && parts.some((part) => part.text === '看看这个视频')
})())
check('Gemini：结束后尝试删除远端文件', geminiCalls.some((entry) => entry.init?.method === 'DELETE'))
let geminiNoKey = ''
try { await describeWithGemini({ apiKey: '', videoPath: video }) } catch (error) { geminiNoKey = error.message }
check('Gemini：没有 Key 直接报人话', geminiNoKey.includes('API Key'))

check('测试连接：local/command 不发网络请求', (await testVideoProvider({ provider: 'local' })).ok === true
  && (await testVideoProvider({ provider: 'command' })).ok === true)
let testQwenUrl = ''
let testQwenBody = null
const testQwen = await testVideoProvider({
  provider: 'qwen', apiKey: 'k', baseUrl: 'https://qwen.example/v1', model: 'qwen-test',
  fetchImpl: async (url, init) => {
    testQwenUrl = String(url)
    testQwenBody = JSON.parse(init.body)
    return fakeResponse({ json: { choices: [{ message: { content: 'OK' } }] } })
  },
})
check('测试连接：Qwen 走 chat/completions 并解析回复',
  testQwen.ok === true && testQwenUrl === 'https://qwen.example/v1/chat/completions' && testQwenBody.model === 'qwen-test', JSON.stringify(testQwen))
let testGeminiUrl = ''
let testGeminiKey = ''
const testGemini = await testVideoProvider({
  provider: 'gemini', apiKey: 'k', baseUrl: 'https://gemini.example/v1beta', model: 'gemini-test',
  fetchImpl: async (url, init) => {
    testGeminiUrl = String(url)
    testGeminiKey = init.headers['x-goog-api-key']
    return fakeResponse({ json: { candidates: [{ content: { parts: [{ text: 'OK' }] } }] } })
  },
})
check('测试连接：Gemini 去掉 /v1beta 并带 Key',
  testGemini.ok === true && testGeminiUrl === 'https://gemini.example/v1beta/models/gemini-test:generateContent' && testGeminiKey === 'k', testGeminiUrl)

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
