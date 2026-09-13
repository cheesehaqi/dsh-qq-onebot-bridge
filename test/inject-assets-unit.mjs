/**
 * 注入安全回归防线（v0.5 新增命令 / 工具）。
 *
 * 为什么单独一个套件：桥的注入保护是"作用域 dry-run"——`OneBotServer#inDryRunScope`
 * 只在调用参数里带匹配的 `group_id` / `user_id` 时才拦截。所以**每一个新的出站调用**
 * 都必须被逐个验证参数形状落在拦截条件内；一旦某个新命令的参数不带会话键（或带了别的
 * 会话的键），注入回合就会真的打到 QQ。历史上一旦漏一处，后果是真发消息给真人。
 *
 * 做法：起**真实** OneBotServer（真 WebSocket、真 JSON 帧）+ 一个真客户端记录所有帧，
 * 用 `setDryRun(true, {groupId, userId})` 复现 `#handleInjection` 的同步窗口，然后：
 *   A. 注入帧跑一遍新命令 → 断言客户端**一个出站帧都没收到**，且回复里说明真实原因；
 *   B. 正对照（不开 dry-run）→ 断言同样的命令**确实**把帧发出去（证明 A 不是空测试）。
 * 反面：任何"什么都不做"的实现也能过 A，所以 B 是必需的。
 */
import { once } from 'node:events'
import { createServer } from 'node:http'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { OneBotServer } from '../lib/onebot.js'
import { QQBridge } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// 本地文件服务器：正对照要走完"下载 → 发私聊"全流程，URL 必须真的可下载
const fileServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/octet-stream' })
  response.end('hello')
})
await new Promise((resolve) => fileServer.listen(0, '127.0.0.1', resolve))
const FILE_URL = `http://127.0.0.1:${fileServer.address().port}/a.zip`

const PORT = 16800 + Math.floor(Math.random() * 90)
const dir = mkdtempSync(join(tmpdir(), 'qq-inject-assets-'))
const logger = { info() {}, warn() {}, error() {} }
const server = new OneBotServer({ host: '127.0.0.1', port: PORT, accessToken: '', botQq: 999 }, logger)

const config = {
  cwd: dir, host: '127.0.0.1', port: 0, accessToken: '', botQq: 999, botName: '测试',
  allowUsers: [1001], allowGroups: [2002], replyOnlyWhenMentioned: true, acceptPrivate: true,
  sessionMode: 'chat', maxMessageLength: 1700, dedupEnabled: true, dedupWindowSeconds: 300,
  adminEnabled: true, adminUsers: [1001], leaveGroupEnabled: true,
  quietHoursEnabled: false, traceEnabled: true, traceLevel: 'debug',
  recordInbound: false, sessionResumeEnabled: false, memoryEnabled: false,
  groupFileEnabled: true, groupFileDownloadEnabled: true, groupFileListLimit: 20, groupFileMaxBytes: 52428800,
  historySearchEnabled: true, historyArchiveEnabled: true, historySearchDays: 7, historySearchLimit: 20,
  ocrEnabled: true, ocrMaxImages: 3, albumEnabled: true, memberQueryEnabled: true, reactToolEnabled: true,
  actionAuditEnabled: false, actionRatePerMinute: 100, actionRatePerDay: 1000,
  // 走真实注入通道：桥自己轮询注入文件并切换 dry-run 与闸门
  injectEnabled: true, injectDryRun: true, injectIntervalMs: 500,
  injectFile: join(dir, 'qq-inject.jsonl'),
}

const ctx = {
  on: () => () => {},
  get: () => undefined,
  agents: { create: async () => { throw new Error('这些命令都不该创建 agent 会话') } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  logger: () => logger,
}

await server.start()
const client = new WebSocket(`ws://127.0.0.1:${PORT}`)
await once(client, 'open')
await new Promise((resolve) => setTimeout(resolve, 60))

const frames = []
const READS = new Set(['get_group_root_files', 'get_group_file_url', 'get_group_member_list', 'get_group_member_info', 'get_group_info', 'get_qun_album_list', 'get_msg'])
client.on('message', (raw) => {
  let frame = null
  try { frame = JSON.parse(String(raw)) } catch { return }
  if (!frame || frame.action === undefined) return
  frames.push(frame)
  const data = frame.action === 'get_group_root_files'
    ? { files: [{ file_id: 'f1', file_name: 'a.zip', file_size: 5, busid: 1, upload_time: 1700000000 }], folders: [] }
    : frame.action === 'get_group_file_url'
      ? { url: FILE_URL }
      : frame.action === 'get_group_member_list'
        ? [{ user_id: 1001, nickname: '小明', card: '', role: 'owner', level: '3' }]
        : frame.action === 'get_group_info'
          ? { group_id: 2002, group_name: '测试群', member_count: 1, max_member_count: 200 }
          : frame.action === 'get_qun_album_list'
            ? { album_list: [{ album_id: '1', album_name: '活动', photo_count: 2 }] }
            : { message_id: 1 }
  client.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }))
})

