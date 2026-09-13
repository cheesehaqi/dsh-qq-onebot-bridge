/**
 * Core bridge: routes QQ messages into native Harness agent sessions and
 * streams assistant replies back over OneBot.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, readdirSync, statSync, rmSync, renameSync } from 'node:fs'
import { join, extname, basename, isAbsolute, resolve, sep } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { FaceLibrary } from './faces.js'
import { describeRecurrence, nextRecurrenceAt, parseRecurringReminder, parseReminder } from './reminders.js'
import { parseVoteCommand, TodoStore } from './grouptools.js'
import { synthesizeTts } from './tts.js'
import { parseMessage } from './onebot.js'
import { CheckinStore, isCheckinIntent, isCheckinBoardIntent } from './checkin.js'
import { generateImage } from './imagegen.js'
import { ActionGate } from './actions.js'
import { JsonStore, expiredFiles, moveToTrash, writeJsonAtomic } from './store.js'
import { TraceRecorder, beginTrace } from './trace.js'
import { InboxRecorder, countLines, createLineTailer, parseInjectionLine } from './inbox.js'
import { describeSendRoots, resolveSendPath, shouldForwardText } from './send.js'
import { KeywordStore, parseKeywordCommand } from './keywords.js'
import { PointsStore, formatLeaderboard } from './points.js'
import { dailyFortune, drawLot, drawTarot, formatFortune, formatLot, formatTarot, parseFortuneIntent } from './fortune.js'
import { parseDice, rollDice, formatRoll, parsePickCommand, pickRandom, formatPick } from './dice.js'
import { IdiomChain, GuessNumber, parseGameStartIntent, parseGameStopIntent } from './games.js'
import { RecallCache, formatRecallNotice, isRecallNotice } from './recall.js'
import { FloodGuard, WordFilter, parseWordList } from './filter.js'
import { JoinGuard, checkVerifyAnswer, formatJoinPrompt, formatPendingList, parseVerifyCommand } from './verify.js'
import { StatsStore, formatActivity, formatHonor, pickReportTargets } from './stats.js'
import { formatMcStatus, parseMcAddress, pingMcServer } from './mcping.js'

const MAX_QQ_MESSAGE_CHARS = 1700

async function downloadTo(url, directory, name) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`download HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new Error('download empty')
  mkdirSync(directory, { recursive: true })
  const ext = guessImageExt(response.headers.get('content-type'), url)
  const filePath = join(directory, `${name}${ext}`)
  writeFileSync(filePath, buffer)
  return filePath
}

function guessImageExt(contentType, url) {
  if (typeof contentType === 'string') {
    if (contentType.includes('gif')) return '.gif'
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg'
    if (contentType.includes('webp')) return '.webp'
    if (contentType.includes('png')) return '.png'
  }
  const ext = extname(String(url).split('?')[0])
  return ext || '.png'
}

let debugLogPath = join(process.cwd(), 'qq-bridge-debug.log')
let debugLogSize = 0

const DEBUG_LOG_MAX_BYTES = 2 * 1024 * 1024   // 2 MiB cap
const DEBUG_LOG_KEEP_BYTES = 128 * 1024        // keep the last 128 KiB after rotation

function debugLog(line) {
  try {
    debugLogSize += Buffer.byteLength(line) + 1
    if (debugLogSize > DEBUG_LOG_MAX_BYTES) {
      // Rotate: keep only the tail so the file never grows unbounded.
      const tail = readFileSync(debugLogPath, 'utf8').slice(-DEBUG_LOG_KEEP_BYTES)
      writeFileSync(debugLogPath, tail, 'utf8')
      debugLogSize = DEBUG_LOG_KEEP_BYTES
    }
    appendFileSync(debugLogPath, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function sessionPrefix(key) {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24)
  return `qq-${digest}`
}

function freshSessionId(prefix, now = Date.now()) {
  return brandSessionId(`${prefix}-${now.toString(36)}`)
}

function assistantText(event) {
  return event.data.message.content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** One-line rendering of an outbound segment list (for the inject dry-run report). */
function summarizeSegments(segments) {
  if (!Array.isArray(segments)) return ''
  return segments
    .map((segment) => (segment?.type === 'text' ? String(segment.data?.text ?? '') : `[${segment?.type ?? '?'}]`))
    .join('')
    .slice(0, 200)
}

function splitChunks(text, limit) {
  const chunks = []
  let rest = String(text)
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0 || cut > limit) cut = rest.lastIndexOf(' ', limit)
    if (cut <= 0 || cut > limit) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/** Split CQ segments into batches whose total text length stays under limit. */
