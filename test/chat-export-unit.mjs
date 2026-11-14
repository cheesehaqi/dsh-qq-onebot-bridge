/**
 * 聊天记录导出：命令解析、Markdown 排版、归档 recent 读取。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryArchive } from '../lib/archive.js'
import { buildChatExport, parseExportCommand, parseSummaryCommand } from '../lib/chat-export.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS', name, extra) }
  else { failed += 1; console.log('FAIL', name, extra) }
}

check('导出命令：/导出 默认 7 天', parseExportCommand('/导出')?.days === 7)
check('导出命令：/导出 3 天', parseExportCommand('/导出 3')?.days === 3)
check('导出命令：/export 99 夹到 30 天', parseExportCommand('/export 99')?.days === 30)
check('导出命令：/导出 3 csv 带格式', parseExportCommand('/导出 3 csv')?.format === 'csv' && parseExportCommand('/导出 3 csv')?.days === 3)
check('导出命令：/export json 带格式', parseExportCommand('/export json')?.format === 'json')
check('导出命令：格式写错报可读原因', String(parseExportCommand('/导出 3 yaml')?.error).includes('用法'))
check('导出命令：不是命令返回 null', parseExportCommand('/导出记录') === null && parseExportCommand('导出') === null)
check('总结命令：/summary 默认 30 条', parseSummaryCommand('/summary')?.count === 30)
check('总结命令：/总结 80 条', parseSummaryCommand('/总结 80')?.count === 80)
check('总结命令：/summary 999 夹到 200 条', parseSummaryCommand('/summary 999')?.count === 200)
check('总结命令：不是命令返回 null', parseSummaryCommand('/summary一下') === null)

const built = buildChatExport({
  chatKey: 'g:100',
  records: [
    { ts: new Date('2026-11-13T09:00:00+08:00').getTime(), name: '甲', text: '第一行\n第二行' },
    { ts: new Date('2026-11-13T09:01:00+08:00').getTime(), name: '乙', text: '收到' },
  ],
})
check('导出内容：标题/计数/时间/名字', built.count === 2 && built.text.includes('g:100')
  && built.text.includes('消息数：2') && built.text.includes('甲: 第一行 第二行') && built.text.includes('乙: 收到'), built.text.slice(0, 160))
check('导出内容：换行被压平（不会撑破一条记录）', !built.text.includes('第一行\n第二行'))
check('导出内容：空记录也有占位', buildChatExport({ chatKey: 'u:1', records: [] }).text.includes('（没有消息）'))
const csv = buildChatExport({
  chatKey: 'g:100',
  format: 'csv',
  records: [{ ts: new Date('2026-11-13T09:00:00+08:00').getTime(), name: '甲', text: '逗号,和"引号"' }],
})
check('CSV：BOM/表头/字段转义/扩展名', csv.extension === 'csv' && csv.text.startsWith('\uFEFF时间,名字,内容') && csv.text.includes('逗号,和""引号""'), csv.text.slice(0, 120))
const json = buildChatExport({
  chatKey: 'g:100',
  format: 'json',
  records: [{ ts: new Date('2026-11-13T09:00:00+08:00').getTime(), name: '甲', text: '内容' }],
})
check('JSON：可解析且扩展名/类型正确', json.extension === 'json' && json.contentType.includes('application/json')
  && JSON.parse(json.text).records[0].text === '内容', json.text.slice(0, 120))

const dir = mkdtempSync(join(tmpdir(), 'qq-archive-export-'))
const now = new Date('2026-11-13T10:00:00+08:00').getTime()
const archive = new HistoryArchive({ dir, now: () => now })
archive.append({ ts: now - 2 * 86_400_000, chatKey: 'g:1', userId: 1, name: '老消息', text: '前天' })
archive.append({ ts: now - 60_000, chatKey: 'g:1', userId: 1, name: '甲', text: '今天一' })
archive.append({ ts: now - 30_000, chatKey: 'g:1', userId: 2, name: '乙', text: '今天二' })
archive.append({ ts: now - 20_000, chatKey: 'g:2', userId: 3, name: '别人', text: '别的群' })
const recent = archive.recent({ days: 7, limit: 2, chatKey: 'g:1' })
check('归档 recent：只取本会话最近的 N 条（正序）',
  recent.records.length === 2 && recent.records[0].text === '今天一' && recent.records[1].text === '今天二'
  && recent.truncated === true, JSON.stringify(recent.records.map((item) => item.text)))
const all = archive.recent({ days: 7, limit: 10, chatKey: 'g:1' })
check('归档 recent：天数过滤 + 跨天', all.records.length === 3 && all.records[0].text === '前天', JSON.stringify(all.records.map((item) => item.text)))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
