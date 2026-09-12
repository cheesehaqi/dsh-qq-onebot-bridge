/**
 * Offline dry-run replay for the control console (v0.4 阶段 3：可复现).
 *
 * "离线" is literal here:
 *   - the REAL bridge code runs, but inside a sandbox directory: every file the
 *     bridge derives from `config.cwd` (state, trace, runtime, media) points at the
 *     sandbox, so a replay can never write into the live bot's files;
 *   - the REAL `OneBotServer` is used with dry-run on and `start()` never called, so
 *     there is no socket, no listening port and no way to reach QQ;
 *   - the agent is a mock: it does not call any model, it answers with one clearly
 *     labelled canned line, and the reply still travels the real outbound path
 *     (segment shaping → action gate → dry-run capture).
 *
 * What replay therefore proves: which branch the pipeline takes, and why.
 * What it does NOT prove: the model's actual wording.
 *
 * Everything side-effecting is injected, so the whole module is unit-testable.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { moveToTrash } from '../../lib/store.js'

/** Live state worth copying so replay decisions match production at replay time. */
export const STATE_FILES = [
  'qq-keywords.json', 'qq-reminders.json', 'qq-sessions.json', 'qq-dailyreport.json',
  'qq-faces.json', 'qq-counters.json',
]
export const STATE_DIRS = ['qq-memory', 'qq-points', 'qq-checkin', 'qq-stats', 'qq-todos', 'qq-faces']

/** Media/reply directories: too big to copy, and their absence changes branches. */
export const MEDIA_DIRS = ['qq-images', 'qq-media', 'qq-files', 'qq-replies', 'qq-tts', 'qq-exports']

/** Never copied, and forced onto the sandbox no matter what the caller asks for. */
export const NEVER_COPY = [
  'qq-runtime.json', 'qq-inbox.jsonl', 'qq-inject.jsonl', 'qq-trace.jsonl', 'qq-actions.log',
  'qq-bridge-debug.log', 'qq-host-out.log', 'qq-host-err.log', 'qq-control.json',
]

/** Config keys that must not escape the sandbox, whatever the caller sends. */
export function sandboxConfig(sandbox, botQq = 0) {
  return {
    cwd: sandbox,
    traceFile: join(sandbox, 'qq-trace.jsonl'),
    inboxFile: join(sandbox, 'qq-inbox.jsonl'),
    injectFile: join(sandbox, 'qq-inject.jsonl'),
    keywordFile: join(sandbox, 'qq-keywords.json'),
    traceEnabled: true,
    traceLevel: 'debug',
    traceMemorySize: 5000,
    recordInbound: false,
    injectEnabled: false,
    notifyEnabled: false,
    ttsEnabled: false,
    sttEnabled: false,
    sessionResumeEnabled: false,
    actionAuditEnabled: false,
    ...(botQq > 0 ? { botQq } : {}),
  }
}

/** Relative names that exist and are safe to copy into the sandbox. */
export function planSandboxCopy(source, {
  exists = existsSync,
  readdir = readdirSync,
  stat = statSync,
} = {}) {
  const files = []
  const dirs = []
  const skippedMedia = []
  for (const name of STATE_FILES) {
    if (NEVER_COPY.includes(name)) continue
    try { if (exists(join(source, name)) && stat(join(source, name)).isFile()) files.push(name) } catch { /* ignore */ }
  }
  for (const name of STATE_DIRS) {
    try { if (exists(join(source, name)) && stat(join(source, name)).isDirectory()) dirs.push(name) } catch { /* ignore */ }
  }
  for (const name of MEDIA_DIRS) {
    try { if (exists(join(source, name)) && stat(join(source, name)).isDirectory() && readdir(join(source, name)).length > 0) skippedMedia.push(name) } catch { /* ignore */ }
  }
  return { files, dirs, skippedMedia }
}

/** Copy the live decision state into the sandbox (best effort, never throws). */
export function copySandboxState(source, sandbox, deps = {}) {
  const fs = {
    exists: deps.exists ?? existsSync,
    readdir: deps.readdir ?? readdirSync,
    stat: deps.stat ?? statSync,
    mkdir: deps.mkdir ?? mkdirSync,
    copyFile: deps.copyFile ?? copyFileSync,
    copyDir: deps.copyDir ?? ((from, to) => cpSync(from, to, { recursive: true })),
  }
  const plan = planSandboxCopy(source, fs)
  const copied = []
  const failed = []
  try { fs.mkdir(sandbox, { recursive: true }) } catch { return { copied, failed: ['<sandbox>'], skippedMedia: plan.skippedMedia } }
  for (const name of plan.files) {
    try { fs.copyFile(join(source, name), join(sandbox, name)); copied.push(name) } catch { failed.push(name) }
  }
  for (const name of plan.dirs) {
    try { fs.copyDir(join(source, name), join(sandbox, name)); copied.push(`${name}/`) } catch { failed.push(name) }
  }
  return { copied, failed, skippedMedia: plan.skippedMedia }
}

