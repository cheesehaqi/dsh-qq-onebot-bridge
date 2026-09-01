/**
 * Core bridge: routes QQ messages into native Harness agent sessions and
 * streams assistant replies back over OneBot.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { FaceLibrary } from './faces.js'
import { parseReminder } from './reminders.js'
import { parseVoteCommand, TodoStore } from './grouptools.js'
import { synthesizeTts } from './tts.js'
import { parseMessage } from './onebot.js'
import { CheckinStore, isCheckinIntent, isCheckinBoardIntent } from './checkin.js'

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
    this.sessions = new Map()   // routeKey -> { handle, agent, sessionId, route }
    this.agents = new Map()     // sessionId -> entry
    this.creating = new Map()
    this.disposers = []
    this.stopped = false
  }

  start() {
    this.disposers.push(this.ctx.on('session/event', (session, event) => this.#onSessionEvent(session, event)))
    this.disposers.push(this.server.on('message', (message) => void this.#onQqMessage(message)))
    this.disposers.push(this.server.on('notice', (notice) => void this.#onNotice(notice)))
    this.disposers.push(this.server.on('bot-disconnect', (socket) => this.#onBotDisconnect(socket)))
    this.disposers.push(this.server.on('bot-connect', () => this.#notify('✅ QQ 机器人已上线')))
    this.#loadReminders()
    this.#cleanupImageDirs()
    this.#notify('🔌 QQ 桥已就绪')
  }

  /** Delete downloaded images older than the retention window so the dirs never grow unbounded. */
  #cleanupImageDirs() {
    try {
      const retentionMs = Math.max(1, Number(this.config.imageRetentionDays) || 14) * 86_400_000
      const cutoff = Date.now() - retentionMs
      for (const dir of [this.imageDir, this.quoteDir]) {
        if (!existsSync(dir)) continue
        for (const name of readdirSync(dir)) {
          const file = join(dir, name)
          try {
            if (statSync(file).isFile() && statSync(file).mtimeMs < cutoff) unlinkSync(file)
          } catch { /* best effort */ }
        }
      }
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

  #allowed(message) {
    if (message.messageType === 'private') {
      // 白名单为空 = 拒绝所有私聊（部署者必须显式填入自己的 QQ 号）
      return this.config.allowUsers.includes(message.userId)
    }
    // 群白名单为空 = 拒绝所有群消息
    if (!this.config.allowGroups.includes(message.groupId)) return false
    if (this.config.allowUsers.length > 0 && !this.config.allowUsers.includes(message.userId)) return false
    return true
  }

  async #onQqMessage(message) {
    if (this.stopped) return
    try {
      await this.#onQqMessageInner(message)
    } catch (error) {
      debugLog(`unhandled error: ${error.message}`)
      this.logger.error(`QQ message handler error: ${error.message}`)
      await this.#safeReply(message, `⚠️ 处理失败：${error.message}`)
    }
  }

  async #onQqMessageInner(message) {
    if (!this.#allowed(message)) {
      debugLog(`rejected u${message.userId} g${message.groupId ?? '-'}`)
      return
    }
    if (isQuietTime(this.config, this.quietRanges)) {
      debugLog(`quiet hours, message ignored u${message.userId} g${message.groupId ?? '-'}`)
      return
    }
    if (this.#duplicate(message)) {
      debugLog(`duplicate message ignored id=${message.messageId} u${message.userId}`)
      return
    }
    const text = message.text.trim()
    if (this.config.autoCollectStickers) void this.#collectSticker(message)

    // ---- 免@低摩擦命令（白名单+静默检查后即处理，不进入 agent 会话）----
    if (text === '/help' || text === '帮助' || text === '菜单') {
      await this.#handleHelp(message)
      return
    }
    if (this.config.checkinEnabled && isCheckinBoardIntent(text)) {
      await this.#handleCheckinBoard(message)
      return
    }
    if (this.config.checkinEnabled && isCheckinIntent(text, this.config.checkinKeyword)) {
      await this.#handleCheckin(message)
      return
    }
    if (this.config.voiceReadingEnabled) {
      const readCmd = /^\/读\s*(.*)$/.exec(text)
      const readQuoteIntent = Boolean(message.reply?.messageId) && /(读|念)/.test(text) &&
        (message.messageType === 'private' || message.atMe)
      if (readCmd || readQuoteIntent) {
        await this.#handleVoiceReading(message, readCmd ? readCmd[1].trim() : '')
        return
      }
    }
    const hasRecords = Array.isArray(message.records) && message.records.length > 0
    const hasImages = Array.isArray(message.images) && message.images.length > 0
    const sttActive = this.config.sttEnabled

    // 私聊语音不受限制：直接转文字回复（无需引用/@，也不受 acceptPrivate 约束）。
    if (message.messageType === 'private' && sttActive && hasRecords) {
      await this.#handleVoice(message)
      return
    }

    // 私聊文件转存：收到的文件自动保存到本机。
    if (message.messageType === 'private' && this.config.fileTransferEnabled && Array.isArray(message.files) && message.files.length > 0) {
      await this.#handlePrivateFiles(message)
      return
    }

    // @机器人 + 引用（回复）一条语音 → 转文字回复；私聊引用语音同样放行。
    const voiceQuoteRequest = sttActive && Boolean(message.reply?.messageId) &&
      (message.messageType === 'private' || (message.messageType === 'group' && message.atMe))

    if (text === '') {
      // 群聊纯语音/空文本默认忽略；仅「@+引用语音」或「私聊图片/动画表情」继续处理。
      const privateImageOnly = message.messageType === 'private' && this.config.privateImageView && hasImages
      if (!voiceQuoteRequest && !privateImageOnly) return
    } else if (message.messageType === 'private' && !this.config.acceptPrivate) {
      if (!voiceQuoteRequest) {
        debugLog(`private msg ignored (acceptPrivate=false) u${message.userId}`)
        return
      }
    } else if (message.messageType === 'group' && this.config.replyOnlyWhenMentioned && !message.atMe) {
      debugLog(`group msg without @bot ignored (u${message.userId} g${message.groupId})`)
      return
    }

    debugLog(`msg from u${message.userId} g${message.groupId ?? '-'} m=${message.messageType} atMe=${message.atMe}: ${text.slice(0, 80)}`)
    let effectiveText = text
    const visionBlocks = []
    if (message.reply && message.reply.messageId) {
      try {
        const resolved = await this.#resolveQuoted(message)
        if (resolved.lines.length > 0 || resolved.blocks.length > 0) {
          const userPart = text !== ''
            ? `用户说：${text}`
            : resolved.hasVoice
              ? '用户引用了一条语音，请把这条语音的文字内容直接回复出来'
              : '请根据用户引用的消息内容回复'
          effectiveText = resolved.lines.length > 0 ? `[引用] ${resolved.lines.join('；')}\n\n${userPart}` : userPart
          visionBlocks.push(...resolved.blocks)
        } else if (text === '') {
          debugLog(`quoted message has no resolvable content, ignored (u${message.userId})`)
          return
        }
      } catch (error) {
        debugLog(`quote resolve failed: ${error.message}`)
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
      } catch (error) {
        debugLog(`private image handling failed: ${error.message}`)
      }
    }

    if (text === '/new') {
      await this.#rotate(message)
      await this.#safeReply(message, '已开启新会话（旧的已完成）。现在直接发任务即可。')
      return
    }
    if (text === '/status') {
      const key = this.#routeKey(message)
      const entry = this.sessions.get(key)
      const status = entry ? String(entry.handle.agent.status) : 'idle (no session)'
      await this.#safeReply(message, `QQ 桥状态：${status} · 会话 ${entry ? entry.sessionId.slice(0, 8) : '无'}`)
      return
    }
    if (text === '/reminders') {
      await this.#listReminders(message)
      return
    }
    if (text === '/health') {
      await this.#handleHealth(message)
      return
    }
    if (text === '/export' && this.config.exportEnabled) {
      await this.#handleExport(message)
      return
    }
    // ---- 管理命令（仅 adminUsers；踢人需二次确认）----
    if (this.config.adminEnabled && this.#isAdmin(message)) {
      const adminCmd = /^\/(mute|unmute|kick|clear)\b\s*(.*)$/.exec(text)
      if (adminCmd) {
        await this.#handleAdminCommand(message, adminCmd[1], adminCmd[2].trim())
        return
      }
      const confirm = /^(确认踢|取消)$/.exec(text)
      if (confirm) {
        await this.#handleKickConfirm(message, confirm[1])
        return
      }
    }
    // ---- 群工具 ----
    if (text === '/summary' && this.config.summaryEnabled) {
      await this.#handleSummary(message)
      return
    }
    if (this.config.voteEnabled) {
      const voteCmd = parseVoteCommand(text)
      if (voteCmd) {
        await this.#startVote(message, voteCmd)
        return
      }
      if (text === '/vote') {
        await this.#showVote(message)
        return
      }
      if (text === '/vote-end') {
        await this.#endVote(message)
        return
      }
      if (await this.#maybeVote(message)) return
    }
    if (this.config.todoEnabled) {
      const todoCmd = /^\/todo\b\s*(.*)$/.exec(text)
      if (todoCmd) {
        await this.#handleTodo(message, todoCmd[1].trim())
        return
      }
      const remember = /^(?:记一下|记着|待办)[:：]?\s*(.+)$/.exec(text)
      if (remember) {
        await this.#handleTodo(message, `add ${remember[1].trim()}`)
        return
      }
    }
    // 定时提醒：群聊沿用 @ 过滤（@ 时允许省略"提醒"字样），私聊直接触发（需关键词）
    if (this.config.reminderEnabled) {
      const requireKeyword = !(message.messageType === 'group' && message.atMe)
      const parsed = parseReminder(text, requireKeyword)
      if (parsed) {
        await this.#addReminder(message, parsed)
        return
      }
    }

    let entry
    try {
      entry = await this.#ensureSession(message)
      debugLog(`session ready ${entry.sessionId}`)
      this.#recordMemory(this.#routeKey(message), 'user', effectiveText)
      entry.handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: effectiveText }, ...visionBlocks],
        source: { kind: 'user' },
      }))
      debugLog(`followup sent`)
    } catch (error) {
      debugLog(`agent failure: ${error.message}`)
      this.logger.error(`QQ agent failure: ${error.message}`)
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
      const list = [...this.reminders.values()].map(({ id, key, route, dueAt, content }) => ({ id, key, route, dueAt, content }))
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

  async #deliverReminder(rem) {
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
    if (parsed.dueAt < now + 5_000) {
      await this.#safeReply(message, '⚠️ 提醒时间太近了，至少设置 5 秒以后。')
      return
    }
    if (parsed.dueAt > now + 30 * 86_400_000) {
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
      timer: null,
    }
    this.reminders.set(rem.id, rem)
    this.#saveReminders()
    this.#scheduleReminder(rem)
    const when = new Date(rem.dueAt).toLocaleString('zh-CN', { hour12: false })
    await this.#safeReply(message, `⏰ 好的，将在 ${when} 提醒：${rem.content}`)
    debugLog(`reminder added ${rem.id} due ${when}`)
  }

  async #listReminders(message) {
    const key = this.#routeKey(message)
    const mine = [...this.reminders.values()].filter((r) => r.key === key)
    if (mine.length === 0) {
      await this.#safeReply(message, '当前没有待执行的提醒。')
      return
    }
    const lines = mine.map((r) => `- ${new Date(r.dueAt).toLocaleString('zh-CN', { hour12: false })}：${r.content}`)
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

  /** OneBot notice 事件分发：戳一戳 / 入群欢迎。 */
  async #onNotice(notice) {
    if (this.stopped) return
    try {
      if (notice.noticeType === 'notify' && notice.subType === 'poke' && this.config.pokeEnabled) {
        await this.#handlePoke(notice)
        return
      }
      if (notice.noticeType === 'group_increase' && this.config.welcomeEnabled) {
        await this.#handleWelcome(notice)
        return
      }
    } catch (error) {
      debugLog(`notice handling failed: ${error.message}`)
    }
  }

  /** 戳一戳：白名单会话内被戳时随机回一条卖萌文案（每会话限频）。 */
  async #handlePoke(notice) {
    const isGroup = notice.groupId !== undefined
    if (isGroup) {
      if (!this.config.allowGroups.includes(notice.groupId)) return
      if (this.config.allowUsers.length > 0 && !this.config.allowUsers.includes(notice.userId)) return
    } else {
      if (!this.config.allowUsers.includes(notice.userId)) return
    }
    // 戳的目标不是机器人本人则忽略（targetId 缺省时视为戳机器人）。
    if (notice.targetId !== undefined && notice.targetId !== (this.config.botQq ?? 0)) return
    const key = isGroup ? `poke:g:${notice.groupId}` : `poke:u:${notice.userId}`
    const now = Date.now()
    const cooldown = Math.max(5, Number(this.config.pokeCooldownSeconds) || 15) * 1000
    if (now - (this.lastPokeAt.get(key) ?? 0) < cooldown) return
    this.lastPokeAt.set(key, now)
    const replies = Array.isArray(this.config.pokeReplies) && this.config.pokeReplies.length > 0
      ? this.config.pokeReplies
      : ['别戳啦，小鲸鱼要吐泡泡了～']
    const line = replies[Math.floor(Math.random() * replies.length)]
    const targetId = isGroup ? notice.groupId : notice.userId
    await this.server.sendSegments(notice.bot, isGroup ? 'group' : 'private', targetId, [{ type: 'text', data: { text: line } }])
    debugLog(`poke replied (${isGroup ? `g${notice.groupId}` : `u${notice.userId}`})`)
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
      '· /export 导出聊天记录 · /help 本菜单',
    ]
    if (this.config.voiceReadingEnabled) {
      lines.push('· 语音朗读：@我 引用文字说「读一下」，或 /读 要读的内容')
    }
    if (this.config.sttEnabled) {
      lines.push('· 语音转文字：@我 并引用一条语音')
    }
    if (this.config.checkinEnabled) {
      lines.push(`· 签到：说「${this.config.checkinKeyword || '签到'}」打卡 · 签到榜 看排行`)
    }
    if (this.config.adminEnabled && isAdmin) {
      lines.push('· 管理：/mute /unmute /kick /clear（踢人需二次确认）')
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
    await this.#safeReply(message, `✅ ${name || '你'} 打卡成功！连续 ${streak} 天 · 累计 ${total} 天${extra}`)
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
    entry.handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: `请把以下本会话最近的聊天记录总结成要点（分条列出：谁、说了什么、重要结论；如有 @我的内容请标出）：\n${lines.join('\n')}` }],
      source: { kind: 'user' },
    }))
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

  /** 管理员命令：/mute /unmute /kick（二次确认）/clear。 */
  async #handleAdminCommand(message, cmd, arg) {
    const groupOnly = cmd === 'mute' || cmd === 'unmute' || cmd === 'kick'
    if (groupOnly && message.messageType !== 'group') {
      await this.#safeReply(message, '⚠️ 禁言/踢人仅支持群聊。')
      return
    }
    const key = this.#routeKey(message)
    if (cmd === 'clear') {
      await this.#rotate(message)
      this.#clearMemory(key)
      await this.#safeReply(message, '✅ 会话与持久化记忆已清空。')
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
    const socket = this.server.currentSocket()
    if (!socket) {
      await this.#safeReply(message, '⚠️ 当前无可用连接，稍后再试。')
      return
    }
    if (cmd === 'mute' || cmd === 'unmute') {
      const minutesMatch = /(\d{1,4})\s*$/.exec(arg.replace(/^\s*\d{5,11}\s*/, ''))
      const minutes = cmd === 'unmute' ? 0 : Math.max(1, Math.min(1440, Number(minutesMatch?.[1] ?? 10)))
      try {
        await this.server.setGroupBan(socket, message.groupId, target, minutes * 60)
        await this.#safeReply(message, cmd === 'unmute' ? `✅ 已解除 ${target} 的禁言。` : `✅ 已禁言 ${target} ${minutes} 分钟。`)
        debugLog(`admin ${cmd} u${target} g${message.groupId} ${minutes}m`)
      } catch (error) {
        await this.#safeReply(message, `⚠️ 操作失败：${error.message.slice(0, 80)}`)
      }
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
    const creating = this.#createSession(message, key)
    this.creating.set(key, creating)
    try {
      return await creating
    } finally {
      this.creating.delete(key)
    }
  }

  async #createSession(message, key) {
    const route = {
      bot: message.bot,
      messageType: message.messageType,
      targetId: message.messageType === 'group' ? message.groupId : message.userId,
    }
    const selection = this.#modelSelection()
    const bridge = this
    const setup = async (agentCtx) => {
      const chatScope = route.messageType === 'group'
        ? ` You are chatting in QQ group ${route.targetId}; everyone in this group shares this one conversation with you, so keep it coherent across members.`
        : ` You are in a private QQ chat with user ${route.targetId}; this conversation is isolated to that user and unrelated to any group chat.`
      const imageGuide = bridge.config.visionMode === 'native'
        ? 'Images the user sends or quotes are attached natively to the user message; view them directly as part of the message.'
        : `Images the user sends or quotes are saved locally and can be viewed with the ${bridge.config.visionToolName} tool.`
      agentCtx.systemPrompt.section({
        name: 'qq-onebot-bridge',
        order: 118,
        text: 'The user is interacting with you through QQ (OneBot bridge). Your ordinary assistant text is delivered automatically as QQ messages. Keep replies concise and in the same language as the user.' + chatScope + ' Each group and each private user has a separate conversation with you, so never mix up context between chats. When the user quotes (replies to) an earlier message, its content is prefixed with [引用] in the user turn. ' + imageGuide + (bridge.config.sttEnabled ? ' When a user quotes (replies to) a voice message while mentioning you, the quoted voice is transcribed and provided in the user turn as 用户引用的语音转文字内容; treat it as the voice content, and if the user text is empty, reply with the transcription directly. Private voice messages are transcribed automatically and delivered as user text prefixed with [语音消息].' : ''),
      })
      const memoryLines = bridge.#loadMemoryLines(key)
      if (memoryLines.length > 0) {
        agentCtx.systemPrompt.section({
          name: 'qq-persistent-memory',
          order: 119,
          text: 'The following lines are the recent conversation of this chat, kept across host restarts (earliest first). Treat them as the continuation context of this session:\n' + memoryLines.join('\n'),
        })
      }
      if (bridge.config.faceEnabled) {
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
    }
    const handle = await this.ctx.agents.create({
      sessionId: freshSessionId(sessionPrefix(key)),
      meta: this.config.cwd ? { cwd: this.config.cwd } : {},
      agentOptions: selection,
      setup,
    })
    const entry = { key, route, handle, agent: handle.agent, sessionId: String(handle.agent.id) }
    this.sessions.set(key, entry)
    this.agents.set(entry.sessionId, entry)
    this.logger.info(`QQ bridge created session ${entry.sessionId.slice(0, 8)} for ${key}`)
    return entry
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
      entry.handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: voiceText }],
        source: { kind: 'user' },
      }))
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
    if (event.type === 'turn/end') {
      debugLog(`turn/end reason=${JSON.stringify(event.data.reason)}`)
    } else if (event.type === 'turn/start') {
      debugLog(`turn/start turn=${event.data.turn}`)
    }
    if (event.type !== 'assistant/message') return
    const entry = this.agents.get(String(session.id))
    if (entry === undefined) {
      debugLog('assistant/message but no entry')
      return
    }
    const text = assistantText(event)
    debugLog(`assistant text len=${text.length}`)
    if (text === '') return
    this.#recordMemory(entry.key, 'assistant', text)
    void this.#replyTo(entry.route, text).then((sent) => {
      if (sent && this.config.ttsEnabled) void this.#sendTts(entry.route, text)
    }).catch((error) => {
      debugLog(`reply failed: ${error.message}`)
      this.logger.error(`QQ reply failed: ${error.message}`)
    })
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
    )
  }

  async #replyTo(route, text) {
    const key = route.messageType === 'group' ? `g:${route.targetId}` : `u:${route.targetId}`
    if (this.#rateLimited(key)) {
      debugLog(`rate limited, reply dropped (${key})`)
      return false
    }
    const segments = this.config.faceEnabled
      ? this.faces.expandMarkers(text)
      : [{ type: 'text', data: { text } }]
    const limit = this.config.maxMessageLength || MAX_QQ_MESSAGE_CHARS
    const batches = splitSegments(segments, limit)
    for (const batch of batches) {
      await this.server.sendSegments(route.bot, route.messageType, route.targetId, batch)
    }
    return true
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
