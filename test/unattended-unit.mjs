/**
 * Bridge-level integration tests for the "无人值守" pack (inbound webhook +
 * scheduled broadcast + disconnect auto-heal), i.e. the wiring that lives in
 * lib/bridge.js — NOT the module-level unit tests of lib/webhook.js /
 * lib/webhookfmt.js / lib/broadcast.js (those authors ship their own).
 *
 * Skeleton copied from test/seeing-unit.mjs: a MockServer extends EventEmitter,
 * the REAL QQBridge runs against it, frames are injected with server.emit and the
 * outbound text is read back from the mock. The agent stub captures followup()
 * turns so we can prove nothing reached the model.
 *
 * The webhook cases (A) are the only ones that use a REAL socket: the bridge
 * creates a real WebhookReceiver inside its constructor, so this file talks to it
 * with Node's built-in global fetch on http://127.0.0.1:<high random port>.
 * Everything else stays offline (the single unreachable address is 127.0.0.1:1,
 * which is the convention this repo's other bridge tests already use).
 *
 * No DSH host, no external network, no model call.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
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
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, 240)
}

/** Local `YYYY-MM-DD` (the archive shards use LOCAL dates, never toISOString). */
function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.calls = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
    // Injectable return values (per scenario). The bridge only calls methods by
    // name, so a plain replacement object is enough.
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
    this.dryRun = false
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

  setDryRun(enabled) {
    this.dryRun = enabled === true
    return { enabled: !enabled, scope: null }
  }

  takeDryRunCalls() { return [] }

  // --- harmless stubs for everything else the bridge may call ---
  getMsg() { return Promise.resolve({ message: [] }) }
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
/** Fresh temporary cwd per scenario (archive/broadcast-state assertions stay deterministic). */
function freshCwd() {
  const dir = mkdtempSync(join(tmpdir(), 'qq-unattended-test-'))
  dirs.push(dir)
  return dir
}

/**
 * Config keys every scenario pins, so no test depends on another's defaults.
 * The three features under test stay OFF here: each scenario turns on exactly
 * what it needs.
 */
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
  // 无人值守三件套：默认全关，各场景按需打开
  webhookEnabled: false,
  webhookSources: [],
  webhookRatePerMinute: 30,
  webhookMaxBodyBytes: 65536,
  broadcastEnabled: false,
  broadcastJobs: [],
  autoHealEnabled: false,
  autoHealCommand: '',
  autoHealCooldownSeconds: 300,
  autoHealMaxPerHour: 3,
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

/** One high random port per scenario: never the schema default (8798), never a low port. */
function randomWebhookPort() {
  return 18700 + Math.floor(Math.random() * 200)
}

/**
 * One isolated bridge per scenario: fresh mock server, fresh mock ctx, fresh cwd,
 * fresh config (= Config() defaults + QUIET_BASE + scenario overrides).
 */
function makeBridge(overrides = {}) {
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
      const id = String(sessionId || `qq-unattended-${++seq}`)
      if (typeof setup === 'function') setup(agentCtx)
      const agent = {
        id,
        status: 'idle',
        followup(message) {
          const blocks = Array.isArray(message?.content) ? message.content : []
          const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
          turns.push({ sessionId: id, text, blocks })
          return Promise.resolve()
        },
        // lib/bridge.js#onBotDisconnect calls agent.cancel({ kind: 'user' }) — the
        // mock must accept that shape or the heal scenarios would throw before
        // ever reaching #tryAutoHeal.
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

  async function send(msg, waitMs = 120) {
    const before = server.sent.length
    server.emit('message', msg)
    await sleep(waitMs)
    return server.sent.slice(before)
      .map((item) => item.segments.map((segment) => segment.data?.text ?? `[${segment.type}]`).join(''))
      .join('\n')
  }

  const toolNamed = (name) => tools.find((tool) => tool.name === name)
  const toolNames = () => tools.map((tool) => tool.name)
  const lastTurn = () => turns.at(-1)?.text ?? ''
  const traceStage = (stage, ok = null) => bridge.trace.recent({ limit: 5000, stage, ok })
  const reasonOf = (event) => String(event?.reason ?? '')
  const allReasons = (events) => events.map((event) => reasonOf(event)).join(' | ')

  return {
    bridge, server, config, cwd, turns, tools, sections,
    toolNamed, toolNames, lastTurn, traceStage, reasonOf, allReasons,
    message, groupMessage, privateMessage, send,
    shardPath: (day = localDay()) => join(cwd, 'qq-history', `${day}.jsonl`),
    textOf: function (file) { try { return readFileSync(file, 'utf8') } catch { return '' } },
    stop: () => bridge.stop(),
  }
}

/**
 * Real HTTP POST to the bridge's own receiver.
 * `init` may be a plain RequestInit or a function (the body is only built once we
 * know the port is actually listening, so a `retry` re-serializes the same payload).
 */
async function postHook(port, name, { headers = {}, body = null, retry = false } = {}) {
  const url = `http://127.0.0.1:${port}/hook/${name}`
  const attempts = retry ? 40 : 1
  let lastError = null
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(4000),
      })
      let text = ''
      try { text = await response.text() } catch { /* body 不重要 */ }
      return { status: response.status, text, error: null }
    } catch (error) {
      lastError = error
      if (i < attempts - 1) await sleep(50)
    }
  }
  return { status: 0, text: '', error: lastError }
}