/**
 * Mock agent context: enough of the DSH surface for the real bridge to run, with a
 * scripted agent that emits a normal turn (`turn/start` → `assistant/message` →
 * `turn/end`) so the real reply path executes.
 */
export function createMockCtx({ replyText = '[回放] 这是离线回放的模拟回复（不是模型真实输出）', botQq = 0, delayMs = 0 } = {}) {
  const listeners = new Map()
  const tools = []
  const sections = []
  const turns = []
  let seq = 0

  const on = (name, handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name).add(handler)
    return () => { listeners.get(name)?.delete(handler) }
  }
  const emit = (name, ...args) => {
    for (const handler of [...(listeners.get(name) ?? [])]) {
      try { handler(...args) } catch { /* 回放不因监听器异常中断 */ }
    }
  }

  const makeAgent = (sessionId) => ({
    id: sessionId,
    status: 'idle',
    followup(message) {
      const text = Array.isArray(message?.content)
        ? message.content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
        : ''
      turns.push({ sessionId, text })
      const runTurn = () => {
        const session = { id: sessionId }
        emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
        emit('session/event', session, {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: replyText }] }, turn: 1 },
        })
        emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      }
      if (delayMs > 0) setTimeout(runTurn, delayMs)
      else queueMicrotask(runTurn)
      return Promise.resolve()
    },
    cancel() { /* 回放无需中断 */ },
  })

  const agentCtx = {
    tools: { register: (tool) => { tools.push(tool); return tool } },
    systemPrompt: { section: (section) => { sections.push(section); return section } },
  }

  const newHandle = (sessionId, setup) => {
    const id = String(sessionId ?? `qq-replay-${++seq}`)
    const agent = makeAgent(id)
    if (typeof setup === 'function') setup(agentCtx)
    return { agent, sessionId: id, dispose: async () => {} }
  }

  const ctx = {
    on,
    get: () => undefined,
    agents: {
      create: async ({ sessionId, setup }) => newHandle(sessionId, setup),
      resume: async ({ resumeSessionId, setup }) => newHandle(resumeSessionId, setup),
    },
    agentDefaultModel: { currentSelection: () => ({}) },
  }
  return { ctx, tools, sections, turns, emit, agentCtx, botQq }
}

/** Config keys the live runtime snapshot may contribute to a replay. */
export const HINT_KEYS = [
  'botQq', 'allowGroups', 'allowUsers', 'adminUsers', 'quietHours', 'quietHoursEnabled',
  'replyOnlyWhenMentioned', 'acceptPrivate', 'sessionMode', 'dedupWindowSeconds',
  'keywordEnabled', 'checkinEnabled', 'checkinKeyword', 'welcomeEnabled', 'pokeEnabled',
  'groupReadEnabled', 'statsEnabled', 'pointsEnabled', 'gameEnabled', 'fortuneEnabled',
  'diceEnabled', 'filterEnabled', 'floodEnabled', 'antiRecallEnabled', 'voiceReadingEnabled',
  'maxMessageLength', 'memoryEnabled', 'filterAction',
]

/**
 * Take the decision-relevant subset of the live runtime snapshot's `replay` hints.
 * Anything outside HINT_KEYS is ignored — including any attempt to move `cwd`.
 */
export function hintConfig(hints) {
  const out = {}
  if (!hints || typeof hints !== 'object') return out
  for (const key of HINT_KEYS) {
    const value = hints[key]
    if (value === undefined || value === null) continue
    out[key] = value
  }
  return out
}

/** Human label for a trace stage (falls back to the raw id). */
export function stageLabel(stage, stages = {}) {
  return stages[stage] ?? String(stage ?? '')
}

/**
 * Turn one replayed entry's trace events + captured outbound calls into a verdict.
 * The verdict ALWAYS carries a reason — that is the point of the whole feature.
 */
