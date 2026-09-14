/**
 * webhook 入站单元测试：渲染层（webhookfmt）纯函数 + 接收层（webhook）真实 HTTP 往返。
 *
 * 接收层不自欺欺人：真起 WebhookReceiver 到随机高位端口，用 fetch 打真请求，
 * 断言状态码、响应体、onEvent 收到的 payload/raw，以及 status() 的计数。
 */
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { pickPath, renderWebhook } from '../lib/webhookfmt.js'
import { WebhookReceiver } from '../lib/webhook.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ---------------------------------------------------------------- helpers ----
const REPO = { full_name: 'cheesehaqi/dsh-qq-onebot-bridge', name: 'dsh-qq-onebot-bridge', html_url: 'https://github.com/cheesehaqi/dsh-qq-onebot-bridge' }

/** 起一个临时监听拿到空闲高位端口后关掉（避免硬编码端口撞车）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** 真实 HTTP 请求；响应不是 JSON（如连接重置）时 safe 返回 { status: 0, error }。 */
async function request(url, options = {}) {
  try {
    const response = await fetch(url, options)
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = text }
    return { status: response.status, body }
  } catch (error) {
    return { status: 0, body: null, error: String(error?.message ?? error) }
  }
}

const post = (base, name, options = {}) => request(`${base}/hook/${name}`, { method: 'POST', body: '{}', ...options })

const logs = []
const logger = {
  info: (message) => logs.push(`info ${message}`),
  warn: (message) => logs.push(`warn ${message}`),
  error: (message) => logs.push(`error ${message}`),
}

const silent = { info() {}, warn() {}, error() {} }

const gh = (extra) => ({ ...extra, repository: REPO, sender: { login: 'cheesehaqi' } })

// ------------------------------------------------------------- pickPath ----
check('pickPath 取多层点路径', pickPath({ a: { b: { c: 7 } } }, 'a.b.c') === 7)
check('pickPath 支持数组下标', pickPath({ a: { b: [{ c: 'x' }, { c: 'y' }] } }, 'a.b.1.c') === 'y')
check('pickPath 顶层单段路径', pickPath({ a: 1 }, 'a') === 1)
check('pickPath 缺失层返回 undefined', pickPath({ a: { b: {} } }, 'a.b.c') === undefined)
check('pickPath 数组越界返回 undefined', pickPath({ a: [] }, 'a.3.c') === undefined)
check('pickPath 中途遇到标量返回 undefined', pickPath({ a: 'text' }, 'a.b') === undefined)
check('pickPath 非对象输入返回 undefined', pickPath(null, 'a') === undefined && pickPath('str', 'a') === undefined)
check('pickPath 空路径返回 undefined', pickPath({ a: 1 }, '') === undefined && pickPath({ a: 1 }, '  ') === undefined)
check('pickPath 不读原型链', pickPath({}, 'constructor') === undefined && pickPath({}, '__proto__.x') === undefined)
check('pickPath 保留 null 与假值', pickPath({ a: { b: null } }, 'a.b') === null && pickPath({ a: 0 }, 'a') === 0)

// -------------------------------------------------- renderWebhook github ----
const pushText = renderWebhook(
  { name: 'gh', format: 'github' },
  gh({ ref: 'refs/heads/main', commits: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], pusher: { name: 'cheesehaqi' }, compare: 'https://github.com/cheesehaqi/dsh-qq-onebot-bridge/compare/x' }),
).text
check('github push 标题与仓库名', pushText.includes('📦') && pushText.includes('新推送') && pushText.includes(REPO.full_name), pushText.split('\n')[0])
check('github push 分支与提交数', pushText.includes('main') && pushText.includes('3 个提交'), pushText)
check('github push 发起人', pushText.includes('cheesehaqi'), pushText)
check('github push 对比链接成行', pushText.includes('对比：https://github.com/'), pushText)

