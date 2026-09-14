/**
 * 入站 webhook 的**渲染层**：把外部系统 POST 过来的 payload 变成一条中文短消息。
 *
 * 这里不碰网络、不碰 OneBot、不做任何 IO：真实 HTTP 由 lib/webhook.js 负责，
 * 渲染结果交给注入的回调由桥去发 QQ。所以整个模块可以脱离桥单测。
 *
 * 三条铁律（与 lib/assets.js 一致）：
 *   1. 字段缺失一律有兜底，绝不抛错；
 *   2. 任何异常都被 renderWebhook 捕获，返回 { ok: false, text: '', reason: '中文原因' }；
 *   3. 最终文本压空白、按 maxChars 硬截断，截断标记不计入 maxChars。
 */

/** 正文超长时追加的提示语（与 lib/assets.js / lib/forward.js 用同一句）。 */
const TRUNCATED_MARK = '…（内容过长已截断）'

/** maxChars 默认值。 */
const DEFAULT_MAX_CHARS = 800

/** 空模板回落到 JSON 时最多保留多少字符。 */
const RAW_JSON_SNIPPET = 500

/** 占位符取不到值时的替换文本。 */
const MISSING_MARK = '（无）'

// ------------------------------------------------------------- 基础工具 ----

/** 空白（含全角空格）压成单个半角空格并 trim。 */
function collapse(value) {
  return String(value ?? '').replace(/[\s\u3000]+/g, ' ').trim()
}

/** 值 → 单行安全文本：null/undefined → ''，其它先 String 再压空白。 */
function textOf(value) {
  if (value === null || value === undefined) return ''
  return collapse(value)
}

/** 普通对象（排除 null 与数组）——payload 形状判断到处要用。 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 上下文配置：source 为基础，显式传入的 options 覆盖之（两处都能配 maxChars）。 */
function mergeConfig(source, options) {
  const base = isPlainObject(source) ? source : {}
  const extra = isPlainObject(options) ? options : {}
  return { ...base, ...extra }
}

/** maxChars 防御性取值：非有限数或 < 1 时回落到 800。 */
function normalizeMaxChars(value, fallback = DEFAULT_MAX_CHARS) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/** 候选值里第一个非空文本。 */
function firstText(...values) {
  for (const value of values) {
    const text = textOf(value)
    if (text) return text
  }
  return ''
}

/**
 * 点路径取值，支持数组下标：`a.b.0.c`、`commits.0.id`。
 * - 只接受 own property（不读原型链）；
 * - 任何一层缺失（含 null/undefined/空路径）→ undefined；
 * - object 非对象 → undefined。
 */
