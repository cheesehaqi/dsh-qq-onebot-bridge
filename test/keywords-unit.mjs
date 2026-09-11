/** Unit tests for the local keyword auto-reply store (no network, no model). */
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeywordStore, normalizeEntry, parseKeywordCommand } from '../lib/keywords.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const dir = mkdtempSync(join(tmpdir(), 'qq-keywords-test-'))
const file = join(dir, 'qq-keywords.json')

// 空库：文件不存在时不抛异常，返回空结构
const empty = new KeywordStore(file)
const emptyData = empty.load()
check('文件不存在返回空库', Array.isArray(emptyData.global) && emptyData.global.length === 0, JSON.stringify(emptyData))
check('空库 match 返回 null', empty.match('你好') === null)
check('空库 list 为空', empty.list().length === 0)

// 初始库：exact / contains / regex，全局 + 聊天级
writeFileSync(file, JSON.stringify({
  version: 1,
  global: [
    { trigger: '你好', match: 'contains', reply: ['你好呀～', '嗨！'], scope: 'all' },
    { trigger: '你好呀', match: 'contains', reply: ['长词优先'], scope: 'all' },
    { trigger: '^早[安上]', match: 'regex', reply: ['早上好！'], scope: 'group' },
    { trigger: '私聊专属', match: 'exact', reply: ['只在小窗说话'], scope: 'private' },
    { trigger: '冷却词', match: 'exact', reply: ['三十秒一次'], cooldownSeconds: 30 },
  ],
  chats: { 'g:100': [{ trigger: '你好呀', match: 'exact', reply: ['聊天级优先'] }] },
}), 'utf8')

const store = new KeywordStore(file)
const loaded = store.load()
check('全局条目归一化 5 条', loaded.global.length === 5, JSON.stringify(loaded.global.map((e) => e.trigger)))
check('归一化含来源标记', loaded.global[0].source === 'global' && loaded.chats['g:100'][0].source === 'chat')

// 优先级：精确 > 包含 > 正则；同级长 trigger 优先
const hitGlobal = store.match('你好呀', { rng: () => 0.99 })
check('全局长 trigger 优先于短 trigger', hitGlobal?.reply === '长词优先', JSON.stringify(hitGlobal))
const hitChat = store.match('你好呀', { chatKey: 'g:100', rng: () => 0.99 })
check('聊天级条目优先于全局', hitChat?.reply === '聊天级优先', JSON.stringify(hitChat))
const hitExact = store.match('私聊专属', { rng: () => 0 })
check('精确匹配优于包含', hitExact?.reply === '只在小窗说话', JSON.stringify(hitExact))
check('精确匹配对非整句不命中', store.match('这是私聊专属内容', { rng: () => 0 }) === null)
const hitRegex = store.match('早上好呀大家', { isGroup: true, rng: () => 0 })
check('正则命中（regex 最低优先级仍可命中）', hitRegex?.reply === '早上好！' && hitRegex?.trigger === '^早[安上]', JSON.stringify(hitRegex))

// 随机 reply：注入固定 rng
const pickLast = store.match('你好', { rng: () => 0.99 })
check('rng 注入取最后一条', pickLast?.reply === '嗨！', JSON.stringify(pickLast))

// scope 过滤
check('私聊条目在群里不命中', store.match('私聊专属', { isGroup: true }) === null)
check('群条目在私聊不命中', store.match('早上好', { isGroup: false }) === null)
check('all 条目私聊群聊都命中', store.match('你好', { isGroup: false })?.reply !== undefined)

// 命令与空文本不参与匹配
check('斜杠命令不匹配', store.match('/你好') === null)
check('空文本不匹配', store.match('   ') === null)
check('null 文本不匹配', store.match(null) === null)

// 冷却窗口
const cooled = new KeywordStore(file)
const t0 = 1_000_000
check('冷却首次命中', cooled.match('冷却词', { chatKey: 'g:100', now: t0 })?.reply === '三十秒一次')
check('冷却窗口内不命中', cooled.match('冷却词', { chatKey: 'g:100', now: t0 + 500 }) === null)
check('冷却窗口内其他会话不受影响', cooled.match('冷却词', { chatKey: 'g:200', now: t0 + 500 }) !== null)
check('冷却结束后命中', cooled.match('冷却词', { chatKey: 'g:100', now: t0 + 30_500 }) !== null)

