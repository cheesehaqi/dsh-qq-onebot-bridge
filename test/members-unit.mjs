/** 群成员查询纯逻辑（lib/members.js）单元测试：命令解析 + 文案格式化，不碰网络。 */
import { roleLabel, formatMemberList, formatMemberInfo, parseMemberQuery } from '../lib/members.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// 固定"当前时间"与几个秒级时间戳，方便判定禁言；全部用本地时间构造，避免时区差异。
const now = new Date(2026, 5, 1, 12, 0, 0).getTime()
const tJoin = new Date(2026, 0, 2, 3, 4, 0).getTime() / 1000 // 2026-01-02 03:04
const tTalk = new Date(2026, 5, 1, 11, 22, 0).getTime() / 1000 // 2026-06-01 11:22
const tFuture = new Date(2100, 0, 5, 6, 7, 0).getTime() / 1000 // 禁言到 2100-01-05 06:07
const tPast = new Date(2020, 0, 1, 0, 0, 0).getTime() / 1000 // 早就解禁了

// ---- 身份标签 ----
check('群主标签', roleLabel('owner') === '群主', roleLabel('owner'))
check('管理员标签', roleLabel('admin') === '管理员', roleLabel('admin'))
check('普通成员标签', roleLabel('member') === '成员', roleLabel('member'))
check('缺失身份算成员', roleLabel(undefined) === '成员', String(roleLabel(undefined)))
check('未知身份算成员', roleLabel('vip') === '成员', roleLabel('vip'))
check('身份为 null 算成员', roleLabel(null) === '成员', String(roleLabel(null)))
check('自己后缀（我）', roleLabel('admin', true) === '管理员（我）', roleLabel('admin', true))
check('群主自己后缀（我）', roleLabel('owner', true) === '群主（我）', roleLabel('owner', true))
check('非自己不加后缀', roleLabel('admin', false) === '管理员', roleLabel('admin', false))
check('isSelf 只有严格 true 才算', roleLabel('owner', 1) === '群主', roleLabel('owner', 1))

// ---- 列表：排序 / 行格式 / 统计 ----
const basic = [
  { user_id: 20002, nickname: '乙', card: '乙', role: 'member', level: '5' },
  { user_id: 10001, nickname: '甲', card: '甲', role: 'owner', level: '1' },
  { user_id: 30003, nickname: '丙', card: '丙', role: 'admin', level: '2' },
]
const r1 = formatMemberList(basic, { now })
const l1 = r1.text.split('\n')
check('列表首行人数', l1[0] === '群成员 共 3 人', l1[0])
check('列表未截断不写显示前', !r1.text.includes('显示前'))
check('列表 shown/total', r1.shown === 3 && r1.total === 3, `${r1.shown}/${r1.total}`)
check('列表 truncated=false', r1.truncated === false)
check('群主排第一', l1[1] === '1. 群主 甲(10001)', l1[1])
check('管理员排第二', l1[2] === '2. 管理员 丙(30003)', l1[2])
check('普通成员排第三', l1[3] === '3. 成员 乙(20002)', l1[3])
check('列表行数 = 表头 + 成员', l1.length === 4, String(l1.length))
check('排序不改动入参数组', basic[0].user_id === 20002 && basic[1].user_id === 10001)

// 同档按 level 数值降序（'10' > '9'，不能按字符串比），缺失 level 排最后
const levels = [
  { user_id: 11, nickname: 'low', role: 'member', level: '9' },
  { user_id: 12, nickname: 'high', role: 'member', level: '10' },
  { user_id: 13, nickname: 'none', role: 'member' },
]
const rl = formatMemberList(levels, { now }).text.split('\n')
check('level 数值降序排第一', rl[1].includes('high(12)'), rl[1])
check('level 数值降序排第二', rl[2].includes('low(11)'), rl[2])
check('缺 level 排最后', rl[3].includes('none(13)'), rl[3])

