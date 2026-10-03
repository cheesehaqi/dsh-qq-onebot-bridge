/**
 * Bridge-level tests for the v0.5.4 group-ops pack: native sign-in, read-only group
 * queries, batch kick, group todos and the weekly ops report — the wiring in
 * lib/bridge.js (lib/ops.js ships its own unit suite).
 *
 * Every action name and parameter shape asserted here comes from the real-device
 * static probe of the installed NapCat bundle (bootmain/napcat.mjs, QQ 9.9.32-50969);
 * see the header of lib/ops.js for the probe table.
 *
 * The red line this file guards: every new write API must produce ZERO outbound
 * frames during an injected / replayed turn, every disabled switch must report a
 * TRUE reason, and the batch kick must never execute without the explicit confirm.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { Config } from '../lib/index.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
function brief(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, 200)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.calls = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
    this.atAll = { can_at_all: true, remain_at_all_count_for_group: 3, remain_at_all_count_for_uin: 1 }
    this.shutList = [{ user_id: 10002, nickname: '小红', shut_up_time: Math.floor(Date.now() / 1000) + 600 }]
    this.groupInfo = { groupName: '测试群', memberCount: 42 }
    this.ignored = { join_requests: [{ requester_uin: 10003, requester_nick: '小刚' }], invited_requests: [] }
    this.albumList = { album_list: [{ album_id: 'album_1', album_name: '日常' }], attach_info: '', has_more: false }
    this.kickError = null
    // v0.5.8 fixtures
    this.signedList = [
      { user_id: 10001, nick: '小明', time: Math.floor(Date.now() / 1000) - 1800, rank: 1 },
      { user_id: 10002, nick: '小红', time: Math.floor(Date.now() / 1000) - 3600, rank: 2.5 },
    ]
    this.systemMsg = {
      join_requests: [{ request_id: 9001, invitor_uin: 10009, requester_nick: '新人', group_id: 2002, message: '求进群', checked: false }],
      invited_requests: [],
    }
    this.doubts = [{ flag: 'uid_doubt_1', uin: 10010, nick: '可疑', msg: '交个朋友', type: 'doubt' }]
    this.signedError = null
    this.doubtError = null
  }

  #rec(action, params) { this.calls.push({ action, params }) }
  count(action) { return this.calls.filter((call) => call.action === action).length }
  paramsOf(action) { return this.calls.filter((call) => call.action === action).map((call) => call.params) }
  reset() { this.calls.length = 0; this.sent.length = 0 }
  currentSocket() { return this.socket }
  setDryRun() { return { enabled: true, scope: null } }
  takeDryRunCalls() { return [] }

  sendSegments(_bot, messageType, targetId, segments) {
    this.#rec('send_msg', { messageType, targetId, segments })
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: this.sent.length })
  }

  sendText(_bot, messageType, targetId, text) {
    return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  // ---- v0.5.4 group-ops APIs (probe-confirmed names) ----
  groupSign(_socket, groupId) { this.#rec('set_group_sign', { groupId }); return Promise.resolve(null) }
  getGroupAtAllRemain(_socket, groupId) { this.#rec('get_group_at_all_remain', { groupId }); return Promise.resolve(this.atAll) }
  getGroupShutList(_socket, groupId) { this.#rec('get_group_shut_list', { groupId }); return Promise.resolve(this.shutList) }
  getGroupInfoEx(_socket, groupId) { this.#rec('get_group_info_ex', { groupId }); return Promise.resolve(this.groupInfo) }
  // 文本 @ 的学习路径（v0.5.9）：桥开机后会读一次昵称与各群名片。
  getLoginInfo(_socket) {
    this.#rec('get_login_info', {})
    if (this.loginError) return Promise.reject(this.loginError)
    return Promise.resolve({ user_id: 999, nickname: this.botNickname ?? '小鲸鱼' })
  }
  getGroupMemberInfo(_socket, groupId, userId) {
    this.#rec('get_group_member_info', { groupId, userId })
    if (this.memberError) return Promise.reject(this.memberError)
    return Promise.resolve({ user_id: userId, nickname: this.botNickname ?? '小鲸鱼', card: this.botCard ?? '' })
  }
  getGroupIgnoredNotifies(_socket) { this.#rec('get_group_ignored_notifies', {}); return Promise.resolve(this.ignored) }
  kickGroupMembers(_socket, groupId, userIds, rejectAddRequest) {
    this.#rec('set_group_kick_members', { groupId, userIds, rejectAddRequest })
    if (this.kickError) return Promise.reject(this.kickError)
    return Promise.resolve(null)
  }
  groupTodo(_socket, kind, { groupId, messageId, messageSeq }) {
    this.#rec(kind === 'complete' ? 'complete_group_todo' : kind === 'cancel' ? 'cancel_group_todo' : 'set_group_todo', { groupId, messageId, messageSeq })
    return Promise.resolve(null)
  }
  moveGroupFile(_socket, groupId, fileId, currentParent, targetParent) {
    this.#rec('move_group_file', { groupId, fileId, currentParent, targetParent })
    return Promise.resolve({ ok: true })
  }
  renameGroupFile(_socket, groupId, fileId, currentParent, newName) {
    this.#rec('rename_group_file', { groupId, fileId, currentParent, newName })
    return Promise.resolve({ ok: true })
  }
  deleteGroupFile(_socket, groupId, fileId) {
    this.#rec('delete_group_file', { groupId, fileId })
    return Promise.resolve(null)
  }
  createGroupFileFolder(_socket, groupId, folderName) {
    this.#rec('create_group_file_folder', { groupId, folderName })
    return Promise.resolve({ ok: true })
  }
  uploadImageToQunAlbum(_socket, groupId, albumId, albumName, file) {
    this.#rec('upload_image_to_qun_album', { groupId, albumId, albumName, file })
    return Promise.resolve({ ok: true })
  }
  getQunAlbumList(_socket, groupId) {
    this.#rec('get_qun_album_list', { groupId })
    return Promise.resolve(this.albumList)
  }
  setGroupProfile(_socket, kind, { groupId, value }) {
    this.#rec(kind === 'remark' ? 'set_group_remark' : kind === 'portrait' ? 'set_group_portrait' : 'set_group_name', { groupId, value })
    return Promise.resolve(null)
  }
  setGroupMemberPermissions(_socket, params) {
    this.#rec('set_group_member_permissions', { ...params })
    return Promise.resolve(null)
  }
  setGroupNewMemberHistoryVisibility(_socket, groupId, visible) {
    this.#rec('set_group_new_member_history_visibility', { groupId, visible })
    return Promise.resolve(null)
  }

  // ---- v0.5.8：管理员 / 邀请策略 / 加群方式 / 打卡名册 / 申请拉取 ----
  setGroupAdmin(_socket, groupId, userId, enable) {
    this.#rec('set_group_admin', { groupId, userId, enable })
    // 真机现场：`/设管理 <不在群里的号>` → NapCat 返回 retcode 1200 get Uid Error
    if (this.adminError) return Promise.reject(new Error(this.adminError))
    return Promise.resolve(null)
  }
  setGroupMemberInvitePolicy(_socket, groupId, policy) {
    this.#rec('set_group_member_invite_policy', { groupId, policy })
    return Promise.resolve(null)
  }
  setGroupAddOption(_socket, groupId, addType, { question = '', answer = '' } = {}) {
    const params = { groupId, addType }
    if (addType === 4 || addType === 5) {
      params.question = question
      params.answer = addType === 4 ? answer : ''
    }
    this.#rec('set_group_add_option', params)
    return Promise.resolve(null)
  }
  getGroupSignedList(_socket, groupId) {
    this.#rec('get_group_signed_list', { groupId })
    if (this.signedError) return Promise.reject(this.signedError)
    return Promise.resolve(this.signedList)
  }
  getGroupSystemMsg(_socket, count) {
    this.#rec('get_group_system_msg', { count })
    return Promise.resolve(this.systemMsg)
  }
  getDoubtFriendsAddRequest(_socket, count) {
    this.#rec('get_doubt_friends_add_request', { count })
    if (this.doubtError) return Promise.reject(this.doubtError)
    return Promise.resolve(this.doubts)
  }
  setDoubtFriendsAddRequest(_socket, flag) {
    this.#rec('set_doubt_friends_add_request', { flag })
    return Promise.resolve(null)
  }
  setGroupAddRequest(_socket, flag, subType, approve, reason) {
    this.#rec('set_group_add_request', { flag, subType, approve, reason })
    return Promise.resolve(null)
  }
  setFriendAddRequest(_socket, flag, approve, reason) {
    this.#rec('set_friend_add_request', { flag, approve, reason })
    return Promise.resolve(null)
  }

  // harmless stubs
  getMsg() { return Promise.resolve({ message: [] }) }
  sendForwardMsg() { return Promise.resolve({ message_id: 1 }) }
  uploadFile() { return Promise.resolve({}) }
  deleteMsg() { return Promise.resolve({}) }
  sendGroupNotice() { return Promise.resolve({}) }
  setGroupWholeBan() { return Promise.resolve({}) }
  setGroupBan() { return Promise.resolve({}) }
  setGroupKick() { return Promise.resolve({}) }
  setGroupLeave(_socket, groupId, isDismiss) {
    this.#rec('set_group_leave', { groupId, isDismiss })
    return Promise.resolve({})
  }
  getForwardMsg() { return Promise.resolve({ messages: [] }) }
  getGroupMemberList() { return Promise.resolve([]) }
  getFriendList() { return Promise.resolve([]) }
}

const QUIET_BASE = {
  host: '127.0.0.1',
  port: 0,
  accessToken: '',
  allowUsers: [1001],
  allowGroups: [2002],
  botQq: 999,
  botName: '小鲸鱼',
  replyOnlyWhenMentioned: true,
  acceptPrivate: true,
  sessionMode: 'chat',
  sessionResumeEnabled: false,
  quietHours: [],
  quietHoursEnabled: false,
  notifyEnabled: false,
  injectEnabled: false,
  injectDryRun: true,
  recordInbound: false,
  traceEnabled: true,
  traceLevel: 'debug',
  traceMemorySize: 2000,
  actionAuditEnabled: false,
  adminEnabled: true,
  adminUsers: [1001],
  engageEnabled: false,
  reactionStatsEnabled: false,
  sendLikeEnabled: false,
  markReadEnabled: false,
  pokeEnabled: false,
  groupOpsEnabled: false,
  nativeSignEnabled: false,
  opsReadEnabled: true,
  opsKickEnabled: false,
  opsKickBatchSize: 20,
  opsTodoEnabled: false,
  opsReportEnabled: false,
  opsReportDays: 7,
  webhookEnabled: false,
  broadcastEnabled: false,
  autoHealEnabled: false,
  keywordEnabled: false,
  fortuneEnabled: false,
  diceEnabled: false,
  pointsEnabled: false,
  statsEnabled: false,
  checkinEnabled: false,
  gameEnabled: false,
  reminderEnabled: false,
  recurringReminderEnabled: false,
  todoEnabled: false,
  voteEnabled: false,
  summaryEnabled: false,
  exportEnabled: false,
  dailyReportEnabled: false,
  mcStatusEnabled: false,
  imageGenEnabled: false,
  ttsEnabled: false,
  sttEnabled: false,
  voiceReadingEnabled: false,
  verifyEnabled: false,
  filterEnabled: false,
  floodEnabled: false,
  antiRecallEnabled: false,
  welcomeEnabled: false,
  autoCollectStickers: false,
  faceEnabled: false,
  privateImageView: false,
  fileTransferEnabled: false,
  agentMediaToolsEnabled: false,
  memoryEnabled: false,
  rateLimitEnabled: false,
}

const dirs = []
function freshCwd() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-ops-test-'))
  dirs.push(dir)
  return dir
}

function makeBridge(overrides = {}) {
  const cwd = overrides.cwd ?? freshCwd()
  const server = new MockServer()
  const turns = []
  let seq = 0
  const makeCtx = () => {
    const agentCtx = { tools: { register: (t) => t }, systemPrompt: { section: (s) => s } }
    const newHandle = (sessionId, setup) => {
      const id = String(sessionId || `qq-ops-${++seq}`)
      if (typeof setup === 'function') setup(agentCtx)
      return {
        agent: {
          id, status: 'idle',
          followup(message) {
            const blocks = Array.isArray(message?.content) ? message.content : []
            turns.push({ sessionId: id, text: blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('') })
            return Promise.resolve()
          },
          cancel() {},
        },
        sessionId: id,
        dispose: async () => {},
      }
    }
    return {
      on: () => () => {},
      get: () => undefined,
      agents: {
        create: async ({ sessionId, setup }) => newHandle(sessionId, setup),
        resume: async ({ resumeSessionId, setup }) => newHandle(resumeSessionId, setup),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
      logger: () => ({ info() {}, warn() {}, error() {} }),
    }
  }
  const config = { ...Config({}), ...QUIET_BASE, ...overrides, cwd }
  const bridge = new QQBridge(makeCtx(), config, server, { info() {}, warn() {}, error() {} })
  bridge.start()

  let seqMsgId = 0
  function message(text, extra = {}) {
    return {
      bot: server.socket,
      userId: 1001,
      messageType: 'group',
      groupId: 2002,
      text,
      atMe: true,
      ats: [],
      reply: null,
      records: [], images: [], files: [], forwards: [],
      messageId: String(8000 + (++seqMsgId)),
      senderName: '小明',
      raw: { message: [] },
      ...extra,
    }
  }
  async function send(msg, waitMs = 140) {
    const before = server.sent.length
    server.emit('message', msg)
    await sleep(waitMs)
    return server.sent.slice(before)
      .map((item) => item.segments.map((s) => s.data?.text ?? `[${s.type}]`).join(''))
      .join('\n')
  }
  const traceStage = (stage, ok = null) => bridge.trace.recent({ limit: 5000, stage, ok })
  const reasonsOf = (events) => events.map((e) => String(e?.reason ?? '')).join(' | ')

  return {
    bridge, server, config, cwd, turns, message, send, traceStage, reasonsOf,
    stop: () => bridge.stop(),
  }
}

// ---------------------------------------------------------------------------
// A0. 文本 @机器人（v0.5.9 真机抓到：客户端把 @ 发成纯文本，群里一个字都不回）
// ---------------------------------------------------------------------------
{
  // 配了别名：正文里的 "@小鲸鱼 /禁言名单" 也算 @，命令要真的执行（读一次群禁言名单）。
  const t = makeBridge({ groupOpsEnabled: true, mentionAliases: ['小鲸鱼'] })
  await t.send(t.message('@小鲸鱼 /禁言名单', { atMe: false, ats: [] }))
  check('S1 文本 @ + 配置别名 → 群命令照常执行（不再静默丢掉）',
    t.server.count('get_group_shut_list') === 1, String(t.server.count('get_group_shut_list')))
  check('S2 放行原因写进了 trace（说清是"文本 @ 命中"而不是真 at 段）',
    t.reasonsOf(t.traceStage('mention', true)).includes('文本 @ 命中'), t.reasonsOf(t.traceStage('mention', true)))
  t.stop()
}
{
  // 没配别名、也没学到名字：仍然按"没 @"忽略（零调用），且 trace 说真话。
  const t = makeBridge({ groupOpsEnabled: true })
  t.server.botNickname = ''
  t.server.botCard = ''
  const out = await t.send(t.message('@某个不存在的东西 /禁言名单', { atMe: false, ats: [] }))
  check('S3 文本 @ 命中不了任何名字 → 仍然忽略且零出站',
    out === '' && t.server.count('get_group_shut_list') === 0, `${brief(out)}|${t.server.count('get_group_shut_list')}`)
  check('S4 忽略原因是"群聊未 @ 机器人"', t.reasonsOf(t.traceStage('mention', false)).includes('群聊未 @ 机器人'),
    t.reasonsOf(t.traceStage('mention', false)))
  t.stop()
}
{
  // 没配别名，但桥自己学到了昵称 → 也要认（真机上就是这种情况：@Deepseek_小鲸鱼）。
  const t = makeBridge({ groupOpsEnabled: true })
  t.server.botNickname = 'Deepseek_小鲸鱼'
  await t.send(t.message('@Deepseek_小鲸鱼 /禁言名单', { atMe: false, ats: [] }))
  check('S5 未配置别名时，桥学到的昵称同样能认（读 get_login_info）',
    t.server.count('get_group_shut_list') === 1 && t.reasonsOf(t.traceStage('mention', true)).includes('Deepseek_小鲸鱼'),
    `${t.server.count('get_group_shut_list')}|${t.reasonsOf(t.traceStage('mention', true))}`)
  check('S6 学习只读一次', t.server.count('get_login_info') === 1, String(t.server.count('get_login_info')))
  await t.send(t.message('@Deepseek_小鲸鱼 /禁言名单', { atMe: false, ats: [] }))
  check('S7 第二条同样认（缓存生效，没有第二次登录信息读取）',
    t.server.count('get_group_shut_list') === 2 && t.server.count('get_login_info') === 1,
    `shut=${t.server.count('get_group_shut_list')} login=${t.server.count('get_login_info')}`)
  t.stop()
}

// ---------------------------------------------------------------------------
// A0-b. 机器人掉线通知（v0.5.9 真机抓到：以前只记"未处理的 notice"，控制台看不出来）
// ---------------------------------------------------------------------------
{
  const t = makeBridge({})
  t.server.emit('notice', {
    bot: t.server.socket, noticeType: 'bot_offline', subType: 'kick',
    userId: 999, selfId: 999, groupId: 0, raw: {},
  })
  await sleep(120)
  const notices = t.traceStage('notice', false)
  check('S8 bot_offline 留下带真原因的 trace（不再是"未处理的 notice"）',
    t.reasonsOf(notices).includes('机器人已离线'), t.reasonsOf(notices).slice(0, 120))
  const snap = JSON.parse(readFileSync(join(t.cwd, 'qq-runtime.json'), 'utf8'))
  check('S9 掉线写进运行快照（控制台的「机器人：离线」才有数据）',
    snap.botOnline === false && Number(snap.botOnlineAt) > 0, JSON.stringify({ botOnline: snap.botOnline }))
  t.server.emit('notice', { bot: t.server.socket, noticeType: 'bot_online', subType: '', userId: 999, selfId: 999, groupId: 0, raw: {} })
  await sleep(120)
  const back = JSON.parse(readFileSync(join(t.cwd, 'qq-runtime.json'), 'utf8'))
  check('S10 bot_online 把状态改回在线', back.botOnline === true, JSON.stringify({ botOnline: back.botOnline }))
  t.stop()
}

// ---------------------------------------------------------------------------
// A. 总开关与关闭分支的真实原因
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: false })
  const out = await t.send(t.message('/群打卡'))
  check('A1 groupOpsEnabled=false → 中文提示且零业务调用',
    out.includes('groupOpsEnabled=false') && t.server.calls.filter((c) => c.action !== 'send_msg').length === 0,
    brief(out))
  check('A1 trace 说明总开关关着',
    t.reasonsOf(t.traceStage('ops')).includes('groupOpsEnabled=false'), brief(t.reasonsOf(t.traceStage('ops'))))
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, nativeSignEnabled: false })
  const out = await t.send(t.message('/群打卡'))
  check('A2 nativeSignEnabled=false → 点名该开关并提示与本地签到的区别',
    out.includes('nativeSignEnabled=false') && out.includes('积分'), brief(out))
  check('A2 零调用', t.server.count('set_group_sign') === 0)
  t.stop()
}

// ---------------------------------------------------------------------------
// B. 原生群打卡：注入回合 0 出站
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, nativeSignEnabled: true })
  const out = await t.send(t.message('/群打卡'))
  check('B1 /群打卡 发出 set_group_sign', t.server.count('set_group_sign') === 1, brief(t.server.paramsOf('set_group_sign')))
  check('B1 参数只有 group_id', JSON.stringify(t.server.paramsOf('set_group_sign')[0]) === '{"groupId":"2002"}', brief(t.server.paramsOf('set_group_sign')[0]))
  check('B1 回执给出结果', out.includes('打卡'), brief(out))

  t.server.reset()
  const injected = await t.send(t.message('/群打卡', { __injected: true }))
  check('B2 注入回合 0 出站：set_group_sign', t.server.count('set_group_sign') === 0, `count=${t.server.count('set_group_sign')}`)
  check('B2 理由说明是注入/回放回合', injected.includes('注入/回放回合不写 QQ'), brief(injected))

  t.server.reset()
  await t.send(t.message('/群打卡', { __replayed: true }))
  check('B3 回放回合 0 出站：set_group_sign', t.server.count('set_group_sign') === 0)

  t.server.reset()
  const dm = await t.send(t.message('/群打卡', { messageType: 'private', groupId: undefined }))
  check('B4 私聊里拒绝并说明只能群聊', dm.includes('只能在群里'), brief(dm))
  check('B4 私聊零调用', t.server.count('set_group_sign') === 0)
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, nativeSignEnabled: true, injectDryRun: false })
  await t.send(t.message('/群打卡', { __injected: true }))
  check('B5 injectDryRun=false（真发模式）时注入的打卡照常执行', t.server.count('set_group_sign') === 1, `count=${t.server.count('set_group_sign')}`)
  t.stop()
}

// ---------------------------------------------------------------------------
// C. 只读查询：真实数据 + 注入回合不访问 QQ
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true })
  const at = await t.send(t.message('/全体余量'))
  check('C1 /全体余量 调 get_group_at_all_remain', t.server.count('get_group_at_all_remain') === 1)
  check('C1 结果显示本群剩余次数', at.includes('本群剩余：3 次'), brief(at))
  const shut = await t.send(t.message('/禁言名单'))
  check('C2 /禁言名单 调 get_group_shut_list', t.server.count('get_group_shut_list') === 1)
  check('C2 显示昵称与剩余时间', shut.includes('小红') && shut.includes('还剩'), brief(shut))
  const info = await t.send(t.message('/群详细'))
  check('C3 /群详细 调 get_group_info_ex（/群资料 已被既有的基础群信息占用）', t.server.count('get_group_info_ex') === 1)
  check('C3 显示群名与人数', info.includes('测试群') && info.includes('42'), brief(info))
  const ignored = await t.send(t.message('/入群通知'))
  check('C4 /入群通知 调 get_group_ignored_notifies', t.server.count('get_group_ignored_notifies') === 1)
  check('C4 列出被忽略的申请', ignored.includes('小刚'), brief(ignored))
  check('C4 trace 记录查询完成', t.reasonsOf(t.traceStage('ops')).includes('查询完成'), brief(t.reasonsOf(t.traceStage('ops'))))

  t.server.reset()
  const injected = await t.send(t.message('/全体余量', { __injected: true }))
  check('C5 注入回合 0 出站：只读查询', t.server.calls.filter((c) => c.action.startsWith('get_group')).length === 0, brief(t.server.calls.map((c) => c.action)))
  check('C5 明确标注未真正访问 QQ', injected.includes('未真正访问 QQ'), brief(injected))
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsReadEnabled: false })
  const out = await t.send(t.message('/禁言名单'))
  check('C6 opsReadEnabled=false → 点名开关且零调用',
    out.includes('opsReadEnabled=false') && t.server.count('get_group_shut_list') === 0, brief(out))
  t.stop()
}

// ---------------------------------------------------------------------------
// D. 批量踢：二次确认 + 分批 + 红线
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, opsKickEnabled: true, opsKickBatchSize: 20 })
  const first = await t.send(t.message('/批量踢 10002 10003'))
  check('D1 第一条命令只给确认提示，不踢人', t.server.count('set_group_kick_members') === 0 && first.includes('确认'), brief(first))
  check('D1 提示里带上人数与自助确认方式', first.includes('2 人') && first.includes('/批量踢 确认'), brief(first))

  const confirm = await t.send(t.message('/批量踢 确认'))
  check('D2 确认后真的调用 set_group_kick_members', t.server.count('set_group_kick_members') === 1, brief(t.server.paramsOf('set_group_kick_members')))
  check('D2 参数是 user_id 数组', Array.isArray(t.server.paramsOf('set_group_kick_members')[0].userIds)
    && t.server.paramsOf('set_group_kick_members')[0].userIds.length === 2, brief(t.server.paramsOf('set_group_kick_members')[0]))
  check('D2 回执给出成功人数', confirm.includes('已移出 2/2 人'), brief(confirm))

  t.server.reset()
  const again = await t.send(t.message('/批量踢 确认'))
  check('D3 重复确认 → 说清没有待确认记录', again.includes('没有待确认'), brief(again))
  check('D3 零调用', t.server.count('set_group_kick_members') === 0)
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsKickEnabled: true, opsKickBatchSize: 2 })
  await t.send(t.message('/批量踢 10002 10003 10004 10005'))
  t.server.reset()
  await t.send(t.message('/批量踢 确认'))
  check('D4 超过批次上限时分成多批（永不截断）', t.server.count('set_group_kick_members') === 2, `batches=${t.server.count('set_group_kick_members')}`)
  const sizes = t.server.paramsOf('set_group_kick_members').map((p) => p.userIds.length)
  check('D4 每批人数符合配置上限', sizes.every((n) => n <= 2) && sizes.reduce((a, b) => a + b, 0) === 4, JSON.stringify(sizes))
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsKickEnabled: true, allowUsers: [1001, 10001], adminUsers: [1001, 10001] })
  // 发起人必须用 5 位以上（仓库约定 QQ 号 5–11 位），否则根本进不了目标列表；
  // 也要在白名单里，否则消息在到达命令处理之前就被 #allowed 拦掉了。
  const out = await t.send(t.message('/批量踢 10001', { userId: 10001 }))
  check('D5 名单含发起人自己 → 拒绝', out.includes('你自己') && t.server.count('set_group_kick_members') === 0, brief(out))
  const bad = await t.send(t.message('/批量踢 abc'))
  check('D6 非法 QQ → 提示且不进入确认流程', bad.includes('用法') || bad.includes('合法'), brief(bad))
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsKickEnabled: true, adminUsers: [1007] })
  const out = await t.send(t.message('/批量踢 10002'))
  check('D7 非管理员被拒', out.includes('管理员') && t.server.count('set_group_kick_members') === 0, brief(out))
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsKickEnabled: false })
  const out = await t.send(t.message('/批量踢 10002'))
  check('D8 opsKickEnabled=false → 点名开关且零调用',
    out.includes('opsKickEnabled=false') && t.server.count('set_group_kick_members') === 0, brief(out))
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsKickEnabled: true })
  await t.send(t.message('/批量踢 10002'))
  t.server.reset()
  const injected = await t.send(t.message('/批量踢 确认', { __injected: true }))
  check('D9 注入回合 0 出站：批量踢', t.server.count('set_group_kick_members') === 0, `count=${t.server.count('set_group_kick_members')}`)
  check('D9 理由说明是注入/回放回合', injected.includes('注入/回放回合不写 QQ'), brief(injected))
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsKickEnabled: true })
  await t.send(t.message('/批量踢 10002'))
  t.bridge.pendingKickBatch.set('g:2002', { userIds: ['10002'], expiresAt: Date.now() - 1 })
  const out = await t.send(t.message('/批量踢 确认'))
  check('D10 过期的确认被拒绝', out.includes('超时') || out.includes('没有待确认'), brief(out))
  check('D10 过期时零调用', t.server.count('set_group_kick_members') === 0)
  t.stop()
}

// ---------------------------------------------------------------------------
// E. 群待办
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, opsTodoEnabled: true })
  const noQuote = await t.send(t.message('/待办'))
  check('E1 没引用消息 → 用中文说明怎么用', noQuote.includes('引用一条消息'), brief(noQuote))
  check('E1 零调用', t.server.count('set_group_todo') === 0)

  const set = await t.send(t.message('/待办', { reply: { messageId: '777' } }))
  check('E2 引用消息后设置成功', t.server.count('set_group_todo') === 1, brief(t.server.paramsOf('set_group_todo')))
  check('E2 参数带 group_id + message_id',
    t.server.paramsOf('set_group_todo')[0].groupId === '2002' && t.server.paramsOf('set_group_todo')[0].messageId === '777',
    brief(t.server.paramsOf('set_group_todo')[0]))

  await t.send(t.message('/完成待办', { reply: { messageId: '777' } }))
  check('E3 /完成待办 → complete_group_todo', t.server.count('complete_group_todo') === 1)
  await t.send(t.message('/取消待办', { reply: { messageId: '777' } }))
  check('E4 /取消待办 → cancel_group_todo', t.server.count('cancel_group_todo') === 1)

  t.server.reset()
  await t.send(t.message('/待办', { reply: { messageId: '777' }, __injected: true }))
  check('E5 注入回合 0 出站：群待办', t.server.count('set_group_todo') === 0, `count=${t.server.count('set_group_todo')}`)
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsTodoEnabled: false })
  const out = await t.send(t.message('/待办', { reply: { messageId: '1' } }))
  check('E6 opsTodoEnabled=false → 点名开关且零调用',
    out.includes('opsTodoEnabled=false') && t.server.count('set_group_todo') === 0, brief(out))
  t.stop()
}

// ---------------------------------------------------------------------------
// F. 周报：本地计数、不访问 QQ、跨重启保留
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, opsReportEnabled: true })
  await t.send(t.message('大家早'))
  await t.send(t.message('今天玩什么'))
  t.server.emit('notice', { bot: null, noticeType: 'group_increase', groupId: 2002, userId: 10005, selfId: 999 })
  await sleep(80)
  t.server.emit('notice', { bot: null, noticeType: 'group_ban', groupId: 2002, userId: 10005, duration: 60 })
  await sleep(80)
  const report = await t.send(t.message('/周报'))
  check('F1 /周报 统计到消息', report.includes('消息：2'), brief(report))
  check('F1 /周报 统计到入群', report.includes('入群：1'), brief(report))
  check('F1 /周报 统计到禁言', report.includes('禁言：1'), brief(report))
  check('F1 /周报 不访问 QQ',
    t.server.calls.filter((c) => c.action !== 'send_msg').length === 0, brief(t.server.calls.map((c) => c.action)))
  check('F1 trace 说明只读本地',
    t.reasonsOf(t.traceStage('ops')).includes('只读本地 JSON'), brief(t.reasonsOf(t.traceStage('ops'))))

  const injected = await t.send(t.message('/周报', { __injected: true }))
  check('F2 注入回合 /周报 照常回答（纯本地）', injected.includes('运营周报'), brief(injected))

  const file = join(t.cwd, 'qq-ops.json')
  check('F3 计数落盘到 qq-ops.json', existsSync(file) && readFileSync(file, 'utf8').includes('message'), existsSync(file) ? 'present' : 'missing')
  t.stop()

  const t2 = makeBridge({ groupOpsEnabled: true, opsReportEnabled: true, cwd: t.cwd })
  const report2 = await t2.send(t2.message('/周报'))
  check('F4 重启后计数被恢复', report2.includes('消息：2'), brief(report2))
  t2.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsReportEnabled: false })
  await t.send(t.message('不计数'))
  const out = await t.send(t.message('/周报'))
  check('F5 opsReportEnabled=false → 点名开关', out.includes('opsReportEnabled=false'), brief(out))
  check('F5 未启用时不写计数文件', !existsSync(join(t.cwd, 'qq-ops.json')))
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsReportEnabled: true })
  const empty = await t.send(t.message('/周报'))
  check('F6 没有任何事件时给中文说明', empty.includes('还没有记录到运营事件'), brief(empty))
  t.stop()
}

// ---------------------------------------------------------------------------
// G. 文件整理（破坏性 → 管理员 + 显式开关 + 注入 0 出站）
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, opsFileEnabled: true })
  const mv = await t.send(t.message('/移动文件 /f1 /dst'))
  check('G1 /移动文件 发出 move_group_file', t.server.count('move_group_file') === 1, brief(t.server.paramsOf('move_group_file')))
  check('G1 参数带 current/target 两个目录',
    t.server.paramsOf('move_group_file')[0].targetParent === '/dst', brief(t.server.paramsOf('move_group_file')[0]))
  check('G1 回执是成功文案', mv.includes('已移动'), brief(mv))

  const rn = await t.send(t.message('/重命名文件 /f1 新名字.jpg'))
  check('G2 /重命名文件 发出 rename_group_file', t.server.count('rename_group_file') === 1)
  check('G2 新名字完整保留（含扩展名）', t.server.paramsOf('rename_group_file')[0].newName === '新名字.jpg', brief(t.server.paramsOf('rename_group_file')[0]))

  const del = await t.send(t.message('/删文件 /f1'))
  check('G3 /删文件 发出 delete_group_file', t.server.count('delete_group_file') === 1)
  const mk = await t.send(t.message('/新建文件夹 截图 归档'))
  check('G4 /新建文件夹 发出 create_group_file_folder', t.server.count('create_group_file_folder') === 1)
  check('G4 名字里的空格被保留', t.server.paramsOf('create_group_file_folder')[0].folderName === '截图 归档', brief(t.server.paramsOf('create_group_file_folder')[0]))
  check('G4 回执说清做了什么', mk.includes('已新建文件夹'), brief(mk))

  const usage = await t.send(t.message('/移动文件 /f1'))
  check('G5 缺目标目录 → 中文原因且不发请求', usage.includes('目标目录'), brief(usage))

  t.server.reset()
  await t.send(t.message('/删文件 /f1', { __injected: true }))
  check('G6 注入回合 0 出站：delete_group_file', t.server.count('delete_group_file') === 0, `count=${t.server.count('delete_group_file')}`)
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsFileEnabled: false })
  const out = await t.send(t.message('/删文件 /f1'))
  check('G7 opsFileEnabled=false → 点名开关且零调用',
    out.includes('opsFileEnabled=false') && t.server.count('delete_group_file') === 0, brief(out))
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsFileEnabled: true, adminUsers: [1007] })
  const out = await t.send(t.message('/删文件 /f1'))
  check('G8 非管理员不能整理文件', out.includes('管理员') && t.server.count('delete_group_file') === 0, brief(out))
  t.stop()
}

// ---------------------------------------------------------------------------
// H. 相册上传（按名字解析相册 ID + 注入 0 出站）
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, opsAlbumUploadEnabled: true })
  const noImage = await t.send(t.message('/传图 日常'))
  check('H1 没有图片 → 中文提示且零调用', noImage.includes('引用一张图片') && t.server.count('upload_image_to_qun_album') === 0, brief(noImage))

  const byName = await t.send(t.message('/传图 日常', { images: [{ file: 'a.jpg' }] }))
  check('H2 按相册名去列表里找 ID', t.server.count('get_qun_album_list') === 1 && t.server.count('upload_image_to_qun_album') === 1, brief(t.server.calls.map((c) => c.action)))
  check('H2 上传参数用找到的 album_id',
    t.server.paramsOf('upload_image_to_qun_album')[0].albumId === 'album_1'
    && t.server.paramsOf('upload_image_to_qun_album')[0].albumName === '日常',
    brief(t.server.paramsOf('upload_image_to_qun_album')[0]))
  check('H2 回执带上相册名', byName.includes('日常'), brief(byName))

  t.server.reset()
  await t.send(t.message('/传图 @album_9', { images: [{ file: 'b.jpg' }] }))
  check('H3 @ID 写法跳过列表查询', t.server.count('get_qun_album_list') === 0 && t.server.count('upload_image_to_qun_album') === 1)
  check('H3 直接用给定的相册 ID', t.server.paramsOf('upload_image_to_qun_album')[0].albumId === 'album_9', brief(t.server.paramsOf('upload_image_to_qun_album')[0]))

  t.server.reset()
  const missing = await t.send(t.message('/传图 不存在的相册', { images: [{ file: 'c.jpg' }] }))
  check('H4 相册名找不到 → 列出可用相册且不上传',
    missing.includes('没有') && t.server.count('upload_image_to_qun_album') === 0, brief(missing))

  t.server.reset()
  await t.send(t.message('/传图 @album_9', { images: [{ file: 'd.jpg' }], __injected: true }))
  check('H5 注入回合 0 出站：upload_image_to_qun_album', t.server.count('upload_image_to_qun_album') === 0, `count=${t.server.count('upload_image_to_qun_album')}`)
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsAlbumUploadEnabled: false })
  const out = await t.send(t.message('/传图 日常', { images: [{ file: 'a.jpg' }] }))
  check('H6 opsAlbumUploadEnabled=false → 点名开关且零调用',
    out.includes('opsAlbumUploadEnabled=false') && t.server.count('upload_image_to_qun_album') === 0, brief(out))
  t.stop()
}

// ---------------------------------------------------------------------------
// I. 群资料与策略（局部更新语义 + 注入 0 出站）
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, opsProfileEnabled: true })
  await t.send(t.message('/群名 新群名'))
  check('I1 /群名 发出 set_group_name', t.server.count('set_group_name') === 1, brief(t.server.paramsOf('set_group_name')))
  check('I1 值原样传出', t.server.paramsOf('set_group_name')[0].value === '新群名', brief(t.server.paramsOf('set_group_name')[0]))
  await t.send(t.message('/群备注 这是备注'))
  check('I2 /群备注 发出 set_group_remark', t.server.count('set_group_remark') === 1)
  const long = await t.send(t.message(`/群名 ${'x'.repeat(31)}`))
  check('I3 群名过长 → 拒绝且零调用', long.includes('太长'), brief(long))
  t.server.reset()
  await t.send(t.message('/群名 注入改名', { __injected: true }))
  check('I4 注入回合 0 出站：set_group_name', t.server.count('set_group_name') === 0, `count=${t.server.count('set_group_name')}`)
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsPolicyEnabled: true })
  // 命令名是 /群权限 而不是 /成员权限：`/成员` 支持紧贴写法，会把「/成员权限 …」整条吃掉。
  await t.send(t.message('/群权限 相册=关'))
  check('I5 /群权限 只提交写出来的项（探针：未传的保持不变）',
    t.server.count('set_group_member_permissions') === 1
    && Object.keys(t.server.paramsOf('set_group_member_permissions')[0]).join(',') === 'group_id,allow_member_upload_album',
    brief(t.server.paramsOf('set_group_member_permissions')[0]))
  check('I5 关被解析成 false', t.server.paramsOf('set_group_member_permissions')[0].allow_member_upload_album === false)

  t.server.reset()
  await t.send(t.message('/群权限 相册=开 临时会话=关 新群聊=开'))
  check('I6 三项一起改', Object.keys(t.server.paramsOf('set_group_member_permissions')[0]).length === 4, brief(t.server.paramsOf('set_group_member_permissions')[0]))

  const none = await t.send(t.message('/群权限'))
  check('I7 一项都没给 → 中文用法提示且零调用',
    none.includes('用法') && t.server.count('set_group_member_permissions') === 1, brief(none))

  await t.send(t.message('/历史可见 关'))
  check('I8 /历史可见 发出 set_group_new_member_history_visibility',
    t.server.count('set_group_new_member_history_visibility') === 1
    && t.server.paramsOf('set_group_new_member_history_visibility')[0].visible === false,
    brief(t.server.paramsOf('set_group_new_member_history_visibility')))

  t.server.reset()
  await t.send(t.message('/历史可见 开', { __injected: true }))
  check('I9 注入回合 0 出站：历史可见', t.server.count('set_group_new_member_history_visibility') === 0)
  t.server.reset()
  await t.send(t.message('/群权限 相册=关', { __injected: true }))
  check('I9 注入回合 0 出站：群权限', t.server.count('set_group_member_permissions') === 0)
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, opsPolicyEnabled: false })
  const out = await t.send(t.message('/历史可见 开'))
  check('I10 opsPolicyEnabled=false → 点名开关且零调用',
    out.includes('opsPolicyEnabled=false') && t.server.count('set_group_new_member_history_visibility') === 0, brief(out))
  t.stop()
}

// ---------------------------------------------------------------------------
// J. v0.5.8 管理员设置：enable 永远显式 + 注入 0 出站
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, opsAdminEnabled: true })
  await t.send(t.message('/设管理 10005'))
  const setCall = t.server.paramsOf('set_group_admin')[0]
  check('J1 /设管理 发出 set_group_admin 且 enable 显式为 true',
    t.server.count('set_group_admin') === 1 && setCall.enable === true, brief(setCall))
  check('J2 群号与目标都是字符串', setCall.groupId === '2002' && setCall.userId === '10005', brief(setCall))

  await t.send(t.message('/撤管理 10005'))
  const unsetCall = t.server.paramsOf('set_group_admin')[1]
  check('J3 /撤管理 enable 显式为 false（而不是省略字段）',
    unsetCall.enable === false && Object.prototype.hasOwnProperty.call(unsetCall, 'enable'), brief(unsetCall))

  t.server.reset()
  await t.send(t.message('/设管理', { ats: [10007] }))
  check('J4 @某人 也能作为目标', t.server.paramsOf('set_group_admin')[0].userId === '10007', brief(t.server.paramsOf('set_group_admin')))

  const none = await t.send(t.message('/设管理'))
  check('J5 没给目标 → 中文用法提示且零新增调用',
    none.includes('用法') && t.server.count('set_group_admin') === 1, brief(none))

  t.server.reset()
  const inj = await t.send(t.message('/设管理 10005', { __injected: true }))
  check('J6 注入回合 0 出站：set_group_admin',
    t.server.count('set_group_admin') === 0 && inj.includes('注入/回放回合不写 QQ'), brief(inj))
  // 干跑逐条实测抓到：设/撤曾经共用「设置管理员」一个标签，`/撤管理` 被拦下时
  // 回一句"设置管理员未执行"，用户会以为发错了命令。真话口径必须区分方向。
  const injDemote = await t.send(t.message('/撤管理 10005', { __injected: true }))
  check('J8 注入回合的 /撤管理 说的是"撤销管理员"，不是"设置管理员"',
    injDemote.includes('撤销管理员') && !injDemote.includes('设置管理员'),
    brief(injDemote))
  check('J9 两条注入都没有真的发出 set_group_admin',
    t.server.count('set_group_admin') === 0, String(t.server.count('set_group_admin')))
  t.stop()
}
{
  // 真机现场（15:50）：`/设管理 10009`（号不在群里）→ NapCat 报 retcode 1200 "get Uid Error"，
  // 而桥的兜底把整段 JSON 贴进了群里。现在必须是看得懂的中文 + 一条 ops 事件。
  const t = makeBridge({ groupOpsEnabled: true, opsAdminEnabled: true })
  t.server.adminError = 'OneBot action set_group_admin failed: {"status":"failed","retcode":1200,"data":null,"message":"get Uid Error"}'
  const out = await t.send(t.message('/设管理 10009'))
  check('J10 NapCat 的 uid 解析失败被翻译成中文真原因（含"不在这个群里"）',
    out.includes('uid') && out.includes('不在这个群里'), brief(out))
  check('J11 回复里不再出现原始 JSON / retcode',
    !out.includes('retcode') && !out.includes('{') && !out.includes('get Uid Error'), brief(out))
  check('J12 失败也写了 ops 事件（trace 里查得到）',
    t.reasonsOf(t.traceStage('ops', false)).includes('uid'), t.reasonsOf(t.traceStage('ops', false)).slice(0, 120))
  t.stop()
}
{
  // 真机现场（16:01）：用户发 `/设管理17xxxxxxxx`（**没空格**）→ 命令匹配不上 →
  // 消息被当成聊天交给模型（白烧一回合，用户以为"设管理失败了"）。
  // 现在必须回一句用法提示，且**绝不交给模型**。
  const t = makeBridge({ groupOpsEnabled: true, opsAdminEnabled: true })
  const out = await t.send(t.message('/设管理10005'))
  check('J13 命令粘住参数 → 明确提示要留空格', out.includes('空格'), brief(out))
  check('J14 该轮**没有**交给模型（不烧回合、不让模型去调工具）',
    t.turns.length === 0, JSON.stringify(t.turns))
  check('J15 trace 说明"没有交给模型"',
    t.reasonsOf(t.traceStage('command', false)).includes('没有交给模型'), t.reasonsOf(t.traceStage('command', false)).slice(0, 110))
  // 正常写法（有空格）不受影响：该走命令就走命令
  const t2 = makeBridge({ groupOpsEnabled: true, opsAdminEnabled: true })
  await t2.send(t2.message('/设管理 10005'))
  check('J16 带空格的正常写法仍然照常执行（没有被这道闸误伤）',
    t2.server.count('set_group_admin') === 1 && t2.turns.length === 0,
    `calls=${t2.server.count('set_group_admin')} turns=${t2.turns.length}`)
  t.stop()
  t2.stop()
}
{
  const t = makeBridge({ groupOpsEnabled: true, opsAdminEnabled: false })
  const out = await t.send(t.message('/设管理 10005'))
  check('J7 opsAdminEnabled=false → 点名开关且零调用',
    out.includes('opsAdminEnabled=false') && t.server.count('set_group_admin') === 0, brief(out))
  t.stop()
}
{
  const t = makeBridge({ groupOpsEnabled: true, opsAdminEnabled: true, adminUsers: [9999] })
  const out = await t.send(t.message('/设管理 10005'))
  check('J8 非管理员 → 拒绝且零调用',
    out.includes('仅管理员可用') && t.server.count('set_group_admin') === 0, brief(out))
  t.stop()
}

// ---------------------------------------------------------------------------
// K. v0.5.8 邀请策略：四个字面量
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, opsInvitePolicyEnabled: true })
  await t.send(t.message('/邀请策略 关闭'))
  check('K1 关闭 → disabled',
    t.server.paramsOf('set_group_member_invite_policy')[0].policy === 'disabled',
    brief(t.server.paramsOf('set_group_member_invite_policy')))
  await t.send(t.message('/邀请策略 百人以下'))
  check('K2 百人以下 → no_approval_under_100',
    t.server.paramsOf('set_group_member_invite_policy')[1].policy === 'no_approval_under_100',
    brief(t.server.paramsOf('set_group_member_invite_policy')))
  const bad = await t.send(t.message('/邀请策略 随便写'))
  check('K3 未知词 → 中文报错列出四种且零新增调用',
    bad.includes('四种') && t.server.count('set_group_member_invite_policy') === 2, brief(bad))
  t.server.reset()
  const injInvite = await t.send(t.message('/邀请策略 关闭', { __injected: true }))
  check('K4 注入回合 0 出站：邀请策略（业务调用总数为 0 + 回复说明原因）',
    t.server.calls.filter((c) => c.action !== 'send_msg').length === 0 && injInvite.includes('注入/回放回合不写 QQ'), brief(injInvite))
  t.stop()
}

// ---------------------------------------------------------------------------
// L. v0.5.8 加群方式：只有 4/5 带问题/答案
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, opsAddOptionEnabled: true })
  await t.send(t.message('/加群方式 3'))
  const plain = t.server.paramsOf('set_group_add_option')[0]
  check('L1 取值 3 不夹带问题/答案',
    plain.addType === 3 && plain.question === undefined && plain.answer === undefined, brief(plain))

  await t.send(t.message('/加群方式 4 问题=口令是什么 答案=鲸鱼'))
  const withAnswer = t.server.paramsOf('set_group_add_option')[1]
  check('L2 取值 4 带问题+答案',
    withAnswer.addType === 4 && withAnswer.question === '口令是什么' && withAnswer.answer === '鲸鱼', brief(withAnswer))

  await t.send(t.message('/加群方式 5 问题=口令是什么'))
  const noAnswer = t.server.paramsOf('set_group_add_option')[2]
  check('L3 取值 5 只带问题（答案空串）',
    noAnswer.addType === 5 && noAnswer.question === '口令是什么' && noAnswer.answer === '', brief(noAnswer))

  const bad = await t.send(t.message('/加群方式 9'))
  check('L4 非法取值 → 中文报错且零新增调用',
    bad.includes('1–5') && t.server.count('set_group_add_option') === 3, brief(bad))

  t.server.reset()
  const injAddOption = await t.send(t.message('/加群方式 4 问题=a 答案=b', { __injected: true }))
  check('L5 注入回合 0 出站：加群方式（业务调用总数为 0 + 回复说明原因）',
    t.server.calls.filter((c) => c.action !== 'send_msg').length === 0 && injAddOption.includes('注入/回放回合不写 QQ'), brief(injAddOption))
  t.stop()
}

// ---------------------------------------------------------------------------
// M. v0.5.8 打卡名册（只读）
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true })
  const out = await t.send(t.message('/打卡名册'))
  check('M1 走 get_group_signed_list 并渲染名册',
    t.server.count('get_group_signed_list') === 1 && out.includes('今日打卡') && out.includes('10001'), brief(out))
  t.server.reset()
  const inj = await t.send(t.message('/打卡名册', { __injected: true }))
  check('M2 注入回合不访问 QQ：打卡名册',
    t.server.count('get_group_signed_list') === 0 && inj.includes('未真正访问 QQ'), brief(inj))
  t.stop()
}
{
  const t = makeBridge({ groupOpsEnabled: true, opsReadEnabled: false })
  const out = await t.send(t.message('/打卡名册'))
  check('M3 opsReadEnabled=false → 点名开关且零调用',
    out.includes('opsReadEnabled=false') && t.server.count('get_group_signed_list') === 0, brief(out))
  t.stop()
}
{
  const t = makeBridge({ groupOpsEnabled: true })
  t.server.signedError = new Error('无法获取该群组打卡列表')
  const out = await t.send(t.message('/打卡名册'))
  check('M4 接口报错 → 中文失败原因，不崩',
    out.includes('查询失败') && out.includes('无法获取'), brief(out))
  t.stop()
}

// ---------------------------------------------------------------------------
// N. v0.5.8 /申请：主动拉取 + 并入待审队列 + 审批
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, requestSyncEnabled: true, verifyEnabled: true })
  const out = await t.send(t.message('/申请'))
  check('N1 同时拉取入群申请与可疑好友两个接口',
    t.server.count('get_group_system_msg') === 1 && t.server.count('get_doubt_friends_add_request') === 1,
    brief(t.server.calls.map((c) => c.action)))
  check('N2 回执说明并入数量', out.includes('新并入待审 2 条'), brief(out))
  check('N3 待审列表标出「补拉」与「只能同意」',
    out.includes('补拉') && out.includes('只能同意'), brief(out))

  const again = await t.send(t.message('/申请'))
  check('N4 再拉一次不重复并入', again.includes('已有 2 条'), brief(again))

  const approved = await t.send(t.message('/同意 1'))
  const groupCall = t.server.paramsOf('set_group_add_request')[0]
  check('N5 /同意 走 set_group_add_request，flag = request_id',
    t.server.count('set_group_add_request') === 1 && groupCall.flag === '9001' && groupCall.approve === true, brief(groupCall))
  check('N6 批准成功文案', approved.includes('已批准'), brief(approved))

  const rejectedDoubt = await t.send(t.message('/拒绝 2'))
  check('N7 可疑好友 /拒绝 → 不发任何请求并说明只能同意',
    t.server.count('set_doubt_friends_add_request') === 0 && rejectedDoubt.includes('只能同意'), brief(rejectedDoubt))

  const approvedDoubt = await t.send(t.message('/同意 2'))
  const doubtCall = t.server.paramsOf('set_doubt_friends_add_request')[0]
  check('N8 可疑好友 /同意 走 set_doubt_friends_add_request（不是 group）',
    t.server.count('set_doubt_friends_add_request') === 1 && doubtCall.flag === 'uid_doubt_1' && t.server.count('set_group_add_request') === 1,
    brief(doubtCall))
  check('N9 队列清空', t.bridge.joinGuard.list().length === 0, String(t.bridge.joinGuard.list().length))
  t.stop()
}
{
  const t = makeBridge({ groupOpsEnabled: true, requestSyncEnabled: false })
  const out = await t.send(t.message('/申请'))
  check('N10 requestSyncEnabled=false → 点名开关且零调用',
    out.includes('requestSyncEnabled=false') && t.server.count('get_group_system_msg') === 0, brief(out))
  t.stop()
}
{
  const t = makeBridge({ groupOpsEnabled: true, requestSyncEnabled: true, verifyEnabled: true, adminUsers: [9999] })
  const out = await t.send(t.message('/申请'))
  check('N11 非管理员 → 拒绝且零调用',
    out.includes('仅管理员可用') && t.server.count('get_group_system_msg') === 0, brief(out))
  t.stop()
}
{
  const t = makeBridge({ groupOpsEnabled: true, requestSyncEnabled: true, verifyEnabled: true })
  const inj = await t.send(t.message('/申请', { __injected: true }))
  check('N12 注入回合 0 出站：拉取不访问 QQ',
    t.server.count('get_group_system_msg') === 0 && inj.includes('注入/回放回合不写 QQ'), brief(inj))
  t.stop()
}
{
  const t = makeBridge({ groupOpsEnabled: true, requestSyncEnabled: true, verifyEnabled: true })
  t.server.doubtError = new Error('可疑好友接口挂了')
  const out = await t.send(t.message('/申请'))
  check('N13 可疑好友接口失败不拖垮入群申请拉取',
    t.server.count('get_group_system_msg') === 1 && out.includes('新并入待审 1 条') && out.includes('可疑好友申请拉取失败'), brief(out))
  t.stop()
}

{
  const t = makeBridge({ groupOpsEnabled: true, requestSyncEnabled: true, verifyEnabled: true })
  await t.send(t.message('/申请'))
  // 补拉的条目没有验证题：申请人随后私聊说话，绝不能被当成"答题"而回一句空的答案提示。
  const chatter = await t.send(t.message('在吗', { messageType: 'private', groupId: undefined, userId: 10009, atMe: false }))
  check('N14 补拉条目不会被当成验证答题（不会回空题提示）',
    !chatter.includes('答案不对'), brief(chatter))
  check('N15 补拉条目也不会因此被自动放行', t.bridge.joinGuard.list().length === 2, String(t.bridge.joinGuard.list().length))
  t.stop()
}

// ---------------------------------------------------------------------------
// O. 审批的注入红线（这一版修掉的真缺陷）
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, requestSyncEnabled: true, verifyEnabled: true })
  await t.send(t.message('/申请'))
  t.server.reset()
  const inj = await t.send(t.message('/同意 1', { __injected: true }))
  check('O1 注入回合不真的批准任何人（flag 参数落不进 scoped dry-run）',
    t.server.count('set_group_add_request') === 0 && inj.includes('不真的审批'), brief(inj))
  check('O2 被拦下的条目仍在队列里（没有被静默消费）',
    t.bridge.joinGuard.list().length === 2, String(t.bridge.joinGuard.list().length))
  const injList = await t.send(t.message('/待审', { __injected: true }))
  check('O3 注入回合的 /待审 仍可看队列（纯本地读，不该被写闸门连坐）',
    injList.includes('待处理请求') && injList.includes('补拉'), brief(injList))
  t.stop()
}
{
  // injectDryRun:false（"真发"模式）下，注入回合的审批照常执行——与 /群打卡 等处的口径一致。
  const t = makeBridge({ groupOpsEnabled: true, requestSyncEnabled: true, verifyEnabled: true, injectDryRun: false })
  await t.send(t.message('/申请'))
  t.server.reset()
  await t.send(t.message('/同意 1', { __injected: true }))
  check('O4 injectDryRun=false 时注入回合的审批真的执行（与全项目口径一致）',
    t.server.count('set_group_add_request') === 1, brief(t.server.calls.map((c) => c.action)))
  t.stop()
}
{
  // 第二层防线：申请人"答对验证题"的自动放行路径不经过命令处理，所以它只能靠
  // #resolveJoin 自己的离线判断兜住。这里用真实的 request 事件建一条带题目的待审条目，
  // 再用注入回合发正确答案——一次真实审批都不许发生。
  const t = makeBridge({ verifyEnabled: true, groupOpsEnabled: true })
  t.server.emit('request', {
    requestType: 'group', subType: 'add', userId: 10055, groupId: 2002, comment: '求进群', flag: 'flag-10055', name: '新人',
  })
  await sleep(140)
  const entry = t.bridge.joinGuard.list().find((item) => item.userId === 10055)
  check('O4 request 事件建出带验证题的待审条目', Boolean(entry && entry.answer), brief(entry))
  t.server.reset()
  const replied = await t.send(t.message(entry.answer, { messageType: 'private', groupId: undefined, userId: 10055, __injected: true }))
  check('O5 注入回合答对题也不会真的放行（第二层防线）',
    t.server.count('set_group_add_request') === 0, brief(t.server.calls.map((c) => c.action)))
  check('O6 条目仍在队列里', t.bridge.joinGuard.list().some((item) => item.userId === 10055), brief(replied))
  t.stop()
}

// ---------------------------------------------------------------------------
// P. v0.5.8 权限自愈：group_admin 事件
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, opsKickEnabled: true, adminWatchEnabled: true })
  const notice = (subType) => t.server.emit('notice', {
    noticeType: 'group_admin', subType, adminSet: subType !== 'unset', groupId: 2002, userId: 999, selfId: 999,
  })
  notice('unset')
  await sleep(140)
  check('P1 被撤管理员 → 群里收到说明',
    t.server.sent.some((item) => item.segments.some((seg) => String(seg.data?.text ?? '').includes('已不是本群管理员'))),
    brief(t.server.sent.map((item) => item.segments.map((s) => s.data?.text).join(''))))
  check('P2 状态记为 false', t.bridge.botAdminKnown.get(2002) === false, String(t.bridge.botAdminKnown.get(2002)))

  t.server.reset()
  await t.send(t.message('/批量踢 10002'))
  const confirm = await t.send(t.message('/批量踢 确认'))
  check('P3 已知被撤管理员 → 写命令给真话且零调用',
    confirm.includes('已被取消') && t.server.count('set_group_kick_members') === 0, brief(confirm))

  const adminCmd = await t.send(t.message('/mute 10002 60'))
  check('P4 老管理命令同样被拦（说真话而不是 API 报错）',
    adminCmd.includes('已被取消') && t.server.count('set_group_ban') === 0, brief(adminCmd))

  notice('set')
  await sleep(140)
  check('P5 恢复管理员 → 状态回到 true 并再次通知',
    t.bridge.botAdminKnown.get(2002) === true
    && t.server.sent.some((item) => item.segments.some((seg) => String(seg.data?.text ?? '').includes('已恢复群管理员'))))
  t.server.reset()
  await t.send(t.message('/批量踢 10002'))
  await t.send(t.message('/批量踢 确认'))
  check('P6 恢复后写命令照常执行', t.server.count('set_group_kick_members') === 1)
  t.stop()
}
{
  const t = makeBridge({ groupOpsEnabled: true, adminWatchEnabled: false })
  t.server.emit('notice', { noticeType: 'group_admin', subType: 'unset', adminSet: false, groupId: 2002, userId: 999, selfId: 999 })
  await sleep(140)
  check('P7 adminWatchEnabled=false 不发通知，但状态照记',
    t.bridge.botAdminKnown.get(2002) === false && t.server.sent.length === 0, String(t.server.sent.length))
  t.stop()
}
{
  const t = makeBridge({ groupOpsEnabled: true, adminWatchEnabled: true })
  t.server.emit('notice', { noticeType: 'group_admin', subType: 'set', adminSet: true, groupId: 2002, userId: 10077, selfId: 999 })
  await sleep(140)
  check('P8 别人的管理员变动不写我们的状态，也不打扰群',
    t.bridge.botAdminKnown.has(2002) === false && t.server.sent.length === 0, String(t.server.sent.length))
  t.stop()
}

// ---------------------------------------------------------------------------
// Q. v0.5.8：控制台「群配置页」按运行快照的 features 白名单渲染开关
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ groupOpsEnabled: true, opsAdminEnabled: true, opsInvitePolicyEnabled: true, opsAddOptionEnabled: true, requestSyncEnabled: true, adminWatchEnabled: true })
  const snap = JSON.parse(readFileSync(join(t.cwd, 'qq-runtime.json'), 'utf8'))
  const f = snap.features ?? {}
  check('Q1 五个新开关 + 拉取条数都进了运行快照',
    f.opsAdminEnabled === true && f.opsInvitePolicyEnabled === true && f.opsAddOptionEnabled === true
    && f.requestSyncEnabled === true && f.adminWatchEnabled === true && f.requestSyncCount === 50,
    brief(f))
  const secretKeys = ['ttsApiKey', 'sttApiKey', 'imageGenApiKey', 'notifyToken', 'notifyPushUrl', 'accessToken', 'verifyKeyword', 'ttsLocalRefAudio']
  check('Q2 新开关没有把密钥类字段带进快照',
    !secretKeys.some((key) => key in f), secretKeys.filter((key) => key in f).join(','))
  t.stop()
}

{
  // P1（独立审查抓到）：`/撤管理` 曾经用 `raw.includes('设管理')` 判断动作，
  // 于是参数里出现"设管理员"三个字就会**反向提权**。这里把那条路钉死。
  const t = makeBridge({ groupOpsEnabled: true, opsAdminEnabled: true })
  await t.send(t.message('/撤管理 10009 设管理员'))
  const call = t.server.paramsOf('set_group_admin')[0]
  check('R1 参数里出现"设管理员"不会把 /撤管理 变成提权',
    call !== undefined && call.enable === false && call.userId === '10009', brief(call))
  const out = await t.send(t.message('/撤管理 10009 顺便说一句设管理员不行'))
  check('R2 目标仍取第一个数字，回复说的是"取消"',
    out.includes('已取消') && t.server.paramsOf('set_group_admin')[1].enable === false, brief(out))
  t.server.reset()
  await t.send(t.message('/设管理 10009 撤管理员'))
  check('R3 反过来也一样（/设管理 里的"撤管理员"不该把它变成撤销）',
    t.server.paramsOf('set_group_admin')[0].enable === true, brief(t.server.paramsOf('set_group_admin')))
  t.stop()
}
{
  // 注入器/回放管线送来的 notice **不带** adminSet（只有 parseNotice 会补），
  // 早前 `adminSet !== false` 会把 undefined 当成 true ⇒ 'unset' 被记成"已恢复管理员"。
  const t = makeBridge({ groupOpsEnabled: true, opsKickEnabled: true, adminWatchEnabled: true })
  t.server.emit('notice', { noticeType: 'group_admin', subType: 'unset', groupId: 2002, userId: 999, selfId: 999 })
  await sleep(140)
  check('R4 没有 adminSet 的 unset 事件仍然记成"已取消"（不许反向）',
    t.bridge.botAdminKnown.get(2002) === false, String(t.bridge.botAdminKnown.get(2002)))
  check('R5 推播文案也是"已不是管理员"',
    t.server.sent.some((item) => item.segments.some((seg) => String(seg.data?.text ?? '').includes('已不是本群管理员'))),
    brief(t.server.sent.map((item) => item.segments.map((s) => s.data?.text).join(''))))
  t.server.reset()
  await t.send(t.message('/批量踢 10002'))
  await t.send(t.message('/批量踢 确认'))
  check('R6 于是写命令被真话拦住（零调用）', t.server.count('set_group_kick_members') === 0)
  // 缺 sub_type 的事件既不记账也不推播（宁可不猜）
  const t2 = makeBridge({ groupOpsEnabled: true, adminWatchEnabled: true })
  t2.server.emit('notice', { noticeType: 'group_admin', groupId: 2002, userId: 999, selfId: 999 })
  await sleep(140)
  check('R7 缺 sub_type 的 group_admin 事件不记账、不推播（不猜）',
    t2.bridge.botAdminKnown.has(2002) === false && t2.server.sent.length === 0, String(t2.server.sent.length))
  t2.stop()
  t.stop()
}
{
  // verifyEnabled=false 时不入队：没有 /同意、/拒绝 可用，入队只会把队列占满（审查 P3-12）。
  const t = makeBridge({ groupOpsEnabled: true, requestSyncEnabled: true, verifyEnabled: false })
  const out = await t.send(t.message('/申请'))
  check('R8 verifyEnabled=false → 只预览不入队',
    out.includes('未并入待审队列') && t.bridge.joinGuard.list().length === 0, brief(out))
  check('R9 但拉取接口确实被调用了', t.server.count('get_group_system_msg') === 1)
  t.stop()
}
{
  // 白名单外的群：机器人被撤管理员不发播报（与欢迎语/戳一戳/防撤回同口径）。
  const t = makeBridge({ groupOpsEnabled: true, adminWatchEnabled: true, allowGroups: [3003] })
  t.server.emit('notice', { noticeType: 'group_admin', subType: 'unset', groupId: 2002, userId: 999, selfId: 999 })
  await sleep(140)
  check('R10 白名单外的群不播报管理员变更（但状态照记）',
    t.bridge.botAdminKnown.get(2002) === false && t.server.sent.length === 0, String(t.server.sent.length))
  t.stop()
}
{
  // /退群 只需要普通成员权限：被撤管理员时不该被"权限自愈"假理由拦住（审查 P3-9）。
  const t = makeBridge({ groupOpsEnabled: true, leaveGroupEnabled: true, adminWatchEnabled: true })
  t.server.emit('notice', { noticeType: 'group_admin', subType: 'unset', groupId: 2002, userId: 999, selfId: 999 })
  await sleep(140)
  t.server.reset()
  const out = await t.send(t.message('/退群 确认'))
  check('R11 被撤管理员后 /退群 仍然可用（它不需要管理员权限）',
    t.server.count('set_group_leave') === 1 && !out.includes('已被取消'), brief(out))
  t.stop()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
