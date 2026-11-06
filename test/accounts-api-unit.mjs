/**
 * 账号中心：v0.8.3~v0.8.4 新增接口的契约测试（真起 control 服务，临时目录当 config）。
 * 覆盖：files（含子目录与越界拒绝）/ backups / trash / napcat-config（脱敏）/
 *       console / release / ports / netcheck。
 * 目标：这些接口以前只有"手工点一遍"，没有自动回归。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createControlServer } from '../control/lib/server.mjs'
import { createAccountsApi } from '../control/lib/accounts.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (value) => JSON.stringify(value ?? null).slice(0, 200)

const dir = mkdtempSync(join(tmpdir(), 'qq-accounts-api-'))
const configDir = join(dir, 'config')
mkdirSync(configDir, { recursive: true })
const webuiFile = join(configDir, 'webui.json')
writeFileSync(webuiFile, JSON.stringify({ host: '127.0.0.1', port: 1, token: 'testtoken123', autoLoginAccount: '' }), 'utf8')

// 账号配置：带 WS 客户端 / WS 服务器 / HTTP 服务器，供 ports 用
writeFileSync(join(configDir, 'onebot11_123456789.json'), JSON.stringify({
  network: {
    websocketClients: [{ name: 'bridge', url: 'ws://127.0.0.1:6700/', enable: true }],
    websocketServers: [{ name: 'ws-srv', port: 3001, host: '0.0.0.0', enable: true }],
    httpServers: [{ name: 'http-srv', port: 3000, host: '', enable: true }],
  },
}), 'utf8')
writeFileSync(join(configDir, 'lastbak.json'), '{"old":true}', 'utf8')
writeFileSync(join(configDir, 'lastbak.json.bak-2026-01-01T00-00-00'), '{"old":false}', 'utf8')
mkdirSync(join(configDir, 'plugins'), { recursive: true })
writeFileSync(join(configDir, 'plugins', 'hello.txt'), 'hi', 'utf8')
writeFileSync(join(configDir, 'napcat.json'), JSON.stringify({
  musicSignUrl: '',
  token: 'super-secret-token',
  apiKey: 'k-123',
  nested: { a: 1, b: 2 },
  list: [1, 2, 3],
  flag: true,
}), 'utf8')

// 假 netstat / tasklist：只报 6700 在监听
const fakeExec = (command, args) => {
  if (command === 'netstat') {
    return [
      '  TCP    127.0.0.1:6700    0.0.0.0:0    LISTENING    4242',
      '  TCP    127.0.0.1:3001    0.0.0.0:0    ESTABLISHED  4242',
    ].join('\n')
  }
  if (command === 'tasklist') return '"node.exe","4242","Console","1","10,000 K"\n'
  return ''
}

const realAccounts = createAccountsApi({ webUiFile: webuiFile })
const api = {
  accounts: {
    ...realAccounts,
    // 版本检查走假数据，避免测试联网
    async latestRelease() {
      return { ok: true, current: '0.8.4', latest: '0.8.4', newer: false, url: 'https://example.invalid/v0.8.4', publishedAt: '', name: '' }
    },
    // 端口占用注入假 netstat/tasklist
    portStatus: () => realAccounts.portStatus({ exec: fakeExec }),
  },
  traceChain(traceId) {
    // 真控制台用 events 里同一 traceId 的事件拼链路；测试只需形状
    return traceId === 't-untraced'
      ? [{ at: '2026-11-06T00:00:00.000Z', stage: 'inject', ok: true, reason: '测试' }]
      : []
  },
  async status() { return { ok: true, ports: [], processes: [], runtime: null } },
  async diagnose() { return { ok: true } },
  async qr() { return { exists: false } },
  async napcatWebui() { return { ok: true, url: 'http://127.0.0.1:6099/webui/?token=x' } },
  async startHost() { return { ok: true, reason: '' } },
  async stopHost() { return { ok: true, reason: '' } },
  async startNapcat() { return { ok: true, reason: '' } },
  async stopNapcat() { return { ok: true, reason: '' } },
  async startTts() { return { ok: true, reason: '' } },
  async stopTts() { return { ok: true, reason: '' } },
  async stopAll() { return { ok: true, reason: '' } },
  async freePort() { return { ok: true, reason: '' } },
}

const TOKEN = 'api-token'
const server = createControlServer({
  config: { ports: { control: 0 }, napcatBat: 'C:/x/bootmain/launcher.bat' },
  token: TOKEN,
  api,
  ui: '<!doctype html><title>ui</title>',
  accountsUi: '<!doctype html><title>accounts</title>',
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const get = async (path) => {
  const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}`)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = null }
  return { status: res.status, body, text }
}
const post = async (path, payload) => {
  const res = await fetch(`${base}${path}?token=${TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// ---------- files ----------
{
  const root = await get('/api/accounts/files')
  check('files：根目录能列出来', root.body?.ok === true && root.body.entries.length > 0 && root.body.rel === '', brief(root.body?.rel))
  const sub = await get('/api/accounts/files?rel=plugins')
  check('files：子目录能列出来', sub.body?.ok === true && sub.body.rel === 'plugins' && sub.body.entries.some((e) => e.name === 'hello.txt'), brief(sub.body?.entries))
  const dotdot = await get('/api/accounts/files?rel=..')
  check('files：.. 被拒绝（不越出 config）', dotdot.body?.ok === false && String(dotdot.body?.message).includes('..'), brief(dotdot.body))
  const abs = await get('/api/accounts/files?rel=' + encodeURIComponent('/etc/passwd'))
  check('files：绝对路径被拒绝', abs.body?.ok === false, brief(abs.body))
  const missing = await get('/api/accounts/files?rel=nope')
  check('files：不存在的子目录如实报错（不是空列表）', missing.body?.ok === false && typeof missing.body?.message === 'string', brief(missing.body))
}

// ---------- backups ----------
{
  const list = await get('/api/accounts/backups')
  check('backups：列出 .bak-* 并带 base/stamp', list.body?.ok === true
    && list.body.backups.some((item) => item.name === 'lastbak.json.bak-2026-01-01T00-00-00' && item.base === 'lastbak.json'), brief(list.body?.backups))
  const restore = await post('/api/accounts/backups/restore', { name: 'lastbak.json.bak-2026-01-01T00-00-00' })
  check('backups：还原后原文件内容被覆盖，并留了 .pre-restore-*', restore.body?.ok === true, brief(restore.body))
  const names = readdirSync(configDir)
  check('backups：还原前另存了 .pre-restore-*', names.some((name) => name.includes('.pre-restore-')), names.join(','))
  const bad = await post('/api/accounts/backups/restore', { name: '../etc/passwd' })
  check('backups：越界文件名被拒绝', bad.body?.ok === false, brief(bad.body))
}

// ---------- trash ----------
{
  const move = await post('/api/accounts/backups/trash', { name: 'lastbak.json.bak-2026-01-01T00-00-00' })
  check('trash：删除备份是移进 _trash（不是硬删）', move.body?.ok === true, brief(move.body))
  const list = await get('/api/accounts/trash')
  check('trash：能列出回收站里的文件', list.body?.ok === true && list.body.entries.length >= 1, brief(list.body?.entries))
  const rel = list.body?.entries?.[0]?.rel ?? ''
  const restore = await post('/api/accounts/trash/restore', { rel })
  check('trash：能从回收站还原', restore.body?.ok === true, brief(restore.body))
  const after = await get('/api/accounts/trash')
  check('trash：还原后回收站少一份', (after.body?.entries ?? []).length < list.body.entries.length, `${list.body.entries.length} → ${(after.body?.entries ?? []).length}`)
}

// ---------- trash/purge-old（批量清理）----------
{
  const bad0 = await post('/api/accounts/trash/purge-old', { days: 0 })
  const badBig = await post('/api/accounts/trash/purge-old', { days: 400 })
  check('purge-old：天数为 0 或过大一律拒绝（不静默退回默认值）',
    bad0.body?.ok === false && badBig.body?.ok === false
    && String(bad0.body?.message).includes('1–365'), brief([bad0.body, badBig.body]))
  const def = await post('/api/accounts/trash/purge-old', {})
  check('purge-old：不传 days 时按默认 7 天（空回收站也算成功）',
    def.body?.ok === true && def.body.purged === 0, brief(def.body))
}

// ---------- trace 链路 ----------
{
  const res = await get('/api/trace?traceId=t-untraced')
  check('trace：给 traceId 时返回 chain 数组（没有事件就是空数组）',
    res.body?.ok === true && Array.isArray(res.body.chain), brief(res.body))
  const missing = await get('/api/trace?traceId=t-does-not-exist')
  check('trace：不存在的 traceId 也返回空数组而不是报错',
    missing.body?.ok === true && Array.isArray(missing.body.chain) && missing.body.chain.length === 0, brief(missing.body))
}

// ---------- napcat-config（脱敏）----------
{
  const res = await get('/api/accounts/napcat-config')
  const entries = res.body?.entries ?? []
  const token = entries.find((item) => item.key === 'token')
  const apiKey = entries.find((item) => item.key === 'apiKey')
  const nested = entries.find((item) => item.key === 'nested')
  const list = entries.find((item) => item.key === 'list')
  check('napcat-config：只回顶层键值', res.body?.ok === true && entries.length === 6, brief(entries.map((e) => e.key)))
  check('★napcat-config：token/gateway 类键一律隐藏', token?.shown === '（已隐藏）' && apiKey?.shown === '（已隐藏）', brief([token, apiKey]))
  check('napcat-config：对象/数组只给摘要', nested?.shown === '{对象 2 键}' && list?.shown === '[数组 3 项]', brief([nested, list]))
  check('napcat-config：不泄露原始密钥', !res.text.includes('super-secret-token') && !res.text.includes('k-123'))
}

// ---------- console ----------
{
  const res = await get('/api/accounts/console')
  check('console：返回版本 / node / pid / 端口', res.body?.ok === true
    && /^\d+\.\d+\.\d+/.test(String(res.body.version))
    && String(res.body.node).startsWith('v')
    && typeof res.body.pid === 'number'
    && res.body.port === 0, brief(res.body))
}

// ---------- release ----------
{
  const res = await get('/api/accounts/release')
  check('release：返回当前/最新/是否更新', res.body?.ok === true
    && res.body.current === '0.8.4' && res.body.latest === '0.8.4' && res.body.newer === false, brief(res.body))
}

// ---------- ports ----------
{
  const res = await get('/api/accounts/ports')
  const rows = res.body?.ports ?? []
  const ws = rows.find((row) => row.port === 6700)
  const srv = rows.find((row) => row.port === 3001)
  check('ports：配置里的端口都出现', res.body?.ok === true && rows.length === 3, brief(rows.map((r) => r.port)))
  check('ports：监听中的端口带进程名', ws?.listening === true && ws?.process === 'node.exe', brief(ws))
  check('ports：未监听的端口如实标 false', srv?.listening === false, brief(srv))
}

// ---------- netcheck ----------
{
  const self = await post('/api/accounts/netcheck', { host: '127.0.0.1', port })
  check('netcheck：连本机在监听的口 → ok + 有耗时', self.body?.ok === true && typeof self.body.latencyMs === 'number', brief(self.body))

  // 找一个确定关着的端口：先 listen 再 close
  const probe = createServer(() => {})
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const closedPort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const closed = await post('/api/accounts/netcheck', { host: '127.0.0.1', port: closedPort, timeoutMs: 800 })
  check('netcheck：关着的端口 → ok:false 且带原因', closed.body?.ok === false && typeof closed.body.message === 'string', brief(closed.body))

  const badPort = await post('/api/accounts/netcheck', { host: '127.0.0.1', port: 0 })
  check('netcheck：非法端口被拒绝', badPort.body?.ok === false && String(badPort.body.message).includes('端口'), brief(badPort.body))
  const badHost = await post('/api/accounts/netcheck', { host: 'bad host!', port: 80 })
  check('netcheck：非法主机名被拒绝', badHost.body?.ok === false, brief(badHost.body))

  const noToken = await fetch(`${base}/api/accounts/netcheck`, { method: 'POST', body: '{}' })
  check('netcheck：没 token 一律 401', noToken.status === 401, String(noToken.status))
}

server.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
