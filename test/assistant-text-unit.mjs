/** assistantText 的 content 兜底单测（真机上抛过 reading 'filter'） */
import { assistantText } from '../lib/bridge.js'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed += 1; console.log('PASS', name, extra) } else { failed += 1; console.log('FAIL', name, extra) }
}

check('★content 缺失 → 空串（不抛 reading filter）', assistantText({ data: { message: {} } }) === '')
check('★content 是字符串 → 空串', assistantText({ data: { message: { content: 'hello' } } }) === '')
check('★content 是 null → 空串', assistantText({ data: { message: { content: null } } }) === '')
check('★事件本身残缺（无 data）→ 空串', assistantText({}) === '')
check('正常数组 → 拼出文本',
  assistantText({ data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] } } }) === 'ab')
check('只有非文本块 → 空串', assistantText({ data: { message: { content: [{ type: 'image' }] } } }) === '')
check('块里有 null → 不崩', assistantText({ data: { message: { content: [null, { type: 'text', text: 'x' }] } } }) === 'x')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
