/**
 * Live acceptance for stage 3 (录制 / 离线回放 / 事件注入) against a RUNNING host.
 *
 * 前提：宿主已启动（3080 + 6700 监听）、控制台已启动（8799），QQ 不需要真的在线——
 * 本脚本自己扮演 OneBot 客户端连到 6700。
 *
 * 验证链：
 *   ① 真实消息 → 桥按生产配置回复，并落盘到 qq-inbox.jsonl；
 *   ② 控制台 /api/inbox 能看到这条录制；
 *   ③ 控制台 /api/replay 会用运行时快照里的真实白名单离线重跑，结论与线上一致；
 *   ④ 控制台 /api/inject 入队后桥在 2s 内消费，dry-run 拦下全部出站（假客户端收不到）；
 *   ⑤ 注入的帧不会被二次录制（否则回放会自激）。
 *
 * Usage: node test/replay-live-host.mjs --token <control token> [--control 8799] [--onebot 6700]
 */
import { WebSocket } from 'ws'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const control = Number(arg('control', '8799'))
const onebotPort = Number(arg('onebot', '6700'))
const token = arg('token', '')
// 真实号从机器本地的 profile 配置现取（仓库里只留占位号）：占位号不在生产白名单里，
// 直接用它们跑真机只会被白名单拦下，看起来像"功能坏了"。
function privateIds() {
  try {
    const text = readFileSync(join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    const pick = (re) => (re.exec(text)?.[1] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    return {
      bot: (/^\s*botQq:\s*(\d+)/m.exec(text)?.[1] ?? ''),
      user: pick(/^\s*allowUsers:\s*\[([^\]]*)\]/m)[0] ?? '',
      group: pick(/^\s*allowGroups:\s*\[([^\]]*)\]/m)[0] ?? '',
    }
  } catch { return { bot: '', user: '', group: '' } }
}
const local = privateIds()
const groupId = Number(arg('group', local.group || '100000001'))
const userId = Number(arg('user', local.user || '2000000001'))
const botQq = Number(arg('bot', local.bot || '3000000001'))
// 线上 cwd 不写死在脚本里：优先 --cwd，其次机器本地的 qq-control.json（gitignored）
const liveCwd = (() => {
  const explicit = arg('cwd', '')
  if (explicit) return explicit
  try { return JSON.parse(readFileSync(new URL('../qq-control.json', import.meta.url), 'utf8')).cwd || process.cwd() } catch { return process.cwd() }
})()
const base = `http://127.0.0.1:${control}`

let passed = 0
let failed = 0
let warned = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
function warn(name, detail = '') {
  warned++
  console.log(`WARN ${name}${detail ? `（${detail}）` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const get = async (path) => (await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`)).json()
