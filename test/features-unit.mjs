/**
 * Bridge-level integration tests for the zero-cost interaction pack: keyword
 * replies, fortune/dice, points and mini-games. Drives QQBridge through a mock
 * OneBot server, so no DSH host, no network and no model calls are involved.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { DEFAULT_IDIOMS } from '../lib/games.js'

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
  uploadFile() { return Promise.resolve({}) }
  deleteMsg() { return Promise.resolve({}) }
  sendForwardMsg() { return Promise.resolve({ message_id: 9999 }) }
  getMsg() { return Promise.resolve({ message: [] }) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-features-test-'))
const config = {
  cwd: dir,
  host: '127.0.0.1',
  port: 0,
  accessToken: '',
  allowUsers: [1001, 1002],
  allowGroups: [2002],
  botQq: 999,
  botName: '小鲸鱼',
  replyOnlyWhenMentioned: true,
  acceptPrivate: true,
  autoCollectStickers: false,
  faceEnabled: false,
  sessionMode: 'chat',
  provider: '',
  model: '',
  maxMessageLength: 1700,
  dedupEnabled: true,
  dedupWindowSeconds: 300,
  memoryEnabled: true,
  memoryMaxEntries: 30,
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
  ttsProvider: 'azure',
  ttsApiKey: '',
  sttEnabled: false,
  sessionResumeEnabled: false,
  agentMediaToolsEnabled: false,
  actionAuditEnabled: false,
  keywordEnabled: true,
  keywordFile: join(dir, 'qq-keywords.json'),
  fortuneEnabled: true,
  diceEnabled: true,
  pointsEnabled: true,
  pointsPerMessage: 2,
  pointsDailyCap: 10,
  pointsCheckinBonus: 5,
  gameEnabled: true,
  idiomChainTimeoutSeconds: 120,
  guessNumberMax: 100,
  guessNumberMaxTries: 8,
  fileSendDirs: [],
  fileSendMaxBytes: 52428800,
  imageSendMaxBytes: 4194304,
  recallWindowSeconds: 110,
  forwardLongReplies: false,
  forwardThresholdChars: 600,
  actionRatePerMinute: 20,
  actionRatePerDay: 500,
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
const logger = { info() {}, warn() {}, error() {} }
const bridge = new QQBridge(ctx, config, server, logger)
bridge.start()

let seq = 0
function groupMessage(text, extra = {}) {
  return {
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
    messageId: `m${++seq}`,
    senderName: '小明',
    raw: { message: [] },
    ...extra,
  }
}

function privateMessage(text, extra = {}) {
  return groupMessage(text, { messageType: 'private', groupId: undefined, atMe: false, ...extra })
}

async function send(message) {
  const before = server.sent.length
  server.emit('message', message)
  await new Promise((resolve) => setTimeout(resolve, 40))
  const fresh = server.sent.slice(before)
  return fresh.map((item) => item.segments.map((segment) => segment.data?.text ?? `[${segment.type}]`).join('')).join('\n')
}

// ---- 关键词问答库 ----
const added = await send(groupMessage('/kw add 你好 你好呀，我是小鲸鱼～'))
check('/kw add 生效', added.includes('已添加'), added.trim())
const hit = await send(groupMessage('你好'))
check('关键词命中免模型回复', hit.includes('小鲸鱼'), hit.trim())
const listed = await send(groupMessage('/kw list'))
check('/kw list 列出条目', listed.includes('你好') && listed.includes('词库'), listed.trim())
const removed = await send(groupMessage('/kw del 你好'))
check('/kw del 生效', removed.includes('已删除'), removed.trim())
const miss = await send(groupMessage('随便说点什么', { atMe: false }))
check('词库未命中且群内未 @ 时静默', miss === '', miss.trim())

// 普通成员不能改词库
const stranger = await send(groupMessage('/kw add 测试 不该被添加', { userId: 1002 }))
check('非管理员改词库被拒（走后续流程）', !stranger.includes('已添加'), stranger.trim())

// ---- 今日人品 / 抽签 / 塔罗 ----
const f1 = await send(groupMessage('今日人品'))
const f2 = await send(groupMessage('今日人品'))
check('今日人品有输出', f1.length > 0 && /分|人品/.test(f1), f1.trim().slice(0, 40))
check('今日人品当天确定性一致', f1 === f2)
const lot = await send(groupMessage('抽签'))
check('抽签有输出', /签/.test(lot), lot.trim().slice(0, 30))
const tarot = await send(groupMessage('塔罗'))
check('塔罗有输出', tarot.length > 0, tarot.trim().slice(0, 30))

// ---- 骰子 / 随机抽人 ----
const roll = await send(groupMessage('.r 3d6'))
check('骰子可用', roll.includes('🎲') && /3d6/.test(roll), roll.trim())
const pick = await send(groupMessage('/抽一个 火锅 烧烤 面条'))
check('随机抽人可用', pick.includes('抽中'), pick.trim())

// ---- 积分 ----
await send(groupMessage('刷一条消息拿积分'))
const balance = await send(groupMessage('/积分'))
check('积分余额可查', /积分/.test(balance) && /现在有 [1-9]\d* 积分/.test(balance), balance.trim())
const board = await send(groupMessage('/排行榜'))
check('积分排行榜可用', /排行榜/.test(board), board.trim().slice(0, 30))
const transferBad = await send(groupMessage('/转账 50', { ats: [1002] }))
check('转账成功或明确报错', /已转给|转账失败/.test(transferBad), transferBad.trim())
const transferUsage = await send(groupMessage('/转账 给我'))
check('转账缺参数给用法', transferUsage.includes('用法'), transferUsage.trim())

// ---- 成语接龙 ----
// 开局成语随机，找一个词库里接得下去的再作答（最多重开 10 局）。
let chained = ''
for (let attempt = 0; attempt < 10; attempt++) {
  const start = await send(groupMessage('接龙'))
  if (attempt === 0) check('接龙开局', start.includes('成语接龙'), start.trim().slice(0, 40))
  const firstIdiom = /「(.{4})」/.exec(start)?.[1] ?? ''
  const candidate = DEFAULT_IDIOMS.find((word) => word[0] === firstIdiom[3] && word !== firstIdiom)
  if (candidate) {
    chained = await send(groupMessage(candidate))
    break
  }
  await send(groupMessage('结束游戏'))
}
check('接龙接得上', /接上啦|这局你赢/.test(chained), chained.trim().slice(0, 40))
await send(groupMessage('结束游戏'))

// ---- 猜数字 ----
const guessStart = await send(groupMessage('猜数字'))
check('猜数字开局', guessStart.includes('猜数字'), guessStart.trim().slice(0, 40))
const guessHint = await send(groupMessage('50'))
check('猜数字给提示', /太小了|太大了|猜对啦/.test(guessHint), guessHint.trim())
await send(groupMessage('不玩了'))

// ---- 私聊关键词（无需 @）----
await send(privateMessage('/kw add 在吗 在的，随时待命！'))
const privateHit = await send(privateMessage('在吗'))
check('私聊关键词命中', privateHit.includes('待命'), privateHit.trim())

// ---- /撤回 ----
const recall = await send(groupMessage('/撤回'))
check('/撤回 有记录则撤回、无记录给提示', /已撤回上一条消息|没有可撤回的消息/.test(recall), recall.trim())

bridge.stop()
check('stop() 可正常收尾（disposer 均为函数）', true)
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
