/**
 * Static cross-checks between the shipped files (no bridge instance needed):
 *   - every `config.<key>` read in lib/ exists in the schemastery schema
 *   - every schema key is actually used somewhere in lib/ (no dead config)
 *   - no duplicated class method names (silent override)
 *   - every named import exists as an export in the target module
 *   - all sources are valid UTF-8 (no mojibake from a bad editor round-trip)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config } from '../lib/index.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
const files = readdirSync(libDir).filter((name) => name.endsWith('.js')).sort()

// ---- UTF-8 完整性（防止编辑器/脚本把文件写坏成乱码）----
const badEncoding = []
for (const name of files) {
  const buffer = readFileSync(join(libDir, name))
  const text = buffer.toString('utf8')
  if (text.includes('\uFFFD')) badEncoding.push(name)
}
check('lib/ 全部为合法 UTF-8（无乱码替换字符）', badEncoding.length === 0, badEncoding.join(','))

// ---- 配置键：代码里读的必须在 schema 里 ----
const schemaKeys = new Set(Object.keys(Config({})))
const skipKeys = new Set(['then', 'constructor', 'name', 'length', 'toString', 'valueOf', 'hasOwnProperty'])
const readKeys = new Map()   // key -> [file:line]
for (const name of files) {
  const lines = readFileSync(join(libDir, name), 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/(?:this\.)?config\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const key = match[1]
      if (skipKeys.has(key)) continue
      if (!readKeys.has(key)) readKeys.set(key, [])
      readKeys.get(key).push(`${name}:${index + 1}`)
    }
  })
}
const unknownKeys = [...readKeys.keys()].filter((key) => !schemaKeys.has(key))
check('代码读取的配置键都存在', unknownKeys.length === 0, unknownKeys.map((key) => `${key}(${readKeys.get(key)[0]})`).join(', '))

// 反向：schema 里的键必须有人在用（避免“配了不生效”的死开关）
const corpus = files.map((name) => readFileSync(join(libDir, name), 'utf8')).join('\n')
const unusedKeys = [...schemaKeys].filter((key) => {
  const pattern = new RegExp(`config\\.${key}\\b`)
  return !pattern.test(corpus)
})
check('schema 中没有完全没人用的死配置键', unusedKeys.length === 0, unusedKeys.join(', '))
check('配置键数量合理（>120）', schemaKeys.size > 120, `keys=${schemaKeys.size}`)

// ---- 类方法重复（后者静默覆盖前者）----
const bridgeSource = readFileSync(join(libDir, 'bridge.js'), 'utf8')
const seenMethods = new Map()
const duplicates = []
bridgeSource.split(/\r?\n/).forEach((line, index) => {
  const match = /^ {2}(?:async\s+)?#?([A-Za-z_][A-Za-z0-9_]*)\(/.exec(line)
  if (!match) return
  const name = match[1]
  if (seenMethods.has(name)) duplicates.push(`${name}@${seenMethods.get(name)},${index + 1}`)
  else seenMethods.set(name, index + 1)
})
check('QQBridge 无重复方法名', duplicates.length === 0, duplicates.join(' '))
check('QQBridge 方法数量合理（>100）', seenMethods.size > 100, `methods=${seenMethods.size}`)

// ---- 具名 import 必须真的被导出 ----
const exportCache = new Map()
function exportsOf(file) {
  if (exportCache.has(file)) return exportCache.get(file)
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { /* 缺失文件下面单独报 */ }
  const names = new Set()
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1])
  for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const piece = part.trim()
      if (!piece) continue
      const alias = / as ([\w$]+)$/.exec(piece)
      names.add(alias ? alias[1] : piece.split(/\s+/)[0])
    }
  }
  if (/^export\s+default\b/m.test(text)) names.add('default')
  exportCache.set(file, names)
  return names
}

const missingExports = []
for (const name of files) {
  const lines = readFileSync(join(libDir, name), 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const match = /^import\s*\{([^}]+)\}\s*from\s*'(\.\/[^']+)'/.exec(line.trim())
    if (!match) continue
    const target = join(libDir, match[2].replace(/^\.\//, ''))
    const available = exportsOf(target)
    for (const part of match[1].split(',')) {
      const piece = part.trim()
      if (!piece) continue
      const imported = /^([\w$]+)\s+as\s+/.exec(piece)?.[1] ?? piece
      if (!available.has(imported)) missingExports.push(`${name} 引用了 ${match[2]} 的 ${imported}`)
    }
  }
}
check('所有具名 import 都能在目标模块找到导出', missingExports.length === 0, missingExports.join('; '))

