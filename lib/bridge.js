/**
 * Core bridge: routes QQ messages into native Harness agent sessions and
 * streams assistant replies back over OneBot.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { FaceLibrary } from './faces.js'
import { parseReminder } from './reminders.js'

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
    this.sessions = new Map()   // routeKey -> { handle, agent, sessionId, route }
    this.agents = new Map()     // sessionId -> entry
    this.creating = new Map()
    this.disposers = []
    this.stopped = false
  }

  start() {
    this.disposers.push(this.ctx.on('session/event', (session, event) => this.#onSessionEvent(session, event)))
    this.disposers.push(this.server.on('message', (message) => void this.#onQqMessage(message)))
    this.disposers.push(this.server.on('bot-disconnect', (socket) => this.#onBotDisconnect(socket)))
    this.#loadReminders()
    this.#cleanupImageDirs()
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
    if (this.#duplicate(message)) {
      debugLog(`duplicate message ignored id=${message.messageId} u${message.userId}`)
      return
    }
    const text = message.text.trim()
    if (this.config.autoCollectStickers) void this.#collectSticker(message)
    const hasRecords = Array.isArray(message.records) && message.records.length > 0
    const hasImages = Array.isArray(message.images) && message.images.length > 0
    const sttActive = this.config.sttEnabled

    // 私聊语音不受限制：直接转文字回复（无需引用/@，也不受 acceptPrivate 约束）。
    if (message.messageType === 'private' && sttActive && hasRecords) {
      await this.#handleVoice(message)
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
        if (nativeVision) downloaded.push(saved)
        else lines.push(`用户引用的图片已保存到：${saved}（可用 ${this.config.visionToolName} 查看它）`)
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
          lines.push(`- 图片已保存到：${saved}`)
          files.push(saved)
          debugLog(`private image saved: ${saved}`)
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

  /** Attach local image files as native multimodal content blocks (DSH attachment seam). */
  async #imageBlocksFor(files) {
    if (files.length === 0) return []
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
    void this.#replyTo(entry.route, text).catch((error) => {
      debugLog(`reply failed: ${error.message}`)
      this.logger.error(`QQ reply failed: ${error.message}`)
    })
  }

  #onBotDisconnect(socket) {
    for (const entry of this.sessions.values()) {
      if (entry.route.bot === socket) {
        this.sessions.delete(entry.key)
        this.agents.delete(entry.sessionId)
        entry.handle.agent.cancel({ kind: 'user' })
        void entry.handle.dispose()
      }
    }
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
      return
    }
    const segments = this.config.faceEnabled
      ? this.faces.expandMarkers(text)
      : [{ type: 'text', data: { text } }]
    const limit = this.config.maxMessageLength || MAX_QQ_MESSAGE_CHARS
    const batches = splitSegments(segments, limit)
    for (const batch of batches) {
      await this.server.sendSegments(route.bot, route.messageType, route.targetId, batch)
    }
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
