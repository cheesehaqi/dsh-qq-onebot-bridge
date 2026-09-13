/**
 * 隐私与密钥回归防线（v0.4.0 最终检测新增）。
 *
 * 这个测试**故意不写任何真实 QQ 号/用户名/密钥**：它用「加盐哈希」比对数字串，
 * 用「模式 + 白名单」比对路径与密钥形态。这样测试本身不会变成新的泄露源。
 *
 * 覆盖：
 *   ① 被跟踪文件里不得出现本机用户名路径 / 家目录绝对路径 / 硬编码作者机器路径
 *   ② 被跟踪文件里不得出现那几个真实 QQ 号（比对 salte 哈希，不落原文）
 *   ③ 不得出现密钥形态（sk-…、32 位 hex、Bearer、私钥头、赋值型密钥），
 *      且配置项里的密钥字段必须为空或占位
 *   ④ 运行产物（消息原文/QQ 号/会话/追踪）必须被 .gitignore 覆盖，且不得被跟踪
 *   ⑤ 文档/示例里出现的 QQ 号必须是占位号（连续重复/明显占位形态不算）
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const SALT = 'dsh-qq-onebot-bridge/privacy-guard/v1'
const hash = (value) => createHash('sha256').update(`${SALT}:${value}`).digest('hex')

/**
 * 需要禁止出现的真实标识**不写在这个文件里**（否则测试本身就成了泄露源）：
 * 从机器本地的私有配置收集（`~/.dsh/profiles/web/cordis.patch.yml` 的
 * allowUsers / allowGroups / adminUsers / botQq），或由 `DSH_QQ_PRIVATE_IDS`
 * 环境变量提供（CI 用）。收集不到就明确跳过这一项，而不是假装通过。
 */
export function collectPrivateIds({ env = process.env, home = homedir(), readFile = readFileSync } = {}) {
  const ids = new Set()
  for (const value of String(env.DSH_QQ_PRIVATE_IDS ?? '').split(/[,\s]+/)) {
    if (/^\d{5,12}$/.test(value)) ids.add(value)
  }
  const candidates = [
    join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
    join(home, '.dsh', 'profiles', 'web', 'cordis.yml'),
  ]
  for (const file of candidates) {
    let text = ''
    try { text = readFile(file, 'utf8') } catch { continue }
    // 三种 YAML 写法都要覆盖：内联数组 `key: [1, 2]`、标量 `key: 123`、
    // 跨行列表 `key:\n  - 123`。旧实现只认前两种，写在跨行列表里的号不会被纳入比对集。
    for (const key of ['allowUsers', 'allowGroups', 'adminUsers', 'botQq', 'rejectUsers', 'rejectGroups']) {
      const block = new RegExp(`^\\s*${key}\\s*:[ \t]*([^\n]*)((?:\n[ \t]+-[^\n]*)*)`, 'm').exec(text)
      if (!block) continue
      for (const match of `${block[1]}\n${block[2]}`.matchAll(/\d{5,12}/g)) ids.add(match[0])
    }
  }
  return ids
}

const PLACEHOLDER_IDS = new Set(['2000000001', '3000000001', '100000001', '100000002'])

/** 运行时产物名（代码会写进工作目录）：必须被 .gitignore 覆盖，且不得被跟踪。 */
const RUNTIME_ARTIFACTS = [
  'qq-inbox.jsonl', 'qq-inject.jsonl', 'qq-trace.jsonl', 'qq-runtime.json', 'qq-actions.log',
  'qq-bridge-debug.log', 'qq-host-out.log', 'qq-host-err.log', 'qq-control.json',
  'qq-reminders.json', 'qq-sessions.json', 'qq-keywords.json', 'qq-counters.json', 'qq-dailyreport.json',
  'qq-replay/run-2026-01-01T00-00-00/qq-trace.jsonl', 'qq-trash/2026-01-01/x',
  'qq-stats/g_1.json', 'qq-checkin/u_1.json', 'qq-points/g_1.json', 'qq-todos/g_1.json',
  'qq-memory/g_1.json', 'qq-media/a.png', 'qq-images/a.png', 'qq-replies/a.png', 'qq-tts/a.mp3',
  'qq-files/a.txt', 'qq-exports/a.md', 'qq-faces/list.json', 'qq-badwords.txt',
]

