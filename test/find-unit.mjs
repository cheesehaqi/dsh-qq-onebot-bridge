/**
 * Bridge-level integration tests for the "群资产与检索" pack:
 * the local message archive (cwd/qq-history/YYYY-MM-DD.jsonl) + its start-time
 * prune, the read-only commands /找 · /ocr · /文件 · /取 · /相册, and the
 * qq_search_history agent tool.
 *
 * Skeleton is copied from test/seeing-unit.mjs: MockServer extends EventEmitter,
 * the REAL QQBridge runs against it, frames are injected with server.emit and the
 * outbound text is read back from the mock. The agent stub captures followup()
 * turns and tools.register() so we can assert on what the model would have seen.
 *
 * MockServer dispatch: the bridge only ever talks to `this.server.<method>(...)`,
 * i.e. the JS method names of lib/onebot.js's OneBotServer. The mock is a plain
 * replacement object, so scenarios are stubbed PER METHOD NAME and every call is
 * recorded under a pseudo-action equal to that method name (count('ocr_image'),
 * count('get_group_root_files'), ...). Nothing ever hits the network: the one
 * unreachable URL is 127.0.0.1:1 and is expected to fail.
 *
 * No DSH host, no network, no model call.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** A tiny helper: turn anything into a short single-line string for `extra`. */
function brief(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, 220)
}

/** Local `YYYY-MM-DD` (shards and the trash bucket use LOCAL dates, never toISOString). */
function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Recursively look for a file leaf name under `root`; '' when absent. */
function findFile(root, name, depth = 0) {
  if (depth > 4) return ''
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return '' }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isFile() && entry.name === name) return full
    if (entry.isDirectory()) {
      const hit = findFile(full, name, depth + 1)
      if (hit !== '') return hit
    }
  }
  return ''
}

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.calls = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
    // Injectable return values / errors (one scenario at a time).
    this.forwardResult = { messages: [] }
    this.forwardError = null
    this.memberList = []
    this.memberInfo = {}
    this.groupInfo = {}
    this.friendList = []
    this.groupHistory = []
    this.friendHistory = []
    this.emojiResult = { ok: true }
    this.leaveResult = { ok: true }
    // --- the pack under test ---
    this.msgResult = { message: [] }
    this.msgError = null
    this.ocrResult = { texts: [] }
    this.ocrError = null
    this.rootFiles = { files: [], folders: [] }
    this.folderFiles = { files: [] }
    this.fileUrl = { url: '' }
    this.albumList = { album_list: [] }
  }

  #rec(action, params) { this.calls.push({ action, params }) }
  count(action) { return this.calls.filter((call) => call.action === action).length }
  paramsOf(action) { return this.calls.filter((call) => call.action === action).map((call) => call.params) }
  reset() { this.calls.length = 0; this.sent.length = 0 }

  currentSocket() { return this.socket }

  sendSegments(_bot, messageType, targetId, segments) {
    this.#rec('send_msg', { messageType, targetId, segments })
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: this.sent.length })
  }

  sendText(_bot, messageType, targetId, text) {
    return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  getForwardMsg(socket, id) {
    this.#rec('get_forward_msg', { id, socket })
    if (this.forwardError) return Promise.reject(this.forwardError)
    return Promise.resolve(this.forwardResult)
  }

  getGroupMemberList(socket, groupId, noCache = false) {
    this.#rec('get_group_member_list', { groupId, noCache })
    return Promise.resolve(this.memberList)
  }

  getGroupMemberInfo(socket, groupId, userId, noCache = true) {
    this.#rec('get_group_member_info', { groupId, userId, noCache })
    return Promise.resolve(this.memberInfo)
  }

  getGroupInfo(socket, groupId, noCache = true) {
    this.#rec('get_group_info', { groupId, noCache })
    return Promise.resolve(this.groupInfo)
  }

  getFriendList(socket) {
    this.#rec('get_friend_list', {})
    return Promise.resolve(this.friendList)
  }

  getGroupMsgHistory(socket, groupId, messageSeq = 0, count = 20) {
    this.#rec('get_group_msg_history', { groupId, messageSeq, count })
    return Promise.resolve(this.groupHistory)
  }

  getFriendMsgHistory(socket, userId, messageSeq = 0, count = 20) {
    this.#rec('get_friend_msg_history', { userId, messageSeq, count })
    return Promise.resolve(this.friendHistory)
  }

  setMsgEmojiLike(socket, messageId, emojiId) {
    this.#rec('set_msg_emoji_like', { messageId, emojiId })
    return Promise.resolve(this.emojiResult)
  }

  setGroupLeave(socket, groupId, isDismiss = false) {
    this.#rec('set_group_leave', { groupId, isDismiss })
    return Promise.resolve(this.leaveResult)
  }

  // --- the methods this pack calls (recorded under their own names) ---
  getMsg(socket, messageId) {
    this.#rec('get_msg', { messageId })
    if (this.msgError) return Promise.reject(this.msgError)
    return Promise.resolve(this.msgResult)
  }

  ocrImage(socket, image) {
    this.#rec('ocr_image', { image })
    if (this.ocrError) return Promise.reject(this.ocrError)
    return Promise.resolve(this.ocrResult)
  }

  getGroupRootFiles(socket, groupId) {
    this.#rec('get_group_root_files', { groupId })
    return Promise.resolve(this.rootFiles)
  }

  getGroupFilesByFolder(socket, groupId, folderId) {
    this.#rec('get_group_files_by_folder', { groupId, folderId })
    return Promise.resolve(this.folderFiles)
  }

  getGroupFileUrl(socket, groupId, fileId, busid = 0) {
    this.#rec('get_group_file_url', { groupId, fileId, busid })
    return Promise.resolve(this.fileUrl)
  }

  getQunAlbumList(socket, groupId) {
    this.#rec('get_qun_album_list', { groupId })
    return Promise.resolve(this.albumList)
  }

  // --- harmless stubs for everything else the bridge may call ---
  sendForwardMsg() { return Promise.resolve({ message_id: 9999 }) }
  uploadFile() { return Promise.resolve({}) }
  deleteMsg() { return Promise.resolve({}) }
  sendGroupNotice() { return Promise.resolve({}) }
  setGroupWholeBan() { return Promise.resolve({}) }
  setGroupBan() { return Promise.resolve({}) }
  setGroupKick() { return Promise.resolve({}) }
  getGroupHonorInfo() { return Promise.resolve({}) }
  getGroupNotice() { return Promise.resolve([]) }
  getEssenceMsgList() { return Promise.resolve([]) }
}

