/**
 * OneBot v11 transport: reverse-WebSocket server.
 *
 * The plugin listens on 127.0.0.1:<port>; a OneBot implementation
 * (LLOneBot / OpenShamrock / NapCat / Lagrange / go-cqhttp) connects TO us
 * using its `ws-reverse://` configuration. Every accepted connection is one
 * bot instance.
 */
import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'

const ACTION_TIMEOUT_MS = 10_000

/**
 * 文本 @ 匹配（v0.5.9 真机抓到）。
 *
 * 背景：`replyOnlyWhenMentioned` 原本只看 `at` 段。但**有些 QQ 客户端把 @机器人 发成纯文本**
 * ——正文里就是字面 `@昵称`，一个 `at` 段都没有（真机实测：同一群里别人发的 @ 是真 at 段、
 * 能被识别；用户自己发的那条 `ats=[]`、正文是 `@机器人昵称 /打卡名册`）。结果就是
 * 用户明明 @ 了机器人，桥却当成"没 @"**静默丢掉**，群里一个字都不回。
 *
 * 这里按名字做字面量匹配（不用正则：昵称里可能有 `.` `+` `(` 等元字符）。
 * 命中返回那个名字（便于写进 trace 说清是哪条规则放行的），否则返回空串。
 */
export function mentionsByName(text, names) {
  const value = String(text ?? '')
  if (value === '' || !value.includes('@')) return ''
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim()
    if (name === '') continue
    if (value.includes(`@${name}`)) return name
  }
  return ''
}

/**
 * 把正文里的 `@机器人名` 去掉（配套 `mentionsByName` 使用）。
 *
 * 为什么需要：命令是按**行首**锚定匹配的（`^[\/／]命令`）。客户端把 @ 发成纯文本时，
 * 正文长这样：`@机器人昵称 /打卡名册`——光把门禁放行还不够，`/打卡名册` 不在行首，
 * 命令依然认不出来（会当成聊天内容丢给模型）。这里把那个 @名字 连同后面的空白去掉，
 * 于是 `/打卡名册` 回到行首。名字不匹配时原样返回。
 */
export function stripMentionName(text, name) {
  const value = String(text ?? '')
  const needle = `@${String(name ?? '').trim()}`
  if (value === '' || needle === '@') return value
  const idx = value.indexOf(needle)
  if (idx === -1) return value
  return `${value.slice(0, idx)} ${value.slice(idx + needle.length)}`.replace(/\s+/g, ' ').trim()
}

export function parseMessage(rawMessage, botQq) {
  let text = ''
  const ats = []
  const records = []
  const images = []
  const files = []
  // 合并转发（聊天记录）卡片：本身没有可读内容，只有 id，要靠 get_forward_msg 展开。
  // 以前这里完全没有 forward 分支，于是「只发一张转发卡片」的消息在 #onFrame 就被整条丢掉，
  // 连 trace 都没有——违反「无静默分支必带 reason」。
  const forwards = []
  let reply = null
  if (typeof rawMessage === 'string') {
    const atRe = /\[CQ:at,qq=(\d+)(?:,name=([^\]]*))?\]/g
    let match
    while ((match = atRe.exec(rawMessage)) !== null) ats.push(Number(match[1]))
    const replyMatch = /\[CQ:reply,id=([^,\]]+)(?:,text=([^\]]*))?\]/.exec(rawMessage)
    if (replyMatch) reply = { messageId: replyMatch[1], text: replyMatch[2] ?? '' }
    const recordRe = /\[CQ:record,([^\]]*)\]/g
    while ((match = recordRe.exec(rawMessage)) !== null) {
      const file = /(?:^|,)file=([^,\]]+)/.exec(match[1])
      const url = /(?:^|,)url=([^,\]]+)/.exec(match[1])
      records.push({ file: file ? file[1] : '', url: url ? url[1] : '' })
    }
    const imageRe = /\[CQ:(image|mface),([^\]]*)\]/g
    while ((match = imageRe.exec(rawMessage)) !== null) {
      const url = /(?:^|,)url=([^,\]]+)/.exec(match[2])
      images.push({ kind: match[1], url: url ? url[1] : '', file: '' })
    }
    const fileRe = /\[CQ:file,([^\]]*)\]/g
    while ((match = fileRe.exec(rawMessage)) !== null) {
      const url = /(?:^|,)url=([^,\]]+)/.exec(match[1])
      const name = /(?:^|,)name=([^,\]]+)/.exec(match[1])
      files.push({ name: name ? name[1] : '', url: url ? url[1] : '', file: '' })
    }
    const forwardRe = /\[CQ:forward,([^\]]*)\]/g
    while ((match = forwardRe.exec(rawMessage)) !== null) {
      const id = /(?:^|,)id=([^,\]]+)/.exec(match[1])
      if (id) forwards.push({ id: id[1] })
    }
    text = stripCq(rawMessage.replace(/\[CQ:at[^\]]*\]/g, ' ').replace(/\[CQ:reply[^\]]*\]/g, ' '))
  } else if (Array.isArray(rawMessage)) {
    const parts = []
    for (const segment of rawMessage) {
      if (!segment || typeof segment !== 'object') continue
      if (segment.type === 'text') parts.push((segment.data && segment.data.text) ?? '')
      else if (segment.type === 'at') ats.push(Number((segment.data && segment.data.qq) ?? 0))
      else if (segment.type === 'reply') {
        reply = { messageId: segment.data?.id ?? '', text: segment.data?.text ?? '' }
      } else if (segment.type === 'record') {
        records.push({
          file: segment.data?.file ?? '',
          url: segment.data?.url ?? '',
          path: segment.data?.path ?? '',
        })
      } else if (segment.type === 'image' || segment.type === 'mface') {
        images.push({
          kind: segment.type,
          url: segment.data?.url ?? '',
          file: segment.data?.file ?? '',
          summary: segment.data?.summary ?? '',
        })
      } else if (segment.type === 'file') {
        files.push({
          name: segment.data?.name ?? '',
          url: segment.data?.url ?? '',
          file: segment.data?.file ?? '',
        })
      } else if (segment.type === 'forward') {
        const id = segment.data?.id
        if (id !== undefined && id !== null && String(id) !== '') forwards.push({ id: String(id) })
      }
    }
    text = parts.join(' ')
  }
  return { text: text.replace(/\s+/g, ' ').trim(), ats, records, images, files, forwards, reply }
}

