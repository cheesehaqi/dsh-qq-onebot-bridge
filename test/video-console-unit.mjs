/**
 * 控制台「视频理解」栏的只读数据源：从 qq-videos/peek-* 的 manifest 汇总，
 * 不返回视频/图片内容。纯文件读取，不启动宿主。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSupervisor } from '../control/lib/supervisor.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS', name, extra) }
  else { failed += 1; console.log('FAIL', name, extra) }
}

const cwd = mkdtempSync(join(tmpdir(), 'qq-video-console-'))
const supervisor = createSupervisor({ cwd, ports: {}, logs: {} }, { now: () => 1_700_000_000_000 })

const empty = supervisor.video({ limit: 10 })
check('视频栏：目录不存在时返回 missing 而不是报错', empty.ok === true && empty.missing === true && empty.analyses.length === 0, JSON.stringify(empty))

mkdirSync(join(cwd, 'qq-videos', 'peek-a'), { recursive: true })
writeFileSync(join(cwd, 'qq-videos', 'peek-a', 'contact-sheet-01.jpg'), 'fake-jpeg', 'utf8')
writeFileSync(join(cwd, 'qq-videos', 'peek-a', 'frame-001.jpg'), 'fake-frame', 'utf8')
writeFileSync(join(cwd, 'qq-videos', 'peek-a', 'transcript.txt'), '测试转写', 'utf8')
writeFileSync(join(cwd, 'qq-videos', 'peek-a', 'manifest.json'), JSON.stringify({
  durationMs: 47_770,
  startMs: 0,
  analyzedMs: 30_000,
  width: 1920,
  height: 1080,
  frames: [{ atMs: 0, path: 'frame-001.jpg' }, { atMs: 3000, path: 'frame-002.jpg' }],
  contactSheets: ['contact-sheet-01.jpg'],
  audioFile: 'audio.wav',
  transcriptFile: 'transcript.txt',
}), 'utf8')
mkdirSync(join(cwd, 'qq-videos', 'peek-b'), { recursive: true })
writeFileSync(join(cwd, 'qq-videos', 'peek-b', 'manifest.json'), '{broken', 'utf8')
writeFileSync(join(cwd, 'qq-videos', 'not-a-peek', ''), '', 'utf8')

const result = supervisor.video({ limit: 10 })
check('视频栏：只收 peek-* 且坏 manifest 跳过', result.ok === true && result.total === 2 && result.analyses.length === 1, JSON.stringify({ total: result.total, analyses: result.analyses.length }))
const item = result.analyses[0]
check('视频栏：返回帧数/联系表/音轨/转写计数', item.frames === 2 && item.sheets === 1 && item.hasAudio === true && item.hasTranscript === true, JSON.stringify(item))
check('视频栏：返回原片与区间信息', item.durationMs === 47_770 && item.analyzedMs === 30_000 && item.width === 1920 && item.height === 1080, JSON.stringify(item))
const limited = supervisor.video({ limit: 1 })
check('视频栏：limit 生效', limited.analyses.length === 1 && limited.total === 2)

const detail = supervisor.videoDetail({ id: 'peek-a' })
check('视频详情：返回联系表/帧/转写', detail.ok === true && detail.contactSheets[0] === 'contact-sheet-01.jpg'
  && detail.frames.includes('frame-001.jpg') && detail.transcript === '测试转写', JSON.stringify(detail))
const asset = supervisor.videoAsset({ id: 'peek-a', file: 'contact-sheet-01.jpg' })
check('视频预览：只放行 manifest 里的图片', asset.ok === true && asset.contentType === 'image/jpeg' && existsSync(asset.path))
const traversal = supervisor.videoAsset({ id: '../peek-a', file: 'contact-sheet-01.jpg' })
check('视频预览：拒绝路径穿越 id', traversal.ok === false, JSON.stringify(traversal))
const notListed = supervisor.videoAsset({ id: 'peek-a', file: 'secret.jpg' })
check('视频预览：拒绝 manifest 外的文件', notListed.ok === false, JSON.stringify(notListed))
const deleted = supervisor.videoDelete({ id: 'peek-a' })
check('视频删除：移入回收目录而不是永久删', deleted.ok === true && Boolean(deleted.movedTo)
  && !existsSync(join(cwd, 'qq-videos', 'peek-a')) && existsSync(deleted.movedTo), JSON.stringify(deleted))

rmSync(cwd, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