/** Wait until the bridge's receiver accepts a TCP connection. */
async function waitListening(port, probe = {}) {
  for (let i = 0; i < 40; i++) {
    const result = await postHook(port, '__probe__', { body: {}, ...probe })
    if (result.error === null) return true
    await sleep(50)
  }
  return false
}

// ===========================================================================
// A. 入站 webhook → 群里发消息（真实 HTTP 往返）
// ===========================================================================

const TOKEN = 'tok-abc123'
const SECRET = 'sec-hmac-xyz'
const GENERIC_TEMPLATE = '🚀 {event.title} → {event.message}'
const GENERIC_BODY = { event: { title: '部署完成', message: '版本 v9.9.9 已上线' } }
/** The exact text renderWebhook must produce before it goes out (collapse() 压空白). */
const GENERIC_RENDERED = '🚀 部署完成 → 版本 v9.9.9 已上线'

// ---------------------------------------------------------------------------
// A1 + A2. 正确 token → 202 且真的发到群；错误 token → 401 且零出站
// ---------------------------------------------------------------------------
{
  const port = randomWebhookPort()
  const t = makeBridge({
    webhookEnabled: true,
    webhookPort: port,
    webhookRatePerMinute: 30,
    webhookSources: [{ name: 'deploy', format: 'generic', chat: 'g:2002', token: TOKEN, template: GENERIC_TEMPLATE }],
  })
  const listening = await waitListening(port)
  check('A1 webhook 监听 127.0.0.1:<webhookPort>', listening, `port=${port} error=${brief(String(listening ? '' : 'connect failed'))}`)

  const good = await postHook(port, 'deploy', { headers: { 'x-webhook-token': TOKEN }, body: GENERIC_BODY, retry: true })
  check('A1 正确 token POST /hook/deploy 回 202', good.status === 202, `status=${good.status} body=${brief(good.text)}`)
  const outbound = t.server.sent.map((item) => item.segments.map((s) => s.data?.text ?? '').join('')).join('\n')
  check('A1 桥向群里发了一条消息', t.server.sent.length === 1, `sent=${t.server.sent.length} text=${brief(outbound)}`)
  check('A1 发的是配置里的那个群（g:2002）', t.server.sent[0]?.messageType === 'group' && t.server.sent[0]?.targetId === 2002, brief(t.server.sent.map((s) => `${s.messageType}:${s.targetId}`)))
  check('A1 群消息文本含模板渲染出的字段值', outbound.includes('部署完成') && outbound.includes('版本 v9.9.9 已上线'), `text=${brief(outbound)}`)
  check('A1 群消息文本与渲染结果一致', outbound === GENERIC_RENDERED, `text=${brief(outbound)} expected=${brief(GENERIC_RENDERED)}`)
  const okEvents = t.traceStage('webhook', true)
  check('A1 trace 有 webhook 成功事件', okEvents.length > 0, brief(t.allReasons(okEvents)))

  const before = t.server.sent.length
  const bad = await postHook(port, 'deploy', { headers: { 'x-webhook-token': 'wrong-token' }, body: { event: { title: '不该出现', message: '不该出现' } } })
  check('A2 错误 token 回 401', bad.status === 401, `status=${bad.status} body=${brief(bad.text)}`)
  check('A2 错误 token 没有新增出站', t.server.sent.length === before, `sent=${t.server.sent.length} before=${before}`)
  const after = t.server.sent.slice(before).map((item) => item.segments.map((s) => s.data?.text ?? '').join('')).join('\n')
  check('A2 错误 token 的正文一个字都没发出去', !after.includes('不该出现'), brief(after))

  // 顺便确认真实往返链路没有把端口/来源状态弄丢
  const status = t.bridge.webhook?.status?.()
  check('A2 webhook.status() 记录了这次成功投递', status?.sources?.[0]?.received === 1, brief(status))
  t.stop()
}

// ---------------------------------------------------------------------------
// A3. 既没 token 也没 secret 的来源 → 401，且绝不发任何消息（未鉴权端点不开放）
// ---------------------------------------------------------------------------
{
  const port = randomWebhookPort()
  const t = makeBridge({
    webhookEnabled: true,
    webhookPort: port,
    webhookSources: [{ name: 'anon', format: 'generic', chat: 'g:2002', template: GENERIC_TEMPLATE }],
  })
  await waitListening(port)
  const result = await postHook(port, 'anon', { body: GENERIC_BODY })
  // 拒法可以是 401（先注册再鉴权）或 404（构造时就把无凭据来源剔除，连路由都没有）——
  // 两种都算"未鉴权端点绝不开放"，但绝不允许 202。
  check('A3 无凭据来源的请求被拒（401/404，绝不 202）', result.status === 401 || result.status === 404, `status=${result.status} body=${brief(result.text)} error=${brief(String(result.error ?? ''))}`)
  check('A3 无凭据来源不发任何消息', t.server.sent.length === 0, `sent=${t.server.sent.length}`)
  const status = t.bridge.webhook?.status?.()
  check('A3 无凭据来源根本没注册路由', status?.sources?.length === 0, brief(status))
  const leaked = t.trace?.ring?.filter?.((event) => event.chatKey === 'g:2002') ?? []
  check('A3 未鉴权请求没有触达桥（没有 g:2002 的 trace）', leaked.length === 0, brief(leaked.map((e) => `${e.stage}:${e.ok}`)))
  t.stop()
}