function stripCq(text) {
  // Keep CQ:at with names readable; drop image/face/etc. payload noise.
  return String(text)
    .replace(/\[CQ:at,qq=(\d+)(?:,name=([^\]]*))?\]/g, (_m, qq, name) => name ? `@${name}` : `@${qq}`)
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse a OneBot v11 notice frame into a normalized shape (poke / member in-out / recall / ...). */
export function parseNotice(frame) {
  if (!frame || frame.post_type !== 'notice') return null
  return {
    noticeType: frame.notice_type ?? '',
    subType: frame.sub_type ?? '',
    groupId: frame.group_id !== undefined ? Number(frame.group_id) : undefined,
    userId: frame.user_id !== undefined ? Number(frame.user_id) : undefined,
    targetId: frame.target_id !== undefined ? Number(frame.target_id) : undefined,
    operatorId: frame.operator_id !== undefined ? Number(frame.operator_id) : undefined,
    messageId: frame.message_id !== undefined ? frame.message_id : undefined,
    duration: frame.duration !== undefined ? Number(frame.duration) : undefined,
    selfId: frame.self_id !== undefined ? Number(frame.self_id) : undefined,
    // v0.5.3 互动：真机探针确认过的字段（group_msg_emoji_like / notify.poke / notify.input_status）。
    likes: Array.isArray(frame.likes) ? frame.likes : undefined,
    isAdd: frame.is_add !== undefined ? frame.is_add !== false : undefined,
    messageSeq: frame.message_seq !== undefined ? frame.message_seq : undefined,
    senderId: frame.sender_id !== undefined ? Number(frame.sender_id) : undefined,
    eventType: frame.event_type !== undefined ? Number(frame.event_type) : undefined,
    statusText: frame.status_text !== undefined ? String(frame.status_text) : undefined,
    // v0.5.8 权限自愈：group_admin 的「设/撤」在 **sub_type** 里（'set' / 'unset'），
    // 真机探针确认该事件**没有** set 布尔字段；其它 notice 类型下为 undefined。
    adminSet: frame.notice_type === 'group_admin' ? frame.sub_type !== 'unset' : undefined,
  }
}

/** Parse a OneBot v11 request frame (group join / friend add) into a normalized shape. */
export function parseRequest(frame) {
  if (!frame || frame.post_type !== 'request') return null
  return {
    requestType: frame.request_type === 'friend' ? 'friend' : 'group',
    subType: frame.sub_type ?? 'add',
    userId: frame.user_id !== undefined ? Number(frame.user_id) : 0,
    groupId: frame.group_id !== undefined ? Number(frame.group_id) : 0,
    comment: String(frame.comment ?? ''),
    flag: String(frame.flag ?? ''),
    selfId: frame.self_id !== undefined ? Number(frame.self_id) : undefined,
  }
}

export class OneBotServer extends EventEmitter {
  #wss = null
  #starting = null
  #connections = new Map()
  #echo = 0
  #pending = new Map()