// 显示名：群名片优先于昵称，都没有退到 QQ 号
const names = [
  { user_id: 21, nickname: 'AAA', card: 'zzz', role: 'member' },
  { user_id: 22, nickname: 'bbb', role: 'member' },
  { user_id: 23, role: 'member' },
]
const rn = formatMemberList(names, { now }).text
check('群名片优先于昵称', rn.includes('zzz(21)') && !rn.includes('AAA(21)'), rn.split('\n').slice(1).join(' | '))
check('按显示名升序（bbb 排 zzz 之前）', rn.split('\n')[1].includes('bbb(22)') && rn.split('\n')[3].includes('zzz(21)'), rn.split('\n').slice(1).join(' | '))
check('无群名片用昵称', rn.includes('bbb(22)'))
check('无昵称无名片退到 QQ 号', rn.includes('QQ23(23)'))
check('空白群名片回落到昵称', formatMemberList([{ user_id: 24, nickname: '真名', card: '   ' }], { now }).text.includes('真名(24)'))

// ---- 列表：头衔 / 禁言 ----
const extras = [
  { user_id: 31, nickname: '有头衔', role: 'owner', level: '1', title: '镇群之宝', shut_up_timestamp: 0 },
  { user_id: 32, nickname: '被禁言', role: 'member', level: '1', shut_up_timestamp: tFuture },
  { user_id: 33, nickname: '曾禁言', role: 'member', level: '1', shut_up_timestamp: tPast },
]
const re = formatMemberList(extras, { now }).text
check('头衔追加在行尾', re.includes('有头衔(31)「镇群之宝」'), re.split('\n')[1])
check('禁言中标记', re.includes('被禁言(32)[禁言中]'))
check('禁言已过期不标记', re.includes('曾禁言(33)') && !re.includes('曾禁言(33)[禁言中]'))
check('shut_up_timestamp=0 不标记', re.includes('有头衔(31)「镇群之宝」') && !re.includes('有头衔(31)「镇群之宝」[禁言中]'))
check('空白头衔不追加引号', !formatMemberList([{ user_id: 41, nickname: 'x', title: '   ' }], { now }).text.includes('「'))

// ---- 列表：selfId ----
const rs = formatMemberList(basic, { selfId: 30003, now }).text
check('列表标出我自己', rs.includes('管理员（我） 丙(30003)'), rs.split('\n')[2])
check('selfId=0 不标我', !formatMemberList(basic, { now }).text.includes('（我）'))
check('selfId 数字字符串也能匹配', formatMemberList(basic, { selfId: '30003', now }).text.includes('管理员（我）'))

// ---- 列表：limit 与 truncated ----
const many = Array.from({ length: 5 }, (_, i) => ({ user_id: 100 + i, nickname: `M${i}`, role: 'member', level: String(5 - i) }))
const rt = formatMemberList(many, { limit: 2, now })
const lt = rt.text.split('\n')
check('limit 截断 shown', rt.shown === 2, String(rt.shown))
check('limit 截断 total', rt.total === 5, String(rt.total))
check('limit 截断 truncated=true', rt.truncated === true)
check('截断表头写显示前', lt[0] === '群成员 共 5 人（显示前 2 人）', lt[0])
check('截断行数正确', lt.length === 3, String(lt.length))
check('截断后序号从 1 开始', lt[1].startsWith('1. ') && lt[2].startsWith('2. '), `${lt[1]} | ${lt[2]}`)
check('默认 limit 20 不截断', formatMemberList(many, { now }).shown === 5)
check('limit=0 回落到 20', formatMemberList(many, { limit: 0, now }).shown === 5)
check('limit 负数回落到 20', formatMemberList(many, { limit: -3, now }).shown === 5)
check('limit NaN 回落到 20', formatMemberList(many, { limit: NaN, now }).shown === 5)
check('limit null 回落到 20', formatMemberList(many, { limit: null, now }).shown === 5)
check('limit 字符串数字可用', formatMemberList(many, { limit: '3', now }).shown === 3)
check('limit 小数向下取整', formatMemberList(many, { limit: 2.9, now }).shown === 2)