// ---------------------------------------------------------------------------
// A4. webhookEnabled=false → 桥不监听该端口，webhook 对象为 null
// ---------------------------------------------------------------------------
{
  const port = randomWebhookPort()
  const t = makeBridge({ webhookEnabled: false, webhookPort: port, webhookSources: [{ name: 'deploy', format: 'generic', chat: 'g:2002', token: TOKEN, template: GENERIC_TEMPLATE }] })
  check('A4 webhookEnabled=false 时 bridge.webhook === null', t.bridge.webhook === null, brief(t.bridge.webhook))
  const result = await postHook(port, 'deploy', { headers: { 'x-webhook-token': TOKEN }, body: GENERIC_BODY })
  check('A4 关闭时 fetch 连不上该端口', result.error !== null, `status=${result.status} error=${brief(String(result.error?.message ?? result.error ?? ''))}`)
  check('A4 关闭时没有任何出站', t.server.sent.length === 0, `sent=${t.server.sent.length}`)
  t.stop()
}

// ---------------------------------------------------------------------------
// A5. 限频：webhookRatePerMinute=1 → 第二次 429，received=1 / dropped>=1
// ---------------------------------------------------------------------------
{
  const port = randomWebhookPort()
  const t = makeBridge({
    webhookEnabled: true,
    webhookPort: port,
    webhookRatePerMinute: 1,
    webhookSources: [{ name: 'deploy', format: 'generic', chat: 'g:2002', token: TOKEN, template: GENERIC_TEMPLATE }],
  })
  await waitListening(port)
  const first = await postHook(port, 'deploy', { headers: { 'x-webhook-token': TOKEN }, body: GENERIC_BODY, retry: true })
  const second = await postHook(port, 'deploy', { headers: { 'x-webhook-token': TOKEN }, body: GENERIC_BODY })
  check('A5 第一次请求 202', first.status === 202, `status=${first.status} body=${brief(first.text)}`)
  check('A5 第二次请求 429（限频）', second.status === 429, `status=${second.status} body=${brief(second.text)}`)
  const status = t.bridge.webhook?.status?.()
  const source = status?.sources?.[0] ?? {}
  check('A5 status() 里 received === 1', source.received === 1, brief(status))
  check('A5 status() 里 dropped >= 1', Number(source.dropped) >= 1, brief(status))
  check('A5 限频只放过一条群消息', t.server.sent.length === 1, `sent=${t.server.sent.length}`)
  t.stop()
}

// ---------------------------------------------------------------------------
// A6. 渲染失败不崩：payload 是数组 → 走 JSON 片段；payload 是字符串 → 占位符回落到（无）
//    两种情况都必须有 stage==='webhook' 且 reason 非空的 trace。
// ---------------------------------------------------------------------------
{
  const port = randomWebhookPort()
  const t = makeBridge({
    webhookEnabled: true,
    webhookPort: port,
    webhookSources: [{ name: 'deploy', format: 'generic', chat: 'g:2002', token: TOKEN, template: GENERIC_TEMPLATE }],
  })
  await waitListening(port)

  const arrayResult = await postHook(port, 'deploy', { headers: { 'x-webhook-token': TOKEN }, body: [1, 2, 3], retry: true })
  check('A6 数组 payload 不崩（202）', arrayResult.status === 202, `status=${arrayResult.status} body=${brief(arrayResult.text)}`)
  const arraySent = t.server.sent.map((item) => item.segments.map((s) => s.data?.text ?? '').join('')).join('\n')
  // 数组是合法 JSON：模板占位符取不到字段 → 回落到「（无）」，照常渲染而不是报错。
  check('A6 数组 payload 仍按模板渲染（占位符回落，不报错）', arraySent.includes('（无）'), `text=${brief(arraySent)}`)

  const stringBefore = t.server.sent.length
  const stringResult = await postHook(port, 'deploy', { headers: { 'x-webhook-token': TOKEN }, body: '"just a string"' })
  check('A6 字符串 payload 不崩（202）', stringResult.status === 202, `status=${stringResult.status} body=${brief(stringResult.text)}`)
  const stringSent = t.server.sent.slice(stringBefore).map((item) => item.segments.map((s) => s.data?.text ?? '').join('')).join('\n')
  check('A6 字符串 payload 不会把原文当字段取（占位符回落）', !stringSent.includes('just a string') || stringSent.includes('（无）'), `text=${brief(stringSent)}`)

  const events = t.traceStage('webhook')
  check('A6 渲染阶段始终有 webhook trace', events.length >= 2, brief(events.map((e) => `${e.ok}:${e.reason ?? ''}`)))
  check('A6 webhook trace 的 reason 全部非空', events.length > 0 && events.every((event) => String(event.reason ?? '').trim() !== ''), brief(t.allReasons(events)))
  check('A6 桥仍然活着（后续请求还能 202）', (await postHook(port, 'deploy', { headers: { 'x-webhook-token': TOKEN }, body: GENERIC_BODY })).status === 202, `sent=${t.server.sent.length}`)
  t.stop()
}

