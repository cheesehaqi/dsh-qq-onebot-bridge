/**
 * 账号中心：老接口的契约测试（第二组）。
 * 覆盖：meta / info / sys / guid / about / plugins / network / logs / logs/live / stats /
 *       qr-image / avatar / open-folder。
 * 目标：这 13 个路由以前没有任何自动回归，靠手工点。
 * 做法：起真 control 服务，把 api.accounts 换成确定性 stub（不联网、不起进程），逐个验契约：
 *       ① 200 + ok 字段透传 ② 没 token 一律 401 ③ 特别的分支（图片二进制、路径回退、SSE 拒绝）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlServer } from '../control/lib/server.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (value) => JSON.stringify(value ?? null).slice(0, 200)

const dir = mkdtempSync(join(tmpdir(), 'qq-accounts-api2-'))
const configDir = join(dir, 'config')
mkdirSync(configDir, { recursive: true })
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
const qrFile = join(dir, 'qr.png')
writeFileSync(qrFile, png)

const TOKEN = 'api2-token'
const api = {
  accounts: {
    async meta() {
      return { ok: true, kind: 'ok', webui: { exists: true, port: 6099 }, accounts: [{ uin: '123456789' }], autoLoginAccount: '' }
    },
    async loginInfo() { return { ok: true, kind: 'ok', data: { uin: '123456789', nick: '测试号' } } },
    async sys() { return { ok: true, kind: 'ok', data: { cpu: 1, mem: 2 } } },
    async guidBackups() { return { ok: true, kind: 'ok', data: { backups: [] } } },
    async about() { return { ok: true, kind: 'ok', data: { hash: 'abc', latest: '0.8.4', mirrors: [] } } },
    async plugins() { return { ok: true, kind: 'ok', data: { plugins: [] }, tree: { exists: true, entries: [{ name: '_downloads', isDir: true }] } } },
    network() { return { ok: true, kind: 'ok', dir: configDir, accounts: [{ uin: '123456789', clients: [], servers: [], https: [] }] } },
    async logs() { return { ok: true, kind: 'ok', data: [] } },
    async logLive() { return { ok: false, kind: 'unreachable', message: 'NapCat 没在运行' } },
    async avatar(uin) {
      if (String(uin) === '') return { ok: false, message: '缺 uin' }
      return { ok: true, buffer: png, contentType: 'image/png' }
    },
    configDir() { return '' },
  },
  async status() { return { ok: true, ports: [], processes: [], runtime: null } },
  async traceStats() { return { ok: true, total: 0, byStage: [] } },
  napcatQrFile() { return qrFile },
  async diagnose() { return { ok: true } },
  async qr() { return { exists: false } },
  async napcatWebui() { return { ok: true, url: 'http://127.0.0.1:6099/webui/?token=x' } },
  async startHost() { return { ok: true } }, async stopHost() { return { ok: true } },
  async startNapcat() { return { ok: true } }, async stopNapcat() { return { ok: true } },
  async startTts() { return { ok: true } }, async stopTts() { return { ok: true } },
  async stopAll() { return { ok: true } }, async freePort() { return { ok: true } },
}

const server = createControlServer({
  config: { ports: { control: 0 }, napcatBat: '' },
  token: TOKEN,
  api,
  ui: '<!doctype html><title>ui</title>',
  accountsUi: '<!doctype html><title>accounts</title>',
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
const withToken = (path) => `${base}${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}`

const getJson = async (path) => {
  const res = await fetch(withToken(path))
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = null }
  return { status: res.status, body, text }
}

// ---------- JSON 透传类 ----------
{
  const meta = await getJson('/api/accounts/meta')
  check('meta：透传 webui/accounts/autoLoginAccount', meta.status === 200 && meta.body?.ok === true
    && meta.body.webui?.port === 6099 && meta.body.accounts.length === 1, brief(meta.body))

  const info = await getJson('/api/accounts/info')
  check('info：透传登录号与昵称', info.body?.ok === true && info.body.data?.uin === '123456789', brief(info.body))

  const sys = await getJson('/api/accounts/sys')
  check('sys：透传系统状态', sys.body?.ok === true && sys.body.data?.cpu === 1, brief(sys.body))

  const guid = await getJson('/api/accounts/guid')
  check('guid：透传备份列表', guid.body?.ok === true && Array.isArray(guid.body.data?.backups), brief(guid.body))

  const about = await getJson('/api/accounts/about')
  check('about：透传哈希/最新版/镜像', about.body?.ok === true && about.body.data?.hash === 'abc', brief(about.body))

  const plugins = await getJson('/api/accounts/plugins')
  check('plugins：同时带列表与目录结构', plugins.body?.ok === true && plugins.body.tree?.exists === true, brief(plugins.body))

  const network = await getJson('/api/accounts/network')
  check('network：带 dir 与账号行', network.body?.ok === true && network.body.dir === configDir && network.body.accounts.length === 1, brief(network.body))

  const logs = await getJson('/api/accounts/logs')
  check('logs：能返回文件列表（空也算成功）', logs.body?.ok === true && Array.isArray(logs.body.data), brief(logs.body))

  const stats = await getJson('/api/accounts/stats')
  check('stats：走 traceStats 并透传', stats.body?.ok === true && stats.body.total === 0, brief(stats.body))
}

// ---------- 特殊分支 ----------
{
  const live = await getJson('/api/accounts/logs/live')
  check('logs/live：NapCat 没运行时不 500，如实报原因', live.body?.ok === false && String(live.body.message).includes('NapCat'), brief(live.body))

  const image = await fetch(withToken('/api/accounts/qr-image'))
  const bytes = Buffer.from(await image.arrayBuffer())
  check('qr-image：返回真 PNG 字节与 image/png', image.status === 200
    && image.headers.get('content-type') === 'image/png'
    && bytes.length === png.length && bytes[0] === 0x89, `${bytes.length}B ${image.headers.get('content-type')}`)

  const avatar = await fetch(withToken('/api/accounts/avatar?uin=123456789'))
  const avatarBytes = Buffer.from(await avatar.arrayBuffer())
  check('avatar：返回图片字节与 1 小时缓存头', avatar.status === 200 && avatarBytes.length === png.length
    && String(avatar.headers.get('cache-control')).includes('max-age=3600'), `${avatarBytes.length}B`)

  const noUin = await getJson('/api/accounts/avatar')
  check('avatar：缺 uin 时如实报错（不返回空图）', noUin.body?.ok === false, brief(noUin.body))

  // open-folder 的成功路径会真的弹资源管理器窗口（有副作用），这里只验"拿不到目录时如实报错"。
  // 拿不到目录的分支在 server.mjs 里是 `dir === ''` 早退，不会走到 spawn。
  const folder = await getJson('/api/accounts/open-folder')
  check('open-folder：拿不到 config 目录时如实报错（不 spawn 外部程序）', folder.body?.ok === false
    && String(folder.body.reason).includes('config'), brief(folder.body))
}

// ---------- 鉴权 ----------
{
  const targets = ['/api/accounts/meta', '/api/accounts/info', '/api/accounts/sys', '/api/accounts/guid',
    '/api/accounts/about', '/api/accounts/plugins', '/api/accounts/network', '/api/accounts/logs',
    '/api/accounts/stats', '/api/accounts/qr-image', '/api/accounts/avatar']
  const open = []
  for (const path of targets) {
    const res = await fetch(`${base}${path}`)
    if (res.status !== 401) open.push(`${path}=${res.status}`)
  }
  check('★鉴权：这 11 个接口没 token 全部 401', open.length === 0, open.join(', '))
}

server.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
