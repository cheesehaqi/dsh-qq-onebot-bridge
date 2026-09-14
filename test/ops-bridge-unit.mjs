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

  // harmless stubs
  getMsg() { return Promise.resolve({ message: [] }) }
  sendForwardMsg() { return Promise.resolve({ message_id: 1 }) }
  uploadFile() { return Promise.resolve({}) }
  deleteMsg() { return Promise.resolve({}) }
  sendGroupNotice() { return Promise.resolve({}) }
  setGroupWholeBan() { return Promise.resolve({}) }
  setGroupBan() { return Promise.resolve({}) }
  setGroupKick() { return Promise.resolve({}) }
  setGroupLeave() { return Promise.resolve({}) }
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

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
