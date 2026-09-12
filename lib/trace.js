/**
 * Structured, always-on tracing for the bridge ("一切皆可调试" 的地基).
 *
 * Every inbound message gets a traceId; every decision point — including every
 * silent drop — appends one event carrying stage / ok / reason / ms. Events go
 * to a size-capped JSONL file (which the standalone console reads cross-process)
 * and to a bounded in-memory ring (for /health and same-process summaries).
 *
 * Dependency-free and fully injectable so it can be unit-tested.
 */
import { appendCappedLine } from './store.js'

export const LEVELS = ['debug', 'info', 'warn', 'error']

/** Counters that make the "did anything get silently dropped?" question answerable. */
export const STAGES = {
  inbound: '收到消息',
  whitelist: '白名单',
  quiet: '静默时段',
  dedup: '重复投递',
  filter: '敏感词/刷屏',
  verify: '入群验证',
  keyword: '关键词词库',
  game: '小游戏',
  command: '命令',
  mention: '群聊 @ 门',
  quote: '引用解析',
  media: '媒体下载',
  transcribe: '语音转文字',
  agent: 'AGENT',
  reply: '出站回复',
  ratelimit: '出站限流',
  notice: 'NOTICE 事件',
  request: 'REQUEST 事件',
  timer: '定时任务',
  action: 'OneBot 写操作',
}

let counter = 0

/** Short, sortable trace id (`t-<base36 time>-<n>`). */
export function newTraceId(now = Date.now()) {
  counter = (counter + 1) % 100000
  return `t-${Math.floor(now / 1000).toString(36)}-${counter.toString(36)}`
}

/**
 * A per-message handle: `mark()` records one decision and its duration since the
 * previous mark, which is exactly the decision-chain timeline the console shows.
 */
export function beginTrace(recorder, meta = {}) {
  const id = recorder.start(meta)
  const chatKey = String(meta.chatKey ?? '')
  let last = recorder.now()
  const handle = {
    id,
    chatKey,
    /** Record one step: ok=false + reason is how "silent drops" become visible. */
    mark(stage, { ok = true, reason = '', data = null, level = 'info' } = {}) {
      const now = recorder.now()
      recorder.event({ id, stage, ok, reason, data, level, chatKey, ms: Math.max(0, now - last) })
      last = now
      return handle
    },
    /** Measure an async external call (OneBot action, STT, TTS, model turn...). */
    async step(stage, fn, options = {}) {
      const started = recorder.now()
      try {
        const value = await fn()
        recorder.event({ id, stage, ok: true, ms: recorder.now() - started, chatKey, module: options.module ?? 'bridge', data: options.data ?? null, level: options.level ?? 'debug' })
        last = recorder.now()
        return value
      } catch (error) {
        recorder.event({
          id, stage, ok: false, ms: recorder.now() - started, chatKey,
          module: options.module ?? 'bridge', level: 'error',
          reason: error?.message ?? String(error), data: options.data ?? null,
        })
        last = recorder.now()
        throw error
      }
    },
    events() {
      return recorder.get(id)
    },
  }
  return handle
}

function jsonlSafe(event) {
  try {
    return JSON.stringify(event)
  } catch {
    return JSON.stringify({ v: event.v, ts: event.ts, id: event.id, level: 'error', module: event.module, stage: event.stage, ok: false, reason: 'event not serializable' })
  }
}

/**
 * Keep the ring serializable: a circular or exotic `data` value must never be
 * able to break a later JSON.stringify (the console reads these events).
 */
function serializable(data) {
  try {
    JSON.stringify(data)
    return data
  } catch {
    let keys = []
    try { keys = Object.keys(data ?? {}).slice(0, 10) } catch { keys = [] }
    return { unserializable: true, type: typeof data, keys }
  }
}

export class TraceRecorder {
  constructor({ file = '', memoryLimit = 500, enabled = true, level = 'debug', now = () => Date.now(), maxBytes = 4 * 1024 * 1024, keepBytes = 512 * 1024 } = {}) {
    this.file = file
    this.enabled = enabled !== false
    this.level = LEVELS.includes(level) ? level : 'debug'
    this.memoryLimit = Math.max(20, Number(memoryLimit) || 500)
    this.now = now
    this.maxBytes = maxBytes
    this.keepBytes = keepBytes
    this.ring = []
    this.traces = new Map()      // id -> { id, startedAt, chatKey, stages: [], lastAt }
    this.counts = { total: 0, byLevel: {}, byStage: {}, dropped: 0 }
  }

  setEnabled(enabled) {
    this.enabled = enabled !== false
  }

