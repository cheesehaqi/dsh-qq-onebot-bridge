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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
    // 再把整个插件配置块里**身份类键**的纯数字值一并纳入（键名会随版本增加/改名，
    // 漏一个键就等于少比对一个真号：本机实测旧实现只收到 4 个号）。
    // 只认键名像"人/群"的行（qq/uin/user/admin/owner/group/chat/notify/friend），
    // 且值必须本身就是数字或数字列表——否则会把「字节上限」这类默认值
    // （`fileSendMaxBytes` 的五十兆）当成 QQ 号收进来（第一版就踩了，套件立刻误报 5 处）。
    const block = /(?:^|\n)\s*-\s*id:\s*dsh-qq-onebot-bridge\s*\n([\s\S]*?)(?=\n\s*-\s*id:|\s*$)/.exec(text)
    if (block) {
      for (const raw of block[1].split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '')
        const key = (/^\s*([\w.-]+)\s*:/.exec(line) ?? [])[1] ?? ''
        if (!/(qq|uin|user|admin|owner|group|chat|notify|friend)/i.test(key)) continue
        const value = line.replace(/^\s*[\w.-]+\s*:/, '')
        if (!/^\s*[[\]\d,\s'"]*$/.test(value)) continue
        for (const match of value.matchAll(/\d{6,12}/g)) ids.add(match[0])
      }
    }
  }
  return ids
}

const PLACEHOLDER_IDS = new Set(['2000000001', '3000000001', '100000001', '100000002'])

/**
 * 本机的**私有昵称**（机器人自己的 QQ 昵称、群名片里的自定义别名……）。
 *
 * 为什么要有这一类（2026-10-06 审计发现）：**机器人账号的真实昵称**
 * 曾经出现在 3 个已跟踪文件里（`lib/onebot.js` 的注释、`test/ops-bridge-unit.mjs` 的用例、
 * CHANGELOG），而且**已经推到了 GitHub**——昵称能直接把仓库指到用户的 QQ 账号上。
 * 号是数字好认，昵称是任意字符串，所以这里从**本机私有配置**里收集，同样不写进仓库。
 */
