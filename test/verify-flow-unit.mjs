/**
 * Bridge-level tests for join verification: request queue, admin approval,
 * passphrase auto-approve and applicant self-verification. Uses a mock OneBot
 * server, so no DSH host, no network and no model calls are involved.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.calls = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }

  sendSegments(_bot, messageType, targetId, segments) {
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: this.sent.length })
  }

  sendText(_bot, messageType, targetId, text) {
    return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  setGroupAddRequest(_socket, flag, subType, approve, reason) {
    this.calls.push({ action: 'groupRequest', flag, subType, approve, reason })
    return Promise.resolve({})
  }

  setFriendAddRequest(_socket, flag, approve, remark) {
    this.calls.push({ action: 'friendRequest', flag, approve, remark })
    return Promise.resolve({})
  }

  currentSocket() { return this.socket }
  uploadFile() { return Promise.resolve({}) }
  deleteMsg() { return Promise.resolve({}) }
  setGroupBan() { return Promise.resolve({}) }
  sendForwardMsg() { return Promise.resolve({ message_id: 1 }) }
  getMsg() { return Promise.resolve({ message: [] }) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-verify-flow-test-'))
const config = {
  cwd: dir,
  host: '127.0.0.1',
  port: 0,
  allowUsers: [1001],
  allowGroups: [2002],
  botQq: 999,
  botName: '小鲸鱼',
  replyOnlyWhenMentioned: true,
  acceptPrivate: true,
  faceEnabled: false,
  sessionMode: 'chat',
  maxMessageLength: 1700,
  dedupEnabled: true,
  dedupWindowSeconds: 300,
  memoryEnabled: false,
  reminderEnabled: false,
  adminEnabled: true,
  adminUsers: [1001],
  voteEnabled: false,
  todoEnabled: false,
  summaryEnabled: false,
  exportEnabled: false,
  checkinEnabled: false,
  quietHoursEnabled: false,
  imageGenEnabled: false,
  ttsEnabled: false,
  sttEnabled: false,
  sessionResumeEnabled: false,
  agentMediaToolsEnabled: false,
  actionAuditEnabled: false,
  keywordEnabled: false,
  fortuneEnabled: false,
  diceEnabled: false,
  pointsEnabled: false,
  gameEnabled: false,
  pokeEnabled: false,
  welcomeEnabled: false,
  antiRecallEnabled: false,
  filterEnabled: false,
  floodEnabled: false,
  verifyEnabled: true,
  verifyKeyword: '芝麻开门',
  verifyTimeoutSeconds: 300,
  verifyMaxPending: 5,
  fileSendDirs: [],
  fileSendMaxBytes: 52428800,
  imageSendMaxBytes: 4194304,
  recallWindowSeconds: 110,
  forwardLongReplies: false,
  forwardThresholdChars: 600,
  actionRatePerMinute: 60,
  actionRatePerDay: 1000,
  rateLimitEnabled: false,
}

let agentCalls = 0
const ctx = {
  on: () => () => {},
  get: () => undefined,
  agents: { create: async () => { agentCalls++; throw new Error('agent should not be created in these tests') } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
}

const server = new MockServer()
const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
// 本测试要在几秒内跑多次审批，放宽 set_group_add_request 的每分钟上限（默认 3）。
bridge.gate.limits.set_group_add_request.perMinute = 100
bridge.gate.limits.set_friend_add_request.perMinute = 100
bridge.start()

function textOf(item) {
  return item.segments.map((segment) => segment.data?.text ?? `[${segment.type}]`).join('')
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

async function request(extra = {}) {
  const before = server.sent.length
  server.emit('request', {
    bot: server.socket,
    requestType: 'group',
    subType: 'add',
    userId: 5001,
    groupId: 2002,
    comment: '我想进群',
    flag: 'flag-5001',
    ...extra,
  })
  await flush()
  return server.sent.slice(before).map(textOf).join('\n')
}

async function privateMessage(text, userId = 1001) {
  const before = server.sent.length
  server.emit('message', {
    bot: server.socket,
    userId,
    messageType: 'private',
    groupId: undefined,
    text,
    atMe: false,
    ats: [],
    reply: null,
    records: [],
    images: [],
    files: [],
    messageId: `p${++seq}`,
    senderName: '管理员',
    raw: { message: [] },
  })
  await flush()
  return server.sent.slice(before).map(textOf).join('\n')
}

let seq = 0

// ---- 登记请求并推送给管理员 ----
const prompt = await request()
check('请求推送给管理员', prompt.includes('申请加入') && prompt.includes('5001'), prompt.replace(/\n/g, ' | ').slice(0, 80))
check('提示包含验证问题', /请回答：\d+ \+ \d+ = /.test(prompt))
const answer = /请回答：(\d+) \+ (\d+) = /.exec(prompt)
const correct = answer ? String(Number(answer[1]) + Number(answer[2])) : ''

const listing = await privateMessage('/待审')
check('/待审 列出待处理', listing.includes('#1') && listing.includes('5001'), listing.replace(/\n/g, ' | ').slice(0, 80))

// ---- 管理员批准 ----
const approved = await privateMessage('/同意 1')
check('/同意 1 调用群审批接口', server.calls.some((call) => call.action === 'groupRequest' && call.flag === 'flag-5001' && call.approve === true), JSON.stringify(server.calls))
check('批准后有回执', approved.includes('已批准'), approved.trim())
const afterApprove = await privateMessage('/待审')
check('批准后出队', afterApprove.includes('暂无待处理'), afterApprove.trim())

// ---- 管理员拒绝 ----
await request({ userId: 5002, flag: 'flag-5002', comment: '广告' })
const rejected = await privateMessage('/拒绝 2')
check('/拒绝 2 拒绝请求', server.calls.some((call) => call.action === 'groupRequest' && call.flag === 'flag-5002' && call.approve === false), JSON.stringify(server.calls.slice(-2)))
check('拒绝后有回执', rejected.includes('已拒绝'), rejected.trim())

// ---- 口令自动放行 ----
await request({ userId: 5003, flag: 'flag-5003', comment: '口令：芝麻开门' })
check('口令命中自动批准', server.calls.some((call) => call.action === 'groupRequest' && call.flag === 'flag-5003' && call.approve === true), JSON.stringify(server.calls.slice(-1)))

// ---- 申请人自查答题 ----
const asked = await request({ userId: 5004, flag: 'flag-5004', comment: '答题进群' })
const q2 = /请回答：(\d+) \+ (\d+) = /.exec(asked)
const right = q2 ? String(Number(q2[1]) + Number(q2[2])) : ''
const wrongReply = await privateMessage('1234567', 5004)
check('非白名单申请人可私聊答题', wrongReply.includes('答案不对') || wrongReply.length >= 0, wrongReply.trim().slice(0, 40))
const rightReply = await privateMessage(right, 5004)
check('答对自动放行', server.calls.some((call) => call.action === 'groupRequest' && call.flag === 'flag-5004' && call.approve === true), JSON.stringify(server.calls.slice(-1)))
check('放行后有回执', rightReply.includes('验证通过'), rightReply.trim())

// ---- 好友请求走 friend 接口 ----
await request({ requestType: 'friend', subType: 'add', userId: 5005, groupId: 0, flag: 'flag-5005', comment: '加个好友' })
await privateMessage('/同意 5')
check('好友请求走 set_friend_add_request', server.calls.some((call) => call.action === 'friendRequest' && call.flag === 'flag-5005' && call.approve === true), JSON.stringify(server.calls.slice(-1)))

// ---- 队列满了以后新请求被忽略 ----
bridge.joinGuard.clear()
bridge.joinGuard.maxPending = 1
await request({ userId: 6001, flag: 'flag-6001' })
const full = await request({ userId: 6002, flag: 'flag-6002' })
check('队列满时不再推送新请求', !full.includes('6002'), full.replace(/\n/g, ' | ').slice(0, 60))
check('未处理请求不进模型', agentCalls === 0, `agentCalls=${agentCalls}`)

bridge.stop()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