export function pickPath(object, path) {
  if (!isPlainObject(object) && !Array.isArray(object)) return undefined
  if (typeof path !== 'string') return undefined
  const segments = path.split('.').map((part) => part.trim()).filter((part) => part !== '')
  if (segments.length === 0) return undefined
  let current = object
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

/** 文本上色收尾：压空白 → 按 maxChars 硬截断（标记不计入 maxChars）。 */
function finalizeText(text, maxChars) {
  const collapsed = collapse(text)
  if (collapsed.length > maxChars) return collapsed.slice(0, maxChars) + TRUNCATED_MARK
  return collapsed
}

/** 行数组 → 文本；空行丢掉，避免出现空白段。 */
function joinLines(lines) {
  return lines.map((line) => textOf(line)).filter((line) => line !== '').join('\n')
}

// ------------------------------------------------------------- GitHub ----

/**
 * GitHub 只把事件类型放在 HTTP 头 `X-GitHub-Event` 里，而本函数只能看到 payload，
 * 所以判定顺序是（注释里的三档就是实际实现）：
 *
 *   第 1 档 显式事件名：payload.event 是 GitHub 风格事件名（'push' / 'issues' …）时直接采纳
 *           （桥把 X-GitHub-Event 补进 payload 时走这一档，最准）；
 *   第 2 档 结构特征：没有 event 时按 payload 的**形状**猜，优先级从特殊到一般：
 *           workflow_run → CI；release → 发布；pull_request → PR；
 *           issue + comment → 评论（issue_comment，GitHub 的评论 payload 顶层
 *           既有 issue 又有 comment，而 issues 的顶层只有 issue）；issue → issues；
 *           commits 数组 → push（放最后，因为 workflow_run 也带 head_commit 之类的字段）；
 *   第 3 档 兜底：以上都不成立，或判出来的名字不在支持列表里 → generic 口径，
 *           并在 reason 里写明"未识别"。
 *
 * payload.action 只用来补充"打开/关闭/合并"这类动词与评论子类型，不单独作为判定依据。
 */
const GITHUB_EVENTS = ['push', 'pull_request', 'issues', 'issue_comment', 'workflow_run', 'release']

/** 事件名规范化：大小写/连字符统一成 GitHub 的下划线风格。 */
function normalizeEventName(value) {
  return textOf(value).toLowerCase().replace(/-/g, '_')
}

/** GitHub 事件类型判定（返回事件名；判不出来返回空串）。 */
function detectGithubEvent(payload) {
  const explicit = normalizeEventName(payload?.event)
  if (GITHUB_EVENTS.includes(explicit)) return explicit
  if (isPlainObject(payload?.workflow_run)) return 'workflow_run'
  if (isPlainObject(payload?.release)) return 'release'
  if (isPlainObject(payload?.pull_request)) return 'pull_request'
  if (isPlainObject(payload?.issue) && isPlainObject(payload?.comment)) return 'issue_comment'
  if (isPlainObject(payload?.issue)) return 'issues'
  if (Array.isArray(payload?.commits)) return 'push'
  return ''
}

/** 仓库名 + 链接：full_name 优先，其次 name，最后从 html_url 尾巴上截。 */
function repoInfo(payload) {
  const repo = isPlainObject(payload?.repository) ? payload.repository : {}
  const url = textOf(repo.html_url)
  const full = firstText(repo.full_name, repo.name)
  if (full) return { name: full, url }
  if (url) return { name: url.split('/').filter(Boolean).pop() ?? '', url }
  return { name: '', url: '' }
}

/** 操作者：议题/评论优先用条目作者，其次 sender.login / pusher.name。 */
function actorOf(payload) {
  return firstText(
    payload?.issue?.user?.login,
    payload?.comment?.user?.login,
    payload?.sender?.login,
    payload?.pusher?.name,
    payload?.release?.author?.login,
    payload?.pull_request?.user?.login,
  )
}

/** 动作动词（中文），认不出来就原样回显英文 action。 */
function actionLabel(action) {
  const map = {
    opened: '新开',
    closed: '关闭',
    reopened: '重新打开',
    merged: '合并',
    created: '新建',
    published: '发布',
    edited: '编辑',
    deleted: '删除',
    synchronize: '同步',
    submitted: '提交',
    completed: '完成',
    requested: '请求',
  }
  const key = textOf(action).toLowerCase()
  return map[key] ?? key
}

/** 事件图标：GitHub 事件名 + action/conclusion 决定，未知一律 📣。 */
function githubEmoji(event, payload) {
  const action = textOf(payload?.action).toLowerCase()
  if (event === 'push') return '📦'
  if (event === 'pull_request') return action === 'closed' ? '🚪' : '🔀'
  if (event === 'issues') return action === 'closed' ? '✅' : '📝'
  if (event === 'issue_comment') return '💬'
  if (event === 'release') return '🏷️'
  if (event === 'workflow_run') return textOf(payload?.workflow_run?.conclusion).toLowerCase() === 'success' ? '✅' : '❌'
  return '📣'
}

/** 事件中文名（用于 generic 口径与兜底）。 */
function githubEventLabel(event) {
  const map = {
    push: '推送',
    pull_request: '拉取请求',
    issues: '议题',
    issue_comment: '议题评论',
    workflow_run: 'CI',
    release: '发布',
  }
  return map[event] ?? '事件'
}

/** CI 运行状态的中文名（conclusion 缺失时显示这个）。 */
function runStatusLabel(status) {
  const map = {
    queued: '排队中',
    in_progress: '进行中',
    waiting: '等待中',
    requested: '等待审批',
    pending: '等待中',
    completed: '已完成',
  }
  const key = textOf(status).toLowerCase()
  return map[key] ?? key
}

/** 行尾链接：有链接就加一行，没有就省略整行（绝不出现空的"查看："）。 */
function linkLine(label, url) {
  const href = textOf(url)
  return href ? `${label}：${href}` : ''
}

/** push：分支 / 提交数 / 发起人 / 对比链接（缺 ref 时回落到 after 短 sha）。 */
function renderGithubPush(payload) {
  const repo = repoInfo(payload)
  const ref = textOf(payload?.ref)
  const branch = ref ? (ref.split('/').slice(2).join('/') || ref) : ''
  const commits = Array.isArray(payload?.commits) ? payload.commits : []
  const after = textOf(payload?.after)
  const actor = actorOf(payload)
  return joinLines([
    `📦 ${repo.name || '未知仓库'} 新推送`,
    `分支 ${branch || (after ? after.slice(0, 7) : '未知分支')}，${commits.length} 个提交`,
    actor ? `发起人 ${actor}` : '',
    linkLine('对比', textOf(payload?.compare) || repo.url),
  ])
}

/** pull_request：动作 / PR 号 / 标题 + 作者 + 链接。 */
function renderGithubPullRequest(payload) {
  const repo = repoInfo(payload)
  const pr = isPlainObject(payload?.pull_request) ? payload.pull_request : {}
  const number = textOf(pr.number ?? payload?.number)
  const title = textOf(pr.title)
  const actor = actorOf(payload)
  const verb = actionLabel(payload?.action) || '更新'
  return joinLines([
    `🔀 ${repo.name || '未知仓库'} PR #${number || '?'} ${verb}`,
    title ? `标题 ${title}` : '',
    actor ? `发起人 ${actor}` : '',
    linkLine('查看', pr.html_url),
  ])
}

/** issues：动作 / 议题号 / 标题 + 提交人 + 链接。 */
function renderGithubIssues(payload) {
  const repo = repoInfo(payload)
  const issue = isPlainObject(payload?.issue) ? payload.issue : {}
  const number = textOf(issue.number ?? payload?.number)
  const title = textOf(issue.title)
  const actor = actorOf(payload)
  const verb = actionLabel(payload?.action) || '更新'
  return joinLines([
    `📝 ${repo.name || '未知仓库'} 议题 #${number || '?'} ${verb}`,
    title ? `标题 ${title}` : '',
    actor ? `提交人 ${actor}` : '',
    linkLine('查看', issue.html_url),
  ])
}

/** issue_comment：评论动词用 action（created 是"新评论"）；PR 上的评论按 PR 口径称呼。 */
function renderGithubIssueComment(payload) {
  const repo = repoInfo(payload)
  const issue = isPlainObject(payload?.issue) ? payload.issue : {}
  const comment = isPlainObject(payload?.comment) ? payload.comment : {}
  const onPull = isPlainObject(issue.pull_request)
  const kind = onPull ? 'PR' : '议题'
  const number = textOf(issue.number)
  const title = textOf(issue.title)
  const actor = firstText(comment.user?.login, payload?.sender?.login)
  const action = textOf(payload?.action).toLowerCase()
  const verb = action === 'created' ? '新评论' : (action === 'deleted' ? '删除了评论' : (actionLabel(action) || '有评论'))
  return joinLines([
    `💬 ${repo.name || '未知仓库'} ${kind} #${number || '?'} ${verb}`,
    title ? `标题 ${title}` : '',
    actor ? `评论者 ${actor}` : '',
    linkLine('查看', comment.html_url ?? issue.html_url),
  ])
}

/** workflow_run：CI 成功 / 失败、工作流名、运行号、分支、触发人、链接。 */
function renderGithubWorkflowRun(payload) {
  const repo = repoInfo(payload)
  const run = isPlainObject(payload?.workflow_run) ? payload.workflow_run : {}
  const conclusion = textOf(run.conclusion).toLowerCase()
  const status = textOf(run.status).toLowerCase()
  const failed = ['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required', 'stale'].includes(conclusion)
  const finished = conclusion !== ''
  const headline = failed
    ? `❌ ${repo.name || '未知仓库'} CI 失败`
    : (finished ? `✅ ${repo.name || '未知仓库'} CI 通过` : `⏳ ${repo.name || '未知仓库'} CI ${runStatusLabel(status) || '进行中'}`)
  const workflow = textOf(run.name)
  const number = textOf(run.run_number)
  const branch = textOf(run.head_branch)
  const actor = firstText(run.actor?.login, payload?.sender?.login)
  return joinLines([
    headline,
    `工作流 ${workflow || '未知工作流'}${number ? ` #${number}` : ''}，结论 ${conclusion || runStatusLabel(status) || '未知'}`,
    branch ? `分支 ${branch}${actor ? `，触发人 ${actor}` : ''}` : (actor ? `触发人 ${actor}` : ''),
    linkLine('运行', run.html_url),
  ])
}

/** release：动作（published/created 都叫"发布"）/ 标签 / 名称 / 发布人 + 链接。 */
function renderGithubRelease(payload) {
  const repo = repoInfo(payload)
  const release = isPlainObject(payload?.release) ? payload.release : {}
  const tag = firstText(release.tag_name, release.name)
  const name = textOf(release.name)
  const action = textOf(payload?.action).toLowerCase()
  const verb = action === 'published' || action === 'created' ? '新发布' : (actionLabel(action) || '更新')
  const actor = actorOf(payload)
  return joinLines([
    `🏷️ ${repo.name || '未知仓库'} ${verb} ${tag || '未知标签'}`,
    name && name !== tag ? `名称 ${name}` : '',
    actor ? `发布人 ${actor}` : '',
    linkLine('查看', release.html_url ?? repo.url),
  ])
}

/** 事件名 → 渲染函数。 */
const GITHUB_RENDERERS = {
  push: renderGithubPush,
  pull_request: renderGithubPullRequest,
  issues: renderGithubIssues,
  issue_comment: renderGithubIssueComment,
  workflow_run: renderGithubWorkflowRun,
  release: renderGithubRelease,
}

/** 认不出来的 GitHub 事件：generic 口径 + 原因说明（action 有值时也算一条线索）。 */
function renderGithubUnknown(payload, maxChars) {
  const repo = repoInfo(payload)
  const actor = actorOf(payload)
  const action = textOf(payload?.action)
  const hint = Array.isArray(payload?.commits) ? `含 ${payload.commits.length} 个提交` : ''
  const text = joinLines([
    `${githubEmoji('', payload)} ${repo.name || '未知仓库'} 收到未知 GitHub 事件`,
    action ? `动作 ${action}${hint ? `，${hint}` : ''}` : hint,
    actor ? `发送者 ${actor}` : '',
    linkLine('查看', repo.url),
  ])
  return { ok: true, text: finalizeText(text, maxChars), reason: '未识别的 GitHub 事件，已按通用口径渲染' }
}

/** format: 'github' 的总入口。 */
function renderGithub(payload, maxChars) {
  if (!isPlainObject(payload)) {
    return { ok: true, text: finalizeText(`📣 GitHub 事件：${textOf(payload) || '(空)'}`, maxChars), reason: 'GitHub payload 不是对象，已按纯文本渲染' }
  }
  const event = detectGithubEvent(payload)
  const renderer = GITHUB_RENDERERS[event]
  if (typeof renderer !== 'function') return renderGithubUnknown(payload, maxChars)
  return { ok: true, text: finalizeText(renderer(payload), maxChars), reason: '' }
}

// -------------------------------------------------------- Uptime Kuma ----

/**
 * Uptime Kuma 的 heartbeat.status 语义（按 Kuma 源码 HeartbeatStatus）：
 *   0 = DOWN（宕机）、1 = UP（正常）、2 = PENDING（待定，刚建/刚改还没探到结果）、
 *   3 = MAINTENANCE（维护窗口内，不代表故障）。
 * 颜色也跟着走：正常绿、宕机红、待定黄、维护蓝。
 */
const KUMA_STATUS = {
  0: { emoji: '🔴', label: '宕机' },
  1: { emoji: '🟢', label: '恢复' },
  2: { emoji: '🟡', label: '待定' },
  3: { emoji: '🔧', label: '维护' },
}

/** 心跳时间：Kuma 给的是 ISO 字符串（也可能给毫秒数），统一成秒级可读时间。 */
function kumaTimeText(time) {
  if (time === null || time === undefined || time === '') return ''
  const raw = typeof time === 'number' ? time : Date.parse(String(time))
  if (!Number.isFinite(raw)) return textOf(time)
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return textOf(time)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** format: 'uptime-kuma' 的总入口。 */
function renderKuma(payload, maxChars) {
  const heartbeat = isPlainObject(payload?.heartbeat) ? payload.heartbeat : {}
  const monitor = isPlainObject(payload?.monitor) ? payload.monitor : {}
  const rawStatus = Number(heartbeat.status)
  const known = Object.prototype.hasOwnProperty.call(KUMA_STATUS, rawStatus) && Number.isFinite(rawStatus)
  const meta = known ? KUMA_STATUS[rawStatus] : KUMA_STATUS[0]
  const name = firstText(monitor.name, payload?.monitor?.name, '未知监控') || '未知监控'
  const headline = known
    ? `${meta.emoji} ${name} ${meta.label}`
    : `🔴 ${name} 宕机（状态码 ${textOf(heartbeat.status) || '未知'}）`
  const message = textOf(heartbeat.msg)
  const time = kumaTimeText(heartbeat.time)
  const lines = [headline]
  if (!known) lines.push('Kuma 状态码未识别，按宕机口径渲染')
  if (message) lines.push(`详情 ${message}`)
  if (time) lines.push(`时间 ${time}`)
  lines.push(linkLine('监控', monitor.url))
  return { ok: true, text: finalizeText(lines.join('\n'), maxChars), reason: '' }
}

// ------------------------------------------------------------ generic ----

/** 占位符取值：{a.b.c} 取不到 → （无）；取到对象/数组 → 内联 JSON（空数组给 []）。 */
function placeholderValue(payload, path) {
  const value = pickPath(payload, path)
  if (value === undefined) return MISSING_MARK
  if (value === null) return MISSING_MARK
  if (typeof value === 'string') return collapse(value) || MISSING_MARK
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value)
      return json === undefined ? MISSING_MARK : json
    } catch {
      return MISSING_MARK
    }
  }
  return String(value)
}

