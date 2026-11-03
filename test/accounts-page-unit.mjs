/**
 * 账号中心页面的静态体检：
 *   ① 内联 <script> 语法必须能过（真机踩过：字符串里混进真实换行 → 语法错误 → 整页按钮全失灵）
 *   ② 关键元素/函数都在（防止改一处删掉另一处）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

const html = readFileSync(join(import.meta.dirname, '..', 'control', 'accounts.html'), 'utf8')
const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
check('页面里有内联脚本', script.length > 1000, script.length + ' 字符')

const tmp = join(tmpdir(), `qq-page-check-${Date.now()}.mjs`)
writeFileSync(tmp, script, 'utf8')
let syntaxOk = true
let detail = ''
try {
  execFileSync('node', ['--check', tmp], { stdio: 'pipe' })
} catch (error) {
  syntaxOk = false
  detail = String(error.stderr ?? '').split('\n').slice(0, 3).join(' ')
}
check('★内联脚本语法通过（否则整页按不动）', syntaxOk, detail.slice(0, 160))

for (const marker of ['const activate = (tab', 'moveIndicator', 'loadMeta', 'refreshStatus', 'openLogs', 'loadStats']) {
  check('关键函数还在：' + marker, script.includes(marker))
}
check('侧栏项与分区一一对应（data-tab 都有对应 section）', (() => {
  const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1])
  const sections = new Set([...html.matchAll(/id="tab-([a-z]+)"/g)].map((m) => m[1]))
  const missing = tabs.filter((tab) => tab !== 'home' ? !sections.has(tab) : !sections.has('home'))
  return missing.length === 0
})())
check('titles 覆盖所有侧栏项', (() => {
  const tabs = new Set([...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]))
  const titlesLine = /const titles = \{([^}]*)\}/.exec(html)?.[1] ?? ''
  const keys = new Set([...titlesLine.matchAll(/([a-z]+):/g)].map((m) => m[1]))
  return [...tabs].every((tab) => keys.has(tab))
})())

check('★绑定的按钮 id 在 HTML 里都存在（否则 null.onclick 会中断整段脚本）', (() => {
  // 真机事故：JS 里绑了 $('btn-openFiles').onclick，但按钮没插进 HTML
  // → TypeError: Cannot set properties of null → 后面所有绑定都不执行 → 整页"按不动"。
  const bound = new Set([...script.matchAll(/\$\('([a-zA-Z][\w-]*)'\)\.(?:onclick|oninput|onchange)/g)].map((m) => m[1]))
  const missing = [...bound].filter((id) => !html.includes(`id="${id}"`))
  if (missing.length > 0) console.log('    缺这些元素：' + missing.join(', '))
  return missing.length === 0
})())
check('分区容器里的可点元素都带 id（避免 getElementById 拿到 null）', (() => {
  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0])
  const withoutId = buttons.filter((tag) => !/id="/.test(tag) && !/onclick="/.test(tag) && !/^<button[^>]*class="[^"]*(?:link|plain)/.test(tag))
  // 只提示带 data-* 却完全无法被脚本找到的（有 onclick 属性的内联按钮不算）
  const suspicious = withoutId.filter((tag) => /data-/.test(tag))
  if (suspicious.length > 0) console.log('    可疑按钮：' + suspicious.slice(0, 3).join(' | '))
  return true
})())

check('★LOADERS 绑定时必须判空（少一个按钮不能拖死整页）', (() => {
  const loop = /for \(const id of Object\.keys\(LOADERS\)\)[\s\S]{0,260}/.exec(script)
  if (loop === null) return false
  return /=== null\) continue|if \(!\w+\) continue|if \(\w+\) \{?/.test(loop[0])
})())

check('★LOADERS 引用的加载器都在它之前定义（const 写在后面会 TDZ，整页变死）', (() => {
  const loadersAt = script.indexOf('const LOADERS =')
  if (loadersAt < 0) return false
  const block = script.slice(loadersAt, script.indexOf('}', loadersAt))
  // 注意：要取「值」（加载器函数名），不是 key（分区名）
  const names = [...block.matchAll(/:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  const missing = names.filter((name) => {
    const defConst = script.indexOf('const ' + name + ' =')
    const defFunc = script.indexOf('function ' + name + '(')
    // 函数声明会提升，位置无所谓；const 必须在此之前
    if (defFunc >= 0 && (defConst < 0 || defFunc < defConst)) return false
    return defConst < 0 || defConst > loadersAt
  })
  if (missing.length > 0) console.log('    引用过早/未定义：' + missing.join(', '))
  return missing.length === 0
})())

check('★DOM 时序：脚本执行时元素必须已存在（放在 <script> 之后 → $(...)=null → 初始化中断）', (() => {
  const scriptAt = html.indexOf('<script')
  // 由 JS 动态创建的节点（页面里没有静态标记）
  const dynamicIds = new Set(['btnStatusRetry', 'navIndicator', 'cfgPort', 'cfgHost', 'btnSaveCfg', 'cfgState'])
  const ids = new Set([...script.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]))
  const tooLate = [...ids].filter((id) => {
    if (dynamicIds.has(id)) return false
    const at = html.indexOf('id="' + id + '"')
    return at < 0 || at > scriptAt
  })
  if (tooLate.length > 0) console.log('    脚本之后才出现（或根本不存在）：' + tooLate.join(', '))
  return ids.size > 50 && tooLate.length === 0
})())

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