const dirs = []
/** Fresh temporary cwd per scenario, so archive/trash assertions are deterministic. */
function freshCwd() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-find-test-'))
  dirs.push(dir)
  return dir
}

/** Config keys every scenario pins, so no test depends on another's defaults. */
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
  recordInbound: false,
  traceEnabled: true,
  traceLevel: 'debug',
  traceMemorySize: 500,
  actionAuditEnabled: false,
  adminEnabled: true,
  adminUsers: [1001],
  // Keep the pipeline narrow: only the pack under test may react to a message.
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
  pokeEnabled: false,
  autoCollectStickers: false,
  faceEnabled: false,
  privateImageView: false,
  fileTransferEnabled: false,
  agentMediaToolsEnabled: false,
  memoryEnabled: false,
  rateLimitEnabled: false,
}

/**
 * One isolated bridge per scenario: fresh mock server, fresh mock ctx, fresh cwd,
 * fresh config (= Config() defaults + QUIET_BASE + scenario overrides).
 * `options.autoStart === false` skips bridge.start() so a test can stage files
 * (e.g. an expired shard) BEFORE the start-time prune runs.
 */
function makeBridge(overrides = {}, options = {}) {
  const cwd = overrides.cwd ?? freshCwd()
  const server = new MockServer()
  const tools = []
  const sections = []
  const turns = []
  const created = []
  let seq = 0

  const makeCtx = () => {
    const agentCtx = {
      tools: { register: (tool) => { tools.push(tool); return tool } },
      systemPrompt: { section: (section) => { sections.push(section); return section } },
    }
    const newHandle = (sessionId, setup) => {
      const id = String(sessionId || `qq-find-${++seq}`)
      if (typeof setup === 'function') setup(agentCtx)
      const agent = {
        id,
        status: 'idle',
        // Exactly what lib/bridge.js#handoff calls, so the captured text IS the
        // user turn the model would have received.
        followup(message) {
          const blocks = Array.isArray(message?.content) ? message.content : []
          const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
          turns.push({ sessionId: id, text, blocks })
          return Promise.resolve()
        },
        cancel() {},
      }
      created.push(id)
      return { agent, sessionId: id, dispose: async () => {} }
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
  const logger = { info() {}, warn() {}, error() {} }
  const bridge = new QQBridge(makeCtx(), config, server, logger)
  if (options.autoStart !== false) bridge.start()

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
      records: [],
      images: [],
      files: [],
      forwards: [],
      messageId: `s${++seqMsgId}`,
      senderName: '小明',
      raw: { message: [] },
      ...extra,
    }
  }
  const groupMessage = (text, extra = {}) => message(text, extra)
  const privateMessage = (text, extra = {}) => message(text, { messageType: 'private', groupId: undefined, atMe: false, ...extra })

  async function send(msg, waitMs = 80) {
    const before = server.sent.length
    server.emit('message', msg)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    return server.sent.slice(before)
      .map((item) => item.segments.map((segment) => segment.data?.text ?? `[${segment.type}]`).join(''))
      .join('\n')
  }

  const toolNamed = (name) => tools.find((tool) => tool.name === name)
  const toolNames = () => tools.map((tool) => tool.name)
  const lastTurn = () => turns.at(-1)?.text ?? ''

  return {
    bridge, server, config, cwd, turns, tools, sections,
    toolNamed, toolNames, lastTurn, message, groupMessage, privateMessage, send,
    start: () => bridge.start(),
    archiveDir: () => join(cwd, 'qq-history'),
    shardPath: (day = localDay()) => join(cwd, 'qq-history', `${day}.jsonl`),
    shardText: function () { try { return readFileSync(this.shardPath(), 'utf8') } catch { return '' } },
    stop: () => bridge.stop(),
  }
}

