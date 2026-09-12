/** Unit tests for the structured trace recorder (no bridge, no network). */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEVELS, STAGES, TraceRecorder, newTraceId } from '../lib/trace.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-trace-test-'))
const file = join(dir, 'qq-trace.jsonl')
let clock = 1_700_000_000_000
const rec = new TraceRecorder({ file, memoryLimit: 20, now: () => (clock += 5), maxBytes: 64 * 1024, keepBytes: 8 * 1024 })

check('阶段常量表非空且有中文标签', Object.keys(STAGES).length >= 15 && STAGES.inbound === '收到消息')
check('traceId 唯一且带前缀', (() => { const a = newTraceId(), b = newTraceId(); return a !== b && a.startsWith('t-') && b.startsWith('t-') })())
check('级别白名单', LEVELS.join(',') === 'debug,info,warn,error')

const id = rec.start({ chatKey: 'g:2002', userId: 1001, groupId: 2002, messageType: 'group', messageId: 'm1', text: '你好' })
check('start 返回 traceId', typeof id === 'string' && id.startsWith('t-'), id)
check('start 自带 inbound 事件', rec.get(id).length === 1 && rec.get(id)[0].stage === 'inbound')
check('inbound 事件含消息上下文', rec.get(id)[0].data.userId === 1001 && rec.get(id)[0].data.messageId === 'm1', JSON.stringify(rec.get(id)[0].data))
check('inbound 事件含 chatKey', rec.get(id)[0].chatKey === 'g:2002')

// 静默分支必须带 reason（这是"无静默分支"约束的最小验证）
rec.event({ id, stage: 'whitelist', ok: false, reason: '不在白名单', chatKey: 'g:2002' })
rec.event({ id, stage: 'mention', ok: false, reason: '群聊未 @ 机器人', chatKey: 'g:2002' })
rec.event({ id, stage: 'reply', ok: true, ms: 42, chatKey: 'g:2002' })
const chain = rec.get(id)
check('决策链按顺序记录', chain.map((e) => e.stage).join('>') === 'inbound>whitelist>mention>reply', chain.map((e) => e.stage).join('>'))
check('被拒分支保留 reason', chain[1].ok === false && chain[1].reason === '不在白名单')
check('耗时被四舍五入记录', chain[3].ms === 42)
check('ok 默认 true', rec.get(id)[0].ok === true)

// 过滤
check('recent 按 chatKey 过滤', rec.recent({ chatKey: 'g:2002' }).length === 4 && rec.recent({ chatKey: 'g:999' }).length === 0)
check('recent 只看失败', rec.recent({ ok: false }).length === 2)
check('recent 按 stage 过滤', rec.recent({ stage: 'reply' }).length === 1)
check('recent limit 生效', rec.recent({ limit: 2 }).length === 2)

// 级别阈值：warn 以上才落盘
const quietRec = new TraceRecorder({ file: join(dir, 'warn-only.jsonl'), level: 'warn', now: () => clock })
const qid = quietRec.start({ chatKey: 'g:1' })
check('低级别事件被阈值挡掉', quietRec.get(qid).length === 0)
quietRec.event({ id: qid, level: 'warn', stage: 'action', reason: '限流' })
check('warn 级别可通过', quietRec.get(qid).length === 1)
quietRec.event({ id: qid, level: 'error', stage: 'action', reason: '失败' })
check('error 级别可通过', quietRec.get(qid).length === 2)

// step() 计时与失败记录
const stepId = rec.start({ chatKey: 'g:2002' })
const value = await rec.step(stepId, 'action', async () => 'done', { module: 'onebot' })
check('step 返回原值', value === 'done')
check('step 记录成功与耗时', rec.recent({ stage: 'action' }).some((e) => e.ok === true && e.module === 'onebot' && e.ms >= 0))
let threw = false
try {
  await rec.step(stepId, 'action', async () => { throw new Error('OneBot action send_group_msg failed: timeout') }, { module: 'onebot' })
} catch { threw = true }
check('step 失败时抛原错误', threw)
const failure = rec.recent({ stage: 'action', ok: false }).at(-1)
check('step 失败被记录且带 reason', failure?.reason.includes('send_group_msg failed'), failure?.reason)
check('step 失败级别为 error', failure?.level === 'error')

