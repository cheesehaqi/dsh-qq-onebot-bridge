/**
 * Bridge-level tests for the v0.3.9 group-insight pack: activity statistics,
 * honor/notice/essence reads, Minecraft status and the daily report plumbing.
 * Uses a mock OneBot server — no DSH host, no network, no model calls.
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
    this.honor = { current_talkative: [{ name: '小明' }], current_emotion: [{ name: '小红' }] }
    this.notices = [{ message: { text: '群规：文明聊天' }, sender_id: 1001 }]
    this.essence = [{ message: { text: '经典发言' }, message_id: 55 }]
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }

  sendSegments(_bot, messageType, targetId, segments) {
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: this.sent.length })
  }

  sendText(_bot, messageType, targetId, text) {
    return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  getGroupHonorInfo(_socket, groupId, type) {
    this.calls.push({ action: 'honor', groupId, type })
    return Promise.resolve(this.honor)
  }

  getGroupNotice(_socket, groupId) {
    this.calls.push({ action: 'notice', groupId })
    return Promise.resolve(this.notices)
  }

  getEssenceMsgList(_socket, groupId) {
    this.calls.push({ action: 'essence', groupId })
    return Promise.resolve(this.essence)
  }

  currentSocket() { return this.socket }
  uploadFile() { return Promise.resolve({}) }
  deleteMsg() { return Promise.resolve({}) }
  setGroupBan() { return Promise.resolve({}) }
  sendForwardMsg() { return Promise.resolve({ message_id: 1 }) }
  getMsg() { return Promise.resolve({ message: [] }) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-report-test-'))
const config = {
  cwd: dir,
  host: '127.0.0.1',
  port: 0,
  allowUsers: [1001, 1002],
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
  memoryEnabled: true,
  memoryMaxEntries: 10,
  reminderEnabled: true,
  reminderMaxPerChat: 5,
  recurringReminderEnabled: true,
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
  verifyEnabled: false,
  statsEnabled: true,
  statsKeepDays: 30,
  groupReadEnabled: true,
  mcStatusEnabled: true,
  mcStatusTimeoutMs: 1500,
  dailyReportEnabled: true,
  dailyReportTime: '23:59',
  dailyReportChats: [],
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

const ctx = {
  on: () => () => {},
  get: () => undefined,
  agents: { create: async () => { throw new Error('agent should not be created in these tests') } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
}

const server = new MockServer()
const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
bridge.start()

let seq = 0
function groupMessage(text, extra = {}) {
  return {
    bot: server.socket,
    userId: 1002,
    messageType: 'group',
    groupId: 2002,
    text,
    atMe: true,
    ats: [],
    reply: null,
    records: [],
    images: [],
    files: [],
    messageId: `g${++seq}`,
    senderName: '小明',
    raw: { message: [] },
    ...extra,
  }
}

async function send(message) {
  const before = server.sent.length
  server.emit('message', message)
  await new Promise((resolve) => setTimeout(resolve, 30))
  return server.sent.slice(before).map((item) => item.segments.map((segment) => segment.data?.text ?? `[${segment.type}]`).join('')).join('\n')
}

// ---- 活跃统计 ----
await send(groupMessage('第一条'))
await send(groupMessage('第二条'))
await send(groupMessage('第三条', { userId: 1001, senderName: '管理员' }))
const stats = await send(groupMessage('/统计'))
check('/统计 出榜', stats.includes('群活跃榜') && stats.includes('小明') && stats.includes('2 条'), stats.replace(/\n/g, ' | '))
check('统计命令本身不计入', !/小明 3 条/.test(stats), stats.replace(/\n/g, ' | '))
const weekly = await send(groupMessage('/周榜'))
check('/周榜 出榜', weekly.includes('本周群活跃榜'), weekly.replace(/\n/g, ' | '))

// ---- 只读群信息 ----
const honor = await send(groupMessage('/荣誉'))
check('/荣誉 查询并渲染', honor.includes('龙王：小明') && server.calls.some((call) => call.action === 'honor'), honor.replace(/\n/g, ' | '))
const notice = await send(groupMessage('/公告'))
check('/公告 读取渲染', notice.includes('群规：文明聊天'), notice.replace(/\n/g, ' | '))
const essence = await send(groupMessage('/群精华'))
check('/群精华 读取渲染', essence.includes('经典发言'), essence.replace(/\n/g, ' | '))

// ---- MC 服务器状态（离线路径，不发网络请求）----
const mcBad = await send(groupMessage('/mc 127.0.0.1:1'))
check('/mc 离线时给中文提示', /离线|失败|连接/.test(mcBad), mcBad.trim().slice(0, 60))
const mcUsage = await send(groupMessage('/mc'))
check('/mc 缺地址给用法', mcUsage.includes('用法'), mcUsage.trim())

// ---- 重复提醒 ----
const recurring = await send(groupMessage('每天8点提醒我喝水'))
check('重复提醒回执含周期', recurring.includes('明天') || recurring.includes('将在') && recurring.includes('每天'), recurring.replace(/\n/g, ' | '))
const reminderList = await send(groupMessage('/reminders'))
check('/reminders 标注周期', reminderList.includes('每天'), reminderList.replace(/\n/g, ' | '))
check('重复提醒已入调度表', [...bridge.reminders.values()].some((rem) => rem.rule?.kind === 'daily'))
await send(groupMessage('/reminders'))

// 一次性提醒仍正常
const once = await send(groupMessage('10分钟后提醒我关火'))
check('一次性提醒仍可用', once.includes('将在'), once.replace(/\n/g, ' | '))

// ---- 每日日报 ----
const asAdmin = { userId: 1001, senderName: '管理员' }
const reportState = await send(groupMessage('/日报', asAdmin))
check('/日报 显示当前状态', /每日日报当前：(开|关)/.test(reportState), reportState.trim())
const reportOn = await send(groupMessage('/日报 on', asAdmin))
check('/日报 on 成功', reportOn.includes('已开启'), reportOn.trim())
check('日报开关落盘', (bridge.dailyReportStore.read()?.chats ?? []).includes('g:2002'), JSON.stringify(bridge.dailyReportStore.read()))
const notAdmin = await send(groupMessage('/日报 off', { userId: 1002, senderName: '普通成员' }))
check('非管理员不能改日报', notAdmin.includes('只有管理员'), notAdmin.trim())
const reportOff = await send(groupMessage('/日报 off', asAdmin))
check('/日报 off 成功', reportOff.includes('已关闭'), reportOff.trim())
check('关闭后已移除', !(bridge.dailyReportStore.read()?.chats ?? []).includes('g:2002'))
check('日报已排程（timer 已挂）', bridge.timers.size > 0, `timers=${bridge.timers.size}`)

bridge.stop()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