// 事件类型只写在 HTTP 头里，payload 里没有 event：靠 commits 结构特征认出来
const pushNoEvent = renderWebhook({ name: 'gh', format: 'github' }, gh({ ref: 'refs/heads/dev', commits: [], after: 'deadbeefcafe' })).text
check('github push 靠 commits 结构特征识别', pushNoEvent.includes('新推送') && pushNoEvent.includes('dev'), pushNoEvent)
check('github push 无 commits 时提交数为 0', pushNoEvent.includes('0 个提交'), pushNoEvent)

const prText = renderWebhook({ name: 'gh', format: 'github' }, gh({ action: 'opened', pull_request: { number: 42, title: '加 webhook', html_url: 'https://github.com/cheesehaqi/dsh-qq-onebot-bridge/pull/42' } })).text
check('github PR 靠 pull_request 结构特征识别', prText.includes('PR #42') && prText.includes('新开'), prText)
check('github PR 标题与链接', prText.includes('加 webhook') && prText.includes('/pull/42'), prText)
const mergedText = renderWebhook({ name: 'gh', format: 'github' }, gh({ action: 'closed', pull_request: { number: 7, title: 'x', merged: true } })).text
check('github PR 关闭动作用中文', mergedText.includes('关闭'), mergedText)

const issueText = renderWebhook({ name: 'gh', format: 'github' }, { action: 'opened', repository: REPO, issue: { number: 9, title: '登录报错', html_url: 'https://github.com/cheesehaqi/dsh-qq-onebot-bridge/issues/9', user: { login: 'zhangsan' } }, sender: { login: 'zhangsan' } }).text
check('github issues 靠 issue 结构特征识别', issueText.includes('议题 #9') && issueText.includes('登录报错'), issueText)
check('github issues 提交人', issueText.includes('提交人 zhangsan'), issueText)
const issueNoSender = renderWebhook({ name: 'gh', format: 'github' }, { repository: REPO, issue: { number: 10, title: 'T', user: { login: 'lisi' } } }).text
check('github issues 缺 sender 时回落到条目作者', issueNoSender.includes('提交人 lisi'), issueNoSender)

const commentText = renderWebhook({ name: 'gh', format: 'github' }, gh({ action: 'created', issue: { number: 9, title: '登录报错', html_url: 'https://github.com/x/y/issues/9' }, comment: { html_url: 'https://github.com/x/y/issues/9#issuecomment-1', user: { login: 'lisi' } } })).text
check('github issue_comment 靠 issue+comment 结构特征识别', commentText.includes('💬') && commentText.includes('新评论'), commentText)
check('github issue_comment 评论者与链接', commentText.includes('lisi') && commentText.includes('#issuecomment-1'), commentText)

const ciFail = renderWebhook({ name: 'gh', format: 'github' }, gh({ workflow_run: { name: 'CI', conclusion: 'failure', run_number: 42, head_branch: 'main', html_url: 'https://github.com/x/y/actions/runs/1', actor: { login: 'cheesehaqi' } } })).text
check('github workflow_run 失败口径', ciFail.includes('❌') && ciFail.includes('CI 失败') && ciFail.includes('failure'), ciFail.split('\n')[0])
check('github workflow_run 工作流与运行号', ciFail.includes('CI #42') && ciFail.includes('main'), ciFail)
const ciOk = renderWebhook({ name: 'gh', format: 'github' }, gh({ workflow_run: { name: 'CI', conclusion: 'success', run_number: 43, html_url: 'https://github.com/x/y/actions/runs/2' } })).text
check('github workflow_run 成功口径', ciOk.includes('✅') && ciOk.includes('CI 通过'), ciOk.split('\n')[0])
const ciRunning = renderWebhook({ name: 'gh', format: 'github' }, gh({ workflow_run: { name: 'CI', status: 'in_progress' } })).text
check('github workflow_run 进行中不误报失败', ciRunning.includes('⏳') && ciRunning.includes('进行中'), ciRunning.split('\n')[0])