function splitSegments(segments, limit) {
  const batches = []
  let current = []
  let length = 0
  for (const segment of segments) {
    const textLen = segment.type === 'text' ? String(segment.data?.text ?? '').length : 1
    if (length > 0 && length + textLen > limit) {
      batches.push(current)
      current = []
      length = 0
    }
    current.push(segment)
    length += textLen
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** Parse "H:MM-H:MM" quiet windows into minute-of-day spans; malformed entries are skipped. */
export function parseQuietRanges(ranges) {
  const parsed = []
  if (!Array.isArray(ranges)) return parsed
  const fullWidthDigits = '０１２３４５６７８９'
  for (const item of ranges) {
    const normalized = String(item)
      .replace(/[：]/g, ':')
      .replace(/[－–—−]/g, '-')
      .replace(/[０-９]/g, (ch) => String(fullWidthDigits.indexOf(ch)))
    const match = normalized.match(/^\s*(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2}):(\d{1,2})\s*$/)
    if (!match) continue
    const h1 = Number(match[1]); const m1 = Number(match[2])
    const h2 = Number(match[3]); const m2 = Number(match[4])
    if (h1 > 23 || m1 > 59 || h2 > 23 || m2 > 59) continue
    const start = h1 * 60 + m1
    const end = h2 * 60 + m2
    if (start === end) continue
    parsed.push({ start, end })
  }
  return parsed
}

/** True when quiet mode is on, today is not an exempt weekend, and `now` falls inside a quiet window. */
export function isQuietTime(config, ranges, now = new Date()) {
  if (!config.quietHoursEnabled || ranges.length === 0) return false
  const day = now.getDay()
  if (config.quietWeekendExempt && (day === 0 || day === 6)) return false
  const minutes = now.getHours() * 60 + now.getMinutes()
  return ranges.some((range) => range.start < range.end
    ? minutes >= range.start && minutes < range.end
    : minutes >= range.start || minutes < range.end)  // overnight window
}

export class QQBridge {
  constructor(ctx, config, server, logger) {
    this.ctx = ctx
    this.config = config
    this.server = server
    this.logger = logger
    debugLogPath = join(config.cwd || process.cwd(), 'qq-bridge-debug.log')
    this.faces = new FaceLibrary(join(config.cwd || process.cwd(), 'qq-faces'))
    this.quoteDir = join(config.cwd || process.cwd(), 'qq-replies')
    this.imageDir = join(config.cwd || process.cwd(), 'qq-images')
    this.memoryDir = join(config.cwd || process.cwd(), 'qq-memory')
    this.reminderFile = join(config.cwd || process.cwd(), 'qq-reminders.json')
    this.reminders = new Map()   // id -> { id, key, route, dueAt, content, timer }
    this.timers = new Set()
    this.replyTimes = new Map()  // chatKey -> recent outbound reply timestamps (rate limiting)
    this.seenMessages = new Map() // messageId -> first-seen timestamp (dedup)
    this.todoDir = join(config.cwd || process.cwd(), 'qq-todos')
    this.ttsDir = join(config.cwd || process.cwd(), 'qq-tts')
    this.filesDir = join(config.cwd || process.cwd(), 'qq-files')
    this.exportsDir = join(config.cwd || process.cwd(), 'qq-exports')
    this.votes = new Map()       // chatKey -> { question, options, votes, route, timer }
    this.pendingKicks = new Map() // chatKey -> { userId, adminId, route, expiresAt }
    try {
      this.pluginVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    } catch {
      this.pluginVersion = '?'
    }
    this.lastNotifyAt = 0
    this.quietRanges = parseQuietRanges(config.quietHours)
    this.lastPokeAt = new Map()   // chatKey -> last poke reply timestamp
    this.checkinDir = join(config.cwd || process.cwd(), 'qq-checkin')
    this.checkinStore = new CheckinStore(this.checkinDir)
    this.genLastAt = new Map()    // chatKey -> last image generation timestamp
    this.genDaily = new Map()     // chatKey -> { date, count } daily image-gen quota
    this.mediaDir = join(config.cwd || process.cwd(), 'qq-media')
    this.sessionFile = join(config.cwd || process.cwd(), 'qq-sessions.json')
    this.sessionStore = new JsonStore(this.sessionFile, { fallback: {} })
    this.gate = new ActionGate({
      auditFile: config.actionAuditEnabled === false ? '' : join(config.cwd || process.cwd(), 'qq-actions.log'),
      perMinute: config.actionRatePerMinute,
      perDay: config.actionRatePerDay,
    })
    this.sentMessages = new Map()  // chatKey -> [{ messageId, at }] recent outbound messages (for /撤回)
    this.keywordStore = new KeywordStore(config.keywordFile || join(config.cwd || process.cwd(), 'qq-keywords.json'))
    this.keywordDir = this.keywordStore.file
    this.pointsStore = new PointsStore(join(config.cwd || process.cwd(), 'qq-points'))
    this.games = new Map()      // chatKey -> { kind: 'idiom' | 'guess', chain?, guess? } running mini-game
    this.recallCache = new RecallCache({
      maxPerChat: Math.max(5, Number(config.antiRecallCacheSize) || 50),
      maxAgeMs: Math.max(1, Number(config.antiRecallMaxAgeMinutes) || 120) * 60_000,
    })
    this.recallLastAt = new Map()   // chatKey -> last anti-recall post timestamp
    this.badWordsFile = config.filterWordsFile || join(config.cwd || process.cwd(), 'qq-badwords.txt')
    this.badWordsCache = { stamp: '', filter: new WordFilter({ words: [], whitelist: config.filterWhitelist ?? [] }) }
    this.floodGuard = new FloodGuard({
      windowSeconds: config.floodWindowSeconds,
      maxMessages: config.floodMaxMessages,
      muteSeconds: config.floodMuteSeconds,
      strikeLimit: config.floodStrikeLimit,
    })
    this.joinGuard = new JoinGuard({
      timeoutSeconds: config.verifyTimeoutSeconds,
      maxPending: config.verifyMaxPending,
    })
    this.statsStore = new StatsStore(join(config.cwd || process.cwd(), 'qq-stats'), { keepDays: config.statsKeepDays })
    this.dailyReportStore = new JsonStore(join(config.cwd || process.cwd(), 'qq-dailyreport.json'), { fallback: { chats: [] } })
    this.trace = new TraceRecorder({
      file: config.traceFile || join(config.cwd || process.cwd(), 'qq-trace.jsonl'),
      memoryLimit: config.traceMemorySize,
      enabled: config.traceEnabled !== false,
      level: config.traceLevel,
    })
    this.runtimeFile = join(config.cwd || process.cwd(), 'qq-runtime.json')
    this.runtimeLastAt = 0
    this.inbox = new InboxRecorder({
      file: config.inboxFile || join(config.cwd || process.cwd(), 'qq-inbox.jsonl'),
      enabled: config.recordInbound !== false,
      redact: config.inboxRedact === true,
    })
    this.injectFile = config.injectFile || join(config.cwd || process.cwd(), 'qq-inject.jsonl')
    this.injectTailer = createLineTailer(this.injectFile)
    this.injecting = false
    // 注入拦截（按会话，不用全局 dry-run）：
    //   injectSync   —— 同步派发阶段的屏蔽窗口（chatKey → 到期时间），覆盖命令类同步回复
    //   deferred     —— 会话正在跑回合时推迟投递的注入（保证"一次注入 = 一个独立回合"）
    this.injectSync = new Map()
    this.deferredInjections = []
    this.sessions = new Map()   // routeKey -> { handle, agent, sessionId, route }
    this.agents = new Map()     // sessionId -> entry
    this.creating = new Map()
    this.disposers = []
    this.stopped = false
  }

  start() {
    this.disposers.push(this.ctx.on('session/event', (session, event) => this.#onSessionEvent(session, event)))
    this.disposers.push(this.#onServer('message', (message) => void this.#onQqMessage(message)))
    this.disposers.push(this.#onServer('notice', (notice) => void this.#onNotice(notice)))
    this.disposers.push(this.#onServer('request', (request) => void this.#onRequest(request)))
    this.disposers.push(this.#onServer('bot-disconnect', (socket) => this.#onBotDisconnect(socket)))
    this.disposers.push(this.#onServer('bot-connect', () => this.#notify('✅ QQ 机器人已上线')))
    this.#loadReminders()
    this.#cleanupImageDirs()
    this.#startVerifySweeper()
    this.#scheduleDailyReport()
    this.#startInjectPoll()
    this.#writeRuntimeSnapshot(true)
    this.#notify('🔌 QQ 桥已就绪')
  }

  /**
   * Subscribe to a bridge-server event and return a REAL disposer.
   * (EventEmitter#on returns the emitter, so pushing its result into `disposers`
   * made stop() throw "dispose is not a function".)
   */
  #onServer(event, handler) {
    this.server.on(event, handler)
    return () => {
      if (typeof this.server.off === 'function') this.server.off(event, handler)
      else if (typeof this.server.removeListener === 'function') this.server.removeListener(event, handler)
    }
  }

  /**
   * Retention cleanup for downloaded images. Policy (user rule 2026-09-12):
   * files are MOVED to cwd/qq-trash/<date>/ instead of being permanently deleted;
   * if the move fails the file is kept (never destroyed).
   */
  #cleanupImageDirs() {
    try {
      const retentionMs = Math.max(1, Number(this.config.imageRetentionDays) || 14) * 86_400_000
      const trash = this.config.imageTrashEnabled === false ? '' : (this.config.imageTrashDir || join(this.config.cwd || process.cwd(), 'qq-trash'))
      let moved = 0
      for (const dir of [this.imageDir, this.quoteDir]) {
        for (const file of expiredFiles(dir, retentionMs)) {
          if (trash) {
            if (moveToTrash(file, trash)) moved += 1
            else debugLog(`image retention: 无法移入回收目录，保留原文件 ${file}`)
          }
        }
      }
      if (moved > 0) debugLog(`image retention: ${moved} 个过期文件已移入 ${trash}（未永久删除）`)
    } catch (error) {
      debugLog(`image retention cleanup failed: ${error.message}`)
    }
  }

  stop() {
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const dispose of this.disposers.splice(0)) dispose()
    const handles = [...this.sessions.values()].map((entry) => entry.handle)
    this.sessions.clear()
    this.agents.clear()
    void Promise.allSettled(handles.map((handle) => handle.dispose()))
  }

  #routeKey(message) {
    const mode = this.config.sessionMode
    if (message.messageType === 'private') return `u:${message.userId}`
    return mode === 'chat' ? `g:${message.groupId}` : `g:${message.groupId}:u:${message.userId}`
  }

  /** Start a trace for one inbound event (null when tracing is off). */
  #beginTrace(message) {
    if (!this.trace?.enabled) return null
    const trace = beginTrace(this.trace, {
      chatKey: this.#chatKeyOf(this.#routeOf(message)),
      userId: message.userId ?? 0,
      groupId: message.groupId ?? 0,
      messageType: message.messageType ?? '',
      messageId: message.messageId ?? '',
      text: message.text ?? '',
    })
    message.__trace = trace
    if (message.__injected === true) trace.mark('inject', { ok: true, reason: '来自注入器（非真实 QQ 消息）' })
    if (message.__replayed === true) trace.mark('replay', { ok: true, reason: '来自离线回放（沙箱 + dry-run，不碰 QQ）' })
    return trace
  }

  /** Start a trace for a notice/request event (no message id). */
  #beginEventTrace(kind, event) {
    if (!this.trace?.enabled) return null
    const trace = beginTrace(this.trace, {
      chatKey: event.groupId ? `g:${event.groupId}` : (event.userId ? `u:${event.userId}` : ''),
      userId: event.userId ?? 0,
      groupId: event.groupId ?? 0,
      messageType: event.groupId ? 'group' : 'private',
      text: `${kind}:${event.noticeType ?? event.requestType ?? ''}/${event.subType ?? ''}`,
    })
    if (event.__injected === true) trace.mark('inject', { ok: true, reason: '来自注入器（非真实 QQ 事件）' })
    if (event.__replayed === true) trace.mark('replay', { ok: true, reason: '来自离线回放（沙箱 + dry-run，不碰 QQ）' })
    return trace
  }

  /**
   * Injection channel (v0.4 调试): the console appends a spec line to
   * `qq-inject.jsonl`; every poll feeds it through the REAL pipeline. With
   * `injectDryRun` (default) the OneBot server is switched to dry-run for the
   * duration, so nothing ever reaches QQ.
   */
  #startInjectPoll() {
    if (this.config.injectEnabled !== true) return
    const interval = Math.max(500, Number(this.config.injectIntervalMs) || 2000)
    this.injectInterval = interval
    // 只消费"启动之后"追加的行：启动前留下的历史注入一律跳过（否则重启就会重放旧注入）。
    // 跳过多少行要留下痕迹，符合"无静默分支"约束。
    this.injectTailer.reset(true)
    const queued = countLines(this.injectFile)
    if (queued > 0) {
      this.trace?.event({
        id: '', level: 'info', module: 'bridge', stage: 'inject', ok: true,
        reason: `注入队列已有 ${queued} 行历史记录，本次启动跳过（只处理启动后新增的行）`,
        data: { file: this.injectFile, skipped: queued },
      })
    }
    const timer = setInterval(() => { void this.#pollInjections() }, interval)
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.add(timer)
    debugLog(`injection channel armed: ${this.injectFile} (dryRun=${this.config.injectDryRun !== false}, every ${interval}ms, skipped=${queued})`)
  }

  async #pollInjections() {
    if (this.stopped || this.injecting) return
    // 先重试上一轮因"会话正忙"推迟的注入（保证一次注入 = 一个独立回合）
    try { await this.#retryDeferredInjections() } catch (error) { debugLog(`deferred inject retry failed: ${error.message}`) }
    let lines = []
    try {
      lines = this.injectTailer.poll()
    } catch (error) {
      debugLog(`inject poll failed: ${error.message}`)
      return
    }
    for (const line of lines) {
      if (line.trim() === '') continue
      this.injectConsumed = (this.injectConsumed ?? 0) + 1
      this.injectLastAt = Date.now()
      try {
        const { kind, frame } = parseInjectionLine(line, { botQq: this.config.botQq })
        await this.#handleInjection(kind, frame)
      } catch (error) {
        this.trace?.event({
          id: '', level: 'error', module: 'bridge', stage: 'inject', ok: false,
          reason: `注入失败：${error.message}`, data: { line: String(line).slice(0, 200) },
        })
        debugLog(`injection rejected: ${error.message}`)
      }
    }
    this.#compactInjectQueue()
  }

  /**
   * 队列压缩：注入文件是只追加的，长期使用会触发 `appendCappedLine` 的"保留尾部"轮转，
   * 而轮转保留下来的正是**最近已消费的行** → tailer 检测到文件变小后从头重读 → 旧注入被重复执行。
   * 所以：当文件已经长到该轮转、且我们读到的位置正好等于文件末尾（说明全部消费完）时，
   * 直接把文件清空。位置判定把"读清空之间的竞态"压到最小。
   */
  #compactInjectQueue() {
    try {
      const size = statSync(this.injectFile).size
      if (size < 256 * 1024) return
      if (this.injectTailer.position !== size) return   // 还有没读到的内容，先不压缩
      // 先改名再建空文件：控制台此刻的 append 只会落到新文件上，不会被截断吞掉
      const parking = `${this.injectFile}.compacted`
      renameSync(this.injectFile, parking)
      writeFileSync(this.injectFile, '', 'utf8')
      this.injectTailer.reset(true)
      this.injectConsumed = 0
      rmSync(parking, { force: true })
      this.trace?.event({
        id: '', level: 'info', module: 'bridge', stage: 'inject', ok: true,
        reason: `注入队列已压缩：${Math.round(size / 1024)} KB 全部消费完毕，清空以避免轮转后重复执行旧注入`,
      })
    } catch (error) {
      debugLog(`inject queue compact skipped: ${error.message}`)
    }
  }

  async #handleInjection(kind, frame) {
    const socket = this.server.currentSocket()
    const dryRun = this.config.injectDryRun !== false
    const chatKey = frame.groupId ? `g:${frame.groupId}` : `u:${frame.userId}`
    // 会话正在跑回合时不投递：否则这次注入会并进真人回合，让"下一个真人回合"被误判成注入回合
    if (kind === 'message') {
      const entry = this.sessions.get(this.#routeKey({ ...frame, bot: socket }))
      if (entry?.turnActive === true) {
        if (this.deferredInjections.length >= 8) {
          this.trace?.event({
            id: '', level: 'warn', module: 'bridge', stage: 'inject', ok: false, chatKey,
            reason: `注入推迟队列已满（8 条），本条丢弃；注入只在会话空闲时投递`,
          })
          return
        }
        this.deferredInjections.push({ kind, frame, at: Date.now(), chatKey })
        this.trace?.event({
          id: '', level: 'info', module: 'bridge', stage: 'inject', ok: true, chatKey,
          reason: `注入推迟：该会话正在处理回合，等空闲后再投递（队列 ${this.deferredInjections.length} 条）`,
        })
        return
      }
    }
    this.injecting = true
    let previous = null
    try {
      if (dryRun) {
        // 作用域 dry-run：只拦这个会话的调用，绝不连坐其它会话里真人的回复
        previous = this.server.setDryRun(true, { groupId: frame.groupId ?? 0, userId: frame.userId ?? 0 })
        this.#beginInjectWindow(chatKey)
      }
      this.trace?.event({
        id: '', level: 'info', module: 'bridge', stage: 'inject', ok: true, chatKey,
        reason: `注入 ${kind}${dryRun ? '（dry-run：不会真发）' : '（真实发送！）'}`, data: { kind, dryRun },
      })
      if (kind === 'notice') await this.#onNotice({ ...frame, bot: socket, __injected: true })
      else if (kind === 'request') await this.#onRequest({ ...frame, bot: socket, __injected: true })
      else {
        await this.#onQqMessage({
          ...frame,
          bot: socket,
          __injected: true,
          ats: frame.ats ?? [],
          reply: frame.reply ?? null,
          records: frame.records ?? [],
          images: frame.images ?? [],
          files: frame.files ?? [],
          raw: { message: [] },
        })
      }
      if (dryRun) {
        const calls = this.server.takeDryRunCalls()
        this.trace?.event({
          id: '', level: 'info', module: 'bridge', stage: 'inject', ok: true, chatKey,
          reason: `注入完成：同步阶段 ${calls.length} 次出站被拦；本会话的 agent 回合（含每一步回复与工具调用）同样会被拦下`,
          data: { wouldSend: calls.map((call) => ({ action: call.action, text: summarizeSegments(call.params?.message) })) },
        })
      }
    } finally {
      // 同步窗口只覆盖本次派发；异步回合由 entry.currentTurnInjected 继续覆盖。
      // 作用域 dry-run 与窗口都在 finally 里还原：异常也不会让注入通道卡死。
      if (dryRun) this.server.setDryRun(previous?.enabled === true, previous?.scope ?? null)
      if (dryRun) this.#endInjectWindow(chatKey)
      this.injecting = false
      this.#writeRuntimeSnapshot(true)
    }
  }

  /** 会话空闲后重试被推迟的注入（在每次轮询开头调用）。 */
  async #retryDeferredInjections() {
    if (this.deferredInjections.length === 0) return
    const now = Date.now()
    const keep = []
    for (const item of this.deferredInjections) {
      if (now - item.at > 5 * 60_000) {
        this.trace?.event({
          id: '', level: 'warn', module: 'bridge', stage: 'inject', ok: false, chatKey: item.chatKey,
          reason: '注入推迟超过 5 分钟仍未等到会话空闲，已丢弃',
        })
        continue
      }
      const entry = this.sessions.get(this.#routeKey({ ...item.frame, bot: this.server.currentSocket() }))
      if (entry?.turnActive === true) { keep.push(item); continue }
      await this.#handleInjection(item.kind, item.frame)
    }
    this.deferredInjections = keep
  }

  /**
   * Machine-readable runtime snapshot (`qq-runtime.json`) so the standalone
   * console — a different process — can show live session/gate/trace state.
   * Throttled: at most one write every 2 seconds unless `force`.
   */
  #writeRuntimeSnapshot(force = false) {
    const now = Date.now()
    if (!force && now - this.runtimeLastAt < 2000) return
    this.runtimeLastAt = now
    try {
      const sessions = [...this.sessions.values()].map((entry) => ({
        chatKey: entry.key,
        sessionId: entry.sessionId,
        status: String(entry.handle.agent.status ?? 'unknown'),
        lastTraceId: entry.lastTraceId ?? '',
        lastTurnAt: entry.lastTurnAt ?? 0,
      }))
      writeJsonAtomic(this.runtimeFile, {
        updatedAt: now,
        pid: process.pid,
        version: this.pluginVersion,
        uptimeSeconds: Math.round(process.uptime()),
        sessions,
        sessionCount: sessions.length,
        reminders: this.reminders.size,
        votes: this.votes.size,
        games: this.games.size,
        joinsPending: this.joinGuard.size,
        features: this.#featureFlags(),
        replay: this.#replayHints(),
        inbox: this.inbox.summary(),
        injection: {
          enabled: this.config.injectEnabled === true,
          file: this.injectFile,
          dryRun: this.config.injectDryRun !== false,
          intervalMs: this.injectInterval ?? 0,
          // 注入文件是只追加的日志：控制台要区分"文件里有多少行"和"本次运行消费了多少"
          consumed: this.injectConsumed ?? 0,
          lastAt: this.injectLastAt ?? 0,
          queued: countLines(this.injectFile),
        },
        gate: this.gate.snapshot(),
        trace: this.trace.summary(),
        recentTraces: this.trace.listTraces({ limit: 10 }),
      })
    } catch (error) {
      debugLog(`runtime snapshot failed: ${error.message}`)
    }
  }

  /**
   * Effective feature flags (never secrets) — the console shows these so
   * "为什么这个功能没生效" is answerable without reading the profile YAML by hand.
   */
  #featureFlags() {
    const keys = [
      'sessionMode', 'maxMessageLength', 'visionMode', 'visionToolName', 'provider', 'model',
      'sessionResumeEnabled', 'agentMediaToolsEnabled', 'fileSendMaxBytes', 'forwardLongReplies',
      'memoryEnabled', 'memoryMaxEntries', 'reminderEnabled', 'recurringReminderEnabled', 'reminderMaxPerChat',
      'quietHoursEnabled', 'quietHours', 'quietWeekendExempt', 'rateLimitEnabled', 'dedupEnabled',
      'keywordEnabled', 'fortuneEnabled', 'diceEnabled', 'pointsEnabled', 'gameEnabled', 'statsEnabled',
      'mcStatusEnabled', 'groupReadEnabled', 'dailyReportEnabled', 'dailyReportTime', 'dailyReportChats',
      'antiRecallEnabled', 'antiRecallInGroup', 'filterEnabled', 'filterAction', 'floodEnabled',
      'verifyEnabled', 'checkinEnabled', 'welcomeEnabled', 'pokeEnabled', 'voiceReadingEnabled',
      'imageGenEnabled', 'ttsEnabled', 'ttsProvider', 'sttEnabled', 'adminEnabled',
      'exportEnabled', 'fileTransferEnabled', 'notifyEnabled',
      'traceEnabled', 'traceLevel', 'traceMemorySize',
    ]
    const flags = {}
    for (const key of keys) flags[key] = this.config[key]
    // 只暴露"口令是否配置"，绝不暴露内容。
    flags.verifyKeywordConfigured = Boolean(String(this.config.verifyKeyword ?? '').trim())
    flags.adminUsers = (this.config.adminUsers ?? []).length
    flags.allowUsers = (this.config.allowUsers ?? []).length
    flags.allowGroups = (this.config.allowGroups ?? []).length
    return flags
  }

  /**
   * Decision-relevant config for OFFLINE REPLAY (v0.4 阶段 3).
   *
   * 离线回放跑在独立进程里，拿不到宿主加载的那份配置；如果只用插件默认值，
   * 白名单为空就会把每条消息都判成"不在白名单"，回放结论毫无意义。所以把真正
   * 决定分支走向的那一小撮键写进本地运行时快照（只写本机文件，仍然不含任何密钥：
   * 口令/令牌一律只写"是否已配置"）。
   */
  #replayHints() {
    const config = this.config
    return {
      botQq: config.botQq ?? 0,
      allowGroups: config.allowGroups ?? [],
      allowUsers: config.allowUsers ?? [],
      adminUsers: config.adminUsers ?? [],
      quietHours: config.quietHours ?? [],
      quietHoursEnabled: config.quietHoursEnabled !== false,
      replyOnlyWhenMentioned: config.replyOnlyWhenMentioned !== false,
      acceptPrivate: config.acceptPrivate !== false,
      sessionMode: config.sessionMode ?? 'chat',
      dedupWindowSeconds: config.dedupWindowSeconds ?? 0,
      keywordEnabled: config.keywordEnabled === true,
      checkinEnabled: config.checkinEnabled === true,
      checkinKeyword: config.checkinKeyword ?? '',
      welcomeEnabled: config.welcomeEnabled === true,
      pokeEnabled: config.pokeEnabled === true,
      groupReadEnabled: config.groupReadEnabled !== false,
      statsEnabled: config.statsEnabled === true,
      pointsEnabled: config.pointsEnabled === true,
      gameEnabled: config.gameEnabled === true,
      fortuneEnabled: config.fortuneEnabled !== false,
      diceEnabled: config.diceEnabled !== false,
      filterEnabled: config.filterEnabled === true,
      floodEnabled: config.floodEnabled === true,
      antiRecallEnabled: config.antiRecallEnabled === true,
      voiceReadingEnabled: config.voiceReadingEnabled === true,
      maxMessageLength: config.maxMessageLength ?? 0,
      memoryEnabled: config.memoryEnabled !== false,
      filterAction: config.filterAction ?? '',
    }
  }

  #allowed(message) {    if (message.messageType === 'private') {
      // 白名单为空 = 拒绝所有私聊（部署者必须显式填入自己的 QQ 号）
      if (this.config.allowUsers.includes(message.userId)) return true
      // 入群/加好友验证期间，申请人可以私聊答题（仅在有待审请求时放行）。
      if (this.config.verifyEnabled && this.joinGuard.list().some((entry) => entry.userId === message.userId)) return true
      return false
    }
    // 群白名单为空 = 拒绝所有群消息
    if (!this.config.allowGroups.includes(message.groupId)) return false
    if (this.config.allowUsers.length > 0 && !this.config.allowUsers.includes(message.userId)) return false
    return true
  }

  async #onQqMessage(message) {
    if (this.stopped) return
    if (this.config.recordInbound !== false && message.__injected !== true && message.__replayed !== true) this.inbox.record('message', message)
    try {
      await this.#onQqMessageInner(message)
    } catch (error) {
      debugLog(`unhandled error: ${error.message}`)
      this.logger.error(`QQ message handler error: ${error.message}`)
      await this.#safeReply(message, `⚠️ 处理失败：${error.message}`)
    }
  }

  async #onQqMessageInner(message) {
    // 「一切皆可调试」：每条入站消息开一条 trace，每个分支（含静默丢弃）都留下 stage + reason。
    const trace = this.#beginTrace(message)
    const mark = (stage, ok = true, reason = '', data = null, level = 'info') => trace?.mark(stage, { ok, reason, data, level })

    if (!this.#allowed(message)) {
      debugLog(`rejected u${message.userId} g${message.groupId ?? '-'}`)
      mark('whitelist', false, message.messageType === 'private'
        ? '私聊用户不在 allowUsers 白名单'
        : (!this.config.allowGroups.includes(message.groupId) ? '群不在 allowGroups 白名单' : '成员不在 allowUsers 白名单'))
      this.#writeRuntimeSnapshot()
      return
    }
    mark('whitelist')
    if (isQuietTime(this.config, this.quietRanges)) {
      debugLog(`quiet hours, message ignored u${message.userId} g${message.groupId ?? '-'}`)
      mark('quiet', false, `避开高峰期静默中（${(this.config.quietHours ?? []).join(' / ')}）`)
      this.#writeRuntimeSnapshot()
      return
    }
    if (this.#duplicate(message)) {
      debugLog(`duplicate message ignored id=${message.messageId} u${message.userId}`)
      mark('dedup', false, `重复投递：message_id=${message.messageId} 已在 ${this.config.dedupWindowSeconds}s 去重窗口内`)
      this.#writeRuntimeSnapshot()
      return
    }
    if (this.config.pointsEnabled) this.#awardMessagePoints(message)
    if (this.config.statsEnabled) this.#recordStats(message)
    const text = message.text.trim()
    if (this.config.autoCollectStickers) void this.#collectSticker(message)
    // 入群验证：申请人私聊答题（答对即放行，否则消费掉这条消息）。
    if (this.config.verifyEnabled && message.messageType === 'private' && await this.#handleJoinAnswer(message, text)) {
      mark('verify', true, '入群验证答题（消息已消费）')
      return
    }
    // 防撤回缓存：每条入站消息都留一份（含图片 URL），撤回时补发。
    if (this.config.antiRecallEnabled) this.#rememberForRecall(message, text)
    // 敏感词 / 刷屏：命中即拦下，不再进入模型。
    if ((this.config.filterEnabled || this.config.floodEnabled) && await this.#handleContentFilter(message, text)) {
      mark('filter', true, '敏感词/刷屏拦截（消息未进入模型）')
      return
    }

    // ---- 免@低摩擦命令（白名单+静默检查后即处理，不进入 agent 会话）----
    if (text === '/help' || text === '帮助' || text === '菜单') {
      await this.#handleHelp(message)
      mark('command', true, '命令 /help')
      return
    }
    if (this.config.checkinEnabled && isCheckinBoardIntent(text)) {
      await this.#handleCheckinBoard(message)
      mark('command', true, '命令 签到榜')
      return
    }
    if (this.config.checkinEnabled && isCheckinIntent(text, this.config.checkinKeyword)) {
      await this.#handleCheckin(message)
      mark('command', true, '命令 签到')
      return
    }
    if (this.config.voiceReadingEnabled) {
      const readCmd = /^\/读\s*(.*)$/.exec(text)
      const readQuoteIntent = Boolean(message.reply?.messageId) && /(读|念)/.test(text) &&
        (message.messageType === 'private' || message.atMe)
      if (readCmd || readQuoteIntent) {
        await this.#handleVoiceReading(message, readCmd ? readCmd[1].trim() : '')
        mark('command', true, '命令 语音朗读')
        return
      }
    }
    if (this.config.imageGenEnabled) {
      const genCmd = String(this.config.imageGenCommand || '/画').trim()
      // 群聊需要 @机器人（生图有成本，防白嫖）；私聊直接可用。
      const genAllowed = message.messageType === 'private' || message.atMe
      if (genCmd && genAllowed && (text === genCmd || text.startsWith(`${genCmd} `))) {
        const prompt = text === genCmd ? '' : text.slice(genCmd.length).trim()
        await this.#handleImageGen(message, prompt)
        mark('command', true, '命令 生图')
        return
      }
    }
    // ---- 进行中的群内小游戏（免 @，让群友直接接龙/猜数）----
    if (this.config.gameEnabled && await this.#handleActiveGame(message, text)) {
      mark('game', true, '进行中的小游戏吃下这条消息')
      return
    }
    // ---- 关键词问答库（免模型、免 @；默认关闭）----
    if (this.config.keywordEnabled && await this.#handleKeyword(message, text)) {
      mark('keyword', true, '关键词词库命中（未调用模型）')
      return
    }

    const hasRecords = Array.isArray(message.records) && message.records.length > 0
    const hasImages = Array.isArray(message.images) && message.images.length > 0
    const sttActive = this.config.sttEnabled

    // 私聊语音不受限制：直接转文字回复（无需引用/@，也不受 acceptPrivate 约束）。
    if (message.messageType === 'private' && sttActive && hasRecords) {
      await this.#handleVoice(message)
      mark('transcribe', true, '私聊语音转文字')
      return
    }

    // 私聊文件转存：收到的文件自动保存到本机。
    if (message.messageType === 'private' && this.config.fileTransferEnabled && Array.isArray(message.files) && message.files.length > 0) {
      await this.#handlePrivateFiles(message)
      mark('media', true, '私聊文件转存')
      return
    }

    // @机器人 + 引用（回复）一条语音 → 转文字回复；私聊引用语音同样放行。
    const voiceQuoteRequest = sttActive && Boolean(message.reply?.messageId) &&
      (message.messageType === 'private' || (message.messageType === 'group' && message.atMe))

    if (text === '') {
      // 群聊纯语音/空文本默认忽略；仅「@+引用语音」或「私聊图片/动画表情」继续处理。
      const privateImageOnly = message.messageType === 'private' && this.config.privateImageView && hasImages
      if (!voiceQuoteRequest && !privateImageOnly) {
        mark('drop', false, `空文本且无可用媒体（records=${hasRecords ? '有' : '无'} images=${hasImages ? '有' : '无'}）`)
        this.#writeRuntimeSnapshot()
        return
      }
    } else if (message.messageType === 'private' && !this.config.acceptPrivate) {
      if (!voiceQuoteRequest) {
        debugLog(`private msg ignored (acceptPrivate=false) u${message.userId}`)
        mark('drop', false, 'acceptPrivate=false，私聊已关闭')
        return
      }
    } else if (message.messageType === 'group' && this.config.replyOnlyWhenMentioned && !message.atMe) {
      debugLog(`group msg without @bot ignored (u${message.userId} g${message.groupId})`)
      mark('mention', false, '群聊未 @ 机器人（replyOnlyWhenMentioned=true）')
      this.#writeRuntimeSnapshot()
      return
    }

    debugLog(`msg from u${message.userId} g${message.groupId ?? '-'} m=${message.messageType} atMe=${message.atMe}: ${text.slice(0, 80)}`)
    let effectiveText = text
    const visionBlocks = []
    if (message.reply && message.reply.messageId) {
      try {
        const resolved = await trace
          ? await trace.step('quote', () => this.#resolveQuoted(message), { module: 'bridge' })
          : await this.#resolveQuoted(message)
        if (resolved.lines.length > 0 || resolved.blocks.length > 0) {
          const userPart = text !== ''
            ? `用户说：${text}`
            : resolved.hasVoice
              ? '用户引用了一条语音，请把这条语音的文字内容直接回复出来'
              : '请根据用户引用的消息内容回复'
          effectiveText = resolved.lines.length > 0 ? `[引用] ${resolved.lines.join('；')}\n\n${userPart}` : userPart
          visionBlocks.push(...resolved.blocks)
          mark('quote', true, `引用内容已解析（${resolved.lines.length} 行${resolved.hasVoice ? '，含语音' : ''}）`)
        } else if (text === '') {
          debugLog(`quoted message has no resolvable content, ignored (u${message.userId})`)
          mark('quote', false, '引用的消息没有可解析内容（且本条无文本）')
          return
        }
      } catch (error) {
        debugLog(`quote resolve failed: ${error.message}`)
        mark('quote', false, `引用解析失败：${error.message}`)
      }
    }

    // 私聊：主动查看对方发送的图片/动画表情（下载到本地并注入会话）。
    if (message.messageType === 'private' && this.config.privateImageView && hasImages) {
      try {
        const result = await this.#downloadMessageImages(message)
        const native = result.blocks.length > 0
        if (text === '') {
          effectiveText = native
            ? '用户发来了图片/动画表情（已附在本条消息中），请查看并回应。'
            : `用户发来了图片/动画表情（没有文字）：\n${result.note}\n请用 ${this.config.visionToolName} 查看图片，然后用文字回应。`
        } else {
          effectiveText = native
            ? `${effectiveText}\n\n用户同时发来了图片/动画表情（已附在本条消息中）。`
            : `${effectiveText}\n\n用户同时发送了图片/动画表情（可用 ${this.config.visionToolName} 查看）：\n${result.note}`
        }
        visionBlocks.push(...result.blocks)
        mark('media', true, `私聊图片已落盘（native=${native}）`)
      } catch (error) {
        debugLog(`private image handling failed: ${error.message}`)
        mark('media', false, `私聊图片处理失败：${error.message}`)
      }
    }

    if (text === '/new') {
      await this.#rotate(message)
      await this.#safeReply(message, '已开启新会话（旧的已完成）。现在直接发任务即可。')
      mark('command', true, '命令 /new（重开会话）')
      return
    }
    if (text === '/status') {
      const key = this.#routeKey(message)
      const entry = this.sessions.get(key)
      const status = entry ? String(entry.handle.agent.status) : 'idle (no session)'
      await this.#safeReply(message, `QQ 桥状态：${status} · 会话 ${entry ? entry.sessionId.slice(0, 8) : '无'}`)
      mark('command', true, '命令 /status')
      return
    }
    // /撤回：撤回机器人自己最近发出的消息（免模型）。
    if (text === '/撤回' || text === '/recall' || text === '撤回上一条') {
      const recalled = await this.#recallRecent(this.#chatKeyOf(this.#routeOf(message)), 1)
      await this.#safeReply(message, recalled > 0 ? '已撤回上一条消息。' : '没有可撤回的消息（可能已超过可撤回时间或未记录）。')
      mark('command', true, `命令 /撤回（撤回 ${recalled} 条）`)
      return
    }
    // ---- 零成本互动包（本地计算，不消耗模型；群聊需 @）----
    if (this.config.fortuneEnabled && await this.#handleFortune(message, text)) {
      mark('command', true, '本地功能：运势/抽签/塔罗')
      return
    }
    if (this.config.diceEnabled && await this.#handleDice(message, text)) {
      mark('command', true, '本地功能：骰子/随机抽人')
      return
    }
    if (this.config.pointsEnabled && await this.#handlePointsCommand(message, text)) {
      mark('command', true, '本地功能：积分')
      return
    }
    if (this.config.statsEnabled && await this.#handleStatsCommand(message, text)) {
      mark('command', true, '本地功能：活跃统计')
      return
    }
    if (this.config.mcStatusEnabled !== false && await this.#handleMcStatus(message, text)) {
      mark('command', true, '本地功能：MC 服务器状态')
      return
    }
    if (this.config.gameEnabled && await this.#handleGameCommand(message, text)) {
      mark('game', true, '小游戏开始/结束')
      return
    }
    if (this.config.dailyReportEnabled && await this.#handleDailyReportCommand(message, text)) {
      mark('command', true, '命令 /日报')
      return
    }
    if (this.config.groupReadEnabled !== false && await this.#handleGroupRead(message, text)) {
      mark('command', true, '只读群信息（荣誉/公告/精华）')
      return
    }
    if (this.config.keywordEnabled && this.config.adminEnabled && this.#isAdmin(message)) {
      const keywordCmd = parseKeywordCommand(text)
      if (keywordCmd) {
        await this.#handleKeywordAdmin(message, keywordCmd)
        mark('command', true, `命令 /kw ${keywordCmd.action}`)
        return
      }
    }
    if (text === '/reminders') {
      await this.#listReminders(message)
      mark('command', true, '命令 /reminders')
      return
    }
    if (text === '/health') {
      await this.#handleHealth(message)
      mark('command', true, '命令 /health')
      return
    }
    if (text === '/export' && this.config.exportEnabled) {
      await this.#handleExport(message)
      mark('command', true, '命令 /export')
      return
    }
    // ---- 管理命令（仅 adminUsers；踢人需二次确认，写操作统一过闸门）----
    if (this.config.adminEnabled && this.#isAdmin(message)) {
      const adminCmd = /^\/(mute|unmute|kick|clear|公告|精华|取消精华|名片|头衔|全员禁言|解除全员禁言)\s*(.*)$/.exec(text)
      if (adminCmd) {
        await this.#handleAdminCommand(message, adminCmd[1], adminCmd[2].trim())
        mark('command', true, `管理命令 /${adminCmd[1]}`)
        return
      }
      const confirm = /^(确认踢|取消)$/.exec(text)
      if (confirm) {
        await this.#handleKickConfirm(message, confirm[1])
        mark('command', true, `管理命令 ${confirm[1]}`)
        return
      }
      if (this.config.verifyEnabled) {
        const verifyCmd = parseVerifyCommand(text)
        if (verifyCmd) {
          await this.#handleVerifyCommand(message, verifyCmd)
          mark('command', true, `入群审批 ${verifyCmd.action}`)
          return
        }
      }
    }
    // ---- 群工具 ----
    if (text === '/summary' && this.config.summaryEnabled) {
      await this.#handleSummary(message)
      mark('command', true, '命令 /summary')
      return
    }
    if (this.config.voteEnabled) {
      const voteCmd = parseVoteCommand(text)
      if (voteCmd) {
        await this.#startVote(message, voteCmd)
        mark('command', true, '发起投票')
        return
      }
      if (text === '/vote') {
        await this.#showVote(message)
        mark('command', true, '命令 /vote')
        return
      }
      if (text === '/vote-end') {
        await this.#endVote(message)
        mark('command', true, '命令 /vote-end')
        return
      }
      if (await this.#maybeVote(message)) {
        mark('command', true, '投票投票')
        return
      }
    }
    if (this.config.todoEnabled) {
      const todoCmd = /^\/todo\b\s*(.*)$/.exec(text)
      if (todoCmd) {
        await this.#handleTodo(message, todoCmd[1].trim())
        mark('command', true, '命令 /todo')
        return
      }
      const remember = /^(?:记一下|记着|待办)[:：]?\s*(.+)$/.exec(text)
      if (remember) {
        await this.#handleTodo(message, `add ${remember[1].trim()}`)
        mark('command', true, '快捷待办')
        return
      }
    }
    // 定时提醒：群聊沿用 @ 过滤（@ 时允许省略"提醒"字样），私聊直接触发（需关键词）
    if (this.config.reminderEnabled) {
      const requireKeyword = !(message.messageType === 'group' && message.atMe)
      // 重复提醒优先：「每天8点」「每周一9点」「每个工作日15点」
      const recurring = this.config.recurringReminderEnabled === false ? null : parseRecurringReminder(text, requireKeyword)
      if (recurring) {
        await this.#addReminder(message, { dueAt: recurring.nextAt, content: recurring.content, rule: { kind: recurring.kind, hour: recurring.hour, minute: recurring.minute, weekday: recurring.weekday } })
        mark('command', true, '重复提醒已登记')
        return
      }
      const parsed = parseReminder(text, requireKeyword)
      if (parsed) {
        await this.#addReminder(message, parsed)
        mark('command', true, '一次性提醒已登记')
        return
      }
    }

    let entry
    try {
      entry = await this.#ensureSession(message)
      debugLog(`session ready ${entry.sessionId}`)
      mark('agent', true, `会话就绪 ${entry.sessionId.slice(0, 8)}${entry.resumed ? '（续接）' : '（新建）'}`)
      this.#recordMemory(this.#routeKey(message), 'user', effectiveText)
      entry.lastTraceId = trace?.id ?? ''
      entry.lastTurnAt = Date.now()
      // 统一走 #handoff 记账：主线之外的 followup（/summary、私聊语音、日报）也必须记账，
      // 否则注入帧的那一回合不会被判成注入回合 → 模型回复直接发到 QQ（真机审计发现的洞）。
      this.#handoff(entry, message, {
        content: [{ type: 'text', text: effectiveText }, ...visionBlocks],
        source: { kind: 'user' },
      })
      debugLog(`followup sent`)
      mark('agent', true, `已转交 agent（文本 ${effectiveText.length} 字${visionBlocks.length ? ` + ${visionBlocks.length} 张图` : ''}）`)
      this.#writeRuntimeSnapshot(true)
    } catch (error) {
      debugLog(`agent failure: ${error.message}`)
      this.logger.error(`QQ agent failure: ${error.message}`)
      mark('agent', false, `agent 处理失败：${error.message}`, null, 'error')
      await this.#safeReply(message, `⚠️ Agent 处理失败：${error.message}`)
    }
  }

  /** Reply to a QQ message without ever throwing (logs failures instead). */
  async #safeReply(message, text) {
    try {
      await this.#reply(message, text)
    } catch (error) {
      debugLog(`reply failed: ${error.message}`)
    }
  }

  #memoryFile(key) {
    return join(this.memoryDir, `${String(key).replace(/[^\w-]/g, '_')}.json`)
  }

  /** Load persisted conversation lines for a chat (earliest first). */
  #loadMemoryLines(key) {
    try {
      const file = this.#memoryFile(key)
      if (!existsSync(file)) return []
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(data?.history)) return []
      return data.history.map((h) => `${h.role === 'user' ? '用户' : '助手'}: ${String(h.text ?? '').slice(0, 800)}`)
    } catch (error) {
      debugLog(`memory load failed: ${error.message}`)
      return []
    }
  }

  /** Append one turn to the chat's persisted memory (rolling window). */
  #recordMemory(key, role, text) {
    if (!this.config.memoryEnabled) return
    const clean = String(text ?? '').trim().slice(0, 1000)
    if (clean === '') return
    try {
      mkdirSync(this.memoryDir, { recursive: true })
      const file = this.#memoryFile(key)
      let history = []
      if (existsSync(file)) {
        try { history = JSON.parse(readFileSync(file, 'utf8')).history ?? [] } catch {}
      }
      history.push({ role, text: clean, ts: Date.now() })
      const max = Math.max(1, Number(this.config.memoryMaxEntries) || 30)
      history = history.slice(-max)
      writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), history }, null, 2), 'utf8')
    } catch (error) {
      debugLog(`memory write failed: ${error.message}`)
    }
  }

  /** Forget a chat's persisted memory (used by /new). */
  #clearMemory(key) {
    try {
      const file = this.#memoryFile(key)
      if (existsSync(file)) unlinkSync(file)
    } catch (error) {
      debugLog(`memory clear failed: ${error.message}`)
    }
  }

  #saveReminders() {
    try {
      const list = [...this.reminders.values()].map(({ id, key, route, dueAt, content, rule }) => ({ id, key, route, dueAt, content, ...(rule ? { rule } : {}) }))
      writeFileSync(this.reminderFile, JSON.stringify(list, null, 2), 'utf8')
    } catch (error) {
      debugLog(`reminders save failed: ${error.message}`)
    }
  }

  #loadReminders() {
    try {
      if (!existsSync(this.reminderFile)) return
      const list = JSON.parse(readFileSync(this.reminderFile, 'utf8'))
      if (!Array.isArray(list)) return
      const now = Date.now()
      for (const item of list) {
        if (!item?.id || !item?.route || typeof item?.dueAt !== 'number' || typeof item?.content !== 'string') continue
        if (item.dueAt < now - 5 * 60_000) {
          debugLog(`reminder dropped (overdue >5min) ${item.id}`)
          continue
        }
        const rem = { ...item, dueAt: Math.max(item.dueAt, now + 1_000), timer: null }
        this.reminders.set(rem.id, rem)
        this.#scheduleReminder(rem)
        debugLog(`reminder restored ${rem.id} due ${new Date(rem.dueAt).toISOString()}`)
      }
      this.#saveReminders()
    } catch (error) {
      debugLog(`reminders load failed: ${error.message}`)
    }
  }

  /** Arm (or re-arm) one reminder; long delays are chained to survive setTimeout bounds. */
  #scheduleReminder(rem) {
    const fire = () => {
      this.reminders.delete(rem.id)
      this.#saveReminders()
      void this.#deliverReminder(rem)
      // 重复提醒：送达后立刻排下一次（规则存在时永久循环）。
      if (rem.rule) this.#rescheduleRecurring(rem)
    }
    const arm = () => {
      const delay = rem.dueAt - Date.now()
      if (delay <= 0) { fire(); return }
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        arm()
      }, Math.min(delay, 0x7fffffff))
      this.timers.add(timer)
      rem.timer = timer
    }
    arm()
  }

  /** 重复提醒的下一次排程（复用原 id，保持 /reminders 列表干净）。 */
  #rescheduleRecurring(rem) {
    const nextAt = nextRecurrenceAt(rem.rule)
    if (nextAt === null) {
      debugLog(`recurring reminder ${rem.id} has no next occurrence (dropped)`)
      return
    }
    const next = { ...rem, dueAt: nextAt, timer: null }
    this.reminders.set(next.id, next)
    this.#saveReminders()
    this.#scheduleReminder(next)
    debugLog(`recurring reminder ${rem.id} rescheduled for ${new Date(nextAt).toISOString()}`)
  }

  async #deliverReminder(rem) {
    // 注入帧登记的提醒会在窗口早已关闭之后才发，而且会落盘、跨重启生效 —— 必须单独拦。
    if (this.#injectedTaskBlocked(rem, '提醒')) return
    const socket = this.server.currentSocket() ?? rem.route.bot
    if (!socket) {
      debugLog(`reminder ${rem.id} has no bot socket (dropped)`)
      return
    }
    try {
      await this.server.sendSegments(socket, rem.route.messageType, rem.route.targetId, [{ type: 'text', data: { text: `⏰ 提醒：${rem.content}` } }])
      debugLog(`reminder delivered ${rem.id}`)
    } catch (error) {
      debugLog(`reminder deliver failed: ${error.message}`)
      this.logger.error(`QQ reminder deliver failed: ${error.message}`)
    }
  }

  async #addReminder(message, parsed) {
    const key = this.#routeKey(message)
    const now = Date.now()
    const maxPerChat = Math.max(1, Number(this.config.reminderMaxPerChat) || 10)
    if (!parsed.rule && parsed.dueAt < now + 5_000) {
      await this.#safeReply(message, '⚠️ 提醒时间太近了，至少设置 5 秒以后。')
      return
    }
    if (!parsed.rule && parsed.dueAt > now + 30 * 86_400_000) {
      await this.#safeReply(message, '⚠️ 最远只能设置 30 天内的提醒。')
      return
    }
    const mine = [...this.reminders.values()].filter((r) => r.key === key).length
    if (mine >= maxPerChat) {
      await this.#safeReply(message, `⚠️ 本会话最多同时保留 ${maxPerChat} 个提醒。`)
      return
    }
    const rem = {
      id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      key,
      route: {
        messageType: message.messageType,
        targetId: message.messageType === 'group' ? message.groupId : message.userId,
      },
      dueAt: parsed.dueAt,
      content: parsed.content,
      ...(parsed.rule ? { rule: parsed.rule } : {}),
      // 注入帧登记的提醒：到点时只记事件，不发 QQ（除非显式关掉 injectDryRun）
      ...(message.__injected === true ? { injected: true } : {}),
      timer: null,
    }
    this.reminders.set(rem.id, rem)
    this.#saveReminders()
    this.#scheduleReminder(rem)
    const when = new Date(rem.dueAt).toLocaleString('zh-CN', { hour12: false })
    const repeat = parsed.rule ? `（${describeRecurrence(parsed.rule)}）` : ''
    await this.#safeReply(message, `⏰ 好的，将在 ${when} 提醒${repeat}：${rem.content}`)
    debugLog(`reminder added ${rem.id} due ${when}${parsed.rule ? ` rule=${parsed.rule.kind}` : ''}`)
  }

  async #listReminders(message) {
    const key = this.#routeKey(message)
    const mine = [...this.reminders.values()].filter((r) => r.key === key)
    if (mine.length === 0) {
      await this.#safeReply(message, '当前没有待执行的提醒。')
      return
    }
    const lines = mine.map((r) => `- ${new Date(r.dueAt).toLocaleString('zh-CN', { hour12: false })}：${r.content}${r.rule ? `（${describeRecurrence(r.rule)}）` : ''}`)
    await this.#safeReply(message, `待执行提醒（${mine.length} 个）：\n${lines.join('\n')}`)
  }

  /** 语音回复：合成 TTS 音频并以 record 段发回原会话（跟随文字回复）。 */
  async #sendTts(route, text) {
    try {
      if (this.config.ttsProvider !== 'local' && !this.config.ttsApiKey) {
        debugLog('tts skipped: no ttsApiKey')
        return
      }
      if (this.config.ttsProvider === 'local' && !this.config.ttsLocalRefAudio) {
        debugLog('tts skipped: ttsProvider=local but ttsLocalRefAudio is empty')
        return
      }
      const max = Math.max(10, Number(this.config.ttsMaxChars) || 120)
      const spoken = text.length > max ? `${text.slice(0, max)}……` : text
      const { file, bytes, format } = await this.#synthVoiceFile(spoken)
      const socket = this.server.currentSocket()
      if (!socket) {
        debugLog('tts skipped: no socket')
        return
      }
      await this.server.sendSegments(socket, route.messageType, route.targetId, [{ type: 'record', data: { file } }])
      debugLog(`tts sent (${bytes} bytes, ${format})`)
    } catch (error) {
      debugLog(`tts failed: ${error.message}`)
      this.logger.error(`QQ tts failed: ${error.message}`)
    }
  }

  /** 合成语音并落盘（含 wav→mp3 转换）；返回 { file, bytes, format }。 */
  async #synthVoiceFile(text) {
    const { audio, format } = await synthesizeTts(this.config, text)
    if (!audio || audio.length === 0) throw new Error('TTS 返回空音频')
    mkdirSync(this.ttsDir, { recursive: true })
    const base = join(this.ttsDir, `tts-${Date.now().toString(36)}`)
    let file = `${base}.${format === 'wav' ? 'wav' : 'mp3'}`
    writeFileSync(file, audio)
    // 本地 TTS 输出 wav：转 mp3 提升 QQ/NapCat 兼容性（可关：ttsLocalConvertToMp3=false）。
    if (format === 'wav' && this.config.ttsLocalConvertToMp3 !== false) {
      try {
        file = await this.#convertToMp3(file)
      } catch (error) {
        debugLog(`tts wav→mp3 convert failed (sending wav): ${error.message}`)
      }
    }
    return { file, bytes: audio.length, format }
  }

  /** 语音朗读：把指定文字合成语音发回当前会话。 */
  async #handleVoiceReading(message, explicitText) {
    let spoken = String(explicitText).trim()
    if (!spoken && message.reply?.text && message.reply.text.trim()) {
      spoken = message.reply.text.trim()
    } else if (!spoken && message.reply?.messageId) {
      try {
        const msg = await this.server.getMsg(message.bot, message.reply.messageId)
        const content = msg?.message
        if (Array.isArray(content) || typeof content === 'string') {
          spoken = parseMessage(content, this.config.botQq).text
        }
      } catch (error) {
        debugLog(`voice reading get_msg failed: ${error.message}`)
      }
    }
    if (!spoken) {
      await this.#safeReply(message, '没有找到要朗读的文字哦～用法：@我并引用一条文字说「读一下」，或直接发 /读 要读的内容')
      return
    }
    if (spoken.length > 500) spoken = `${spoken.slice(0, 500)}……`
    try {
      const { file } = await this.#synthVoiceFile(spoken)
      const targetId = message.messageType === 'group' ? message.groupId : message.userId
      await this.server.sendSegments(message.bot, message.messageType, targetId, [{ type: 'record', data: { file } }])
      debugLog(`voice reading sent (${file})`)
    } catch (error) {
      debugLog(`voice reading failed: ${error.message}`)
      await this.#safeReply(message, `朗读失败：${error.message.slice(0, 60)}`)
    }
  }

  /** 生图：/画 <描述词> → 调用生图后端并把图片发回当前会话（带冷却+每日限额）。 */
  async #handleImageGen(message, prompt) {
    const genCmd = String(this.config.imageGenCommand || '/画').trim()
    if (!prompt) {
      await this.#safeReply(message, `用法：${genCmd} 描述词\n例如：${genCmd} 一只蓝鲸在星空下喷着水花，赛博朋克风格`)
      return
    }
    const maxChars = Math.min(1000, Math.max(10, Number(this.config.imageGenMaxPromptChars) || 400))
    if (prompt.length > maxChars) prompt = prompt.slice(0, maxChars)
    const key = this.#routeKey(message)
    const now = Date.now()
    const cooldown = Math.max(10, Number(this.config.imageGenCooldownSeconds) || 60) * 1000
    const since = now - (this.genLastAt.get(key) ?? 0)
    if (since < cooldown) {
      await this.#safeReply(message, `画得太快啦～小鲸鱼要喘口气，再等 ${Math.ceil((cooldown - since) / 1000)} 秒吧`)
      return
    }
    const today = new Date().toDateString()
    const daily = this.genDaily.get(key)
    const dailyLimit = Math.max(1, Number(this.config.imageGenDailyLimit) || 20)
    if (daily && daily.date === today && daily.count >= dailyLimit) {
      await this.#safeReply(message, '今天画得够多啦，明天再来吧～')
      return
    }
    this.genLastAt.set(key, now)
    this.genDaily.set(key, daily && daily.date === today ? { date: today, count: daily.count + 1 } : { date: today, count: 1 })
    await this.#safeReply(message, '🎨 正在努力作画，稍等十几秒哦～')
    try {
      const { buffer } = await generateImage(this.config, prompt)
      if (!buffer || buffer.length === 0) throw new Error('生成结果为空')
      mkdirSync(this.imageDir, { recursive: true })
      const file = join(this.imageDir, `gen-${Date.now().toString(36)}.png`)
      writeFileSync(file, buffer)
      const targetId = message.messageType === 'group' ? message.groupId : message.userId
      await this.server.sendSegments(message.bot, message.messageType, targetId, [{ type: 'image', data: { file } }])
      debugLog(`image gen sent (${buffer.length} bytes)`)
    } catch (error) {
      debugLog(`image gen failed: ${error.message}`)
      await this.#safeReply(message, `生图失败：${error.message.slice(0, 60)}`)
    }
  }

  /** Convert a wav file to mp3 with ffmpeg; resolves to the mp3 path. */
  #convertToMp3(wavFile) {
    return new Promise((resolve, reject) => {
      const out = wavFile.replace(/\.wav$/i, '') + '.mp3'
      execFile(this.config.ffmpegPath || 'ffmpeg', ['-y', '-i', wavFile, '-codec:a', 'libmp3lame', '-q:a', '4', out], { timeout: 60_000 }, (error) => {
        if (error) {
          reject(error)
          return
        }
        try { unlinkSync(wavFile) } catch { /* best effort */ }
        resolve(out)
      })
    })
  }

  /** /health：主机与插件运行状况一览。 */
  async #handleHealth(message) {
    const key = this.#routeKey(message)
    const entry = this.sessions.get(key)
    const lines = [
      `插件版本：${this.pluginVersion}`,
      `机器人 QQ：${this.config.botQq || '未配置'}`,
      `宿主运行：${Math.round(process.uptime() / 60)} 分钟`,
      `当前会话：${entry ? entry.sessionId.slice(0, 8) : '无'}`,
      `全部会话数：${this.sessions.size}`,
      `待执行提醒：${this.reminders.size} 个`,
      `进行中投票：${this.votes.size} 个`,
      `本会话记忆条数：${this.#loadMemoryLines(key).length}`,
      `识图：${this.config.visionMode}（${this.config.visionToolName}）`,
      `语音转文字：${this.config.sttEnabled ? '开' : '关'}｜语音回复：${this.config.ttsEnabled ? '开' : '关'}`,
      `会话续接：${this.config.sessionResumeEnabled === false ? '关' : `开（已记录 ${Object.keys(this.sessionStore.read() ?? {}).length} 个会话）`}`,
      `写操作闸门：${this.gate.denied} 次被拒｜${this.config.actionAuditEnabled === false ? '审计关' : '审计开'}`,
      `避开高峰期：${this.config.quietHoursEnabled ? `开（${(this.config.quietHours ?? []).join(' / ')}，${this.config.quietWeekendExempt ? '周末豁免' : '含周末'}）` : '关'}`,
    ]
    await this.#safeReply(message, `📊 小鲸鱼状态\n${lines.join('\n')}`)
  }

  /** /export：把本会话持久化记录导出为 markdown 文件。 */
  async #handleExport(message) {
    const key = this.#routeKey(message)
    const lines = this.#loadMemoryLines(key)
    if (lines.length === 0) {
      await this.#safeReply(message, '当前会话没有可导出的记录（可能刚重启或聊天太少）。')
      return
    }
    try {
      mkdirSync(this.exportsDir, { recursive: true })
      const name = `${String(key).replace(/[^\w-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.md`
      const file = join(this.exportsDir, name)
      writeFileSync(file, `# ${key} 聊天记录导出\n\n` + lines.map((l) => `- ${l}`).join('\n') + '\n', 'utf8')
      await this.#safeReply(message, `✅ 已导出 ${lines.length} 条记录到：${file}`)
      debugLog(`export written ${file}`)
    } catch (error) {
      await this.#safeReply(message, `⚠️ 导出失败：${error.message.slice(0, 80)}`)
    }
  }

  /** OneBot notice 事件分发：戳一戳 / 入群欢迎 / 撤回。 */
  async #onNotice(notice) {
    if (this.stopped) return
    if (this.config.recordInbound !== false && notice.__injected !== true && notice.__replayed !== true) this.inbox.record('notice', notice)
    const trace = this.#beginEventTrace('notice', notice)
    const mark = (stage, ok = true, reason = '', data = null, level = 'info') => trace?.mark(stage, { ok, reason, data, level })
    try {
      if (notice.noticeType === 'notify' && notice.subType === 'poke' && this.config.pokeEnabled) {
        const poke = await this.#handlePoke(notice)
        mark('notice', poke?.ok === true, poke?.ok === true ? '戳一戳已回复' : `戳一戳未回复：${poke?.reason ?? '未知原因'}`, null, poke?.ok === true ? 'info' : 'debug')
        return
      }
      if (notice.noticeType === 'group_increase' && this.config.welcomeEnabled) {
        await this.#handleWelcome(notice)
        mark('notice', true, '入群欢迎已发送')
        return
      }
      if (isRecallNotice(notice) && this.config.antiRecallEnabled) {
        await this.#handleRecallNotice(notice)
        mark('notice', true, '防撤回已处理')
        return
      }
      mark('notice', false, `未处理的 notice：${notice.noticeType}/${notice.subType}`
        + (notice.noticeType === 'notify' && notice.subType === 'poke' && !this.config.pokeEnabled ? '（pokeEnabled=false）' : '')
        + (notice.noticeType === 'group_increase' && !this.config.welcomeEnabled ? '（welcomeEnabled=false）' : '')
        + (isRecallNotice(notice) && !this.config.antiRecallEnabled ? '（antiRecallEnabled=false）' : ''))
    } catch (error) {
      debugLog(`notice handling failed: ${error.message}`)
      mark('notice', false, `notice 处理失败：${error.message}`, null, 'error')
    }
  }

  /** 缓存一条入站消息，供防撤回补发（群聊与私聊都记）。 */
  #rememberForRecall(message, text) {
    try {
      const images = (message.images ?? []).map((image) => image?.url ?? '').filter((url) => /^https?:\/\//.test(url))
      this.recallCache.remember(this.#chatKeyOf(this.#routeOf(message)), {
        messageId: message.messageId,
        userId: message.userId,
        name: message.senderName || String(message.userId),
        text,
        images,
      })
    } catch (error) {
      debugLog(`recall cache failed: ${error.message}`)
    }
  }

  /** 防撤回：把撤回的内容补发到群里（或私聊管理员）。 */
  async #handleRecallNotice(notice) {
    const isGroup = notice.groupId !== undefined && notice.groupId !== 0
    if (isGroup) {
      if (!this.config.allowGroups.includes(notice.groupId)) return
      if (this.config.allowUsers.length > 0 && !this.config.allowUsers.includes(notice.userId)) return
    } else if (!this.config.allowUsers.includes(notice.userId)) {
      return
    }
    const chatKey = isGroup ? `g:${notice.groupId}` : `u:${notice.userId}`
    const entry = this.recallCache.recall(chatKey, notice.messageId)
    if (!entry) {
      debugLog(`recall notice without cached message id=${notice.messageId}`)
      return
    }
    // 机器人自己撤回过的东西不补发（那是它主动撤回的）。
    if (notice.operatorId === this.config.botQq || entry.userId === this.config.botQq) return
    const cooldown = Math.max(2, Number(this.config.antiRecallCooldownSeconds) || 5) * 1000
    const last = this.recallLastAt.get(chatKey) ?? 0
    if (Date.now() - last < cooldown) {
      debugLog('anti-recall rate limited')
      return
    }
    this.recallLastAt.set(chatKey, Date.now())
    const notice2 = formatRecallNotice(entry, { botName: this.config.botName || '小鲸鱼' })
    const text = typeof notice2 === 'string' ? notice2 : notice2.text
    const images = (typeof notice2 === 'object' && Array.isArray(notice2.images)) ? notice2.images : []
    const postInGroup = isGroup && this.config.antiRecallInGroup !== false
    const route = postInGroup
      ? { bot: notice.bot, messageType: 'group', targetId: notice.groupId }
      : { bot: notice.bot, messageType: 'private', targetId: (this.config.adminUsers ?? [])[0] }
    if (!route.targetId) {
      debugLog('anti-recall has nowhere to post (no adminUsers)')
      return
    }
    const result = await this.gate.run('anti_recall_notice', chatKey, `id=${notice.messageId}`, () => this.server.sendSegments(
      route.bot, route.messageType, route.targetId, [{ type: 'text', data: { text } }],
    ))
    if (!result.ok) {
      debugLog(`anti-recall denied: ${result.reason}`)
      return
    }
    if (this.config.antiRecallImages !== false && images.length > 0 && postInGroup) {
      try {
        await this.server.sendSegments(route.bot, route.messageType, route.targetId,
          images.slice(0, 3).map((url) => ({ type: 'image', data: { file: url } })))
      } catch (error) {
        debugLog(`anti-recall image resend failed: ${error.message}`)
      }
    }
    debugLog(`anti-recall posted (${chatKey} u${entry.userId})`)
  }

  /** 敏感词 / 刷屏拦截。返回 true 表示这条消息已被处理，不再进入模型。 */
  async #handleContentFilter(message, text) {
    if (this.#isAdmin(message)) return false
    const chatKey = this.#chatKeyOf(this.#routeOf(message))
    const groupId = message.messageType === 'group' ? message.groupId : 0
    const socket = this.server.currentSocket()

    if (this.config.floodEnabled) {
      const flood = this.floodGuard.observe(chatKey, message.userId)
      if (flood.action === 'mute' && groupId && socket) {
        const result = await this.gate.run('set_group_ban', `g:${groupId}`, `flood u${message.userId}`, () => this.server.setGroupBan(socket, groupId, message.userId, flood.muteSeconds))
        if (result.ok) {
          await this.#safeReply(message, `🔇 ${message.senderName || message.userId} 刷屏太猛啦，先冷静 ${Math.round(flood.muteSeconds / 60)} 分钟吧。`)
        }
        return true
      }
      if (flood.action === 'warn') {
        await this.#safeReply(message, `⚠️ ${message.senderName || '你'} 慢一点哦，刷屏会被禁言的（${flood.strike}/${Math.max(1, Number(this.config.floodStrikeLimit) || 3)}）。`)
        return true
      }
    }

    if (this.config.filterEnabled && text !== '') {
      const filter = this.#wordFilter()
      const hit = filter.check(text)
      if (!hit.hit) return false
      const action = String(this.config.filterAction || 'warn')
      debugLog(`badword hit g${groupId} u${message.userId} word=${hit.word}`)
      if (action === 'recall' && groupId && socket) {
        const result = await this.gate.run('delete_msg', `g:${groupId}`, `badword u${message.userId}`, () => this.server.deleteMsg(socket, message.messageId))
        if (result.ok) await this.#safeReply(message, `🚫 ${message.senderName || '你'} 的消息包含敏感词，已撤回。`)
        return true
      }
      if (action === 'mute' && groupId && socket) {
        const seconds = Math.max(60, Number(this.config.filterMuteSeconds) || 300)
        const result = await this.gate.run('set_group_ban', `g:${groupId}`, `badword u${message.userId}`, () => this.server.setGroupBan(socket, groupId, message.userId, seconds))
        if (result.ok) await this.#safeReply(message, `🔇 ${message.senderName || '你'} 的消息包含敏感词，禁言 ${Math.round(seconds / 60)} 分钟。`)
        return true
      }
      await this.#safeReply(message, `⚠️ ${message.senderName || '你'} 的消息包含敏感词，请注意群规。`)
      return true
    }
    return false
  }

  /** 词表（按 mtime 热重载，方便直接编辑文件生效）。 */
  #wordFilter() {
    let stamp = 'missing'
    try {
      const stat = statSync(this.badWordsFile)
      stamp = `${stat.mtimeMs}:${stat.size}`
    } catch { /* 文件不存在：空过滤器 */ }
    if (this.badWordsCache.stamp === stamp) return this.badWordsCache.filter
    const whitelist = this.config.filterWhitelist ?? []
    let filter = new WordFilter({ whitelist })
    try {
      const parsed = parseWordList(readFileSync(this.badWordsFile, 'utf8'))
      filter = new WordFilter({
        words: [...parsed.words, ...parsed.patterns.map((re) => `re:${re.source}`)],
        whitelist,
      })
      if (parsed.invalid.length > 0) debugLog(`badword list has ${parsed.invalid.length} invalid entries`)
    } catch { /* 读不到就当空词表 */ }
    this.badWordsCache = { stamp, filter }
    debugLog(`badword list loaded (${filter.size} entries)`)
    return filter
  }

  /** OneBot request 事件（加群/加好友）：入群验证开启时登记并推送管理员，否则只记日志。 */
  async #onRequest(request) {
    if (this.stopped) return
    if (this.config.recordInbound !== false && request.__injected !== true && request.__replayed !== true) this.inbox.record('request', request)
    const trace = this.#beginEventTrace('request', request)
    const mark = (stage, ok = true, reason = '', data = null, level = 'info') => trace?.mark(stage, { ok, reason, data, level })
    debugLog(`request ${request.requestType}/${request.subType} u${request.userId} g${request.groupId} flag=${String(request.flag).slice(0, 16)}`)
    if (!this.config.verifyEnabled) {
      mark('request', false, 'verifyEnabled=false，入群验证未开启（请求未入队）')
      return
    }
    try {
      // 群白名单外的群不处理（私聊/好友请求按 allowUsers 判断）。
      if (request.requestType === 'group' && request.groupId && !this.config.allowGroups.includes(request.groupId)) {
        mark('request', false, `群 ${request.groupId} 不在 allowGroups 白名单`)
        return
      }
      const pending = this.joinGuard.addRequest({
        flag: request.flag,
        userId: request.userId,
        groupId: request.groupId,
        subType: request.subType,
        comment: request.comment,
        name: request.name ?? '',
      })
      if (!pending) {
        debugLog('join guard full, request ignored')
        mark('request', false, '待审批队列已满（verifyMaxPending）', null, 'warn')
        return
      }
      // 自带口令（verifyKeyword）直接放行，其余等管理员审批。
      const keyword = String(this.config.verifyKeyword || '').trim()
      if (keyword && request.comment.includes(keyword)) {
        const ok = await this.#resolveJoin(pending.entry, true)
        debugLog(`join request keyword auto-approve #${pending.id} → ${ok ? 'sent' : 'denied/kept pending'}`)
        mark('request', ok, ok ? `口令命中，自动批准 #${pending.id}` : `口令命中但写操作被闸门拒绝，仍待审批 #${pending.id}`, null, ok ? 'info' : 'warn')
        if (ok) await this.#notify(`✅ 已按口令自动批准 #${pending.id}（${request.userId}）`)
        return
      }
      const prompt = formatJoinPrompt(pending.entry, { groupName: '' })
      const text = `${prompt}\n\n（把验证问题发给申请人，对方答对后回复 /同意 ${pending.id}）`
      await this.#notifyAdmin(text)
      mark('request', true, `请求 #${pending.id} 已入队并推送管理员`)
      debugLog(`join request pending #${pending.id} u${request.userId}`)
      this.#writeRuntimeSnapshot(true)
    } catch (error) {
      debugLog(`request handling failed: ${error.message}`)
      mark('request', false, `request 处理失败：${error.message}`, null, 'error')
    }
  }

  /** 私聊推送一条文本给所有管理员（用于请求审批等）。 */
  async #notifyAdmin(text) {
    const admins = Array.isArray(this.config.adminUsers) ? this.config.adminUsers : []
    const socket = this.server.currentSocket()
    if (!socket || admins.length === 0) {
      debugLog('no admin to notify')
      return
    }
    for (const admin of admins.slice(0, 3)) {
      try {
        await this.server.sendSegments(socket, 'private', admin, [{ type: 'text', data: { text } }])
      } catch (error) {
        debugLog(`admin notify failed (${admin}): ${error.message}`)
      }
    }
  }

  /** 管理员审批命令：/同意 N、/拒绝 N、/同意 all、/待审。 */
  async #handleVerifyCommand(message, cmd) {
    if (cmd.action === 'list') {
      await this.#safeReply(message, formatPendingList(this.joinGuard.list()))
      return
    }
    if (!cmd.target) {
      await this.#safeReply(message, '用法：/同意 序号、/拒绝 序号、/同意 all、/待审')
      return
    }
    if (cmd.target === 'all') {
      const entries = this.joinGuard.list()
      if (entries.length === 0) {
        await this.#safeReply(message, '📭 暂无待处理请求。')
        return
      }
      let done = 0
      for (const entry of entries) {
        if (await this.#resolveJoin(entry, cmd.action === 'approve')) done += 1
      }
      await this.#safeReply(message, `✅ 已处理 ${done}/${entries.length} 条请求。`)
      return
    }
    const entry = this.joinGuard.find(cmd.target)
    if (!entry) {
      await this.#safeReply(message, `⚠️ 没有 #${cmd.target} 这条待处理请求（用 /待审 查看）。`)
      return
    }
    const ok = await this.#resolveJoin(entry, cmd.action === 'approve')
    await this.#safeReply(message, ok
      ? `${cmd.action === 'approve' ? '✅ 已批准' : '⛔ 已拒绝'} #${entry.id}（${entry.userId}）`
      : `⚠️ 处理 #${entry.id} 失败，请查看宿主日志。`)
  }

  /** 执行一次审批（走写操作闸门）。 */
  async #resolveJoin(entry, approve) {
    const socket = this.server.currentSocket()
    if (!socket) return false
    const isGroup = entry.groupId !== 0
    const action = isGroup ? 'set_group_add_request' : 'set_friend_add_request'
    const result = await this.gate.run(action, 'verify', `#${entry.id} ${approve ? 'ok' : 'no'}`, () => (isGroup
      ? this.server.setGroupAddRequest(socket, entry.flag, entry.subType, approve, '')
      : this.server.setFriendAddRequest(socket, entry.flag, approve, '')))
    if (!result.ok) {
      debugLog(`verify resolve denied: ${result.reason}`)
      return false
    }
    this.joinGuard.resolve(entry.id, approve)
    debugLog(`join request #${entry.id} ${approve ? 'approved' : 'rejected'}`)
    return true
  }

  /** 申请人答对验证题时自动放行（管理员也可手动 /同意）。返回 true 表示已消费该消息。 */
  async #handleJoinAnswer(message, text) {
    const pending = this.joinGuard.list().find((entry) => entry.userId === message.userId)
    if (!pending) return false
    if (!checkVerifyAnswer(pending, text)) {
      // 只在看起来像在答题（短数字）时提醒一次，避免打扰。
      if (/^[^\d]{0,6}\d{1,4}[^\d]{0,3}$/.test(text)) {
        await this.#safeReply(message, `❌ 答案不对哦，再想想：${pending.question}`)
      }
      return true
    }
    const ok = await this.#resolveJoin(pending, true)
    if (ok) {
      await this.#safeReply(message, '✅ 验证通过，已放行～')
      await this.#notify(`✅ 申请人 ${message.userId} 答对验证题，#${pending.id} 已放行`)
      debugLog(`join answer accepted #${pending.id}`)
    }
    return true
  }

  /** 定期清理超时的待审批请求并提醒管理员。 */
  #startVerifySweeper() {
    if (!this.config.verifyEnabled) return
    const timer = setInterval(() => {
      if (this.stopped) return
      const expired = this.joinGuard.expire()
      if (expired.length > 0) {
        debugLog(`join requests expired: ${expired.map((entry) => `#${entry.id}`).join(',')}`)
        void this.#notifyAdmin(`⏰ 有 ${expired.length} 条入群/加好友请求已超时未处理：${expired.map((entry) => `#${entry.id}(${entry.userId})`).join('、')}`)
      }
    }, 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.add(timer)
  }

  /** 戳一戳：白名单会话内被戳时随机回一条卖萌文案（每会话限频）。 */
  async #handlePoke(notice) {
    const isGroup = notice.groupId !== undefined
    if (isGroup) {
      if (!this.config.allowGroups.includes(notice.groupId)) return { ok: false, reason: '群不在 allowGroups 白名单' }
      if (this.config.allowUsers.length > 0 && !this.config.allowUsers.includes(notice.userId)) return { ok: false, reason: '戳的人不在 allowUsers 白名单' }
    } else {
      if (!this.config.allowUsers.includes(notice.userId)) return { ok: false, reason: '私聊用户不在 allowUsers 白名单' }
    }
    // 戳的目标不是机器人本人则忽略（targetId 缺省时视为戳机器人）。
    if (notice.targetId !== undefined && notice.targetId !== (this.config.botQq ?? 0)) return { ok: false, reason: '戳的目标不是机器人本人' }
    const key = isGroup ? `poke:g:${notice.groupId}` : `poke:u:${notice.userId}`
    const now = Date.now()
    const cooldown = Math.max(5, Number(this.config.pokeCooldownSeconds) || 15) * 1000
    if (now - (this.lastPokeAt.get(key) ?? 0) < cooldown) return { ok: false, reason: `戳一戳冷却中（${Math.round(cooldown / 1000)}s）` }
    this.lastPokeAt.set(key, now)
    const replies = Array.isArray(this.config.pokeReplies) && this.config.pokeReplies.length > 0
      ? this.config.pokeReplies
      : ['别戳啦，小鲸鱼要吐泡泡了～']
    const line = replies[Math.floor(Math.random() * replies.length)]
    const targetId = isGroup ? notice.groupId : notice.userId
    await this.server.sendSegments(notice.bot, isGroup ? 'group' : 'private', targetId, [{ type: 'text', data: { text: line } }])
    debugLog(`poke replied (${isGroup ? `g${notice.groupId}` : `u${notice.userId}`})`)
    return { ok: true, reason: '' }
  }

  /** 入群欢迎：群成员加入时 @ 新人 + 欢迎语（机器人自己入群不触发）。 */
  async #handleWelcome(notice) {
    if (notice.userId === notice.selfId) return
    if (!this.config.allowGroups.includes(notice.groupId)) return
    const text = String(this.config.welcomeText || '').trim() ||
      '欢迎新朋友入群～我是小鲸鱼，@我聊天、说「签到」打卡都可以哦！'
    await this.server.sendSegments(notice.bot, 'group', notice.groupId, [
      { type: 'at', data: { qq: String(notice.userId) } },
      { type: 'text', data: { text: ` ${text}` } },
    ])
    debugLog(`welcome sent (g${notice.groupId} u${notice.userId})`)
  }

  /** /help：命令帮助（按功能开关与管理员身份动态展示）。 */
  async #handleHelp(message) {
    const isAdmin = this.#isAdmin(message)
    const lines = [
      '🐋 小鲸鱼使用指南',
      '· 聊天：群里 @我 说话，或直接私聊我',
      '· /new 新对话 · /status 会话状态 · /health 运行诊断',
      '· 提醒：「30分钟后提醒我喝水」· /reminders 查看提醒',
      '· /summary 群聊总结 · 投票：「投票：问题？A xx B xx」',
      '· 待办：「/todo add xx」或「记一下：xx」',
      '· /撤回 撤回我上一条消息 · /export 导出聊天记录 · /help 本菜单',
    ]
    if (this.config.voiceReadingEnabled) {
      lines.push('· 语音朗读：@我 引用文字说「读一下」，或 /读 要读的内容')
    }
    if (this.config.imageGenEnabled) {
      lines.push(`· 生图：${this.config.imageGenCommand || '/画'} 描述词（群聊需 @我）`)
    }
    if (this.config.sttEnabled) {
      lines.push('· 语音转文字：@我 并引用一条语音')
    }
    if (this.config.checkinEnabled) {
      lines.push(`· 签到：说「${this.config.checkinKeyword || '签到'}」打卡 · 签到榜 看排行`)
    }
    if (this.config.fortuneEnabled) {
      lines.push('· 今日人品 / 运势 / 抽签 / 塔罗：直接说「今日人品」「抽签」「塔罗」')
    }
    if (this.config.diceEnabled) {
      lines.push('· 骰子：.r 3d6 · 随机抽人：/抽一个 A B C')
    }
    if (this.config.pointsEnabled) {
      lines.push('· 积分：/积分 查余额 · /排行榜 看排行 · /转账 @某人 数量')
    }
    if (this.config.gameEnabled) {
      lines.push('· 小游戏：说「接龙」或「猜数字」开始，说「不玩了」结束')
    }
    if (this.config.statsEnabled) {
      lines.push('· 活跃榜：/统计（今日）· /周榜（本周）')
    }
    if (this.config.groupReadEnabled !== false && message.messageType === 'group') {
      lines.push('· 群信息：/荣誉 · /公告 · /群精华（只读查询）')
    }
    if (this.config.mcStatusEnabled !== false) {
      lines.push('· MC 服务器状态：/mc mc.example.com:25565')
    }
    if (this.config.dailyReportEnabled && this.config.adminEnabled && isAdmin) {
      lines.push('· 每日日报：/日报 查看 · /日报 on|off 开关本群日报')
    }
    if (this.config.keywordEnabled && this.config.adminEnabled && isAdmin) {
      lines.push('· 词库：/kw add 触发词 回复内容 · /kw del 触发词 · /kw list')
    }
    if (this.config.adminEnabled && isAdmin) {
      lines.push('· 管理：/mute /unmute /kick /clear（踢人需二次确认）')
      if (message.messageType === 'group') {
        lines.push('· 群管：/公告 内容 · /全员禁言 · /解除全员禁言 · /精华（引用消息）· /名片 @某人 名字 · /头衔 @某人 头衔')
      }
    }
    if (this.config.antiRecallEnabled) {
      lines.push('· 防撤回：有人撤回消息会补发内容（可在配置里关闭）')
    }
    if (this.config.filterEnabled || this.config.floodEnabled) {
      lines.push('· 群规：敏感词与刷屏会被提醒/撤回/禁言')
    }
    if (this.config.verifyEnabled && this.config.adminEnabled && isAdmin) {
      lines.push('· 入群审批：/待审 看列表 · /同意 序号 · /拒绝 序号 · /同意 all')
    }
    await this.#safeReply(message, lines.join('\n'))
  }

  /** 每日签到：记录连续/累计天数。 */
  async #handleCheckin(message) {
    const key = this.#routeKey(message)
    const name = message.senderName || ''
    const { firstToday, streak, total } = this.checkinStore.checkin(key, message.userId, name)
    if (!firstToday) {
      await this.#safeReply(message, `今天已经打过卡啦～（连续 ${streak} 天 · 累计 ${total} 天）明天再来哦！`)
      return
    }
    const extra = streak >= 7 ? ' 🏆 全勤小标兵！' : streak >= 3 ? ' 再接再厉！' : ''
    let bonusLine = ''
    const bonus = Math.max(0, Number(this.config.pointsCheckinBonus) || 0)
    if (this.config.pointsEnabled && bonus > 0) {
      const total2 = this.pointsStore.add(key, message.userId, bonus, { name })
      bonusLine = `（+${bonus} 积分，共 ${total2}）`
    }
    await this.#safeReply(message, `✅ ${name || '你'} 打卡成功！连续 ${streak} 天 · 累计 ${total} 天${extra}${bonusLine}`)
    debugLog(`checkin u${message.userId} streak=${streak} total=${total}`)
  }

  /** 签到排行榜。 */
  async #handleCheckinBoard(message) {
    const board = this.checkinStore.board(this.#routeKey(message), 10)
    if (board.length === 0) {
      await this.#safeReply(message, '还没有人打过卡，快来说「签到」当第一名吧！')
      return
    }
    const lines = ['📊 签到排行榜']
    board.forEach((entry, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`
      const today = entry.today ? '✅' : '·'
      lines.push(`${medal} ${entry.name} ${today} 连续 ${entry.streak} 天 / 累计 ${entry.total} 天`)
    })
    await this.#safeReply(message, lines.join('\n'))
  }

  /** 私聊文件转存：下载用户发来的文件到 cwd/qq-files/。 */
  async #handlePrivateFiles(message) {
    const lines = []
    for (const f of (message.files ?? []).slice(0, 4)) {
      const url = f.url
      if (url && /^https?:\/\//.test(url)) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(90_000) })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const buffer = Buffer.from(await response.arrayBuffer())
          if (buffer.length === 0) throw new Error('空文件')
          const maxBytes = Math.max(1, Number(this.config.fileTransferMaxBytes) || 50 * 1024 * 1024)
          if (buffer.length > maxBytes) throw new Error('文件过大（超限）')
          mkdirSync(this.filesDir, { recursive: true })
          let name = f.name ? basename(String(f.name)) : `file-${Date.now().toString(36)}`
          let file = join(this.filesDir, name)
          if (existsSync(file)) {
            const stem = name.replace(/\.[^.]+$/, '')
            const ext = extname(name)
            file = join(this.filesDir, `${stem}-${Date.now().toString(36)}${ext}`)
          }
          writeFileSync(file, buffer)
          lines.push(`✅ 已保存：${file}（${Math.round(buffer.length / 1024)} KB）`)
          debugLog(`file saved ${file}`)
        } catch (error) {
          debugLog(`file transfer failed: ${error.message}`)
          lines.push(`⚠️ 保存失败：${error.message.slice(0, 60)}`)
        }
      } else {
        lines.push(`⚠️ 文件「${f.name || '未知'}」没有可下载链接`)
      }
    }
    await this.#safeReply(message, lines.join('\n'))
  }

  #isAdmin(message) {
    return Array.isArray(this.config.adminUsers) && this.config.adminUsers.includes(message.userId)
  }

  /** /summary：把本会话的持久化聊天记录交给 agent 总结。 */
  async #handleSummary(message) {
    const key = this.#routeKey(message)
    const lines = this.#loadMemoryLines(key)
    if (lines.length === 0) {
      await this.#safeReply(message, '我还没有记住这个会话的聊天记录（可能刚重启或聊天太少）。')
      return
    }
    const entry = await this.#ensureSession(message)
    this.#handoff(entry, message, {
      content: [{ type: 'text', text: `请把以下本会话最近的聊天记录总结成要点（分条列出：谁、说了什么、重要结论；如有 @我的内容请标出）：\n${lines.join('\n')}` }],
      source: { kind: 'user' },
    })
    debugLog('summary requested')
  }

  /** 投票：start / show / end / count / publish。 */
  async #startVote(message, vc) {
    if (message.messageType !== 'group') {
      await this.#safeReply(message, '⚠️ 投票仅支持群聊。')
      return
    }
    const key = this.#routeKey(message)
    if (this.votes.has(key)) {
      await this.#safeReply(message, '⚠️ 本群已有进行中的投票，先 /vote-end 结束再开新的。')
      return
    }
    const durationMs = Math.max(10, Number(this.config.voteDurationSeconds) || 300) * 1000
    const vote = {
      question: vc.question,
      options: vc.options,
      votes: new Map(),
      route: { messageType: 'group', targetId: message.groupId },
      // 注入帧发起的投票：到点时只记事件，不把结果发进 QQ
      ...(message.__injected === true ? { injected: true } : {}),
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.votes.delete(key)
      void this.#publishVote(vote)
    }, durationMs)
    vote.timer = timer
    this.timers.add(timer)
    this.votes.set(key, vote)
    const lines = vc.options.map((o) => `${o.key}：${o.label}`)
    await this.#safeReply(message, `🗳️ 投票开始（${Math.round(durationMs / 60_000)} 分钟后截止）：${vc.question}\n${lines.join('\n')}\n群友直接回复选项字母投票；/vote 查进度，/vote-end 提前结束。`)
  }

  async #showVote(message) {
    const key = this.#routeKey(message)
    const vote = this.votes.get(key)
    if (!vote) {
      await this.#safeReply(message, '当前没有进行中的投票。发起方式：「投票：问题？A 选项 B 选项」。')
      return
    }
    const counts = {}
    for (const o of vote.options) counts[o.key] = 0
    for (const k of vote.votes.values()) counts[k] = (counts[k] ?? 0) + 1
    const lines = vote.options.map((o) => `${o.key} ${o.label}：${counts[o.key] ?? 0} 票`)
    await this.#safeReply(message, `🗳️ ${vote.question}\n${lines.join('\n')}\n共 ${vote.votes.size} 人已投。`)
  }

  async #endVote(message) {
    const key = this.#routeKey(message)
    const vote = this.votes.get(key)
    if (!vote) {
      await this.#safeReply(message, '当前没有进行中的投票。')
      return
    }
    this.votes.delete(key)
    if (vote.timer) {
      clearTimeout(vote.timer)
      this.timers.delete(vote.timer)
    }
    await this.#publishVote(vote)
  }

  async #publishVote(vote) {
    // 注入帧发起的投票：到点（或 /vote-end）只记事件，不把结果发进 QQ
    if (this.#injectedTaskBlocked({ ...vote, key: this.#chatKeyOf(vote.route) }, '投票结果')) return
    const counts = {}
    for (const o of vote.options) counts[o.key] = 0
    for (const k of vote.votes.values()) counts[k] = (counts[k] ?? 0) + 1
    const lines = vote.options.map((o) => `${o.key} ${o.label}：${counts[o.key] ?? 0} 票`)
    const socket = this.server.currentSocket()
    if (!socket) {
      debugLog('vote publish skipped: no socket')
      return
    }
    try {
      await this.server.sendSegments(socket, vote.route.messageType, vote.route.targetId, [{ type: 'text', data: { text: `🗳️ 投票结束：${vote.question}\n${lines.join('\n')}\n共 ${vote.votes.size} 人参与。` } }])
      debugLog('vote published')
    } catch (error) {
      debugLog(`vote publish failed: ${error.message}`)
    }
  }

  /** Count a group message as a vote when it matches an active vote option. */
  async #maybeVote(message) {
    if (message.messageType !== 'group') return false
    const key = this.#routeKey(message)
    const vote = this.votes.get(key)
    if (!vote) return false
    const t = message.text.trim()
    const opt = vote.options.find((o) => o.key === t.toUpperCase() || o.label === t)
    if (!opt) return false
    vote.votes.set(message.userId, opt.key)
    debugLog(`vote counted u${message.userId} -> ${opt.key}`)
    return true
  }

  /** 共享待办：/todo add|list|done|clear 与「记一下：xxx」。 */
  async #handleTodo(message, arg) {
    const key = this.#routeKey(message)
    const store = new TodoStore(this.todoDir)
    if (arg === '' || arg === 'list') {
      const list = store.load(key)
      if (list.length === 0) {
        await this.#safeReply(message, '待办清单是空的。用「/todo add xxx」或「记一下：xxx」添加。')
        return
      }
      const pending = list.filter((t) => !t.done)
      const done = list.filter((t) => t.done)
      const lines = []
      pending.forEach((t, i) => { lines.push(`${i + 1}. ${t.text}`) })
      const text = `待办清单（${pending.length} 件待完成）：\n${lines.length ? lines.join('\n') : '（全部完成 ✅）'}` + (done.length ? `\n已完成 ${done.length} 件（/todo clear 清除已完成）。` : '')
      await this.#safeReply(message, text)
      return
    }
    if (arg.startsWith('add ')) {
      const item = arg.slice(4).trim()
      if (item === '') {
        await this.#safeReply(message, '用法：/todo add 内容')
        return
      }
      const list = store.load(key)
      list.push({ id: `t${Date.now().toString(36)}`, text: item, done: false, ts: Date.now() })
      store.save(key, list)
      await this.#safeReply(message, `✅ 已添加待办：${item}`)
      return
    }
    const doneMatch = /^done\s+(\d+)$/.exec(arg)
    if (doneMatch) {
      const idx = Number(doneMatch[1]) - 1
      const list = store.load(key)
      const pending = list.filter((t) => !t.done)
      if (idx < 0 || idx >= pending.length) {
        await this.#safeReply(message, '⚠️ 序号无效（用 /todo 查看当前序号）。')
        return
      }
      pending[idx].done = true
      store.save(key, list)
      await this.#safeReply(message, `✅ 已完成：${pending[idx].text}`)
      return
    }
    if (arg === 'clear') {
      const list = store.load(key).filter((t) => !t.done)
      store.save(key, list)
      await this.#safeReply(message, '✅ 已清除已完成的待办。')
      return
    }
    await this.#safeReply(message, '用法：/todo（查看）| /todo add xxx（添加）| /todo done 序号（完成）| /todo clear（清除已完成）')
  }

  /** 管理员命令：/mute /unmute /kick（二次确认）/clear + 群管套件（公告/精华/名片/头衔/全员禁言）。 */
  async #handleAdminCommand(message, cmd, arg) {
    const groupOnly = cmd === 'mute' || cmd === 'unmute' || cmd === 'kick' ||
      cmd === '公告' || cmd === '精华' || cmd === '取消精华' || cmd === '名片' ||
      cmd === '头衔' || cmd === '全员禁言' || cmd === '解除全员禁言'
    if (groupOnly && message.messageType !== 'group') {
      await this.#safeReply(message, '⚠️ 该命令仅支持群聊。')
      return
    }
    const key = this.#routeKey(message)
    if (cmd === 'clear') {
      await this.#rotate(message)
      this.#clearMemory(key)
      await this.#safeReply(message, '✅ 会话与持久化记忆已清空。')
      return
    }
    const socket = this.server.currentSocket()
    if (!socket) {
      await this.#safeReply(message, '⚠️ 当前无可用连接，稍后再试。')
      return
    }

    // ---- 群公告 ----
    if (cmd === '公告') {
      if (!arg) {
        await this.#safeReply(message, '用法：/公告 公告内容')
        return
      }
      const result = await this.gate.run('_send_group_notice', `g:${message.groupId}`, 'admin', () => this.server.sendGroupNotice(socket, message.groupId, arg.slice(0, 500)))
      await this.#safeReply(message, result.ok ? '✅ 群公告已发布。' : `⚠️ 发布失败：${result.reason}`)
      return
    }

    // ---- 全员禁言 ----
    if (cmd === '全员禁言' || cmd === '解除全员禁言') {
      const enable = cmd === '全员禁言'
      const result = await this.gate.run('set_group_whole_ban', `g:${message.groupId}`, enable ? 'on' : 'off', () => this.server.setGroupWholeBan(socket, message.groupId, enable))
      await this.#safeReply(message, result.ok ? (enable ? '🔇 已开启全员禁言。' : '🔊 已解除全员禁言。') : `⚠️ 操作失败：${result.reason}`)
      return
    }

    // ---- 精华（对引用消息）----
    if (cmd === '精华' || cmd === '取消精华') {
      const messageId = message.reply?.messageId
      if (!messageId) {
        await this.#safeReply(message, '用法：@我 并引用一条消息，发送 /精华 或 /取消精华')
        return
      }
      const action = cmd === '精华' ? 'set_essence_msg' : 'delete_essence_msg'
      const call = cmd === '精华' ? () => this.server.setEssenceMsg(socket, messageId) : () => this.server.deleteEssenceMsg(socket, messageId)
      const result = await this.gate.run(action, `g:${message.groupId}`, 'admin', call)
      await this.#safeReply(message, result.ok ? (cmd === '精华' ? '⭐ 已设为精华消息。' : '✅ 已取消精华。') : `⚠️ 操作失败：${result.reason}`)
      return
    }

    // ---- 群名片 / 头衔（@某人 + 内容）----
    if (cmd === '名片' || cmd === '头衔') {
      const target = (message.ats ?? []).find((qq) => qq && qq !== this.config.botQq) ?? Number((/^\s*(\d{5,11})/.exec(arg) ?? [])[1] ?? 0)
      const value = arg.replace(/^\s*\d{5,11}\s*/, '').replace(/\[CQ:at[^\]]*\]/g, '').trim()
      if (!target || !value) {
        await this.#safeReply(message, `用法：/${cmd} @某人 新${cmd === '名片' ? '名字' : '头衔'}`)
        return
      }
      const isCard = cmd === '名片'
      const action = isCard ? 'set_group_card' : 'set_group_special_title'
      const call = isCard
        ? () => this.server.setGroupCard(socket, message.groupId, target, value.slice(0, 60))
        : () => this.server.setGroupSpecialTitle(socket, message.groupId, target, value.slice(0, 18))
      const result = await this.gate.run(action, `g:${message.groupId}`, `u${target}`, call)
      await this.#safeReply(message, result.ok ? `✅ 已更新 ${target} 的${isCard ? '群名片' : '头衔'}为「${value}」。` : `⚠️ 操作失败：${result.reason}`)
      return
    }

    const numMatch = /(?:^|\s)(\d{5,11})(?:\s|$)/.exec(arg)
    const target = numMatch ? Number(numMatch[1]) : (message.ats?.[0] ?? 0)
    if (!target) {
      await this.#safeReply(message, '用法：/mute <QQ号或@某人> [分钟]，/unmute <QQ号或@某人>，/kick <QQ号或@某人>')
      return
    }
    if (target === this.config.botQq) {
      await this.#safeReply(message, '⚠️ 不能对我自己执行这个操作哦。')
      return
    }
    if (cmd === 'mute' || cmd === 'unmute') {
      const minutesMatch = /(\d{1,4})\s*$/.exec(arg.replace(/^\s*\d{5,11}\s*/, ''))
      const minutes = cmd === 'unmute' ? 0 : Math.max(1, Math.min(1440, Number(minutesMatch?.[1] ?? 10)))
      const result = await this.gate.run('set_group_ban', `g:${message.groupId}`, `u${target}`, () => this.server.setGroupBan(socket, message.groupId, target, minutes * 60))
      if (!result.ok) {
        await this.#safeReply(message, `⚠️ 操作失败：${result.reason}`)
        return
      }
      await this.#safeReply(message, cmd === 'unmute' ? `✅ 已解除 ${target} 的禁言。` : `✅ 已禁言 ${target} ${minutes} 分钟。`)
      debugLog(`admin ${cmd} u${target} g${message.groupId} ${minutes}m`)
      return
    }
    if (cmd === 'kick') {
      this.pendingKicks.set(key, { userId: target, adminId: message.userId, route: { messageType: 'group', targetId: message.groupId }, expiresAt: Date.now() + 60_000 })
      await this.#safeReply(message, `⚠️ 确认将 ${target} 移出本群？请回复「确认踢」执行，回复「取消」放弃（60 秒内有效）。`)
      return
    }
  }

  /** 踢人二次确认。 */
  async #handleKickConfirm(message, word) {
    const key = this.#routeKey(message)
    const pending = this.pendingKicks.get(key)
    if (!pending || message.userId !== pending.adminId) return
    this.pendingKicks.delete(key)
    if (word === '取消') {
      await this.#safeReply(message, '已取消踢人操作。')
      return
    }
    if (Date.now() > pending.expiresAt) {
      await this.#safeReply(message, '⚠️ 确认已超时（60 秒），操作取消。')
      return
    }
    const socket = this.server.currentSocket()
    if (!socket) {
      await this.#safeReply(message, '⚠️ 当前无可用连接，稍后再试。')
      return
    }
    try {
      await this.server.setGroupKick(socket, pending.route.targetId, pending.userId)
      await this.#safeReply(message, '✅ 已执行移出操作。')
      debugLog(`admin kick u${pending.userId} g${pending.route.targetId}`)
    } catch (error) {
      await this.#safeReply(message, `⚠️ 踢人失败：${error.message.slice(0, 80)}`)
    }
  }

  async #rotate(message) {
    const key = this.#routeKey(message)
    const entry = this.sessions.get(key)
    this.#forgetSession(key)   // /new must really start over, not resume the old transcript
    if (entry === undefined) return
    this.#clearMemory(key)
    this.sessions.delete(key)
    this.agents.delete(entry.sessionId)
    entry.handle.agent.cancel({ kind: 'user' })
    await entry.handle.dispose()
  }

  async #ensureSession(message) {
    const key = this.#routeKey(message)
    const existing = this.sessions.get(key)
    if (existing !== undefined) return existing
    const pending = this.creating.get(key)
    if (pending !== undefined) return pending
    const creating = this.#openSession(message, key)
    this.creating.set(key, creating)
    try {
      return await creating
    } finally {
      this.creating.delete(key)
    }
  }

  /** Resume the persisted session of this chat when possible, else create a fresh one. */
  async #openSession(message, key) {
    const stored = this.config.sessionResumeEnabled === false ? '' : this.#storedSessionId(key)
    if (stored) {
      try {
        const entry = await this.#resumeSession(message, key, stored)
        this.logger.info(`QQ bridge resumed session ${entry.sessionId.slice(0, 8)} for ${key}`)
        debugLog(`session resumed ${entry.sessionId} for ${key}`)
        return entry
      } catch (error) {
        debugLog(`session resume failed (${stored}): ${error.message}`)
        this.#forgetSession(key)
      }
    }
    return this.#createSession(message, key)
  }

  #storedSessionId(key) {
    const data = this.sessionStore.read()
    const id = data ? data[key] : ''
    return typeof id === 'string' && id !== '' ? id : ''
  }

  #rememberSession(key, sessionId) {
    try {
      this.sessionStore.mutate((data) => { data[key] = String(sessionId) })
    } catch (error) {
      debugLog(`session map write failed: ${error.message}`)
    }
  }

  #forgetSession(key) {
    try {
      this.sessionStore.mutate((data) => { delete data[key] })
    } catch { /* best effort */ }
  }

  #routeOf(message) {
    return {
      bot: message.bot,
      messageType: message.messageType,
      targetId: message.messageType === 'group' ? message.groupId : message.userId,
    }
  }

  /** Chat-level key (no per-user grouping) used for outbound tracking and rate limits. */
  #chatKeyOf(route) {
    return route.messageType === 'group' ? `g:${route.targetId}` : `u:${route.targetId}`
  }

  async #createSession(message, key) {
    const route = this.#routeOf(message)
    const selection = this.#modelSelection()
    const handle = await this.ctx.agents.create({
      sessionId: freshSessionId(sessionPrefix(key)),
      meta: this.config.cwd ? { cwd: this.config.cwd } : {},
      agentOptions: selection,
      setup: (agentCtx) => this.#installSession(agentCtx, route, key, { resumed: false }),
    })
    const entry = this.#registerSession(key, route, handle, { resumed: false })
    this.#rememberSession(key, entry.sessionId)
    this.logger.info(`QQ bridge created session ${entry.sessionId.slice(0, 8)} for ${key}`)
    return entry
  }

  /** Attach to the session a previous host run persisted for this chat (full history kept). */
  async #resumeSession(message, key, sessionId) {
    const route = this.#routeOf(message)
    const selection = this.#modelSelection()
    const handle = await this.ctx.agents.resume({
      resumeSessionId: brandSessionId(sessionId),
      agentOptions: selection,
      setup: (agentCtx) => this.#installSession(agentCtx, route, key, { resumed: true }),
    })
    return this.#registerSession(key, route, handle, { resumed: true })
  }

  #registerSession(key, route, handle, { resumed = false } = {}) {
    const entry = {
      key, route, handle, agent: handle.agent, sessionId: String(handle.agent.id), resumed,
      lastTraceId: '', lastTurnAt: 0, turnStartedAt: 0,
      // 注入回合记账（按回合 FIFO）：每次转交 agent 压一条 {injected, at}，
      // turn/start 取队首决定"这一回合的回复要不要拦"。用 FIFO 而不是单个标志：
      // 真人消息可能插队在"注入 → 模型回话"之间，用标志会被真人消息清掉 → 漏发。
      // 失效方向是 fail-closed：多拦一条真人回复会在事件流里可见，漏发一条注入消息则不可见。
      pendingTurns: [], currentTurnInjected: false, turnSuppressedReply: false, turnActive: false,
    }
    this.sessions.set(key, entry)
    this.agents.set(entry.sessionId, entry)
    this.#writeRuntimeSnapshot(true)
    return entry
  }

  /** System prompt + per-session tools. Runs for both fresh and resumed sessions. */
  #installSession(agentCtx, route, key, { resumed = false } = {}) {
    const chatScope = route.messageType === 'group'
      ? ` You are chatting in QQ group ${route.targetId}; everyone in this group shares this one conversation with you, so keep it coherent across members.`
      : ` You are in a private QQ chat with user ${route.targetId}; this conversation is isolated to that user and unrelated to any group chat.`
    const imageGuide = this.config.visionMode === 'native'
      ? 'Images the user sends or quotes are attached natively to the user message; view them directly as part of the message.'
      : `Images the user sends or quotes are saved locally and can be viewed with the ${this.config.visionToolName} tool.`
    const mediaGuide = this.config.agentMediaToolsEnabled === false
      ? ''
      : ` You can also send local images/files or a voice message into this chat with the qq_send_image / qq_send_file / qq_send_voice tools, and withdraw your own recent messages with qq_recall. Files may only be sent from the allowed directories (${this.#sendRoots().join(', ')}).`
    agentCtx.systemPrompt.section({
      name: 'qq-onebot-bridge',
      order: 118,
      text: 'The user is interacting with you through QQ (OneBot bridge). Your ordinary assistant text is delivered automatically as QQ messages. Keep replies concise and in the same language as the user.' + chatScope + ' Each group and each private user has a separate conversation with you, so never mix up context between chats. When the user quotes (replies to) an earlier message, its content is prefixed with [引用] in the user turn. ' + imageGuide + mediaGuide + (this.config.sttEnabled ? ' When a user quotes (replies to) a voice message while mentioning you, the quoted voice is transcribed and provided in the user turn as 用户引用的语音转文字内容; treat it as the voice content, and if the user text is empty, reply with the transcription directly. Private voice messages are transcribed automatically and delivered as user text prefixed with [语音消息].' : ''),
    })
    if (!resumed) {
      const memoryLines = this.#loadMemoryLines(key)
      if (memoryLines.length > 0) {
        agentCtx.systemPrompt.section({
          name: 'qq-persistent-memory',
          order: 119,
          text: 'The following lines are the recent conversation of this chat, kept across host restarts (earliest first). Treat them as the continuation context of this session:\n' + memoryLines.join('\n'),
        })
      }
    }
    if (this.config.faceEnabled) this.#registerFaceTools(agentCtx, route)
    if (this.config.agentMediaToolsEnabled !== false) this.#registerMediaTools(agentCtx, route, key)
  }

  #registerFaceTools(agentCtx, route) {
    const bridge = this
    agentCtx.tools.register(defineTool({
      name: 'qq_face_list',
      description: 'List emoticons available for the current QQ chat: common yellow-face emoticons (by Chinese name) and saved image stickers collected from this chat.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { count: { type: 'number', required: true }, sample: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.sample }],
      },
      async execute() {
        const { yellow, saved } = bridge.faces.list()
        const names = yellow.slice(0, 30).map((f) => f.name).join('、')
        const stickers = saved.map((s) => s.name).join('、') || '无'
        return {
          count: yellow.length + saved.length,
          sample: `黄脸表情（用 qq_face_send 发送或回复里写 [face:名字]）：${names}\n收藏图片表情：${stickers}`,
        }
      },
    }))
    agentCtx.tools.register(defineTool({
      name: 'qq_face_send',
      description: 'Send an emoticon to the current QQ chat. Accepts a Chinese yellow-face name (微笑 撇嘴 呲牙 偷笑 大哭 鼓掌 爱心 拥抱 强 ...) or a saved sticker name (see qq_face_list).',
      parameters: {
        name: { type: 'string', description: 'Face name, e.g. 鼓掌, or a saved sticker name.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { sent: { type: 'boolean', required: true }, label: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.sent ? `已发送表情：${value.label}` : `表情发送失败：${value.label}` }],
      },
      async execute(args) {
        const resolved = bridge.faces.resolve(String(args.name ?? ''))
        if (!resolved) throw new Error(`unknown face: ${args.name}. Call qq_face_list to see available names.`)
        await bridge.server.sendSegments(route.bot, route.messageType, route.targetId, resolved.segments)
        return { sent: true, label: resolved.label }
      },
    }))
  }

  /** Tools that let the agent act on QQ beyond plain text: media, voice, recall. */
  #registerMediaTools(agentCtx, route, key) {
    const bridge = this
    agentCtx.tools.register(defineTool({
      name: 'qq_send_image',
      description: `Send a local image file into the current QQ chat. The path must be inside an allowed directory (${bridge.#sendRoots().join(', ')}). Large images are compressed automatically.`,
      parameters: {
        path: { type: 'string', description: 'Local image path (absolute, or relative to the working directory).' },
        caption: { type: 'string', description: 'Optional text sent before the image.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { sent: { type: 'boolean', required: true }, detail: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.detail }],
      },
      async execute(args) {
        if (bridge.#injectionSuppressed(key)) { bridge.#markSuppressed(key, '图片'); return { sent: false, detail: '注入回合：出站已被 dry-run 拦下（未发送）' } }
        const file = bridge.#resolveSendPath(String(args.path ?? ''))
        const detail = await bridge.#sendImageTo(route, file, String(args.caption ?? ''))
        return { sent: true, detail }
      },
    }))
    agentCtx.tools.register(defineTool({
      name: 'qq_send_file',
      description: `Send a local file into the current QQ chat (group files upload to the group file list; private chats receive it as a file message). The path must be inside an allowed directory (${bridge.#sendRoots().join(', ')}).`,
      parameters: {
        path: { type: 'string', description: 'Local file path (absolute, or relative to the working directory).' },
        name: { type: 'string', description: 'Optional file name shown to the receiver (defaults to the real name).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { sent: { type: 'boolean', required: true }, detail: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.detail }],
      },
      async execute(args) {
        if (bridge.#injectionSuppressed(key)) { bridge.#markSuppressed(key, '文件'); return { sent: false, detail: '注入回合：出站已被 dry-run 拦下（未发送）' } }
        const file = bridge.#resolveSendPath(String(args.path ?? ''))
        const detail = await bridge.#sendFileTo(route, file, String(args.name ?? ''))
        return { sent: true, detail }
      },
    }))
    if (bridge.#ttsUsable()) {
      agentCtx.tools.register(defineTool({
        name: 'qq_send_voice',
        description: 'Synthesize the given text with the configured TTS provider and send it to the current QQ chat as a voice message (use sparingly: voice messages are slower and more noticeable).',
        parameters: {
          text: { type: 'string', description: 'Text to speak (kept under ttsMaxChars).' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { sent: { type: 'boolean', required: true }, detail: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.detail }],
        },
        async execute(args) {
          if (bridge.#injectionSuppressed(key)) { bridge.#markSuppressed(key, '语音', String(args.text ?? '')); return { sent: false, detail: '注入回合：出站已被 dry-run 拦下（未发送）' } }
          const text = String(args.text ?? '').trim()
          if (!text) throw new Error('没有要朗读的文字')
          const detail = await bridge.#sendVoiceTo(route, text)
          return { sent: true, detail }
        },
      }))
    }
    agentCtx.tools.register(defineTool({
      name: 'qq_recall',
      description: 'Withdraw (recall) the most recent messages YOU sent in this chat, newest first. Only messages sent by this bridge can be recalled.',
      parameters: {
        count: { type: 'number', description: 'How many of your recent messages to withdraw (default 1, max 5).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { recalled: { type: 'number', required: true }, detail: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.detail }],
      },
      async execute(args) {
        if (bridge.#injectionSuppressed(key)) { bridge.#markSuppressed(key, '撤回操作'); return { recalled: 0, detail: '注入回合：撤回已被 dry-run 拦下（未执行）' } }
        const count = Math.min(5, Math.max(1, Number(args.count) || 1))
        const recalled = await bridge.#recallRecent(bridge.#chatKeyOf(route), count)
        return { recalled, detail: recalled > 0 ? `已撤回 ${recalled} 条消息` : '没有可撤回的消息（可能已超时或未记录）' }
      },
    }))
  }

  /** Roots a file may be sent from: the session cwd plus configured extra dirs. */
  #sendRoots() {
    return describeSendRoots({ cwd: this.config.cwd || process.cwd(), extraDirs: this.config.fileSendDirs })
  }

  /** Resolve + validate an outbound file path (contained, existing, size- and type-checked). */
  #resolveSendPath(raw) {
    return resolveSendPath(raw, {
      cwd: this.config.cwd || process.cwd(),
      extraDirs: this.config.fileSendDirs,
      maxBytes: this.config.fileSendMaxBytes,
    })
  }

  /** Send a local image (compressing oversized ones first) and remember the message id. */
  async #sendImageTo(route, file, caption = '') {
    const prepared = await this.#prepareImageForSend(file)
    const segments = []
    if (caption) segments.push({ type: 'text', data: { text: caption } })
    segments.push({ type: 'image', data: { file: prepared } })
    const data = await this.server.sendSegments(route.bot, route.messageType, route.targetId, segments)
    this.#trackSent(this.#chatKeyOf(route), data)
    const size = statSync(prepared).size
    debugLog(`agent image sent (${prepared}, ${size} bytes)`)
    return `已发送图片：${basename(prepared)}（${Math.round(size / 1024)} KB）`
  }

  /** Compress an image with ffmpeg when it exceeds imageSendMaxBytes (best effort). */
  async #prepareImageForSend(file) {
    const limit = Math.max(10240, Number(this.config.imageSendMaxBytes) || 4 * 1024 * 1024)
    let size = 0
    try { size = statSync(file).size } catch { return file }
    if (size <= limit) return file
    try {
      mkdirSync(this.mediaDir, { recursive: true })
      const out = join(this.mediaDir, `img-${Date.now().toString(36)}.jpg`)
      await new Promise((resolve, reject) => {
        execFile(this.config.ffmpegPath || 'ffmpeg', [
          '-y', '-i', file,
          '-vf', 'scale=1920:-2:force_original_aspect_ratio=decrease',
          '-q:v', '3', out,
        ], { timeout: 60_000 }, (error) => (error ? reject(error) : resolve()))
      })
      const compressed = statSync(out).size
      if (compressed > 0 && compressed < size) {
        debugLog(`image compressed ${Math.round(size / 1024)}KB → ${Math.round(compressed / 1024)}KB`)
        return out
      }
      rmSync(out, { force: true })
      return file
    } catch (error) {
      debugLog(`image compression skipped: ${error.message}`)
      return file
    }
  }

  /** Upload a local file (group file list for groups, file message for private chats). */
  async #sendFileTo(route, file, name = '') {
    const action = route.messageType === 'group' ? 'upload_group_file' : 'upload_private_file'
    const chatKey = this.#chatKeyOf(route)
    const result = await this.gate.run(action, chatKey, basename(file), () => this.server.uploadFile(
      route.bot, route.messageType, route.targetId, file, name || basename(file), '',
    ))
    if (!result.ok) throw new Error(`发送被限流：${result.reason}`)
    debugLog(`agent file sent (${file})`)
    const size = statSync(file).size
    return `已发送文件：${name || basename(file)}（${Math.round(size / 1024)} KB）`
  }

  /** Whether the configured TTS provider has everything it needs. */
  #ttsUsable() {
    if (this.config.ttsProvider === 'local') return Boolean(this.config.ttsLocalRefAudio)
    return Boolean(this.config.ttsApiKey)
  }

  /** Synthesize and send a voice message on demand (agent tool / /读). */
  async #sendVoiceTo(route, text) {
    if (!this.#ttsUsable()) throw new Error('未配置 TTS（ttsApiKey 或 ttsLocalRefAudio 为空）')
    const max = Math.max(10, Number(this.config.ttsMaxChars) || 120)
    const spoken = text.length > max ? `${text.slice(0, max)}……` : text
    const { file, bytes } = await this.#synthVoiceFile(spoken)
    const data = await this.server.sendSegments(route.bot, route.messageType, route.targetId, [{ type: 'record', data: { file } }])
    this.#trackSent(this.#chatKeyOf(route), data)
    debugLog(`agent voice sent (${bytes} bytes)`)
    return `已发送语音（${Math.round(bytes / 1024)} KB）`
  }

  /** Remember the newest outbound message ids so /撤回 and qq_recall can withdraw them. */
  #trackSent(chatKey, data) {
    const id = data?.message_id ?? data?.messageId
    if (id === undefined || id === null || id === '') return
    const list = this.sentMessages.get(chatKey) ?? []
    list.push({ messageId: id, at: Date.now() })
    if (list.length > 20) list.splice(0, list.length - 20)
    this.sentMessages.set(chatKey, list)
  }

  /** Withdraw the most recent outbound messages of this chat. Returns how many were withdrawn. */
  async #recallRecent(chatKey, count = 1) {
    const list = this.sentMessages.get(chatKey) ?? []
    if (list.length === 0) return 0
    const maxAge = Math.max(10, Number(this.config.recallWindowSeconds) || 110) * 1000
    const now = Date.now()
    const candidates = list.filter((item) => now - item.at <= maxAge).slice(-count).reverse()
    let recalled = 0
    for (const item of candidates) {
      const result = await this.gate.run('delete_msg', chatKey, String(item.messageId), () => this.server.deleteMsg(this.server.currentSocket(), item.messageId))
      if (result.ok) {
        recalled += 1
        const remaining = (this.sentMessages.get(chatKey) ?? []).filter((x) => x.messageId !== item.messageId)
        this.sentMessages.set(chatKey, remaining)
      } else {
        debugLog(`recall denied: ${result.reason}`)
      }
    }
    return recalled
  }

  /** 关键词问答库：命中即回（不走模型、不需要 @）。返回 true 表示已处理。 */
  async #handleKeyword(message, text) {
    const t = String(text ?? '').trim()
    if (t === '') return false
    const key = this.#routeKey(message)
    let hit = null
    try {
      hit = this.keywordStore.match(t, { chatKey: key, isGroup: message.messageType === 'group' })
    } catch (error) {
      debugLog(`keyword match failed: ${error.message}`)
      return false
    }
    if (!hit) return false
    if (hit.reply) {
      this.#recordMemory(key, 'user', t)
      await this.#safeReply(message, hit.reply)
      this.#recordMemory(key, 'assistant', hit.reply)
    }
    if (hit.image) {
      try {
        const file = await this.#keywordImage(hit.image)
        if (file) await this.#sendImageTo(this.#routeOf(message), file)
      } catch (error) {
        debugLog(`keyword image failed: ${error.message}`)
      }
    }
    debugLog(`keyword hit trigger=${hit.trigger}`)
    return Boolean(hit.reply || hit.image)
  }

  /** 关键词条目里的图片：http(s) 链接落盘，本地路径直接校验存在性。 */
  async #keywordImage(image) {
    const value = String(image ?? '').trim()
    if (!value) return ''
    if (/^https?:\/\//.test(value)) {
      return downloadTo(value, this.imageDir, `kw-${Date.now().toString(36)}`)
    }
    const abs = isAbsolute(value) ? value : join(this.config.cwd || process.cwd(), value)
    if (!existsSync(abs)) throw new Error(`图片不存在：${abs}`)
    return abs
  }

  /** 管理员维护词库（/kw add|del|list）。 */
  async #handleKeywordAdmin(message, cmd) {
    const key = this.#routeKey(message)
    if (cmd.action === 'list') {
      const entries = this.keywordStore.list(key)
      if (entries.length === 0) {
        await this.#safeReply(message, '词库是空的。用法：/kw add 触发词 回复内容')
        return
      }
      const lines = entries.slice(0, 20).map((entry) => `· [${entry.source === 'chat' ? '本会话' : '全局'}/${entry.match}] ${entry.trigger} → ${entry.reply.join(' / ') || '（图片）'}`)
      await this.#safeReply(message, `📚 词库（${entries.length} 条，显示前 20）\n${lines.join('\n')}`)
      return
    }
    if (cmd.action === 'add') {
      if (!cmd.reply) {
        await this.#safeReply(message, '要带上回复内容哦：/kw add 触发词 回复内容')
        return
      }
      const ok = this.keywordStore.add({ trigger: cmd.trigger, reply: [cmd.reply], match: 'contains', scope: 'all' }, key)
      if (ok) this.keywordStore.save()
      await this.#safeReply(message, ok ? `✅ 已添加：${cmd.trigger} → ${cmd.reply}` : '⚠️ 添加失败（触发词或回复不合法）')
      return
    }
    const removed = this.keywordStore.remove(cmd.trigger, key)
    if (removed) this.keywordStore.save()
    await this.#safeReply(message, removed ? `✅ 已删除：${cmd.trigger}` : `⚠️ 没找到：${cmd.trigger}`)
  }

  /** 今日人品 / 抽签 / 塔罗（本地确定性计算，零成本）。 */
  async #handleFortune(message, text) {
    const intent = parseFortuneIntent(text)
    if (!intent) return false
    const name = message.senderName || ''
    if (intent === 'lot') {
      await this.#safeReply(message, formatLot(drawLot(message.userId)))
      return true
    }
    if (intent === 'tarot') {
      await this.#safeReply(message, formatTarot(drawTarot(message.userId, text)))
      return true
    }
    await this.#safeReply(message, formatFortune(dailyFortune(message.userId, name)))
    return true
  }

  /** 骰子与随机选择（纯本地）。 */
  async #handleDice(message, text) {
    const spec = parseDice(text)
    if (spec) {
      await this.#safeReply(message, formatRoll(rollDice(spec)))
      return true
    }
    const pick = parsePickCommand(text)
    if (pick) {
      await this.#safeReply(message, formatPick(pickRandom(pick.items, pick.count), pick.items))
      return true
    }
    return false
  }

  /** 积分查询 / 排行榜 / 转账。 */
  async #handlePointsCommand(message, text) {
    const t = String(text ?? '').trim()
    if (!/^[\/／]?(积分|我的积分|积分榜|积分排行|排行榜|转账|转)(\s|$)/.test(t)) return false
    const key = this.#routeKey(message)
    const name = message.senderName || ''
    if (/^[\/／]?(积分|我的积分)$/.test(t)) {
      await this.#safeReply(message, `💰 ${name || '你'} 现在有 ${this.pointsStore.balance(key, message.userId)} 积分`)
      return true
    }
    if (/^[\/／]?(积分榜|积分排行|排行榜)$/.test(t)) {
      await this.#safeReply(message, formatLeaderboard(this.pointsStore.leaderboard(key, 10)))
      return true
    }
    const transfer = /^[\/／]?(?:转账|转)\s*(.+)$/.exec(t)
    if (!transfer) return false
    const nums = (transfer[1].match(/\d+/g) ?? []).map((value) => Number(value))
    const target = (message.ats ?? []).find((qq) => qq && qq !== (this.config.botQq ?? 0))
      ?? nums.find((value) => String(value).length >= 5)
    const amount = [...nums].reverse().find((value) => value !== target) ?? 0
    if (!target || !amount) {
      await this.#safeReply(message, '用法：/转账 @某人 数量（或 /转账 QQ号 数量）')
      return true
    }
    const result = this.pointsStore.transfer(key, message.userId, target, amount)
    if (!result.ok) {
      await this.#safeReply(message, `⚠️ 转账失败：${result.error}`)
      return true
    }
    await this.#safeReply(message, `✅ 已转给 ${target} ${amount} 积分（你还剩 ${result.fromBalance}）`)
    return true
  }

  /** 发言得积分（每会话每日封顶；默认关闭）。 */
  #awardMessagePoints(message) {
    try {
      const amount = Math.max(0, Number(this.config.pointsPerMessage) || 0)
      if (amount <= 0) return
      const key = this.#routeKey(message)
      const result = this.pointsStore.messageBonus(key, message.userId, {
        amount,
        dailyCap: Math.max(0, Number(this.config.pointsDailyCap) || 20),
      })
      if (result.granted && message.senderName) this.pointsStore.setName(key, message.userId, message.senderName)
    } catch (error) {
      debugLog(`points award failed: ${error.message}`)
    }
  }

  /** 开始一局小游戏（成语接龙 / 猜数字）。 */
  async #handleGameCommand(message, text) {
    const t = String(text ?? '').trim()
    const key = this.#routeKey(message)
    if (parseGameStopIntent(t)) {
      const had = this.games.delete(key)
      await this.#safeReply(message, had ? '游戏结束啦～下次再玩！' : '现在没有在玩的游戏哦。')
      return true
    }
    const start = parseGameStartIntent(t)
    if (!start) return false
    if (start === 'idiom') {
      const seconds = Math.max(30, Number(this.config.idiomChainTimeoutSeconds) || 120)
      const chain = new IdiomChain({ timeoutMs: seconds * 1000 })
      const first = chain.start()
      if (!first) {
        await this.#safeReply(message, '词库空啦，玩不了接龙。')
        return true
      }
      this.games.set(key, { kind: 'idiom', chain })
      await this.#safeReply(message, `🐟 成语接龙开始！我先来：「${first}」\n请接「${first[3]}」开头的四字成语（${Math.round(seconds / 60)} 分钟内有效）`)
      return true
    }
    const max = Math.max(10, Number(this.config.guessNumberMax) || 100)
    const tries = Math.max(1, Number(this.config.guessNumberMaxTries) || 10)
    this.games.set(key, { kind: 'guess', guess: new GuessNumber({ min: 1, max, maxTries: tries }) })
    await this.#safeReply(message, `🎯 猜数字开始！我想好了一个 1-${max} 的数字，你有 ${tries} 次机会～`)
    return true
  }

  /** 进行中的小游戏：直接吃下当前消息并推进状态机（免 @，让群友顺畅接龙）。 */
  async #handleActiveGame(message, text) {
    const key = this.#routeKey(message)
    const game = this.games.get(key)
    if (!game) return false
    const t = String(text ?? '').trim()
    if (t === '') return false
    if (game.kind === 'idiom') {
      if (!game.chain.active) {
        this.games.delete(key)
        return false
      }
      const result = game.chain.tryAnswer(t)
      if (result.ok) {
        if (result.next) {
          await this.#safeReply(message, `✅ 接上啦！我接「${result.next}」，请接「${result.next[3]}」开头～`)
        } else {
          this.games.delete(key)
          await this.#safeReply(message, `🎉 「${t}」接得漂亮，我想不出下一个啦，这局你赢！`)
        }
        return true
      }
      if (result.reason.includes('超时')) {
        this.games.delete(key)
        await this.#safeReply(message, '⏰ 接龙超时啦，这局结束～想玩再发「接龙」。')
        return true
      }
      // 只有看起来像在接龙（四个汉字）时才纠正，避免群里每句话都被打断。
      if (/^[\u4e00-\u9fa5]{4}$/.test(t)) {
        await this.#safeReply(message, `❌ ${message.senderName || '你'}：${result.reason}`)
        return true
      }
      return false
    }
    const result = game.guess.guess(t)
    if (result.hint === 'correct') {
      this.games.delete(key)
      await this.#safeReply(message, `🎉 猜对啦！答案就是 ${result.answer}（第 ${result.tries} 次猜中）`)
      return true
    }
    if (result.hint === 'bigger') {
      await this.#safeReply(message, `📈 太小了～再大一点（第 ${result.tries} 次）`)
      return true
    }
    if (result.hint === 'smaller') {
      await this.#safeReply(message, `📉 太大了～再小一点（第 ${result.tries} 次）`)
      return true
    }
    if (result.exhausted) {
      this.games.delete(key)
      await this.#safeReply(message, `😵 次数用完啦，答案是 ${result.answer}。想再玩就发「猜数字」。`)
      return true
    }
    return false
  }

  /** 记录一条发言（用于 /统计 与日报）；命令消息（/ 开头）不计入。 */
  #recordStats(message) {
    try {
      if (String(message.text ?? '').trim().startsWith('/')) return
      this.statsStore.record(this.#routeKey(message), message.userId, message.senderName || '')
    } catch (error) {
      debugLog(`stats record failed: ${error.message}`)
    }
  }

  /** /统计、/活跃榜、/周榜。 */
  async #handleStatsCommand(message, text) {
    const t = String(text ?? '').trim()
    if (!/^[\/／]?(统计|活跃榜|群活跃|周榜|统计周|周活跃)$/.test(t)) return false
    const key = this.#routeKey(message)
    const weekly = /周榜|统计周|周活跃/.test(t)
    const days = weekly ? 7 : 1
    const rows = this.statsStore.top(key, { days, limit: 10 })
    await this.#safeReply(message, formatActivity(rows, { title: weekly ? '📊 本周群活跃榜' : '📊 今日群活跃榜' }))
    return true
  }

  /** /mc <host[:port]>：查询 Minecraft Java 版服务器状态（只读，无外部依赖）。 */
  async #handleMcStatus(message, text) {
    const t = String(text ?? '').trim()
    if (!/^[\/／]?(mc|mcstatus|mc状态|服务器状态)(\s|$)/i.test(t)) return false
    const address = parseMcAddress(t)
    if (!address) {
      await this.#safeReply(message, '用法：/mc mc.example.com:25565（可省略端口，默认 25565）')
      return true
    }
    try {
      const result = await pingMcServer(address.host, address.port, Math.max(1000, Number(this.config.mcStatusTimeoutMs) || 5000))
      await this.#safeReply(message, formatMcStatus(result, { address: `${address.host}:${address.port}` }))
    } catch (error) {
      await this.#safeReply(message, `⚠️ 查询失败：${error.message.slice(0, 80)}`)
    }
    return true
  }

  /** /日报 on|off：本会话是否接收每日群日报。 */
  async #handleDailyReportCommand(message, text) {
    const t = String(text ?? '').trim()
    const m = /^[\/／]?(日报|群日报)\s*(on|off|开|关|开启|关闭)?$/i.exec(t)
    if (!m) return false
    if (!this.#isAdmin(message)) {
      await this.#safeReply(message, '⚠️ 只有管理员可以开关每日日报。')
      return true
    }
    const chatKey = this.#routeKey(message)
    const on = ['on', '开', '开启'].includes(String(m[2] ?? '').toLowerCase())
    const off = ['off', '关', '关闭'].includes(String(m[2] ?? '').toLowerCase())
    if (!on && !off) {
      const chats = this.dailyReportStore.read()?.chats ?? []
      await this.#safeReply(message, `每日日报当前：${chats.includes(chatKey) ? '开' : '关'}（发送 /日报 on 或 /日报 off 切换）`)
      return true
    }
    this.dailyReportStore.mutate((data) => {
      const chats = new Set(Array.isArray(data.chats) ? data.chats : [])
      if (on) chats.add(chatKey)
      else chats.delete(chatKey)
      data.chats = [...chats]
    })
    await this.#safeReply(message, on ? '✅ 已开启本会话的每日日报。' : '✅ 已关闭本会话的每日日报。')
    return true
  }

  /** 只读群信息：/荣誉、/公告（读取）、/群精华。 */
  async #handleGroupRead(message, text) {
    const t = String(text ?? '').trim()
    if (message.messageType !== 'group') return false
    const socket = this.server.currentSocket()
    if (!socket) return false
    if (/^[\/／]?(荣誉|群荣誉)$/.test(t)) {
      try {
        const info = await this.server.getGroupHonorInfo(socket, message.groupId, 'all')
        await this.#safeReply(message, formatHonor(info))
      } catch (error) {
        await this.#safeReply(message, `⚠️ 查询失败：${error.message.slice(0, 80)}`)
      }
      return true
    }
    if (/^[\/／]?(公告|群公告)$/.test(t)) {
      try {
        const list = await this.server.getGroupNotice(socket, message.groupId)
        const items = Array.isArray(list) ? list : (Array.isArray(list?.notices) ? list.notices : [])
        if (items.length === 0) {
          await this.#safeReply(message, '📢 这个群还没有公告。')
          return true
        }
        const lines = items.slice(0, 5).map((item, index) => {
          const content = String(item?.message?.text ?? item?.content ?? '').replace(/\s+/g, ' ').slice(0, 80)
          const sender = item?.sender_id ?? item?.sender ?? ''
          return `${index + 1}. ${content}${sender ? `（by ${sender}）` : ''}`
        })
        await this.#safeReply(message, `📢 群公告（${items.length} 条，显示前 5）\n${lines.join('\n')}`)
      } catch (error) {
        await this.#safeReply(message, `⚠️ 读取公告失败：${error.message.slice(0, 80)}`)
      }
      return true
    }
    if (/^[\/／]?(群精华|精华列表)$/.test(t)) {
      try {
        const list = await this.server.getEssenceMsgList(socket, message.groupId)
        const items = Array.isArray(list) ? list : []
        if (items.length === 0) {
          await this.#safeReply(message, '⭐ 这个群还没有精华消息。')
          return true
        }
        const lines = items.slice(0, 5).map((item, index) => {
          const content = String(item?.message?.text ?? item?.content ?? item?.sender_nick ?? '').replace(/\s+/g, ' ').slice(0, 70)
          return `${index + 1}. ${content || `消息 ${item?.message_id ?? ''}`}`
        })
        await this.#safeReply(message, `⭐ 群精华（${items.length} 条，显示前 5）\n${lines.join('\n')}`)
      } catch (error) {
        await this.#safeReply(message, `⚠️ 读取精华失败：${error.message.slice(0, 80)}`)
      }
      return true
    }
    return false
  }

  /** 每日群日报：让 agent 总结当天聊天并发到群里。 */
  #scheduleDailyReport() {
    if (!this.config.dailyReportEnabled) return
    const [hhRaw, mmRaw] = String(this.config.dailyReportTime || '22:00').split(':')
    const hour = Math.min(23, Math.max(0, Number(hhRaw) || 22))
    const minute = Math.min(59, Math.max(0, Number(mmRaw) || 0))
    const now = new Date()
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    const delay = Math.min(next.getTime() - now.getTime(), 0x7fffffff)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      void this.#runDailyReport()
      if (!this.stopped) this.#scheduleDailyReport()
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.add(timer)
    debugLog(`daily report scheduled for ${next.toLocaleString('zh-CN', { hour12: false })}`)
  }

  /** 本会话是否接收日报：显式配置 > /日报 on 的开关 > 群白名单兜底。 */
  #dailyReportTargets() {
    return pickReportTargets({
      configured: this.config.dailyReportChats ?? [],
      optIn: this.dailyReportStore.read()?.chats ?? [],
      allowGroups: this.config.allowGroups ?? [],
    })
  }

  async #runDailyReport() {
    if (this.stopped) return
    const socket = this.server.currentSocket()
    if (!socket) {
      debugLog('daily report skipped: no bot connection')
      return
    }
    for (const chatKey of this.#dailyReportTargets()) {
      try {
        const groupId = Number(String(chatKey).replace(/^g:/, ''))
        if (!Number.isFinite(groupId) || groupId === 0) continue
        const message = {
          bot: socket,
          userId: this.config.botQq || 0,
          messageType: 'group',
          groupId,
          text: '',
          atMe: true,
          ats: [],
          reply: null,
          records: [],
          images: [],
          files: [],
          messageId: `report-${Date.now().toString(36)}`,
          senderName: 'system',
          raw: { message: [] },
        }
        const entry = await this.#ensureSession(message)
        const stats = this.config.statsEnabled
          ? this.statsStore.top(chatKey, { days: 1, limit: 5 }).map((row) => `${row.name} ${row.count} 条`).join('、')
          : ''
        const memory = this.#loadMemoryLines(chatKey).slice(-12).join('\n')
        const prompt = '[系统定时任务] 现在是每日群日报时间。请用 3-6 句口语化的话总结今天这个群里聊了些什么（可以点出好玩的事），最后用一行给出今日活跃榜。直接输出日报内容，不要 @ 任何人，也不要复述这条指令。'
          + (stats ? `\n\n今日发言统计：${stats}` : '')
          + (memory ? `\n\n今天的部分聊天记录（最早在前）：\n${memory}` : '')
        // 日报没有触发消息 → 传 null，#handoff 会记 injected=false（保持队列与真实回合对齐）
        this.#handoff(entry, null, {
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        })
        debugLog(`daily report queued for ${chatKey}`)
      } catch (error) {
        debugLog(`daily report failed for ${chatKey}: ${error.message}`)
      }
    }
  }

  #modelSelection() {
    const fallback = this.ctx.agentDefaultModel.currentSelection()
    const selection = {
      provider: this.config.provider || fallback.provider,
      model: this.config.model || fallback.model,
    }
    debugLog(`model selection ${JSON.stringify(selection)}`)
    return selection
  }

  /** Auto-save image stickers from incoming messages into the face library. */
  async #collectSticker(message) {
    const raw = message.raw && message.raw.message
    if (!Array.isArray(raw)) return
    for (const segment of raw) {
      if (!segment || segment.type !== 'image') continue
      const url = segment.data && (segment.data.url || segment.data.file)
      if (!url || url.startsWith('file://')) continue
      try {
        const name = `表情${Date.now().toString(36).slice(-4)}`
        await this.faces.addRemoteImage(url, name)
        debugLog(`sticker collected as ${name}`)
      } catch (error) {
        debugLog(`sticker collect failed: ${error.message}`)
      }
    }
  }

  /** Resolve a quoted (replied-to) message into text lines the agent can understand. */
  async #resolveQuoted(message) {
    const full = await this.server.getMsg(message.bot, message.reply.messageId)
    const segments = Array.isArray(full?.message) ? full.message : []
    const texts = []
    const images = []
    const records = []
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object') continue
      if (segment.type === 'text') {
        const t = (segment.data?.text ?? '').trim()
        if (t) texts.push(t)
      } else if (segment.type === 'image') {
        const url = segment.data?.url || segment.data?.file || ''
        if (url && !url.startsWith('file://')) images.push(url)
      } else if (segment.type === 'record') {
        records.push({
          file: segment.data?.file ?? '',
          url: segment.data?.url ?? '',
          path: segment.data?.path ?? '',
        })
      } else if (segment.type === 'face') {
        texts.push(`[黄脸表情${segment.data?.id ?? ''}]`)
      } else if (segment.type === 'at') {
        texts.push(`@${segment.data?.qq ?? ''}`)
      }
    }
    const textPart = texts.length > 0 ? texts.join('') : ''
    const lines = []
    const blocks = []
    let hasVoice = false
    if (textPart) lines.push(`用户引用的消息内容：${textPart}`)
    const nativeVision = this.config.visionMode === 'native'
    const downloaded = []
    for (let i = 0; i < images.length; i++) {
      try {
        const saved = await downloadTo(images[i], this.quoteDir, `quoted-${Date.now().toString(36)}-${i}`)
        const vision = (await this.#extractGifFrame(saved)) ?? saved
        if (nativeVision) downloaded.push(vision)
        else lines.push(`用户引用的图片已保存到：${vision}（可用 ${this.config.visionToolName} 查看它）`)
      } catch (error) {
        debugLog(`quote image download failed: ${error.message}`)
        lines.push(`用户引用了 1 张图片（下载失败）`)
      }
    }
    if (downloaded.length > 0) {
      blocks.push(...await this.#imageBlocksFor(downloaded))
      lines.push(blocks.length > 0 ? `用户引用了 ${downloaded.length} 张图片（已附在本条消息中）` : `用户引用了 ${downloaded.length} 张图片（附件不可用，图片已存本地）`)
    }
    if (records.length > 0) {
      hasVoice = true
      if (this.config.sttEnabled) {
        try {
          const audio = await this.#fetchVoiceAudio(message, records[0])
          const transcript = await this.#transcribe(audio)
          lines.push(`用户引用的语音转文字内容：${transcript}`)
          debugLog(`quoted voice transcribed (${transcript.length} chars)`)
        } catch (error) {
          debugLog(`quoted voice STT failed: ${error.message}`)
          lines.push(`用户引用了 1 条语音（转文字失败：${error.message.slice(0, 80)}）`)
        }
      } else {
        lines.push('用户引用了 1 条语音（未开启语音转文字）')
      }
    }
    return { lines, hasVoice, blocks }
  }

  /** Download images/animated stickers from a private message; return a note and native image blocks. */
  async #downloadMessageImages(message) {
    const lines = []
    const files = []
    const pending = (message.images ?? []).slice(0, 4)
    for (let i = 0; i < pending.length; i++) {
      const img = pending[i]
      const url = img.url
      if (url && /^https?:\/\//.test(url)) {
        try {
          const saved = await downloadTo(url, this.imageDir, `qq-img-${Date.now().toString(36)}-${i}`)
          const vision = (await this.#extractGifFrame(saved)) ?? saved
          lines.push(`- 图片已保存到：${vision}`)
          files.push(vision)
          debugLog(`private image saved: ${saved}${vision !== saved ? ` (frame: ${vision})` : ''}`)
        } catch (error) {
          debugLog(`private image download failed: ${error.message}`)
          lines.push(`- 1 张图片下载失败：${error.message.slice(0, 60)}`)
        }
      } else {
        lines.push(img.kind === 'mface'
          ? `- 用户发送了 1 个动画表情（${img.summary || '无图片链接，无法查看'}）`
          : '- 用户发送了 1 张图片（无图片链接，无法查看）')
      }
    }
    let blocks = []
    if (this.config.visionMode === 'native' && files.length > 0) {
      blocks = await this.#imageBlocksFor(files)
    }
    return { note: lines.join('\n'), blocks }
  }

  /** Extract the first frame of a GIF into a PNG beside it (for stable vision support). */
  #extractGifFrame(file) {
    return new Promise((resolve) => {
      if (!this.config.gifFrameExtract) { resolve(null); return }
      if (!String(file).toLowerCase().endsWith('.gif')) { resolve(null); return }
      const out = String(file).replace(/\.gif$/i, '') + '-frame.png'
      if (existsSync(out)) { resolve(out); return }
      execFile(this.config.ffmpegPath || 'ffmpeg', ['-y', '-i', file, '-frames:v', '1', out], { timeout: 20_000 }, (error) => {
        if (error) {
          debugLog(`gif frame extract failed: ${error.message}`)
          resolve(null)
          return
        }
        resolve(existsSync(out) ? out : null)
      })
    })
  }

  /** Attach local image files as native multimodal content blocks (DSH attachment seam). */
  async #imageBlocksFor(files) {    if (files.length === 0) return []
    const attachments = this.ctx.get('attachments')
    if (!attachments || typeof attachments.saveImages !== 'function') {
      debugLog('native vision unavailable: attachments service not mounted')
      return []
    }
    try {
      const images = files.slice(0, 4).map((file) => {
        const buffer = readFileSync(file)
        const lower = file.toLowerCase()
        const mediaType = lower.endsWith('.png') ? 'image/png'
          : lower.endsWith('.gif') ? 'image/gif'
          : lower.endsWith('.webp') ? 'image/webp'
          : 'image/jpeg'
        return { data: buffer.toString('base64'), mediaType, name: basename(file) }
      })
      const refs = await attachments.saveImages(images)
      return refs.map((attachment) => ({ type: 'image', attachment }))
    } catch (error) {
      debugLog(`native image attach failed: ${error.message}`)
      return []
    }
  }

  /** Transcribe an incoming voice message and feed the text into the agent. */
  async #handleVoice(message) {
    const record = (message.records ?? [])[0] ?? {}
    if (!this.config.sttApiKey) {
      await this.#safeReply(message, '⚠️ 语音转文字未配置 API Key（sttApiKey 为空）')
      return
    }
    try {
      const audio = await this.#fetchVoiceAudio(message, record)
      const transcript = await this.#transcribe(audio)
      if (!transcript) throw new Error('识别结果为空')
      debugLog(`voice transcribed (${transcript.length} chars): ${transcript.slice(0, 60)}`)
      const entry = await this.#ensureSession(message)
      debugLog(`session ready ${entry.sessionId}`)
      const voiceText = `[语音消息] ${transcript}`
      this.#recordMemory(this.#routeKey(message), 'user', voiceText)
      this.#handoff(entry, message, {
        content: [{ type: 'text', text: voiceText }],
        source: { kind: 'user' },
      })
      debugLog('followup sent (voice)')
    } catch (error) {
      debugLog(`voice STT failed: ${error.message}`)
      this.logger.error(`QQ voice STT failed: ${error.message}`)
      await this.#safeReply(message, `⚠️ 语音转文字失败：${error.message}`)
    }
  }

  /** Obtain the voice audio as base64: get_record (mp3/wav) first, then url download. */
  async #fetchVoiceAudio(message, record) {
    const fileRef = record.file || record.path || record.url || ''
    if (fileRef) {
      for (const outFormat of ['mp3', 'wav']) {
        try {
          const data = await this.server.getRecord(message.bot, fileRef, outFormat)
          let b64 = typeof data?.base64 === 'string' ? data.base64 : ''
          if (!b64 && typeof data?.file === 'string' && data.file.startsWith('base64://')) b64 = data.file.slice(9)
          if (b64) {
            debugLog(`voice fetched via get_record ${outFormat} (${Math.round(b64.length / 1024)} KB b64)`)
            return { base64: b64, ext: outFormat }
          }
        } catch (error) {
          debugLog(`get_record(${outFormat}) failed: ${error.message}`)
        }
      }
    }
    const url = record.url || record.path
    if (url && /^https?:\/\//.test(url)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`voice download HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length === 0) throw new Error('voice download empty')
      debugLog(`voice fetched via url (${buffer.length} bytes)`)
      return { base64: buffer.toString('base64'), ext: 'mp3' }
    }
    throw new Error('无法获取语音文件（get_record 与 url 均失败）')
  }

  /** Call the STT endpoint (OpenAI-compatible /audio/transcriptions). */
  async #transcribe(audio) {
    const base = String(this.config.sttBaseUrl || '').replace(/\/+$/, '')
    if (!base) throw new Error('未配置 sttBaseUrl')
    const url = `${base}/audio/transcriptions`
    const ext = audio.ext === 'wav' ? 'wav' : 'mp3'
    const mime = ext === 'wav' ? 'audio/wav' : 'audio/mpeg'
    const form = new FormData()
    form.append('model', this.config.sttModel || 'glm-asr-2512')
    form.append('file', new Blob([Buffer.from(audio.base64, 'base64')], { type: mime }), `audio.${ext}`)
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.sttApiKey}` },
      body: form,
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new Error(`STT HTTP ${response.status}: ${detail}`)
    }
    const data = await response.json()
    const text = String(data?.text ?? '').trim()
    if (!text) throw new Error(`STT 返回为空: ${JSON.stringify(data).slice(0, 120)}`)
    return text
  }

  #onSessionEvent(session, event) {
    if (this.stopped) return
    const sessionId = String(session.id)
    const entry = this.agents.get(sessionId)
    // 桥的 session/event 监听是全局的：宿主里其它会话（用户自己的、宿主内部的）
    // 也会走到这里。只有我们自己创建的 qq-* 会话才值得记录，否则就是假警报。
    const isBridgeSession = entry !== undefined || sessionId.startsWith('qq-')
    if (!isBridgeSession) return
    if (event.type === 'turn/start') {
      debugLog(`turn/start turn=${event.data.turn}`)
      if (entry) {
        entry.turnStartedAt = Date.now()
        entry.turnActive = true
        // 这一回合是谁触发的：取队首（FIFO）。超过 15 分钟的陈旧记账直接丢弃，
        // 避免宿主某次没报 turn/start 时，很久以后误伤真人回合。
        const stale = Date.now() - 15 * 60_000
        while (entry.pendingTurns.length > 0 && entry.pendingTurns[0].at < stale) entry.pendingTurns.shift()
        entry.currentTurnInjected = entry.pendingTurns.shift()?.injected === true
        entry.turnSuppressedReply = false
      }
      this.trace?.event({
        id: entry?.lastTraceId, stage: 'agent', ok: true, chatKey: entry?.key, level: 'debug',
        data: { phase: 'turn-start', turn: event.data.turn, sessionId: entry?.sessionId },
      })
      return
    }
    if (event.type === 'turn/end') {
      debugLog(`turn/end reason=${JSON.stringify(event.data.reason)}`)
      const reason = event.data.reason
      const failed = reason && reason.kind === 'error'
      const ms = entry?.turnStartedAt ? Date.now() - entry.turnStartedAt : 0
      if (entry) {
        // 回合结束：清掉这一回合的临时状态（记账本身在 turn/start 时已经出队）
        entry.turnActive = false
        entry.currentTurnInjected = false
        entry.turnSuppressedReply = false
      }
      this.trace?.event({
        id: entry?.lastTraceId, stage: 'agent', ok: !failed, chatKey: entry?.key, ms,
        level: failed ? 'error' : 'debug',
        reason: failed ? `模型回合结束但报错：${reason?.error?.message ?? 'unknown'}` : '',
        data: { phase: 'turn-end', turn: event.data.turn, kind: reason?.kind ?? '' },
      })
      this.#writeRuntimeSnapshot()
      return
    }
    if (event.type !== 'assistant/message') return
    if (entry === undefined) {
      // 会话已被机器人断开清理，或宿主重启后残留：这条回复无处可发。
      debugLog('assistant/message but no entry')
      this.trace?.event({
        id: '', stage: 'agent', ok: false, level: 'warn',
        reason: `收到没有归属会话的 assistant/message（session=${sessionId.slice(0, 12)}），回复被丢弃`,
      })
      return
    }
    const text = assistantText(event)
    debugLog(`assistant text len=${text.length}`)
    if (text === '') {
      this.trace?.event({ id: entry.lastTraceId, stage: 'agent', ok: false, chatKey: entry.key, level: 'warn', reason: '模型这一轮没有输出文本（可能只调用了工具）' })
      return
    }
    this.#recordMemory(entry.key, 'assistant', text)
    entry.lastTurnAt = Date.now()
    // 注入回合的模型回复：窗口早已结束（dry-run 只在同步阶段开着），必须在这里单独拦下，
    // 否则"注入绝不会真发 QQ"就是假话。拦下的原文本照样写进事件流，调试信息不丢。
    if (entry.currentTurnInjected === true) {
      // 整回合拦截：一个回合可能有**多条** assistant/message（模型每步一条，用工具的回合必然多步），
      // 只拦第一条会把最终回答漏发出去。
      entry.turnSuppressedReply = true
      this.trace?.event({
        id: entry.lastTraceId, stage: 'inject', ok: true, chatKey: entry.key, level: 'info',
        reason: `注入回合的模型回复已被拦截（dry-run，未发送）：${text.slice(0, 120)}`,
        data: { suppressed: true, length: text.length },
      })
      debugLog(`injected turn reply suppressed (${text.length} chars)`)
      this.#writeRuntimeSnapshot()
      return
    }
    void this.#replyTo(entry.route, text, { traceId: entry.lastTraceId ?? '' }).then((sent) => {
      if (sent && this.config.ttsEnabled) void this.#sendTts(entry.route, text)
    }).catch((error) => {
      debugLog(`reply failed: ${error.message}`)
      this.logger.error(`QQ reply failed: ${error.message}`)
      this.trace?.event({ id: entry.lastTraceId, stage: 'reply', ok: false, chatKey: entry.key, level: 'error', reason: `回复发送失败：${error.message}` })
    })
    this.#writeRuntimeSnapshot()
  }

  #onBotDisconnect(socket) {
    this.#notify(`⚠️ QQ 机器人掉线（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`)
    for (const entry of this.sessions.values()) {
      if (entry.route.bot === socket) {
        this.sessions.delete(entry.key)
        this.agents.delete(entry.sessionId)
        entry.handle.agent.cancel({ kind: 'user' })
        void entry.handle.dispose()
      }
    }
  }

  /** Push a status notification via the configured webhook (PushPlus or custom), with cooldown. */
  #notify(text) {
    if (!this.config.notifyEnabled) return
    if (!this.config.notifyPushUrl && !this.config.notifyToken) {
      debugLog('notify skipped: no push url/token')
      return
    }
    const now = Date.now()
    const cooldown = Math.max(30, Number(this.config.notifyCooldownSeconds) || 300) * 1000
    if (now - this.lastNotifyAt < cooldown) return
    this.lastNotifyAt = now
    const url = this.config.notifyPushUrl || 'http://www.pushplus.plus/send'
    const payload = this.config.notifyToken
      ? { token: this.config.notifyToken, title: '小鲸鱼', content: text }
      : { title: '小鲸鱼', content: text }
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    }).then((response) => {
      debugLog(`notify sent status=${response.status}`)
    }).catch((error) => {
      debugLog(`notify failed: ${error.message}`)
    })
  }

  async #reply(message, text) {
    await this.#replyTo(
      {
        bot: message.bot,
        messageType: message.messageType,
        targetId: message.messageType === 'group' ? message.groupId : message.userId,
      },
      text,
      { traceId: message.__trace?.id ?? '' },
    )
  }

  /**
   * 注入回合的整回合记账 + 按会话的出站拦截。
   *
   * 设计要点（都是真机/审计实测出来的）：
   *   - dry-run 不能是**服务器级**开关：注入窗口内到达的真人消息会被一起吞掉，
   *     而且那些被吞的调用还会被当成"注入会发的东西"上报。所以拦截改成按 chatKey。
   *   - 一个回合里模型可能产生**多条** assistant/message（每步一条，用工具的回合必然多步），
   *     所以拦截判定是"整回合"，不是"本回合第一条"。
   *   - 工具出站（发图/发文件/发语音/撤回）走的是 server 直连，不经过同步窗口，
   *     必须在工具入口单独查同一个判定。
   */
  #injectionSuppressed(chatKey) {
    if (this.config.injectDryRun === false || !chatKey) return false
    const until = this.injectSync.get(chatKey)
    if (until !== undefined && until > Date.now()) return true
    return this.sessions.get(chatKey)?.currentTurnInjected === true
  }

  /** 被拦下的出站都要留一条事件（无静默分支）。 */
  #markSuppressed(chatKey, what, text = '', traceId = '') {
    this.trace?.event({
      id: traceId, stage: 'inject', ok: true, chatKey, level: 'info',
      reason: `注入回合的${what}已被拦截（dry-run，未发送）${text ? `：${String(text).slice(0, 120)}` : ''}`,
      data: { suppressed: true, chars: String(text ?? '').length },
    })
    debugLog(`injected outbound suppressed (${what}, ${String(text ?? '').length} chars)`)
  }

  /** 注入帧被投递到会话之前/之后的同步窗口。 */
  #beginInjectWindow(chatKey) { this.injectSync.set(chatKey, Date.now() + 60_000) }
  #endInjectWindow(chatKey) { this.injectSync.delete(chatKey) }

  /**
   * 把一条用户内容交给 agent，并记下"这一回合是谁触发的"。
   *
   * 所有 followup 都必须经过这里：主消息路径、/summary、私聊语音、每日日报。
   * 漏掉任何一处，注入帧的那一回合就会被误判成真人回合 → 注入的模型回复直接发到 QQ。
   */
  #handoff(entry, message, payload) {
    const injectedTurn = message?.__injected === true && this.config.injectDryRun !== false
    entry.pendingTurns.push({ injected: injectedTurn, at: Date.now() })
    if (entry.pendingTurns.length > 32) {
      // 宿主若长期不报 turn/start，队列会攒着；截断旧条目并留下痕迹
      entry.pendingTurns.splice(0, entry.pendingTurns.length - 32)
      this.trace?.event({ id: entry.lastTraceId, stage: 'inject', ok: false, level: 'warn', chatKey: entry.key, reason: '回合记账队列积压超过 32 条，已截断最早的记账（宿主可能没有上报 turn/start）' })
    }
    if (injectedTurn) {
      this.trace?.event({ id: entry.lastTraceId, stage: 'inject', ok: true, chatKey: entry.key, reason: '注入帧已转交 agent：本回合的回复会被 dry-run 拦下' })
    }
    return entry.handle.agent.followup(createUserMessage({ ...payload, content: payload.content }))
  }

  /**
   * 注入帧在同步阶段登记的**延时发送**（提醒 / 投票开奖）也要能拦：
   * 它们在窗口早已关闭之后才发，且提醒还会落盘、跨重启生效。
   */
  #injectedTaskBlocked(record, what) {
    if (record?.injected !== true) return false
    if (this.config.injectDryRun === false) return false
    this.trace?.event({
      id: '', stage: 'inject', ok: true, level: 'info', chatKey: record.key ?? '',
      reason: `注入登记的${what}已被拦截（dry-run，未发送）`,
    })
    debugLog(`injected ${what} suppressed`)
    return true
  }

  async #replyTo(route, text, { forceForward = false, traceId = '' } = {}) {
    const key = this.#chatKeyOf(route)
    if (this.#injectionSuppressed(key)) {
      this.#markSuppressed(key, '回复', text, traceId)
      return false
    }
    if (this.#rateLimited(key)) {
      debugLog(`rate limited, reply dropped (${key})`)
      if (traceId) {
        this.trace.event({
          id: traceId, stage: 'ratelimit', ok: false, chatKey: key, level: 'warn',
          reason: `出站限流：${this.config.rateLimitWindowSeconds}s 内已超过 ${this.config.rateLimitMaxReplies} 条回复，本条被丢弃`,
        })
      }
      return false
    }
    if (this.#shouldForward(text, route, forceForward)) {
      try {
        await this.#sendForwardCard(route, text)
        if (traceId) this.trace.event({ id: traceId, stage: 'reply', ok: true, chatKey: key, data: { mode: 'forward-card', chars: String(text).length } })
        return true
      } catch (error) {
        debugLog(`forward card failed, falling back to plain text: ${error.message}`)
        if (traceId) this.trace.event({ id: traceId, stage: 'reply', ok: false, chatKey: key, level: 'warn', reason: `合并转发失败，已回退普通文本：${error.message}` })
      }
    }
    const segments = this.config.faceEnabled
      ? this.faces.expandMarkers(text)
      : [{ type: 'text', data: { text } }]
    const limit = this.config.maxMessageLength || MAX_QQ_MESSAGE_CHARS
    const batches = splitSegments(segments, limit)
    const started = Date.now()
    for (const batch of batches) {
      const data = await this.server.sendSegments(route.bot, route.messageType, route.targetId, batch)
      this.#trackSent(key, data)
    }
    if (traceId) {
      this.trace.event({
        id: traceId, stage: 'reply', ok: true, chatKey: key, ms: Date.now() - started,
        data: { mode: 'text', batches: batches.length, chars: String(text).length, target: `${route.messageType}:${route.targetId}` },
      })
    }
    return true
  }

  /** Long group replies may be delivered as a merged-forward card instead of a wall of text. */
  #shouldForward(text, route, forceForward) {
    return shouldForwardText(text, {
      enabled: this.config.forwardLongReplies === true,
      force: forceForward,
      threshold: this.config.forwardThresholdChars,
      messageType: route.messageType,
    })
  }

  /** Send text as a one-node merged-forward ("chat record") card. */
  async #sendForwardCard(route, text) {
    const key = this.#chatKeyOf(route)
    const node = {
      type: 'node',
      data: {
        name: String(this.config.botName || '小鲸鱼'),
        uin: String(this.config.botQq || ''),
        content: [{ type: 'text', data: { text: String(text) } }],
      },
    }
    const result = await this.gate.run('send_group_forward_msg', key, `len=${String(text).length}`, () => this.server.sendForwardMsg(route.bot, route.messageType, route.targetId, [node]))
    if (!result.ok) throw new Error(result.reason)
    this.#trackSent(key, result.value)
    debugLog(`forward card sent (${String(text).length} chars)`)
  }

  /** Sliding-window outbound rate limiter (off unless rateLimitEnabled). Returns true when the reply must be dropped. */
  #rateLimited(key) {
    if (!this.config.rateLimitEnabled) return false
    const now = Date.now()
    const windowMs = Math.max(5, Number(this.config.rateLimitWindowSeconds) || 60) * 1000
    const max = Math.max(1, Number(this.config.rateLimitMaxReplies) || 10)
    const times = (this.replyTimes.get(key) ?? []).filter((t) => now - t < windowMs)
    if (times.length >= max) {
      this.replyTimes.set(key, times)
      return true
    }
    times.push(now)
    this.replyTimes.set(key, times)
    if (this.replyTimes.size > 500) {
      for (const [k, list] of this.replyTimes) {
        const kept = list.filter((t) => now - t < windowMs)
        if (kept.length === 0) this.replyTimes.delete(k)
        else this.replyTimes.set(k, kept)
      }
    }
    return false
  }

  /** Duplicate inbound message guard (NapCat reconnect re-delivery), on unless dedupEnabled=false. */
  #duplicate(message) {
    if (!this.config.dedupEnabled) return false
    const id = message.messageId
    if (id === undefined || id === null) return false
    const now = Date.now()
    const windowMs = Math.max(10, Number(this.config.dedupWindowSeconds) || 300) * 1000
    if (this.seenMessages.size > 1000) {
      for (const [mid, ts] of this.seenMessages) {
        if (now - ts > windowMs) this.seenMessages.delete(mid)
      }
    }
    const seen = this.seenMessages.get(id)
    this.seenMessages.set(id, now)
    return seen !== undefined && now - seen < windowMs
  }
}