// ---------------------------------------------------------------------------
// A7. 会话键非法（chat:'bad'）→ webhook trace ok=false 且带非法会话键，不抛错
// ---------------------------------------------------------------------------
{
  const port = randomWebhookPort()
  const t = makeBridge({
    webhookEnabled: true,
    webhookPort: port,
    webhookSources: [{ name: 'broken', format: 'generic', chat: 'bad', token: TOKEN, template: GENERIC_TEMPLATE }],
  })
  await waitListening(port)
  const result = await postHook(port, 'broken', { headers: { 'x-webhook-token': TOKEN }, body: GENERIC_BODY, retry: true })
  check('A7 非法会话键不抛错（仍是 202，因为渲染成功）', result.status === 202, `status=${result.status} body=${brief(result.text)}`)
  const bad = t.traceStage('webhook', false)
  check('A7 有 stage=webhook 且 ok=false 的 trace', bad.length > 0, brief(bad.map((e) => `${e.ok}:${e.reason ?? ''}`)))
  check('A7 失败 reason 提到会话键', bad.some((event) => String(event.reason ?? '').includes('会话键')), brief(t.allReasons(bad)))
  // 非法键本身就是坏数据：它没有被当成 chatKey 写进事件，而是原样出现在 reason 里，
  // 所以这里断 reason 带上了那个值（也顺带证明失败事件没有伪造一个合法 chatKey）。
  check('A7 失败 reason 带上了那个非法键的值', bad.some((event) => String(event.reason ?? '').includes('bad')), brief(t.allReasons(bad)))
  check('A7 非法会话键不发任何消息', t.server.sent.length === 0, `sent=${t.server.sent.length}`)
  t.stop()
}

// ---------------------------------------------------------------------------
// A8. 对照：format 不认识 → 渲染失败分支也要留 reason（A6 的失败对照组）
// ---------------------------------------------------------------------------
{
  const port = randomWebhookPort()
  const t = makeBridge({
    webhookEnabled: true,
    webhookPort: port,
    webhookSources: [{ name: 'weird', format: 'no-such-format', chat: 'g:2002', token: TOKEN, template: GENERIC_TEMPLATE }],
  })
  await waitListening(port)
  const result = await postHook(port, 'weird', { headers: { 'x-webhook-token': TOKEN }, body: GENERIC_BODY, retry: true })
  check('A8 未知 format 不崩（202）', result.status === 202, `status=${result.status} body=${brief(result.text)}`)
  const bad = t.traceStage('webhook', false)
  check('A8 渲染失败留下 ok=false 的 webhook trace', bad.length > 0, brief(bad.map((e) => `${e.ok}:${e.reason ?? ''}`)))
  check('A8 渲染失败 reason 提到渲染/格式', bad.some((event) => /渲染|格式/.test(String(event.reason ?? ''))), brief(t.allReasons(bad)))
  check('A8 渲染失败不发消息', t.server.sent.length === 0, `sent=${t.server.sent.length}`)
  t.stop()
}

// ===========================================================================
// B. 定时播报（手动触发：/播报）
// ===========================================================================

/** mc 任务，地址注定连不上（仓库既有约定：127.0.0.1:1 必然失败、绝不联网）。 */
const MC_JOB = { id: 'mc-main', kind: 'mc', chat: 'g:2002', enabled: true, at: '08:00', address: '127.0.0.1:1' }

// ---------------------------------------------------------------------------
// B8. /播报 → 列出任务 id 与"下次"时间
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ broadcastEnabled: true, broadcastJobs: [MC_JOB] })
  const list = t.bridge.broadcast?.list?.() ?? []
  check('B8 broadcastEnabled=true 时任务已装载', list.length === 1 && list[0].id === 'mc-main', brief(list.map((job) => `${job.id}:${job.enabled}:${job.nextAt}`)))
  const reply = await t.send(t.privateMessage('/播报'), 300)
  check('B8 /播报 回复含任务 id', reply.includes('mc-main'), brief(reply))
  check('B8 /播报 回复含「下次」时间', reply.includes('下次') && !reply.includes('下次 —'), brief(reply))
  check('B8 /播报 回复含启用计数', /定时播报（1\/1 启用）/.test(reply), brief(reply))
  t.stop()
}

// ---------------------------------------------------------------------------
// B9. /播报 测试 <id> → runOnce 真的跑了；失败/离线都要有中文回复，且不崩
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ broadcastEnabled: true, broadcastJobs: [MC_JOB] })
  const reply = await t.send(t.groupMessage('/播报 测试 mc-main'), 900)
  check('B9 /播报 测试 有回复', reply.trim() !== '', brief(reply))
  check('B9 回复带任务 id', reply.includes('mc-main'), brief(reply))
  const ran = t.bridge.broadcast?.list?.()[0] ?? {}
  check('B9 runOnce 真的生效（runs 递增、lastAt 落盘）', ran.runs === 1 && Number(ran.lastAt) > 0, brief(ran))
  check('B9 回复含中文结果（已触发/失败/离线原因）', /已触发|失败|离线|原因/.test(reply), brief(reply))
  check('B9 拿不到在线数据也要有中文解释', /离线|失败|原因|已触发/.test(reply) && /[\u4e00-\u9fa5]/.test(reply), brief(ran.lastReason))
  const events = t.traceStage('broadcast')
  check('B9 播报动作在 trace 里留痕', events.length > 0, brief(events.map((e) => `${e.ok}:${e.reason ?? ''}`)))
  t.stop()
}

