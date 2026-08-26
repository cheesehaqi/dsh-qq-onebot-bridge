/**
 * Group tools: vote-command parsing and a file-backed shared todo store.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Parse a vote command: "投票：今晚吃什么？A 火锅 B 烧烤" or "/vote 问题 A xxx B yyy".
 * Returns { question, options: [{ key, label }] } or null. Bare questions get 赞成/反对.
 */
export function parseVoteCommand(text) {
  const t = String(text ?? '').trim()
  const m = /^(?:投票|发起投票|接龙|\/vote)\s*[:：]?\s*(.+)$/.exec(t)
  if (!m) return null
  const body = m[1].trim()
  const optRe = /([A-Da-d])[\s\.、．:：]+([^A-Da-d].*?)(?=\s+[A-Da-d][\s\.、．:：]|$)/g
  const found = [...body.matchAll(optRe)]
  if (found.length >= 2) {
    const question = body.slice(0, found[0].index).replace(/[:：?？\s]+$/, '').trim() || '投票'
    const options = found.map((mm) => ({ key: mm[1].toUpperCase(), label: mm[2].trim() }))
    return { question, options }
  }
  return { question: body.replace(/[:：?？\s]+$/, ''), options: [{ key: 'A', label: '赞成' }, { key: 'B', label: '反对' }] }
}

/** File-backed shared todo list per chat (key = route key). */
export class TodoStore {
  constructor(directory) {
    this.directory = directory
  }

  #file(key) {
    return join(this.directory, `${String(key).replace(/[^\w-]/g, '_')}.json`)
  }

  load(key) {
    try {
      const data = JSON.parse(readFileSync(this.#file(key), 'utf8'))
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  save(key, list) {
    try {
      mkdirSync(this.directory, { recursive: true })
      writeFileSync(this.#file(key), JSON.stringify(list, null, 2), 'utf8')
    } catch { /* best effort */ }
  }
}