// ===========================================================================
// A. 归档（/找 的数据源）
// ===========================================================================

const T1 = '今晚组队打暗区突围'
const INJECTED = '注入帧的机密暗号ZZZ'
const REPLAYED = '回放帧的机密暗号YYY'
const OUTSIDER = '越权群不该入档的暗号XXX'

// 1. 白名单群的普通消息会写入当天的分片
{
  const t = makeBridge()
  await t.send(t.groupMessage(T1))
  const file = t.shardPath()
  check('A1 白名单消息写入 qq-history/<今天>.jsonl', existsSync(file), `file=${file}`)
  check('A1 分片含这条文本', t.shardText().includes(T1), brief(t.shardText()))
  t.stop()
}

// 2 + 3 + 4. 注入帧 / 回放帧 / 非白名单会话都不入档（同一个 cwd，另有对照消息证明分片真的在写）
{
  const t = makeBridge()
  await t.send(t.groupMessage('白名单群的正常消息一号'))
  check('A2 对照：普通消息确实入档', t.shardText().includes('白名单群的正常消息一号'), brief(t.shardText()))

  await t.send(t.groupMessage(INJECTED, { __injected: true }))
  check('A2 注入帧不入档', !t.shardText().includes(INJECTED), brief(t.shardText()))

  await t.send(t.groupMessage(REPLAYED, { __replayed: true }))
  check('A3 回放帧不入档', !t.shardText().includes(REPLAYED), brief(t.shardText()))

  const reply = await t.send(t.groupMessage(OUTSIDER, { groupId: 2003 }))
  check('A4 非白名单会话不入档', !t.shardText().includes(OUTSIDER), brief(t.shardText()))
  check('A4 非白名单会话也不回复', reply === '', brief(reply))
  t.stop()
}

// 5. historyArchiveEnabled:false → 没有 archive 对象，也不会建目录
{
  const t = makeBridge({ historyArchiveEnabled: false })
  check('A5 historyArchiveEnabled=false 时 bridge.archive 为 null', t.bridge.archive === null, brief(t.bridge.archive))
  await t.send(t.groupMessage('关闭归档后的消息不该落盘'))
  check('A5 关闭归档时不创建 qq-history 目录', !existsSync(t.archiveDir()), `dir=${t.archiveDir()} exists=${existsSync(t.archiveDir())}`)
  t.stop()
}

