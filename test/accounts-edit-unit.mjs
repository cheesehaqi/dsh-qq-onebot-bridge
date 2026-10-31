/**
 * 网络配置编辑单测（唯一会写 NapCat 文件的入口，所以重点测"不乱写"）：
 *   ① 校验：URL 协议、条数、长度、端口范围、QQ 号格式
 *   ② 备份：写之前一定生成 .bak-*，且原文件其它字段原样保留
 *   ③ 失败路径：非 JSON / 文件不存在 / 备份失败 → 都不写
 *   ④ 写回内容：clients 结构与 NapCat 期望的一致
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountsApi } from '../control/lib/accounts.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-netedit-'))
const configDir = join(dir, 'config')
mkdirSync(configDir, { recursive: true })
const webuiFile = join(configDir, 'webui.json')
writeFileSync(webuiFile, JSON.stringify({ host: '127.0.0.1', port: 6099, token: 't0k' }), 'utf8')

const uin = '123456789'
const onebotFile = join(configDir, `onebot11_${uin}.json`)
const original = {
  network: {
    websocketServers: [{ name: 'ws-server', enable: true, host: '0.0.0.0', port: 3001, messagePostFormat: 'array', token: '', debug: false, heartInterval: 30000, reportSelfMessage: false }],
    websocketClients: [{ url: 'ws://127.0.0.1:6700', reportSelfMessage: false, token: '', messagePostFormat: 'array', debug: false, heartInterval: 30000 }],
  },
  musicSignUrl: '',
  enableLocalFile2Url: false,
  parseMultMsg: false,
}
writeFileSync(onebotFile, JSON.stringify(original, null, 2), 'utf8')

const api = createAccountsApi({ webUiFile: webuiFile })

// ① 校验
const badUin = api.updateNetwork({ uin: 'abc' })
check('QQ 号格式不对 → 拒绝', badUin.ok === false && badUin.kind === 'bad-input', badUin.message)
const badProto = api.updateNetwork({ uin, clients: ['http://127.0.0.1:6700'] })
check('★非 ws:// 地址 → 拒绝（不写任何东西）', badProto.ok === false && /ws:\/\/|wss:\/\//.test(badProto.message), badProto.message)
const tooMany = api.updateNetwork({ uin, clients: Array.from({ length: 9 }, (_, i) => `ws://127.0.0.1:${6700 + i}`) })
check('超过 8 条 → 拒绝', tooMany.ok === false && /最多 8 条/.test(tooMany.message))
const badPort = api.updateNetwork({ uin, serverPort: 70000 })
check('端口越界 → 拒绝', badPort.ok === false && /1–65535/.test(badPort.message))
check('以上都被拒绝后，原文件没被改动', JSON.parse(readFileSync(onebotFile, 'utf8')).network.websocketClients[0].url === 'ws://127.0.0.1:6700')

// ② 正常写入
const saved = api.updateNetwork({ uin, clients: ['ws://127.0.0.1:6700', 'wss://example.com/onebot'], serverPort: 3002, now: () => Date.UTC(2026, 9, 31, 22, 30, 0) })
check('★合法输入 → 写入成功且要求重启', saved.ok === true && saved.requiresRestart === true, saved.message)
check('★写前有备份文件', typeof saved.backup === 'string' && existsSync(saved.backup), saved.backup)
const backups = readdirSync(configDir).filter((name) => name.includes('.bak-'))
check('备份只有一个（没有重复乱写）', backups.length === 1, backups.join(','))
const after = JSON.parse(readFileSync(onebotFile, 'utf8'))
check('★clients 写成了两条、协议正确', after.network.websocketClients.length === 2
  && after.network.websocketClients[1].url === 'wss://example.com/onebot'
  && after.network.websocketClients[0].enable === true, JSON.stringify(after.network.websocketClients.map((c) => c.url)))
check('★其它字段原样保留（musicSignUrl / parseMultMsg 不动）',
  after.musicSignUrl === original.musicSignUrl && after.parseMultMsg === original.parseMultMsg)
check('端口改到 3002，其余 server 字段保留', after.network.websocketServers[0].port === 3002 && after.network.websocketServers[0].name === 'ws-server')
check('返回值里带 before/after 便于界面回显', saved.before.clients.length === 1 && saved.after.serverPort === 3002, JSON.stringify(saved.before))
check('备份内容 = 改动前的原文', JSON.parse(readFileSync(saved.backup, 'utf8')).network.websocketClients[0].url === 'ws://127.0.0.1:6700')

// ③ 失败路径
writeFileSync(join(configDir, 'onebot11_987654321.json'), '{ 这不是 JSON', 'utf8')
const broken = api.updateNetwork({ uin: '987654321', clients: ['ws://127.0.0.1:6700'] })
check('★配置不是合法 JSON → 拒绝且不覆盖', broken.ok === false && /不是合法 JSON/.test(broken.message), broken.message)
const missing = api.updateNetwork({ uin: '111111111', clients: ['ws://127.0.0.1:6700'] })
check('账号文件不存在 → 拒绝', missing.ok === false && missing.kind === 'not-found')

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
