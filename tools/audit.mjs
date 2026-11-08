#!/usr/bin/env node
/**
 * 结构审计：一条命令看完"代码结构有没有被改坏"。
 *
 * 这不是替代单测，而是补单测看不见的那几类：
 *   ① 语法：每个 .js/.mjs 都能过 node --check
 *   ② 页面时序：账号中心里 $('id') 引用的元素必须在 <script> 之前（真机踩过：整页停住）
 *   ③ 路由一致性：前端调用的 /api 路径必须在 server.mjs 里有实现
 *   ④ 路由覆盖：每个 /api 路由至少在 test/ 里被提到过
 *   ⑤ 关键文件规模：server.mjs / accounts.mjs / accounts.html 行数不许异常缩水
 *
 * 用法：node tools/audit.mjs
 * 退出码：0 全过；1 有问题（每条都会打印原因）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let problems = 0
const out = (text) => console.log('  ' + text)
const fail = (text) => { problems += 1; console.log('  ✗ ' + text) }

// ---------- ① 语法 ----------
const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '_trash' || name === '_backups') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { walk(full); continue }
    if (/\.(m?js)$/.test(name)) files.push(full)
  }
}
for (const dir of ['lib', 'control', 'client', 'test', 'tools']) {
  try { walk(join(ROOT, dir)) } catch { /* 目录不存在就跳过 */ }
}
let syntaxBad = 0
for (const file of files) {
  try { execFileSync('node', ['--check', file], { stdio: 'pipe' }) }
  catch { syntaxBad += 1; fail('语法：' + relative(ROOT, file)) }
}
out(`① 语法：${files.length} 个文件 / 错 ${syntaxBad}`)

// ---------- ② 页面时序 ----------
const html = readFileSync(join(ROOT, 'control/accounts.html'), 'utf8')
const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
const scriptAt = html.indexOf('<script')
// 由 JS 动态创建、页面里本来就没有静态节点的 id
const DYNAMIC = new Set(['btnStatusRetry', 'navIndicator', 'cfgPort', 'cfgHost', 'btnSaveCfg', 'cfgState'])
const ids = new Set([...script.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]))
const tooLate = [...ids].filter((id) => {
  if (DYNAMIC.has(id)) return false
  const at = html.indexOf('id="' + id + '"')
  return at < 0 || at > scriptAt
})
if (tooLate.length > 0) fail('页面时序：这些 id 在脚本执行时还不存在 → ' + tooLate.join(', '))
else out(`② 页面时序：${ids.size} 个 id（+${DYNAMIC.size} 个动态）全部就位`)

// ---------- ③ 路由一致性 ----------
const server = readFileSync(join(ROOT, 'control/lib/server.mjs'), 'utf8')
const called = new Set([...script.matchAll(/['"`](\/api\/[A-Za-z0-9_/?=&.-]*)['"`]/g)].map((m) => m[1].split('?')[0]))
const noRoute = [...called].filter((path) => !server.includes("'" + path + "'"))
if (noRoute.length > 0) fail('路由一致性：前端调用了但没有实现 → ' + noRoute.join(', '))
else out(`③ 路由一致性：${called.size} 个前端调用全部有实现`)

// ---------- ④ 路由覆盖 ----------
const routes = [...new Set([...server.matchAll(/path === '(\/api\/[^']+)'/g)].map((m) => m[1]))]
const testText = readdirSync(join(ROOT, 'test'))
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => readFileSync(join(ROOT, 'test', name), 'utf8'))
  .join('\n')
const uncovered = routes.filter((path) => !testText.includes(path))
if (uncovered.length > 0) fail('路由覆盖：这些路由在 test/ 里没出现过 → ' + uncovered.join(', '))
else out(`④ 路由覆盖：${routes.length} 个路由全部有测试提到`)

// ---------- ⑤ 关键文件规模 ----------
const invariants = [
  ['control/lib/server.mjs', 600],
  ['control/lib/accounts.mjs', 900],
  ['control/accounts.html', 1800],
]
for (const [file, minLines] of invariants) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n').length
  if (lines < minLines) fail(`文件规模：${file} 只有 ${lines} 行（< ${minLines}，疑似被误删）`)
  else out(`⑤ ${file}：${lines} 行（≥ ${minLines}）`)
}

// ---------- ⑥ 打包形态 ----------
/**
 * 安装形态是按 package.json 的 files 铺出来的。脚本里引用的路径如果不在 files 覆盖范围内，
 * 用户装完再跑这条命令就会撞「文件不存在」——2026-11-07 由 551123 的铺装读数发现：
 * tools/audit.mjs 当时没进 files，npm run audit 在线上树里跑不起来。
 */
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const roots = Array.isArray(pkg.files) ? pkg.files : []
  const scripts = pkg.scripts ?? {}
  const covered = (relPath) => roots.some((root) => {
    const clean = String(root).replace(/^\/+|\/+$/g, '')
    if (clean === '') return false
    // 目录式条目：files 里写 "tools" 覆盖 "tools/audit.mjs"
    return relPath === clean || relPath.startsWith(clean + '/')
  })
  const scriptTargets = []
  for (const [name, command] of Object.entries(scripts)) {
    for (const match of String(command).matchAll(/(?:node|npx)\s+([\w./-]+\.(?:m?js|cjs))\b/g)) {
      scriptTargets.push({ name, file: match[1].replace(/^\.\//, '') })
    }
  }
  const missing = scriptTargets.filter((item) => {
    try { statSync(join(ROOT, item.file)); return false } catch { return true }
  })
  const unpacked = scriptTargets.filter((item) => !covered(item.file))
  if (missing.length > 0) fail('打包形态：这些脚本指向的文件不存在 → ' + missing.map((item) => item.name + ':' + item.file).join(', '))
  if (unpacked.length > 0) fail('打包形态：这些脚本引用的文件不在 package.json files 里 → ' + unpacked.map((item) => item.name + ':' + item.file).join(', '))
  if (missing.length === 0 && unpacked.length === 0) {
    out(`⑥ 打包形态：${scriptTargets.length} 个脚本引用都在 files 覆盖范围内（files 共 ${roots.length} 项）`)
  }
}

console.log(problems === 0 ? '\n  全部通过' : `\n  有 ${problems} 个问题`)
process.exit(problems === 0 ? 0 : 1)
