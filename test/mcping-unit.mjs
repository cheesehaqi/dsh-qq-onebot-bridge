/** Unit tests for Minecraft Server List Ping encoding/parsing (offline, no real server). */
import { buildHandshake, buildStatusRequest, decodeVarInt, encodeVarInt, formatMcStatus, parseMcAddress, parseStatusJson, pingMcServer } from '../lib/mcping.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// ---------- VarInt ----------
for (const value of [0, 1, 127, 128, 255, 300, 25565, 2097151, 2147483647]) {
  const buf = encodeVarInt(value)
  const back = decodeVarInt(buf, 0)
  check(`VarInt 往返 ${value}`, back.value === value && back.size === buf.length, `value=${back.value} size=${back.size}/${buf.length}`)
}
const negBack = decodeVarInt(encodeVarInt(-1), 0)
check('VarInt 负数往返 -1', negBack.value === -1 && negBack.size === 5, JSON.stringify(negBack))
check('VarInt 0 单字节', encodeVarInt(0).equals(Buffer.from([0x00])))
check('VarInt 127 单字节', encodeVarInt(127).equals(Buffer.from([0x7f])))
check('VarInt 128 双字节', encodeVarInt(128).equals(Buffer.from([0x80, 0x01])))
check('VarInt 255 双字节', encodeVarInt(255).equals(Buffer.from([0xff, 0x01])))
check('VarInt 300 双字节', encodeVarInt(300).equals(Buffer.from([0xac, 0x02])))
check('VarInt 2097151 三字节', encodeVarInt(2097151).equals(Buffer.from([0xff, 0xff, 0x7f])))
check('decode 支持 offset', JSON.stringify(decodeVarInt(Buffer.from([0xff, 0xac, 0x02]), 1)) === JSON.stringify({ value: 300, size: 2 }))
check('decode 截断返回 0', JSON.stringify(decodeVarInt(Buffer.from([0x80]), 0)) === JSON.stringify({ value: 0, size: 0 }))
check('decode 空缓冲返回 0', JSON.stringify(decodeVarInt(Buffer.alloc(0), 0)) === JSON.stringify({ value: 0, size: 0 }))
check('decode 超长返回 0', JSON.stringify(decodeVarInt(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), 0)) === JSON.stringify({ value: 0, size: 0 }))
check('decode 越界 offset 返回 0', decodeVarInt(Buffer.from([0x01]), 5).size === 0)

// ---------- 包结构 ----------
const host = 'mc.example.com'
const handshake = buildHandshake(host, 25565, 47)
const payloadLen = 1 + 1 + 1 + host.length + 2 + 1
check('handshake 长度前缀正确', handshake[0] === payloadLen && handshake.length === payloadLen + 1, `${handshake[0]}/${handshake.length}`)
check('handshake packet id = 0x00', handshake[1] === 0x00)
check('handshake protocol = 47', handshake[2] === 47)
check('handshake host 长度前缀', handshake[3] === host.length)
check('handshake host 内容', handshake.subarray(4, 4 + host.length).toString('utf8') === host)
check('handshake port 大端 uint16', handshake.readUInt16BE(4 + host.length) === 25565)
check('handshake next state = 1', handshake[handshake.length - 1] === 1)
const custom = buildHandshake('1.2.3.4', 25566, 765)
check('handshake 自定义端口/协议', custom.readUInt16BE(custom.length - 3) === 25566 && custom[2] === 0xfd)
const fallback = buildHandshake('1.2.3.4', 99999, 47)
check('handshake 非法端口回落 25565', fallback.readUInt16BE(fallback.length - 3) === 25565)
const statusReq = buildStatusRequest()
check('status request 两字节', statusReq.length === 2 && statusReq[0] === 0x01 && statusReq[1] === 0x00)

// ---------- parseStatusJson ----------
const full = parseStatusJson(JSON.stringify({
  version: { name: '1.20.4', protocol: 765 },
  players: { max: 20, online: 3, sample: [{ name: 'Alex', id: 'a' }, { name: 'Steve', id: 'b' }] },
  description: '欢迎来到服务器',
  favicon: 'data:image/png;base64,AAAA',
}))
check('版本名解析', full.version === '1.20.4')
check('协议号解析', full.protocol === 765)
check('人数上限解析', full.max === 20)
check('在线人数解析', full.online === 3)
check('sample 名字解析', full.sample.length === 2 && full.sample[0] === 'Alex', JSON.stringify(full.sample))
check('字符串 description → motd', full.motd === '欢迎来到服务器', full.motd)
check('favicon 为布尔 true', full.favicon === true)
check('raw 保留原始对象', full.raw?.version?.protocol === 765)

const componenty = parseStatusJson(JSON.stringify({
  version: { name: 'Paper 1.21', protocol: 767 },
  players: { max: 100, online: 42 },
  description: { text: 'A', extra: [{ text: 'B', extra: [{ text: 'C' }] }, 'D'] },
}))
check('{text, extra} 拼接 motd', componenty.motd === 'ABCD', componenty.motd)
check('嵌套 extra 拼接', componenty.motd.length === 4)
check('缺 sample 容错为空数组', Array.isArray(componenty.sample) && componenty.sample.length === 0)
check('缺 favicon 容错为 false', componenty.favicon === false)