/** format: 'generic' 的总入口：{a.b.c} 占位符替换；空模板回落到 JSON 片段。 */
function renderGeneric(payload, template, maxChars) {
  const raw = textOf(template)
  if (!raw) {
    let json = ''
    try {
      json = JSON.stringify(payload)
    } catch {
      // 循环引用 / BigInt 之类：JSON.stringify 会抛，退回 String(payload) 而不是报错
      json = String(payload)
    }
    if (json === undefined) json = String(payload)
    const snippet = json.length > RAW_JSON_SNIPPET ? json.slice(0, RAW_JSON_SNIPPET) + '…' : json
    return { ok: true, text: finalizeText(snippet, maxChars), reason: '' }
  }
  const rendered = isPlainObject(payload) || Array.isArray(payload)
    ? raw.replace(/\{([^{}]+)\}/g, (whole, path) => placeholderValue(payload, path))
    : raw.replace(/\{[^{}]+\}/g, () => MISSING_MARK)
  return { ok: true, text: finalizeText(rendered, maxChars), reason: '' }
}

// --------------------------------------------------------------- 入口 ----

/**
 * 渲染一条入站 webhook。
 * @param source  `{ name, format, chat, template, maxChars }`（桥里的来源配置）
 * @param payload 已解析的 JSON（也可能是任何东西——渲染层必须扛得住）
 * @param options 可选的覆盖项（只认 maxChars / template / format 等同名字段）
 * @returns {{ ok: boolean, text: string, reason: string }}
 */
export function renderWebhook(source, payload, options = {}) {
  try {
    // 注意：这个局部变量**不能叫 `config`**——`test/static-unit.mjs` 会用 `config.<键>` 扫描 lib/，
    // 一个同名局部变量会被误判成"读取了不存在的插件配置键"（它确实是在防那类真 bug）。
    const merged = mergeConfig(source, options)
    const maxChars = normalizeMaxChars(merged.maxChars, DEFAULT_MAX_CHARS)
    const format = textOf(merged.format).toLowerCase()
    if (format === 'github') return renderGithub(payload, maxChars)
    if (format === 'uptime-kuma' || format === 'uptimekuma' || format === 'kuma') return renderKuma(payload, maxChars)
    if (format === 'generic' || format === '') return renderGeneric(payload, merged.template, maxChars)
    return { ok: false, text: '', reason: `未知的 webhook 格式：${textOf(merged.format)}` }
  } catch (error) {
    return { ok: false, text: '', reason: `渲染失败：${error?.message ?? error}` }
  }
}