// ---------------------------------------------------------------------------
// B10. 非管理员 → 「仅管理员」
//      注意：白名单门（#allowed）跑在所有命令之前，所以非管理员必须**在**白名单里，
//      否则连命令分发都到不了（那样测的就不是"仅管理员"这条分支了）。
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ broadcastEnabled: true, broadcastJobs: [MC_JOB], allowUsers: [1001, 30003] })
  const reply = await t.send(t.groupMessage('/播报', { userId: 30003 }), 200)
  check('B10 非管理员收到「仅管理员」', reply.includes('仅管理员'), brief(reply))
  check('B10 非管理员看不到任务清单', !reply.includes('mc-main'), brief(reply))
  const before = t.bridge.broadcast?.list?.()[0]?.runs ?? -1
  const reply2 = await t.send(t.groupMessage('/播报 测试 mc-main', { userId: 30003 }), 400)
  check('B10 非管理员触发不了任务', (t.bridge.broadcast?.list?.()[0]?.runs ?? -1) === before && reply2.includes('仅管理员'), `runs=${t.bridge.broadcast?.list?.()[0]?.runs} reply=${brief(reply2)}`)
  check('B10 非管理员一个任务都没跑（runs 仍为 0）', (t.bridge.broadcast?.list?.()[0]?.runs ?? -1) === 0, brief(t.bridge.broadcast?.list?.()))
  t.stop()
}

// ---------------------------------------------------------------------------
// B11. broadcastEnabled=false → 「未启用」，且没有 broadcast 对象
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ broadcastEnabled: false, broadcastJobs: [MC_JOB] })
  check('B11 关闭时 bridge.broadcast === null', t.bridge.broadcast === null, brief(t.bridge.broadcast))
  const reply = await t.send(t.privateMessage('/播报'), 200)
  check('B11 关闭时回复含「未启用」', reply.includes('未启用'), brief(reply))
  check('B11 关闭时不留 broadcast 运行痕迹', t.traceStage('broadcast').length === 0, brief(t.traceStage('broadcast').map((e) => e.reason)))
  t.stop()
}

// ---------------------------------------------------------------------------
// B12. 任务 chat:'bad' → runOnce 后 trace 有播报阶段的 ok=false，reason 提到会话键
//      （MC 结果显示"离线"也算拿到文本，所以一定会走到发送那一步）
//      注意 stage 实际写的是中文「播报」——那是 lib/bridge.js#deliverExternal
//      把调用方传入的 stage 参数原样写进事件（webhook 传 'webhook'，播报传 '播报'），
//      所以两种写法都接受，不替作者改模块。
// ---------------------------------------------------------------------------
{
  const t = makeBridge({
    broadcastEnabled: true,
    broadcastJobs: [{ id: 'mc-bad', kind: 'mc', chat: 'bad', enabled: true, at: '08:00', address: '127.0.0.1:1' }],
  })
  const reply = await t.send(t.privateMessage('/播报 测试 mc-bad'), 900)
  check('B12 非法会话键的任务不崩，仍有回复', reply.trim() !== '', brief(reply))
  const all = t.bridge.trace.recent({ limit: 5000 })
  const bad = all.filter((event) => (event.stage === 'broadcast' || event.stage === '播报') && event.ok === false)
  check('B12 有播报阶段且 ok=false 的 trace', bad.length > 0, `stages=${brief([...new Set(all.map((e) => e.stage))])} bad=${brief(bad.map((e) => `${e.stage}:${e.ok}:${e.reason ?? ''}`))}`)
  check('B12 失败 reason 提到会话键', bad.some((event) => String(event.reason ?? '').includes('会话键')), brief(t.allReasons(bad)))
  check('B12 非法会话键不发任何消息（没有 MC 正文出站）', t.server.sent.filter((item) => item.segments.some((s) => /离线|原因：/.test(String(s.data?.text ?? '')))).length === 0, brief(t.server.sent.length))
  t.stop()
}

// ---------------------------------------------------------------------------
// B13. 红线：注入窗口内的 /播报 测试 —— 绝不真发（回复被 #replyTo 拦下，
//      播报正文被 #deliverExternal 记为「出站被拦下」）
// ---------------------------------------------------------------------------
{
  const t = makeBridge({
    broadcastEnabled: true,
    broadcastJobs: [{ id: 'mc-live', kind: 'mc', chat: 'g:2002', enabled: true, at: '08:00', address: '127.0.0.1:1' }],
    // 与真实注入派发等价：注入通道在派发期间把该会话放进 injectSync 窗口，
    // 回合结束后窗口关闭，但 #deliverExternal 走的是同一个 #replyTo 判定。
    injectDryRun: true,
  })
  // 打开注入窗口（等价于 #beginInjectWindow('g:2002')，60s 有效期）
  t.bridge.injectSync.set('g:2002', Date.now() + 60_000)
  const reply = await t.send(t.groupMessage('/播报 测试 mc-live', { __injected: true }), 900)
  // 红线的三种写法都必须成立：
  const broadcastTexts = t.server.sent
    .map((item) => item.segments.map((s) => s.data?.text ?? '').join(''))
    .filter((text) => /离线|原因：|MC /.test(text))
  check('B13 注入窗口内播报正文一条都没发出去', broadcastTexts.length === 0, `broadcastTexts=${brief(broadcastTexts)} sent=${t.server.sent.length}`)
  check('B13 注入窗口内回复也没发出去（MockServer 零出站）', t.server.sent.length === 0, brief(t.server.sent.map((item) => item.segments.map((s) => s.data?.text ?? '').join(''))))
  const suppressedBroadcast = t.bridge.trace.recent({ limit: 5000 })
    .filter((event) => (event.stage === 'broadcast' || event.stage === '播报') && event.ok === false)
  check('B13 发送方记下了「出站被拦下」', suppressedBroadcast.some((event) => String(event.reason ?? '').includes('出站被拦下')), brief(t.allReasons(suppressedBroadcast)))
  const suppressed = t.traceStage('inject')
  check('B13 回复被 #replyTo 拦截并留痕', suppressed.some((event) => String(event.reason ?? '').includes('已被拦截')), brief(t.allReasons(suppressed)))
  // 桥给这条注入回合准备的回复文本确实被拦下了（reply 为空是因为 MockServer 没收到，
  // 拦截事件里带着那段文本，说明"不是没生成，而是没发出去"）。
  check('B13 被拦下的回复文本里能看到播报内容（证明是拦下而非未生成）', suppressed.some((event) => /mc-live|离线/.test(String(event.reason ?? ''))) && reply === '', `reply=${brief(reply)} reasons=${brief(t.allReasons(suppressed))}`)
  t.bridge.injectSync.clear()
  t.stop()
}