// ------------------------------------------------------------------ 读文件 --
// 发布包里没有 .git（用户直接从 zip 解包时也跑不动 `git ls-files`），所以这里退化：
// 有 git 就用 git 的文件清单，没有就遍历目录（排除 node_modules 与运行产物）。
function listFiles() {
  try {
    const fromGit = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    if (fromGit.length > 0) return { names: fromGit, source: 'git' }
  } catch { /* 不是 git 仓库（解包副本） */ }
  const names = []
  const skip = new Set(['.git', 'node_modules'])
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      if (prefix === '' && /^qq-/.test(entry.name)) continue       // 运行产物
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue }
      names.push(rel)
    }
  }
  walk(repo)
  return { names, source: 'walk' }
}
const listed = listFiles()
const tracked = listed.names
check('被跟踪/枚举文件数量合理', tracked.length >= 90, `${tracked.length} 个（来源 ${listed.source}）`)
const textFiles = []
for (const name of tracked) {
  if (!/\.(mjs|js|json|md|yml|yaml|html|txt|bat|gitignore)$/i.test(name) && name !== '.gitignore') continue
  let text = ''
  try { text = readFileSync(join(repo, name), 'utf8') } catch { continue }
  textFiles.push({ name, text })
}
check('读到可扫描的文本文件', textFiles.length >= 60, `${textFiles.length} 个`)
check('无 .git 时也能枚举文件（解包副本可用）', listed.source === 'git' || listed.source === 'walk', listed.source)

