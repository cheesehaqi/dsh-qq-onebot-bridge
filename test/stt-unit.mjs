/**
 * 语音转文字（DSH 自带那条路）单测。
 *
 * 用户口径（2026-10-04）：**DSH 自带语音转文字，默认就该走它、不外发**。
 * 这里把"默认走本地"、"没有服务时给中文原因"、"音频必须转成 16kHz 单声道 WAV"、
 * "云端那条路仍然可用"这几件事钉死。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import {
  DEFAULT_STT_LANGUAGE, DSH_SPEECH_SERVICE, canonicalizeWav, explainDshError, inspectWav, toWav16k, transcribeViaDsh,
} from '../lib/stt.js'
import { Config } from '../lib/index.js'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed += 1; console.log(`PASS ${name}${extra ? '  ' + extra : ''}`) } else { failed += 1; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`) }
}

/** 造一个合法的 16kHz 单声道 PCM16 WAV。 */
const makeWav = (seconds = 0.2, sampleRate = 16000, channels = 1, bits = 16) => {
  const frames = Math.max(1, Math.round(seconds * sampleRate))
  const dataBytes = frames * channels * (bits / 8)
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * (bits / 8), 28)
  buffer.writeUInt16LE(channels * (bits / 8), 32)
  buffer.writeUInt16LE(bits, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  return buffer
}

// ---- 1. 配置默认值：默认走 DSH、不外发 ----
check('sttProvider 默认是 dsh（本地识别，不外发）', Config.dict.sttProvider.meta.default === 'dsh')
check('sttLanguage 默认 auto', Config.dict.sttLanguage.meta.default === 'auto')
check('云端配置项保留（显式选 cloud 时仍可用）',
  String(Config.dict.sttBaseUrl.meta.description).includes('cloud') && Config.dict.sttApiKey !== undefined)
check('服务名与语言常量没写错', DSH_SPEECH_SERVICE === 'speechToText' && DEFAULT_STT_LANGUAGE === 'auto')

// ---- 2. WAV 体检：只认 16kHz 单声道 PCM16 ----
check('合法 WAV 通过体检', inspectWav(makeWav()).ok === true)
check('采样率不对会被指出来', inspectWav(makeWav(0.2, 44100)).reason.includes('16000'))
check('双声道会被指出来', inspectWav(makeWav(0.2, 16000, 2)).reason.includes('单声道'))
check('不是 WAV 会被指出来', inspectWav(Buffer.from('not a wav at all, definitely longer than 44 bytes..............')).reason.includes('RIFF'))
check('太短会被指出来', inspectWav(Buffer.alloc(10)).ok === false)