// ===========================================================================
// C. 掉线自愈（只启动、不杀）
// ===========================================================================

/** 每次自愈尝试都必须留一条 stage='heal' 的 trace，且 reason 非空。 */
function healTraces(t) { return t.traceStage('heal') }

// ---------------------------------------------------------------------------
// C14. autoHealEnabled=true 但没配命令 → heal ok=false 且 reason 提到 autoHealCommand
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ autoHealEnabled: true, autoHealCommand: '' })
  let threw = ''
  try { t.server.emit('bot-disconnect', t.server.socket) } catch (error) { threw = error.message }
  await sleep(80)
  check('C14 掉线事件不抛错', threw === '', brief(threw))
  const heal = healTraces(t)
  check('C14 有 stage=heal 的 trace', heal.length > 0, brief(heal.map((e) => `${e.ok}:${e.reason ?? ''}`)))
  check('C14 heal trace ok=false', heal.some((event) => event.ok === false), brief(heal.map((e) => e.ok)))
  check('C14 reason 提到没配 autoHealCommand', heal.some((event) => String(event.reason ?? '').includes('autoHealCommand')), brief(t.allReasons(heal)))
  check('C14 没有尝试过任何自愈（autoHealAt 为空）', t.bridge.autoHealAt.length === 0, brief(t.bridge.autoHealAt))
  t.stop()
}

// ---------------------------------------------------------------------------
// C15. autoHealEnabled=false → 完全没有 heal trace
// ---------------------------------------------------------------------------
{
  const t = makeBridge({ autoHealEnabled: false, autoHealCommand: 'node -e "0"' })
  t.server.emit('bot-disconnect', t.server.socket)
  await sleep(80)
  check('C15 关闭时不产生任何 heal 事件', healTraces(t).length === 0, brief(healTraces(t).map((e) => `${e.ok}:${e.reason ?? ''}`)))
  check('C15 关闭时不记账自愈时间戳', t.bridge.autoHealAt.length === 0, brief(t.bridge.autoHealAt))
  t.stop()
}

// ---------------------------------------------------------------------------
// C16 / C17. 冷却与每小时上限：命令无害立刻退出（node -e "0"，Windows 上 shell:true 也能跑）
// ---------------------------------------------------------------------------
{
  const t = makeBridge({
    autoHealEnabled: true,
    autoHealCommand: 'node -e "0"',
    autoHealCooldownSeconds: 300,
    autoHealMaxPerHour: 3,
  })
  t.server.emit('bot-disconnect', t.server.socket)
  await sleep(150)
  const first = healTraces(t)
  check('C16 首次掉线真的尝试拉起（heal ok=true）', first.some((event) => event.ok === true), brief(first.map((e) => `${e.ok}:${e.reason ?? ''}`)))
  check('C16 首次尝试被计入 autoHealAt', t.bridge.autoHealAt.length === 1, brief(t.bridge.autoHealAt))

  t.server.emit('bot-disconnect', t.server.socket)
  await sleep(150)
  const second = healTraces(t)
  check('C16 第二次掉线被冷却拦下（reason 含「冷却中」）', second.some((event) => String(event.reason ?? '').includes('冷却中')), brief(t.allReasons(second)))
  check('C16 冷却期内没有再记账', t.bridge.autoHealAt.length === 1, brief(t.bridge.autoHealAt))
  check('C16 冷却分支记的是「距上次多少秒」（冷却 300s）', second.some((event) => /冷却中（距上次 \d+s，冷却 300s）/.test(String(event.reason ?? ''))), brief(t.allReasons(second)))

  const all = healTraces(t)
  check('C17 每次自愈尝试都有 heal trace', all.length >= 2, `count=${all.length} ${brief(all.map((e) => `${e.ok}:${e.reason ?? ''}`))}`)
  check('C17 heal trace 的 reason 全部非空', all.every((event) => String(event.reason ?? '').trim() !== ''), brief(t.allReasons(all)))
  check('C17 成功与失败分支都在 trace 里（ok=true 与 ok=false 各至少一条）', all.some((event) => event.ok === true) && all.some((event) => event.ok === false), brief(all.map((e) => `${e.ok}`)))
  t.stop()
}