// 6. prune 走"移走不删"：200 天前的旧分片在 start() 时被搬进 qq-trash/
{
  const t = makeBridge({ historyArchiveKeepDays: 30 }, { autoStart: false })
  const archiveDir = t.archiveDir()
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(join(archiveDir, '2020-01-01.jsonl'), `${JSON.stringify({ ts: 1577836800000, chatKey: 'g:2002', userId: 1001, name: '小明', kind: 'message', text: '很久以前的一条消息' })}\n`, 'utf8')
  t.start()
  await new Promise((resolve) => setTimeout(resolve, 40))
  const today = localDay()
  const trashRoot = join(t.cwd, 'qq-trash')
  const strict = join(trashRoot, today, '2020-01-01.jsonl')
  const found = findFile(trashRoot, '2020-01-01.jsonl')
  check('A6 旧分片已从归档目录消失', !existsSync(join(archiveDir, '2020-01-01.jsonl')), `still=${existsSync(join(archiveDir, '2020-01-01.jsonl'))}`)
  check('A6 旧分片被移走而不是删除（qq-trash 下能找到）', found !== '', `found=${found === '' ? '(none)' : found.replace(t.cwd, '<cwd>')}`)
  check('A6 旧分片位于 qq-trash/<今天>/ 正下方', existsSync(strict), `expected=${strict.replace(t.cwd, '<cwd>')} actual=${found === '' ? '(none)' : found.replace(t.cwd, '<cwd>')}`)
  t.stop()
}

// ===========================================================================
// B. /找 关键词
// ===========================================================================

const HIT = '今晚暗区突围开黑走起'
const MISS = '我先去睡觉了明天见'

// 7. 基本命中 + 不含关键词的内容不出现
{
  const t = makeBridge()
  await t.send(t.groupMessage(HIT))
  await t.send(t.groupMessage(MISS))
  const reply = await t.send(t.groupMessage('/找 暗区突围'))
  check('B7 /找 命中回复含关键词', reply.includes('暗区突围'), brief(reply))
  check('B7 /找 不含关键词的会话内容不出现', !reply.includes(MISS), brief(reply))
  t.stop()
}

// 8. 多关键词 AND
{
  const t = makeBridge()
  await t.send(t.groupMessage(HIT))
  const and = await t.send(t.groupMessage('/找 暗区 突围'))
  check('B8 多关键词 AND 命中', and.includes('开黑走起'), brief(and))
  const none = await t.send(t.groupMessage('/找 暗区 不存在的词'))
  check('B8 多关键词有一个不命中就 0 条', none.includes('没找到'), brief(none))
  // 回归：命令行不入档（否则每次 /找 都会命中自己刚敲的查询词，"没找到"永远不可达）
  const hitLines = none.split('\n').slice(1).map((line) => line.trim()).filter((line) => line !== '')
  check('B8b 命令行不入档：不命中时结果里没有 /找 自己的回声', hitLines.length === 0, brief(hitLines))
  t.stop()
}

// 9. historySearchEnabled:false → 不检索。
//    依据 lib/bridge.js#handleHistorySearch 第 1 行 `if (this.config.historySearchEnabled === false) return false`：
//    命令不消费这条消息，也没有别的 handler 接 /找，于是落到 #ensureSession → agent 路径（回复为空、turns 增加）。
{
  const t = makeBridge({ historySearchEnabled: false })
  await t.send(t.groupMessage(HIT))
  const turnsBefore = t.turns.length
  const reply = await t.send(t.groupMessage('/找 暗区突围'))
  check('B9 关闭检索时 /找 不回复（走了模型路径）', reply === '', brief(reply))
  check('B9 关闭检索时消息落到 agent 回合', t.turns.length === turnsBefore + 1 && t.lastTurn().includes('/找 暗区突围'), `turns=${t.turns.length} last=${brief(t.lastTurn())}`)
  t.stop()
}

// 10. /找 无参数 → 用法
{
  const t = makeBridge()
  const reply = await t.send(t.groupMessage('/找'))
  check('B10 /找 无参数回复含用法', reply.includes('用法'), brief(reply))
  check('B10b 回归：/找 无参数被命令层拦下（不再落到 agent）', t.turns.length === 0, `turns=${t.turns.length} last=${brief(t.lastTurn())}`)
  t.stop()
}

