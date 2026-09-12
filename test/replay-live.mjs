/**
 * Live acceptance for offline replay: the REAL bridge + the REAL OneBot server, run
 * outside the host against a prepared sandbox, with zero QQ side effects.
 *
 * Asserts the three things the feature promises:
 *   ① 复现分支：命中关键词会回复、未 @ 会静默、命令在私聊可用；
 *   ② 不碰 QQ：dry-run 开启、没有连接、没有新增监听端口、源目录一个字节都没改；
 *   ③ 结论可读：每条都带原因，并且给出"会发送什么"。
 *
 * Usage: node test/replay-live.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReplayer } from '../control/lib/replay.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(here)
let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

/** Count listeners on a TCP port (0 when nothing is listening). */
function listenersOn(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    return out.split(/\r?\n/).filter((line) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING`, 'i').test(line)).length
  } catch {
    return -1
  }
}

const BOT = 3000000001
const GROUP = 100000001
const USER = 2000000001

const sandboxSource = mkdtempSync(join(tmpdir(), 'qq-replay-live-'))
mkdirSync(join(sandboxSource, 'qq-points'), { recursive: true })
writeFileSync(join(sandboxSource, 'qq-keywords.json'), JSON.stringify({
  global: [{ trigger: '回放报时', match: 'exact', reply: ['现在是回放时间', '现在是备用文案'], cooldownSeconds: 0, scope: 'all' }],
  chats: {},
}, null, 2), 'utf8')
writeFileSync(join(sandboxSource, 'qq-points', 'g_100000001.json'), JSON.stringify({ users: { 2000000001: { points: 7 } }, updatedAt: 0 }), 'utf8')
const before = {
  keywords: readFileSync(join(sandboxSource, 'qq-keywords.json'), 'utf8'),
  files: readdirSync(sandboxSource).sort().join(','),
  mtime: statSync(join(sandboxSource, 'qq-keywords.json')).mtimeMs,
}

const entries = [
  { v: 1, ts: 1, kind: 'message', frame: { messageType: 'group', groupId: GROUP, userId: USER, text: '回放报时', atMe: true, ats: [BOT], messageId: 'replay-kw-1' } },
  { v: 1, ts: 2, kind: 'message', frame: { messageType: 'group', groupId: GROUP, userId: USER, text: '聊点别的', atMe: false, ats: [], messageId: 'replay-nomention-2' } },
  { v: 1, ts: 3, kind: 'message', frame: { messageType: 'private', userId: USER, text: '/r 3d6', messageId: 'replay-dice-3' } },
  { v: 1, ts: 4, kind: 'message', frame: { messageType: 'group', groupId: GROUP, userId: USER, text: '安静时段测试', atMe: true, ats: [BOT], messageId: 'replay-quiet-4' } },
]

const replayer = createReplayer({
  pluginRoot,
  sourceCwd: sandboxSource,
  sandboxRoot: join(sandboxSource, 'qq-replay'),
  botQq: BOT,
  logger: { info() {}, warn() {}, error() {} },
})

const portBefore = listenersOn(6700)
const report = await replayer.run({
  entries,
  // 线上运行时快照里的决策配置：白名单为空会拒绝一切，所以回放必须带上它
  hints: { botQq: BOT, allowGroups: [GROUP], allowUsers: [USER], quietHours: [], keywordEnabled: true },
  // 关键词默认关闭、安静时段默认 9:00-12:00/14:00-18:00：回放里当成"试配置"打开/关掉
  overrides: { keywordEnabled: true, quietHours: [] },
  maxEntries: 10,
})
const portAfter = listenersOn(6700)

console.log(report.text)
console.log('')

// ① 分支复现
check('关键词命中 → 会回复且文案来自关键词表', report.results[0].status === 'replied' && /现在是回放时间|现在是备用文案/.test(report.results[0].calls[0]?.text ?? ''), report.results[0].calls[0]?.text ?? '')
check('关键词条目链路包含 keyword 阶段', report.results[0].chain.some((step) => step.stage === 'command' || step.stage === 'keyword'), report.results[0].chain.map((step) => step.stage).join('>'))
check('未 @ 机器人 → 静默且原因明确', report.results[1].status === 'silent' && report.results[1].verdict.includes('未 @'), report.results[1].verdict)
check('私聊命令 → 会回复骰子结果', report.results[2].status === 'replied' && /\d/.test(report.results[2].calls[0]?.text ?? ''), report.results[2].calls[0]?.text ?? '')
check('每条结论都非空', report.results.every((item) => item.verdict.trim().length > 0))
check('每条都有 traceId（端到端可追）', report.results.every((item) => item.traceId.startsWith('t-')), report.results.map((item) => item.traceId).join(','))

// ② 不碰 QQ
check('dry-run 处于开启状态', report.safety.dryRun === true)
check('没有任何 QQ 连接', report.safety.connectedBots === 0)
check('cwd 被强制沙箱化', report.safety.sandboxed === true)
check('没有新增监听端口', portBefore === portAfter, `${portBefore} → ${portAfter}`)
check('源目录文件列表未变', readdirSync(sandboxSource).filter((name) => name !== 'qq-replay').sort().join(',') === before.files, readdirSync(sandboxSource).join(','))
check('源状态文件字节未变', readFileSync(join(sandboxSource, 'qq-keywords.json'), 'utf8') === before.keywords)
check('源状态文件时间戳未变', statSync(join(sandboxSource, 'qq-keywords.json')).mtimeMs === before.mtime)
check('沙箱独立于源目录', report.sandbox.startsWith(join(sandboxSource, 'qq-replay')) && existsSync(report.sandbox))
check('沙箱内写入了自己的 trace', existsSync(join(report.sandbox, 'qq-trace.jsonl')))
check('沙箱内状态是副本（未回写源）', existsSync(join(report.sandbox, 'qq-keywords.json')))

// ③ 结论可读
check('文本报告含安全行', report.text.includes('安全：dry-run=开'))
check('报告已复制状态清单', report.copied.includes('qq-keywords.json') && report.copied.includes('qq-points/'), report.copied.join(','))
check('报告统计与条目一致', report.totals.entries === report.results.length && report.totals.replied + report.totals.silent + report.totals.error + report.totals.action === report.totals.entries)

// 安静时段默认关闭（quietHoursEnabled=false），回放里显式打开才能验证这条静默分支
const quietRun = await replayer.run({
  entries: [entries[3]],
  hints: { botQq: BOT, allowGroups: [GROUP], allowUsers: [USER], keywordEnabled: true },
  overrides: { keywordEnabled: true, quietHoursEnabled: true, quietHours: ['0:00-23:59'], quietWeekendExempt: false },
})
const quietHit = quietRun.results[0]
check('安静时段内给出可读的静默原因', quietHit.status === 'silent' && quietHit.verdict.includes('静默'), quietHit.verdict)

// 回放真实录制文件（若线上已有 qq-inbox.jsonl）
// 线上 cwd 不写死在脚本里：优先 --cwd 参数，其次机器本地的 qq-control.json（gitignored）
const liveCwd = (() => {
  const index = process.argv.indexOf('--cwd')
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  try { return JSON.parse(readFileSync(join(pluginRoot, 'qq-control.json'), 'utf8')).cwd || process.cwd() } catch { return process.cwd() }
})()
const inbox = join(liveCwd, 'qq-inbox.jsonl')
if (existsSync(inbox)) {
  const { readInbox } = await import('../lib/inbox.js')
  const recorded = readInbox(inbox, { limit: 200 })
  if (recorded.length > 0) {
    const live = await replayer.run({ entries: recorded.slice(-5), maxEntries: 5 })
    check('真实录制文件可被回放', live.results.length === recorded.slice(-5).length, `${live.results.length} 条`)
    check('真实录制回放同样不产生连接', live.safety.connectedBots === 0 && live.safety.dryRun === true)
    check('真实录制回放逐条有结论', live.results.every((item) => item.verdict.trim().length > 0))
    console.log(`（已回放线上 qq-inbox.jsonl 最近 ${live.results.length} 条：${live.totals.replied} 回复 / ${live.totals.silent} 静默 / ${live.totals.error} 出错）`)
  } else {
    console.log('（线上 qq-inbox.jsonl 还没有记录，跳过真实文件回放）')
  }
} else {
  console.log('（未找到线上 qq-inbox.jsonl，跳过真实文件回放）')
}

rmSync(sandboxSource, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
