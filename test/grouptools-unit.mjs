/** Unit tests for group tools: vote command parsing and todo store. */
import { parseVoteCommand, TodoStore } from '../lib/grouptools.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// vote parsing
const v1 = parseVoteCommand('投票：今晚吃什么？A 火锅 B 烧烤')
check('投票解析问题', v1?.question === '今晚吃什么', v1?.question)
check('投票解析选项数', v1?.options.length === 2, JSON.stringify(v1?.options))
check('投票选项A', v1?.options[0].key === 'A' && v1?.options[0].label === '火锅', JSON.stringify(v1?.options[0]))
check('投票选项B', v1?.options[1].key === 'B' && v1?.options[1].label === '烧烤', JSON.stringify(v1?.options[1]))

const v2 = parseVoteCommand('/vote 去不去团建 A 去 B 不去 C 看情况')
check('/vote 前缀解析', v2?.options.length === 3 && v2?.options[2].label === '看情况', JSON.stringify(v2))

const v3 = parseVoteCommand('投票：今晚开黑吗？')
check('无选项默认赞成反对', v3?.options.length === 2 && v3?.options[0].label === '赞成' && v3?.options[1].label === '反对', JSON.stringify(v3))

check('非投票消息不识别', parseVoteCommand('今天天气怎么样') === null)
check('普通消息不识别', parseVoteCommand('/status') === null)
// 回归（真机审计发现）：/vote-end 曾被这一支吃掉，导致投票永远结束不了
check('/vote-end 不被当成发起投票', parseVoteCommand('/vote-end') === null)
check('/vote-end 前后空白同样不误判', parseVoteCommand('  /vote-end  ') === null)
check('/vote-anything 也不误判', parseVoteCommand('/vote-xyz') === null)
check('裸 /vote 不误判（交给查看分支）', parseVoteCommand('/vote') === null)
check('/vote 后跟空格仍能发起', parseVoteCommand('/vote 去不去 A 去 B 不去')?.options.length === 2)
check('/vote:问题 冒号形式仍可', parseVoteCommand('/vote:去哪玩 A 公园 B 家里')?.question === '去哪玩')

// todo store round-trip
const dir = mkdtempSync(join(tmpdir(), 'qq-todos-test-'))
const store = new TodoStore(dir)
const list = [{ id: 't1', text: '写周报', done: false, ts: 1 }, { id: 't2', text: '买鱼', done: true, ts: 2 }]
store.save('g:123', list)
const loaded = store.load('g:123')
check('todo 持久化往返', loaded.length === 2 && loaded[0].text === '写周报' && loaded[1].done === true, JSON.stringify(loaded))
check('todo 空键返回空', store.load('g:404').length === 0)
rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
