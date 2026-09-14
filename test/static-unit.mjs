/**
 * Static cross-checks between the shipped files (no bridge instance needed):
 *   - every `config.<key>` read in lib/ exists in the schemastery schema
 *   - every schema key is actually used somewhere in lib/ (no dead config)
 *   - no duplicated class method names (silent override)
 *   - every named import exists as an export in the target module
 *   - all sources are valid UTF-8 (no mojibake from a bad editor round-trip)
 */
import { readFileSync, readdirSync } from 'node:fs'
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
  const top = /^## v([0-9.]+)/m.exec(changelog.replace(/^#[^\n]*\n+/, ''))
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

// ---- README 惯例：更新日志只展示最近**两个大版本**（每个大版本一条线）----
// 口径：两条 `- **vX.Y 线…（vA → vB）** — …`；第一条必须是当前版本所在的大版本线，
// 且该线区间以当前版本结尾——这样 README 不会停在旧版本上。
const readme = readFileSync(join(libDir, '..', 'README.md'), 'utf8')
// 形如：`- **v0.5 线（v0.5.0 → v0.5.6，当前）** — …` / `- **v0.5 line (v0.5.0 → v0.5.6, current)** — …`
// 刻意不锚定「线 / line」这几个字（措辞将来可能改），只要求：大版本号 + 紧跟的区间括号。
const majorPattern = /^- \*\*v([0-9]+\.[0-9]+)[^\n]{0,24}?[（(]v[0-9.]+ → v([0-9.]+)/gm
const majorBullets = [...readme.matchAll(majorPattern)].map((match) => ({ major: match[1], last: match[2] }))
check('README 更新日志只列两个大版本', majorBullets.length === 2, majorBullets.map((b) => b.major).join(','))
const currentMajor = pkg.version.split('.').slice(0, 2).join('.')
check('README 首个大版本 = 当前版本所在的线，且区间以当前版本结尾',
  majorBullets[0]?.major === currentMajor && majorBullets[0]?.last === pkg.version,
  `${majorBullets[0]?.major} / ${majorBullets[0]?.last} vs ${currentMajor} / ${pkg.version}`)
const readmeEn = readFileSync(join(libDir, '..', 'README.en.md'), 'utf8')
const majorBulletsEn = [...readmeEn.matchAll(majorPattern)].map((match) => ({ major: match[1], last: match[2] }))
check('英文 README 同样只列两个大版本', majorBulletsEn.length === 2, majorBulletsEn.map((b) => b.major).join(','))
check('英文 README 首条大版本同版本',
  majorBulletsEn[0]?.major === currentMajor && majorBulletsEn[0]?.last === pkg.version,
  `${majorBulletsEn[0]?.major} / ${majorBulletsEn[0]?.last}`)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