// 11. chatKey 隔离：群 A 的消息不会被群 B 的 /找 命中
{
  const A = '甲群独有的暗号AAA'
  const B = '乙群独有的暗号BBB'
  const t = makeBridge({ allowGroups: [2002, 2003] })
  await t.send(t.groupMessage(A, { groupId: 2002 }))
  await t.send(t.groupMessage(B, { groupId: 2003 }))
  const inA = await t.send(t.groupMessage('/找 独有', { groupId: 2002 }))
  const inB = await t.send(t.groupMessage('/找 独有', { groupId: 2003 }))
  check('B11 甲群的 /找 只命中甲群消息', inA.includes(A) && !inA.includes(B), brief(inA))
  check('B11 乙群的 /找 只命中乙群消息', inB.includes(B) && !inB.includes(A), brief(inB))
  t.stop()
}

// ===========================================================================
// C. qq_search_history 工具
// ===========================================================================

// 12. 默认（historySearchEnabled/reactToolEnabled 打开）注册
{
  const t = makeBridge({ historySearchEnabled: true, reactToolEnabled: true })
  await t.send(t.groupMessage('你好呀'))
  check('C12 注册 qq_search_history', t.toolNames().includes('qq_search_history'), brief(t.toolNames()))
  check('C12 同时注册 qq_react（对照组）', t.toolNames().includes('qq_react'), brief(t.toolNames()))
  t.stop()
}

// 13. historySearchEnabled:false → 不注册
{
  const t = makeBridge({ historySearchEnabled: false })
  await t.send(t.groupMessage('你好呀'))
  check('C13 historySearchEnabled=false 时不注册 qq_search_history', !t.toolNames().includes('qq_search_history'), brief(t.toolNames()))
  t.stop()
}

// 14. 执行：非空关键词有命中，空关键词 count=0 且是中文提示
{
  const t = makeBridge()
  await t.send(t.groupMessage(HIT))
  const tool = t.toolNamed('qq_search_history')
  const result = await tool.execute({ keywords: '暗区' })
  check('C14 execute 有命中', Number(result?.count) >= 1, brief(result))
  check('C14 detail 含关键词与命中文本', String(result?.detail ?? '').includes('暗区') && String(result?.detail ?? '').includes(HIT), brief(result?.detail))
  const empty = await tool.execute({ keywords: '   ' })
  check('C14 空关键词 count 为 0', empty?.count === 0, brief(empty))
  check('C14 空关键词 detail 是中文提示', /关键词/.test(String(empty?.detail ?? '')) && /[\u4e00-\u9fa5]/.test(String(empty?.detail ?? '')), brief(empty?.detail))
  t.stop()
}

// 15. historyArchiveEnabled:false（archive === null）→ 不注册该工具
{
  const t = makeBridge({ historyArchiveEnabled: false })
  await t.send(t.groupMessage('你好呀'))
  check('C15 无归档时不注册 qq_search_history', t.bridge.archive === null && !t.toolNames().includes('qq_search_history'), brief(t.toolNames()))
  t.stop()
}

// ===========================================================================
// D. /ocr
// ===========================================================================

// 16. 引用带图消息 → ocr_image
{
  const t = makeBridge()
  const imgPath = join(t.cwd, 'quoted-pic.png')
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  t.server.msgResult = { message: [{ type: 'image', data: { file: imgPath } }] }
  t.server.ocrResult = { texts: [{ text: '识别出来的字' }] }
  const reply = await t.send(t.groupMessage('/ocr', { reply: { messageId: 's1' } }))
  check('D16 引用图走 ocr_image 一次', t.server.count('ocr_image') === 1, `calls=${t.server.count('ocr_image')}`)
  check('D16 识别结果进入回复', reply.includes('识别出来的字'), brief(reply))
  t.stop()
}

// 17. message.images 自带图片（无引用）也能识别
{
  const t = makeBridge()
  const imgPath = join(t.cwd, 'attached-pic.png')
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  t.server.ocrResult = { texts: [{ text: '识别出来的字' }] }
  const reply = await t.send(t.groupMessage('/ocr', { images: [{ file: imgPath }] }))
  check('D17 自带图片走 ocr_image 一次', t.server.count('ocr_image') === 1, `calls=${t.server.count('ocr_image')}`)
  check('D17 自带图片的识别结果进入回复', reply.includes('识别出来的字'), brief(reply))
  t.stop()
}

