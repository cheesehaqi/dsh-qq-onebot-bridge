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

  start() {
    const { host, port, accessToken } = this.config
    this.#wss = new WebSocketServer({ host, port })
    this.#wss.on('listening', () => {
      this.logger.info(`OneBot reverse-WS listening on ws://${host}:${port}`)
    })
    this.#wss.on('error', (error) => {
      this.logger.error(`OneBot server error: ${error.message}`)
      this.emit('error', error)
    })
    this.#wss.on('connection', (socket, request) => this.#accept(socket, request))
    return new Promise((resolve) => {
      if (this.#wss.address() !== null) resolve()
      else this.#wss.once('listening', resolve)
    })
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