const sparse = parseStatusJson('{}')
check('空对象默认值', sparse.version === '' && sparse.protocol === 0 && sparse.max === 0 && sparse.online === 0, JSON.stringify(sparse))
check('空对象 motd 为空串', sparse.motd === '')
const broken = parseStatusJson('这不是 JSON')
check('坏 JSON 不抛异常且 motd 为空', broken.motd === '' && broken.online === 0)
check('非对象 JSON 容错', parseStatusJson('123').motd === '' && parseStatusJson('null').max === 0)
check('description 数字容错', parseStatusJson({ description: 42 }).motd === '42')

// ---------- formatMcStatus ----------
const onlineText = formatMcStatus({ ...full, latencyMs: 37 }, { address: 'mc.example.com:25565' })
check('文案包含在线标记', onlineText.includes('在线') && onlineText.includes('mc.example.com:25565'))
check('文案包含在线人数与上限', onlineText.includes('3/20'), onlineText)
check('文案包含版本', onlineText.includes('1.20.4'))
check('文案包含延迟', onlineText.includes('37 ms'))
check('文案包含 MOTD', onlineText.includes('欢迎来到服务器'))
check('文案包含玩家列表', onlineText.includes('Alex') && onlineText.includes('Steve'))
const offlineText = formatMcStatus({ online: false, error: '连接超时，服务器无响应' }, { address: 'mc.example.com' })
check('离线文案包含离线与原因', offlineText.includes('离线') && offlineText.includes('连接超时，服务器无响应'), offlineText.replace(/\n/g, ' | '))
check('离线文案无在线人数行', !offlineText.includes('在线人数'))
check('空结果不抛异常', typeof formatMcStatus(undefined) === 'string' && formatMcStatus(undefined).includes('离线'))
check('超长玩家列表被截断', formatMcStatus({ online: 1, max: 10, sample: ['a', 'b', 'c', 'd', 'e', 'f'] }).includes('等 6 人'))
check('ping 结果形状可用（players）', formatMcStatus({ online: true, players: { online: 7, max: 9 }, version: '1.20.4', latencyMs: 12 }).includes('7/9'))
check('零人在线仍视为在线', formatMcStatus({ online: 0, max: 10 }).includes('0/10'))

// ---------- parseMcAddress ----------
const bare = parseMcAddress('mc.example.com')
check('裸域名默认端口', bare?.host === 'mc.example.com' && bare?.port === 25565, JSON.stringify(bare))
const withPort = parseMcAddress('mc.example.com:25566')
check('域名带端口', withPort?.host === 'mc.example.com' && withPort?.port === 25566, JSON.stringify(withPort))
const cmd = parseMcAddress('/mc 1.2.3.4:25565')
check('/mc 前缀整句', cmd?.host === '1.2.3.4' && cmd?.port === 25565, JSON.stringify(cmd))
const cmdStatus = parseMcAddress('mcstatus mc.example.com:25566')
check('mcstatus 前缀整句', cmdStatus?.host === 'mc.example.com' && cmdStatus?.port === 25566, JSON.stringify(cmdStatus))
check('/mcstatus 前缀', parseMcAddress('/mcstatus example.org')?.host === 'example.org')
check('mc 前缀 + 空格端口写法', parseMcAddress('mc 1.2.3.4')?.port === 25565)
check('带尾随标点容错', parseMcAddress('/mc mc.example.com:25565。')?.port === 25565)
check('端口 1 合法', parseMcAddress('host.local:1')?.port === 1)
check('端口 65535 合法', parseMcAddress('host.local:65535')?.port === 65535)
check('空文本返回 null', parseMcAddress('') === null && parseMcAddress('   ') === null && parseMcAddress(undefined) === null)
check('只有命令返回 null', parseMcAddress('/mc') === null && parseMcAddress('mcstatus') === null)
check('空 host 返回 null', parseMcAddress(':25565') === null)
check('端口 0 非法', parseMcAddress('mc.example.com:0') === null)
check('端口超范围非法', parseMcAddress('mc.example.com:70000') === null)
check('端口非数字非法', parseMcAddress('mc.example.com:abc') === null)
check('冒号后无端口非法', parseMcAddress('mc.example.com:') === null)
check('IPv6 方括号写法', parseMcAddress('[::1]:25565')?.host === '::1')

// ---------- pingMcServer（离线端口，绝不联网成功） ----------
let pingError = ''
let refused = null
try { refused = await pingMcServer('127.0.0.1', 1, 300) } catch (err) { pingError = String(err) }
check('ping 不抛异常', pingError === '', pingError)
check('无人监听端口 online=false', refused?.online === false, JSON.stringify(refused))
check('离线 error 为中文短句', /[\u4e00-\u9fa5]/.test(refused?.error ?? ''), refused?.error)
check('离线 latencyMs 为非负数字', typeof refused?.latencyMs === 'number' && refused.latencyMs >= 0, String(refused?.latencyMs))
check('离线结果字段与在线一致', typeof refused?.version === 'string' && Array.isArray(refused?.sample) && refused?.favicon === false && refused?.max === 0)
const emptyHost = await pingMcServer('   ', 25565, 200)
check('空地址直接返回中文错误', emptyHost.online === false && emptyHost.error.includes('地址为空'), JSON.stringify(emptyHost))
const badPort = await pingMcServer('mc.example.com', 70000, 200)
check('非法端口直接返回中文错误', badPort.online === false && badPort.error.includes('端口'), JSON.stringify(badPort))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