// 18. 没有任何图片 → 用法
{
  const t = makeBridge()
  const reply = await t.send(t.groupMessage('/ocr'))
  check('D18 无图回复含用法', reply.includes('用法'), brief(reply))
  check('D18 无图时不调用 ocr_image', t.server.count('ocr_image') === 0, `calls=${t.server.count('ocr_image')}`)
  t.stop()
}

// 19. ocr_image 抛错 → 说明识别失败，不崩
{
  const t = makeBridge()
  const imgPath = join(t.cwd, 'broken-pic.png')
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  t.server.ocrError = new Error('boom-ocr')
  const reply = await t.send(t.groupMessage('/ocr', { images: [{ file: imgPath }] }))
  check('D19 识别失败时回复含识别失败', reply.includes('识别失败'), brief(reply))
  check('D19 识别失败不整体崩（没有处理失败）', !reply.includes('处理失败'), brief(reply))
  t.stop()
}

// 20. ocrEnabled:false → 一次识别都不发
{
  const t = makeBridge({ ocrEnabled: false })
  const imgPath = join(t.cwd, 'disabled-pic.png')
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const reply = await t.send(t.groupMessage('/ocr', { images: [{ file: imgPath }] }))
  check('D20 ocrEnabled=false 时不调用 ocr_image', t.server.count('ocr_image') === 0, `calls=${t.server.count('ocr_image')}`)
  check('D20 ocrEnabled=false 时不回复识别结果', !reply.includes('图片文字识别'), brief(reply))
  t.stop()
}

// ===========================================================================
// E. /文件 与 /取
// ===========================================================================

const ROOT_FILES = {
  files: [{ file_name: 'a.zip', file_id: 'fid-a', busid: 0, file_size: 1024, uploader_name: '小明', upload_time: 1700000000 }],
  folders: [{ folder_name: '资料', folder_id: 'fid-j', total_file_count: 2 }],
}

// 21. /文件 列根目录
{
  const t = makeBridge()
  t.server.rootFiles = ROOT_FILES
  const reply = await t.send(t.groupMessage('/文件'))
  check('E21 /文件 调用 get_group_root_files 一次', t.server.count('get_group_root_files') === 1, `calls=${t.server.count('get_group_root_files')}`)
  check('E21 回复含文件名与文件夹名', reply.includes('a.zip') && reply.includes('资料'), brief(reply))
  t.stop()
}

// 22. /文件 资料 进文件夹
{
  const t = makeBridge()
  t.server.rootFiles = ROOT_FILES
  t.server.folderFiles = { files: [{ file_name: '资料里的报告.docx', file_id: 'fid-b', file_size: 2048 }] }
  const reply = await t.send(t.groupMessage('/文件 资料'))
  check('E22 /文件 资料 调用 get_group_files_by_folder', t.server.count('get_group_files_by_folder') === 1, `calls=${t.server.count('get_group_files_by_folder')}`)
  check('E22 传的是那个文件夹的 id', t.server.paramsOf('get_group_files_by_folder')[0]?.folderId === 'fid-j', brief(t.server.paramsOf('get_group_files_by_folder')))
  check('E22 回复含文件夹里的文件名', reply.includes('资料里的报告.docx'), brief(reply))
  t.stop()
}

// 23. /取 a.zip 下载地址不可达 → 失败提示，不崩（故意 127.0.0.1:1，不联网）
{
  const t = makeBridge()
  t.server.rootFiles = ROOT_FILES
  t.server.fileUrl = { url: 'http://127.0.0.1:1/x' }
  const reply = await t.send(t.groupMessage('/取 a.zip'), 400)
  check('E23 /取 先问一次下载地址', t.server.count('get_group_file_url') === 1, `calls=${t.server.count('get_group_file_url')}`)
  check('E23 下载失败回复含失败', reply.includes('失败'), brief(reply))
  check('E23 下载失败不整体崩（没有处理失败）', !reply.includes('处理失败'), brief(reply))
  t.stop()
}