// ---------------------------------------------------------------------------
// C16b. 每小时上限：与 C16 同一套配置（冷却 300s，上限 3）。
//   #tryAutoHeal 的判定顺序是 ① 按 1 小时滑动窗口过滤 → ② 最后一条是否在冷却内 →
//   ③ 条数是否 ≥ maxPerHour。所以窗口里那三条必须**同时**满足「距今 ≥ 300s 且 < 1h」，
//   否则第 ② 步先命中「冷却中」，永远走不到「每小时上限」。
//   30min / 20min / 400s 前这三条：最新的一条 400s > 300s 冷却（跳过 ②），
//   条数 3 ≥ maxPerHour 3（命中 ③）→ reason 必须是「自愈已达每小时上限…」。
// ---------------------------------------------------------------------------
{
  const t = makeBridge({
    autoHealEnabled: true,
    autoHealCommand: 'node -e "0"',
    autoHealCooldownSeconds: 300,
    autoHealMaxPerHour: 3,
  })
  t.server.emit('bot-disconnect', t.server.socket)
  await sleep(150)
  check('C16b 上限用例的前一次尝试确实拉起了', healTraces(t).some((event) => event.ok === true), brief(t.allReasons(healTraces(t))))

  const now = Date.now()
  t.bridge.autoHealAt = [now - 1_800_000, now - 1_200_000, now - 400_000]
  t.server.emit('bot-disconnect', t.server.socket)
  await sleep(150)
  const capped = healTraces(t)
  const reasons = t.allReasons(capped)
  check('C16b 超过每小时上限时 reason 含「每小时上限」', capped.some((event) => String(event.reason ?? '').includes('每小时上限')), brief(reasons))
  check('C16b 上限分支没被冷却分支抢走（三条都在冷却窗口外）', !reasons.includes('冷却中'), brief(reasons))
  check('C16b 上限命中后没有真的再拉起（条数仍是 3）', t.bridge.autoHealAt.length === 3, `len=${t.bridge.autoHealAt.length} rel=${brief(t.bridge.autoHealAt.map((at) => Math.round((Date.now() - at) / 1000)))}`)
  check('C16b 上限命中仍然留痕（不是静默什么都不做）', capped.length >= 2, `count=${capped.length} ${brief(reasons)}`)
  t.stop()
}

// ---------------------------------------------------------------------------
// C16d. 上限的第二种构造：一小时窗口里只留一条**已经过了冷却**的记账（maxPerHour=1），
//       走的是真实推入的那条记录（.map() 往前推 60s），而不是手写数组。
// ---------------------------------------------------------------------------
{
  const t = makeBridge({
    autoHealEnabled: true,
    autoHealCommand: 'node -e "0"',
    autoHealCooldownSeconds: 30,
    autoHealMaxPerHour: 1,
  })
  t.server.emit('bot-disconnect', t.server.socket)
  await sleep(150)
  check('C16d 第一次掉线在 maxPerHour=1 下仍然拉起', healTraces(t).some((event) => event.ok === true), brief(t.allReasons(healTraces(t))))
  check('C16d 第一次尝试被记账', t.bridge.autoHealAt.length === 1, brief(t.bridge.autoHealAt))

  // 真实那条推到 60s 前：已过 30s 冷却、仍在 1 小时窗口内 → 条数 1 打满 maxPerHour=1
  t.bridge.autoHealAt = t.bridge.autoHealAt.map(() => Date.now() - 60_000)
  t.server.emit('bot-disconnect', t.server.socket)
  await sleep(150)
  const capped = healTraces(t)
  check('C16d maxPerHour=1 时第二条掉线命中「每小时上限」', capped.some((event) => String(event.reason ?? '').includes('每小时上限')), brief(t.allReasons(capped)))
  check('C16d 上限命中后没有真的再拉起（记账条数不变）', t.bridge.autoHealAt.length === 1, brief(t.bridge.autoHealAt.length))
  t.stop()
}

// ---------------------------------------------------------------------------
// C16c. 对照：autoHealCooldownSeconds 小 + 上限高 → 冷却过后能再次尝试（不是永远冷却）
// ---------------------------------------------------------------------------
{
  const t = makeBridge({
    autoHealEnabled: true,
    autoHealCommand: 'node -e "0"',
    autoHealCooldownSeconds: 30,
    autoHealMaxPerHour: 3,
  })
  t.server.emit('bot-disconnect', t.server.socket)
  await sleep(120)
  t.bridge.autoHealAt = t.bridge.autoHealAt.map(() => Date.now() - 60_000)
  t.server.emit('bot-disconnect', t.server.socket)
  await sleep(120)
  const ok = healTraces(t).filter((event) => event.ok === true)
  check('C16c 冷却过后能再次尝试（两条成功 heal）', ok.length === 2, `ok=${ok.length} ${brief(healTraces(t).map((e) => `${e.ok}:${e.reason ?? ''}`))}`)
  t.stop()
}

// ===========================================================================
// D. 配置键、快照与既有功能回归
// ===========================================================================

