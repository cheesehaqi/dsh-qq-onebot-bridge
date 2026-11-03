/**
 * 账号中心页面「运行时」冒烟：
 *   把内联 <script> 放进 vm + Proxy DOM 桩里真跑一遍。
 *   目的：抓 node --check 抓不到的那类错误 ——
 *     ① 引用了不存在的变量（真机踩过：keyword 是 renderLines 的局部 const，偏好代码直接用 → ReferenceError）
 *     ② 元素为 null 时的属性访问（真机踩过：面板 HTML 放在 </script> 之后 → 初始化中断 → LOADERS TDZ）
 *     ③ 初始化阶段的 TDZ
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

const html = readFileSync(join(import.meta.dirname, '..', 'control', 'accounts.html'), 'utf8')
const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

/** 万能 DOM 桩：任何属性访问都返回可调用、可再取的 Proxy，避免桩本身引发误报。 */
const handler = {
  get(target, key) {
    if (key === Symbol.toPrimitive) return () => ''
    if (key === 'length') return 0
    if (key === 'childNodes' || key === 'children') return []
    if (key === 'classList') return target.__classList ?? (target.__classList = chain())
    if (key === 'style') return target.__style ?? (target.__style = chain())
    if (key === 'dataset') return target.__dataset ?? (target.__dataset = {})
    if (key in target) return target[key]
    return chain()
  },
  set(target, key, value) { target[key] = value; return true },
  apply() { return chain() },
  has() { return true },
}
function chain() { return new Proxy(function () { return chain() }, handler) }

const makeSandbox = () => {
  const element = chain()
  const sandbox = {
    document: {
      querySelector: () => element,
      querySelectorAll: () => [],
      getElementById: () => element,
      createElement: () => element,
      addEventListener: () => {},
      body: element,
      documentElement: element,
      title: '',
    },
    window: { addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }), open: () => {} },
    location: { search: '', hash: '', href: 'http://127.0.0.1:8799/accounts' },
    history: { replaceState: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => ({ text: async () => '{"ok":false}' }),
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    console,
    URL, URLSearchParams, Promise, Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Error, Map, Set,
    Blob: class { constructor() {} },
    confirm: () => false,
    alert: () => {},
  }
  sandbox.globalThis = sandbox
  return sandbox
}

const run = (code) => {
  try {
    vm.runInNewContext(code, makeSandbox(), { filename: 'accounts-inline.js', timeout: 5000 })
    return { ok: true, message: '' }
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) }
  }
}

// ① 正文：必须能跑完
const main = run(script)
check('★内联脚本在 DOM 桩里能跑完（抓未定义引用 / TDZ / null 属性访问）', main.ok, main.message)

// ② 反向验证：把 logKeyword 的「读取」换回局部变量名 keyword，应当立刻报错
//    （注意：赋值不会报错——非严格模式下给未声明变量赋值会静默建全局，所以必须改「读取」那一处）
const mutated = script.replace("if (search && logKeyword !== '') search.value = logKeyword", "if (search && keyword !== '') search.value = logKeyword")
check('★反向验证：读取未声明的 keyword 后应当失败', mutated !== script && run(mutated).ok === false, run(mutated).message)

// ③ 反向验证：初始化阶段访问未定义的全局，应当失败
const mutated2 = script.replace("  const token = ", "  void notDefinedAnywhere\n  const token = ")
check('★反向验证：初始化阶段引用未定义全局应当失败', mutated2 !== script && run(mutated2).ok === false, run(mutated2).message)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