const bridge = new QQBridge(ctx, config, server, logger)
bridge.start()

let seq = 0
const frame = (text, extra = {}) => ({
  bot: server.currentSocket(), userId: 1001, messageType: 'group', groupId: 2002, text,
  atMe: true, ats: [], reply: null, records: [], images: [], files: [], forwards: [],
  messageId: `safety-${++seq}`, senderName: '小明', raw: { message: [] }, ...extra,
})

/** 走**真实注入通道**：往注入文件追加一行，让桥的轮询器自己消费（含 dry-run 与闸门切换）。 */
async function runInjected(spec) {
  frames.length = 0
  const seenBefore = bridge.trace.recent({ limit: 600 }).filter((event) => event.stage === 'inbound').length
  const line = JSON.stringify({ kind: 'message', userId: 1001, groupId: 2002, atMe: true, ...spec })
  appendFileSync(config.injectFile, `${line}\n`)
  await new Promise((resolve) => setTimeout(resolve, 1600))
  const outbound = frames.filter((item) => !READS.has(item.action))
  const events = bridge.trace.recent({ limit: 600 })
  const seenAfter = events.filter((event) => event.stage === 'inbound').length
  // 回复在真实注入路径里是**在桥层**被拦下的（`#replyTo` 先查注入判定，不经过 #call），
  // 所以"会说什么"要看这条 trace，而不是 dry-run 调用列表。
  const suppressed = events
    .filter((event) => event.stage === 'inject' && typeof event.reason === 'string' && event.reason.startsWith('注入回合的回复已被拦截'))
    .pop()
  const dispatched = events.some((event) => event.stage === 'command' && (event.ms ?? 0) >= 0)
  return { outbound, reply: String(suppressed?.reason ?? ''), processed: seenAfter > seenBefore, dispatched }
}

// ---- A. 注入回合（真实注入通道）：新命令一个出站帧都不许漏 ----
const cases = [
  { spec: { text: '/文件' }, name: '/文件 列表' },
  { spec: { text: '/成员' }, name: '/成员 名单' },
  { spec: { text: '/群信息' }, name: '/群信息' },
  { spec: { text: '/相册' }, name: '/相册' },
  { spec: { text: '/取 a.zip' }, name: '/取（会下载文件并私聊发送）' },
  { spec: { text: '/ocr', images: [FILE_URL] }, name: '/ocr（ocr_image 参数不带会话键，必须显式判离线）' },
  { spec: { text: '/退群 确认' }, name: '/退群（写操作）' },
]
for (const item of cases) {
  const result = await runInjected(item.spec)
  check(`A 注入回合确实被处理：${item.name}`, result.processed === true, `processed=${result.processed}`)
  check(`A 注入回合不出站：${item.name}`, result.outbound.length === 0, JSON.stringify(result.outbound.map((f) => f.action)))
  check(`A 注入回合理由诚实：${item.name}`, result.reply.includes('回放/注入'), result.reply.slice(0, 90))
}
const afterA = frames.filter((item) => !READS.has(item.action))
check('A 汇总：整轮注入没有一条出站帧到达 OneBot', afterA.length === 0, JSON.stringify(afterA.map((f) => f.action)))

// ---- B. 正对照：同一批命令在非 dry-run 下必须真的发出去 ----
const positive = [
  { text: '/取 a.zip', action: 'upload_private_file' },
  { text: '/文件', action: 'send_group_msg' },
  { text: '/成员', action: 'send_group_msg' },
  { text: '/相册', action: 'send_group_msg' },
  { text: '/ocr', action: 'ocr_image' },
  { text: '/退群 确认', action: 'set_group_leave' },
]
for (const item of positive) {
  frames.length = 0
  server.emit('message', frame(item.text, item.text === '/ocr' ? { images: [{ kind: 'image', url: FILE_URL, file: '' }] } : {}))
  await new Promise((resolve) => setTimeout(resolve, 900))
  const actions = frames.map((f) => f.action)
  check(`B 正对照真的发出：${item.text} → ${item.action}`, actions.includes(item.action), JSON.stringify(actions))
}

bridge.stop()
await server.stop()
try { client.close() } catch { /* 关闭失败不影响判定 */ }
try { fileServer.close() } catch { /* 同上 */ }
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