const releaseText = renderWebhook({ name: 'gh', format: 'github' }, gh({ action: 'published', release: { tag_name: 'v1.2.0', name: '1.2.0', html_url: 'https://github.com/x/y/releases/tag/v1.2.0', author: { login: 'cheesehaqi' } } })).text
check('github release 靠 release 结构特征识别', releaseText.includes('🏷️') && releaseText.includes('新发布') && releaseText.includes('v1.2.0'), releaseText)
check('github release 发布人与链接', releaseText.includes('cheesehaqi') && releaseText.includes('/releases/tag/v1.2.0'), releaseText)

// 显式事件名（桥把 X-GitHub-Event 补进 payload）优先于结构特征
const explicit = renderWebhook({ name: 'gh', format: 'github' }, gh({ event: 'issues', action: 'closed', issue: { number: 3, title: 'T' }, commits: [{ id: 'a' }] })).text
check('github 显式 event 优先于结构特征', explicit.includes('议题 #3') && !explicit.includes('新推送'), explicit)
const dashed = renderWebhook({ name: 'gh', format: 'github' }, gh({ event: 'workflow-run', workflow_run: { conclusion: 'success', name: 'CI' } })).text
check('github 事件名连字符形式可识别', dashed.includes('CI 通过'), dashed.split('\n')[0])

// 认不出来 + 畸形 payload
const unknown = renderWebhook({ name: 'gh', format: 'github' }, gh({ action: 'labeled', label: { name: 'bug' } }))
check('github 未识别事件回落到 generic 口径', unknown.ok === true && unknown.text.includes('未知') && unknown.reason.includes('未识别'), `${unknown.reason} | ${unknown.text}`)
const malformed = renderWebhook({ name: 'gh', format: 'github' }, { event: 'push' })
check('github 畸形 payload 不抛错且字段有兜底', malformed.ok === true && malformed.text.includes('未知仓库') && malformed.text.includes('未知分支'), malformed.text)
const githubString = renderWebhook({ name: 'gh', format: 'github' }, 'hi there')
check('github 非对象 payload 安全渲染', githubString.ok === true && githubString.text.includes('hi there'), githubString.text)
check('github 空 payload 安全渲染', renderWebhook({ name: 'gh', format: 'github' }, null).ok === true)
check('github 数组 payload 安全渲染', renderWebhook({ name: 'gh', format: 'github' }, [1, 2]).ok === true)
check('无 source（undefined）也能渲染', renderWebhook(undefined, { event: 'push', repository: REPO }).ok === true)
check('未知 format 返回中文原因', renderWebhook({ format: 'nope' }, {}).ok === false && renderWebhook({ format: 'nope' }, {}).reason.includes('未知的 webhook 格式'))

// ------------------------------------------------------ renderWebhook kuma ----
const kumaSource = { name: 'kuma', format: 'uptime-kuma' }
const down = renderWebhook(kumaSource, { heartbeat: { status: 0, msg: 'connect ECONNREFUSED', time: '2026-09-01T10:00:00.000Z', important: true }, monitor: { name: '官网', url: 'https://example.com' } }).text
check('kuma status 0 是宕机（红）', down.includes('🔴') && down.includes('官网') && down.includes('宕机'), down.split('\n')[0])
check('kuma 宕机带详情与监控链接', down.includes('ECONNREFUSED') && down.includes('https://example.com'), down)
const up = renderWebhook(kumaSource, { heartbeat: { status: 1, msg: '200 - OK', time: '2026-09-01T10:05:00.000Z' }, monitor: { name: '官网' } }).text
check('kuma status 1 是恢复（绿）', up.includes('🟢') && up.includes('恢复'), up.split('\n')[0])
const pending = renderWebhook(kumaSource, { heartbeat: { status: 2, time: 0 }, monitor: { name: '新监控' } }).text
check('kuma status 2 是待定', pending.includes('🟡') && pending.includes('待定'), pending.split('\n')[0])
const maintenance = renderWebhook(kumaSource, { heartbeat: { status: 3, msg: 'maintenance window' }, monitor: { name: '官网' } }).text
check('kuma status 3 是维护（不是故障）', maintenance.includes('🔧') && maintenance.includes('维护'), maintenance.split('\n')[0])
check('kuma 缺 monitor 名有兜底', renderWebhook(kumaSource, { heartbeat: { status: 0 } }).text.includes('未知监控'))
check('kuma 未知 status 不抛错', (() => { const r = renderWebhook(kumaSource, { heartbeat: { status: 9 }, monitor: { name: 'X' } }); return r.ok === true && r.text.includes('X') })())
check('kuma 空 payload 不抛错', renderWebhook(kumaSource, null).ok === true)

