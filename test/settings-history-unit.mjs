/**
 * 「设置项变更历史」测试（控制台 /api/history + 控制台卡片）。
 *
 * 四层：
 *   ① 纯函数：快照扁平化、old→new diff、密钥脱敏、截断、过滤、文本；
 *   ② 真实 supervisor：拿临时设置文件拍快照 → 改文件 → 记历史 → 读回来，
 *      并钉死"token 等密钥只落 ***"，历史文件里绝不能出现明文；
 *   ③ 真实 HTTP：POST 设置接口会自动记一条（非设置接口不记）、GET /api/history 的
 *      参数透传与 token/Origin 门禁、旧版控制台的可读原因；
 *   ④ 页面静态校验：卡片元素、函数、转义、自动刷新，以及保存配置后立刻回读。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlServer, createToken, readUi } from '../control/lib/server.mjs'
import { createSupervisor } from '../control/lib/supervisor.mjs'
import {
  MAX_CHANGES, MAX_VALUE_CHARS, buildHistoryEntry, diffSettings, displayValue,
  filterHistory, flattenSettings, formatHistory, isSecretKey, parseHistory,
} from '../control/lib/history.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ------------------------------------------------------------ ① 纯函数 ----
check('密钥键识别：token/secret/password', ['token', 'accessToken', 'clientSecret', 'password', 'apiKey'].every(isSecretKey))
check('密钥键识别：普通键不误伤', ['url', 'cwd', 'port', 'host', 'enable'].every((key) => isSecretKey(key) === false))
check('密钥值展示为 ***', displayValue('webui.token', 'super-secret-token') === '***' && displayValue('network.websocketClients[0].token', 'x') === '***')
check('普通值原样展示', displayValue('cwd', 'X:\\work') === 'X:\\work' && displayValue('port', 6099) === '6099')
check('超长值截断并带省略号', displayValue('cwd', 'x'.repeat(MAX_VALUE_CHARS + 50)).length === MAX_VALUE_CHARS + 1)
check('对象值压成 JSON', displayValue('x', { a: 1 }) === '{"a":1}')

const flat = flattenSettings({ cwd: 'D:\\a', ports: { host: 3080 }, clients: [{ url: 'ws://a' }], empty: [], none: {} })
check('扁平化：嵌套与数组下标', flat['ports.host'] === 3080 && flat['clients[0].url'] === 'ws://a', JSON.stringify(flat))
check('扁平化：空数组/空对象有占位', flat.empty === '[]' && flat.none === '{}')

const changed = diffSettings({ a: 1, b: 'x', c: true }, { a: 2, b: 'x', d: false })
check('diff：只报变化，不报相同项', changed.changes.length === 3 && changed.changes.every((item) => item.key !== 'b'), changed.changes.map((c) => c.key).join(','))
check('diff：added/removed/changed 三种', changed.changes.find((c) => c.key === 'a').kind === 'changed'
  && changed.changes.find((c) => c.key === 'c').kind === 'removed'
  && changed.changes.find((c) => c.key === 'd').kind === 'added')
check('diff：无变化返回空', diffSettings({ a: 1 }, { a: 1 }).changes.length === 0)
check('diff：密钥值只留 ***（并标记 secret）', (() => {
  const diff = diffSettings({ token: 'aaa' }, { token: 'bbb' })
  return diff.changes.length === 1 && diff.changes[0].secret === true && diff.changes[0].before === '***' && diff.changes[0].after === '***'
})())
check('diff：数组增删按条目报', (() => {
  const diff = diffSettings({ clients: ['ws://a', 'ws://b'] }, { clients: ['ws://a'] })
  return diff.changes.length === 1 && diff.changes[0].key === 'clients[1]' && diff.changes[0].kind === 'removed'
})(), JSON.stringify(diffSettings({ clients: ['ws://a', 'ws://b'] }, { clients: ['ws://a'] }).changes))
const capped = diffSettings(Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`k${index}`, 1])), Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`k${index}`, 2])))
check('diff：变更条数有上限并记录截断数', capped.changes.length === MAX_CHANGES && capped.truncated === 20, `${capped.changes.length}/${capped.truncated}`)

const snapshot = (files) => ({ at: 1, files })
const file = (name, data, exists = true) => ({ name, file: name, exists, data })
const entry = buildHistoryEntry({
  at: 1_700_000_000_000,
  source: '控制台路径配置',
  route: '/api/config',
  before: snapshot([file('qq-control.json', { cwd: 'D:\\a', ports: { host: 3080 } })]),
  after: snapshot([file('qq-control.json', { cwd: 'D:\\b', ports: { host: 3080 } })]),
})
check('记录：只有一处变化时只写一处', entry && entry.changes.length === 1 && entry.changes[0].key === 'cwd' && entry.changes[0].file === 'qq-control.json')
check('记录：带来源/路由/版本/文件清单', entry.source === '控制台路径配置' && entry.route === '/api/config' && entry.v === 1 && entry.files.includes('qq-control.json'))
check('记录：没有变化返回 null', buildHistoryEntry({ before: snapshot([file('a.json', { x: 1 })]), after: snapshot([file('a.json', { x: 1 })]) }) === null)
check('记录：文件首次出现按 added 记（不是"全变了"）', (() => {
  const added = buildHistoryEntry({ source: 's', before: snapshot([]), after: snapshot([file('webui.json', { port: 6099 })]) })
  return added.changes.length === 1 && added.changes[0].kind === 'added' && added.changes[0].key === 'port'
})())
check('记录：失败也留痕', buildHistoryEntry({ source: 's', ok: false, reason: '写入失败', before: snapshot([file('a.json', { x: 1 })]), after: snapshot([file('a.json', { x: 2 })]) }).ok === false)

const history = [
  { at: 1, source: '控制台路径配置', route: '/api/config', ok: true, changes: [{ file: 'qq-control.json', key: 'cwd', before: 'a', after: 'b' }] },
  { at: 2, source: '账号网络配置（WS 客户端）', route: '/api/accounts/network/save', ok: true, changes: [{ file: 'onebot11_1.json', key: 'network.websocketClients[0].url', before: 'ws://a', after: 'ws://b' }] },
  { at: 3, source: 'NapCat WebUI 配置', route: '/api/accounts/config', ok: false, reason: '端口被占用', changes: [{ file: 'webui.json', key: 'port', before: '6099', after: '6100' }] },
]
check('过滤：按关键词命中键名', filterHistory(history, { q: 'websocketClients' }).length === 1)
check('过滤：按关键词命中旧值/新值', filterHistory(history, { q: 'ws://b' }).length === 1)
check('过滤：按来源前缀', filterHistory(history, { source: '账号网络配置' }).length === 1)
check('过滤：大小写不敏感', filterHistory(history, { q: 'NAPCAT' }).length === 1)
check('过滤：新的在前 + limit 生效', filterHistory(history, { limit: 2 }).map((item) => item.at).join(',') === '3,2')
check('过滤：没有命中就是空', filterHistory(history, { q: '不存在的东西' }).length === 0)

const parsed = parseHistory('{"v":1,"changes":[]}\n不是JSON\n\n{"v":1,"changes":[{"key":"a"}]}\n')
check('解析：坏行跳过，好行保留', parsed.length === 2, String(parsed.length))
const text = formatHistory(history)
check('文本：带条数、来源与 old → new', text.includes('最近 3 条') && text.includes('cwd：a → b') && text.includes('→ ws://b'))
check('文本：失败原因写出来', text.includes('失败：端口被占用'))
check('文本：空历史有说明', formatHistory([]) === '（还没有设置变更记录）')
check('文本：容忍非数组', formatHistory(null).includes('还没有'))

// ------------------------------------------------------ ② 真实 supervisor ----
const dir = mkdtempSync(join(tmpdir(), 'qq-history-'))
const cwd = join(dir, 'live')
mkdirSync(cwd, { recursive: true })
const configFile = join(dir, 'qq-control.json')
const writeControl = (data) => writeFileSync(configFile, JSON.stringify(data, null, 2) + '\n', 'utf8')
writeControl({ cwd: 'D:\\a', ports: { control: 8799, host: 3080 }, napcatBat: '', token: 'control-token-plain' })
const napcatBat = join(dir, 'napcat', 'launcher.bat')
const napcatDir = join(dir, 'napcat', 'config')
mkdirSync(napcatDir, { recursive: true })
writeFileSync(napcatBat, '@echo off\n', 'utf8')
const webuiFile = join(napcatDir, 'webui.json')
writeFileSync(webuiFile, JSON.stringify({ host: '127.0.0.1', port: 6099, token: 'napcat-secret-token' }, null, 2) + '\n', 'utf8')
const onebotFile = join(napcatDir, 'onebot11_10001.json')
writeFileSync(onebotFile, JSON.stringify({ network: { websocketClients: [{ url: 'ws://127.0.0.1:6700', token: '' }] } }, null, 2) + '\n', 'utf8')

const noExec = (command, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  if (command === 'netstat') return done(null, '  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    555\n', '')
  if (command === 'tasklist') return done(null, '"node.exe","555","Console","1","100 K"\n', '')
  return done(new Error('not stubbed'), '', '')
}
const config = {
  cwd,
  pluginRoot: join(dir, 'plugin-root'),
  nodeExe: process.execPath,
  napcatBat,
  ports: { control: 18811, host: 3080, onebot: 6700, napcat: 6099, tts: 9880 },
  logs: {
    trace: join(cwd, 'qq-trace.jsonl'), runtime: join(cwd, 'qq-runtime.json'),
    audit: join(cwd, 'qq-actions.log'), inbox: join(cwd, 'qq-inbox.jsonl'),
    inject: join(cwd, 'qq-inject.jsonl'), hostOut: join(cwd, 'h.out'), bridge: join(cwd, 'b.log'),
  },
}
const sup = createSupervisor(config, { exec: noExec, configFile, logger: { info() {}, warn() {}, error() {} } })
const snap = sup.settingsSnapshot()
check('快照包含控制台配置 + WebUI + 账号 OneBot 配置',
  ['qq-control.json', 'webui.json', 'onebot11_10001.json'].every((name) => snap.files.some((file) => file.name === name)),
  snap.files.map((file) => file.name).join(','))
check('快照带解析后的数据（webui 的 token 在内存里，落盘时会脱敏）',
  snap.files.find((file) => file.name === 'webui.json')?.data?.token === 'napcat-secret-token')

const noChange = sup.recordSettingsChange({ source: '控制台路径配置', before: snap, after: sup.settingsSnapshot() })
check('没有变化时不写空记录', noChange.recorded === false)

writeControl({ cwd: 'D:\\b', ports: { control: 8799, host: 3080 }, napcatBat: '', token: 'control-token-plain' })
const recorded = sup.recordSettingsChange({ source: '控制台路径配置', route: '/api/config', before: snap, after: sup.settingsSnapshot() })
check('有变化时写一条记录', recorded.recorded === true && recorded.entry.changes.length === 1, JSON.stringify(recorded.entry?.changes ?? []))
check('记录内容就是 old → new', recorded.entry.changes[0].key === 'cwd' && recorded.entry.changes[0].before === 'D:\\a' && recorded.entry.changes[0].after === 'D:\\b')
const historyFile = join(cwd, 'qq-settings-history.jsonl')
check('历史文件按 JSONL 追加', JSON.parse(readFileSync(historyFile, 'utf8').trim()).v === 1)

// 改 WebUI token：值必须落 ***，历史文件里绝不许出现明文
const webuiBefore = sup.settingsSnapshot()
writeFileSync(webuiFile, JSON.stringify({ host: '127.0.0.1', port: 6100, token: 'napcat-new-secret' }, null, 2) + '\n', 'utf8')
const secretEntry = sup.recordSettingsChange({ source: 'NapCat WebUI 配置', before: webuiBefore, after: sup.settingsSnapshot() })
check('WebUI 端口变化被记录', secretEntry.recorded === true && secretEntry.entry.changes.some((change) => change.key === 'port'))
const tokenChange = secretEntry.entry.changes.find((change) => change.key === 'token')
check('token 变化只记 *** 并标 secret', tokenChange && tokenChange.secret === true && tokenChange.before === '***' && tokenChange.after === '***', JSON.stringify(tokenChange))
const rawHistory = readFileSync(historyFile, 'utf8')
check('历史文件里没有明文 token', rawHistory.includes('napcat-secret-token') === false && rawHistory.includes('napcat-new-secret') === false)
check('历史文件里也没有控制台 token', rawHistory.includes('control-token-plain') === false)

const listed = sup.settingsHistory()
check('读回：新的在前、总数正确', listed.total === 2 && listed.entries[0].source === 'NapCat WebUI 配置')
check('读回：带文本视图与文件路径', typeof listed.text === 'string' && listed.text.includes('设置项变更历史') && listed.file.endsWith('qq-settings-history.jsonl'))
check('读回：关键词过滤', sup.settingsHistory({ q: 'webui' }).entries.length === 1)
check('读回：limit 生效', sup.settingsHistory({ limit: 1 }).entries.length === 1)

// ------------------------------------------------------------- ③ HTTP ----
const token = createToken()
const recordedCalls = []
const stubApi = {
  status: async () => ({ ports: [], processes: {}, warnings: [], config: {}, scannedAt: Date.now() }),
  logFile: () => '',
  settingsSnapshot: () => ({ at: Date.now(), files: [{ name: 'qq-control.json', file: configFile, exists: true, data: { cwd: 'D:\\x' } }] }),
  recordSettingsChange: (entry) => { recordedCalls.push(entry); return { ok: true, recorded: true } },
  settingsHistory: ({ limit, q }) => ({ ok: true, file: 'qq-settings-history.jsonl', total: 2, entries: [{ at: 1, source: `stub-${limit}-${q}`, changes: [] }], text: 'stub text' }),
  inject: () => ({ ok: true, reason: '注入已入队' }),
  accounts: { saveNetworkClients: () => ({ ok: true, message: '已写入' }) },
}
const server = createControlServer({
  config,
  token,
  api: stubApi,
  ui: '<h1>console</h1>',
  saveConfig: () => true,
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const post = (path, body, headers = {}) => fetch(`${base}${path}?token=${token}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body ?? {}),
})
const configResponse = await post('/api/config', { cwd: 'D:\\x' })
check('保存路径配置成功', configResponse.status === 200 && (await configResponse.json()).ok === true)
check('设置接口会记一条变更（来源是中文，不是路径）', recordedCalls.length === 1 && recordedCalls[0].source === '控制台路径配置' && recordedCalls[0].route === '/api/config', JSON.stringify(recordedCalls[0]?.source))
check('记录带动作前后的两份快照', Boolean(recordedCalls[0].before) && Boolean(recordedCalls[0].after))
const injectResponse = await post('/api/inject', { spec: { text: 'hi' } })
check('非设置接口（注入）不记变更', injectResponse.status === 200 && recordedCalls.length === 1, String(recordedCalls.length))
const networkResponse = await post('/api/accounts/network/save', { uin: '10001', clients: [] })
check('账号网络配置也记变更（来源标明是哪一段）',
  networkResponse.status === 200 && recordedCalls.length === 2 && recordedCalls[1].source === '账号网络配置（WS 客户端）',
  JSON.stringify(recordedCalls.map((call) => call.source)))
const failedSave = await post('/api/config', {})  // 空 patch → 接口自己返回 ok:false
check('失败的设置动作也记录（ok=false）', failedSave.status === 200 && recordedCalls.length === 3 && recordedCalls[2].ok === false)

const historyResponse = await fetch(`${base}/api/history?limit=7&q=webui&token=${token}`)
const historyBody = await historyResponse.json()
check('GET /api/history 返回记录与文本', historyResponse.status === 200 && historyBody.ok === true && Array.isArray(historyBody.entries) && historyBody.text === 'stub text')
check('limit 与 q 透传到 supervisor', historyBody.entries[0].source === 'stub-7-webui', historyBody.entries[0].source)
check('历史接口需要 token', (await fetch(`${base}/api/history`)).status === 401)
check('历史接口拒绝跨站 Origin',
  (await fetch(`${base}/api/history?token=${token}`, { headers: { Origin: 'https://evil.example' } })).status === 403)
server.close()

const legacy = createControlServer({ config, token, api: { status: async () => ({}), logFile: () => '' }, ui: '' })
await new Promise((resolve) => legacy.listen(0, '127.0.0.1', resolve))
const legacyBody = await (await fetch(`http://127.0.0.1:${legacy.address().port}/api/history?token=${token}`)).json()
check('旧控制台返回可读的不支持原因', legacyBody.ok === false && legacyBody.reason.includes('设置变更历史'))
legacy.close()

// ------------------------------------------------------- ④ 页面静态 ----
const ui = readUi(join(import.meta.dirname, '..', 'control', 'ui.html'))
for (const id of ['history', 'historyQ', 'historyCount']) {
  if (!ui.includes(`id="${id}"`)) { failed++; console.log('FAIL', `控制台缺少元素 #${id}`) }
}
check('控制台有设置变更历史卡片', ui.includes('设置项变更历史'))
const script = /<script>([\s\S]*)<\/script>/.exec(ui)?.[1] ?? ''
for (const fn of ['loadChangeHistory', 'renderChangeHistory', 'copyChangeHistory', 'describeHistoryChange']) {
  if (!new RegExp(`(async )?function ${fn}\\(`).test(script)) { failed++; console.log('FAIL', `控制台缺少函数 ${fn}`) }
}
check('历史卡片函数齐全', true)
check('脚本可解析', (() => { try { new Function(script); return true } catch { return false } })())
check('页面请求 /api/history', script.includes("api('/api/history?limit=200')"))
check('加载时会拉历史', script.includes('loadChangeHistory();'))
check('保存配置后会立刻回读历史', /async function saveConfig[\s\S]{0,700}loadChangeHistory\(/.test(script))
check('可见时定时刷新历史', /setInterval\(\(\) => \{ if \(!document\.hidden\) loadChangeHistory\(false\); \}, 30000\)/.test(script))
check('关键词过滤在前端即时生效', ui.includes('oninput="renderChangeHistory()"') && script.includes('historyQ'))
// 回归：事件流历史有自己的 loadHistory()（/api/trace），不能被设置历史的函数顶掉
check('事件流历史加载器没被顶掉', (script.match(/function loadHistory\(/g) ?? []).length === 1
  && script.includes("api('/api/trace?limit=300')")
  && script.includes('loadHistory().then(() => startStream())'))
check('历史内容统一走 escapeHtml', /escapeHtml\(describeHistoryChange/.test(script) && /escapeHtml\(entry\.source/.test(script))
check('可以复制完整历史文本', script.includes('navigator.clipboard.writeText(historyText)'))
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
check('package.json files 覆盖 control（历史页随包分发）', (pkg.files ?? []).includes('control'))
check('历史文件不进 git（qq-*.jsonl 已被忽略）', readFileSync(join(import.meta.dirname, '..', '.gitignore'), 'utf8').includes('qq-*.jsonl'))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