const post = async (path, body) => (await fetch(`${base}${path}?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()

if (!token) {
  console.log('缺少 --token（从控制台启动日志或 qq-control.json 里取）')
  process.exit(2)
}

// ---- 0. 控制台新面板已上线 ----
const page = await (await fetch(`${base}/?token=${token}`)).text()
check('控制台已提供录制/回放/注入面板', page.includes('录制 · 回放 · 注入'))
check('面板含注入表单与回放按钮', page.includes('id="injUser"') && page.includes('replayRecent('))
const beforeInbox = await get('/api/inbox?limit=5')
check('GET /api/inbox 可用', beforeInbox.ok === true && typeof beforeInbox.recorded === 'number', `recorded=${beforeInbox.recorded}`)
if (beforeInbox.queued > 0) {
  // 重启"不重放历史注入"这件事，靠启动时留下的痕迹来证明（而不是靠进程内计数，
  // 那个计数只对"刚重启的那一次"有意义）。
  const skipTrace = await get('/api/trace?stage=inject&limit=200')
  const skipEvent = (skipTrace.events ?? []).find((event) => String(event.reason ?? '').includes('本次启动跳过'))
  check('历史注入被明确跳过并留下痕迹（无静默分支）', Boolean(skipEvent), skipEvent?.reason ?? '（trace 里没有跳过记录）')
  check('跳过原因写清了行数与规则', String(skipEvent?.reason ?? '').includes('只处理启动后新增的行'), skipEvent?.reason ?? '')
} else {
  console.log('（注入队列启动时为空，跳过"不重放历史"检查）')
}

// ---- 1. 扮演 OneBot 客户端，发一条真实群消息 ----
const stamp = Date.now()
const messageId = (stamp % 100000) * 10 + 7
const liveText = `回放自检 ${stamp}`
const received = []          // 桥发出来的动作（真实出站）
const replies = []           // 桥真正发给 QQ 的消息文本
const ws = new WebSocket(`ws://127.0.0.1:${onebotPort}/`)
ws.on('message', (data) => {
  let frame
  try { frame = JSON.parse(String(data)) } catch { return }
  if (frame.action) {
    received.push(frame)
    const text = (frame.params?.message ?? []).filter((segment) => segment.type === 'text').map((segment) => segment.data.text).join('')
    if (text) replies.push(text)
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 90000 + received.length }, echo: frame.echo }))
  }
})
await new Promise((resolve, reject) => {
  ws.on('open', resolve)
  ws.on('error', reject)
  setTimeout(() => reject(new Error('连接 6700 超时（宿主没起来？）')), 8000)
})
check('假 OneBot 客户端已连上桥', ws.readyState === WebSocket.OPEN)

ws.send(JSON.stringify({
  post_type: 'message', message_type: 'group', group_id: groupId, user_id: userId, self_id: botQq,
  message_id: messageId, sender: { card: '回放自检' },
  message: `[CQ:at,qq=${botQq},name=小鲸鱼] ${liveText}`,
}))

// 等桥回复（宿主冷启动后第一轮可能很慢，最长等 180s；这段时间也顺便验证"回复确实发生过"）
const replyDeadline = Date.now() + 180000
while (replies.length === 0 && Date.now() < replyDeadline) await sleep(1000)
check('线上消息得到真实回复', replies.length > 0, replies[0]?.slice(0, 60) ?? '（超时）')

// ---- 2. 录制落盘 ----
let recorded = null
const inboxDeadline = Date.now() + 8000
while (recorded === null && Date.now() < inboxDeadline) {
  const inbox = await get('/api/inbox?limit=20')
  recorded = (inbox.entries ?? []).find((item) => String(item.messageId) === String(messageId)) ?? null
  if (recorded === null) await sleep(500)
}
check('桥把收到的消息写进了 qq-inbox.jsonl', recorded !== null, JSON.stringify(recorded ?? {}).slice(0, 120))
check('录制条目带可读描述与序号', Boolean(recorded?.text?.includes(liveText)) && Number.isInteger(recorded?.index), recorded?.text ?? '')
check('录制文件真实存在', existsSync(join(liveCwd, 'qq-inbox.jsonl')))

// ---- 3. 离线回放：结论必须与线上一致 ----
// 用 messageId 精确定位这条消息的 trace，避免误用历史事件
let liveTraceId = ''
const traceDeadline = Date.now() + 15000
while (liveTraceId === '' && Date.now() < traceDeadline) {
  const trace = await get(`/api/trace?chatKey=g:${groupId}&limit=300`)
  const inbound = (trace.events ?? []).find((event) => event.stage === 'inbound' && String(event.data?.messageId) === String(messageId))
  liveTraceId = inbound?.id ?? ''
  if (liveTraceId === '') await sleep(700)
}
check('线上这条消息有端到端 traceId', liveTraceId.startsWith('t-'), liveTraceId || '（没找到）')
const liveChainResponse = liveTraceId ? await get(`/api/trace?traceId=${encodeURIComponent(liveTraceId)}`) : { chain: null }
const liveStages = (liveChainResponse.chain?.events ?? []).filter((event) => event.stage !== 'inbound').map((event) => event.stage)
check('线上确实走到了回复阶段', liveStages.includes('reply'), liveStages.join('>') || '（空链）')

