/**
 * 账号中心（控制台本地网站）端到端：真起一个 control 服务，用假 NapCat 当上游。
 *   ① /accounts 能打开（静态页）
 *   ② /api/accounts 概览带账号清单、不带 token
 *   ③ /api/accounts/status 走真链路（假 NapCat 返回 envelope）
 *   ④ /api/accounts/qr /quick 同理
 *   ⑤ POST quick-login / auto 有参数校验与写回
 *   ⑥ 没 token / 跨站 Origin 一律拒绝
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlServer } from '../control/lib/server.mjs'
import { createAccountsApi, hashWebUiToken } from '../control/lib/accounts.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (value) => JSON.stringify(value ?? null).slice(0, 220)

const dir = mkdtempSync(join(tmpdir(), 'qq-accounts-http-'))
const configDir = join(dir, 'config')
mkdirSync(configDir, { recursive: true })
const webuiFile = join(configDir, 'webui.json')
writeFileSync(webuiFile, JSON.stringify({ host: '::', port: 0, token: 'testtoken123', autoLoginAccount: '' }), 'utf8')
writeFileSync(join(configDir, 'onebot11_123456789.json'), '{}', 'utf8')
writeFileSync(join(configDir, 'napcat_123456789.json'), '{}', 'utf8')

// ---- 假 NapCat WebUI ----
let napcatPort = 0
let credential = ''
const napcatCalls = []
const napcat = createHttpServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const path = new URL(request.url, 'http://x').pathname
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    napcatCalls.push({ path, method: request.method, body })
    const send = (payload) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)) }
    if (path === '/api/auth/login') {
      if (body?.hash !== hashWebUiToken('testtoken123')) return send({ code: -1, message: 'token is invalid' })
      credential = 'cred-x'
      return send({ code: 0, message: 'success', data: { Credential: credential } })
    }
    if ((request.headers.authorization ?? '') !== `Bearer ${credential}`) return send({ code: -1, message: 'Unauthorized' })
    if (path === '/api/QQLogin/CheckLoginStatus') return send({ code: 0, message: 'success', data: { isLogin: true, isOffline: false } })
    if (path === '/api/QQLogin/GetQQLoginQrcode') return send({ code: 0, message: 'success', data: { qrcode: 'https://qrcode.example/abc' } })
    if (path === '/api/QQLogin/GetQuickLoginList') return send({ code: 0, message: 'success', data: ['123456789'] })
    if (path === '/api/QQLogin/SetQuickLoginQQ') return send({ code: 0, message: 'success', data: null })
    if (path === '/api/QQLogin/SetQuickLogin') return send({ code: 0, message: 'success', data: null })
    return send({ code: -1, message: `unknown ${path}` })
  })
})
await new Promise((resolve) => napcat.listen(0, '127.0.0.1', resolve))
napcatPort = napcat.address().port
writeFileSync(webuiFile, JSON.stringify({ host: '127.0.0.1', port: napcatPort, token: 'testtoken123', autoLoginAccount: '' }), 'utf8')

// ---- control 服务（用假 api，只装 accounts）----
const TOKEN = 'control-token'
const api = {
  accounts: createAccountsApi({ webUiFile: webuiFile }),
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
const server = createControlServer({
  config: { ports: { control: 0 }, napcatBat: 'C:/x/bootmain/launcher.bat' },
  token: TOKEN,
  api,
  ui: '<!doctype html><title>ui</title>',
  accountsUi: '<!doctype html><title>accounts</title>账号中心',
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const get = async (path, headers = {}) => {
  const res = await fetch(`${base}${path}`, { headers })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = null }
  return { status: res.status, text, body }
}
const post = async (path, payload, headers = {}) => {
  const res = await fetch(`${base}${path}?token=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// ① 页面
{
  const page = await get('/accounts')
  check('★/accounts 能打开（本地页面）', page.status === 200 && page.text.includes('账号中心'), `HTTP ${page.status}`)
  check('页面里没有 webui token 明文', !page.text.includes('testtoken123'))
}

// ⑥ 鉴权
{
  const noToken = await get('/api/accounts')
  check('★没有 control token → 401', noToken.status === 401, `HTTP ${noToken.status}`)
  const crossSite = await get(`/api/accounts?token=${TOKEN}`, { origin: 'https://evil.example' })
  check('★跨站 Origin → 403（拒绝 CSRF）', crossSite.status === 403, `HTTP ${crossSite.status}`)
}

// ② 概览
{
  const summary = await get(`/api/accounts?token=${TOKEN}`)
  check('★概览：ok + 账号清单 + token 打码', summary.body?.ok === true
    && summary.body.accounts.length === 1 && summary.body.accounts[0].uin === '123456789'
    && summary.body.webui.tokenMasked.includes('…')
    && !JSON.stringify(summary.body).includes('testtoken123'), brief(summary.body?.webui))
}

// ③④ 代理
{
  const status = await get(`/api/accounts/status?token=${TOKEN}`)
  check('★/api/accounts/status 走通假 NapCat（登录/凭证/查询）', status.body?.ok === true && status.body.data.isLogin === true, brief(status.body))
  check('假 NapCat 收到的是 auth/login + CheckLoginStatus 两条', napcatCalls.some((c) => c.path === '/api/auth/login') && napcatCalls.some((c) => c.path === '/api/QQLogin/CheckLoginStatus'),
    napcatCalls.map((c) => c.path).join(' → '))
  const qr = await get(`/api/accounts/qr?token=${TOKEN}`)
  check('/api/accounts/qr 返回二维码 URL', qr.body?.ok === true && qr.body.data.qrcode === 'https://qrcode.example/abc', brief(qr.body))
  const quick = await get(`/api/accounts/quick?token=${TOKEN}`)
  check('/api/accounts/quick 返回快速登录列表', quick.body?.ok === true && quick.body.data[0] === '123456789', brief(quick.body))
}

// ⑤ 写操作
{
  const bad = await post('/api/accounts/quick-login', { uin: 'abc' })
  check('★QQ 号格式不对时拒绝（不去打接口）', bad.body?.ok === false && /格式/.test(bad.body.message), brief(bad.body))
  const good = await post('/api/accounts/quick-login', { uin: '123456789' })
  check('★合法 QQ 号 → 调 NapCat SetQuickLogin', good.body?.ok === true && napcatCalls.some((c) => c.path === '/api/QQLogin/SetQuickLogin' && c.body?.uin === '123456789'), brief(good.body))
  const auto = await post('/api/accounts/auto', { uin: '123456789' })
  check('★设自动登录 → 调 SetQuickLoginQQ', auto.body?.ok === true && napcatCalls.some((c) => c.path === '/api/QQLogin/SetQuickLoginQQ' && c.body?.uin === '123456789'), brief(auto.body))
}

// NapCat 挂掉时
{
  await new Promise((resolve) => napcat.close(resolve))
  const down = await get(`/api/accounts/status?token=${TOKEN}`)
  check('★NapCat 关了：如实说"连不上"，不 500', down.status === 200 && down.body?.ok === false && down.body.kind === 'unreachable', brief(down.body))
}

server.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