// ---- 列表：群名与空输入兜底 ----
const rg = formatMemberList(basic, { groupName: '测试群', limit: 2, now })
check('群名作为首行', rg.text.split('\n')[0] === '【测试群】', rg.text.split('\n')[0])
check('群名后仍是人数表头', rg.text.split('\n')[1] === '群成员 共 3 人（显示前 2 人）', rg.text.split('\n')[1])
check('群名为空白不加行', !formatMemberList(basic, { groupName: '   ', now }).text.includes('【'))
check('非数组入参给空列表', formatMemberList(null).text === '群成员 共 0 人', formatMemberList(null).text)
check('undefined 入参统计为 0', formatMemberList(undefined).shown === 0 && formatMemberList(undefined).total === 0 && formatMemberList(undefined).truncated === false)
check('字符串入参按空列表处理', formatMemberList('一群成员').total === 0)
const r0 = formatMemberList([])
check('空数组文案', r0.text === '群成员 共 0 人' && r0.shown === 0 && r0.truncated === false, r0.text)
check('空列表也带群名', formatMemberList(null, { groupName: '测试群' }).text === '【测试群】\n群成员 共 0 人')

// ---- 详情 ----
const info = {
  user_id: 424242, nickname: '小明', card: '小明同学', role: 'admin', level: '7', title: '群管',
  join_time: tJoin, last_sent_time: tTalk, shut_up_timestamp: tFuture,
}
const detail = formatMemberInfo(info, { now })
check('详情行数固定 8 行', detail.split('\n').length === 8, detail.replace(/\n/g, ' | '))
check('详情显示名用群名片', detail.includes('显示名：小明同学'))
check('详情 QQ 号', detail.includes('QQ 号：424242'))
check('详情身份', detail.includes('身份：管理员'))
check('详情等级', detail.includes('等级：7'))
check('详情头衔', detail.includes('头衔：群管'))
check('详情入群时间本地格式', detail.includes('入群时间：2026-01-02 03:04'))
check('详情最后发言本地格式', detail.includes('最后发言：2026-06-01 11:22'))
check('详情禁言至', detail.includes('禁言状态：禁言至 2100-01-05 06:07'))
check('详情标出我自己', formatMemberInfo(info, { selfId: 424242, now }).includes('身份：管理员（我）'))
check('详情非我不标我', !formatMemberInfo(info, { selfId: 999, now }).includes('（我）'))
check('未禁言文案', formatMemberInfo({ ...info, shut_up_timestamp: 0 }, { now }).includes('禁言状态：未被禁言'))
check('禁言已过期文案', formatMemberInfo({ ...info, shut_up_timestamp: tPast }, { now }).includes('禁言状态：未被禁言'))
check('缺时间戳给未知', formatMemberInfo({ user_id: 51 }, { now }).includes('入群时间：未知') && formatMemberInfo({ user_id: 51 }, { now }).includes('最后发言：未知'))
check('时间戳 0 给未知', formatMemberInfo({ user_id: 51, join_time: 0, last_sent_time: 0 }, { now }).includes('入群时间：未知'))
check('详情显示名回落昵称', formatMemberInfo({ user_id: 51, nickname: '只有昵称' }, { now }).includes('显示名：只有昵称'))
check('详情全缺字段兜底', (() => {
  const one = formatMemberInfo({ user_id: 51 }, { now })
  return one.includes('显示名：QQ51') && one.includes('身份：成员') && one.includes('等级：未知') && one.includes('头衔：无')
})(), formatMemberInfo({ user_id: 51 }, { now }).replace(/\n/g, ' | '))
check('详情空对象兜底', formatMemberInfo({}) === '没有查到该成员的信息。', formatMemberInfo({}))
check('详情 null 兜底', formatMemberInfo(null) === '没有查到该成员的信息。')
check('详情 undefined 兜底', formatMemberInfo(undefined) === '没有查到该成员的信息。')
check('详情等级 0 不当作缺失', formatMemberInfo({ user_id: 51, level: 0 }, { now }).includes('等级：0'))