// ------------------------------------------------------- ① 路径与用户名泄露 --
const USERNAME_PATTERNS = [
  [/C:\\+Users\\+(?!<|%|\{|user\b|username\b|yourname\b|someone\b|me\b|public\b|default\b)[A-Za-z0-9_.-]+/gi, 'Windows 用户名路径'],
  [/\/home\/(?!<|%|\{|user\b|username\b)[A-Za-z0-9_.-]+\//gi, 'Linux 家目录路径'],
  [/\/Users\/(?!<|%|\{|user\b|username\b|shared\b)[A-Za-z0-9_.-]+\//gi, 'macOS 家目录路径'],
]
const pathHits = []
for (const { name, text } of textFiles) {
  for (const [re, label] of USERNAME_PATTERNS) {
    for (const match of text.matchAll(re)) pathHits.push(`${name}: ${label} → ${match[0]}`)
  }
}
check('没有硬编码的本机用户名/家目录路径', pathHits.length === 0, pathHits.slice(0, 5).join(' | '))

// 作者机器的工作目录不应作为默认值出现（示例/文档里的路径说明允许，默认值不允许）
const cwdDefaultHits = textFiles
  .filter(({ name, text }) => /(config\.cwd|env\.DSH_QQ_CWD)[^\n]*\n?[^\n]*'[A-Za-z]:\\\\/.test(text) || /exists\('[A-Za-z]:\\\\[^']+'\)/.test(text))
  .map(({ name }) => name)
check('控制台配置探测不假设作者机器的目录', cwdDefaultHits.length === 0, cwdDefaultHits.join(','))

// ----------------------------------------------------------- ② 真实 QQ 号 --
const PRIVATE_IDS = collectPrivateIds()
const idHits = []
if (PRIVATE_IDS.size === 0) {
  console.log('SKIP 没有可用的私有号清单（本机无 profile 配置且未设置 DSH_QQ_PRIVATE_IDS），跳过真实号比对')
} else {
  for (const { name, text } of textFiles) {
    for (const match of text.matchAll(/\b\d{5,12}\b/g)) {
      const value = match[0]
      // 先判真实号再考虑占位号：反过来会让"真实号恰好等于占位号"被静默放过。
      if (PRIVATE_IDS.has(value)) idHits.push(`${name}: 命中私有号（${hash(value).slice(0, 8)}）`)
    }
  }
  check(`没有真实 QQ 号（比对 ${PRIVATE_IDS.size} 个本机私有号）`, idHits.length === 0, [...new Set(idHits)].slice(0, 5).join(' | '))
  // 文件名同样是泄露面：`qq-control-<真实号>.json` 这种内容干净、名字泄露的情况不能被漏掉。
  const nameHits = []
  for (const name of tracked) {
    for (const match of name.matchAll(/\b\d{5,12}\b/g)) {
      if (PRIVATE_IDS.has(match[0])) nameHits.push(name)
    }
  }
  check('文件名里也没有真实 QQ 号', nameHits.length === 0, nameHits.slice(0, 3).join(','))
}
check('占位号在示例/测试里被有意使用', textFiles.some(({ text }) => [...PLACEHOLDER_IDS].some((id) => text.includes(id))))

// ------------------------------------------------------------- ③ 密钥形态 --
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{20,}/g, 'OpenAI 风格 key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '私钥'],
  [/Bearer\s+[A-Za-z0-9._-]{24,}/g, 'Bearer token'],
  [/\b[0-9a-f]{32}\.[A-Za-z0-9_-]{12,}\b/g, '复合形态 key（如智谱）'],
]
const secretHits = []
for (const { name, text } of textFiles) {
  for (const [re, label] of SECRET_PATTERNS) {
    for (const match of text.matchAll(re)) {
      if (/your|example|placeholder|xxx|\.\.\./i.test(match[0])) continue
      secretHits.push(`${name}: ${label}`)
    }
  }
}
check('没有密钥形态的字符串', secretHits.length === 0, [...new Set(secretHits)].slice(0, 5).join(' | '))

// 配置 schema 里所有"密钥类"字段的默认值必须是空串/占位（真实值只应存在于机器本地配置）
const schema = textFiles.find(({ name }) => name === 'lib/index.js')?.text ?? ''
const keyDefaults = [...schema.matchAll(/(\w*(?:ApiKey|Token|Password|Secret)\w*)\s*:\s*z\.string\(\)[^\n]*?\.default\(\s*'([^']*)'\s*\)/gi)]
const nonEmptyKeyDefaults = keyDefaults.filter(([, , value]) => value !== '')
check('配置 schema 里的密钥字段默认值为空', nonEmptyKeyDefaults.length === 0, nonEmptyKeyDefaults.map(([, field, value]) => `${field}=${value.length}字符`).join(','))
check('schema 里确实存在密钥类字段（检查本身有效）', keyDefaults.length >= 4, `${keyDefaults.length} 个`)

// 示例配置里也不能填值
const example = textFiles.find(({ name }) => name === 'examples/cordis.patch.example.yml')?.text ?? ''
check('示例配置里的密钥字段为空', !/(apiKey|ApiKey|token|Token)\s*:\s*['"]?[A-Za-z0-9_\-.]{12,}/.test(example))

// ------------------------------------------- ④ 运行产物必须被 gitignore --
// 文本化的 .gitignore 匹配（解包副本里没有 .git，`git check-ignore` 用不了）；
// 有 git 时再交叉核对一遍，两种模式都必须判"已忽略"。
function gitignoreMatcher(text) {
  const rules = String(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
  const globToRe = (body) => body
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]')
  // 按 git 的真实语义编译（旧实现把 `qq-*/` 去掉末尾斜杠后当成文件模式，
  // 于是 `qq-badwords.txt` 被误判为"已忽略"——正是这个假阳性掩盖了真实缺口）：
  //   · 以 / 结尾 → 只匹配目录，目录下所有内容都算忽略
  //   · 不含 /    → 匹配任意层级（basename 语义）
  //   · 含 /      → 从仓库根锚定
  const compiled = rules.map((pattern) => {
    if (pattern.endsWith('/')) return new RegExp(`(^|/)${globToRe(pattern.replace(/\/+$/, ''))}/`)
    if (!pattern.includes('/')) return new RegExp(`(^|/)${globToRe(pattern)}(/.*)?$`)
    return new RegExp(`^${globToRe(pattern)}(/.*)?$`)
  })
  return (candidate) => compiled.some((re) => re.test(candidate))
}
const ignoreText = (() => { try { return readFileSync(join(repo, '.gitignore'), 'utf8') } catch { return '' } })()
const ignoredByText = gitignoreMatcher(ignoreText)
const ignoredOk = []
for (const artifact of RUNTIME_ARTIFACTS) {
  let ignored = ignoredByText(artifact)
  if (listed.source === 'git') {
    try {
      const byGit = execFileSync('git', ['check-ignore', '--no-index', '--', artifact], { cwd: repo, encoding: 'utf8' }).trim() !== ''
      ignored = ignored && byGit   // 两种判定都要过
    } catch { ignored = false }
  }
  if (!ignored) ignoredOk.push(artifact)
}
check('所有运行产物都被 .gitignore 覆盖（文本判定 + git 交叉核对）', ignoredOk.length === 0, ignoredOk.slice(0, 6).join(', '))
const trackedArtifacts = tracked.filter((name) => /^qq-/.test(name))
check('没有任何运行产物被跟踪/在包里', trackedArtifacts.length === 0, trackedArtifacts.join(','))
check('qq-control.json 未被跟踪（含控制台 token）', !tracked.includes('qq-control.json'))

// ------------------------------------------- ⑥ 诊断包脱敏（分享安全通路）--
const { maskDigits, maskNumber, redactObject, redactJsonLine, redactByKind, redactionNote } = await import('../control/lib/redact.mjs')
const GROUP = '100000001'
const USER = '2000000001'
// 期望值用拼接构造，避免测试文件里出现长数字字面量（自检会拦）
const MASKED_GROUP_NUM = Number('1' + '0'.repeat(8))
const MASKED_USER_NUM = Number('2' + '0'.repeat(9))
const MASKED_GROUP = '10' + '*'.repeat(7)
const MASKED_USER = '20' + '*'.repeat(8)
const SMALL_NUM = Number('12' + '345')
const sampleText = `群 ${GROUP} 用户 ${USER} 说：我的手机号是 ${'1'.repeat(3)}${'0'.repeat(8)}`
const masked = maskDigits(sampleText)
check('文本里的 6 位以上数字被掩码且保留前两位', !masked.includes(GROUP) && masked.includes(MASKED_GROUP), masked.slice(0, 40))
check('不足 6 位的数字不动', maskDigits('共 3 人') === '共 3 人')
check('数字型 QQ 号保留前两位补零', maskNumber(Number(GROUP)) === MASKED_GROUP_NUM && maskNumber(Number(USER)) === MASKED_USER_NUM)
check('小于 6 位的数字保持原值', maskNumber(SMALL_NUM) === SMALL_NUM)
const redactedFrame = redactObject({ kind: 'message', frame: { messageType: 'group', groupId: Number(GROUP), userId: Number(USER), text: '这是一条真实消息', atMe: true } })
check('结构脱敏：text 字段只留长度', redactedFrame.frame.text === '[已脱敏 8 字]', redactedFrame.frame.text)
check('结构脱敏：群号/用户号掩码', redactedFrame.frame.groupId === MASKED_GROUP_NUM && redactedFrame.frame.userId === MASKED_USER_NUM)
check('结构脱敏：布尔与非文本字段保持语义', redactedFrame.frame.atMe === true && redactedFrame.frame.messageType === 'group')
const line = JSON.stringify({ v: 1, ts: 1, id: 't-abc-1', chatKey: `g:${GROUP}`, stage: 'inbound', ok: true, data: { userId: Number(USER), text: '你好呀' } })
const redactedLine = JSON.parse(redactJsonLine(line))
check('JSONL 行脱敏：chatKey 掩码', redactedLine.chatKey === `g:${MASKED_GROUP}`, redactedLine.chatKey)
check('JSONL 行脱敏：data.text 只留长度', redactedLine.data.text === '[已脱敏 3 字]', redactedLine.data.text)
check('JSONL 行脱敏：traceId 不受影响（保留可追性）', redactedLine.id === 't-abc-1')
check('JSONL 行脱敏：仍可 JSON.parse', typeof redactedLine === 'object')
check('坏行退化为纯文本掩码而不是抛错', redactJsonLine(`{坏行 group ${GROUP}`) === `{坏行 group ${MASKED_GROUP}`)
check('整份 JSONL 逐行处理', redactByKind('qq-inbox.jsonl', `${line}\n${line}\n`).split('\n').filter(Boolean).length === 2)
check('JSON 文件按结构脱敏', JSON.parse(redactByKind('qq-runtime.json', JSON.stringify({ sessions: [{ chatKey: `u:${USER}` }] }))).sessions[0].chatKey === `u:${MASKED_USER}`)
check('日志文件只掩码数字', redactByKind('qq-bridge-debug.log', `msg from u${USER} g${GROUP}`) === `msg from u${MASKED_USER} g${MASKED_GROUP}`)
check('脱敏说明与包内容一致', redactionNote().redacted === true && redactionNote().policy.includes('掩码'))

// ------------------------------------------------------------ ⑦ 汇总输出 --
const selfText = readFileSync(new URL(import.meta.url), 'utf8')
const selfIds = [...selfText.matchAll(/\b\d{5,12}\b/g)].map((match) => match[0]).filter((id) => !PLACEHOLDER_IDS.has(id))
check('测试文件自身不含任何真实号字面量（否则测试就是新的泄露源）', selfIds.length === 0, [...new Set(selfIds)].slice(0, 5).join(','))
const NINE_ONES = '1'.repeat(9)
const NINE_NINES = '9'.repeat(9)
const injected = collectPrivateIds({
  env: { DSH_QQ_PRIVATE_IDS: `${NINE_ONES}, ${NINE_NINES}` },
  home: '/nonexistent',
  readFile: () => { throw new Error('no file') },
})
check('私有号清单可被环境变量注入（CI 用，不需要本机配置）', injected.size === 2 && injected.has(NINE_ONES) && injected.has(NINE_NINES))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
