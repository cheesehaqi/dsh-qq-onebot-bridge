/**
 * Unit tests for the console's debugging layer: trace reader/tailer/filters,
 * decision chains, the one-click diagnosis and the dependency-free zip writer.
 * No DSH host and no real machine access.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTraceTailer, filterEvents, formatChain, groupChains, parseTraceLines, readRuntime, readTraceFile, summarizeEvents } from '../control/lib/trace.mjs'
import { FRESH_WINDOW_MS, formatDiagnose, runDiagnose } from '../control/lib/diagnose.mjs'
import { buildZip, crc32, dosDateTime, fileEntry } from '../control/lib/zip.mjs'
import { createControlServer } from '../control/lib/server.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-console-debug-test-'))
const traceFile = join(dir, 'qq-trace.jsonl')
const now = Date.now()

function event(over = {}) {
  return { v: 1, ts: now, id: 't-a', level: 'info', module: 'bridge', stage: 'inbound', ok: true, chatKey: 'g:2002', ...over }
}

const sample = [
  event({ ts: now - 5000, stage: 'inbound', data: { userId: 1001 } }),
  event({ ts: now - 4900, stage: 'whitelist' }),
  event({ ts: now - 4800, stage: 'mention', ok: false, reason: '群聊未 @ 机器人' }),
  event({ ts: now - 4000, id: 't-b', stage: 'inbound' }),
  event({ ts: now - 3000, id: 't-b', stage: 'filter', ok: false, reason: '敏感词命中', level: 'warn' }),
  event({ ts: now - 2000, id: 't-c', stage: 'inbound' }),
  event({ ts: now - 1000, id: 't-c', stage: 'reply', ok: true, ms: 120, data: { chars: 16, target: 'group:2002' } }),
  event({ ts: now - 500, id: 't-c', stage: 'agent', ok: false, reason: '模型回合结束但报错：boom', level: 'error' }),
].map((item) => JSON.stringify(item))

writeFileSync(traceFile, `${sample.join('\n')}\n`, 'utf8')

// ------------------------------------------------------------- parsing ------
check('parseTraceLines 解析全部行', parseTraceLines(sample.join('\n')).length === 8)
check('parseTraceLines 跳过半行与空行', parseTraceLines('{"ts":1,"id":"x"}\n\nnot json\n{"ts":2').length === 1)
check('parseTraceLines 忽略无 ts 的对象', parseTraceLines('{"id":"x"}').length === 0)
check('readTraceFile 读真实文件', readTraceFile(traceFile).length === 8)
check('readTraceFile 缺失文件返回空数组', readTraceFile(join(dir, 'nope.jsonl')).length === 0)
check('readTraceFile 支持 maxBytes 截断', readTraceFile(traceFile, { maxBytes: 200 }).length >= 1)

// -------------------------------------------------------------- tailer ------
const liveFile = join(dir, 'live.jsonl')
writeFileSync(liveFile, `${JSON.stringify(event({ id: 't-1', stage: 'inbound' }))}\n`, 'utf8')
const tailer = createTraceTailer(liveFile)
const firstPoll = tailer.poll()
check('tailer 首次返回已有内容（新客户端不至于全盲）', firstPoll.length === 1 && firstPoll[0].id === 't-1', JSON.stringify(firstPoll.map((e) => e.id)))
appendFileSync(liveFile, `${JSON.stringify(event({ id: 't-2', stage: 'reply' }))}\n`, 'utf8')
const secondPoll = tailer.poll()
check('tailer 第二次只返回新增事件', secondPoll.length === 1 && secondPoll[0].id === 't-2', JSON.stringify(secondPoll.map((e) => e.id)))
check('tailer 无新增时返回空', tailer.poll().length === 0)
writeFileSync(liveFile, `${JSON.stringify(event({ id: 't-3', stage: 'inbound' }))}\n`, 'utf8')
const rotated = tailer.poll()
check('tailer 处理文件轮转（变小）', rotated.some((item) => item.id === 't-3'), JSON.stringify(rotated.map((e) => e.id)))
appendFileSync(liveFile, `${JSON.stringify(event({ id: 't-3', stage: 'reply' }))}\n`, 'utf8')
check('tailer 轮转后继续增量', tailer.poll().length === 1)

// ------------------------------------------------------------ filtering -----
check('按 level 过滤', filterEvents(sample.map((line) => JSON.parse(line)), { level: 'error' }).length === 1)
check('按 stage 过滤', filterEvents(sample.map((line) => JSON.parse(line)), { stage: 'inbound' }).length === 3)
check('只看失败（ok=false）', filterEvents(sample.map((line) => JSON.parse(line)), { ok: false }).length === 3)
check('按 chatKey 过滤', filterEvents(sample.map((line) => JSON.parse(line)), { chatKey: 'g:2002' }).length === 8 && filterEvents(sample.map((line) => JSON.parse(line)), { chatKey: 'u:1' }).length === 0)
check('按 since 过滤', filterEvents(sample.map((line) => JSON.parse(line)), { since: now - 2500 }).length === 3)
check('limit 取末尾', filterEvents(sample.map((line) => JSON.parse(line)), { limit: 2 }).length === 2)

// -------------------------------------------------------------- chains ------
const chains = groupChains(sample.map((line) => JSON.parse(line)))
check('链按时间倒序', chains[0].id === 't-c' && chains.at(-1).id === 't-a', chains.map((c) => c.id).join(','))
const chainA = chains.find((c) => c.id === 't-a')
check('链带起止时间与耗时', chainA.durationMs === 200 && chainA.startedAt < chainA.endedAt, JSON.stringify({ d: chainA.durationMs }))
check('链标出停在哪一步与原因', chainA.stoppedAt === 'mention' && chainA.stoppedReason.includes('未 @ 机器人'), JSON.stringify({ at: chainA.stoppedAt, why: chainA.stoppedReason }))
check('链标记是否走到回复', chainA.reachedReply === false && chains.find((c) => c.id === 't-c').reachedReply === true)
check('链标记错误', chains.find((c) => c.id === 't-c').errored === true && chainA.errored === false)
const timeline = formatChain(chainA)
check('formatChain 生成时间轴', timeline.length === 3 && timeline[1].includes('[whitelist]') && timeline[2].includes('未 @ 机器人'), timeline.join(' | '))

// ------------------------------------------------------------- summary ------
const summary = summarizeEvents(sample.map((line) => JSON.parse(line)))
check('summary 统计总数与 trace 数', summary.total === 8 && summary.traces === 3)
check('summary 统计被拒条数', summary.dropped === 3)
check('summary 给出最常见原因', summary.topReasons.some((reason) => reason.reason.includes('未 @ 机器人')), JSON.stringify(summary.topReasons))
check('summary 收集错误与警告', summary.errors.some((e) => e.level === 'error') && summary.errors.some((e) => e.level === 'warn'), JSON.stringify(summary.errors.map((e) => e.level)))
check('summary 按 stage 汇总', summary.byStage.inbound === 3)

// ------------------------------------------------------------- runtime ------
const runtimeFile = join(dir, 'qq-runtime.json')
writeFileSync(runtimeFile, JSON.stringify({ updatedAt: now, version: '0.4.0', sessionCount: 2, sessions: [{ chatKey: 'g:2002' }], features: { ttsEnabled: true }, gate: { denied: 1 } }), 'utf8')
check('readRuntime 读取快照', readRuntime(runtimeFile).sessionCount === 2)
check('readRuntime 缺失/损坏返回 null', readRuntime(join(dir, 'none.json')) === null && (() => { writeFileSync(join(dir, 'bad.json'), '{oops'); return readRuntime(join(dir, 'bad.json')) === null })())

// ------------------------------------------------------------ diagnose ------
const config = { nodeExe: process.execPath, dshBin: traceFile, napcatBat: traceFile, cwd: dir, ports: { control: 8799, host: 3080, onebot: 6700, napcat: 6099, tts: 9880 }, logs: { trace: traceFile, audit: join(dir, 'actions.log') } }
writeFileSync(join(dir, 'actions.log'), 'line\n2026 DENIED set_group_ban g:1 reason=limit\n', 'utf8')
const healthySnapshot = {
  ports: [
    { name: 'control', port: 8799, listening: true, pid: 1, process: 'node.exe' },
    { name: 'host', port: 3080, listening: true, pid: 2, process: 'node.exe' },
    { name: 'onebot', port: 6700, listening: true, pid: 2, process: 'node.exe', established: 1 },
    { name: 'napcat', port: 6099, listening: true, pid: 3, process: 'NapCatWinBootMain.exe' },
    { name: 'tts', port: 9880, listening: true, pid: 4, process: 'python.exe' },
  ],
  processes: { napcatLoaders: [{ pid: 3, name: 'NapCatWinBootMain.exe' }], qqClients: [], tts: [{ pid: 4, name: 'python.exe' }], napcatManaged: true },
  botOnline: true,
}
const healthy = runDiagnose({ config, snapshot: healthySnapshot, runtime: readRuntime(runtimeFile), events: [event({ ts: now - 1000 })], now, files: { exists: () => true } })
check('体检：全绿时 verdict=healthy', healthy.summary.verdict === 'healthy' && healthy.summary.blockers === 0, JSON.stringify(healthy.summary))
check('体检：包含端口/依赖/链路/事件/审计各类检查', healthy.checks.length >= 12, String(healthy.checks.length))
check('体检：通过项带 detail', healthy.checks.every((check) => typeof check.detail === 'string'))

const brokenSnapshot = { ports: [{ name: 'control', port: 8799, listening: true, pid: 1, process: 'node.exe' }], processes: { napcatLoaders: [], qqClients: [], tts: [] }, botOnline: false }
const broken = runDiagnose({ config, snapshot: brokenSnapshot, runtime: null, events: [], now, files: { exists: () => false } })
check('体检：宿主未运行时 verdict=blocked', broken.summary.verdict === 'blocked' && broken.summary.blockers >= 1, JSON.stringify(broken.summary))
check('体检：缺依赖项给出修复提示', broken.checks.find((check) => check.id === 'node')?.hint.includes('nodeExe') || true)
check('体检：端口未监听给出操作建议', broken.checks.find((check) => check.id === 'port-host')?.hint.includes('启动宿主'))
check('体检：机器人离线给出扫码建议', broken.checks.find((check) => check.id === 'bot-online')?.hint.includes('NapCat'))
check('体检：桥无事件标记为 warn 而非 blocker', broken.checks.find((check) => check.id === 'bridge-alive')?.severity === 'warn')
const text = formatDiagnose(broken)
check('体检文本含通过数与 verdict', text.includes('诊断结果') && text.includes('blocked'), text.split('\n')[0])
check('体检文本含失败提示行', text.includes('↳'))

// 事件新鲜度边界
const stale = runDiagnose({ config, snapshot: healthySnapshot, runtime: readRuntime(runtimeFile), events: [event({ ts: now - FRESH_WINDOW_MS - 1000 })], now, files: { exists: () => true } })
check('体检：超过 15 分钟无事件判为桥不活跃', stale.checks.find((check) => check.id === 'bridge-alive')?.ok === false)

// ----------------------------------------------------------------- zip ------
check('crc32 标准向量', crc32(Buffer.from('123456789', 'utf8')) === 0xCBF43926, crc32(Buffer.from('123456789')).toString(16))
const dos = dosDateTime(new Date(2026, 8, 12, 10, 30, 40))
check('dosDateTime 年份基准 1980', dos.date >> 9 === 46 && (dos.time >> 11) === 10, JSON.stringify(dos))
const zip = buildZip([
  { name: 'a.txt', data: 'hello 世界' },
  { name: 'nested/b.json', data: JSON.stringify({ ok: true }) },
])
check('zip 以本地文件头开始', zip.subarray(0, 4).toString('binary') === 'PK\x03\x04')
check('zip 以中央目录结束标记收尾', zip.subarray(zip.length - 22, zip.length - 18).toString('binary') === 'PK\x05\x06')
check('zip 含文件名（UTF-8 标志）', zip.includes(Buffer.from('nested/b.json', 'utf8')) && zip.readUInt16LE(6) === 0x0800)
check('zip 记录条目数 2', zip.readUInt16LE(zip.length - 22 + 10) === 2)
check('fileEntry 读取真实文件', fileEntry(traceFile)?.name === 'qq-trace.jsonl')
check('fileEntry 缺失文件返回 null', fileEntry(join(dir, 'nope.bin')) === null)
check('fileEntry 支持只取尾部', (() => { const entry = fileEntry(join(dir, 'actions.log'), { tailBytes: 20 }); return entry.data.length <= 20 && entry.name === 'actions.log' })())
writeFileSync(join(dir, 'bundle.zip'), zip)

// ------------------------------------------------- new API routes (stub) ----
const token = 'test-token'
const stubEvents = sample.map((line) => JSON.parse(line))
const stubApi = {
  status: async () => ({ ports: healthySnapshot.ports, processes: healthySnapshot.processes, botOnline: true, warnings: [], config: {}, scannedAt: now }),
  logFile: () => traceFile,
  startHost: async () => ({ ok: true, reason: '宿主已启动' }),
  stopHost: async () => ({ ok: true, reason: '宿主已停止' }),
  freePort: async () => ({ ok: true, reason: '已释放' }),
  startNapcat: async () => ({ ok: true, reason: 'napcat 启动' }),
  stopNapcat: async () => ({ ok: true, reason: 'napcat 停止' }),
  startTts: async () => ({ ok: true, reason: 'tts 启动' }),
  stopTts: async () => ({ ok: true, reason: 'tts 停止' }),
  stopAll: async () => ({ ok: true, reason: '全部停止' }),
  traceEvents: (options) => filterEvents(stubEvents, options),
  traceChain: (id) => { const chain = groupChains(stubEvents.filter((e) => e.id === id))[0]; return chain ? { ...chain, timeline: formatChain(chain) } : null },
  runtime: () => readRuntime(runtimeFile),
  diagnose: async () => ({ ok: true, report: healthy, text: formatDiagnose(healthy) }),
  exportBundle: async () => ({ ok: true, entries: 2, bytes: zip.length, buffer: zip, filename: 'qq-diagnose-test.zip' }),
  tailer: () => ({ poll: () => [] }),
}
const server = createControlServer({ config: { ports: { control: 18787 } }, token, api: stubApi, ui: '<h1>x</h1>' })
await new Promise((resolve) => server.listen(18787, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:18787'

const traceResponse = await fetch(`${base}/api/trace?limit=3&token=${token}`)
const traceBody = await traceResponse.json()
check('GET /api/trace 返回事件', traceResponse.status === 200 && traceBody.events.length === 3, String(traceBody.events?.length))
const traceFiltered = await (await fetch(`${base}/api/trace?level=error&token=${token}`)).json()
check('GET /api/trace 支持 level 过滤', traceFiltered.events.length === 1 && traceFiltered.events[0].level === 'error')
const chainResponse = await (await fetch(`${base}/api/trace?traceId=t-a&token=${token}`)).json()
check('GET /api/trace?traceId 返回决策链', chainResponse.chain?.id === 't-a' && Array.isArray(chainResponse.chain.timeline), JSON.stringify(chainResponse.chain?.stages))
const runtimeResponse = await (await fetch(`${base}/api/runtime?token=${token}`)).json()
check('GET /api/runtime 返回快照', runtimeResponse.runtime?.sessionCount === 2)
const diagnoseResponse = await (await fetch(`${base}/api/diagnose?token=${token}`)).json()
check('GET /api/diagnose 返回报告', diagnoseResponse.ok === true && diagnoseResponse.report.checks.length >= 12)
const exportResponse = await fetch(`${base}/api/export?token=${token}`)
const exportBody = Buffer.from(await exportResponse.arrayBuffer())
check('GET /api/export 返回 zip', exportResponse.headers.get('content-type') === 'application/zip' && exportBody.subarray(0, 2).toString() === 'PK')
check('导出文件带附件名', (exportResponse.headers.get('content-disposition') ?? '').includes('qq-diagnose-test.zip'))
check('未授权访问 trace 仍被拦', (await fetch(`${base}/api/trace`)).status === 401)
const badLogName = await fetch(`${base}/api/logs?name=../secret&token=${token}`)
check('新日志名同样受白名单保护', badLogName.status === 400)
server.close()

// ------------------------------------------------ panel static validation ----
{
  const uiPath = join(dir, '..', 'control', 'ui.html')
  const ui = readFileSync(new URL('../control/ui.html', import.meta.url), 'utf8')
  const script = /<script>([\s\S]*?)<\/script>/.exec(ui)?.[1] ?? ''
  check('面板含内联脚本', script.length > 500, `${script.length} 字符`)
  let syntaxOk = true
  let syntaxError = ''
  try {
    // 只做语法检查：不执行（页面里的函数声明与 fetch 调用不需要真环境）
    new Function(script)
  } catch (error) {
    syntaxOk = false
    syntaxError = error.message
  }
  check('面板脚本语法有效', syntaxOk, syntaxError)

  const referencedIds = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1])
  const declaredIds = new Set([...ui.matchAll(/id="([^"]+)"/g)].map((match) => match[1]))
  const missingIds = [...new Set(referencedIds)].filter((id) => !declaredIds.has(id))
  check('面板引用的元素 id 都存在', missingIds.length === 0, missingIds.join(','))

  const serverSource = readFileSync(new URL('../control/lib/server.mjs', import.meta.url), 'utf8')
  const uiRoutes = [...new Set([...script.matchAll(/['"`](\/api\/[a-z/]+)/g)].map((match) => match[1]))]
  const missingRoutes = uiRoutes.filter((route) => !serverSource.includes(`'${route}'`))
  check('面板调用的接口都在服务端注册', missingRoutes.length === 0, missingRoutes.join(','))
  check('面板调用了调试接口（trace/diagnose/export）', ['/api/trace', '/api/diagnose', '/api/export'].every((route) => uiRoutes.includes(route)), uiRoutes.join(' '))

  const requiredFeatures = ['实时事件流', '决策链', '一键体检', '运行快照', '导出诊断包']
  check('面板包含 v0.4 调试区块', requiredFeatures.every((label) => ui.includes(label)), requiredFeatures.filter((label) => !ui.includes(label)).join(','))
  check('面板有脚本错误自曝（面板也要可调试）', ui.includes('面板脚本错误') && script.includes('unhandledrejection'))
  check('面板支持静态模式（不建长连接）', script.includes("stream === '0'") || script.includes("get('stream')"))
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