// ---- 命令解析 ----
check('裸 /成员 → 列表', parseMemberQuery('/成员')?.kind === 'list', JSON.stringify(parseMemberQuery('/成员')))
check('/成员列表 → 列表', parseMemberQuery('/成员列表')?.kind === 'list', JSON.stringify(parseMemberQuery('/成员列表')))
check('/成员 列表 → 列表', parseMemberQuery('/成员 列表')?.kind === 'list', JSON.stringify(parseMemberQuery('/成员 列表')))
check('前后空白仍识别', parseMemberQuery('  /成员  ')?.kind === 'list', JSON.stringify(parseMemberQuery('  /成员  ')))
check('@ 优先于后面的文字', parseMemberQuery('/成员 @某人', [10001])?.userId === 10001, JSON.stringify(parseMemberQuery('/成员 @某人', [10001])))
check('at 数字字符串转成数字', parseMemberQuery('/成员 @某人', ['10001'])?.userId === 10001, JSON.stringify(parseMemberQuery('/成员 @某人', ['10001'])))
check('紧贴 @ 也能取 at', parseMemberQuery('/成员@某人', [10001])?.userId === 10001, JSON.stringify(parseMemberQuery('/成员@某人', [10001])))
check('纯数字按 QQ 号查', parseMemberQuery('/成员 123456')?.userId === 123456, JSON.stringify(parseMemberQuery('/成员 123456')))
check('纯数字是 number 类型', typeof parseMemberQuery('/成员 123456')?.userId === 'number')
check('昵称交给调用方匹配', parseMemberQuery('/成员 某个昵称')?.name === '某个昵称', JSON.stringify(parseMemberQuery('/成员 某个昵称')))
check('没有 at 时 @ 被剥掉当昵称', parseMemberQuery('/成员 @某个昵称')?.name === '某个昵称', JSON.stringify(parseMemberQuery('/成员 @某个昵称')))
check('多种空格不误判', parseMemberQuery('/成员\t123456')?.userId === 123456, JSON.stringify(parseMemberQuery('/成员\t123456')))
check('紧贴写法 /成员foo 当昵称 foo', parseMemberQuery('/成员foo')?.name === 'foo', JSON.stringify(parseMemberQuery('/成员foo')))
check('紧贴写法 /成员列表x 当昵称', parseMemberQuery('/成员列表x')?.name === '列表x', JSON.stringify(parseMemberQuery('/成员列表x')))
check('紧贴写法 /成员数 当昵称「数」', parseMemberQuery('/成员数')?.name === '数', JSON.stringify(parseMemberQuery('/成员数')))
check('/成员@ 无目标回落列表', parseMemberQuery('/成员@')?.kind === 'list', JSON.stringify(parseMemberQuery('/成员@')))
check('裸 /成员 + at → 查这个人', parseMemberQuery('/成员', [10001])?.userId === 10001, JSON.stringify(parseMemberQuery('/成员', [10001])))
check('ats 非法时回落文本分支', parseMemberQuery('/成员 某个昵称', ['all'])?.name === '某个昵称', JSON.stringify(parseMemberQuery('/成员 某个昵称', ['all'])))
check('ats 为 0 时回落文本分支', parseMemberQuery('/成员 123456', [0])?.userId === 123456, JSON.stringify(parseMemberQuery('/成员 123456', [0])))
check('ats 非数组不影响', parseMemberQuery('/成员 123456', 'x')?.userId === 123456, JSON.stringify(parseMemberQuery('/成员 123456', 'x')))
check('ats 默认值可用', parseMemberQuery('/成员列表', undefined)?.kind === 'list')
check('非命令文本返回 null', parseMemberQuery('今天天气怎么样') === null)
check('正文里的 /成员 不算命令', parseMemberQuery('你好，用 /成员 看看') === null)
check('/members 不误判', parseMemberQuery('/members') === null)
check('其它斜杠命令不误判', parseMemberQuery('/投票') === null)
check('空文本返回 null', parseMemberQuery('') === null && parseMemberQuery(null) === null && parseMemberQuery(undefined) === null)
check('单个斜杠返回 null', parseMemberQuery('/') === null)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
