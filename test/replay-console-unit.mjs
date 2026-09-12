/**
 * Stage-3 console acceptance: 录制 / 回放 / 注入 的控制台一侧。
 *
 * 覆盖三件事：
 *   ① 控制台路由（/api/inbox、/api/replay、/api/inject、/api/queue/clear）走真实 HTTP，
 *      含 token/Origin 门禁与参数裁剪；
 *   ② 真实 supervisor 读写 qq-inbox.jsonl / qq-inject.jsonl（临时 cwd，不碰线上）；
 *   ③ 面板接线：新增元素存在、内联 onclick 引用的函数都已定义、脚本可解析。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlServer, createToken, readUi } from '../control/lib/server.mjs'
import { createSupervisor } from '../control/lib/supervisor.mjs'
import { HINT_KEYS, hintConfig } from '../control/lib/replay.mjs'
import { serializeFrame } from '../lib/inbox.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const die = (message) => { failed++; console.log('FAIL', message) }

const dir = mkdtempSync(join(tmpdir(), 'qq-replay-console-'))
const cwd = join(dir, 'live')
mkdirSync(cwd, { recursive: true })

// 造 3 条录制 + 1 条历史注入队列
const inboxLines = [
  serializeFrame('message', { messageType: 'group', groupId: 100000001, userId: 2000000001, text: '第一条', atMe: true, ats: [3000000001], messageId: 'r-1' }, { now: 1_700_000_000_000 }),
  serializeFrame('message', { messageType: 'private', userId: 2000000001, text: '第二条', messageId: 'r-2' }, { now: 1_700_000_001_000 }),
  serializeFrame('notice', { noticeType: 'notify', subType: 'poke', groupId: 100000001, userId: 2000000001, targetId: 3000000001 }, { now: 1_700_000_002_000 }),
  '{"broken',
].join('\n') + '\n'
writeFileSync(join(cwd, 'qq-inbox.jsonl'), inboxLines, 'utf8')
writeFileSync(join(cwd, 'qq-inject.jsonl'), '{"text":"历史注入一行","userId":2000000001}\n', 'utf8')
writeFileSync(join(cwd, 'qq-runtime.json'), JSON.stringify({
  updatedAt: Date.now(),
  version: '0.4.0',
  replay: { botQq: 3000000001, allowGroups: [100000001], allowUsers: [2000000001] },
  injection: { enabled: true, file: join(cwd, 'qq-inject.jsonl'), dryRun: true, intervalMs: 1500 },
  features: {},
}), 'utf8')

const config = {
  cwd,
  pluginRoot: join(dir, 'plugin-root-missing'),
  ports: { control: 18801, host: 3080, onebot: 6700, napcat: 6099, tts: 9880 },
  logs: {
    hostOut: join(cwd, 'qq-host-out.log'),
    trace: join(cwd, 'qq-trace.jsonl'),
    runtime: join(cwd, 'qq-runtime.json'),
    audit: join(cwd, 'qq-actions.log'),
    inbox: join(cwd, 'qq-inbox.jsonl'),
    inject: join(cwd, 'qq-inject.jsonl'),
  },
}
const noExec = (command, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  if (command === 'netstat') return done(null, '  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    555\n', '')
  if (command === 'tasklist') return done(null, '"node.exe","555","Console","1","100 K"\n', '')
  return done(new Error('not stubbed'), '', '')
}

// ---------------------------------------------------- 面板接线（静态检查） ----
const ui = readUi(join(import.meta.dirname, '..', 'control', 'ui.html'))
check('面板读到录制/回放区', ui.includes('录制 · 回放 · 注入'))
for (const id of ['inbox', 'inboxMeta', 'replayOut', 'replayState', 'replayLimit', 'injKind', 'injGroup', 'injUser', 'injText', 'injAtMe', 'injState']) {
  if (!ui.includes(`id="${id}"`)) die(`面板缺少元素 #${id}`)
}
check('面板录制区元素齐全', true)
const script = /<script>([\s\S]*)<\/script>/.exec(ui)?.[1] ?? ''
check('面板脚本可解析为合法 JS', (() => { try { new Function(script); return true } catch { return false } })())
for (const fn of ['loadInbox', 'replayOne', 'replayRecent', 'replayEntries', 'doInject', 'clearQueue', 'escapeHtml', 'escapeAttr']) {
  if (!new RegExp(`(async )?function ${fn}\\(`).test(script)) die(`面板缺少函数 ${fn}`)
}
check('面板函数全部已定义', true)
const called = [...ui.matchAll(/on(?:click|change|input)="([a-zA-Z_$][\w$]*)\(/g)].map((match) => match[1])
const missing = [...new Set(called)].filter((name) => !new RegExp(`(async )?function ${name}\\(`).test(script))
check('内联事件调用的函数都存在', missing.length === 0, missing.join(','))
check('面板提示了 dry-run 不会真发', ui.includes('dry-run'))
check('清空队列写明进回收站', ui.includes('清空注入队列（进回收站）'))
check('录制列表在加载前不显示假数据', ui.includes('尚未加载'))
check('注入前置校验要求 QQ 号', script.includes('请填写发消息的 QQ 号'))

// ------------------------------------------------ 回放提示（hintConfig） ----
const hints = hintConfig({ botQq: 1, allowGroups: [2], cwd: 'D:\\evil', traceFile: 'x', token: 'secret', allowUsers: [3] })
check('hintConfig 只取白名单键', hints.botQq === 1 && hints.allowGroups[0] === 2 && hints.allowUsers[0] === 3)
check('hintConfig 拒绝 cwd / traceFile / 未知键', hints.cwd === undefined && hints.traceFile === undefined && hints.token === undefined)
check('hintConfig 容忍空值', Object.keys(hintConfig(null)).length === 0 && Object.keys(hintConfig('nope')).length === 0)
check('hintConfig 跳过 null 值', hintConfig({ botQq: null, allowGroups: [] }).botQq === undefined)
check('HINT_KEYS 含白名单与安静时段', HINT_KEYS.includes('allowGroups') && HINT_KEYS.includes('quietHours') && HINT_KEYS.includes('quietHoursEnabled'))
check('HINT_KEYS 不含任何沙箱关键键', !HINT_KEYS.includes('cwd') && !HINT_KEYS.includes('traceFile') && !HINT_KEYS.includes('injectFile'))

// ------------------------------------------------------ 真实 supervisor ----
const sup = createSupervisor(config, { exec: noExec, logger: { info() {}, warn() {}, error() {} } })
const listed = sup.inboxList({ limit: 2 })
check('inboxList 读出录制条数', listed.recorded === 3 && listed.entries.length === 2, JSON.stringify(listed.recorded))
check('inboxList 只给最新的 2 条（保持时间顺序）', listed.entries[0].kind === 'message' && listed.entries[1].kind === 'notice', listed.entries.map((e) => e.kind).join(','))
check('inboxList 给出全局序号', listed.entries[0].index === 1 && listed.entries[1].index === 2, listed.entries.map((e) => e.index).join(','))
check('inboxList 给出可读描述', listed.entries[1].text.includes('notify/poke') && listed.entries[0].text.includes('私聊'), `${listed.entries[0].text} / ${listed.entries[1].text}`)
check('inboxList 带 chatKey 便于跳转', listed.entries[1].chatKey === 'g:100000001' && listed.entries[0].chatKey === 'u:2000000001')
check('inboxList 统计注入队列', listed.queued === 1, String(listed.queued))
check('inboxList 带源数据供回放', listed.entries[1].frame.noticeType === 'notify' && listed.entries[0].frame.text === '第二条')
check('inboxList 容忍坏行', listed.recorded === 3)

const injected = sup.inject({ text: '注入一条', groupId: 100000001, userId: 2000000001, atMe: true })
check('注入成功并入队', injected.ok === true, injected.reason)
check('注入写进队列文件', (readFileSync(join(cwd, 'qq-inject.jsonl'), 'utf8').match(/\n/g) ?? []).length === 2)
check('注入返回可读预览', injected.preview.includes('群 100000001'), injected.preview)
check('注入结果提示 dry-run 状态', injected.dryRun === true && injected.reason.includes('dry-run=开'), injected.reason)
check('非法注入被拒且给中文原因', sup.inject({ text: '缺 userid' }).ok === false && sup.inject({ text: '缺 userid' }).reason.includes('userId'))
check('非法注入不写队列', (readFileSync(join(cwd, 'qq-inject.jsonl'), 'utf8').match(/\n/g) ?? []).length === 2)

// 注入通道关闭时必须直说
writeFileSync(join(cwd, 'qq-runtime.json'), JSON.stringify({ updatedAt: Date.now(), injection: { enabled: false, dryRun: true } }), 'utf8')
const blocked = sup.inject({ text: 'x', userId: 2000000001 })
check('注入通道未开启时不静默失败', blocked.ok === false && blocked.reason.includes('injectEnabled'), blocked.reason)
writeFileSync(join(cwd, 'qq-runtime.json'), JSON.stringify({ updatedAt: Date.now(), injection: { enabled: true, dryRun: true, intervalMs: 1500 } }), 'utf8')

const cleared = sup.clearQueue()
check('清空队列是移动到回收站', cleared.ok === true && cleared.reason.includes('回收站'), cleared.reason)
check('清空后队列文件不在原位', !existsSync(join(cwd, 'qq-inject.jsonl')))
check('清空后文件仍在回收站里', cleared.reason.includes('qq-trash') && existsSync(cleared.reason.split('：').pop()), cleared.reason)
check('已清空的队列再次清空被拒', sup.clearQueue().ok === false)
check('清空后仍可继续注入（自动重建队列）', sup.inject({ text: '清空后再来', userId: 2000000001 }).ok === true)

// 回放：pluginRoot 不存在 → 明确报错而不是抛出/静默返回空报告
const brokenReplay = await sup.replay({ limit: 1 })
check('回放缺少插件代码时明确失败', brokenReplay.ok === false && typeof brokenReplay.reason === 'string', JSON.stringify(brokenReplay).slice(0, 140))
check('失败报告仍是完整形状（有 text 与 totals）', typeof brokenReplay.report?.text === 'string' && brokenReplay.report.text.includes('离线回放无法进行') && brokenReplay.totals.entries === 0)

// ---------------------------------------------------------- 真实 HTTP ----
const token = createToken()
const api = {
  status: async () => ({ ports: [], processes: {}, botOnline: false, warnings: [], config: {}, scannedAt: Date.now() }),
  logFile: () => join(cwd, 'qq-inbox.jsonl'),
  inboxList: (options) => sup.inboxList(options),
  inject: (spec) => sup.inject(spec),
  clearQueue: () => sup.clearQueue(),
  replay: async (options) => ({ ok: true, text: `回放 ${options.limit} 条`, totals: { entries: options.limit }, seen: options }),
}
const server = createControlServer({ config, token, api, ui: '<h1>console</h1>' })
await new Promise((resolve) => server.listen(18801, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:18801'

const inboxResponse = await fetch(`${base}/api/inbox?limit=2&token=${token}`)
const inboxBody = await inboxResponse.json()
check('GET /api/inbox 返回录制列表', inboxResponse.status === 200 && inboxBody.ok === true && inboxBody.entries.length === 2, JSON.stringify(inboxBody).slice(0, 120))
check('GET /api/inbox 透传 limit', inboxBody.entries[0].index === 1)
check('GET /api/inbox 需要 token', (await fetch(`${base}/api/inbox`)).status === 401)
check('GET /api/inbox 拒绝跨站', (await fetch(`${base}/api/inbox?token=${token}`, { headers: { Origin: 'https://evil.example' } })).status === 403)

const injectResponse = await fetch(`${base}/api/inject?token=${token}`, { method: 'POST', body: JSON.stringify({ text: '来自面板', userId: 2000000001, groupId: 100000001 }) })
const injectBody = await injectResponse.json()
check('POST /api/inject 校验并写队列', injectResponse.status === 200 && injectBody.ok === true, JSON.stringify(injectBody).slice(0, 140))
check('POST /api/inject 支持 spec 包装', (await (await fetch(`${base}/api/inject?token=${token}`, { method: 'POST', body: JSON.stringify({ spec: { text: '包装体', userId: 2000000001 } }) })).json()).ok === true)

const replayResponse = await fetch(`${base}/api/replay?token=${token}`, { method: 'POST', body: JSON.stringify({ limit: 3, replyText: 'x'.repeat(900), budgetMs: 999999 }) })
const replayBody = await replayResponse.json()
check('POST /api/replay 转发参数', replayResponse.status === 200 && replayBody.ok === true && replayBody.seen.limit === 3, JSON.stringify(replayBody).slice(0, 140))
check('POST /api/replay 截断 replyText 到 500', replayBody.seen.replyText.length === 500, String(replayBody.seen.replyText.length))
check('POST /api/replay 收敛时间预算上限', replayBody.seen.budgetMs === 60000, String(replayBody.seen.budgetMs))
check('POST /api/replay 默认预算 20s', (await (await fetch(`${base}/api/replay?token=${token}`, { method: 'POST', body: '{}' })).json()).seen.budgetMs === 20000)
check('POST /api/replay 默认回放 5 条', (await (await fetch(`${base}/api/replay?token=${token}`, { method: 'POST', body: '{}' })).json()).seen.limit === 5)
const cappedReplay = await (await fetch(`${base}/api/replay?token=${token}`, { method: 'POST', body: JSON.stringify({ indices: Array.from({ length: 50 }, (_, index) => index) }) })).json()
check('POST /api/replay 限制下标数量', cappedReplay.seen.indices.length === 20, String(cappedReplay.seen.indices.length))
const badOverrides = await (await fetch(`${base}/api/replay?token=${token}`, { method: 'POST', body: JSON.stringify({ overrides: 'nope' }) })).json()
check('POST /api/replay 丢弃非对象覆盖', typeof badOverrides.seen.overrides === 'object' && badOverrides.seen.overrides !== null)

const clearResponse = await fetch(`${base}/api/queue/clear?token=${token}`, { method: 'POST', body: '{}' })
const clearBody = await clearResponse.json()
check('POST /api/queue/clear 走 supervisor', clearResponse.status === 200 && clearBody.reason.includes('回收站'), JSON.stringify(clearBody))
check('清空队列接口需要 token', (await fetch(`${base}/api/queue/clear`, { method: 'POST', body: '{}' })).status === 401)
check('GET /api/replay 不被接受', [404, 405].includes((await fetch(`${base}/api/replay?token=${token}`)).status))
server.close()

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