// --------------------------------------------------- renderWebhook generic ----
const templateSource = { name: 'g', format: 'generic', template: '📣 {service.name} 变成 {service.state}（{service.missing}）' }
const filled = renderWebhook(templateSource, { service: { name: 'api', state: 'degraded' } }).text
check('generic 模板点路径替换', filled.includes('api') && filled.includes('degraded'), filled)
check('generic 取不到的占位符替换成（无）', filled.includes('（无）'), filled)
const emptyTemplate = renderWebhook({ name: 'g', format: 'generic' }, { pad: 'x'.repeat(900) })
check('generic 空模板回落到 JSON', emptyTemplate.ok === true && emptyTemplate.text.includes('"pad"'), emptyTemplate.text.slice(0, 40))
check('generic 空模板 JSON 截断到 500 字', emptyTemplate.text.length === 501 && emptyTemplate.text.endsWith('…'), String(emptyTemplate.text.length))
check('generic 非对象 payload 走 String', renderWebhook({ format: 'generic', template: '值={x}' }, '纯文本').text.includes('（无）'))
check('generic 模板数组形式也能渲染', renderWebhook({ format: 'generic', template: '名单 {names.0}' }, { names: ['小明'] }).text.includes('小明'))

const longText = renderWebhook({ format: 'generic', template: ' {a} ' }, { a: 'x'.repeat(2000) }, { maxChars: 50 })
check('maxChars 硬截断并加标记', longText.text.length === 50 + '…（内容过长已截断）'.length && longText.text.endsWith('…（内容过长已截断）'), String(longText.text.length))
check('maxChars 默认 800 生效', renderWebhook({ format: 'generic', template: '{a}' }, { a: 'y'.repeat(2000) }).text.length === 800 + '…（内容过长已截断）'.length)
const shortPush = renderWebhook({ name: 'gh', format: 'github', maxChars: 12 }, gh({ event: 'push', ref: 'refs/heads/main', commits: [] })).text
check('github 渲染同样受 maxChars 约束', shortPush.endsWith('…（内容过长已截断）'), shortPush)
const whitespace = renderWebhook({ format: 'generic', template: ' 一个\n\n  两个  ' }, {}).text
check('渲染结果压缩空白并 trim', whitespace === '一个 两个', JSON.stringify(whitespace))
// JSON.stringify 遇到循环引用会抛 TypeError：渲染层必须自己接住并退回 String(payload)
const circular = {}
circular.self = circular
const circularResult = renderWebhook({ format: 'generic', template: '{a}' }, circular)
check('畸形 payload 不抛错：循环引用', circularResult.ok === true && circularResult.text === '（无）', JSON.stringify(circularResult))
check('畸形 payload 不抛错：BigInt', (() => { const r = renderWebhook({ format: 'generic' }, 10n); return r.ok === true && r.text === '10' })(), JSON.stringify(renderWebhook({ format: 'generic' }, 10n)))
const boom = {
  get format() { throw new Error('坏了') },
}
check('渲染异常被捕获并给中文原因', (() => { const r = renderWebhook(boom, {}); return r.ok === false && r.text === '' && r.reason.includes('渲染失败') })(), renderWebhook(boom, {}).reason)

