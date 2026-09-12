/**
 * Console-side reader for the bridge's trace stream.
 *
 * The bridge runs inside the DSH host process and the console is a separate
 * process, so the contract is a file: `qq-trace.jsonl` (one JSON event per line,
 * size-rotated) plus `qq-runtime.json` (session/gate/feature snapshot). This
 * module turns those bytes into filters, decision chains and digests.
 */
import { readFileSync, statSync } from 'node:fs'
import { openSync, readSync, closeSync } from 'node:fs'

/** Parse JSONL text into events, skipping blank/partial (rotated) lines. */
export function parseTraceLines(text) {
  const events = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    try {
      const event = JSON.parse(trimmed)
      if (event && typeof event.ts === 'number') events.push(event)
    } catch { /* 轮转可能留下半行，跳过 */ }
  }
  return events
}

/** Read the tail of the trace file (bounded bytes) and parse it. */
export function readTraceFile(file, { maxBytes = 2 * 1024 * 1024, readFile = readFileSync } = {}) {
  let text = ''
  try { text = readFile(file, 'utf8') } catch { return [] }
  if (text.length > maxBytes) text = text.slice(-maxBytes)
  return parseTraceLines(text)
}

/** Incremental tailer: only the bytes appended since the last poll are parsed. */
export function createTraceTailer(file, { initialBytes = 256 * 1024 } = {}) {
  let offset = -1
  let inode = ''
  let skipPartial = false
  return {
    /**
     * @returns {object[]} events appended since the previous poll; the first poll
     *   returns the recent tail (up to `initialBytes`) so a fresh client is not blind.
     */
    poll() {
      let stat
      try { stat = statSync(file) } catch { offset = -1; inode = ''; return [] }
      const stamp = String(stat.ino)
      const rotated = inode !== '' && inode !== stamp
      if (offset < 0 || rotated || stat.size < offset) {
        offset = stat.size > initialBytes ? stat.size - initialBytes : 0
        // 只有从文件中间开始读时才需要丢掉半行；从 0 开始一定是行首。
        skipPartial = offset > 0
      }
      inode = stamp
      if (stat.size <= offset) return []
      const length = stat.size - offset
      const buffer = Buffer.allocUnsafe(length)
      let fd = null
      try {
        fd = openSync(file, 'r')
        readSync(fd, buffer, 0, length, offset)
      } catch {
        return []
      } finally {
        if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
      }
      offset = stat.size
      let text = buffer.toString('utf8')
      if (skipPartial) {
        const firstNewline = text.indexOf('\n')
        text = firstNewline < 0 ? '' : text.slice(firstNewline + 1)
        skipPartial = false
      }
      return parseTraceLines(text)
    },
    reset() { offset = -1; inode = ''; skipPartial = false },
  }
}

/** Filter events by the fields the console exposes. */
export function filterEvents(events, { chatKey = '', level = '', stage = '', traceId = '', ok = null, since = 0, limit = 500 } = {}) {
  const filtered = events.filter((event) => {
    if (chatKey && event.chatKey !== chatKey) return false
    if (level && event.level !== level) return false
    if (stage && event.stage !== stage) return false
    if (traceId && event.id !== traceId) return false
    if (ok !== null && event.ok !== ok) return false
    if (since && event.ts < since) return false
    return true
  })
  return filtered.slice(-Math.max(1, limit))
}

/** Group events into per-message decision chains (newest last). */
export function groupChains(events) {
  const chains = new Map()
  for (const event of events) {
    const id = event.id || 't-untraced'
    if (!chains.has(id)) chains.set(id, { id, chatKey: event.chatKey ?? '', events: [] })
    const chain = chains.get(id)
    chain.events.push(event)
    if (!chain.chatKey && event.chatKey) chain.chatKey = event.chatKey
  }
  const list = [...chains.values()].map((chain) => {
    const first = chain.events[0]
    const last = chain.events[chain.events.length - 1]
    const failed = chain.events.some((event) => event.ok === false)
    const errored = chain.events.some((event) => event.level === 'error')
    return {
      ...chain,
      startedAt: first?.ts ?? 0,
      endedAt: last?.ts ?? 0,
      durationMs: Math.max(0, (last?.ts ?? 0) - (first?.ts ?? 0)),
      stoppedAt: chain.events.find((event) => event.ok === false)?.stage ?? '',
      stoppedReason: chain.events.find((event) => event.ok === false)?.reason ?? '',
      reachedReply: chain.events.some((event) => event.stage === 'reply' && event.ok !== false),
      failed,
      errored,
      stages: chain.events.map((event) => event.stage),
    }
  })
  return list.sort((a, b) => b.startedAt - a.startedAt)
}

/** Aggregate view used by the panel header and the error badge. */
export function summarizeEvents(events) {
  const byLevel = {}
  const byStage = {}
  const reasons = new Map()
  const errors = []
  let dropped = 0
  for (const event of events) {
    byLevel[event.level ?? 'info'] = (byLevel[event.level ?? 'info'] ?? 0) + 1
    byStage[event.stage ?? 'unknown'] = (byStage[event.stage ?? 'unknown'] ?? 0) + 1
    if (event.ok === false) {
      dropped += 1
      const key = `${event.stage}: ${event.reason ?? '（无原因）'}`
      reasons.set(key, (reasons.get(key) ?? 0) + 1)
    }
    if (event.level === 'error') errors.push({ ts: event.ts, id: event.id, stage: event.stage, reason: event.reason ?? '', level: 'error' })
    else if (event.level === 'warn') errors.push({ ts: event.ts, id: event.id, stage: event.stage, reason: event.reason ?? '', level: 'warn' })
  }
  return {
    total: events.length,
    byLevel,
    byStage,
    dropped,
    traces: new Set(events.map((event) => event.id)).size,
    topReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ reason, count })),
    errors: errors.slice(-20),
  }
}

/** Human-readable timeline lines for one chain (used by tests and the CLI). */
export function formatChain(chain) {
  if (!chain) return []
  return chain.events.map((event) => {
    const time = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false })
    const flag = event.ok === false ? '✗' : '·'
    const ms = event.ms ? ` +${event.ms}ms` : ''
    const reason = event.reason ? ` — ${event.reason}` : ''
    return `${time} ${flag} [${event.stage}] ${event.level}${ms}${reason}`
  })
}

/** Runtime snapshot written by the bridge (missing/corrupt → null). */
export function readRuntime(file, { readFile = readFileSync } = {}) {
  try {
    const data = JSON.parse(readFile(file, 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}