export function collectPrivateNicknames({ env = process.env, home = homedir(), readFile = readFileSync } = {}) {
  const names = new Set()
  for (const value of String(env.DSH_QQ_PRIVATE_NICKNAMES ?? '').split(/[,，\s]+/)) {
    const clean = value.trim()
    if (clean.length >= 3) names.add(clean)
  }
  const candidates = [
    join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
    join(home, '.dsh', 'profiles', 'web', 'cordis.yml'),
  ]
  for (const file of candidates) {
    let text = ''
    try { text = readFile(file, 'utf8') } catch { continue }
    // 只看"昵称类"键：值里带数字的留给 collectPrivateIds，避免把 `botQq: <一串数字>` 当昵称收进来。
    for (const key of ['botNickname', 'botName', 'nickname', 'botAlias', 'aliases', 'botNames']) {
      const block = new RegExp(`^\\s*${key}\\s*:[ \t]*([^\n]*)((?:\n[ \t]+-[^\n]*)*)`, 'm').exec(text)
      if (!block) continue
      for (const raw of `${block[1]}\n${block[2]}`.split(/\r?\n/)) {
        const value = raw.replace(/^\s*(-\s*)?/, '').replace(/^[\w.-]+\s*:\s*/, '').replace(/[#'"]/g, '').trim()
        if (value === '' || /^\d+$/.test(value)) continue
        for (const piece of value.split(/[,，\s]+/)) if (piece.length >= 3) names.add(piece)
      }
    }
  }
  return names
}

/** 运行时产物名（代码会写进工作目录）：必须被 .gitignore 覆盖，且不得被跟踪。 */
const RUNTIME_ARTIFACTS = [
  'qq-inbox.jsonl', 'qq-inject.jsonl', 'qq-trace.jsonl', 'qq-runtime.json', 'qq-actions.log',
  'qq-bridge-debug.log', 'qq-host-out.log', 'qq-host-err.log', 'qq-control.json',
  'qq-reminders.json', 'qq-sessions.json', 'qq-keywords.json', 'qq-counters.json', 'qq-dailyreport.json',
  'qq-replay/run-2026-01-01T00-00-00/qq-trace.jsonl', 'qq-trash/2026-01-01/x',
  'qq-stats/g_1.json', 'qq-checkin/u_1.json', 'qq-points/g_1.json', 'qq-todos/g_1.json',
  'qq-memory/g_1.json', 'qq-media/a.png', 'qq-images/a.png', 'qq-replies/a.png', 'qq-tts/a.mp3',
  'qq-files/a.txt', 'qq-exports/a.md', 'qq-faces/list.json', 'qq-badwords.txt',
  'qq-engage.json', 'qq-broadcast.json',
  // v0.6.3 起"快捷启动 NapCat"会往工作目录写这两样：垫片（含 NapCat 安装路径）
  // 与启动日志（真机实测里面会出现 `WebUi Token: …`）——必须同 .cmd/.log 一起被忽略。
  'qq-napcat-launch.cmd', 'qq-napcat-launch.log',
  // 审计提的缺口：规则按扩展名兜底，就不能只兜一半（`/export` 产出的就是 .md）。
  'qq-export.md', 'qq-notes.md', 'qq-raw.bin', 'qq-dump.html',
  // writeJsonAtomic 的临时文件是**隐藏名** `.m1a2b3-x9y8z7.tmp`（写一半崩掉就会留下，
  // 里面是完整的 JSON——qq-engage.json 这类内容含 QQ 号）→ 必须同 .json 一样被忽略。
  '.m1a2b3-x9y8z7.tmp',
]

// ------------------------------------------------------------------ 读文件 --
// 发布包里没有 .git（用户直接从 zip 解包时也跑不动 `git ls-files`），所以这里退化：
// 有 git 就用 git 的文件清单，没有就遍历目录（排除 node_modules 与运行产物）。
//
// ⚠️ 必须用 `-z`：`git ls-files` 对非 ASCII 文件名会输出 C 引号形式
// （`"control/\345\220\257…bat"`），旧实现把这一串当路径去 readFileSync → ENOENT →
// `catch { continue }` 静默丢掉该文件。真机实测：128 个被跟踪文件只扫到 126 个，
// 被丢的正是 `control/启动控制台.bat`——而它当时硬编码着作者机器的 node 路径。
function listFiles() {
  try {
    const raw = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], { cwd: repo, encoding: 'utf8' })
    const fromGit = raw.split('\u0000').filter(Boolean)
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

// **每个**文件都必须被读到：读不出来就点名失败，绝不静默跳过。
// 也不再按扩展名白名单过滤（旧实现漏掉 LICENSE、.sh/.ps1/.toml/.env 与无扩展名文件）；
// 二进制内容按 latin1 再扫一遍，宁可多扫也不能漏。
const textFiles = []
const unreadable = []
for (const name of tracked) {
  let buffer
  try { buffer = readFileSync(join(repo, name)) } catch { unreadable.push(name); continue }
  const text = buffer.includes(0) && buffer.length > 4
    ? `${buffer.toString('utf8')}\n${buffer.toString('latin1')}`
    : buffer.toString('utf8')
  textFiles.push({ name, text })
}
check('每个被跟踪文件都被扫到（不许静默跳过）', unreadable.length === 0, unreadable.slice(0, 5).join(', '))
check('扫描数量与文件清单一致', textFiles.length === tracked.length, `${textFiles.length}/${tracked.length}`)
if (listed.source === 'git') {
  // 上面 `-z` 的回归断言：中文文件名必须真的出现在清单里。
  const nonAscii = tracked.filter((name) => /[^\u0000-\u007F]/.test(name))
  check('非 ASCII 文件名也在清单里（-z 清单生效）', nonAscii.length > 0, nonAscii.join(','))
}

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

// 盘符绝对路径（`D:\…`、`C:/…`）：家目录之外的真实路径同样是泄露面。
// 旧实现只认 `C:\Users\<名>`/`/home/<名>`/`/Users/<名>`，于是作者机器上某个
// 非家目录的真实应用路径（D 盘下的一个目录）一路通过，隐私套件全绿却是假的。
// 判据是**"这台机器上真的存在"**——比"形状像路径"精确得多，也不会误伤文档里
// 的虚构示例（`X:\qq-history`、`D:\evil`、`C:\NapCat\…`、`D:/voice/…` 都不存在）。
// 例外：操作系统自带路径（`C:\Windows\`、`C:\Program Files\`）不含个人信息。
const OS_PATH_ALLOW = [/^C:[\\/]Windows[\\/]/i, /^C:[\\/]Program Files(?: \(x86\))?[\\/]/i]
const DRIVE_PATH = /(?:^|[^\w:/])([A-Za-z]:[\\/][^\s"'`)\]},;]*)/g
const realPathHits = []
for (const { name, text } of textFiles) {
  for (const match of text.matchAll(DRIVE_PATH)) {
    const candidate = match[1].replace(/[.,;:]+$/, '')
    if (candidate.length < 5) continue
    if (OS_PATH_ALLOW.some((re) => re.test(candidate))) continue
    if (existsSync(candidate)) realPathHits.push(`${name}: 本机真实存在的绝对路径 → ${candidate}`)
  }
}
check('没有"本机真实存在"的绝对路径（盘符路径不只家目录）', realPathHits.length === 0, [...new Set(realPathHits)].slice(0, 5).join(' | '))

// 作者机器的工作目录不应作为默认值出现（示例/文档里的路径说明允许，默认值不允许）
const cwdDefaultHits = textFiles
  .filter(({ name, text }) => /(config\.cwd|env\.DSH_QQ_CWD)[^\n]*\n?[^\n]*'[A-Za-z]:\\\\/.test(text) || /exists\('[A-Za-z]:\\\\[^']+'\)/.test(text))
  .map(({ name }) => name)
check('控制台配置探测不假设作者机器的目录', cwdDefaultHits.length === 0, cwdDefaultHits.join(','))

// ----------------------------------------------------------- ② 真实 QQ 号 --
const PRIVATE_IDS = collectPrivateIds()
const idHits = []
// 本机明明有 profile 却一个号都没收到 → 这是**检查失效**，必须红，不许静默 SKIP
// （旧实现只打印 SKIP，于是"清单收集坏了"和"清单是空的"看起来一模一样）。
const hasLocalProfile = (() => { try { return existsSync(join(homedir(), '.dsh', 'profiles')) } catch { return false } })()
check('私有号清单可用（本机有 profile 时不许静默跳过）',
  PRIVATE_IDS.size > 0 || !hasLocalProfile, `size=${PRIVATE_IDS.size} hasProfile=${hasLocalProfile}`)
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

// ------------------------------------------- ②b 私有昵称（昵称也能指到账号）--
{
  const nicknames = collectPrivateNicknames()
  const hits = []
  for (const { name: trackedName, text } of textFiles) {
    for (const name of nicknames) if (text.includes(name)) hits.push(`${trackedName}: ${name}`)
  }
  // 收不到就明确跳过（CI 里用 DSH_QQ_PRIVATE_NICKNAMES 注入），不假装通过。
  check('没有把本机机器人的真实昵称写进仓库（昵称同样能指到用户的 QQ 账号）',
    nicknames.size === 0 || hits.length === 0,
    nicknames.size === 0 ? '本机没收集到私有昵称（跳过）' : hits.slice(0, 3).join(' / '))
  check('私有昵称清单可用（本机有配置时不许静默跳过）',
    typeof collectPrivateNicknames === 'function'
    && collectPrivateNicknames({ env: { DSH_QQ_PRIVATE_NICKNAMES: '某个昵称甲,另一个昵称乙' } }).has('某个昵称甲'),
    [...nicknames].length ? [...nicknames].join(',') : '（本机为空）')
}

// ------------------------------- ②c "真机输出被抄进仓库"的几种具体形状 --
/**
 * 昵称不好枚举，但**"从真机日志里复制一段"**这个动作有固定形状。2026-10-06 审计发现
 * 本机机器人账号的真实昵称就是被这么抄进注释/用例并推到 GitHub 的，所以这里直接拦形状：
 * 桥的收信行、NapCat 的 WebUI token 行、NapCat 的运行日志片段。
 */
const REAL_MACHINE_SHAPES = [
  [/\|\s*接收\s*<-/, '桥日志里的真机收信行（含昵称/号）'],
  // 模式本身要"带值"才精准：写成 /WebUi Token:\s*\S+/ 会**匹配到这条规则自己的源码**
  // （\s*\S+ 里那个反斜杠也算非空白字符），第一版就因此误报了一次。
  [/WebUi Token:\s*[0-9a-fA-F]{6,}/i, 'NapCat 的 WebUI token 行'],
  [/User Panel Url:\s*https?:\/\/[^\s]*[?&]token=[^\s"']{4,}/i, 'NapCat 的 WebUI 地址行（含 token 参数）'],
  [/\[AdapterManager\]/, 'NapCat 运行日志片段'],
]
/**
 * 命中形状后还要看一眼"是不是明显假值"——真 token 是随机串，示例里写的是
 * placeholder/example/尖括号占位。不这样区分的话，规则会把**测试自己写的那行假 token**
 * 也当成泄露（第一版就误报了自己刚写的断言）。
 */
const FAKE_MACHINE_ALLOW = [/example/i, /placeholder/i, /<[^>]{1,40}>/, /token=x?abc/i, /a1b2c3d4/i]
{
  const hits = []
  for (const { name: trackedName, text } of textFiles) {
    for (const [pattern, label] of REAL_MACHINE_SHAPES) {
      const match = pattern.exec(text)
      if (match === null) continue
      if (FAKE_MACHINE_ALLOW.some((allow) => allow.test(match[0]))) continue
      hits.push(`${trackedName}: ${label}`)
    }
  }
  check('没有把真机日志片段原样抄进仓库（这类复制是昵称/token 泄露的实际入口）',
    hits.length === 0, hits.slice(0, 3).join(' / '))
}

// ------------------------------------------------------------- ③ 密钥形态 --
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{20,}/g, 'OpenAI 风格 key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '私钥'],
  [/Bearer\s+[A-Za-z0-9._-]{24,}/g, 'Bearer token'],
  [/\b[0-9a-f]{32}\.[A-Za-z0-9_-]{12,}\b/g, '复合形态 key（如智谱）'],
  // 早期版本漏了这一类：一条真机上的 `?token=<44 位随机串>` 被抄进测试文件后一路通过。
  [/[?&](?:token|access_token|key|apikey|api_key|secret)=([A-Za-z0-9._~-]{16,})/gi, 'URL 里的长 token'],
  [/\b(?:token|apiKey|api_key|secret|password)\s*[:=]\s*["']([A-Za-z0-9._~-]{24,})["']/gi, '赋值型长密钥'],
]
// 允许的**显式假值**：只有命中这张表才放行。旧实现用 /your|example|xxx|\.\.\./ 一刀切，
// 会把任何恰好含这些子串的真密钥一起吞掉。
const FAKE_SECRET_ALLOW = [
  /example-token/i, /OLD_token_value/i, /NEW_token_value/i, /test-token/i, /SECRET-TOKEN/i,
  /<[^>]{1,40}>/, /placeholder/i, /dummy/i, /^[?&]token=x?abc$/i,
]
const isFakeSecret = (match) => FAKE_SECRET_ALLOW.some((re) => re.test(match))
const secretHits = []
for (const { name, text } of textFiles) {
  for (const [re, label] of SECRET_PATTERNS) {
    for (const match of text.matchAll(re)) {
      if (isFakeSecret(match[0])) continue
      secretHits.push(`${name}: ${label}`)
    }
  }
}
check('没有密钥形态的字符串', secretHits.length === 0, [...new Set(secretHits)].slice(0, 5).join(' | '))

// 配置 schema 里所有"密钥类"字段的默认值必须是空串/占位（真实值只应存在于机器本地配置）
const schema = textFiles.find(({ name }) => name === 'lib/index.js')?.text ?? ''
const keyDefaults = [...schema.matchAll(/(\w*(?:ApiKey|Token|Password|Secret)\w*)\s*:\s*z\.string\(\)[^\n]*?\.default\(\s*(['"])([^'"]*)\2\s*\)/gi)]
const nonEmptyKeyDefaults = keyDefaults.filter((match) => match[3] !== '')
check('配置 schema 里的密钥字段默认值为空', nonEmptyKeyDefaults.length === 0, nonEmptyKeyDefaults.map((match) => `${match[1]}=${match[3].length}字符`).join(','))
// 这条检查自身必须有效：旧正则只认单引号 `.default('…')`，双引号写法会整片隐形，
// 而"至少 4 个"的下限照样通过。所以这里点名几个必须被覆盖到的字段。
const defaultedNames = new Set(keyDefaults.map((match) => match[1]))
check('关键密钥字段确实被默认值检查覆盖',
  ['sttApiKey', 'ttsApiKey', 'imageGenApiKey'].every((field) => defaultedNames.has(field)) && keyDefaults.length >= 4,
  `${keyDefaults.length} 个：${[...defaultedNames].join(',')}`)

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

// --------------------------------------------- ⑧ 历史 / 对象库（可选，只报告）--
// 工作树干净 ≠ 历史干净：被后续提交删掉的、以及**悬空**的 blob 里可能还留着
// 本机路径或密钥（真机实测：3 个悬空 blob 含家目录路径，正常 push 不会带走，
// 但 `--mirror`、复制 `.git`、`clone --local` 会）。
// 这类残留只能用「改写历史 / git gc --prune」清除，不是一次提交能修的，
// 所以默认**只报告不判失败**：`DSH_QQ_PRIVACY_HISTORY=1 node test/privacy-unit.mjs`。
if (String(process.env.DSH_QQ_PRIVACY_HISTORY ?? '') === '1' && listed.source === 'git') {
  const historyBodies = () => {
    const out = execFileSync('git', ['cat-file', '--batch-all-objects', '--batch'], { cwd: repo, encoding: 'latin1', maxBuffer: 256 * 1024 * 1024 })
    const bodies = []
    let at = 0
    while (at < out.length) {
      const headerEnd = out.indexOf('\n', at)
      if (headerEnd < 0) break
      const parts = out.slice(at, headerEnd).split(' ')
      const size = Number(parts[2])
      if (parts.length !== 3 || !Number.isFinite(size)) { at = headerEnd + 1; continue }
      bodies.push([parts[0].slice(0, 8), out.slice(headerEnd + 1, headerEnd + 1 + size)])
      at = headerEnd + 1 + size + 1
    }
    return bodies
  }
  const scanHistory = (matcher) => historyBodies().filter(([, body]) => matcher(body)).map(([oid]) => oid)
  const user = homedir().split(/[\\/]/).filter(Boolean).pop() ?? ''
  const reports = []
  if (PRIVATE_IDS.size > 0) reports.push(['真机私有号', scanHistory((body) => [...PRIVATE_IDS].some((id) => body.includes(id)))])
  if (user !== '') reports.push([`本机用户名路径（Users/${user.slice(0, 2)}…）`, scanHistory((body) => new RegExp(`Users[\\\\/]+${user}`, 'i').test(body))])
  // 历史里的盘符路径同样按"这台机器上真的存在"判定；blob 正文是 latin1 解码的字节，
  // 含中文的路径要按字节还原成 utf8 才能 existsSync（否则永远判"不存在"）。
  reports.push(['本机真实存在的绝对路径', scanHistory((body) => {
    for (const match of body.matchAll(DRIVE_PATH)) {
      const candidate = Buffer.from(match[1].replace(/[.,;:]+$/, ''), 'latin1').toString('utf8')
      if (candidate.length < 5 || OS_PATH_ALLOW.some((re) => re.test(candidate))) continue
      if (existsSync(candidate)) return true
    }
    return false
  })])
  for (const [label, hits] of reports) {
    console.log(hits.length === 0 ? `HISTORY 干净：${label}` : `HISTORY 命中 ${hits.length} 个 blob（${label}）：${[...new Set(hits)].slice(0, 8).join(', ')}`)
  }
  console.log('HISTORY 说明：命中的对象若为悬空 blob，可 `git gc --prune=now` 清除；若在可达提交里，只能改写历史（会改所有提交哈希，需谨慎）。')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