export function summarizeEntry({ entry, kind = 'message', events = [], calls = [], stages = {}, timedOut = false } = {}) {
  // 只有 level==='error' 才算真出错：被拒分支（白名单/静默/未 @）是正常决策，level 为 info。
  const errorEvent = events.find((event) => event.level === 'error')
  const sends = calls.filter((call) => /send|upload/.test(String(call.action ?? '')))
  const others = calls.filter((call) => !/send|upload/.test(String(call.action ?? '')))
  const traceId = events.find((event) => event.id)?.id ?? ''
  let verdict
  let status
  if (errorEvent) {
    status = 'error'
    verdict = `出错：${errorEvent.reason || errorEvent.stage}`
  } else if (sends.length > 0) {
    status = 'replied'
    verdict = `会发出 ${sends.length} 条消息（dry-run 已拦截，未真正发送）`
  } else if (others.length > 0) {
    status = 'action'
    verdict = `只调用了 ${others.length} 个非发送动作：${others.map((call) => call.action).join('、')}`
  } else {
    status = 'silent'
    const reason = [...events].reverse().find((event) => event.ok === false && event.reason)
    verdict = reason ? `没有回复：${reason.reason}` : '没有回复：消息在链路中被静默丢弃（未记录到原因，请检查 traceLevel）'
  }  if (timedOut) verdict += '（等待超时，结果可能不完整）'
  return {
    status,
    verdict,
    traceId,
    kind,
    input: '',
    chain: events.map((event) => ({
      stage: event.stage,
      label: stageLabel(event.stage, stages),
      ok: event.ok !== false,
      reason: event.reason ?? '',
      ms: event.ms ?? 0,
      level: event.level ?? 'info',
    })),
    calls: calls.map((call) => ({
      action: call.action,
      text: (call.params?.message ?? []).map((segment) => (segment?.type === 'text' ? String(segment.data?.text ?? '') : `[${segment?.type ?? '?'}]`)).join('').slice(0, 300),
    })),
  }
}

/** Readable Chinese text block for the console / CLI. */
export function formatReplayText(report) {
  const lines = []
  lines.push(`离线回放：${report.results.length} 条（${report.totals.replied} 条会回复 / ${report.totals.silent} 条静默 / ${report.totals.error} 条出错），耗时 ${report.durationMs}ms`)
  lines.push(`沙箱：${report.sandbox}`)
  if (report.safety) {
    lines.push(`安全：dry-run=${report.safety.dryRun ? '开' : '关'}、QQ 连接数=${report.safety.connectedBots}、cwd 已沙箱化=${report.safety.sandboxed ? '是' : '否'}`)
  }
  if (report.copied.length > 0) lines.push(`已复制状态：${report.copied.join('、')}`)
  for (const warning of report.warnings) lines.push(`提示：${warning}`)
  report.results.forEach((result, index) => {
    lines.push('')
    lines.push(`[${index + 1}] ${result.input}`)
    if (result.traceId) lines.push(`    traceId: ${result.traceId}`)
    lines.push(`    结论：${result.verdict}`)
    for (const step of result.chain) {
      if (step.stage === 'inbound') continue
      lines.push(`      ${step.ok ? '✓' : '✗'} ${step.label}${step.reason ? `：${step.reason}` : ''}${step.ms ? ` (${step.ms}ms)` : ''}`)
    }
    for (const call of result.calls) {
      lines.push(`      → 会发送 ${call.action}${call.text ? `：${call.text}` : ''}`)
    }
  })
  return lines.join('\n')
}

/** Wait until the bridge stops producing trace events / outbound calls. */
async function drain({ activity, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), quietMs = 60, maxMs = 2500, samples = 2 }) {
  let last = -1
  let stable = 0
  const started = Date.now()
  while (Date.now() - started < maxMs) {
    const count = activity()
    if (count === last) {
      stable += 1
      if (stable >= samples) return true
    } else {
      stable = 0
      last = count
    }
    await delay(quietMs)
  }
  return false
}

/** Move the oldest replay sandboxes into the local trash (never delete). */
export function pruneSandboxes(root, keep = 5, { readdir = readdirSync, stat = statSync, trash = join(root, '_trash'), now = new Date() } = {}) {
  let names = []
  try { names = readdir(root, { withFileTypes: true }).filter((item) => item.isDirectory() && item.name !== '_trash').map((item) => item.name) } catch { return [] }
  const stamps = names
    .map((name) => {
      try { return { name, mtime: stat(join(root, name)).mtimeMs } } catch { return { name, mtime: 0 } }
    })
    .sort((a, b) => b.mtime - a.mtime)
  const moved = []
  for (const item of stamps.slice(Math.max(0, keep))) {
    const dest = moveToTrash(join(root, item.name), trash, { now })
    if (dest) moved.push(item.name)
  }
  return moved
}

