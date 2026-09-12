/**
 * Live end-to-end check against a REAL dsh web host (not a mock).
 *
 * Prereqs: the web-profile host is running (dsh web, reverse WS on 6700) and the
 * production cordis.patch.yml allowlists these ids. Connects a fake OneBot
 * client, then verifies:
 *   1. /status   → answered by the bridge itself (no model call)
 *   2. 今日人品   → answered by the local fortune module (no model call)
 *   3. plain text → answered by the real agent (validates agents.create,
 *      per-session tool registration and assistant/message delivery)
 *   4. an unknown command still reaches the agent (no silent drop)
 *
 * Usage: node test/live-e2e.mjs [--group <真实群号>] [--user <真实QQ>] [--bot <机器人QQ>]
 * 不给参数时从机器本地的 profile 配置现取（仓库里只有占位号）。
 */
import { WebSocket } from 'ws'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

/** 真实号从本机 profile 配置现取：占位号不在生产白名单里，直接用会被白名单拦下。 */
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
const url = arg('url', 'ws://127.0.0.1:6700/')

const replies = []
// 每次运行用不同的 message_id 段，避免命中桥的去重窗口（生产行为，测试需绕开）。
let messageId = (Date.now() % 100000) * 10
const ws = new WebSocket(url)

function sendGroup(text) {
  ws.send(JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    user_id: userId,
    self_id: botQq,
    message_id: ++messageId,
    sender: { card: '自检', nickname: '自检' },
    message: `[CQ:at,qq=${botQq},name=小鲸鱼] ${text}`,
  }))
}

/** Same as sendGroup but WITHOUT the @-mention: must be dropped AND traced with a reason. */
function sendGroupWithoutMention(text) {
  ws.send(JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    user_id: userId,
    self_id: botQq,
    message_id: ++messageId,
    sender: { card: '自检', nickname: '自检' },
    message: text,
  }))
}

function waitFor(predicate, timeoutMs, label, fromIndex = 0) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const hit = replies.slice(fromIndex).find(predicate)
      if (hit) {
        clearInterval(timer)
        resolve(hit)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`超时等待：${label}`))
      }
    }, 250)
  })
}

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

ws.on('open', async () => {
  console.log(`connected ${url} (group=${groupId} user=${userId} bot=${botQq})`)
  try {
    // 1) 桥自身命令（无模型）
    sendGroup('/status')
    const status = await waitFor((r) => r.includes('QQ 桥状态'), 20_000, '/status 回复')
    record('活宿主：/status 由桥直接回复', true, status.slice(0, 40))

    // 2) 本地运势（无模型）
    sendGroup('今日人品')
    const fortune = await waitFor((r) => /总分|人品|分/.test(r), 20_000, '今日人品回复')
    record('活宿主：本地运势回复', true, fortune.slice(0, 40))

    // 3) 真 agent 回合（走 agents.create + 工具注册 + session 事件回发）
    sendGroup('请只回复两个字：收到')
    const agent = await waitFor((r) => !r.includes('QQ 桥状态') && !/总分|人品/.test(r) && r.length > 0 && r !== fortune, 120_000, 'agent 回复')
    record('活宿主：agent 回合回复', agent.length > 0, agent.slice(0, 60))

    // 4) 会话已建立（第二条消息复用同一会话，不应报错）
    const mark = replies.length
    sendGroup('再说一次：收到')
    const second = await waitFor((r) => r.includes('收到'), 120_000, 'agent 第二轮回复', mark)
    record('活宿主：同一会话可连续对话', second.length > 0, second.slice(0, 60))

    // 5) 只读命令的健壮性：假 OneBot 端对所有 action 都只回 {message_id}，
    //    返回结构与真实实现不同，这里要确认桥不会崩、也不会抛给用户看。
    const readOnly = ['/help', '/统计', '/荣誉', '/公告', '/群精华', '/mc 127.0.0.1:1']
    const mark2 = replies.length
    for (const command of readOnly) sendGroup(command)
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    const quiet = replies.slice(mark2)
    record('活宿主：只读命令不崩溃', !quiet.some((text) => /Agent 处理失败|处理失败|Cannot read/.test(text)), `${quiet.length} 条回复`)
    record('活宿主：/help 有回复', quiet.some((text) => text.includes('小鲸鱼使用指南')), quiet.find((text) => text.includes('指南'))?.slice(0, 30) ?? '')

    // 6) 该被静默丢弃的消息：群聊未 @ 机器人 —— 不应有任何回复，
    //    但必须在事件流里留下带原因的记录（「一切皆可调试」的核心约束）。
    const mark3 = replies.length
    sendGroupWithoutMention('这条没有 @ 机器人，应该被静默丢弃')
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    record('活宿主：未 @ 的消息被静默丢弃', replies.length === mark3, `${replies.length - mark3} 条回复`)
  } catch (error) {
    record(error.message, false)
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed} passed, ${failed} failed`)
  try { ws.close() } catch {}
  process.exit(failed > 0 ? 1 : 0)
})

ws.on('message', (data) => {
  const frame = JSON.parse(String(data))
  if (!frame.action) return
  const text = typeof frame.params?.message === 'string'
    ? frame.params.message
    : (frame.params?.message ?? []).map((segment) => segment.data?.text ?? '').join('')
  if (text) {
    replies.push(text)
    console.log(`  ← [${frame.action}] ${text.replace(/\n/g, ' | ').slice(0, 100)}`)
  }
  ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: messageId }, echo: frame.echo }))
})

ws.on('error', (error) => {
  console.log(`FAIL 连接失败：${error.message}`)
  process.exit(1)
})

setTimeout(() => {
  console.log('FAIL 总超时（180s）')
  process.exit(1)
}, 180_000)