const replayReceivedBefore = received.length
const replay = await post('/api/replay', { indices: [recorded.index] })
check('POST /api/replay 返回报告', replay.ok === true && Boolean(replay.text), JSON.stringify(replay).slice(0, 140))
const replayEntry = replay.report?.results?.[0]
check('回放把这条判成"会回复"', replayEntry?.status === 'replied', replayEntry?.verdict ?? '')
check('回放指出会发送到群', (replayEntry?.calls ?? []).some((call) => call.action.includes('send_group')), JSON.stringify(replayEntry?.calls ?? []))
check('回放采用线上白名单而非默认空值', (replay.report?.hintedKeys ?? []).includes('allowGroups'), `hints=${(replay.report?.hintedKeys ?? []).length}`)
check('回放链路里白名单是放行而非拒绝', (replayEntry?.chain ?? []).some((step) => step.stage === 'whitelist' && step.ok === true), (replayEntry?.chain ?? []).map((s) => `${s.stage}:${s.ok ? 'ok' : 'no'}`).join('>'))
check('回放报告带沙箱路径', typeof replay.report?.sandbox === 'string' && replay.report.sandbox.length > 0)
check('回放安全保证齐全', replay.report?.safety?.dryRun === true && replay.report?.safety?.connectedBots === 0)
check('离线回放没有产生任何 QQ 出站', received.length === replayReceivedBefore, `出站 ${replayReceivedBefore} → ${received.length}`)

// ---- 4. 事件注入：只有 dry-run，绝不发 QQ ----
const injectText = `注入自检 ${stamp}`
const recordedBefore = (await get('/api/inbox?limit=1')).recorded
const injected = await post('/api/inject', { kind: 'message', text: injectText, groupId, userId, atMe: true })
check('POST /api/inject 入队成功', injected.ok === true, JSON.stringify(injected).slice(0, 140))
check('注入回执说明 dry-run 状态', String(injected.reason ?? '').includes('dry-run'), injected.reason ?? '')
check('注入队列文件写入新行', (await get('/api/inbox?limit=1')).queued >= beforeInbox.queued + 1)

let injectEvents = []
const injectDeadline = Date.now() + 15000
// 注意：启动时的"跳过历史注入"也是一条 stage=inject 的事件，但它不是"消费了注入"
const isInjectionRun = (event) => {
  const reason = String(event.reason ?? '')
  return reason.includes('来自注入器') || reason.includes('注入完成') || /^注入 (message|notice|request)/.test(reason)
}
while (injectEvents.length === 0 && Date.now() < injectDeadline) {
  const trace = await get('/api/trace?stage=inject&limit=50')
  injectEvents = (trace.events ?? []).filter(isInjectionRun)
  if (injectEvents.length === 0) await sleep(700)
}
check('桥在轮询间隔内消费了注入', injectEvents.length > 0, `${injectEvents.length} 条注入事件`)
check('注入事件标明来自注入器', injectEvents.some((event) => String(event.reason).includes('来自注入器')), JSON.stringify(injectEvents[0] ?? {}).slice(0, 140))
check('注入结果说明 dry-run 拦截了几次出站', injectEvents.some((event) => String(event.reason).includes('dry-run')), injectEvents.map((event) => event.reason).join(' / ').slice(0, 160))
await sleep(2500)
// 注意：线上那条真实消息的模型回复可能在这期间才到达，所以不能比较"出站总数"，
// 只能比较"有没有任何出站携带注入文本"——这才是 dry-run 该保证的事。
const outboundText = () => received.map((frame) => JSON.stringify(frame.params ?? {})).join('\n')
check('dry-run 拦下注入：没有任何出站携带注入文本', !outboundText().includes(injectText), `出站 ${received.length} 次全部属于真实消息`)
check('注入回执明确标注"未发送"', injectEvents.some((event) => String(event.reason).includes('未发送')), injectEvents.map((event) => event.reason).join(' / ').slice(0, 160))
check('注入内容没有真正发给 QQ', !replies.some((text) => text.includes('注入自检')), replies.slice(-1).join(' | ').slice(0, 100))
check('注入的帧不会被二次录制', (await get('/api/inbox?limit=1')).recorded === recordedBefore, `录制 ${recordedBefore} → ${(await get('/api/inbox?limit=1')).recorded}`)

