/**
 * QQ 视频理解的本地抽帧器：只依赖 ffmpeg，不联网、不调 VLM。
 *
 * 产出：一组带时间戳的帧 + 每 12 帧一张联系表 + 音轨（供桥已有的 STT 转写）。
 * 具体把图交给哪个模型，由 bridge 决定；本模块只负责“把视频变成可看的证据”。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VIDEO_MAX_FRAMES = 24
export const VIDEO_CONTACT_SHEET_SIZE = 12

/** `/看视频` / `/video` 命令（允许后面跟问题）。 */
export function isVideoCommand(text) {
  return /^[\/／](?:看视频|video)(?:\s|$)/i.test(String(text ?? ''))
}

/**
 * 解析 `/看视频 0:30-0:45` / `/看视频 30-45秒` 的时间段。
 * 返回 null 表示“整段”；时间非法时返回 { error }，由调用方回人话。
 */
export function parseVideoRange(text) {
  const source = String(text ?? '').replace(/^[\/／](?:看视频|video)\s*/i, '')
  const clock = /(\d+):(\d{1,2})\s*(?:-|~|—|到|至)\s*(\d+):(\d{1,2})/.exec(source)
  if (clock) {
    const startMs = (Number(clock[1]) * 60 + Number(clock[2])) * 1000
    const endMs = (Number(clock[3]) * 60 + Number(clock[4])) * 1000
    if (endMs <= startMs) return { error: '结束时间必须晚于开始时间' }
    return { startMs, endMs, durationMs: endMs - startMs }
  }
  const seconds = /(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*(?:-|~|—|到|至)\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?/.exec(source)
  if (seconds) {
    const startMs = Math.round(Number(seconds[1]) * 1000)
    const endMs = Math.round(Number(seconds[2]) * 1000)
    if (endMs <= startMs) return { error: '结束时间必须晚于开始时间' }
    return { startMs, endMs, durationMs: endMs - startMs }
  }
  return null
}

/**
 * 谁可以触发视频理解：
 * - 私聊：直接发视频自动处理（acceptPrivate 必须不是 false）；
 * - 群聊：必须引用某条消息 + @机器人（引用里是不是视频由 bridge 再查）；
 * - 总开关 videoEnabled 关闭时一律不处理。
 */
export function planVideoRequest({ config = {}, message = {}, text = '', hasVideos = false } = {}) {
  const enabled = config.videoEnabled === true
  const privateAuto = enabled && config.acceptPrivate !== false && message.messageType === 'private' && hasVideos
  const quoted = enabled && Boolean(message.reply?.messageId) &&
    (message.messageType === 'private' || Boolean(message.atMe))
  return {
    enabled,
    command: isVideoCommand(text),
    privateAuto,
    quoted,
    request: privateAuto || quoted,
  }
}

/** 把 `node "D:\path\video-peek.mjs"` 拆成 argv；不经过 shell，避免注入。 */
export function splitCommandLine(line) {
  const parts = []
  const source = String(line ?? '')
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = re.exec(source)) !== null) {
    const value = match[1] ?? match[2] ?? match[3]
    if (value !== '') parts.push(value)
  }
  return parts
}

/**
 * 把 OneBot video 段落到 qq-videos/：支持 http(s) 与本机文件，先看大小再落盘。
 * 返回本地路径；不负责抽帧。
 */