// mtime 变化后自动重载（load 缓存 + 手动改动文件）
const cached = new KeywordStore(file)
cached.load()
const mtimeMs = statSync(file).mtimeMs
check('mtime 缓存：未 change 时返回同一结构', cached.load() === cached.load())
writeFileSync(file, JSON.stringify({ version: 1, global: [{ trigger: '新鲜词', match: 'exact', reply: ['热更新成功'] }], chats: {} }), 'utf8')
await sleep(30)
utimesSync(file, new Date(), new Date())
const reloaded = cached.load()
check('mtime 变化后自动重载', reloaded.global.length === 1 && reloaded.global[0].trigger === '新鲜词', JSON.stringify(reloaded.global))
check('mtime 变化后匹配到新内容', cached.match('新鲜词')?.reply === '热更新成功')
void mtimeMs

// 损坏 JSON 容错 + 备份
writeFileSync(file, '{ 这不是合法 JSON', 'utf8')
const broken = new KeywordStore(file)
const brokenData = broken.load()
check('损坏 JSON 返回空库不抛异常', brokenData.global.length === 0 && broken.match('新鲜词') === null)
let backup = ''
try { backup = readFileSync(`${file}.broken`, 'utf8') } catch { backup = '' }
check('损坏文件已备份到 .broken', backup.includes('这不是合法 JSON'), backup.slice(0, 24))

// add / remove / list / save
const edited = new KeywordStore(join(dir, 'edit.json'))
check('add 返回 true', edited.add({ trigger: '签到', reply: '签到成功' }) === true)
check('add 非法条目返回 false', edited.add({ trigger: '' }) === false && edited.add({ trigger: '无回复' }) === false)
check('add 后 list 可见', edited.list().some((e) => e.trigger === '签到' && e.reply[0] === '签到成功' && e.source === 'global'))
edited.add({ trigger: '群专属', reply: ['群里见'], scope: 'group' }, 'g:9')
check('add 聊天级条目', edited.list('g:9').filter((e) => e.source === 'chat').length === 1 && edited.match('群专属', { chatKey: 'g:9', isGroup: true })?.reply === '群里见')
check('save 写文件成功', edited.save() === true)
const savedRaw = JSON.parse(readFileSync(join(dir, 'edit.json'), 'utf8'))
check('save 结构正确', savedRaw.version === 1 && savedRaw.global.length === 1 && savedRaw.chats['g:9'].length === 1)
check('save 不写入 source 标记', savedRaw.global[0].source === undefined)
check('remove 成功返回 true', edited.remove('签到') === true)
check('remove 后再 list 不可见', !edited.list().some((e) => e.trigger === '签到'))
check('remove 不存在返回 false', edited.remove('从来没加过') === false)

// normalizeEntry
check('normalizeEntry 缺省值', normalizeEntry({ trigger: ' x ', reply: 'y' })?.match === 'contains', JSON.stringify(normalizeEntry({ trigger: ' x ', reply: 'y' })))
check('normalizeEntry scope 缺省 all', normalizeEntry({ trigger: 'a', reply: [] , image: 'http://x' })?.scope === 'all')
check('normalizeEntry reply 数组化', Array.isArray(normalizeEntry({ trigger: 'a', reply: 'one' })?.reply))
check('normalizeEntry 冷却数字化', normalizeEntry({ trigger: 'a', reply: 'x', cooldownSeconds: '5' })?.cooldownSeconds === 5)
check('normalizeEntry 非法返回 null', normalizeEntry(null) === null && normalizeEntry({ reply: 'x' }) === null && normalizeEntry({ trigger: 'a' }) === null)

// parseKeywordCommand
const cmdAdd = parseKeywordCommand('/kw add 你好 你好呀～')
check('/kw add 解析', cmdAdd?.action === 'add' && cmdAdd.trigger === '你好' && cmdAdd.reply === '你好呀～', JSON.stringify(cmdAdd))
const cmdCn = parseKeywordCommand('/词库 add 你好 你好呀')
check('/词库 add 解析', cmdCn?.action === 'add' && cmdCn.trigger === '你好' && cmdCn.reply === '你好呀', JSON.stringify(cmdCn))
const cmdImg = parseKeywordCommand('/kw add 猫咪')
check('回复可为空（只发图片）', cmdImg?.action === 'add' && cmdImg.trigger === '猫咪' && cmdImg.reply === '')
const cmdDel = parseKeywordCommand('/kw del 你好')
check('/kw del 解析', cmdDel?.action === 'remove' && cmdDel.trigger === '你好', JSON.stringify(cmdDel))
const cmdList = parseKeywordCommand('/kw list')
check('/kw list 解析', cmdList?.action === 'list')
check('非法命令返回 null', parseKeywordCommand('/kw add') === null && parseKeywordCommand('你好') === null && parseKeywordCommand('/kw 你好') === null && parseKeywordCommand(null) === null)

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