// 24. /取 不存在的文件 → 没有找到
{
  const t = makeBridge()
  t.server.rootFiles = ROOT_FILES
  const reply = await t.send(t.groupMessage('/取 不存在的文件'))
  check('E24 找不到文件时回复含没有找到', reply.includes('没有找到'), brief(reply))
  check('E24 找不到文件时不问下载地址', t.server.count('get_group_file_url') === 0, `calls=${t.server.count('get_group_file_url')}`)
  t.stop()
}

// 25. groupFileEnabled:false → 不触发 API
{
  const t = makeBridge({ groupFileEnabled: false })
  t.server.rootFiles = ROOT_FILES
  const reply = await t.send(t.groupMessage('/文件'))
  check('E25 groupFileEnabled=false 时不调用 get_group_root_files', t.server.count('get_group_root_files') === 0, `calls=${t.server.count('get_group_root_files')}`)
  check('E25 groupFileEnabled=false 时说明功能关闭', reply.includes('关闭'), brief(reply))
  t.stop()
}

// 26. 私聊 /文件 不触发（群限定）
{
  const t = makeBridge()
  t.server.rootFiles = ROOT_FILES
  const reply = await t.send(t.privateMessage('/文件'))
  check('E26 私聊 /文件 不调用 get_group_root_files', t.server.count('get_group_root_files') === 0, `calls=${t.server.count('get_group_root_files')}`)
  check('E26 私聊 /文件 不回复群文件列表', !reply.includes('群文件'), brief(reply))
  t.stop()
}

// ===========================================================================
// F. /相册
// ===========================================================================

// 27. 有相册
{
  const t = makeBridge()
  t.server.albumList = { album_list: [{ album_id: '1', album_name: '活动', photo_count: 3 }] }
  const reply = await t.send(t.groupMessage('/相册'))
  check('F27 /相册 调用 get_qun_album_list', t.server.count('get_qun_album_list') === 1, `calls=${t.server.count('get_qun_album_list')}`)
  check('F27 回复含相册名与张数', reply.includes('活动') && reply.includes('3'), brief(reply))
  t.stop()
}

// 28. 空相册列表 → 兜底文案，不抛错
{
  const t = makeBridge()
  t.server.albumList = { album_list: [] }
  const reply = await t.send(t.groupMessage('/相册'))
  check('F28 空相册回复共 0 个', /共 0 个/.test(reply), brief(reply))
  check('F28 空相册不报错', !reply.includes('查询群相册失败') && !reply.includes('处理失败'), brief(reply))
  t.stop()
}

// ===========================================================================
// G. 回归：/读图 是 OCR 的别名，绝不能被语音朗读吃掉
//    （lib/bridge.js#onQqMessageInner 的 voiceReadingEnabled 分发里那个 ocrAlias 判断）
// ===========================================================================

// 29. voiceReadingEnabled 打开时 /读图 + 图片 → 真的走 ocr_image，且一条语音都不发
//     TTS 故意指向 127.0.0.1:1（本文件既有约定：这个地址必然失败、绝不联网）：
//     万一回归成"朗读吃掉 /读图"，这里会立刻变成一条「朗读失败」而不是挂 60s 等 Azure。
{
  const t = makeBridge({ voiceReadingEnabled: true, ocrEnabled: true, ttsProvider: 'local', ttsLocalUrl: 'http://127.0.0.1:1' })
  const imgPath = join(t.cwd, 'read-image-ocr.png')
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  t.server.ocrResult = { texts: [{ text: '读图识别出来的字' }] }
  const reply = await t.send(t.privateMessage('/读图', { images: [{ kind: 'image', url: '', file: imgPath }] }), 250)
  check('G29 /读图 调用 ocr_image', t.server.count('ocr_image') >= 1, `calls=${t.server.count('ocr_image')} reply=${brief(reply)}`)
  check('G29 /读图 的回复是 OCR 结果', reply.includes('图片文字识别') && reply.includes('读图识别出来的字'), brief(reply))
  const records = t.server.sent.flatMap((item) => item.segments.filter((segment) => segment.type === 'record'))
  check('G29 /读图 一条语音都没发（没被朗读吃掉）', records.length === 0 && !reply.includes('朗读'), `records=${records.length} reply=${brief(reply)}`)
  t.stop()
}

