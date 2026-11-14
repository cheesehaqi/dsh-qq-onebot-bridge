/**
 * 聊天记录导出：把当前会话的归档消息排成 Markdown。
 * 纯函数，便于单测；真正写文件/发文件由 bridge 做。
 */

const COMMAND_RE = /^[\/／](?:export|导出)(?:\s+(\d+))?(?:\s+(md|csv|json))?$/i
const EXPORT_FORMATS = new Set(['md', 'csv', 'json'])

/** `/导出`、`/导出 7`、`/导出 7 csv`、`/export 30 json`；不是这个命令返回 null，格式写错返回 error。 */
export function parseExportCommand(text) {
  const source = String(text ?? '').trim()
  const matched = COMMAND_RE.exec(source)
  if (!matched) {
    if (/^[\/／](?:export|导出)(?:\s|$)/i.test(source)) return { error: '用法：/导出 [天数] [md|csv|json]（天数 1–30）' }
    return null
  }
  const days = Math.max(1, Math.min(30, Math.floor(Number(matched[1])) || 7))
  const format = (matched[2] || 'md').toLowerCase()
  if (!EXPORT_FORMATS.has(format)) return { error: `不支持的导出格式：${format}（可选 md / csv / json）` }
  return { days, format }
}

const SUMMARY_RE = /^[\/／](?:summary|总结)(?:\s+(\d+))?$/

/** `/summary`、`/summary 50`、`/总结 80`；返回要总结的条数（默认 30，最多 200）。 */
export function parseSummaryCommand(text) {
  const matched = SUMMARY_RE.exec(String(text ?? '').trim())
  if (!matched) return null
  const count = Math.max(1, Math.min(200, Math.floor(Number(matched[1])) || 30))
  return { count }
}

function stamp(ms) {
  const date = new Date(Number(ms) || Date.now())
  if (Number.isNaN(date.getTime())) return '????-??-?? ??:??'
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * @param {{ chatKey?: string, records?: Array<{ts?:number,name?:string,text?:string}>, format?: 'md'|'csv'|'json' }} input
 * @returns {{ text: string, count: number, extension: string, contentType: string }}
 */
export function buildChatExport({ chatKey = '', records = [], format = 'md' } = {}) {
  const rows = Array.isArray(records) ? records : []
  const kind = EXPORT_FORMATS.has(format) ? format : 'md'
  const clean = rows.map((record) => ({
    ts: Number(record?.ts) || 0,
    name: String(record?.name || '未知').replace(/\s+/g, ' ').trim().slice(0, 40) || '未知',
    text: String(record?.text ?? '').replace(/\r?\n/g, ' ').trim().slice(0, 2000),
  }))
  if (kind === 'json') {
    return {
      count: clean.length,
      extension: 'json',
      contentType: 'application/json; charset=utf-8',
      text: JSON.stringify({ chatKey, exportedAt: Date.now(), count: clean.length, records: clean }, null, 2),
    }
  }
  if (kind === 'csv') {
    const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const lines = ['时间,名字,内容', ...clean.map((record) => [stamp(record.ts), record.name, record.text].map(quote).join(','))]
    return {
      count: clean.length,
      extension: 'csv',
      contentType: 'text/csv; charset=utf-8',
      text: `\uFEFF${lines.join('\n')}\n`,
    }
  }
  const lines = clean.map((record) => `- [${stamp(record.ts)}] ${record.name}: ${record.text}`)
  return {
    count: clean.length,
    extension: 'md',
    contentType: 'text/markdown; charset=utf-8',
    text: [
      `# ${chatKey || '聊天'} 聊天记录导出`,
      '',
      `- 导出时间：${stamp(Date.now())}`,
      `- 消息数：${clean.length}`,
      '',
      ...(lines.length > 0 ? lines : ['（没有消息）']),
      '',
    ].join('\n'),
  }
}
