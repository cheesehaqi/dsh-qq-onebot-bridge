/**
 * 音频小工具：**试听时的移调**（只变音调、基本不变时长）。
 *
 * 为什么自己实现：Azure 有原生 SSML `prosody pitch`，OpenAI 与本地 GPT-SoVITS 都没有音调参数；
 * 而 ffmpeg 的 `asetrate/atempo` 滤镜**不是每个 ffmpeg 构建都有**（本机 LLBot 自带的就是精简版，
 * 只有 aresample）。所以这里：
 *   ① WAV（本地 GPT-SoVITS 常见输出）完全在 JS 里处理，不需要 ffmpeg；
 *   ② mp3（云端 TTS）只用 ffmpeg 做一次"解码成 PCM WAV"，不用任何滤镜 —— 精简版也能跑；
 *   ③ 变调用"重采样（改变音调与速度）+ WSOLA 时间伸缩（把时长拉回来）"，纯 JS，可单测。
 *
 * 精度预期：用于"听一下升/降几个半音"的调试预览，不是录音棚级变调。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 半音 → 频率倍率。 */
export function pitchFactor(semitones) {
  return Math.pow(2, Number(semitones) / 12)
}

/** 可变调的半音范围。 */
export const PITCH_MIN = -12
export const PITCH_MAX = 12

function runFfmpeg(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error) => (error ? reject(error) : resolve()))
  })
}

/**
 * 解析 16 位 PCM WAV（单/多声道）。只支持最常见的 16bit，其它位深给明确原因。
 * @returns {{ sampleRate:number, channels:number, samples:Float32Array }}
 */
export function decodeWav16(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw new Error('WAV 太短，解析不了')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV（没找到 RIFF/WAVE 头）')
  }
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size))
    if (id === 'fmt ') fmt = body
    else if (id === 'data') data = body
    offset += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data 块')
  const formatTag = fmt.readUInt16LE(0)
  const channels = fmt.readUInt16LE(2)
  const sampleRate = fmt.readUInt32LE(4)
  const bits = fmt.readUInt16LE(14)
  if (formatTag !== 1) throw new Error(`WAV 编码不是 PCM（format=${formatTag}），移调只支持 PCM`)
  if (bits !== 16) throw new Error(`WAV 位深是 ${bits}，移调只支持 16 位 PCM`)
  if (channels < 1 || sampleRate <= 0) throw new Error('WAV 头里的声道/采样率不合法')
  const frames = Math.floor(data.length / (channels * 2))
  const samples = new Float32Array(frames * channels)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2) / 32768
  }
  return { sampleRate, channels, samples }
}

/** 把 Float32 采样编码成 16 位 PCM WAV。 */
export function encodeWav16(samples, channels, sampleRate) {
  const frames = Math.floor(samples.length / channels)
  const data = Buffer.alloc(frames * channels * 2)
  for (let index = 0; index < frames * channels; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0))
    data.writeInt16LE(Math.round(value * 32767), index * 2)
  }
  const out = Buffer.alloc(44 + data.length)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + data.length, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(channels, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * channels * 2, 28)
  out.writeUInt16LE(channels * 2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(data.length, 40)
  data.copy(out, 44)
  return out
}

/** 线性插值重采样（factor > 1 = 变短、音调升高）。返回交错采样。 */
export function resampleLinear(samples, channels, factor) {
  const frames = Math.floor(samples.length / channels)
  const outFrames = Math.max(1, Math.floor(frames / factor))
  const out = new Float32Array(outFrames * channels)
  for (let frame = 0; frame < outFrames; frame += 1) {
    const src = frame * factor
    const left = Math.floor(src)
    const right = Math.min(frames - 1, left + 1)
    const t = src - left
    for (let channel = 0; channel < channels; channel += 1) {
      const a = samples[left * channels + channel] ?? 0
      const b = samples[right * channels + channel] ?? a
      out[frame * channels + channel] = a + (b - a) * t
    }
  }
  return out
}

/**
 * WSOLA 时间伸缩：把长度拉伸 rate 倍（rate > 1 = 变长），音调不变。
 * 做法：Hann 窗 + 50% 重叠；每一帧在"理想位置"附近按**上一帧的自然延续**做互相关对齐
 * （模板取上一帧起点 + hop 的那一段输入，而不是已叠加的输出——后者会把相位锁到半周期上，
 * 叠加时相互抵消，听起来像掉了一个八度）。
 */