// ------------------------------------------------------------------ HTTP ----
const port = await freePort()
const TOKEN = 'token-abcdefghijklmnop'
const SECRET = 'shhh-secret-value'
let onEventCalls = 0
let lastEvents = []
let throwOnce = true
const receiver = new WebhookReceiver({
  port,
  sources: [
    // github 来源同时配 token 与 secret：两种鉴权方式各自都能独立放行
    { name: 'github', token: TOKEN, secret: TOKEN, format: 'github', chat: 'group:1' },
    { name: 'kuma', secret: SECRET, format: 'uptime-kuma', chat: 'private:2' },
    { name: 'slow', token: TOKEN, format: 'generic', template: '{a}', chat: 'group:3', maxChars: 100 },
    { name: 'boom', token: TOKEN, format: 'generic', chat: 'group:4' },
    { name: 'naked', format: 'generic', chat: 'group:5' },
    { name: 'big', token: TOKEN, format: 'generic', chat: 'group:6' },
  ],
  onEvent: async (event) => {
    onEventCalls++
    lastEvents.push(event)
    if (event.source.name === 'boom' && throwOnce) {
      throwOnce = false
      throw new Error('下游发送失败\n第二行不该出现')
    }
  },
  logger,
})
const nakedIndex = receiver.sources.size
await receiver.start()
const base = `http://127.0.0.1:${port}`
check('start() 后监听本机端口', receiver.status().listening === true)
check('缺少 token 与 secret 的来源被拒绝注册', nakedIndex === 5 && !receiver.status().sources.some((item) => item.name === 'naked'), JSON.stringify(receiver.status().sources.map((s) => s.name)))

const created = await post(base, 'github', { headers: { 'X-Webhook-Token': TOKEN }, body: JSON.stringify(gh({ event: 'push', ref: 'refs/heads/main', commits: [{ id: 'a' }] })) })
check('合法 token + JSON → 202 {ok:true}', created.status === 202 && created.body?.ok === true, JSON.stringify(created))
check('onEvent 收到源配置对象', lastEvents.at(-1)?.source?.name === 'github' && lastEvents.at(-1)?.source?.chat === 'group:1')
check('onEvent 收到已解析 payload', lastEvents.at(-1)?.payload?.ref === 'refs/heads/main', JSON.stringify(lastEvents.at(-1)?.payload?.ref))
check('onEvent 收到原始请求体字符串', typeof lastEvents.at(-1)?.raw === 'string' && lastEvents.at(-1).raw.includes('refs/heads/main'), String(lastEvents.at(-1)?.raw).slice(0, 40))

const queryUrl = `${base}/hook/github?token=${TOKEN}`
check('查询串 token 也放行', (await request(queryUrl, { method: 'POST', body: '{}' })).status === 202)

// 鉴权失败的请求绝不能触发 onEvent：提交前后各取一次计数，确认没有变化
const kumaPayload = JSON.stringify({ heartbeat: { status: 0, msg: 'boom' }, monitor: { name: '官网' } })
const wrongSig = `sha256=${'0'.repeat(64)}`
const eventsBeforeAuthFailures = onEventCalls
const badToken = await post(base, 'github', { headers: { 'X-Webhook-Token': 'wrong-token-value' }, body: '{}' })
const noToken = await post(base, 'github', { body: '{}' })
const hmacBad = await post(base, 'kuma', { headers: { 'X-Hub-Signature-256': wrongSig }, body: kumaPayload })
const hmacMissing = await post(base, 'kuma', { body: kumaPayload })
const kumaToken = await post(base, 'kuma', { headers: { 'X-Webhook-Token': TOKEN }, body: kumaPayload })
const authFailures = [badToken, noToken, hmacBad, hmacMissing, kumaToken]
check('错误 token → 401', badToken.status === 401 && badToken.body?.reason === '鉴权失败', JSON.stringify(badToken))
check('缺失 token → 401（不开放）', noToken.status === 401, JSON.stringify(noToken))
check('HMAC 错误 → 401', hmacBad.status === 401, JSON.stringify(hmacBad))
check('缺签名头 → 401', hmacMissing.status === 401, JSON.stringify(hmacMissing))
check('kuma 来源不认 token（只认 secret）', kumaToken.status === 401, JSON.stringify(kumaToken))
check('鉴权失败的 5 次请求一次都没有触发 onEvent', authFailures.every((item) => item.status === 401) && onEventCalls === eventsBeforeAuthFailures, `calls=${onEventCalls} before=${eventsBeforeAuthFailures}`)

