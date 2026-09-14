/**
 * Unit + HTTP tests for the standalone control console (no real machine access:
 * every side effect is injected, and the server is exercised with real requests
 * against a stubbed supervisor).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORTS, PORT_LABELS, configWarnings, detectDshBin, detectPaths, loadControlConfig, saveControlConfig } from '../control/lib/config.mjs'
import {
  NAPCAT_LOADER_NAMES, QR_STALE_SECONDS, assertKillAllowed, createSupervisor, extractHostUrl, inspect,
  killTree, napcatLaunchCommand, napcatRestartCommand, parseNetstat, parseTasklist,
  portOf, publicConfig, qrStatus, run, startDetached, summarizePorts, tailLines,
} from '../control/lib/supervisor.mjs'
import { createControlServer, createToken, originAllowed, readUi } from '../control/lib/server.mjs'
import { groupsView, jobsView, perfReport } from '../control/lib/perf.mjs'
import { BROWSER_CANDIDATES, buildOpenCommand, openPanel, pickBrowser } from '../control/lib/open.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-control-test-'))
const here0 = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- parsing ----
const NETSTAT = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       25700
  TCP    127.0.0.1:6700         0.0.0.0:0              LISTENING       25700
  TCP    127.0.0.1:6700         127.0.0.1:52344        ESTABLISHED     25700
  TCP    127.0.0.1:6099         0.0.0.0:0              LISTENING       4100
  TCP    [::]:8799              [::]:0                 LISTENING       9001
  UDP    0.0.0.0:5353           *:*                                    1234
`
const rows = parseNetstat(NETSTAT)
check('netstat 解析出 5 条 TCP', rows.filter((row) => row.proto === 'TCP').length === 5, `rows=${rows.length}`)
check('netstat 提取本地端口', rows.some((row) => row.localPort === 3080 && row.state === 'LISTENING' && row.pid === 25700))
check('netstat 识别 ESTABLISHED', rows.some((row) => row.localPort === 6700 && row.state === 'ESTABLISHED'))
check('netstat 支持 IPv6 地址', rows.some((row) => row.localPort === 8799 && row.pid === 9001))
check('netstat 忽略表头与空行', !rows.some((row) => row.pid === 0))

const TASKLIST = `"node.exe","25700","Console","1","120,000 K"
"QQ.exe","4100","Console","1","300,000 K"
"python.exe","7777","Console","1","80,000 K"
`
const tasks = parseTasklist(TASKLIST)
check('tasklist 解析 pid→进程名', tasks.get(25700) === 'node.exe' && tasks.get(4100) === 'QQ.exe')
check('portOf 处理各种地址', portOf('127.0.0.1:3080') === 3080 && portOf('[::]:6700') === 6700 && portOf('0.0.0.0:0') === 0 && portOf('') === 0)

const summary = summarizePorts(rows, tasks, DEFAULT_PORTS, PORT_LABELS)
const host = summary.find((item) => item.name === 'host')
const onebot = summary.find((item) => item.name === 'onebot')
check('端口摘要：宿主监听与占用者', host.listening === true && host.pid === 25700 && host.process === 'node.exe')
check('端口摘要：6700 记录连接数', onebot.listening === true && onebot.established === 1)
check('端口摘要：未监听端口', summary.find((item) => item.name === 'tts').listening === false)
check('端口摘要带中文标签', summary.every((item) => item.label.length > 0))

// ------------------------------------------------------------------ reads ----
const logFile = join(dir, 'host.log')
writeFileSync(logFile, [
  'dsh web: http://127.0.0.1:3080/?token=xZRVGw6peedZUCdn6w_yh617gQFmKXURCLkjylA5Amc',
  'dsh web: opening the default browser; pass --no-open to disable',
].join('\n'), 'utf8')
check('从宿主日志提取 3080 token 链接', extractHostUrl(tailLines(logFile, 10).join('\n')) === 'http://127.0.0.1:3080/?token=xZRVGw6peedZUCdn6w_yh617gQFmKXURCLkjylA5Amc')
check('多次启动时取最新 token（避免 401）', extractHostUrl([
  'dsh web: http://127.0.0.1:3080/?token=OLD_token_value',
  'dsh web: opening the default browser; pass --no-open to disable',
  'dsh web: http://127.0.0.1:3080/?token=NEW_token_value',
].join('\n')) === 'http://127.0.0.1:3080/?token=NEW_token_value')
check('无 token 时返回空串', extractHostUrl('nothing here') === '')
check('tailLines 返回末 N 行', tailLines(logFile, 1).filter((line) => line !== '').length === 1)
check('tailLines 缺失文件安全', tailLines(join(dir, 'nope.log'), 5).length === 0)

const qrFile = join(dir, 'qrcode.png')
writeFileSync(qrFile, 'x')
const fresh = qrStatus(qrFile, Date.now())
const stale = qrStatus(qrFile, Date.now() + 600_000)
check('二维码新鲜度判定', fresh.exists === true && fresh.fresh === true && stale.fresh === false, JSON.stringify({ fresh: fresh.ageSeconds, stale: stale.ageSeconds }))
check('二维码缺失安全', qrStatus(join(dir, 'none.png')).exists === false)

// ------------------------------------------------------------------ config ----
const configFile = join(dir, 'qq-control.json')
const { config } = loadControlConfig(configFile, { env: {}, exists: () => false, readdir: () => [] })
check('默认端口正确', config.ports.onebot === 6700 && config.ports.control === 8799 && config.ports.host === 3080)
check('配置文件缺失时用探测结果', config.cwd === process.cwd() || config.cwd.length > 0, config.cwd)
check('端口覆盖生效', loadControlConfig(configFile, { env: {}, exists: () => false, readdir: () => [] }).config.ports.onebot === 6700)
const overridden = detectPaths({ ports: { control: 9999 } }, { env: {}, exists: () => false, readdir: () => [] })
check('端口部分覆盖保留其余默认值', overridden.ports.control === 9999 && overridden.ports.onebot === 6700)
check('nodeExe 默认指向当前 node', overridden.nodeExe === process.execPath)
check('配置可保存并回读', (() => {
  const ok = saveControlConfig(configFile, { ports: { control: 8799, host: 3080, onebot: 6700, napcat: 6099, tts: 9880 }, cwd: 'D:\\qq-bridge-work' })
  const back = JSON.parse(readFileSync(configFile, 'utf8'))
  return ok && back.cwd === 'D:\\qq-bridge-work' && back.ports.onebot === 6700
})())

const detected = detectDshBin({
  roots: ['C:/fake/npx'],
  readdir: () => [{ name: 'aaa', isDirectory: () => true }, { name: 'bbb', isDirectory: () => true }, { name: 'file.txt', isDirectory: () => false }],
  exists: (path) => path.includes('bbb') || path.includes('aaa'),
})
check('npx 缓存探测返回候选 bin.js', detected.includes('@deepseek-ai') && detected.includes('bin.js'), detected)
check('npx 缓存为空时返回空串', detectDshBin({ roots: [], readdir: () => [], exists: () => false }) === '')

const warnings = configWarnings({ ports: { control: 8799 }, nodeExe: process.execPath, dshBin: 'C:/nope/bin.js', napcatBat: '', cwd: '' })
check('配置提醒：缺 dsh bin / napcat / cwd', warnings.some((w) => w.includes('dsh bin.js')) && warnings.some((w) => w.includes('NapCat')) && warnings.some((w) => w.includes('工作目录')), warnings.join(' | '))
check('配置提醒：非法端口', configWarnings({ ports: { onebot: 70000 }, nodeExe: process.execPath }).some((w) => w.includes('端口配置非法')))

// ----------------------------------------------------------------- guards ----
const snapshot = {
  ports: summarizePorts(rows, tasks, DEFAULT_PORTS, PORT_LABELS),
  processes: {
    napcat: [{ pid: 4100, name: 'QQ.exe' }],
    napcatLoaders: [{ pid: 4100, name: 'NapCatWinBootMain.exe' }],
    qqClients: [{ pid: 4100, name: 'QQ.exe' }, { pid: 4200, name: 'QQ.exe' }],
    napcatManaged: true,
    tts: [],
  },
}
check('允许杀掉占用受管端口的进程', assertKillAllowed(25700, { snapshot, ports: DEFAULT_PORTS }).ok === true)
check('允许杀掉 NapCat 加载器', assertKillAllowed(4100, { snapshot, ports: DEFAULT_PORTS }).ok === true)
check('拒绝按名字杀个人 QQ 客户端', assertKillAllowed(4200, { snapshot, ports: DEFAULT_PORTS }).ok === false, assertKillAllowed(4200, { snapshot, ports: DEFAULT_PORTS }).reason)
check('拒绝杀掉无关 PID', assertKillAllowed(12345, { snapshot, ports: DEFAULT_PORTS }).ok === false, assertKillAllowed(12345, { snapshot, ports: DEFAULT_PORTS }).reason)
check('拒绝杀掉控制台自身', assertKillAllowed(process.pid, { snapshot, ports: DEFAULT_PORTS }).ok === false)
check('拒绝非法 PID', assertKillAllowed('abc', { snapshot }).ok === false && assertKillAllowed(-1, { snapshot }).ok === false)

// ------------------------------------------------------------- supervisor ----
const okExec = (command, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  const output = command === 'netstat' ? NETSTAT : TASKLIST
  done(null, output, '')
}
const supervisor = createSupervisor({ ...config, cwd: dir, logs: { hostOut: logFile, hostErr: join(dir, 'err.log'), bridge: join(dir, 'bridge.log') } }, { exec: okExec })
const status = await supervisor.status()
check('supervisor.status 汇总端口', status.ports.length === 5 && status.ports.some((item) => item.port === 6700 && item.listening))
check('supervisor.status 识别机器人在线', status.botOnline === true)
check('supervisor.status 附带 3080 控制台链接', status.hostUrl.includes('token='))
check('supervisor.status 附带配置与提醒', typeof status.config.cwd === 'string' && Array.isArray(status.warnings))
check('logFile 映射正确', supervisor.logFile('hostOut') === logFile && supervisor.logFile('bridge').endsWith('bridge.log') && supervisor.logFile('unknown') === '')

const busyExec = (command, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  if (command === 'netstat') return done(null, '  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    555\n', '')
  return done(null, '"node.exe","555","Console","1","1 K"\n', '')
}
const busySupervisor = createSupervisor({ ...config, nodeExe: process.execPath, dshBin: 'C:/dsh/bin.js', logs: {} }, { exec: busyExec })
const refused = await busySupervisor.startHost()
check('端口被占时拒绝启动宿主并报占用者', refused.ok === false && refused.reason.includes('3080') && refused.reason.includes('555'), refused.reason)
const freed = await busySupervisor.freePort('host')
check('freePort 走护栏并尝试结束进程', typeof freed.ok === 'boolean' && (freed.reason.includes('已结束') || freed.reason.includes('拒绝')), freed.reason)
const unknownPort = await busySupervisor.freePort('nope')
check('未知端口名被拒', unknownPort.ok === false && unknownPort.reason.includes('未知端口名'))
const notListening = await busySupervisor.freePort('tts')
check('未监听端口无需释放', notListening.ok === false && notListening.reason.includes('没有监听进程'))

const noBin = createSupervisor({ ...config, dshBin: '', nodeExe: '' }, { exec: okExec })
check('缺 dshBin 时 startHost 明确报错', (await noBin.startHost()).reason.includes('dshBin'))
const noNapcat = createSupervisor({ ...config, napcatBat: '' }, { exec: okExec })
check('缺 napcatBat 时 startNapcat 明确报错', (await noNapcat.startNapcat()).reason.includes('napcatBat'))
const missingNapcat = createSupervisor({ ...config, napcatBat: join(dir, 'none.bat') }, { exec: okExec, exists: () => false })
check('napcatBat 不存在时明确报错', (await missingNapcat.startNapcat()).reason.includes('不存在'))

// 个人 QQ 在跑但 NapCat 没跑 → 绝不能杀
const personalQqExec = (command, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback
  if (command === 'netstat') return done(null, '  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    555\n', '')
  return done(null, '"QQ.exe","4200","Console","1","1 K"\n"QQEX.exe","4300","Console","1","1 K"\n', '')
}
const personalQq = createSupervisor({ ...config, nodeExe: process.execPath, dshBin: 'C:/dsh/bin.js', logs: {} }, { exec: personalQqExec })
const personalStatus = await personalQq.status()
check('识别个人 QQ 客户端但标记为不受管', personalStatus.processes.qqClients.length === 2 && personalStatus.processes.napcatManaged === false && personalStatus.processes.napcat.length === 0)
const refusedNapcat = await personalQq.stopNapcat()
check('拒绝结束个人 QQ 客户端', refusedNapcat.ok === false && refusedNapcat.reason.includes('个人版'), refusedNapcat.reason)

// 启动宿主：spawn 被替换，只检查命令构造
let spawned = null
const spawnStub = (command, args, options) => { spawned = { command, args, options }; return { pid: 4242, unref() {} } }
const starter = createSupervisor({ ...config, cwd: dir, nodeExe: 'node.exe', dshBin: 'C:/dsh/bin.js', logs: { hostOut: join(dir, 'o.log'), hostErr: join(dir, 'e.log') } }, { exec: (c, a, o, cb) => (typeof o === 'function' ? o : cb)(null, '', ''), spawnImpl: spawnStub })
const started = await starter.startHost()
check('startHost 用 --no-open 启动且不弹浏览器', started.ok === true && spawned.args.includes('web') && spawned.args.includes('--no-open'), JSON.stringify(spawned))
check('startHost 返回 PID', started.pid === 4242)
check('startDetached 拒绝空命令', (() => { try { startDetached({ command: '' }); return false } catch { return true } })())

// --------------------------------------------------------------- server ------
const token = createToken()
check('token 足够长且 URL 安全', token.length >= 20 && /^[A-Za-z0-9_-]+$/.test(token))
check('Origin 校验：同源放行', originAllowed('http://127.0.0.1:8799', 8799) === true)
check('Origin 校验：其他站点拒绝', originAllowed('https://evil.example', 8799) === false)
check('Origin 校验：其它本地端口拒绝', originAllowed('http://127.0.0.1:3080', 8799) === false)
check('Origin 校验：缺失（curl）放行给 token 把关', originAllowed(undefined, 8799) === true)
check('Origin 校验：垃圾值拒绝', originAllowed('not-a-url', 8799) === false)

const stubApi = {
  status: async () => ({ ports: [], processes: { napcat: [], tts: [] }, botOnline: false, warnings: [], config: publicConfig(detected), scannedAt: Date.now() }),
  logFile: () => logFile,
  startHost: async () => ({ ok: true, pid: 1, reason: '宿主已启动' }),
  stopHost: async () => ({ ok: true, reason: '宿主已停止' }),
  freePort: async (name) => ({ ok: true, reason: `已释放 ${name}` }),
  startNapcat: async () => ({ ok: true, reason: 'napcat 启动' }),
  stopNapcat: async () => ({ ok: true, reason: 'napcat 停止' }),
  startTts: async () => ({ ok: true, reason: 'tts 启动' }),
  stopTts: async () => ({ ok: true, reason: 'tts 停止' }),
  stopAll: async () => ({ ok: true, reason: '全部停止' }),
  archiveStats: async () => ({ ok: true, dir: 'X:\\qq-history', files: 2, bytes: 2048, oldest: '2026-09-01', newest: '2026-09-02', trashDirs: ['2026-09-03'] }),
  archiveSearch: async (query, options) => ({
    ok: true, query, days: options.days, limit: options.limit, chatKey: options.chatKey,
    hits: [{ ts: 1700000000000, chatKey: 'g:1', userId: 1001, name: '小明', text: 'x' }], scanned: 3, files: ['2026-09-02.jsonl'], truncated: false,
  }),
  // v0.5.5「控制台看得见」：三个新面板。stub 记录收到的参数，好断言透传与夹取。
  perf: async (options) => {
    stubApi.lastPerf = options
    return { ok: true, ...perfReport([{ ts: 1000, id: 'a', stage: 'inbound', ok: true, chatKey: 'g:1' }, { ts: 1400, id: 'a', stage: 'reply', ok: true, ms: 400, chatKey: 'g:1' }, { ts: 2000, id: 'b', stage: 'inbound', ok: true, chatKey: 'g:1' }, { ts: 3000, id: 'b', stage: 'reply', ok: true, ms: 1000, chatKey: 'g:1' }], options) }
  },
  jobsView: async () => ({ ok: true, ...jobsView({ jobs: { broadcast: [{ id: 'news', kind: 'rss', chat: 'g:2002', enabled: true, nextAt: Date.now() + 60_000, runs: 2, failures: 0 }], webhook: { enabled: true, port: 8798, sources: [{ name: 'ci', received: 1, dropped: 0, lastAt: 1 }] }, autoHeal: { enabled: false, commandConfigured: false } }, injection: { enabled: true, dryRun: true, queued: 0, consumed: 0 } }) }),
  groups: async () => ({ ok: true, ...groupsView({ features: { engageEnabled: true, groupOpsEnabled: false }, replay: { allowGroups: [2002] }, sessions: [{ chatKey: 'g:2002', sessionId: 's', status: 'idle', lastTurnAt: 1 }], jobs: { broadcast: [] } }) }),
  // v0.5.5 阶段 4：注入场景库与回放 diff
  inject: async (spec) => { stubApi.lastInject = spec; return { ok: true, reason: '已入队', preview: '×' } },
  replay: async (options) => {
    stubApi.replayCalls = (stubApi.replayCalls ?? 0) + 1
    const on = options.overrides && options.overrides.keywordEnabled === true
    return { ok: true, results: [{ index: 0, entry: { chatKey: 'g:2002', text: 'hi' }, decision: on, reply: on ? '命中关键词' : '', reason: on ? '' : '没 @ 机器人' }] }
  },
}
let savedPatch = null
const server = createControlServer({
  config: { ...detected, ports: { ...DEFAULT_PORTS, control: 18799 } },
  token,
  api: stubApi,
  ui: '<h1>console</h1>',
  saveConfig: (patch) => { savedPatch = patch; return true },
})
await new Promise((resolve) => server.listen(18799, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:18799'

const uiResponse = await fetch(base + '/')
check('根路径返回 UI', uiResponse.status === 200 && (await uiResponse.text()).includes('console'))
check('未知路径 404', (await fetch(base + '/nope')).status === 404)
const noToken = await fetch(base + '/api/status')
check('无 token 返回 401', noToken.status === 401, String(noToken.status))
const badToken = await fetch(base + '/api/status?token=wrong')
check('错误 token 返回 401', badToken.status === 401)
const crossSite = await fetch(base + '/api/status?token=' + token, { headers: { Origin: 'https://evil.example' } })
check('跨站 Origin 返回 403', crossSite.status === 403, String(crossSite.status))
const goodStatus = await fetch(base + '/api/status?token=' + token)
const statusBody = await goodStatus.json()
check('带 token 返回状态', goodStatus.status === 200 && statusBody.ok === true && Array.isArray(statusBody.ports))
const archiveStats = await (await fetch(base + '/api/archive?token=' + token)).json()
check('GET /api/archive 返回归档概览', archiveStats.ok === true && archiveStats.files === 2 && archiveStats.bytes === 2048, JSON.stringify(archiveStats))
const archiveSearchRes = await (await fetch(base + '/api/archive?q=hi&days=3&limit=5&chatKey=g%3A1&token=' + token)).json()
check('GET /api/archive?q= 走检索并透传参数', archiveSearchRes.ok === true && archiveSearchRes.query === 'hi' && archiveSearchRes.days === 3 && archiveSearchRes.limit === 5 && archiveSearchRes.chatKey === 'g:1', JSON.stringify(archiveSearchRes))
check('检索结果带命中与扫描数', Array.isArray(archiveSearchRes.hits) && archiveSearchRes.hits.length === 1 && archiveSearchRes.scanned === 3)
const archiveClamp = await (await fetch(base + '/api/archive?q=hi&days=99999&limit=0&token=' + token)).json()
check('days/limit 被夹到合法区间', archiveClamp.days === 3650 && archiveClamp.limit === 20, JSON.stringify({ days: archiveClamp.days, limit: archiveClamp.limit }))

// ---- v0.5.6：扫码页 / 二维码 / 重启登录流程（这三个都是真机踩出来的坑） ----
stubApi.qr = async () => ({
  ok: true, exists: true, fresh: false, ageSeconds: 520, mtimeMs: 1,
  path: 'C:\\x\\qrcode.png', staleSeconds: QR_STALE_SECONDS,
  dataUrl: 'data:image/png;base64,AAAA', hint: '这张二维码是 8 分钟前生成的，已经过期',
})
const qrBody = await (await fetch(base + '/api/qr?token=' + token)).json()
check('GET /api/qr 返回新鲜度与过期提示',
  qrBody.ok === true && qrBody.fresh === false && qrBody.ageSeconds === 520 && qrBody.hint.includes('过期'),
  JSON.stringify(qrBody))
check('GET /api/qr 直接带出图片 dataUrl（页面不用再开一个端口）', String(qrBody.dataUrl).startsWith('data:image/png;base64,'))
stubApi.restartNapcatLogin = async () => ({ ok: true, pid: 4242, reason: '已请求提权重启登录流程' })
const restartBody = await (await fetch(base + '/api/napcat/restart?token=' + token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
check('POST /api/napcat/restart 走到重启登录流程', restartBody.ok === true && restartBody.pid === 4242, JSON.stringify(restartBody))
const noQr = await fetch(base + '/api/napcat/restart?token=wrong', { method: 'POST', body: '{}' })
check('重启接口同样要 token', noQr.status === 401, String(noQr.status))

// ---- v0.5.5 三个新面板：性能 / 定时任务 / 群配置 ----
const perfBody = await (await fetch(base + '/api/perf?token=' + token)).json()
check('GET /api/perf 返回 P50/P95 与结论',
  perfBody.ok === true && perfBody.chains.count === 2 && perfBody.chains.p50 === 400 && perfBody.chains.p95 === 1000,
  JSON.stringify(perfBody.chains))
check('GET /api/perf 带上人话结论', typeof perfBody.verdict === 'string' && perfBody.verdict.includes('P50'), perfBody.verdict)
const perfScoped = await (await fetch(base + '/api/perf?chatKey=g%3A1&window=30&limit=100&token=' + token)).json()
const perfArgs = stubApi.lastPerf
check('GET /api/perf 透传 chatKey 与 window', perfArgs.chatKey === 'g:1' && perfArgs.windowMinutes === 30 && perfArgs.limit === 100, JSON.stringify(perfArgs))
check('GET /api/perf 按会话过滤后仍有数据', perfScoped.ok === true && perfScoped.chains.count === 2)
const perfClamp = await (await fetch(base + '/api/perf?limit=999999&window=99999&token=' + token)).json()
check('GET /api/perf 的 limit/window 被夹到合法区间',
  stubApi.lastPerf.limit === 20000 && stubApi.lastPerf.windowMinutes === 1440, JSON.stringify(stubApi.lastPerf))

const jobsBody = await (await fetch(base + '/api/jobs?token=' + token)).json()
check('GET /api/jobs 返回播报任务', jobsBody.ok === true && jobsBody.broadcast.rows.length === 1 && jobsBody.broadcast.rows[0].id === 'news', JSON.stringify(jobsBody.broadcast.rows))
check('GET /api/jobs 带上下次时间的人话文案', jobsBody.broadcast.rows[0].nextText.includes('后'), jobsBody.broadcast.rows[0].nextText)
check('GET /api/jobs 带 webhook 来源与自愈状态',
  jobsBody.webhook.sources[0].name === 'ci' && jobsBody.autoHeal.enabled === false, JSON.stringify(jobsBody.webhook.sources))
check('GET /api/jobs 不含自愈命令原文', jobsBody.autoHeal.command === undefined && !JSON.stringify(jobsBody).includes('autoHealCommand'))

const groupsBody = await (await fetch(base + '/api/groups?token=' + token)).json()
check('GET /api/groups 返回开关表与群列表', groupsBody.ok === true && groupsBody.switches.length >= 16 && groupsBody.groups.length === 1, JSON.stringify(groupsBody.groups))
check('GET /api/groups 标出白名单状态（读 replay.allowGroups）', groupsBody.groups[0].allowlisted === true, JSON.stringify(groupsBody.groups[0]))
check('GET /api/groups 说明开关真源在插件配置', groupsBody.note.includes('cordis.patch.yml'), groupsBody.note)
check('GET /api/groups 统计打开的开关数', groupsBody.onCount === 1, String(groupsBody.onCount))

// ---- v0.5.5 阶段 4：注入场景库 + 回放 diff ----
const scen = await (await fetch(base + '/api/scenarios?token=' + token)).json()
check('GET /api/scenarios 返回场景清单', scen.ok === true && scen.scenarios.length >= 15, `len=${scen.scenarios?.length}`)
check('场景清单不泄露 build 函数', scen.scenarios.every((s) => s.build === undefined && s.name && s.needs))
const postJson = (path, body) => fetch(base + path + '?token=' + token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const injOk = await (await postJson('/api/inject', { scenario: 'group-mention', params: { groupId: 2002, userId: 10001 } })).json()
check('POST /api/inject 支持 scenario 生成 spec', injOk.ok === true && stubApi.lastInject.kind === 'message' && stubApi.lastInject.atMe === true, JSON.stringify(stubApi.lastInject))
const injBad = await (await postJson('/api/inject', { scenario: 'group-mention', params: {} })).json()
check('场景缺参数 → 明确拒绝并点名缺什么', injBad.ok === false && injBad.reason.includes('groupId'), injBad.reason)
const injPlain = await (await postJson('/api/inject', { kind: 'message', groupId: 2002, userId: 10001, text: 'raw' })).json()
check('不带 scenario 时仍按原来的裸 spec 注入', injPlain.ok === true && stubApi.lastInject.text === 'raw', JSON.stringify(stubApi.lastInject))
stubApi.replayCalls = 0
const diffRes = await (await postJson('/api/replay-diff', { indices: [0], variant: { keywordEnabled: true } })).json()
check('POST /api/replay-diff 跑两次回放并给出差异',
  diffRes.ok === true && stubApi.replayCalls === 2 && diffRes.changed === 1, JSON.stringify({ calls: stubApi.replayCalls, changed: diffRes.changed }))
check('差异里带上人话总结与变化类型', diffRes.summary.includes('1/1') && diffRes.byKind.decision === 1, diffRes.summary)
const diffNoVariant = await (await postJson('/api/replay-diff', { indices: [0] })).json()
check('缺少 variant 覆盖 → 拒绝并给例子', diffNoVariant.ok === false && diffNoVariant.reason.includes('variant'), diffNoVariant.reason)
check('拒绝时没有再跑回放', stubApi.replayCalls === 2, String(stubApi.replayCalls))
const headerToken = await fetch(base + '/api/status', { headers: { 'X-Control-Token': token } })
check('也可用请求头携带 token', headerToken.status === 200)
const logsResponse = await fetch(base + '/api/logs?name=hostOut&lines=5&token=' + token)
const logsBody = await logsResponse.json()
check('日志接口返回内容', logsBody.ok === true && logsBody.lines.length > 0 && logsBody.lines.join('\n').includes('token='))
const badLog = await fetch(base + '/api/logs?name=../../secret&token=' + token)
check('日志名白名单拦截路径穿越', badLog.status === 400, String(badLog.status))
for (const [path, needle] of [['/api/host/start', '宿主已启动'], ['/api/host/stop', '宿主已停止'], ['/api/napcat/stop', 'napcat 停止'], ['/api/tts/start', 'tts 启动'], ['/api/all/stop', '全部停止']]) {
  const response = await fetch(base + path + '?token=' + token, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
  const body = await response.json()
  check(`POST ${path}`, response.status === 200 && body.ok === true && body.reason === needle, JSON.stringify(body))
}
const freeResponse = await fetch(base + '/api/port/free?token=' + token, { method: 'POST', body: JSON.stringify({ name: 'onebot' }) })
check('POST /api/port/free 透传端口名', (await freeResponse.json()).reason === '已释放 onebot')
// 审查 G5：不在受管列表里的端口名必须拒绝（FREEABLE_PORTS = host/onebot/napcat/tts），
// 否则 token 持有者能借它杀掉任意占用者的进程（control 就是"别的进程"的典型）。
for (const badName of ['control', '', 'host; rm -rf', 'unknown']) {
  const bad = await (await fetch(base + '/api/port/free?token=' + token, { method: 'POST', body: JSON.stringify({ name: badName }) })).json()
  check(`POST /api/port/free 拒绝非受管端口「${badName}」`, bad.ok === false && bad.reason.includes('只能释放受管端口'), JSON.stringify(bad))
}
const cfgResponse = await fetch(base + '/api/config?token=' + token, { method: 'POST', body: JSON.stringify({ cwd: 'D:\\qq-bridge-work', ports: { host: 3081, onebot: 999999 } }) })
const cfgBody = await cfgResponse.json()
check('POST /api/config 过滤非法端口', cfgBody.ok === true && savedPatch.cwd === 'D:\\qq-bridge-work' && savedPatch.ports.host === 3081 && savedPatch.ports.onebot === 6700, JSON.stringify(savedPatch))
const emptyCfg = await fetch(base + '/api/config?token=' + token, { method: 'POST', body: '{}' })
check('空配置更新被拒', (await emptyCfg.json()).ok === false)
const badJson = await fetch(base + '/api/host/start?token=' + token, { method: 'POST', body: '{oops' })
check('非法 JSON 返回 400', badJson.status === 400)
const wrongVerb = await fetch(base + '/api/host/start?token=' + token)
check('GET 调 mutation 返回 404/405', [404, 405].includes(wrongVerb.status), String(wrongVerb.status))
// 审计发现：以前超大请求体直接 destroy socket，客户端只看到连接重置
const tooLarge = await fetch(base + '/api/host/start?token=' + token, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }),
})
check('超大请求体返回 413 而不是断开连接', tooLarge.status === 413, String(tooLarge.status))
check('413 带可读原因', (await tooLarge.json()).reason.includes('请求体过大'))
server.close()

// ------------------------------------------------- 事件流 tailer 隔离（审计） --
const traceA = join(dir, 'a-trace.jsonl')
const traceB = join(dir, 'b-trace.jsonl')
const traceLine = (id) => `${JSON.stringify({ v: 1, ts: Date.now(), id, level: 'info', module: 'bridge', stage: 'inbound', ok: true, reason: '' })}\n`
writeFileSync(traceA, traceLine('t-a'), 'utf8')
writeFileSync(traceB, traceLine('t-b'), 'utf8')
const supA = createSupervisor({ ...config, cwd: dir, logs: { ...config.logs, trace: traceA } }, { exec: okExec, logger: { info() {}, warn() {}, error() {} } })
const supB = createSupervisor({ ...config, cwd: dir, logs: { ...config.logs, trace: traceB } }, { exec: okExec, logger: { info() {}, warn() {}, error() {} } })
check('不同 supervisor 的 tailer 相互独立', supA.tailer() !== supB.tailer())
check('第二个 supervisor 不会读到第一个的事件文件', supB.tailer().poll().every((event) => event.id === 't-b'), JSON.stringify(supB.tailer().poll()))
const conn1 = supA.tailer()
const conn2 = supA.tailer()
check('同一 supervisor 的两次取用也是两份 tailer', conn1 !== conn2)
check('两个连接都能各自拿到完整历史（不互相偷事件）', conn1.poll().length >= 1 && conn2.poll().length >= 1, `${conn1.poll().length}/${conn2.poll().length}`)

// --------------------------------------------------------------- helpers -----
const ran = await run('cmd.exe', ['/c', 'echo', 'hi'])
check('run() 返回 stdout 且不抛错', ran.ok === true && ran.stdout.includes('hi'), JSON.stringify(ran).slice(0, 80))
const killed = await killTree(999999, { exec: (c, a, o, cb) => (typeof o === 'function' ? o : cb)(new Error('not found'), '', 'no such pid') })
check('killTree 失败时安全返回', killed.ok === false && killed.stderr === 'no such pid')
check('inspect 在假 exec 下可用', (await inspect({ ports: DEFAULT_PORTS, exec: okExec })).ports.length === 5)
check('readUi 缺失文件返回提示', readUi(join(dir, 'no-ui.html')).includes('缺失'))

// ------------------------------------------------------------ app window -----
const panelUrl = 'http://127.0.0.1:8799/?token=abc'
check('候选浏览器列表非空且含 msedge', BROWSER_CANDIDATES.length >= 2 && BROWSER_CANDIDATES.some((p) => p.toLowerCase().includes('msedge')), BROWSER_CANDIDATES.join(' | '))
check('pickBrowser 命中第一个存在的', pickBrowser({ exists: (p) => p.toLowerCase().includes('chrome') }) === BROWSER_CANDIDATES.find((p) => p.toLowerCase().includes('chrome')))
check('pickBrowser 找不到返回空串', pickBrowser({ exists: () => false }) === '')
const appCmd = buildOpenCommand(panelUrl, { browser: 'C:/Edge/msedge.exe' })
check('应用窗口模式用 --app 且无地址栏', appCmd.mode === 'app' && appCmd.args[0] === `--app=${panelUrl}` && appCmd.args[1].startsWith('--window-size='), JSON.stringify(appCmd))
const defaultCmd = buildOpenCommand(panelUrl, { browser: '' })
check('无浏览器时回退系统默认浏览器', defaultCmd.mode === 'default' && defaultCmd.command === 'cmd.exe' && defaultCmd.args.includes(panelUrl))
check('空 URL 不产生命令', buildOpenCommand('').mode === 'none')
let opened = null
const openResult = openPanel(panelUrl, { exists: (p) => p.toLowerCase().includes('msedge'), spawnImpl: (command, args) => { opened = { command, args }; return { unref() {} } } })
check('openPanel 用应用窗口打开', openResult.ok === true && openResult.mode === 'app' && opened.args[0].startsWith('--app='), JSON.stringify(opened))
let fallbackOpened = null
const openFallback = openPanel(panelUrl, { exists: () => false, spawnImpl: (command, args) => { fallbackOpened = { command, args }; return { unref() {} } } })
check('openPanel 无浏览器时回退系统默认浏览器', openFallback.ok === true && openFallback.mode === 'default' && fallbackOpened.command === 'cmd.exe' && fallbackOpened.args.includes(panelUrl), JSON.stringify(fallbackOpened))
const openThrows = openPanel(panelUrl, { browser: 'C:/Edge/msedge.exe', spawnImpl: () => { throw new Error('boom') }, logger: { warn() {} } })
check('openPanel 启动失败安全返回', openThrows.ok === false && openThrows.mode === 'app')

// ---- v0.5.6：提权启动 / 登录流程重启 / 二维码（纯函数 + 护栏） ----
const launch = napcatLaunchCommand('C:\\NapCat\\bootmain\\launcher.bat')
check('napcatLaunchCommand 用 PowerShell 提权启动', launch.ok === true && launch.command === 'powershell.exe' && launch.args.includes('-Command'), JSON.stringify(launch))
check('napcatLaunchCommand 带 -Verb RunAs（launcher.bat 需要管理员）', launch.args.join(' ').includes('-Verb RunAs'), launch.args.join(' '))
check('napcatLaunchCommand 目标脚本用 call + 引号包住（括号路径不会被 cmd 剥引号）',
  launch.args.join(' ').includes('call \\"C:\\\\NapCat\\\\bootmain\\\\launcher.bat\\"') || launch.args.join(' ').includes('call "C:\\NapCat\\bootmain\\launcher.bat"'),
  launch.args.join(' ').slice(0, 220))
check('napcatLaunchCommand 指定工作目录为脚本所在目录',
  launch.args.join(' ').includes("WorkingDirectory 'C:\\NapCat\\bootmain'"), launch.args.join(' ').slice(0, 220))
check('napcatLaunchCommand 用 @() 数组传参（不走裸 /c,\'"path"\' 那条会被剥引号的写法）',
  launch.args.join(' ').includes("@('/c',") && !launch.args.join(' ').includes("-ArgumentList '/c'"),
  launch.args.join(' ').slice(0, 220))
check('napcatLaunchCommand 空路径 → 明确拒绝', napcatLaunchCommand('').ok === false && napcatLaunchCommand('').reason.includes('napcatBat'))

const restart = napcatRestartCommand('C:\\NapCat\\bootmain\\launcher.bat', [11460, 11461])
check('napcatRestartCommand 按 PID 清理（不发 taskkill /IM）',
  restart.ok === true && restart.args.join(' ').includes('taskkill /PID 11460 /T /F') && restart.args.join(' ').includes('taskkill /PID 11461 /T /F'),
  restart.args.join(' ').slice(0, 240))
// 审查 S1 的核心回归：绝不能按镜像名杀 QQ —— 那会把用户自己开着的 QQ 一起杀掉
check('绝不出现 taskkill /IM（按名杀会误杀个人 QQ）', !/taskkill \/F \/IM|taskkill \/IM/.test(restart.args.join(' ')), restart.args.join(' ').slice(0, 240))
check('绝不出现 QQ.exe 字样', !/QQ\.exe/i.test(restart.args.join(' ')), restart.args.join(' ').slice(0, 200))
check('加载器名单只含 NapCat 系进程，不含 QQ',
  NAPCAT_LOADER_NAMES.every((name) => !/^qq\.exe$/i.test(name)) && NAPCAT_LOADER_NAMES.some((name) => name.includes('napcat')),
  JSON.stringify(NAPCAT_LOADER_NAMES))
check('restartNapcatCommand 没有 PID 时拒绝执行（不退回按名杀）',
  napcatRestartCommand('C:\\NapCat\\launcher.bat', []).ok === false
  && napcatRestartCommand('C:\\NapCat\\launcher.bat', []).reason.includes('PID'),
  napcatRestartCommand('C:\\NapCat\\launcher.bat', []).reason)
check('napcatRestartCommand 清理后仍会启动 launcher.bat', restart.args.join(' ').includes('call "C:\\NapCat\\bootmain\\launcher.bat"'))
// 回归：清理与启动必须在**同一个提权进程**里，否则非提权的 taskkill 杀不掉由提权 launcher 拉起的 QQ
const restartScript = restart.args.join(' ')
check('清理与启动在同一个提权命令里（不是只把启动提权）',
  restartScript.includes("Start-Process -FilePath 'cmd.exe'") && restartScript.includes("'/c'")
  && restartScript.indexOf('taskkill') < restartScript.indexOf('launcher.bat'),
  restartScript.slice(0, 240))
check('提权命令里只有一次 Start-Process（不会"没杀掉又拉一个"）',
  (restartScript.match(/Start-Process /g) ?? []).length === 1, String((restartScript.match(/Start-Process /g) ?? []).length))
// 审查 G1/G2：cmd 的引号剥离规则 + PowerShell 单引号转义
const launchScript = launch.args.join(' ')
check('启动命令用 call "<path>"（括号路径不会被 cmd 剥引号）',
  launchScript.includes("call \\\"C:\\\\NapCat\\\\bootmain\\\\launcher.bat\\\"") || launchScript.includes('call "C:\\NapCat\\bootmain\\launcher.bat"'),
  launchScript.slice(0, 220))
check('启动命令用 @() 数组传参（不是裸的 \'/c\',\'"path"\'）',
  launchScript.includes("@('/c',") && !launchScript.includes("-ArgumentList '/c','\""), launchScript.slice(0, 220))
const quoted = napcatLaunchCommand("D:\\O'Brien\\napcat.bat")
check('路径含单引号时 PowerShell 单引号成对转义（否则脚本解析失败）',
  quoted.ok === true && quoted.args[4].includes("'D:\\O''Brien'"), quoted.args[4].slice(0, 200))
check('restartNapcatLogin 是 supervisor 的方法', typeof createSupervisor({ ...config, cwd: dir, napcatBat: 'C:\\NapCat\\bootmain\\launcher.bat' }, {}).restartNapcatLogin === 'function')
check('napcatRestartCommand 空路径 → 拒绝', napcatRestartCommand('').ok === false)

check('qrStatus 新鲜判定用 QR_STALE_SECONDS',
  qrStatus('x', 1000, { stat: () => ({ mtimeMs: 1000 - (QR_STALE_SECONDS - 1) * 1000 }) }).fresh === true
  && qrStatus('x', 1000, { stat: () => ({ mtimeMs: 1000 - (QR_STALE_SECONDS + 1) * 1000 }) }).fresh === false,
  String(QR_STALE_SECONDS))

{
  const qrDir = mkdtempSync(join(tmpdir(), 'qq-qr-test-'))
  const qrFile = join(qrDir, 'qrcode.png')
  writeFileSync(qrFile, Buffer.from('89504e470d0a1a0a', 'hex'))
  const sup = createSupervisor({ ...config, cwd: qrDir, napcatQr: qrFile, napcatBat: 'C:\\NapCat\\bootmain\\launcher.bat' }, { now: () => Date.now() })
  const fresh = await sup.qr()
  check('supervisor.qr 返回 dataUrl 与提示', fresh.ok === true && fresh.dataUrl.startsWith('data:image/png;base64,') && fresh.hint.length > 0, JSON.stringify({ exists: fresh.exists, hint: fresh.hint }))
  const missing = await createSupervisor({ ...config, cwd: qrDir, napcatQr: join(qrDir, 'nope.png') }, {}).qr()
  check('supervisor.qr 没有文件时给中文说明而不是报错',
    missing.ok === true && missing.exists === false && missing.dataUrl === '' && missing.hint.includes('没有二维码'),
    missing.hint)
  rmSync(qrDir, { recursive: true, force: true })
}

check('ui.html 里有二维码卡片与 token 缺失提示',
  readFileSync(join(here0, '..', 'control', 'ui.html'), 'utf8').includes('loadQr')
  && readFileSync(join(here0, '..', 'control', 'ui.html'), 'utf8').includes('地址里没有 token'),
  'ui.html')

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

// 审查 O1/O2：二维码只认 PNG 魔数；stat 报错要区分"不存在"与"读不到"
{
  const qrDir2 = mkdtempSync(join(tmpdir(), 'qq-qr-audit-'))
  const notPng = join(qrDir2, 'fake.png')
  writeFileSync(notPng, '{"this":"is json, not a png"}')
  const supNotPng = createSupervisor({ ...config, cwd: qrDir2, napcatQr: notPng }, { now: () => Date.now() })
  const r = await supNotPng.qr()
  check('qr() 拒绝非 PNG 文件（不给前端当图片）', r.ok === true && r.dataUrl === '' && r.hint.includes('不是 PNG'), r.hint)
  const busy = qrStatus('x', 1, { stat: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e } })
  check('qrStatus 区分「读不到」与「不存在」', busy.exists === false && busy.error.includes('EBUSY'), JSON.stringify(busy))
  const missing = qrStatus('x', 1, { stat: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e } })
  check('qrStatus ENOENT 才算真的不存在', missing.exists === false && missing.error === '', JSON.stringify(missing))
  rmSync(qrDir2, { recursive: true, force: true })
}
