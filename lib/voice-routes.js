/**
 * 宿主侧的「语音调试」路由（挂在 DSH 的 HTTP 服务上，由控制台代理调用）。
 *
 * 为什么住在宿主里：`sttProvider: dsh` 用的是**宿主进程内**的 `speechToText` 服务，
 * 控制台是独立进程，拿不到它；TTS 的密钥与本地 GPT-SoVITS 配置也只存在于插件的 config 里。
 * 所以这里只做三件很小的事：读状态、试合成一段、试转写一段（都不发 QQ）。
 *
 * 门禁：
 *   · 路由本身在宿主 3080 上，宿主已经要求 token；
 *   · 写操作再过一道 `sameSiteGuard`（拒绝跨站、只收 application/json）；
 *   · 音频请求体单独放大到 8 MB（默认 64 KB 装不下 3–10 秒录音）；TTS 只收 64 KB。
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkVoiceReadiness, synthesizeForTest, transcribeForTest, voiceStatus } from './voice.js'

const MAX_JSON_BYTES = 64 * 1024
/**
 * 录音/上传的音频走 base64：给 10 MB 上限。
 * 必须**比控制台那侧（9 MB 的请求体）更大**，否则 5–6 MB 的音频会在这里被判"太大"，
 * 用户看到的是"宿主说太大、控制台却说没问题"的矛盾提示。
 */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

/** 与面板路由同口径：用异步迭代读，真请求与单测里的假请求都能喂进来。 */
async function readJsonBody(request, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) return { __tooLarge: true }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try { return JSON.parse(text) } catch { return null }
}

/**
 * @param host       宿主上下文（`ctx.inject(['webServer'], …)` 拿到的那个）
 * @param options.config  运行中的插件配置（与 schema 同一个对象）
 * @param options.getService 取宿主服务：`() => host.get('speechToText')`
 * @param options.guard  `sameSiteGuard`（由 settings-routes 注入，避免两个模块循环 import）
 * @param options.fetchImpl / options.run / options.tmpDir  副作用注入（单测用）
 */
export function registerVoiceRoutes(host, options = {}) {
  const {
    config = {},
    getService = () => (typeof host.get === 'function' ? host.get('speechToText') : undefined),
    guard = () => ({ ok: true, reason: '' }),
    logger = { info() {}, warn() {}, error() {} },
    fetchImpl = fetch,
    run = undefined,
    tmpDir = '',
  } = options

  const workDir = () => tmpDir !== '' ? tmpDir : join(String(config.cwd ?? '').trim() || tmpdir(), 'qq-voice-debug')

  const handlers = {
    '/qqai/voice/status': (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      let hostService = false
      try { hostService = Boolean(getService()) } catch { hostService = false }
      sendJson(response, 200, { ok: true, ...voiceStatus(config, { hostService }) })
    },
    '/qqai/voice/tts': async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      const checked = guard(request)
      if (checked.ok !== true) { sendJson(response, 403, { ok: false, reason: checked.reason }); return }
      const body = await readJsonBody(request, MAX_JSON_BYTES)
      if (body === null) { sendJson(response, 400, { ok: false, reason: '请求体不是合法 JSON' }); return }
      if (body.__tooLarge === true) { sendJson(response, 413, { ok: false, reason: '请求体过大（TTS 文本上限 500 字，不该这么大）' }); return }
      try {
        const result = await synthesizeForTest({
          config,
          text: body.text,
          // 细调参数整包交给 voice.js 校验（越界直接报错，不悄悄夹紧）
          overrides: body.overrides && typeof body.overrides === 'object' ? body.overrides : {},
          // 兼容早期的平铺字段
          voice: String(body.voice ?? '').slice(0, 80),
          textLang: String(body.textLang ?? '').slice(0, 8),
          // 移调要落临时文件、跑 ffmpeg：目录与执行器都可注入（单测不跑真进程）
          tmpDir: workDir(),
          run,
          fetchImpl,
        })
        logger.info?.(`QQ助手 语音调试：TTS ${result.bytes} 字节（${result.ms}ms，${result.provider}）`)
        sendJson(response, 200, {
          ok: true,
          text: String(body.text ?? ''),
          provider: result.provider,
          format: result.format,
          bytes: result.bytes,
          ms: result.ms,
          voice: result.voice,
          textLang: result.textLang,
          params: result.params,
          audio: result.audio.toString('base64'),
        })
      } catch (error) {
        logger.warn?.(`QQ助手 语音调试：TTS 失败（${error?.message ?? error}）`)
        sendJson(response, 400, { ok: false, reason: String(error?.message ?? error) })
      }
    },
    '/qqai/voice/stt': async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      const checked = guard(request)
      if (checked.ok !== true) { sendJson(response, 403, { ok: false, reason: checked.reason }); return }
      const body = await readJsonBody(request, MAX_AUDIO_BYTES)
      if (body === null) { sendJson(response, 400, { ok: false, reason: '请求体不是合法 JSON' }); return }
      if (body.__tooLarge === true) { sendJson(response, 413, { ok: false, reason: `音频太大（请求体上限 ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB）` }); return }
      try {
        const result = await transcribeForTest({
          config,
          audioBase64: body.audioBase64,
          ext: String(body.ext ?? 'webm'),
          language: String(body.language ?? '').slice(0, 16),
          model: String(body.model ?? '').slice(0, 80),
          service: (() => { try { return getService() ?? null } catch { return null } })(),
          tmpDir: workDir(),
          run,
          fetchImpl,
        })
        logger.info?.(`QQ助手 语音调试：STT ${result.text.length} 字（${result.ms}ms，${result.provider}）`)
        sendJson(response, 200, {
          ok: true,
          text: result.text,
          provider: result.provider,
          language: result.language,
          model: result.model,
          bytes: result.bytes,
          wavBytes: result.wavBytes,
          ms: result.ms,
        })
      } catch (error) {
        logger.warn?.(`QQ助手 语音调试：STT 失败（${error?.message ?? error}）`)
        sendJson(response, 400, { ok: false, reason: String(error?.message ?? error) })
      }
    },
  }

  const disposers = []
  for (const [path, handler] of Object.entries(handlers)) {
    disposers.push(host.webServer.register({
      kind: 'exact',
      path,
      handler: (request, response) => {
        // handler 可能是 async：宿主要在返回的 promise 上等写完响应（与面板路由一致）
        try {
          return Promise.resolve(handler(request, response)).catch((error) => {
            sendJson(response, 500, { ok: false, reason: `语音调试失败：${error?.message ?? error}` })
          })
        } catch (error) {
          sendJson(response, 500, { ok: false, reason: `语音调试失败：${error?.message ?? error}` })
          return undefined
        }
      },
    }))
  }
  return disposers
}

export { checkVoiceReadiness, voiceStatus }