/** Default loaders: the real plugin config schema, bridge and OneBot server. */
async function defaultLoaders(pluginRoot) {
  const [{ QQBridge }, { OneBotServer }, { Config }, { STAGES }] = await Promise.all([
    import(pathToFileURL(join(pluginRoot, 'lib', 'bridge.js')).href),
    import(pathToFileURL(join(pluginRoot, 'lib', 'onebot.js')).href),
    import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href),
    import(pathToFileURL(join(pluginRoot, 'lib', 'trace.js')).href),
  ])
  return { QQBridge, OneBotServer, Config, STAGES }
}

/**
 * @param pluginRoot  repo root (contains lib/)
 * @param sourceCwd   live bot working directory (state is copied from here, read-only)
 * @param sandboxRoot where replay sandboxes live (default `<sourceCwd>/qq-replay`)
 */
export function createReplayer({
  pluginRoot,
  sourceCwd,
  sandboxRoot = '',
  botQq = 0,
  logger = console,
  now = () => Date.now(),
  delay,
  loaders = null,
  keepSandboxes = 5,
  deps = {},
} = {}) {
  const root = sandboxRoot || join(sourceCwd || tmpdir(), 'qq-replay')

  async function run({
    entries = [],
    replyText = '',
    overrides = {},
    hints = null,
    maxEntries = 20,
    budgetMs = 20000,
    perEntryMs = 2500,
    keep = false,
  } = {}) {
    const started = now()
    const warnings = []
    const list = entries.slice(0, Math.max(1, maxEntries))
    if (entries.length > list.length) warnings.push(`一次最多回放 ${maxEntries} 条，已忽略其余 ${entries.length - list.length} 条`)

    const stamp = new Date(started).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const sandbox = join(root, `run-${stamp}`)
    mkdirSync(sandbox, { recursive: true })

    // 插件代码加载失败（pluginRoot 指错、依赖缺失）时必须给出可读原因，绝不静默返回空报告
    let mods
    try {
      mods = loaders ?? await (deps.loaders ?? defaultLoaders)(pluginRoot)
    } catch (error) {
      return failedReport({
        started, sandbox, sourceCwd, botQq, now,
        copied: [], warnings: [...warnings, `无法加载插件代码（pluginRoot=${pluginRoot || '(空)'}）：${error.message}`],
        reason: `无法加载插件代码：${error.message}`,
      })
    }

    const copy = copySandboxState(sourceCwd, sandbox, deps)
    if (copy.failed.length > 0) warnings.push(`以下状态未能复制，回放结果可能与线上不同：${copy.failed.join('、')}`)
    for (const dir of copy.skippedMedia) warnings.push(`未复制媒体目录 ${dir}（回放中引用旧图片/语音会走"文件缺失"分支）`)

    const base = typeof mods.Config === 'function' ? mods.Config({}) : {}
    const live = hintConfig(hints)
    const cleanOverrides = {}
    for (const [key, value] of Object.entries(overrides ?? {})) {
      if (value === undefined || value === null) continue
      cleanOverrides[key] = value
    }
    const config = { ...base, ...live, ...cleanOverrides, ...sandboxConfig(sandbox, botQq) }
    if (typeof cleanOverrides.cwd === 'string' && cleanOverrides.cwd.trim() !== '') {
      warnings.push(`cwd 覆盖（${cleanOverrides.cwd}）被忽略：回放必须在沙箱目录内运行`)
    }
    const hinted = Object.keys(live)
    if (hinted.length > 0) warnings.push(`已采用线上运行时快照中的 ${hinted.length} 项决策配置（${hinted.slice(0, 6).join('、')}${hinted.length > 6 ? '…' : ''}）`)
    else warnings.push('没有可用的线上配置提示，回放使用插件默认值（白名单为空会拒绝所有消息）')

    const server = new mods.OneBotServer({ host: '127.0.0.1', port: 0, botQq, accessToken: '' }, logger)
    server.setDryRun(true)
    const simulatedReply = replyText || '[回放] 这是离线回放的模拟回复（不是模型真实输出）'
    const mock = createMockCtx({ replyText: simulatedReply, botQq })
    const bridge = new mods.QQBridge(mock.ctx, config, server, logger)
    bridge.start()

    const stages = mods.STAGES ?? {}
    const activity = () => server.dryRunCalls.length + bridge.trace.recent({ limit: 5000 }).length + mock.turns.length
    const results = []
    let cursor = 0
    let timeoutHit = false
    try {
      for (const item of list) {
        const entry = item?.entry ?? item
        const kind = entry?.kind ?? 'message'
        const frame = entry?.frame ?? {}
        if (now() - started > budgetMs) {
          warnings.push(`总时间预算 ${budgetMs}ms 用尽，剩余 ${list.length - results.length} 条未回放`)
          break
        }
        const before = server.dryRunCalls.length
        try {
          // 走真实入口：OneBotServer 的事件监听器就是桥注册的那几个。
          // 用 __replayed 而不是 __injected：回放不是注入，绝不能命中"注入回合回复拦截"
          // 那条安全逻辑（否则回放永远看不到本该发出的回复）。
          server.emit(kind, { bot: null, __replayed: true, ...frame })
        } catch (error) {
          results.push({ ...summarizeEntry({ entry, kind, events: [], calls: [], stages }), input: describeInput(entry), status: 'error', verdict: `回放抛出异常：${error.message}` })
          continue
        }
        const settled = await drain({ activity, delay, maxMs: perEntryMs })
        if (!settled) timeoutHit = true
        const allEvents = bridge.trace.recent({ limit: 5000 })
        const events = allEvents.slice(Math.min(cursor, allEvents.length))
        cursor = allEvents.length
        const calls = server.dryRunCalls.slice(before)
        const summary = summarizeEntry({ entry, kind, events, calls, stages, timedOut: !settled })
        results.push({ ...summary, input: describeInput(entry) })
      }
    } finally {
      try { bridge.stop() } catch { /* ignore */ }
      try { await server.stop() } catch { /* ignore */ }
    }
    if (timeoutHit) warnings.push('部分回放等待超时，结论可能不完整')

    const totals = {
      entries: results.length,
      replied: results.filter((item) => item.status === 'replied').length,
      silent: results.filter((item) => item.status === 'silent').length,
      error: results.filter((item) => item.status === 'error').length,
      action: results.filter((item) => item.status === 'action').length,
    }
    // 安全保证：出站全部被 dry-run 拦截，且从未建立任何 QQ 连接
    const safety = {
      dryRun: server.dryRun === true,
      connectedBots: typeof server.currentSocket === 'function' && server.currentSocket() ? 1 : 0,
      sandboxed: String(config.cwd) === sandbox,
      forcedOff: ['notifyEnabled', 'ttsEnabled', 'sttEnabled', 'injectEnabled', 'recordInbound'],
    }
    const report = {
      ok: results.every((item) => item.status !== 'error'),
      ranAt: started,
      durationMs: now() - started,
      sandbox,
      sourceCwd,
      botQq: config.botQq ?? botQq,
      hintedKeys: hinted,
      replyText: simulatedReply,
      copied: copy.copied,
      skippedMedia: copy.skippedMedia,
      warnings,
      safety,
      totals,
      results,
    }
    report.text = formatReplayText(report)
    const pruned = keep ? [] : pruneSandboxes(root, keepSandboxes, deps)
    if (pruned.length > 0) report.warnings.push(`旧沙箱已移入回收站（${join(root, '_trash')}）：${pruned.join('、')}`)
    return report
  }

  return { run, sandboxRoot: root }
}