  constructor(config, logger) {
    super()
    this.config = config
    this.logger = logger
    /**
     * Dry-run mode (v0.4 debugging): while on, action calls are recorded and
     * stubbed instead of being sent, so a synthetic frame can run through the real
     * pipeline with zero QQ side effects.
     *
     * `enabled === true` intercepts EVERY call (used by offline replay, which has
     * no real socket at all). Passing a scope object — `{ chatKey }` — intercepts
     * only calls that target that chat, so a debug window can never swallow a real
     * user's reply in another conversation.
     */
    this.dryRun = false
    this.dryRunScope = null
    this.dryRunCalls = []
  }

  /** Turn dry-run on/off (optionally scoped to one chat); returns the previous value. */
  setDryRun(enabled, scope = null) {
    const previous = { enabled: this.dryRun, scope: this.dryRunScope }
    this.dryRun = enabled === true
    this.dryRunScope = this.dryRun && scope && typeof scope === 'object' ? { ...scope } : null
    if (this.dryRun) this.dryRunCalls = []
    return previous
  }

  /** Does this call belong to the scoped chat? (no scope → every call does) */
  #inDryRunScope(params) {
    if (!this.dryRun) return false
    const scope = this.dryRunScope
    if (!scope) return true
    if (scope.groupId && Number(params?.group_id) === Number(scope.groupId)) return true
    if (scope.userId && Number(params?.user_id) === Number(scope.userId)) return true
    return false
  }

  /** Every action that WOULD have been sent while dry-run was on. */
  takeDryRunCalls() {
    const calls = this.dryRunCalls.slice()
    this.dryRunCalls = []
    return calls
  }

  /**
   * 启动反向 WS 监听。
   *
   * **永不抛、永不挂、可重复调用**：返回 `{ ok: true }` 或 `{ ok: false, code, reason }`。
   * 端口被占（web 宿主与官方桌面端同时跑同一份配置时必然发生）在旧实现里是两连击：
   * `this.emit('error', …)` 没有订阅者 → EventEmitter 直接**抛出**未捕获错误（历史上那次
   * EADDRINUSE 崩溃就是这么来的），而等 `'listening'` 的 Promise 永远不 resolve → 宿主启动卡死。
   * 现在两种情况都变成"如实返回失败"，由上层决定怎么降级（见 lib/index.js 的退避重试）。
   *
   * ⚠️ 幂等：已经在监听时**直接返回 ok:true，绝不去关掉一个健康实例**。
   * 旧实现只关闭"还没绑上"的那个，于是"先超时（ETIMEDOUT）、后重试"这条路上，
   * 第二次 `start()` 会把**已经绑定的 socket 变成孤儿**：端口一直被占、桥却没起来，
   * 日志还反过来赖"端口被另一个进程占用"（对抗性审查实测复现：start→ok、
   * 再 start→EADDRINUSE、`stop()` 之后端口仍然占着）。并发调用也复用同一个 Promise。
   */
  start({ timeoutMs = 5000 } = {}) {
    if (this.#wss && this.#wss.address() !== null) return Promise.resolve({ ok: true, already: true })
    if (this.#starting) return this.#starting
    const { host, port } = this.config
    // 上一次尝试留下的实例：它没在监听（否则上面就返回了），关掉不泄漏。
    if (this.#wss) {
      try { this.#wss.close() } catch {}
      this.#wss = null
    }
    this.#wss = new WebSocketServer({ host, port })
    const wss = this.#wss
    wss.on('error', (error) => {
      this.logger.error(`OneBot server error: ${error.message}`)
      // EventEmitter 的 'error' 事件没有订阅者会**抛出**：只有真有人订阅时才 emit。
      if (this.listenerCount('error') > 0) this.emit('error', error)
      else this.emit('server-error', error)
    })
    wss.on('connection', (socket, request) => this.#accept(socket, request))
    const promise = new Promise((resolve) => {
      if (wss.address() !== null) return resolve({ ok: true })
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        wss.off('listening', onListening)
        wss.off('error', onBindError)
        this.#starting = null
        // 没绑上的实例就地关掉：既不留悬挂的 Server，也不让下一次 start() 关错对象。
        if (result.ok !== true && wss.address() === null) {
          try { wss.close() } catch {}
        }
        resolve(result)
      }
      const onListening = () => {
        this.logger.info(`OneBot reverse-WS listening on ws://${host}:${port}`)
        finish({ ok: true })
      }
      const onBindError = (error) => finish({ ok: false, code: error.code ?? '', reason: String(error.message ?? '监听失败') })
      const timer = setTimeout(() => {
        // 超时 ≠ 没绑上：慢机器上可能刚好在超时后才绑成功，先看 address() 再定结论。
        finish(wss.address() !== null
          ? { ok: true, late: true }
          : { ok: false, code: 'ETIMEDOUT', reason: `监听 ws://${host}:${port} 超时（${timeoutMs}ms）` })
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      wss.once('listening', onListening)
      wss.once('error', onBindError)
    })
    this.#starting = promise
    return promise
  }

  async stop() {
    for (const socket of this.#connections.values()) {
      try { socket.close(1000, 'bridge shutdown') } catch {}
    }
    this.#connections.clear()
    if (this.#wss) await new Promise((resolve) => this.#wss.close(() => resolve()))
    this.#wss = null
  }

  #accept(socket, request) {
    const token = extractBearer(request)
    if (this.config.accessToken && token !== this.config.accessToken) {
      this.logger.warn(`OneBot connection rejected (bad access token) from ${request.socket.remoteAddress}`)
      socket.close(4001, 'invalid access token')
      return
    }
    const id = `${request.socket.remoteAddress}:${Date.now()}:${++this.#echo}`
    this.#connections.set(id, socket)
    this.logger.info(`OneBot bot connected (${this.#connections.size} active)`)
    socket.on('message', (data) => this.#onFrame(socket, data))
    socket.on('close', () => {
      this.#connections.delete(id)
      this.logger.info(`OneBot bot disconnected (${this.#connections.size} active)`)
      this.emit('bot-disconnect', socket)
    })
    socket.on('error', () => {})
    this.emit('bot-connect', socket)
  }

  #onFrame(socket, data) {
    let frame
    try { frame = JSON.parse(String(data)) } catch { return }
    if (frame.echo !== undefined) {
      const pending = this.#pending.get(String(frame.echo))
      if (pending) {
        this.#pending.delete(String(frame.echo))
        pending(frame)
      }
      return
    }
    if (frame.post_type === 'message' && frame.message_type) {
      const userId = Number(frame.user_id)
      const messageType = frame.message_type === 'group' ? 'group' : 'private'
      const groupId = messageType === 'group' ? Number(frame.group_id) : undefined
      const parsed = parseMessage(frame.message, this.config.botQq ?? 0)
      // 转发卡片也算"有内容"：否则「只发一张聊天记录卡片」的消息会在这里被静默丢掉（连 trace 都没有）。
      if ((parsed.text === '' && parsed.records.length === 0 && parsed.images.length === 0 && parsed.files.length === 0 && parsed.forwards.length === 0) || !Number.isFinite(userId)) return
      const atMe = messageType === 'group'
        ? (this.config.botQq ?? 0) === 0 || parsed.ats.includes(this.config.botQq)
        : false
      this.emit('message', {
        bot: socket,
        userId,
        messageType,
        groupId,
        text: parsed.text,
        atMe,
        ats: parsed.ats,
        reply: parsed.reply,
        records: parsed.records,
        images: parsed.images,
        files: parsed.files,
        forwards: parsed.forwards,
        messageId: frame.message_id,
        senderName: (frame.sender && (frame.sender.card || frame.sender.nickname)) || '',
        raw: frame,
      })
    }
    if (frame.post_type === 'notice') {
      const notice = parseNotice(frame)
      if (notice && Number.isFinite(notice.userId)) {
        this.emit('notice', { bot: socket, ...notice })
      }
    }
    if (frame.post_type === 'request') {
      const request = parseRequest(frame)
      if (request && Number.isFinite(request.userId)) {
        this.emit('request', { bot: socket, ...request })
      }
    }
  }

  sendText(socket, messageType, targetId, text) {
    return this.sendSegments(socket, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  /** Send a message as an array of CQ segments (text/face/image). */
  sendSegments(socket, messageType, targetId, segments) {
    const action = messageType === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = { message: segments }
    if (messageType === 'group') params.group_id = targetId
    else params.user_id = targetId
    return this.#call(socket, action, params)
  }

  /** Fetch the full content of a message by id (for quote/reply resolution). */
  getMsg(socket, messageId) {
    return this.#call(socket, 'get_msg', { message_id: Number(messageId) })
  }

  /** Fetch a voice record (optionally converted) — resolves to data.base64. */
  getRecord(socket, file, outFormat = 'mp3') {
    return this.#call(socket, 'get_record', { file, out_format: outFormat })
  }

  /** The most recently connected open bot socket (for delayed sends after reconnects). */
  currentSocket() {
    for (const socket of this.#connections.values()) {
      if (socket.readyState === socket.OPEN) return socket
    }
    return null
  }

  /** Mute (or unmute) a group member (durationSeconds 0 = unmute). */
  setGroupBan(socket, groupId, userId, durationSeconds) {
    return this.#call(socket, 'set_group_ban', { group_id: groupId, user_id: userId, duration: durationSeconds })
  }

  /** Kick a member out of a group. */
  setGroupKick(socket, groupId, userId) {
    return this.#call(socket, 'set_group_kick', { group_id: groupId, user_id: userId })
  }

  // ---- write actions (gate them through ActionGate before calling) ----

  /** Recall a message. */
  deleteMsg(socket, messageId) {
    return this.#call(socket, 'delete_msg', { message_id: Number(messageId) })
  }

  /** Set a member's group card (nickname inside the group). */
  setGroupCard(socket, groupId, userId, card) {
    return this.#call(socket, 'set_group_card', { group_id: groupId, user_id: userId, card: String(card ?? '') })
  }

  /** Set a member's special title (needs owner rights). */
  setGroupSpecialTitle(socket, groupId, userId, title, duration = -1) {
    return this.#call(socket, 'set_group_special_title', {
      group_id: groupId, user_id: userId, special_title: String(title ?? ''), duration,
    })
  }

  /** Whole-group mute on/off. */
  setGroupWholeBan(socket, groupId, enable) {
    return this.#call(socket, 'set_group_whole_ban', { group_id: groupId, enable: Boolean(enable) })
  }

  /** Leave (or dismiss, when owner) a group. */
  setGroupLeave(socket, groupId, isDismiss = false) {
    return this.#call(socket, 'set_group_leave', { group_id: groupId, is_dismiss: Boolean(isDismiss) })
  }

  /** Add a message to the group's essence list. */
  setEssenceMsg(socket, messageId) {
    return this.#call(socket, 'set_essence_msg', { message_id: Number(messageId) })
  }

  deleteEssenceMsg(socket, messageId) {
    return this.#call(socket, 'delete_essence_msg', { message_id: Number(messageId) })
  }

  /** Publish a group notice (NapCat exposes it as `_send_group_notice`). */
  sendGroupNotice(socket, groupId, content, image = '') {
    const params = { group_id: groupId, content: String(content ?? '') }
    if (image) params.image = image
    return this.#call(socket, '_send_group_notice', params)
  }

  /** Emoji reaction on a message (NapCat extension; failures are non-fatal). */
  setMsgEmojiLike(socket, messageId, emojiId = 128077) {
    return this.#call(socket, 'set_msg_emoji_like', { message_id: Number(messageId), emoji_id: Number(emojiId) || 128077 })
  }

  // ---- 互动（v0.5.3「点一下就完事」）----
  // 下面每个 action 名都由真机静态探针逐一确认过：NapCat bootmain/napcat.mjs
  // （QQ 9.9.32-50969）里存在同名 action，参数形状与这里一致。

  /** 群聊戳一戳（NapCat 的 group_poke 与 friend_poke 共用一套参数）。 */
  groupPoke(socket, groupId, userId) {
    return this.#call(socket, 'group_poke', { group_id: Number(groupId), user_id: Number(userId) })
  }

  /** 私聊戳一戳。 */
  friendPoke(socket, userId) {
    return this.#call(socket, 'friend_poke', { user_id: Number(userId) })
  }

  /**
   * 私聊「正在输入」状态（1=正在输入，2=停止输入）。
   * 真机探针：NapCat 的 set_input_status 只拼 C2C 会话，群聊没有这个能力。
   */
  setInputStatus(socket, userId, eventType = 1) {
    return this.#call(socket, 'set_input_status', { user_id: String(userId), event_type: Number(eventType) || 1 })
  }

  /** 谁给这条消息点了表情（NapCat 扩展；返回 { emoji_like_list: [{ user_id, nick_name }] }）。 */
  getEmojiLikes(socket, messageId, emojiId = '128077', { groupId = 0, emojiType = '', count = 50 } = {}) {
    const params = { message_id: String(messageId), emoji_id: String(emojiId), count: Number(count) || 50 }
    if (groupId) params.group_id = String(groupId)
    if (emojiType !== '') params.emoji_type = String(emojiType)
    return this.#call(socket, 'get_emoji_likes', params)
  }

  /** 给某人点赞（QQ 客户端上限就是 10 次；频率过快会返回 1400）。 */
  sendLike(socket, userId, times = 1) {
    return this.#call(socket, 'send_like', { user_id: String(userId), times: Number(times) || 1 })
  }

  /** 标记群会话已读（真机探针：NapCat 按会话标记，不接受单条消息 ID）。 */
  markGroupMsgAsRead(socket, groupId) {
    return this.#call(socket, 'mark_group_msg_as_read', { group_id: String(groupId) })
  }

  /** 标记私聊会话已读。 */
  markPrivateMsgAsRead(socket, userId) {
    return this.#call(socket, 'mark_private_msg_as_read', { user_id: String(userId) })
  }

  // ---- 群运营工具箱（v0.5.4「群运营工具箱」）----
  // action 名与参数形状同样来自真机静态探针（NapCat bootmain/napcat.mjs，QQ 9.9.32-50969）。

  /** 原生群打卡（QQ 的「群签到」，与插件本地的 /签到 积分游戏无关）。 */
  groupSign(socket, groupId) {
    return this.#call(socket, 'set_group_sign', { group_id: String(groupId) })
  }

  /** @全体剩余次数（探针返回 can_at_all / remain_at_all_count_for_group / remain_at_all_count_for_uin）。 */
  getGroupAtAllRemain(socket, groupId) {
    return this.#call(socket, 'get_group_at_all_remain', { group_id: String(groupId) })
  }

  /** 群禁言名单（探针返回 [{ user_id, nickname, shut_up_time }]）。 */
  getGroupShutList(socket, groupId) {
    return this.#call(socket, 'get_group_shut_list', { group_id: String(groupId) })
  }

  /** 群详细信息（扩展）：字段名比 get_group_info 多，能拿到群描述/问题等。 */
  getGroupInfoEx(socket, groupId) {
    return this.#call(socket, 'get_group_info_ex', { group_id: String(groupId) })
  }

  /** 被忽略的入群申请与邀请。 */
  getGroupIgnoredNotifies(socket) {
    return this.#call(socket, 'get_group_ignored_notifies', {})
  }

  /** 批量踢人（原生一次多个 QQ；userIds 必须是字符串数组）。 */
  kickGroupMembers(socket, groupId, userIds, rejectAddRequest = false) {
    return this.#call(socket, 'set_group_kick_members', {
      group_id: String(groupId),
      user_id: (Array.isArray(userIds) ? userIds : [userIds]).map((id) => String(id)),
      reject_add_request: rejectAddRequest === true,
    })
  }

  /** 群待办：设置 / 完成 / 取消（三者共用 { group_id, message_id? / message_seq? }）。 */
  groupTodo(socket, kind, { groupId, messageId = '', messageSeq = '' } = {}) {
    const action = kind === 'complete' ? 'complete_group_todo' : kind === 'cancel' ? 'cancel_group_todo' : 'set_group_todo'
    const params = { group_id: String(groupId) }
    if (String(messageSeq).trim() !== '') params.message_seq = String(messageSeq).trim()
    if (String(messageId).trim() !== '') params.message_id = String(messageId).trim()
    return this.#call(socket, action, params)
  }

  /** 修改群名 / 群备注 / 群头像。 */
  setGroupProfile(socket, kind, { groupId, value = '' } = {}) {
    if (kind === 'remark') return this.#call(socket, 'set_group_remark', { group_id: String(groupId), remark: String(value) })
    if (kind === 'portrait') return this.#call(socket, 'set_group_portrait', { group_id: String(groupId), file: String(value) })
    return this.#call(socket, 'set_group_name', { group_id: String(groupId), group_name: String(value) })
  }

  /** 群成员功能权限（局部更新：没传的项保持不变，与探针文档一致）。 */
  setGroupMemberPermissions(socket, params) {
    return this.#call(socket, 'set_group_member_permissions', params)
  }

  /** 新成员是否可见最近聊天记录。 */
  setGroupNewMemberHistoryVisibility(socket, groupId, visible) {
    return this.#call(socket, 'set_group_new_member_history_visibility', { group_id: String(groupId), visible: visible === true })
  }

  /**
   * 设置 / 取消群管理员。
   *
   * ⚠️ 真机探针（v0.5.8）：`enable` **省略时 NapCat 按 false 处理**（`!!undefined === false`），
   * 也就是"少传一个字段"会静默把人**撤**成普通成员。所以这里永远显式传布尔值，
   * 绝不做成"可选参数"。
   */
  setGroupAdmin(socket, groupId, userId, enable) {
    return this.#call(socket, 'set_group_admin', {
      group_id: String(groupId),
      user_id: String(userId),
      enable: enable === true,
    })
  }

  /**
   * 群成员邀请策略（探针：policy 只接受四个字面量）。
   * 取值：disabled / require_approval / no_approval / no_approval_under_100。
   */
  setGroupMemberInvitePolicy(socket, groupId, policy) {
    return this.#call(socket, 'set_group_member_invite_policy', { group_id: String(groupId), policy: String(policy) })
  }

  /**
   * 群加群方式（add_type 是 QQ 的裸数字，NapCat 官方 schema 只写「加群方式: number」、
   * 没有枚举；探针确认只有 4/5 会连问题/答案一起写：4 带答案、5 只写问题）。
   * 因此问题/答案只在 4/5 时随请求发出，其它取值绝不夹带（否则等于往群设置里写脏字段）。
   */
  setGroupAddOption(socket, groupId, addType, { question = '', answer = '' } = {}) {
    const type = Number(addType)
    const params = { group_id: String(groupId), add_type: type }
    if (type === 4 || type === 5) {
      params.group_question = String(question ?? '')
      params.group_answer = type === 4 ? String(answer ?? '') : ''
    }
    return this.#call(socket, 'set_group_add_option', params)
  }

  /** 群打卡名册（探针：{ group_id } → [{ user_id, nick, time, rank }]，rank 可能是小数）。 */
  getGroupSignedList(socket, groupId) {
    return this.#call(socket, 'get_group_signed_list', { group_id: String(groupId) })
  }

  /**
   * 群系统消息（入群申请 / 被邀请）。探针：`count` 非可选但有 default=50，
   * 返回 `{ invited_requests, InvitedRequest, join_requests }`——后两者是**同一个数组引用**。
   * 元素里的 `request_id` 就是 `set_group_add_request` 要比对的 `flag`（探针：
   * `find(i => i.seq === flag)`，而 `request_id: +i.seq`）。
   */
  getGroupSystemMsg(socket, count = 50) {
    return this.#call(socket, 'get_group_system_msg', { count: Number(count) || 50 })
  }

  /** 可疑好友申请列表（探针：实际字段是 flag(uid) / uin / nick / msg / group_code / time）。 */
  getDoubtFriendsAddRequest(socket, count = 50) {
    return this.#call(socket, 'get_doubt_friends_add_request', { count: Number(count) || 50 })
  }

  /**
   * 处理可疑好友申请。
   * ⚠️ 真机探针：NapCat 的 handler **完全忽略 `approve`**（源码注释「该字段没有语义 仅做保留
   * 强制为True」）——也就是这条路**只能同意**，传 false 也一样放行。所以这里不提供拒绝参数，
   * 调用方必须在文案里说清楚。
   */
  setDoubtFriendsAddRequest(socket, flag) {
    return this.#call(socket, 'set_doubt_friends_add_request', { flag: String(flag) })
  }

  /** 移动群文件（探针：需要 file_id + 当前父目录 + 目标父目录）。 */
  moveGroupFile(socket, groupId, fileId, currentParent, targetParent) {
    return this.#call(socket, 'move_group_file', {
      group_id: String(groupId),
      file_id: String(fileId),
      current_parent_directory: String(currentParent ?? ''),
      target_parent_directory: String(targetParent),
    })
  }

  /** 重命名群文件。 */
  renameGroupFile(socket, groupId, fileId, currentParent, newName) {
    return this.#call(socket, 'rename_group_file', {
      group_id: String(groupId),
      file_id: String(fileId),
      current_parent_directory: String(currentParent ?? ''),
      new_name: String(newName),
    })
  }

  /** 删除群文件。 */
  deleteGroupFile(socket, groupId, fileId) {
    return this.#call(socket, 'delete_group_file', { group_id: String(groupId), file_id: String(fileId) })
  }

  /** 新建群文件目录（兼容字段 folder_name / name 二选一，这里用 folder_name）。 */
  createGroupFileFolder(socket, groupId, folderName) {
    return this.#call(socket, 'create_group_file_folder', { group_id: String(groupId), folder_name: String(folderName) })
  }

  /** 上传图片到群相册（探针确认 action 名是 upload_image_to_qun_album）。 */
  uploadImageToQunAlbum(socket, groupId, albumId, albumName, file) {
    return this.#call(socket, 'upload_image_to_qun_album', {
      group_id: String(groupId),
      album_id: String(albumId),
      album_name: String(albumName ?? ''),
      file: String(file),
    })
  }

  /** Approve/reject a group join (or invite) request. */
  setGroupAddRequest(socket, flag, subType, approve, reason = '') {
    return this.#call(socket, 'set_group_add_request', {
      flag, sub_type: subType === 'invite' ? 'invite' : 'add', approve: Boolean(approve), reason: String(reason ?? ''),
    })
  }

  /** Approve/reject a friend request. */
  setFriendAddRequest(socket, flag, approve, remark = '') {
    return this.#call(socket, 'set_friend_add_request', { flag, approve: Boolean(approve), remark: String(remark ?? '') })
  }

  /** Send a local file into a group / private chat. */
  uploadFile(socket, messageType, targetId, file, name = '', folder = '') {
    const action = messageType === 'group' ? 'upload_group_file' : 'upload_private_file'
    const params = { file, name: name || undefined }
    if (messageType === 'group') {
      params.group_id = targetId
      if (folder) params.folder = folder
    } else {
      params.user_id = targetId
    }
    return this.#call(socket, action, params)
  }

  /** Send a merged-forward ("chat record") card built from node segments. */
  sendForwardMsg(socket, messageType, targetId, nodes) {
    if (messageType === 'group') {
      return this.#call(socket, 'send_group_forward_msg', { group_id: targetId, messages: nodes })
    }
    return this.#call(socket, 'send_private_forward_msg', { user_id: targetId, messages: nodes })
  }

  // ---- read-only actions ----

  /** Fetch a merged-forward message's node list (used to expand recalled cards). */
  getForwardMsg(socket, id) {
    return this.#call(socket, 'get_forward_msg', { message_id: String(id), id: String(id) })
  }

  /** Full group member list (single call is expensive — cache on the caller side). */
  getGroupMemberList(socket, groupId, noCache = false) {
    return this.#call(socket, 'get_group_member_list', { group_id: groupId, no_cache: Boolean(noCache) })
  }

  getGroupMemberInfo(socket, groupId, userId, noCache = true) {
    return this.#call(socket, 'get_group_member_info', { group_id: groupId, user_id: userId, no_cache: Boolean(noCache) })
  }

  /** 机器人自己的登录信息（读）：`{ user_id, nickname }`——用来认"文本 @机器人名"。 */
  getLoginInfo(socket) {
    return this.#call(socket, 'get_login_info', {})
  }

  getGroupInfo(socket, groupId, noCache = true) {
    return this.#call(socket, 'get_group_info', { group_id: groupId, no_cache: Boolean(noCache) })
  }

  getFriendList(socket) {
    return this.#call(socket, 'get_friend_list', {})
  }

  getGroupHonorInfo(socket, groupId, type = 'all') {
    return this.#call(socket, 'get_group_honor_info', { group_id: groupId, type })
  }

  getGroupNotice(socket, groupId) {
    return this.#call(socket, '_get_group_notice', { group_id: groupId })
  }

  getEssenceMsgList(socket, groupId) {
    return this.#call(socket, 'get_essence_msg_list', { group_id: groupId })
  }

  /** Recent history of a group (used for stats backfill / recall recovery). */
  getGroupMsgHistory(socket, groupId, messageSeq = 0, count = 20) {
    return this.#call(socket, 'get_group_msg_history', { group_id: groupId, message_seq: messageSeq, count })
  }

  /** Fetch recent messages of a private chat (NapCat extension; read-only). */
  getFriendMsgHistory(socket, userId, messageSeq = 0, count = 20) {
    return this.#call(socket, 'get_friend_msg_history', { user_id: Number(userId), message_seq: Number(messageSeq) || 0, count: Number(count) || 20 })
  }

  /** Group file list of the root folder (read-only). */
  getGroupRootFiles(socket, groupId) {
    return this.#call(socket, 'get_group_root_files', { group_id: Number(groupId) })
  }

  /** Group file list of one folder (read-only). */
  getGroupFilesByFolder(socket, groupId, folderId) {
    return this.#call(socket, 'get_group_files_by_folder', { group_id: Number(groupId), folder_id: String(folderId ?? '') })
  }

  /** Temporary download URL of one group file (read-only). */
  getGroupFileUrl(socket, groupId, fileId, busid = 0) {
    return this.#call(socket, 'get_group_file_url', { group_id: Number(groupId), file_id: String(fileId ?? ''), busid: Number(busid) || 0 })
  }

  /** OCR an image the bot can already read (NapCat extension; read-only). */
  ocrImage(socket, image) {
    return this.#call(socket, 'ocr_image', { image: String(image ?? '') })
  }

  /** Group album list (NapCat extension; read-only). */
  getQunAlbumList(socket, groupId) {
    return this.#call(socket, 'get_qun_album_list', { group_id: Number(groupId) })
  }

  getVersionInfo(socket) {
    return this.#call(socket, 'get_version_info', {})
  }

  getStatus(socket) {
    return this.#call(socket, 'get_status', {})
  }

  #call(socket, action, params) {
    // 调试用 dry-run：只记录，不发送（注入器与离线回放走这条路，绝不会有 QQ 副作用）。
    // 带 scope 时只拦该会话的调用——注入窗口不能连坐其它会话里真人的回复。
    if (this.#inDryRunScope(params)) {
      this.dryRunCalls.push({ action, params, at: Date.now() })
      return Promise.resolve({ message_id: `dry-${this.dryRunCalls.length}`, dryRun: true })
    }
    const echo = `qq-${++this.#echo}`
    const frame = JSON.stringify({ action, params, echo })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        reject(new Error(`OneBot action ${action} timed out`))
      }, ACTION_TIMEOUT_MS)
      this.#pending.set(echo, (response) => {
        clearTimeout(timer)
        if (response && response.status === 'ok' && response.retcode === 0) resolve(response.data)
        else reject(new Error(`OneBot action ${action} failed: ${JSON.stringify(response)}`))
      })
      if (socket.readyState === socket.OPEN) socket.send(frame)
      else {
        clearTimeout(timer)
        this.#pending.delete(echo)
        console.error(`[qq-bridge] OneBot send failed: action=${action} readyState=${socket.readyState}`)
        reject(new Error('OneBot connection closed'))
      }
    })
  }
}

function extractBearer(request) {
  const header = request.headers && request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
  return ''
}