// ---- 4b. 注入触发的**异步 agent 回合**也必须被拦下（真机抓到过漏网） ----
const isSuppression = (event) => String(event.reason ?? '').includes('注入回合的模型回复已被拦截')
const suppressedBefore = (await get('/api/trace?stage=inject&limit=200')).events.filter(isSuppression).length
let suppressedEvent = null
const suppressDeadline = Date.now() + 300000
while (suppressedEvent === null && Date.now() < suppressDeadline) {
  const trace = await get('/api/trace?stage=inject&limit=200')
  const matches = (trace.events ?? []).filter(isSuppression)
  // 必须比注入前多一条：否则可能匹配到上一轮留下的旧事件
  if (matches.length > suppressedBefore) suppressedEvent = matches[matches.length - 1]
  if (suppressedEvent === null) await sleep(2000)
}
if (suppressedEvent === null) {
  // 模型回话时间不可控（宿主冷启动/排队时会很慢），这里如实标成"未验证"而不是假失败
  warn('注入回合的模型回复拦截：300s 内模型没有回话，本项未验证', '同步 dry-run 拦截已通过；确定性覆盖见 test/inject-guard-unit.mjs')
} else {
  check('注入回合的模型回复被拦下并记录了原文', true, suppressedEvent.reason.slice(0, 110))
  check('拦截原因写明 dry-run 未发送', String(suppressedEvent.reason).includes('dry-run，未发送'), String(suppressedEvent.reason).slice(0, 80))
  const quoted = String(suppressedEvent.reason).slice(String(suppressedEvent.reason).lastIndexOf('：') + 1)
  check('被拦下的原文没有出现在任何出站里', quoted.length > 0 && !outboundText().includes(quoted), `原文 ${quoted.slice(0, 40)}…`)
}

// ---- 5. 运行时快照暴露注入进度 ----
const runtime = await get('/api/runtime')
check('快照带注入通道状态', runtime.runtime?.injection?.enabled === true && runtime.runtime?.injection?.consumed >= 1, JSON.stringify(runtime.runtime?.injection ?? {}).slice(0, 140))
check('快照带回放提示（线上配置）', Array.isArray(runtime.runtime?.replayHints?.allowGroups) && runtime.runtime.replayHints.allowGroups.includes(groupId))
check('快照带录制计数', runtime.runtime?.inbox?.recorded >= 1, JSON.stringify(runtime.runtime?.inbox ?? {}))

// ---- 6. 录制文件确实是可回放的 JSONL ----
const raw = readFileSync(join(liveCwd, 'qq-inbox.jsonl'), 'utf8').trim().split(/\r?\n/)
check('录制文件是 JSONL', raw.length >= 1 && raw.every((line) => { try { return Boolean(JSON.parse(line).frame) } catch { return false } }), `${raw.length} 行`)
check('录制行含 kind 与时间戳', (() => { const entry = JSON.parse(raw[raw.length - 1]); return ['message', 'notice', 'request'].includes(entry.kind) && typeof entry.ts === 'number' })())

try { ws.close() } catch { /* ignore */ }
console.log(`\n${passed} passed, ${failed} failed${warned > 0 ? `, ${warned} warned` : ''}`)
process.exit(failed > 0 ? 1 : 0)