// 内存环上限
const ringRec = new TraceRecorder({ memoryLimit: 20, now: () => clock })
const ringId = ringRec.start({ chatKey: 'g:1' })
for (let i = 0; i < 40; i += 1) ringRec.event({ id: ringId, stage: 'noise', data: { i } })
check('内存环被裁剪到上限', ringRec.recent({ limit: 1000 }).length <= 20, String(ringRec.recent({ limit: 1000 }).length))
check('trace 表也被裁剪', ringRec.listTraces({ limit: 100 }).length <= 20)

// JSONL 落盘 + 可解析
const lines = readFileSync(file, 'utf8').trim().split('\n')
check('事件已写入 JSONL', lines.length >= 5)
const parsed = lines.map((line) => JSON.parse(line))
check('JSONL 每行都是合法 JSON 且带 v/ts/id', parsed.every((e) => e.v === 1 && typeof e.ts === 'number' && typeof e.id === 'string'))
check('JSONL 保留 stage 与 reason', parsed.some((e) => e.reason === '群聊未 @ 机器人'))

// 关闭后不再记录
rec.setEnabled(false)
const offId = rec.start({ chatKey: 'g:1' })
rec.event({ id: offId, stage: 'noise' })
check('关闭后只返回 id 不落事件', rec.get(offId).length === 0 && typeof offId === 'string')
rec.setEnabled(true)
check('可重新开启', (() => { const onId = rec.start({ chatKey: 'g:1' }); return rec.get(onId).length === 1 })())

// summary
const summary = rec.summary()
check('summary 汇总计数', summary.total > 5 && summary.byStage.inbound >= 1, JSON.stringify(summary.byLevel))
check('summary 汇总 topReasons（谁在被静默丢弃）', summary.topReasons.some((r) => r.reason.includes('群聊未 @ 机器人')), JSON.stringify(summary.topReasons))
check('summary 汇总最近错误', summary.errors.some((e) => e.reason.includes('send_group_msg failed')), JSON.stringify(summary.errors))
check('summary 带文件路径与开关状态', summary.file === file && summary.enabled === true)

// listTraces 时间倒序
const traces = rec.listTraces({ limit: 5 })
check('listTraces 倒序返回', traces.length > 0 && traces[0].startedAt >= traces.at(-1).startedAt)
check('listTraces 带阶段轨迹', Array.isArray(traces[0].stages) && traces[0].stages.includes('inbound'))

// 写入失败不抛错（目录不存在时 appendCappedLine 会自建目录）
const deep = new TraceRecorder({ file: join(dir, 'nested', 'deep', 'trace.jsonl'), now: () => clock })
const deepId = deep.start({ chatKey: 'g:1' })
check('嵌套路径自动创建', deep.summary().dropped === 0 && readFileSync(join(dir, 'nested', 'deep', 'trace.jsonl'), 'utf8').includes(deepId))

// 不可序列化数据不炸，且内存环保持可序列化
const weird = new TraceRecorder({ file: join(dir, 'weird.jsonl'), now: () => clock })
const circular = { name: 'loop' }
circular.self = circular
weird.event({ id: 't-x', stage: 'noise', data: circular })
const weirdEvent = weird.recent({ limit: 5 })[0]
check('循环引用数据被兜底为可序列化对象', weirdEvent?.data?.unserializable === true && Array.isArray(weirdEvent.data.keys), JSON.stringify(weirdEvent?.data))
check('内存环始终可 JSON 序列化', (() => { try { JSON.stringify(weird.recent({ limit: 5 })); return true } catch { return false } })())
check('落盘行仍是合法 JSON', (() => { try { JSON.parse(readFileSync(join(dir, 'weird.jsonl'), 'utf8').trim()); return true } catch { return false } })())

// 截断的文件（轮转留尾）也能被解析
writeFileSync(join(dir, 'truncated.jsonl'), '{"v":1,"ts":1,"i\n{"v":1,"ts":2,"id":"t-ok","stage":"x","ok":true}\n', 'utf8')
const raw = readFileSync(join(dir, 'truncated.jsonl'), 'utf8').trim().split('\n')
check('截断行可被解析器跳过（数据行仍可解析）', (() => {
  let ok = 0
  for (const line of raw) { try { JSON.parse(line); ok += 1 } catch { /* 半行跳过 */ } }
  return ok === 1
})())

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
