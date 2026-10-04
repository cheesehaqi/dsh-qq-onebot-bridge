/**
 * 语音转文字：走 **DSH 自带的**语音服务（本地 SenseVoice），不把音频发到任何云端。
 *
 * DSH 0.2.0-rc.2 的实验性「语音输入」bundle 提供宿主服务 `speechToText`：
 *   resolve({ audio, language, providerId? }) -> spec
 *   transcribe(spec, signal) -> { text, audioSeconds, inferenceSeconds }
 * 其中 audio 必须是 **16 kHz 单声道 PCM16 WAV**（平台用 validateWave 校验），所以我们统一用 ffmpeg 转一道，
 * 不赌 QQ/NapCat 给的格式（silk / amr / 任意采样率的 wav 都见过）。
 *
 * 这个文件不碰全局状态、不自己 spawn 进程（ffmpeg 调用通过 `run` 注入），所以单测可以直接喂假数据。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** DSH 语音服务在宿主里的服务名（cordis service id）。 */
export const DSH_SPEECH_SERVICE = 'speechToText'

/** 这个功能的默认语言：auto = 让 SenseVoice 自己判（中英混说也稳）。 */
export const DEFAULT_STT_LANGUAGE = 'auto'

/**
 * 检查一段字节是不是"16 kHz 单声道 PCM16 WAV"——DSH 那边会用同一个标准校验，
 * 我们在本地先看一眼，能给出比"provider 报错"更好懂的原因。
 * @param {Buffer} buffer
 * @returns {{ ok: boolean, reason?: string, sampleRate?: number, channels?: number, bits?: number }}
 */
export function inspectWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 46) return { ok: false, reason: '音频太短，不像是完整录音' }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, reason: '不是 WAV（没找到 RIFF/WAVE 头）' }
  }
  // 下面逐条对齐平台的 validateWave：它是**严格**检查（不做块遍历），
  // 所以这里也必须严格，否则会出现"本地过了、平台抛 Invalid speech WAV"（2026-10-04 真机事故）。
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') return { ok: false, reason: 'WAV 头不规范：fmt 块不在偏移 12' }
  if (buffer.readUInt32LE(16) !== 16) return { ok: false, reason: 'WAV 头不规范：fmt 块长度不是 16' }
  if (buffer.readUInt16LE(20) !== 1) return { ok: false, reason: 'WAV 不是 PCM 编码' }
  const channels = buffer.readUInt16LE(22)
  if (channels !== 1) return { ok: false, reason: `声道数 ${channels}，需要单声道`, channels }
  const sampleRate = buffer.readUInt32LE(24)
  if (sampleRate !== 16000) return { ok: false, reason: `采样率 ${sampleRate}，需要 16000`, sampleRate }
  if (buffer.readUInt32LE(28) !== 32000) return { ok: false, reason: 'WAV 字节率不是 32000（16kHz×单声道×16 位）' }
  if (buffer.readUInt16LE(32) !== 2) return { ok: false, reason: 'WAV 块对齐不是 2' }
  const bits = buffer.readUInt16LE(34)
  if (bits !== 16) return { ok: false, reason: `位深 ${bits}，需要 16 位`, bits }
  if (buffer.toString('ascii', 36, 40) !== 'data') {
    return { ok: false, reason: 'WAV 的 data 块不在偏移 36（多半多了元数据块，例如 ffmpeg 默认写的 LIST）' }
  }
  if (buffer.readUInt32LE(4) !== buffer.length - 8) return { ok: false, reason: 'WAV 的 RIFF 长度与文件长度不一致' }
  if (buffer.readUInt32LE(40) !== buffer.length - 44) return { ok: false, reason: 'WAV 的 data 长度与文件长度不一致' }
  if ((buffer.length - 44) % 2 !== 0) return { ok: false, reason: 'WAV 的音频数据长度是奇数' }
  return { ok: true, channels, sampleRate, bits }
}

/**
 * 把任意 WAV 重写成**规范形态**：44 字节头 + 音频数据（`fmt ` 在 12、`data` 必须在 36）。
 *
 * 为什么自己来做：ffmpeg 默认会写 `LIST/INFO` 元数据块，`data` 的偏移就不是 36，
 * 平台的校验会直接抛 `Invalid speech WAV`。不管 ffmpeg 怎么写，这里都只抽 fmt + data 并按规范重建。
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function canonicalizeWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw new Error('音频太短，不像是完整录音')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV（没找到 RIFF/WAVE 头）')
  }
  let fmt = null
  let data = null
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size))
    if (id === 'fmt ') fmt = body
    else if (id === 'data') data = body
    offset += 8 + size + (size % 2)
  }
  if (!fmt) throw new Error('WAV 里没有 fmt 块')
  if (!data || data.length === 0) throw new Error('WAV 里没有音频数据（data 块是空的）')
  if (fmt.length < 16) throw new Error('WAV 的 fmt 块不完整')
  if (fmt.readUInt16LE(0) !== 1) throw new Error('WAV 不是 PCM 编码，转写只接受 PCM16')
  const channels = fmt.readUInt16LE(2)
  const sampleRate = fmt.readUInt32LE(4)
  const bits = fmt.readUInt16LE(14)
  if (channels !== 1 || sampleRate !== 16000 || bits !== 16) {
    throw new Error(`WAV 规格不对（声道 ${channels} / 采样率 ${sampleRate} / 位深 ${bits}），需要 16kHz 单声道 16 位`)
  }
  // 平台要求音频数据长度为偶数；多出半个字节就截掉。
  const pcm = data.length % 2 === 0 ? data : data.subarray(0, data.length - 1)
  const out = Buffer.alloc(44 + pcm.length)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + pcm.length, 4)
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
  out.writeUInt32LE(pcm.length, 40)
  pcm.copy(out, 44)
  return out
}

/** 默认的 ffmpeg 执行器（可注入，方便单测）。 */
function runFfmpeg(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error) => (error ? reject(error) : resolve()))
  })
}