const goodSig = `sha256=${createHmac('sha256', SECRET).update(kumaPayload).digest('hex')}`
const hmacOk = await post(base, 'kuma', { headers: { 'X-Hub-Signature-256': goodSig }, body: kumaPayload })
check('HMAC 正确 → 202（同一来源的签名路径可用）', hmacOk.status === 202, JSON.stringify(hmacOk))
// github 来源同时配了 token 与 secret：两条鉴权路径要各自都能独立放行
const pushBody = JSON.stringify(gh({ event: 'push', ref: 'refs/heads/main', commits: [{ id: 'a' }] }))
const pushSigOk = await post(base, 'github', { headers: { 'X-Hub-Signature-256': `sha256=${createHmac('sha256', TOKEN).update(pushBody).digest('hex')}` }, body: pushBody })
check('github 来源也可走 HMAC 签名（token 与 secret 并存）', pushSigOk.status === 202, JSON.stringify(pushSigOk))

const unknownSource = await post(base, 'nope', { headers: { 'X-Webhook-Token': TOKEN }, body: '{}' })
check('未知来源 → 404 未知来源', unknownSource.status === 404 && unknownSource.body?.reason === '未知来源', JSON.stringify(unknownSource))
const weirdPath = await request(`${base}/nothing`, { method: 'POST', body: '{}' })
check('非 /hook/ 路径 → 404', weirdPath.status === 404, JSON.stringify(weirdPath))

const getHook = await request(`${base}/hook/github?token=${TOKEN}`)
check('GET → 405', getHook.status === 405, JSON.stringify(getHook))
const putHook = await request(`${base}/hook/github`, { method: 'PUT', headers: { 'X-Webhook-Token': TOKEN }, body: '{}' })
check('PUT → 405', putHook.status === 405, JSON.stringify(putHook))

const badJson = await post(base, 'github', { headers: { 'X-Webhook-Token': TOKEN }, body: '{oops' })
check('非法 JSON → 400', badJson.status === 400 && badJson.body?.reason === '请求体不是合法 JSON', JSON.stringify(badJson))

const boomResponse = await post(base, 'boom', { headers: { 'X-Webhook-Token': TOKEN }, body: '{"a":1}' })
check('onEvent 抛错 → 500', boomResponse.status === 500, JSON.stringify(boomResponse))
check('500 reason 带下游错误且压掉换行', boomResponse.body?.reason.includes('下游发送失败') && !boomResponse.body.reason.includes('\n'), boomResponse.body?.reason)

// 超体积：Content-Length 超限 + 真实大 body 两条路径
const hugeBody = JSON.stringify({ pad: 'x'.repeat(70 * 1024) })
const tooLarge = await post(base, 'big', { headers: { 'X-Webhook-Token': TOKEN, 'content-type': 'application/json' }, body: hugeBody })
check('超过 maxBodyBytes → 413', tooLarge.status === 413, JSON.stringify(tooLarge).slice(0, 120))
check('413 reason 说明上限', String(tooLarge.body?.reason).includes('请求体过大'), tooLarge.body?.reason)
const chunkedLarge = await post(base, 'big', { headers: { 'X-Webhook-Token': TOKEN }, body: hugeBody })
check('大请求体第二条路径同样 413（连接被销毁）', chunkedLarge.status === 413, JSON.stringify(chunkedLarge).slice(0, 120))
const afterOverflow = await post(base, 'big', { headers: { 'X-Webhook-Token': TOKEN }, body: '{"ok":1}' })
check('413 销毁连接后仍能继续服务', afterOverflow.status === 202, JSON.stringify(afterOverflow))