/** A report-shaped failure (so callers and the text view never see a half object). */
function failedReport({ started, sandbox, sourceCwd, botQq, warnings, reason, copied = [], now = () => Date.now() }) {
  const report = {
    ok: false,
    reason,
    ranAt: started,
    durationMs: Math.max(0, now() - started),
    sandbox,
    sourceCwd,
    botQq,
    hintedKeys: [],
    replyText: '',
    copied,
    skippedMedia: [],
    warnings,
    safety: null,
    totals: { entries: 0, replied: 0, silent: 0, error: 0, action: 0 },
    results: [],
  }
  report.text = `离线回放无法进行：${reason}`
  return report
}

/** One-line description of the frame being replayed. */
function describeInput(entry) {
  const frame = entry?.frame ?? {}
  if (entry?.kind === 'notice') return `通知 ${frame.noticeType ?? '?'}/${frame.subType ?? '?'}（群 ${frame.groupId ?? '-'} 用户 ${frame.userId ?? '-'}）`
  if (entry?.kind === 'request') return `请求 ${frame.requestType ?? '?'}/${frame.subType ?? '?'}（群 ${frame.groupId ?? '-'} 用户 ${frame.userId ?? '-'}）`
  const where = frame.messageType === 'group' ? `群 ${frame.groupId}` : `私聊 ${frame.userId}`
  return `${where}：${String(frame.text ?? '').slice(0, 80) || '（无文本）'}`
}
