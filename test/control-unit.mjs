/**
 * Unit + HTTP tests for the standalone control console (no real machine access:
 * every side effect is injected, and the server is exercised with real requests
 * against a stubbed supervisor).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PORTS, PORT_LABELS, configWarnings, detectDshBin, detectPaths, loadControlConfig, saveControlConfig } from '../control/lib/config.mjs'
import {
  assertKillAllowed, createSupervisor, extractHostUrl, inspect, killTree, parseNetstat, parseTasklist,
  portOf, publicConfig, qrStatus, run, startDetached, summarizePorts, tailLines,
} from '../control/lib/supervisor.mjs'
import { createControlServer, createToken, originAllowed, readUi } from '../control/lib/server.mjs'
import { BROWSER_CANDIDATES, buildOpenCommand, openPanel, pickBrowser } from '../control/lib/open.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-control-test-'))

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

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