// 限频：ratePerMinute=1，连打两次
const ratePort = await freePort()
const rateReceiver = new WebhookReceiver({
  port: ratePort,
  ratePerMinute: 1,
  sources: [{ name: 'r', token: 'tk', format: 'generic', template: '{a}' }],
  onEvent: async () => {},
  logger: silent,
})
await rateReceiver.start()
const rateBase = `http://127.0.0.1:${ratePort}`
const firstHit = await post(rateBase, 'r', { headers: { 'X-Webhook-Token': 'tk' }, body: '{"a":1}' })
const secondHit = await post(rateBase, 'r', { headers: { 'X-Webhook-Token': 'tk' }, body: '{"a":2}' })
check('限频内第一条 → 202', firstHit.status === 202, JSON.stringify(firstHit))
check('超过 ratePerMinute → 429 触发限频', secondHit.status === 429 && secondHit.body?.reason === '触发限频', JSON.stringify(secondHit))
check('限频计入 dropped', rateReceiver.status().sources[0].dropped === 1 && rateReceiver.status().sources[0].received === 1, JSON.stringify(rateReceiver.status()))
await rateReceiver.stop()

// 限频窗口用注入时钟锁死：窗口内第 2 次被拒，窗口过后又能通过
let fakeNow = 1_800_000_000_000
const windowReceiver = new WebhookReceiver({
  port: await freePort(),
  ratePerMinute: 1,
  now: () => fakeNow,
  sources: [{ name: 'w', token: 'tk' }],
  onEvent: async () => {},
  logger: silent,
})
await windowReceiver.start()
const windowBase = `http://127.0.0.1:${windowReceiver.port}`
const windowFirst = await post(windowBase, 'w', { headers: { 'X-Webhook-Token': 'tk' } })
const windowSecond = await post(windowBase, 'w', { headers: { 'X-Webhook-Token': 'tk' } })
fakeNow += 61_000
const windowThird = await post(windowBase, 'w', { headers: { 'X-Webhook-Token': 'tk' } })
check('限频窗口内第二次被拒', windowFirst.status === 202 && windowSecond.status === 429, `${windowFirst.status}/${windowSecond.status}`)
check('窗口滑过之后重新放行', windowThird.status === 202, String(windowThird.status))
await windowReceiver.stop()

// 注入时钟也让 lastAt 可断言（不受机器时间影响）
const clockPort = await freePort()
const clockReceiver = new WebhookReceiver({
  port: clockPort,
  now: () => 1_700_000_000_123,
  sources: [{ name: 'c', token: 'tk' }],
  onEvent: async () => {},
  logger: silent,
})
await clockReceiver.start()
await post(`http://127.0.0.1:${clockPort}`, 'c', { headers: { 'X-Webhook-Token': 'tk' } })
check('lastAt 取自注入时钟（毫秒）', clockReceiver.status().sources[0].lastAt === 1_700_000_000_123, String(clockReceiver.status().sources[0].lastAt))
await clockReceiver.stop()

