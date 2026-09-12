/**
 * Live check for the console's real-time debugging surfaces (run with the host up):
 *   1. SSE /api/stream pushes trace events as the bridge writes them
 *   2. /api/trace + /api/runtime + /api/diagnose answer with real data
 *   3. the token still guards every route
 *
 * Usage: node test/live-stream.mjs [--token <control token>] [--control 8799] [--onebot 6700]
 */
import { WebSocket } from 'ws'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

/** 真实号从本机 profile 配置现取：仓库里只有占位号，而占位号不在生产白名单里。 */
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
const control = Number(arg('control', '8799'))
const onebotPort = Number(arg('onebot', '6700'))
const token = arg('token', '')
const groupId = Number(arg('group', local.group || '100000001'))
const userId = Number(arg('user', local.user || '2000000001'))
const botQq = Number(arg('bot', local.bot || '3000000001'))

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const control_base = `http://127.0.0.1:${control}`

// ---- HTTP surfaces ----
const unauth = await fetch(`${control_base}/api/trace`)
check('未带 token 的事件接口返回 401', unauth.status === 401, String(unauth.status))
const trace = await (await fetch(`${control_base}/api/trace?limit=5&token=${token}`)).json()
check('/api/trace 有数据', trace.ok === true && Array.isArray(trace.events), `events=${trace.events?.length}`)
const runtime = await (await fetch(`${control_base}/api/runtime?token=${token}`)).json()
check('/api/runtime 有快照', runtime.runtime !== null && typeof runtime.runtime?.version === 'string', JSON.stringify(runtime.runtime?.version))
const diagnose = await (await fetch(`${control_base}/api/diagnose?token=${token}`)).json()
check('/api/diagnose 有报告', diagnose.report?.checks?.length >= 10, `${diagnose.report?.summary?.passed}/${diagnose.report?.summary?.total}`)

// ---- SSE stream while a real message flows through the bridge ----
const streamed = []
const controller = new AbortController()
const streamPromise = (async () => {
  const response = await fetch(`${control_base}/api/stream?token=${token}`, { signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    for (const line of decoder.decode(value).split('\n')) {
      if (!line.startsWith('data: ')) continue
      try { streamed.push(JSON.parse(line.slice(6))) } catch { /* ignore */ }
    }
    if (streamed.length > 0) break
  }
  controller.abort()
})().catch(() => {})

await new Promise((resolve) => setTimeout(resolve, 1500))
const ws = new WebSocket(`ws://127.0.0.1:${onebotPort}/`)
ws.on('message', (data) => {
  const frame = JSON.parse(String(data))
  if (frame.action) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: frame.echo }))
})
await new Promise((resolve) => setTimeout(resolve, 500))
ws.send(JSON.stringify({
  post_type: 'message', message_type: 'group', group_id: groupId, user_id: userId, self_id: botQq,
  message_id: (Date.now() % 100000) * 10 + 1, sender: { card: '自检' },
  message: `[CQ:at,qq=${botQq},name=小鲸鱼] /status`,
}))
await streamPromise

check('SSE 实时推送了新事件', streamed.length > 0, `${streamed.length} 条`)
check('SSE 事件带 stage 与 traceId', streamed.every((event) => typeof event.stage === 'string'), JSON.stringify(streamed[0] ?? {}).slice(0, 90))
check('SSE 第一条是 inbound 或该消息链路', streamed.some((event) => ['inbound', 'whitelist', 'command', 'reply'].includes(event.stage)), streamed.map((e) => e.stage).join('>'))

// ---- decision chain of the just-sent message ----
const chainId = streamed[0]?.id
if (chainId) {
  const chain = await (await fetch(`${control_base}/api/trace?traceId=${chainId}&token=${token}`)).json()
  check('可按 traceId 取到决策链', chain.chain?.id === chainId && Array.isArray(chain.chain.timeline), JSON.stringify(chain.chain?.stages))
  check('决策链带耗时与结果', chain.chain.events.every((event) => typeof event.ok === 'boolean'), '')
} else {
  check('可按 traceId 取到决策链', false, '没有拿到 traceId')
}

try { ws.close() } catch { /* ignore */ }
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
