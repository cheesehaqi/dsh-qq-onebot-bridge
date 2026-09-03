/** Unit tests for image-gen request builders and response parsing (no network). */
import { buildOpenaiImageRequest, parseOpenaiImageResponse, buildLocalTxt2ImgRequest } from '../lib/imagegen.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// OpenAI-compatible request
const req = buildOpenaiImageRequest({ imageGenModel: 'cogview-3-flash', imageGenSize: '1024x1024' }, '一只蓝鲸在星空下')
check('openai 请求含 prompt', req.prompt === '一只蓝鲸在星空下', JSON.stringify(req))
check('openai 请求用指定 model', req.model === 'cogview-3-flash')
check('openai 请求 size/单张', req.size === '1024x1024' && req.n === 1)
check('openai 请求 b64_json', req.response_format === 'b64_json')

const reqDefault = buildOpenaiImageRequest({}, '测试')
check('openai 缺省 model gpt-image-1', reqDefault.model === 'gpt-image-1' && reqDefault.size === '1024x1024')

// Response parsing: b64_json path
const parsed = parseOpenaiImageResponse({ data: [{ b64_json: Buffer.from('hello').toString('base64') }] })
check('b64 响应解析 buffer', parsed.buffer instanceof Buffer && parsed.buffer.toString() === 'hello')
check('b64 响应 format png', parsed.format === 'png')

// Response parsing: url path
const parsedUrl = parseOpenaiImageResponse({ data: [{ url: 'https://cdn.example.com/img.png' }] })
check('url 响应解析', parsedUrl.url === 'https://cdn.example.com/img.png')

// Response parsing: invalid
let threw = false
try { parseOpenaiImageResponse({ data: [] }) } catch { threw = true }
check('空 data 抛错', threw)
threw = false
try { parseOpenaiImageResponse({ data: [{}] }) } catch { threw = true }
check('无内容字段抛错', threw)

// Local SD WebUI request
const local = buildLocalTxt2ImgRequest({ imageGenSize: '768x512', imageGenSteps: 30, imageGenCfgScale: 8.5, imageGenSampler: 'DPM++ 2M Karras' }, 'test prompt')
check('local 请求尺寸拆分', local.width === 768 && local.height === 512, JSON.stringify(local))
check('local 请求步数/CFG', local.steps === 30 && local.cfg_scale === 8.5)
check('local 请求采样器', local.sampler_name === 'DPM++ 2M Karras')

const localDefault = buildLocalTxt2ImgRequest({}, 'p')
check('local 缺省 512x512/20/7', localDefault.width === 512 && localDefault.height === 512 && localDefault.steps === 20 && localDefault.cfg_scale === 7)

const localBad = buildLocalTxt2ImgRequest({ imageGenSize: 'invalid', imageGenSteps: 0, imageGenCfgScale: 0 }, 'p')
check('local 非法参数兜底', localBad.width === 512 && localBad.height === 512 && localBad.steps === 20 && localBad.cfg_scale === 7)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