// status() 计数
const statusAfter = receiver.status()
const githubStat = statusAfter.sources.find((item) => item.name === 'github')
const bigStat = statusAfter.sources.find((item) => item.name === 'big')
const kumaStat = statusAfter.sources.find((item) => item.name === 'kuma')
check('status() 返回 listening 与 port', statusAfter.listening === true && statusAfter.port === port)
check('status() 每来源都带 received/dropped/lastAt', statusAfter.sources.every((item) => typeof item.received === 'number' && typeof item.dropped === 'number' && typeof item.lastAt === 'number'))
check('received 计数只算成功事件', githubStat.received === 3 && githubStat.dropped === 3, JSON.stringify(githubStat))
check('lastAt 是毫秒时间戳', githubStat.lastAt > 1_600_000_000_000 && githubStat.lastAt <= Date.now(), String(githubStat.lastAt))
check('413 计入 dropped', bigStat.dropped === 2 && bigStat.received === 1, JSON.stringify(bigStat))
check('HMAC 失败计入 dropped', kumaStat.received === 1 && kumaStat.dropped === 3, JSON.stringify(kumaStat))
check('未收到事件的来源 lastAt 为 0', statusAfter.sources.find((item) => item.name === 'slow').lastAt === 0)

// stop() 幂等 + 释放端口
await receiver.stop()
check('stop() 后 listening 为 false', receiver.status().listening === false)
check('stop() 后端口不再接受连接', (await post(base, 'github', { headers: { 'X-Webhook-Token': TOKEN }, body: '{}' })).status === 0)
await receiver.stop()
check('重复 stop() 不抛错', true)
const reuse = new WebhookReceiver({ port, sources: [{ name: 'a', token: 't' }], onEvent: async () => {}, logger: silent })
check('stop() 后端口真正释放（可重新绑定）', await (async () => { try { await reuse.start(); await reuse.stop(); return true } catch (error) { return String(error.message) } })() === true)

// 端口被占用：start() 要抛出可读中文错误
const busyPort = await freePort()
const blocker = createServer((request, response) => response.end('busy'))
await new Promise((resolve) => blocker.listen(busyPort, '127.0.0.1', resolve))
const blocked = new WebhookReceiver({ port: busyPort, sources: [{ name: 'a', token: 't' }], onEvent: async () => {}, logger: silent })
let blockedError = ''
try { await blocked.start() } catch (error) { blockedError = String(error.message) }
check('端口被占用时 start() 抛出可读错误', blockedError.includes(String(busyPort)) && blockedError.includes('占用'), blockedError)
check('端口冲突后 status().listening 仍为 false', blocked.status().listening === false)
blocker.close()

// 构造期参数防御
check('缺 port 时构造抛中文错误', (() => { try { new WebhookReceiver({ sources: [] }); return false } catch (error) { return error.message.includes('port') } })())
check('非法 port（0 / 70000 / 字符串）都抛错', [0, 70000, 'abc', -1].every((bad) => { try { new WebhookReceiver({ port: bad }); return false } catch { return true } }))
const portForGuard = await freePort()
check('onEvent 不是函数时构造抛错', (() => { try { new WebhookReceiver({ port: portForGuard, onEvent: 5 }); return false } catch { return true } })())
check('空 sources 也能构造（只是没有可用来源）', new WebhookReceiver({ port: portForGuard }).status().sources.length === 0)
check('host 默认只绑 127.0.0.1', new WebhookReceiver({ port: portForGuard }).host === '127.0.0.1')
check('maxBodyBytes / ratePerMinute 非法值回落默认', (() => {
  const fallback = new WebhookReceiver({ port: 1, maxBodyBytes: 0, ratePerMinute: -5 })
  return fallback.maxBodyBytes === 65536 && fallback.ratePerMinute === 30 && fallback.destroyOnOverflow === true
})())
check('日志记录启动与鉴权失败', logs.some((line) => line.includes('已监听')) && logs.some((line) => line.includes('鉴权失败')), logs.slice(0, 2).join(' | '))
check('每一条通过鉴权的请求都真的调了 onEvent', onEventCalls === 6, String(onEventCalls))
const boomStat = receiver.status().sources.find((item) => item.name === 'boom')
check('onEvent 抛错的那次记 dropped 不算 received', boomStat.dropped === 1 && boomStat.received === 0, JSON.stringify(boomStat))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