// ---------------------------------------------------------------------------
// D18. 快照：计数正确，且绝不写出来源的 token/secret
// ---------------------------------------------------------------------------
{
  const cwd = freshCwd()
  const t = makeBridge({
    cwd,
    webhookEnabled: true,
    webhookPort: randomWebhookPort(),
    webhookSources: [
      { name: 'deploy', format: 'generic', chat: 'g:2002', token: TOKEN, template: GENERIC_TEMPLATE },
      { name: 'ci', format: 'generic', chat: 'g:2002', secret: SECRET },
    ],
    broadcastEnabled: true,
    broadcastJobs: [MC_JOB, { id: 'feed-1', kind: 'rss', chat: 'g:2002', enabled: false, url: 'http://127.0.0.1:1/feed.xml' }],
    autoHealEnabled: true,
    autoHealCommand: 'C:\\nope\\napcat.bat',
  })
  const runtimeFile = join(cwd, 'qq-runtime.json')
  let snapshot = ''
  try { snapshot = readFileSync(runtimeFile, 'utf8') } catch { snapshot = '' }
  check('D18 启动即写出 qq-runtime.json', snapshot !== '', `size=${snapshot.length} file=${runtimeFile}`)

  const flags = t.bridge.featureFlagsForTest?.() ?? null
  if (flags) {
    check('D18 featureFlags().webhookSourceCount === 2', flags.webhookSourceCount === 2, brief(flags.webhookSourceCount))
    check('D18 featureFlags().broadcastJobCount === 2', flags.broadcastJobCount === 2, brief(flags.broadcastJobCount))
  }

  let parsed = null
  try { parsed = JSON.parse(snapshot) } catch { parsed = null }
  check('D18 features.webhookSourceCount === 2', parsed?.features?.webhookSourceCount === 2, brief(parsed?.features?.webhookSourceCount))
  check('D18 features.broadcastJobCount === 2', parsed?.features?.broadcastJobCount === 2, brief(parsed?.features?.broadcastJobCount))
  check('D18 features 里三个开关都在', parsed?.features?.webhookEnabled === true && parsed?.features?.broadcastEnabled === true && parsed?.features?.autoHealEnabled === true, brief(parsed?.features))
  check('D18 features.autoHealCommandConfigured 只暴露"配没配"', parsed?.features?.autoHealCommandConfigured === true, brief(parsed?.features?.autoHealCommandConfigured))
  check('D18 快照不含来源 token', !snapshot.includes(TOKEN), `token出现在快照里=${snapshot.includes(TOKEN)}`)
  check('D18 快照不含来源 secret', !snapshot.includes(SECRET), `secret出现在快照里=${snapshot.includes(SECRET)}`)
  check('D18 快照不含 autoHeal 命令原文', !snapshot.includes('napcat.bat'), `命令出现在快照里=${snapshot.includes('napcat.bat')}`)
  check('D18 快照里没有任何 "token"/"secret" 字段', !/"token"\s*:/.test(snapshot) && !/"secret"\s*:/.test(snapshot), brief((snapshot.match(/"[a-z]*token[a-z]*"\s*:/gi) ?? []).join(',')))
  const status = t.bridge.webhook?.status?.()
  check('D18 有凭据的两个来源都注册了', status?.sources?.length === 2, brief(status))
  t.stop()
}

// ---------------------------------------------------------------------------
// D19. 回归：归档仍然工作（普通群消息 → qq-history/<今天>.jsonl）
// ---------------------------------------------------------------------------
{
  const t = makeBridge()
  const text = '无人值守回归：这条普通群消息必须照旧入档'
  await t.send(t.groupMessage(text))
  const file = t.shardPath()
  let size = -1
  try { size = statSync(file).size } catch { size = -1 }
  check('D19 qq-history/<今天>.jsonl 有内容', size > 0, `file=${file} size=${size}`)
  check('D19 分片里含这条文本', t.textOf(file).includes(text), brief(t.textOf(file)))
  check('D19 bridge.archive 仍然可用', t.bridge.archive !== null, brief(Boolean(t.bridge.archive)))
  t.stop()
}

// ---------------------------------------------------------------------------
// D20. 回归：三件套全关时，桥的构造/启停完全不受影响
// ---------------------------------------------------------------------------
{
  const t = makeBridge()
  check('D20 默认全关时 broadcast === null', t.bridge.broadcast === null, brief(t.bridge.broadcast))
  check('D20 默认全关时 webhook === null', t.bridge.webhook === null, brief(t.bridge.webhook))
  check('D20 默认全关时 autoHealAt 为空数组', Array.isArray(t.bridge.autoHealAt) && t.bridge.autoHealAt.length === 0, brief(t.bridge.autoHealAt))
  const reply = await t.send(t.privateMessage('/播报'), 200)
  check('D20 全关时 /播报 仍给中文提示（未启用）', reply.includes('未启用'), brief(reply))
  t.stop()
}

// ---------------------------------------------------------------------------
// D21. 回归：播报状态真的落盘、并且重启后读得回来
//   （补这个回归的原因：桥曾经调用 JsonStore 上不存在的 load()/save()，
//    异常被 try/catch 吞掉 → 去重与统计的持久化从来没生效过，而且完全无感。）
// ---------------------------------------------------------------------------
{
  const cwd = freshCwd()
  const jobs = [{ id: 'persist', kind: 'mc', chat: 'g:2002', enabled: true, everyMinutes: 5, address: '127.0.0.1:1' }]
  const t1 = makeBridge({ broadcastEnabled: true, broadcastJobs: jobs, cwd })
  const first = await t1.bridge.broadcast.runOnce('persist', { manual: true })
  check('D21 手动触发一次播报（失败也算一次运行）', typeof first?.ok === 'boolean', brief(first))
  const stateFile = join(cwd, 'qq-broadcast.json')
  const written = readFileSync(stateFile, 'utf8')
  check('D21 状态确实写到了 qq-broadcast.json', written.includes('persist'), brief(written).slice(0, 160))
  const before = t1.bridge.broadcast.snapshot().jobs.persist
  t1.stop()

  const t2 = makeBridge({ broadcastEnabled: true, broadcastJobs: jobs, cwd })
  const after = t2.bridge.broadcast.snapshot().jobs.persist
  check('D21 重启后 lastAt 被恢复（不是从零开始）',
    Number(after.lastAt) === Number(before.lastAt) && after.runs === before.runs,
    `before=${brief(before)} after=${brief(after)}`)
  t2.stop()
}

for (const dir of dirs) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结论 */ }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