  /** Begin a trace for one inbound message; returns its id. */
  start({ chatKey = '', userId = 0, groupId = 0, messageType = '', messageId = '', text = '' } = {}) {
    const id = newTraceId(this.now())
    if (!this.enabled) return id
    const trace = { id, startedAt: this.now(), chatKey, stages: [], counts: {} }
    this.traces.set(id, trace)
    if (this.traces.size > this.memoryLimit) {
      const oldest = [...this.traces.keys()].slice(0, this.traces.size - this.memoryLimit)
      for (const key of oldest) this.traces.delete(key)
    }
    this.event({ id, level: 'info', module: 'bridge', stage: 'inbound', ok: true, chatKey, data: { userId, groupId, messageType, messageId, text: String(text ?? '').slice(0, 120) } })
    return id
  }

  /** Append one event (silent no-op when tracing is disabled). */
  event({ id = '', level = 'info', module = 'bridge', stage = '', ok = true, reason = '', ms = 0, chatKey = '', data = null } = {}) {
    if (!this.enabled) return null
    const event = {
      v: 1,
      ts: this.now(),
      id: id || 't-untraced',
      level: LEVELS.includes(level) ? level : 'info',
      module,
      stage,
      ok: ok !== false,
    }
    if (reason) event.reason = String(reason).slice(0, 300)
    if (ms) event.ms = Math.round(ms)
    if (chatKey) event.chatKey = String(chatKey)
    if (data !== null && data !== undefined) event.data = serializable(data)
    if (LEVELS.indexOf(event.level) < LEVELS.indexOf(this.level)) return null

    this.counts.total += 1
    this.counts.byLevel[event.level] = (this.counts.byLevel[event.level] ?? 0) + 1
    const stageKey = stage || 'unknown'
    this.counts.byStage[stageKey] = (this.counts.byStage[stageKey] ?? 0) + 1

    const trace = this.traces.get(id)
    if (trace) {
      trace.lastAt = event.ts
      trace.stages.push(stageKey)
      trace.counts[stageKey] = (trace.counts[stageKey] ?? 0) + 1
      trace.durationMs = event.ts - trace.startedAt
    }

    this.ring.push(event)
    if (this.ring.length > this.memoryLimit) this.ring.splice(0, this.ring.length - this.memoryLimit)
    if (this.file) {
      const wrote = appendCappedLine(this.file, jsonlSafe(event), { maxBytes: this.maxBytes, keepBytes: this.keepBytes })
      if (!wrote) this.counts.dropped += 1
    }
    return event
  }

  /**
   * Wrap an async step: records ok + duration, and on failure records the error
   * message before re-throwing (so failures are never silent).
   */
  async step(id, stage, fn, { module = 'bridge', chatKey = '', data = null, level = 'debug' } = {}) {
    const started = this.now()
    try {
      const value = await fn()
      this.event({ id, stage, ok: true, ms: this.now() - started, module, chatKey, level, data })
      return value
    } catch (error) {
      this.event({ id, stage, ok: false, ms: this.now() - started, module, chatKey, level: 'error', reason: error?.message ?? String(error), data })
      throw error
    }
  }

  /** Events of one trace, in order. */
  get(id) {
    return this.ring.filter((event) => event.id === id)
  }

  /** Recent events with simple filters (used by /health and by tests). */
  recent({ limit = 50, chatKey = '', level = '', stage = '', ok = null } = {}) {
    return this.ring
      .filter((event) => (chatKey ? event.chatKey === chatKey : true))
      .filter((event) => (level ? event.level === level : true))
      .filter((event) => (stage ? event.stage === stage : true))
      .filter((event) => (ok === null ? true : event.ok === ok))
      .slice(-Math.max(1, limit))
  }

  /** Aggregated view: totals, the biggest silent-drop reasons, recent errors. */
  summary() {
    const dropReasons = new Map()
    for (const event of this.ring) {
      if (event.ok === false && event.stage === 'drop' || (event.ok === false && event.reason)) {
        const key = `${event.stage}: ${event.reason}`
        dropReasons.set(key, (dropReasons.get(key) ?? 0) + 1)
      }
    }
    return {
      enabled: this.enabled,
      level: this.level,
      total: this.counts.total,
      byLevel: { ...this.counts.byLevel },
      byStage: { ...this.counts.byStage },
      dropped: this.counts.dropped,
      traces: this.traces.size,
      ringSize: this.ring.length,
      topReasons: [...dropReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ reason, count })),
      errors: this.ring.filter((event) => event.level === 'error').slice(-5).map((event) => ({ ts: event.ts, id: event.id, stage: event.stage, reason: event.reason ?? '' })),
      file: this.file,
    }
  }

  /** All traces started recently (id + first/last ts + stage trail). */
  listTraces({ limit = 50 } = {}) {
    return [...this.traces.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.max(1, limit))
      .map((trace) => ({
        id: trace.id,
        chatKey: trace.chatKey,
        startedAt: trace.startedAt,
        durationMs: trace.durationMs ?? 0,
        stages: trace.stages,
      }))
  }
}