// 30. 对照：同一套开关下 /读 你好 走朗读（TTS 不可用 → 朗读失败），一次 ocr_image 都不发
{
  const t = makeBridge({ voiceReadingEnabled: true, ocrEnabled: true, ttsProvider: 'local', ttsLocalUrl: 'http://127.0.0.1:1' })
  const reply = await t.send(t.privateMessage('/读 你好'), 250)
  check('G30 TTS 不可用时 /读 不调用 ocr_image', t.server.count('ocr_image') === 0, `calls=${t.server.count('ocr_image')} reply=${brief(reply)}`)
  check('G30 /读 的回复不是 OCR 结果', !reply.includes('图片文字识别'), brief(reply))
  t.stop()
}

// ===========================================================================
// H. 回归：注入/回放回合里的 /好友 不访问 QQ
//    （lib/bridge.js#handleFriendList 开头的离线判断）
// ===========================================================================

// 31. 注入的私聊管理员 /好友 → 一次 get_friend_list 都不发，回复标明回放/注入
{
  const t = makeBridge({ friendListEnabled: true, adminUsers: [1001] })
  t.server.friendList = [{ user_id: 20002, nickname: '小红' }]
  const reply = await t.send(t.privateMessage('/好友', { __injected: true }))
  check('H31 注入回合不调用 get_friend_list', t.server.count('get_friend_list') === 0, `calls=${t.server.count('get_friend_list')}`)
  check('H31 回复标明回放/注入', reply.includes('回放/注入'), brief(reply))
  check('H31 回复说明取不到好友列表（不是好友名单）', reply.includes('取不到好友列表') && !reply.includes('小红'), brief(reply))
  t.stop()
}

// ===========================================================================
// I. 回归：归档写入失败必须留痕
//    （lib/bridge.js#onQqMessageInner 里 written === false 时那条 stage:'archive' 的 trace）
// ===========================================================================

// 32. historyArchiveDir 指向不存在的盘符（Z:\）→ archive.append 返回 false → trace 必须有 archive ok=false
{
  const t = makeBridge({ historyArchiveDir: 'Z:\\nope\\qq-history' })
  await t.send(t.groupMessage('归档写入失败留痕的普通消息'))
  const failed = t.bridge.trace.recent({ limit: 5000, stage: 'archive', ok: false })
  check('I32 归档写入失败留下 archive ok=false 事件', failed.length > 0, brief(failed.map((e) => `${e.ok}:${e.reason ?? ''}`)))
  check('I32 trace 原因提到归档', failed.some((event) => String(event.reason ?? '').includes('归档')), brief(failed.map((e) => e.reason)))
  check('I32 归档失败不阻塞主流程（消息仍进 agent 回合）', t.turns.length === 1, `turns=${t.turns.length}`)
  t.stop()
}

// 32b. 对照：可写目录（默认 cwd/qq-history）下不应该出现 archive ok=false —— 免得上面那条是靠
//      "trace 里本来就有个 archive 失败事件" 蒙对的。
{
  const t = makeBridge()
  await t.send(t.groupMessage('归档正常写入的普通消息'))
  const failed = t.bridge.trace.recent({ limit: 5000, stage: 'archive', ok: false })
  check('I32b 对照：可写目录下没有 archive 失败事件', failed.length === 0 && t.shardText().includes('归档正常写入的普通消息'), brief(failed.map((e) => e.reason)))
  t.stop()
}

// 32c. 同一断言的**可移植**写法：拿一个普通文件当父目录（mkdir 必然 ENOTDIR），
//      这样"Z: 盘恰好存在"的机器上这条回归也不会失效。
{
  const cwd = freshCwd()
  const blocker = join(cwd, 'not-a-dir')
  writeFileSync(blocker, 'x', 'utf8')
  const t = makeBridge({ cwd, historyArchiveDir: join(blocker, 'qq-history') })
  await t.send(t.groupMessage('归档目录父级是文件时的普通消息'))
  const failed = t.bridge.trace.recent({ limit: 5000, stage: 'archive', ok: false })
  check('I32c 归档目录不可创建时同样留下 archive ok=false + 归档原因', failed.length > 0 && String(failed.at(-1)?.reason ?? '').includes('归档'), brief(failed.map((e) => `${e.ok}:${e.reason ?? ''}`)))
  t.stop()
}

for (const dir of dirs) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结论 */ }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