// ---- package.json 与入口一致 ----
const pkg = JSON.parse(readFileSync(join(libDir, '..', 'package.json'), 'utf8'))
check('package.json 版本与 CHANGELOG 顶部一致', (() => {
  const changelog = readFileSync(join(libDir, '..', 'CHANGELOG.md'), 'utf8')
  // 标题层级：大版本 `## v0.6 系列`、小节版本 `### v0.6.3`。这里只认**三段式**版本号，
// 免得把大版本标题（v0.6）当成最新版本。
const top = /^#{2,3} v(\d+\.\d+\.\d+)/m.exec(changelog.replace(/^#[^\n]*\n+/, ''))
  return top !== null && top[1] === pkg.version
})(), `package=${pkg.version}`)
check('package.json main 指向 lib/index.js', pkg.main === 'lib/index.js')
check('入口声明了 bundle patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')

// ---- 裸 import 必须已声明（issue #1：lib 里 import 'schemastery'，却只声明了 @deepseek-ai/schemastery）----
// 在别人机器上不会被"另一个插件恰好 hoist 了同名包"兜住，所以这里静态守住两条：
//   ①每个第三方规格名都必须在 dependencies/peerDependencies/optionalDependencies 里
//   ②官方依赖一律用 @deepseek-ai/* 作用域名，禁止退化成本地/裸名
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
])
const officialBases = [...declared].filter((name) => name.startsWith('@deepseek-ai/')).map((name) => name.slice('@deepseek-ai/'.length))
const undeclaredImports = []
const bareOfficialImports = []
const specifiers = new Set()
for (const name of files) {
  const text = readFileSync(join(libDir, name), 'utf8')
  const pattern = /(?:^|\s)(?:import|export)\b[^\n]*?\sfrom\s*'([^']+)'|(?:^|\s)import\s*\(\s*'([^']+)'/gm
  for (const match of text.matchAll(pattern)) {
    const spec = match[1] ?? match[2]
    if (!spec || spec.startsWith('.') || spec.startsWith('node:')) continue
    specifiers.add(spec)
    const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (!declared.has(root)) undeclaredImports.push(`${name}: ${spec}`)
    if (officialBases.includes(root)) bareOfficialImports.push(`${name}: ${spec} (应写作 @deepseek-ai/${root})`)
  }
}
check('lib/ 的第三方 import 全部已在 package.json 声明', undeclaredImports.length === 0, undeclaredImports.join('; '))
check('官方依赖统一用 @deepseek-ai/* 作用域名（不依赖他人 hoist 的裸名）', bareOfficialImports.length === 0, bareOfficialImports.join('; '))
check('规格名扫描确实抓到了官方依赖（防止正则失效假通过）', [...specifiers].some((spec) => spec.startsWith('@deepseek-ai/')), [...specifiers].join(','))

// ---- v0.5.9：peer 范围必须覆盖**声明支持的每一条运行时线** ----
// 为什么要有这条：DSH 从 0.1.x 升到 0.2.0-rc.2 后，profile 因为 peer 范围不含 0.2 **直接拒载插件**
// （`skipping profile bundle … is incompatible with dsh 0.2.0-rc.2`），而且官方桌面端
// （Electron，`~/.dsh/profiles/desktop`）与 CLI 版是同一个运行时版本——范围漏一条线，
// web 宿主和桌面端**两边都装不上**。
// 旧守卫只 grep 了字面 `^0.2.`，于是"下次升到 0.3 会照样绿"——那是假的保障。
// 现在以 `package.json` 的 `dsh.supportedRuntimeLines` 为**唯一真源**：
// 每声明支持一条线，六个 peer 范围都必须覆盖它；升运行时线时必须先改这张表（改表即测试红）。
const supportedLines = pkg.dsh?.supportedRuntimeLines ?? []
const peerDsh = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
const expectedPeers = [
  '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools',
]
const missingPeers = expectedPeers.filter((name) => !(name in (pkg.peerDependencies ?? {})))
check('六个 dsh-* peer 依赖一个都不少', missingPeers.length === 0, missingPeers.join(','))
check('声明了支持的运行时线（否则这条守卫无从判起）', supportedLines.length >= 2, JSON.stringify(supportedLines))
const uncovered = []
for (const [name, range] of peerDsh) {
  for (const line of supportedLines) {
    if (!String(range).includes(`^${line}.`)) uncovered.push(`${name} 缺 ${line} 线`)
  }
}
check('每条声明的运行时线都被 peer 范围覆盖（升线必须同步改表）',
  uncovered.length === 0, uncovered.slice(0, 6).join('; ') || `${peerDsh.length} 个 peer × ${supportedLines.length} 条线`)

// ---- README 惯例：更新日志只展示最近五版 ----
const readme = readFileSync(join(libDir, '..', 'README.md'), 'utf8')
const versionBullets = [...readme.matchAll(/^- \*\*v([0-9.]+)\*\* —/gm)].map((match) => match[1])
check('README 更新日志恰好五版（滚动）', versionBullets.length === 5, versionBullets.join(','))
check('README 首版为当前版本', versionBullets[0] === pkg.version, `${versionBullets[0]} vs ${pkg.version}`)
const readmeEn = readFileSync(join(libDir, '..', 'README.en.md'), 'utf8')
const versionBulletsEn = [...readmeEn.matchAll(/^- \*\*v([0-9.]+)\*\* —/gm)].map((match) => match[1])
check('README.en 更新日志恰好五版', versionBulletsEn.length === 5, versionBulletsEn.join(','))
check('英文 README 首版同版本', versionBulletsEn[0] === pkg.version, versionBulletsEn[0])

// ---- v0.5.9：OPS_ARG_WORDS（识别"命令粘住参数"用的词表）必须与命令正则同步 ----
// 为什么：这张表决定"`/设管理123` 该不该回用法提示"，漏一个词就意味着那个命令
// 粘了参数后仍然会悄悄落到模型（真机现场：`/设管理17xxxxxxxx` 就是这条路）。
const bridgeSrc = readFileSync(join(libDir, 'bridge.js'), 'utf8')
const wordsBlock = /const OPS_ARG_WORDS = \[([\s\S]*?)\]/.exec(bridgeSrc)
const argWords = [...(wordsBlock?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1])
const notInCommands = argWords.filter((word) => !(
  bridgeSrc.includes(`|${word}|`) || bridgeSrc.includes(`|${word})`) || bridgeSrc.includes(`(${word}|`)
))
check('OPS_ARG_WORDS 里每个词都真的出现在命令正则的候选里（防漂移）',
  argWords.length >= 15 && notInCommands.length === 0,
  notInCommands.join(',') || `${argWords.length} 个词`)

// ---- v0.6：DSH 设置面板的结构守卫 ----
// 这些字段写错的后果都很隐蔽：`dsh.client` 少了 platform 就**不会被加载**；
// `inject` 里的包名拼错会**静默跳过**；bundle 少了 __ModuleLoader__ 包裹则整块不执行。
const pkgNow = JSON.parse(readFileSync(join(libDir, '..', 'package.json'), 'utf8'))
const clientRel = pkgNow.exports?.['./client']
check('package.json 声明 ./client 导出（客户端 bundle 入口）', typeof clientRel === 'string', String(clientRel))
const clientDecl = pkgNow.dsh?.client
check('dsh.client 声明 platform=web 且注入了设置界面所需的客户端包',
  clientDecl?.platform === 'web' && Array.isArray(clientDecl?.inject)
  && clientDecl.inject.includes('@deepseek-ai/dsh-client-ui-settings'),
  JSON.stringify(clientDecl))
check('dsh.client.inject 的包名形状正确（写错会静默失效）',
  (clientDecl?.inject ?? []).length > 0
  && (clientDecl?.inject ?? []).every((name) => /^@deepseek-ai\/dsh-client-[a-z0-9-]+$/.test(name))
  // 光是"形状对"不够：拼错一个字母同样被静默跳过，所以把真正要注入的那个包钉死。
  && (clientDecl?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-settings'),
  (clientDecl?.inject ?? []).join(','))
const clientFile = join(libDir, '..', typeof clientRel === 'string' ? clientRel : 'client/client.js')
const clientOk = existsSync(clientFile) && readFileSync(clientFile, 'utf8').includes('window.__ModuleLoader__.load')
check('客户端 bundle 存在且被 __ModuleLoader__.load 包裹', clientOk, clientFile)
check('插件入口把面板挂到宿主 webServer 上（否则设置里没有那一页）',
  /ctx\.inject\(\['webServer'\]/.test(readFileSync(join(libDir, 'index.js'), 'utf8')))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
