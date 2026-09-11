/**
 * Config-schema smoke test: resolves the published schema defaults and boots a
 * real QQBridge on top of them, so a typo between index.js and bridge.js (or a
 * key that lost its default) fails here instead of in production.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/index.js'
import { QQBridge } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const defaults = Config({})
check('schema 可解析默认值', defaults && typeof defaults === 'object')
check('默认端口 6700', defaults.port === 6700)
check('白名单默认拒绝（空数组）', Array.isArray(defaults.allowUsers) && defaults.allowUsers.length === 0 && defaults.allowGroups.length === 0)

// v0.3.6
check('会话续接默认开', defaults.sessionResumeEnabled === true)
check('媒体工具默认开', defaults.agentMediaToolsEnabled === true)
check('合并转发默认关', defaults.forwardLongReplies === false)
check('写操作闸门默认值', defaults.actionRatePerMinute === 20 && defaults.actionRatePerDay === 500 && defaults.actionAuditEnabled === true)
check('文件发送上限默认 50MiB', defaults.fileSendMaxBytes === 52428800)
// v0.3.7
check('零成本互动默认值', defaults.keywordEnabled === false && defaults.fortuneEnabled === true && defaults.diceEnabled === true)
check('积分/游戏默认关', defaults.pointsEnabled === false && defaults.gameEnabled === false)
check('积分参数默认值', defaults.pointsPerMessage === 1 && defaults.pointsDailyCap === 20 && defaults.pointsCheckinBonus === 5)
// v0.3.8
check('防撤回/过滤/刷屏默认关', defaults.antiRecallEnabled === false && defaults.filterEnabled === false && defaults.floodEnabled === false)
check('过滤参数默认值', defaults.filterAction === 'warn' && defaults.filterMuteSeconds === 300 && Array.isArray(defaults.filterWhitelist))
check('刷屏参数默认值', defaults.floodWindowSeconds === 10 && defaults.floodMaxMessages === 8 && defaults.floodStrikeLimit === 3)
check('入群验证默认关', defaults.verifyEnabled === false && defaults.verifyKeyword === '' && defaults.verifyMaxPending === 20)
// v0.3.9
check('统计默认关、只读群信息默认开', defaults.statsEnabled === false && defaults.groupReadEnabled === true)
check('MC 状态默认开', defaults.mcStatusEnabled === true && defaults.mcStatusTimeoutMs === 5000)
check('重复提醒默认开', defaults.recurringReminderEnabled === true)
check('日报默认关且默认 22:00', defaults.dailyReportEnabled === false && defaults.dailyReportTime === '22:00' && Array.isArray(defaults.dailyReportChats))

// 真实 boot：默认配置 + 最小可用覆盖
const dir = mkdtempSync(join(tmpdir(), 'qq-config-test-'))
class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }

  sendSegments(_bot, messageType, targetId, segments) {
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: this.sent.length })
  }

  sendText(_bot, messageType, targetId, text) {
    return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  currentSocket() { return this.socket }
  getGroupHonorInfo() { return Promise.resolve({}) }
  getGroupNotice() { return Promise.resolve([]) }
  getEssenceMsgList() { return Promise.resolve([]) }
  deleteMsg() { return Promise.resolve({}) }
  setGroupBan() { return Promise.resolve({}) }
  uploadFile() { return Promise.resolve({}) }
  sendForwardMsg() { return Promise.resolve({ message_id: 1 }) }
  getMsg() { return Promise.resolve({ message: [] }) }
}

const config = {
  ...Config({
    cwd: dir,
    allowUsers: [1001],
    allowGroups: [2002],
    botQq: 999,
    adminUsers: [1001],
    memoryEnabled: false,
    actionAuditEnabled: false,
  }),
}
const server = new MockServer()
const ctx = {
  on: () => () => {},
  get: () => undefined,
  agents: { create: async () => { throw new Error('no agent in this test') } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
}

let bridge = null
let bootError = ''
try {
  bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
  bridge.start()
} catch (error) {
  bootError = error.message
}
check('用默认配置可构造并启动', bridge !== null && bootError === '', bootError)

async function send(text, extra = {}) {
  const before = server.sent.length
  server.emit('message', {
    bot: server.socket,
    userId: 1001,
    messageType: 'group',
    groupId: 2002,
    text,
    atMe: true,
    ats: [],
    reply: null,
    records: [],
    images: [],
    files: [],
    messageId: `c${before}`,
    senderName: '管理员',
    raw: { message: [] },
    ...extra,
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  return server.sent.slice(before).map((item) => item.segments.map((segment) => segment.data?.text ?? '').join('')).join('\n')
}

if (bridge) {
  const help = await send('/help')
  check('/help 在默认配置下可用', help.includes('小鲸鱼使用指南') && help.includes('/health'), help.split('\n')[0])
  check('/help 默认含群信息与 MC', help.includes('/荣誉') && help.includes('/mc'), help.replace(/\n/g, ' | ').slice(-90))
  check('/help 默认不含未开启功能', !help.includes('/kw add') && !help.includes('/统计') && !help.includes('/日报'), help.replace(/\n/g, ' | ').slice(-90))
  const health = await send('/health')
  check('/health 在默认配置下可用', health.includes('小鲸鱼状态') && health.includes('会话续接'), health.replace(/\n/g, ' | ').slice(0, 80))
  const status = await send('/status')
  check('/status 可用', status.includes('QQ 桥状态'), status.trim())
  const fortune = await send('今日人品')
  check('默认开启的运势可用', fortune.length > 0 && /分|人品/.test(fortune), fortune.split('\n')[0])
  bridge.stop()
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