// ---- 3. ffmpeg 转换：命令正确、产物要体检 ----
const dir = mkdtempSync(join(tmpdir(), 'qq-stt-'))
try {
  let seenArgs = null
  const fakeRun = async (command, args) => {
    seenArgs = { command, args }
    // 假的 ffmpeg：把输出参数指向的那个 wav 写成合法文件
    writeFileSync(args[args.length - 1], makeWav())
  }
  const wav = await toWav16k({ buffer: Buffer.from('fake-amr-bytes'), ext: 'amr', ffmpegPath: 'ffmpeg.exe', tmpDir: dir, run: fakeRun })
  check('转换命令用的是 16kHz/单声道/PCM16', seenArgs.args.join(' ').includes('-ar 16000 -ac 1 -c:a pcm_s16le'))
  check('转换用的 ffmpeg 路径来自配置', seenArgs.command === 'ffmpeg.exe')
  check('转换产物通过体检（否则就该报错而不是硬发）', inspectWav(wav).ok === true)
  check('临时文件已清理', (await import('node:fs')).readdirSync(dir).length === 0)

  // ffmpeg 失败 → 中文原因
  const brokenRun = async () => { throw new Error('ffmpeg: command not found') }
  let message = ''
  try { await toWav16k({ buffer: Buffer.from('x'), ext: 'amr', tmpDir: dir, run: brokenRun }) } catch (error) { message = error.message }
  check('ffmpeg 不可用时给出中文原因', message.includes('ffmpeg 转 16kHz WAV 失败'), message.slice(0, 50))

  // ffmpeg "成功"但产物不合规 → 必须拦下来
  const wrongRun = async (command, args) => { writeFileSync(args[args.length - 1], makeWav(0.2, 8000)) }
  let wrongMessage = ''
  try { await toWav16k({ buffer: Buffer.from('x'), ext: 'amr', tmpDir: dir, run: wrongRun }) } catch (error) { wrongMessage = error.message }
  check('产物不是 16kHz 时拒绝（不让坏音频进识别）', wrongMessage.includes('不符合要求'), wrongMessage.slice(0, 50))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ---- 4. 调 DSH 服务：形状正确、不联网 ----
let resolveArgs = null
let transcribeArgs = null
const fakeService = {
  resolve(request) { resolveArgs = request; return { provider: 'sensezero?', audio: request.audio, language: request.language } },
  async transcribe(spec, signal) {
    transcribeArgs = { spec, hasSignal: typeof signal?.addEventListener === 'function' || signal instanceof AbortSignal }
    return { text: '  你好，这是一条语音  ', audioSeconds: 1.2, inferenceSeconds: 0.3 }
  },
}
const text = await transcribeViaDsh({ service: fakeService, wav: makeWav(), language: 'zh' })
check('返回的文本被 trim', text === '你好，这是一条语音')
check('audio 传的是 Uint8Array（平台的契约）', resolveArgs.audio instanceof Uint8Array)
check('语言透传给了服务', resolveArgs.language === 'zh')
check('transcribe 收到 signal（可取消）', transcribeArgs.hasSignal === true)

// 没装服务 → 中文提示，且不会去碰网络
let noService = ''
try { await transcribeViaDsh({ service: undefined, wav: makeWav() }) } catch (error) { noService = error.message }
check('DSH 没启用时给出可操作的中文原因', noService.includes('没启用') && noService.includes('voice-input-bundle'), noService.slice(0, 40))

// 空文本 → 明确报错
let emptyText = ''
try {
  await transcribeViaDsh({ service: { resolve: (r) => r, transcribe: async () => ({ text: '   ' }) }, wav: makeWav() })
} catch (error) { emptyText = error.message }
check('空结果会报错而不是把空字符串喂给模型', emptyText.includes('空文本'))

// ---- 5. 错误翻译 ----
check('下载/准备类错误 → 提示首次要下载模型',
  explainDshError(new Error('preparation required: model not downloaded')).includes('首次使用要下载'))
check('没有可用提供方 → 提示检查 profile',
  explainDshError(new Error('Speech provider is unavailable: sensevoice-local')).includes('没有可用的本地识别提供方'))
check('其他错误 → 兜底中文', explainDshError(new Error('boom')).startsWith('DSH 语音转文字失败'))

// ---- 6. 真机事故回归：ffmpeg 默认写的 LIST 元数据块 → 平台判 "Invalid speech WAV" ----
// （2026-10-04 真机：引用语音转写报 Invalid speech WAV，根因就是 data 块不在偏移 36）
const withListChunk = (trimBytes = 0) => {
  const pcm = Buffer.alloc(3200)
  // WAV 的块长度必须是偶数——别手数字符，直接补齐（我自己就在这里踩过一次）。
  const listBody = Buffer.from('INFOISFTLavf60.16.100', 'binary')
  const list = listBody.length % 2 === 0 ? listBody : Buffer.concat([listBody, Buffer.alloc(1)])
  const buffer = Buffer.alloc(12 + 24 + 8 + list.length + 8 + pcm.length - trimBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('LIST', 36, 'ascii')
  buffer.writeUInt32LE(list.length, 40)
  list.copy(buffer, 44)
  const dataOffset = 44 + list.length
  buffer.write('data', dataOffset, 'ascii')
  buffer.writeUInt32LE(pcm.length, dataOffset + 4)
  pcm.copy(buffer, dataOffset + 8)
  return buffer
}
const ffmpegStyle = withListChunk()
const ffmpegCheck = inspectWav(ffmpegStyle)
check('带 LIST 元数据块的 WAV 会被严格检查拦下（data 不在偏移 36）',
  ffmpegCheck.ok === false && String(ffmpegCheck.reason).includes('偏移 36'), String(ffmpegCheck.reason))
const canonical = canonicalizeWav(ffmpegStyle)
check('规范化后 data 回到偏移 36 并通过严格检查（平台不会再抛 Invalid speech WAV）',
  canonical.toString('ascii', 36, 40) === 'data' && inspectWav(canonical).ok === true,
  `长度 ${canonical.length}`)
check('规范化保留 PCM 数据（44 + 原始数据长度）', canonical.length === 44 + 3200)
check('规范化会截掉奇数尾字节（平台要求数据长度为偶数）',
  canonicalizeWav(withListChunk(1)).length % 2 === 0)
let canonicalReason = ''
try { canonicalizeWav(Buffer.from('RIFFxxxxWAVEfmt ')) } catch (error) { canonicalReason = error.message }
check('规范化对残缺文件给出中文原因（太短 / 缺 fmt / 不是 WAV 都算）',
  /太短|fmt 块|不是 WAV/.test(canonicalReason), canonicalReason)
check('严格检查与平台逐条对齐（字节率/块对齐/整数长度都要卡）',
  inspectWav(makeWav().subarray(0, 45)).ok === false
  && inspectWav(Buffer.concat([makeWav().subarray(0, 28), Buffer.from([0, 0, 0, 0]), makeWav().subarray(32)])).ok === false)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