export function timeStretchWsola(samples, channels, sampleRate, rate) {
  if (!(rate > 0)) throw new Error(`时间伸缩倍率不合法：${rate}`)
  const frames = Math.floor(samples.length / channels)
  const outFrames = Math.max(1, Math.round(frames * rate))
  const frame = Math.max(256, 2 * Math.round(sampleRate * 0.02)) // 40ms，偶数
  const hop = Math.floor(frame / 2)
  const overlap = frame - hop
  const search = Math.max(8, Math.round(sampleRate * 0.004))    // ±4ms
  const out = new Float32Array((outFrames + frame) * channels)
  const weight = new Float32Array(outFrames + frame)
  const window = new Float32Array(frame)
  for (let index = 0; index < frame; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / frame) // 周期 Hann：50% 重叠和 = 1
  }
  let outPos = 0
  let previousStart = null
  while (outPos < outFrames) {
    const ideal = Math.round(outPos / rate)
    let start = Math.max(0, Math.min(Math.max(0, frames - 1), ideal))
    if (previousStart !== null) {
      const templateStart = Math.min(Math.max(0, frames - 1), previousStart + hop)
      let best = -Infinity
      let bestStart = start
      const from = Math.max(0, ideal - search)
      const to = Math.min(Math.max(0, frames - 1), ideal + search)
      for (let candidate = from; candidate <= to; candidate += 1) {
        let dot = 0
        for (let index = 0; index < overlap; index += 1) {
          const a = samples[Math.min(frames - 1, candidate + index) * channels] ?? 0
          const b = samples[Math.min(frames - 1, templateStart + index) * channels] ?? 0
          dot += a * b
        }
        if (dot > best) { best = dot; bestStart = candidate }
      }
      start = bestStart
    }
    for (let index = 0; index < frame; index += 1) {
      const dst = outPos + index
      if (dst >= outFrames + frame) break
      const srcFrame = start + index
      const gain = window[index]
      for (let channel = 0; channel < channels; channel += 1) {
        const value = srcFrame < frames ? (samples[srcFrame * channels + channel] ?? 0) : 0
        out[dst * channels + channel] += value * gain
      }
      weight[dst] += gain
    }
    previousStart = start
    outPos += hop
  }
  const result = new Float32Array(outFrames * channels)
  for (let frameIndex = 0; frameIndex < outFrames; frameIndex += 1) {
    const w = weight[frameIndex]
    for (let channel = 0; channel < channels; channel += 1) {
      result[frameIndex * channels + channel] = w > 1e-6 ? out[frameIndex * channels + channel] / w : 0
    }
  }
  return result
}

/**
 * 对任意 WAV/MP3 做移调（保持时长）。
 * @returns {Promise<{ audio: Buffer, format: string }>}
 */
export async function shiftPitch({
  buffer, format = 'wav', semitones = 0, ffmpegPath = 'ffmpeg', tmpDir, run = runFfmpeg,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('音频是空的，没法移调')
  const value = Number(semitones)
  if (!Number.isFinite(value)) throw new Error(`音调必须是数字（收到 ${semitones}）`)
  if (value === 0) return { audio: buffer, format }
  if (value < PITCH_MIN || value > PITCH_MAX) {
    throw new Error(`音调必须在 ${PITCH_MIN}…${PITCH_MAX} 半音之间（收到 ${semitones}）`)
  }
  const factor = pitchFactor(value)

  // ① 拿到 PCM：WAV 直接解析；mp3 之类先用 ffmpeg 解码成 16 位 WAV（不用任何滤镜，精简版 ffmpeg 也能跑）
  let wav = buffer
  if (format !== 'wav') {
    if (!tmpDir) throw new Error('缺少临时目录（tmpDir），无法解码非 WAV 音频')
    mkdirSync(tmpDir, { recursive: true })
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const input = join(tmpDir, `pitch-${stamp}.${format === 'mp3' ? 'mp3' : 'bin'}`)
    const output = join(tmpDir, `pitch-${stamp}.wav`)
    writeFileSync(input, buffer)
    try {
      await run(ffmpegPath, ['-y', '-i', input, '-c:a', 'pcm_s16le', '-f', 'wav', output], { timeout: 60_000 })
      wav = readFileSync(output)
    } catch (error) {
      throw new Error(`移调需要先把音频解码成 WAV，但 ffmpeg 失败了：${String(error?.message ?? error).slice(0, 100)}`
        + '（可在设置里把 ffmpegPath 指向可用的 ffmpeg）')
    } finally {
      try { unlinkSync(input) } catch { /* best effort */ }
      try { unlinkSync(output) } catch { /* best effort */ }
    }
  }

  // ② 重采样改变音调（同时变快/变慢）→ ③ WSOLA 把时长拉回原样
  const { sampleRate, channels, samples } = decodeWav16(wav)
  const pitched = resampleLinear(samples, channels, factor)
  const restored = timeStretchWsola(pitched, channels, sampleRate, factor)
  return { audio: encodeWav16(restored, channels, sampleRate), format: 'wav' }
}
