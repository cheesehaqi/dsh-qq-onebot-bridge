/**
 * QQ 视频抽帧器单测：探测解析、帧时间、摘要，以及真实 ffmpeg 的最小集成。
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { analyzeVideo, downloadVideoSource, isVideoCommand, parseVideoProbe, parseVideoRange, planVideoRequest, splitCommandLine, summarizeVideo, videoFrameTimes, writeVideoManifest } from '../lib/video.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS', name, extra) }
  else { failed += 1; console.log('FAIL', name, extra) }
}

const probeText = `
  Duration: 00:00:06.20, start: 0.000000, bitrate: 500 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 640x360, 25 fps, 25 tbr
  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s
`
const probe = parseVideoProbe(probeText)
check('探测：时长/分辨率/fps/音轨', probe.ok && probe.durationMs === 6200 && probe.width === 640 && probe.height === 360 && probe.fps === 25 && probe.hasAudio === true, JSON.stringify(probe))
check('帧时间：均匀且不取末尾', JSON.stringify(videoFrameTimes({ durationMs: 10_000, frames: 5 })) === JSON.stringify([0, 2000, 4000, 6000, 8000]))
check('帧时间：数量夹在 2–24', videoFrameTimes({ durationMs: 1000, frames: 1 }).length === 2 && videoFrameTimes({ durationMs: 1000, frames: 99 }).length === 24)
check('摘要：只含时间线/尺寸，不含画面文本', (() => {
  const summary = summarizeVideo({ ok: true, analyzedMs: 6000, durationMs: 10_000, width: 640, height: 360, frames: [{ atMs: 0 }, { atMs: 3000 }] }, { maxSeconds: 30 })
  return summary.includes('6.0s') && summary.includes('640×360') && summary.includes('原片 10.0s')
})())
check('命令：识别 /看视频 与 /video', isVideoCommand('/看视频 这段讲了什么') && isVideoCommand('/video') && !isVideoCommand('看视频'))
const rangeClock = parseVideoRange('/看视频 0:30-0:45')
check('时间段：0:30-0:45', rangeClock && rangeClock.startMs === 30_000 && rangeClock.endMs === 45_000 && rangeClock.durationMs === 15_000, JSON.stringify(rangeClock))
const rangeSeconds = parseVideoRange('/看视频 30-45秒 这段在干嘛')
check('时间段：30-45秒 + 问题', rangeSeconds && rangeSeconds.startMs === 30_000 && rangeSeconds.endMs === 45_000, JSON.stringify(rangeSeconds))
check('时间段：倒序直接报错', Boolean(parseVideoRange('/看视频 45-30')?.error))
check('时间段：没写就是整段', parseVideoRange('/看视频 这讲了什么') === null)
const enabled = { videoEnabled: true }
check('策略：私聊视频自动处理', planVideoRequest({ config: enabled, message: { messageType: 'private', userId: 1 }, hasVideos: true }).request === true)
check('策略：私聊关闭 acceptPrivate 不自动', planVideoRequest({ config: { ...enabled, acceptPrivate: false }, message: { messageType: 'private', userId: 1 }, hasVideos: true }).request === false)
check('策略：群聊未引用不处理', planVideoRequest({ config: enabled, message: { messageType: 'group', groupId: 1, atMe: true }, text: '看这个', hasVideos: true }).request === false)
check('策略：群聊引用 + @ 才处理', planVideoRequest({ config: enabled, message: { messageType: 'group', groupId: 1, atMe: true, reply: { messageId: '9' } }, text: '这是什么', hasVideos: true }).request === true)
check('策略：群聊引用但没 @ 不处理', planVideoRequest({ config: enabled, message: { messageType: 'group', groupId: 1, atMe: false, reply: { messageId: '9' } }, hasVideos: true }).request === false)
check('策略：总开关关闭一律不处理', planVideoRequest({ config: { videoEnabled: false }, message: { messageType: 'private', userId: 1, reply: { messageId: '9' } }, hasVideos: true }).request === false)
check('外部命令：带空格的路径不经过 shell 拆分', JSON.stringify(splitCommandLine('node "D:\\a b\\video-peek.mjs" --flag')) === JSON.stringify(['node', 'D:\\a b\\video-peek.mjs', '--flag']))

// 下载/落盘（本机文件，不联网）
const mediaDir = mkdtempSync(join(tmpdir(), 'qq-video-dl-'))
const source = join(mediaDir, 'source.mp4')
writeFileSync(source, Buffer.alloc(2048, 7))
const copied = await downloadVideoSource({ raw: source, videoDir: join(mediaDir, 'videos'), maxBytes: 4096, name: 'copy' })
check('下载：本机文件复制到 qq-videos', existsSync(copied) && statSync(copied).size === 2048)
let tooBig = ''
try { await downloadVideoSource({ raw: source, videoDir: join(mediaDir, 'videos2'), maxBytes: 1024, name: 'big' }) } catch (error) { tooBig = error.message }
check('下载：超过上限直接拒绝', tooBig.includes('视频太大'))
let noSource = ''
try { await downloadVideoSource({ raw: '', videoDir: join(mediaDir, 'videos3') }) } catch (error) { noSource = error.message }
check('下载：空地址报明确原因', noSource.includes('没有可下载'))
rmSync(mediaDir, { recursive: true, force: true })

const ffmpegCandidates = [process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean)
const ffmpeg = ffmpegCandidates.find((candidate) => {
  const result = spawnSync(candidate, ['-version'], { encoding: 'utf8', windowsHide: true })
  return result.status === 0
})
if (!ffmpeg) {
  console.log('SKIP 真实 ffmpeg 集成（未找到 ffmpeg）')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'qq-video-'))
  const input = join(dir, 'sample.mp4')
  const generated = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '4', '-pix_fmt', 'yuv420p', input,
  ], { encoding: 'utf8', windowsHide: true })
  check('集成：生成带音轨测试视频', generated.status === 0 && existsSync(input), String(generated.stderr ?? '').slice(0, 100))
  if (existsSync(input)) {
    const analysis = analyzeVideo({ input, outDir: join(dir, 'out'), ffmpegPath: ffmpeg, frames: 4, maxSeconds: 30, width: 320 })
    check('集成：抽到 4 帧', analysis.frames.length === 4 && analysis.frames.every((frame) => existsSync(frame.path)))
    check('集成：联系表/音轨落盘', analysis.contactSheets.length === 1 && existsSync(analysis.contactSheets[0]) && Boolean(analysis.audioFile) && existsSync(analysis.audioFile))
    check('集成：manifest 可写', Boolean(writeVideoManifest(join(dir, 'out'), analysis)) && existsSync(join(dir, 'out', 'manifest.json')))
    check('集成：摘要不含帧路径', !summarizeVideo(analysis).includes('frames'))
    const ranged = analyzeVideo({ input, outDir: join(dir, 'ranged'), ffmpegPath: ffmpeg, frames: 3, startMs: 1000, durationMs: 2000, width: 320 })
    check('集成：按时间段抽帧', ranged.analyzedMs === 2000 && ranged.frames.every((frame) => frame.atMs >= 1000 && frame.atMs < 3000), JSON.stringify(ranged.frames.map((frame) => frame.atMs)))
    check('集成：按时间段音轨落盘', Boolean(ranged.audioFile) && existsSync(ranged.audioFile))
  }
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