export async function downloadVideoSource({
  raw,
  videoDir,
  maxBytes = 104_857_600,
  fetchImpl = globalThis.fetch,
  name = `qq-video-${Date.now().toString(36)}`,
} = {}) {
  const value = String(raw ?? '').trim()
  if (value === '') throw new Error('视频没有可下载的 url/file')
  const limit = Math.max(1, Number(maxBytes) || 104_857_600)
  mkdirSync(videoDir, { recursive: true })
  const extMatch = /\.(mp4|mov|webm|mkv|avi|flv|m4v)(?:[?#]|$)/i.exec(value)
  const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : '.mp4'
  const target = join(videoDir, `${name}${ext}`)
  if (/^https?:\/\//i.test(value)) {
    if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch，下载不了视频')
    const response = await fetchImpl(value, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`视频下载 HTTP ${response.status}`)
    const length = Number(response.headers.get('content-length') || 0)
    if (length > limit) throw new Error(`视频太大（${(length / 1024 / 1024).toFixed(1)} MB，上限 ${(limit / 1024 / 1024).toFixed(0)} MB）`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0) throw new Error('视频下载为空')
    if (buffer.length > limit) throw new Error(`视频太大（${(buffer.length / 1024 / 1024).toFixed(1)} MB，上限 ${(limit / 1024 / 1024).toFixed(0)} MB）`)
    writeFileSync(target, buffer)
    return target
  }
  const source = /^file:\/\//i.test(value) ? fileURLToPath(value) : resolve(value)
  if (!existsSync(source)) throw new Error(`视频文件不存在：${source}`)
  const info = statSync(source)
  if (info.isFile() !== true) throw new Error(`视频不是文件：${source}`)
  if (info.size > limit) throw new Error(`视频太大（${(info.size / 1024 / 1024).toFixed(1)} MB，上限 ${(limit / 1024 / 1024).toFixed(0)} MB）`)
  writeFileSync(target, readFileSync(source))
  return target
}

export function parseVideoProbe(stderr) {
  const text = String(stderr ?? '')
  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  if (!durationMatch) return { ok: false, reason: 'ffmpeg 输出里没有 Duration（可能不是可读的视频）' }
  const durationMs = Math.round(
    (Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])) * 1000,
  )
  const videoLine = text.split(/\r?\n/).find((line) => /Stream #\d+:\d+.*: Video:/.test(line)) ?? ''
  const sizeMatch = /(\d{2,5})x(\d{2,5})/.exec(videoLine)
  const fpsMatch = /([\d.]+)\s*fps/.exec(videoLine)
  const codecMatch = /Video:\s*([^,\s]+)/.exec(videoLine)
  return {
    ok: true,
    durationMs,
    width: sizeMatch ? Number(sizeMatch[1]) : 0,
    height: sizeMatch ? Number(sizeMatch[2]) : 0,
    fps: fpsMatch ? Number(fpsMatch[1]) : 0,
    videoCodec: codecMatch ? codecMatch[1] : '',
    hasAudio: /Stream #\d+:\d+.*: Audio:/.test(text),
  }
}

export function videoFrameTimes({ durationMs, frames = 12, startMs = 0 } = {}) {
  const span = Number(durationMs)
  const count = Math.max(2, Math.min(VIDEO_MAX_FRAMES, Math.floor(Number(frames) || 12)))
  if (!Number.isFinite(span) || span <= 0) throw new Error('视频时长无效，抽不了帧')
  const start = Math.max(0, Number(startMs) || 0)
  if (start >= span) throw new Error('--start 已经超过视频时长')
  const step = (span - start) / count
  return Array.from({ length: count }, (_item, index) => Math.round(start + index * step))
}

function run(ffmpeg, args, { timeout = 120_000 } = {}) {
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw new Error(`执行 ffmpeg 失败：${result.error.message}`)
  if (result.status !== 0) {
    const tail = String(result.stderr ?? '').trim().split(/\r?\n/).slice(-4).join(' | ')
    throw new Error(`ffmpeg 退出码 ${result.status}：${tail || '没有输出'}`)
  }
  return result
}

/**
 * @returns {{ok:true,durationMs:number,analyzedMs:number,width:number,height:number,fps:number,
 *   hasAudio:boolean,frames:Array<{atMs:number,path:string}>,contactSheets:string[],audioFile:string,warnings:string[]}}
 */
export function analyzeVideo({
  input,
  outDir,
  ffmpegPath = 'ffmpeg',
  frames = 12,
  maxSeconds = 30,
  width = 960,
  startMs = 0,
  durationMs = null,
} = {}) {
  if (!input || !existsSync(input)) throw new Error(`视频文件不存在：${input}`)
  const stat = statSync(input)
  if (stat.isFile() !== true) throw new Error(`不是文件：${input}`)
  const probeResult = spawnSync(ffmpegPath, ['-hide_banner', '-i', input], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  })
  const probe = parseVideoProbe(`${probeResult.stderr ?? ''}\n${probeResult.stdout ?? ''}`)
  if (!probe.ok) throw new Error(probe.reason)
  const limitMs = Math.max(1, Number(maxSeconds) || 30) * 1000
  const start = Math.max(0, Math.round(Number(startMs) || 0))
  if (start >= probe.durationMs) throw new Error('开始时间超过视频时长')
  const wantedMs = durationMs === null ? limitMs : Math.max(1, Math.round(Number(durationMs) || 0))
  const analyzedMs = Math.min(probe.durationMs - start, wantedMs)
  if (analyzedMs <= 0) throw new Error('视频时长不足，抽不了帧')
  const times = videoFrameTimes({ durationMs: start + analyzedMs, frames, startMs: start })

  const framesDir = join(outDir, 'frames')
  mkdirSync(framesDir, { recursive: true })
  const scaleWidth = Math.max(160, Math.floor(Number(width) || 960))
  const warnings = []
  const frameFiles = []
  for (let index = 0; index < times.length; index += 1) {
    const at = times[index]
    const file = join(framesDir, `frame-${String(index + 1).padStart(3, '0')}.jpg`)
    run(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', (at / 1000).toFixed(3), '-i', input,
      '-frames:v', '1', '-vf', `scale='min(${scaleWidth},iw)':-2`, '-q:v', '3', file,
    ])
    frameFiles.push({ atMs: at, path: file })
  }

  const contactSheets = []
  for (let start = 0; start < frameFiles.length; start += VIDEO_CONTACT_SHEET_SIZE) {
    const sheet = join(outDir, `contact-sheet-${String(Math.floor(start / VIDEO_CONTACT_SHEET_SIZE) + 1).padStart(2, '0')}.jpg`)
    run(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-framerate', '1', '-start_number', String(start + 1), '-i', join(framesDir, 'frame-%03d.jpg'),
      '-vf', 'scale=320:-1,tile=4x3:padding=4:margin=4', '-frames:v', '1', sheet,
    ])
    contactSheets.push(sheet)
  }

  let audioFile = ''
  if (probe.hasAudio) {
    try {
      audioFile = join(outDir, 'audio.wav')
      run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', (start / 1000).toFixed(3), '-i', input, '-t', (analyzedMs / 1000).toFixed(3), '-vn', '-ac', '1', '-ar', '16000', audioFile])
    } catch (error) {
      warnings.push(`抽取音轨失败：${error.message}`)
      audioFile = ''
    }
  }

  return {
    ok: true,
    durationMs: probe.durationMs,
    startMs: start,
    analyzedMs,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    videoCodec: probe.videoCodec,
    hasAudio: probe.hasAudio,
    frames: frameFiles,
    contactSheets,
    audioFile,
    warnings,
  }
}

/** 供 trace / 回复用的简短摘要（不含画面内容）。 */
export function summarizeVideo(analysis, { maxSeconds = 30 } = {}) {
  if (!analysis || analysis.ok !== true) return '视频分析失败'
  const seconds = (analysis.analyzedMs / 1000).toFixed(1)
  const timeline = analysis.frames.map((frame) => `${(frame.atMs / 1000).toFixed(1)}s`).join(', ')
  const truncated = analysis.analyzedMs < analysis.durationMs ? `（原片 ${(analysis.durationMs / 1000).toFixed(1)}s，只分析前 ${(analysis.analyzedMs / 1000).toFixed(1)}s）` : ''
  return `视频 ${seconds}s · ${analysis.width}×${analysis.height} · ${analysis.frames.length} 帧${truncated}\n时间点：${timeline}`
}

export function writeVideoManifest(outDir, analysis) {
  if (!outDir) return ''
  const file = join(outDir, 'manifest.json')
  writeFileSync(file, JSON.stringify(analysis, null, 2), 'utf8')
  return file
}