/**
 * 把任意音频转成 16 kHz 单声道 PCM16 WAV。
 * @param {object} options
 * @param {Buffer} options.buffer 原始音频
 * @param {string} [options.ext] 原始扩展名（决定临时文件名，ffmpeg 主要靠内容嗅探）
 * @param {string} [options.ffmpegPath]
 * @param {string} options.tmpDir 临时文件目录（必须已存在或可创建）
 * @param {Function} [options.run] 执行器（默认 execFile 的 Promise 包装）
 * @returns {Promise<Buffer>}
 */
export async function toWav16k({ buffer, ext = 'amr', ffmpegPath = 'ffmpeg', tmpDir, run = runFfmpeg }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('语音内容是空的，没法转写')
  mkdirSync(tmpDir, { recursive: true })
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const input = join(tmpDir, `stt-${stamp}.${String(ext || 'amr').replace(/[^a-z0-9]/gi, '') || 'amr'}`)
  const output = join(tmpDir, `stt-${stamp}.wav`)
  writeFileSync(input, buffer)
  try {
    // 关键：`-map_metadata -1` 与 `-fflags +bitexact` 都是**输出侧**选项，必须放在 `-i` 之后！
    // （2026-10-04 真机事故：我一开始放在 -i 前，ffmpeg 直接 Command failed —— 输入选项里没有它们。）
    // 作用是别让 ffmpeg 写 LIST/INFO 元数据块（那会让 data 偏移不是 36，平台判 Invalid speech WAV）；
    // 即便它还是写了，下面 canonicalizeWav 也会兜住。
    await run(ffmpegPath, ['-y', '-i', input,
      '-map_metadata', '-1', '-fflags', '+bitexact',
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output], { timeout: 60_000 })
    // 规范化失败（例如 ffmpeg 产物规格不对）也要用同一个前缀报出来，调用方/测试看的是这句。
    let wav
    try {
      wav = canonicalizeWav(readFileSync(output))
    } catch (error) {
      throw new Error(`转出来的音频不符合要求：${String(error?.message ?? error)}`)
    }
    const check = inspectWav(wav)
    if (!check.ok) throw new Error(`转出来的音频不符合要求：${check.reason}`)
    return wav
  } catch (error) {
    if (String(error?.message ?? '').includes('不符合要求')) throw error
    throw new Error(`ffmpeg 转 16kHz WAV 失败：${String(error?.message ?? error).slice(0, 90)}`)
  } finally {
    try { unlinkSync(input) } catch { /* best effort */ }
    try { unlinkSync(output) } catch { /* best effort */ }
  }
}

/**
 * 用 DSH 自带的语音服务转写。
 * @param {object} options
 * @param {object|undefined} options.service 宿主服务（`ctx.get('speechToText')`）
 * @param {Buffer} options.wav 16 kHz 单声道 PCM16 WAV
 * @param {string} [options.language]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} 转写文本
 */
export async function transcribeViaDsh({ service, wav, language = DEFAULT_STT_LANGUAGE, signal }) {
  if (!service || typeof service.resolve !== 'function' || typeof service.transcribe !== 'function') {
    throw new Error('DSH 的语音转文字没启用：请把 @deepseek-ai/dsh-experimental-voice-input-bundle 加进 profile 的 bundles 并重启')
  }
  const check = inspectWav(wav)
  if (!check.ok) throw new Error(`音频不符合 DSH 语音服务的要求：${check.reason}`)
  const spec = service.resolve({ audio: new Uint8Array(wav), language })
  const transcript = await service.transcribe(spec, signal ?? AbortSignal.timeout(120_000))
  const text = String(transcript?.text ?? '').trim()
  if (text === '') throw new Error('DSH 语音服务返回了空文本（可能是录音太短或没人说话）')
  return text
}

/** 把 DSH 语音服务的异常翻译成用户看得懂的中文原因。 */
export function explainDshError(error) {
  const message = String(error?.message ?? error)
  if (/download|prepare|preparation|model/i.test(message)) {
    return `首次使用要下载本地语音模型：${message.slice(0, 80)}`
  }
  if (/unavailable|not registered|unknown provider/i.test(message)) {
    return `DSH 里没有可用的本地识别提供方（检查 profile 是否装了 speech-to-text-sensevoice）：${message.slice(0, 60)}`
  }
  if (/language/i.test(message)) return `这个语言 DSH 的本地识别不支持：${message.slice(0, 60)}`
  return `DSH 语音转文字失败：${message.slice(0, 90)}`
}
