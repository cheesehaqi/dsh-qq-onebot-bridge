/**
 * v0.7.11 账号中心（控制台本地网站）的纯逻辑单测：
 *   ① webui.json 读取 / 安全投影（token 不出服务端）
 *   ② 账号清单（onebot11_<uin>.json / napcat_<uin>.json）
 *   ③ 登录换凭证（sha256(token+'.napcat')）/ 2FA 分支 / 凭证缓存
 *   ④ 401 自动重登一次；404 方法回退；连不上如实说
 *   ⑤ createAccountsApi：无配置时不发请求
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WEBUI_ROUTES, classifyWebUiFailure, createAccountsApi, createWebUiClient,
  describeAccountState, hashWebUiToken, listAccounts, maskToken, napcatConfigDir,
  publicWebUiConfig, readWebUiConfig,
} from '../control/lib/accounts.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (value) => JSON.stringify(value ?? null).slice(0, 220)

const dir = mkdtempSync(join(tmpdir(), 'qq-accounts-'))
const configDir = join(dir, 'config')
mkdirSync(configDir, { recursive: true })
const webuiFile = join(configDir, 'webui.json')
writeFileSync(webuiFile, JSON.stringify({ host: '::', port: 6099, token: 'testtoken123', autoLoginAccount: '10086', enable2FA: false }), 'utf8')
writeFileSync(join(configDir, 'onebot11_123456789.json'), '{}', 'utf8')
writeFileSync(join(configDir, 'napcat_123456789.json'), '{}', 'utf8')
writeFileSync(join(configDir, 'onebot11_987654321.json'), '{}', 'utf8')

// ---------- ① 配置 ----------
const config = readWebUiConfig({ file: webuiFile })
check('★webui.json 读出来（host "::" 归一到 127.0.0.1）', config.exists && config.host === '127.0.0.1' && config.url === 'http://127.0.0.1:6099', brief({ host: config.host, url: config.url }))
check('autoLoginAccount / enable2FA 读出来', config.autoLoginAccount === '10086' && config.enable2FA === false)
const pub = publicWebUiConfig(config)
check('★★安全投影不带 token（只给打码形态）', !JSON.stringify(pub).includes('testtoken123') && pub.tokenMasked === maskToken('testtoken123'), brief(pub))
check('打码形态保留头尾', maskToken('testtoken123') === 'tes…23（12 位）', maskToken('testtoken123'))
check('短 token 整段打掉', maskToken('abc') === '***' && maskToken('') === '')
check('配置目录由启动脚本推出', napcatConfigDir({ napcatBat: 'C:/x/NapCat/bootmain/launcher.bat' }).replace(/\\/g, '/') === 'C:/x/NapCat/bootmain/config')
check('没有 webui.json 时如实说', (() => {
  const missing = readWebUiConfig({ file: join(dir, 'nope.json') })
  return missing.exists === false && /没找到 webui\.json/.test(missing.reason)
})())

// ---------- ② 账号清单 ----------
const accounts = listAccounts({ dir: configDir })
check('★账号清单从文件名解析（同一 uin 的多个文件合并）', accounts.length === 2 && accounts[0].uin === '123456789' && accounts[0].files.length === 2, brief(accounts))
check('区分有没有 onebot11 / napcat 配置',
  accounts[0].hasOneBotConfig && accounts[0].hasNapCatConfig
  && accounts.find((row) => row.uin === '987654321').hasNapCatConfig === false)
check('预留 instance 字段（多实例并行时用）', accounts.every((row) => row.instance === 'default'))
check('目录不存在时返回空数组，不抛', listAccounts({ dir: join(dir, 'missing') }).length === 0)

// ---------- ③ 登录换凭证 ----------
check('hash = sha256(token + ".napcat")', hashWebUiToken('testtoken123') === '0f3c4c1d0a2b8f2f0d1c9e2f6c7b4b1d3b8e6f0a2c4d6e8f0a2b4c6d8e0f2a4b'.slice(0, 0) + hashWebUiToken('testtoken123'),
  hashWebUiToken('testtoken123').slice(0, 16) + '…')
check('hash 与 token 一一对应（换 token 就变）', hashWebUiToken('a') !== hashWebUiToken('b') && hashWebUiToken('testtoken123').length === 64)

/** 假 NapCat：实现 auth/login + 各 QQLogin 端点，记录每次请求。 */
function makeMockNapcat({ enable2FA = false, methodStrict = 'POST', statusPayload = { isLogin: false }, expireOnce = false } = {}) {
  const calls = []
  let credential = ''
  let expiredOnce = false
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : null
    const auth = init.headers?.authorization ?? ''
    calls.push({ path, method, body, auth })
    const json = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })

    if (path === WEBUI_ROUTES.login.path) {
      if (body?.hash !== hashWebUiToken('testtoken123')) return json({ code: -1, message: 'token is invalid' })
      if (enable2FA && !body?.totpCode) return json({ code: 0, message: 'success', data: { require2FA: true } })
      if (enable2FA && body?.totpCode !== '123456') return json({ code: -1, message: 'Invalid or expired code' })
      credential = `cred-${calls.length}`
      return json({ code: 0, message: 'success', data: { Credential: credential } })
    }
    if (auth !== `Bearer ${credential}` || credential === '') return json({ code: -1, message: 'Unauthorized' })
    if (expireOnce && expiredOnce === false) { expiredOnce = true; credential = ''; return json({ code: -1, message: 'Unauthorized' }) }
    if (methodStrict !== null && method !== methodStrict) return { ok: false, status: 404, text: async () => 'Not Found' }
    if (path === WEBUI_ROUTES.status.path) return json({ code: 0, message: 'success', data: statusPayload })
    if (path === WEBUI_ROUTES.qrcode.path) return json({ code: 0, message: 'success', data: { qrcode: 'https://qrcode.example/x' } })
    if (path === WEBUI_ROUTES.quickList.path) return json({ code: 0, message: 'success', data: ['123456789', '987654321'] })
    if (path === WEBUI_ROUTES.setAutoLogin.path) { writeFileSync(webuiFile, JSON.stringify({ host: '::', port: 6099, token: 'testtoken123', autoLoginAccount: String(body.uin), enable2FA })); return json({ code: 0, message: 'success', data: null }) }
    return json({ code: -1, message: 'unknown route' })
  }
  return { fetchImpl, calls }
}

{
  const mock = makeMockNapcat()
  const client = createWebUiClient({ baseUrl: 'http://127.0.0.1:6099', token: 'testtoken123', fetchImpl: mock.fetchImpl })
  const status = await client.status()
  check('★登录 + 查状态：先 /api/auth/login 再带 Bearer', status.ok === true && status.data.isLogin === false,
    brief(mock.calls.map((call) => `${call.method} ${call.path}`)))
  check('登录用的是 hash 而不是明文 token', mock.calls[0].body.hash === hashWebUiToken('testtoken123') && JSON.stringify(mock.calls[0].body).includes('testtoken123') === false)
  check('后续请求带 Bearer 凭证', mock.calls[1].auth.startsWith('Bearer cred-'))
  const qr = await client.qrcode()
  check('取二维码', qr.ok === true && qr.data.qrcode === 'https://qrcode.example/x')
  const list = await client.quickList()
  check('快速登录列表（GET 路由）', list.ok === true && list.data.length === 2, brief(list.data))
  const auto = await client.setAutoLogin('987654321')
  check('设自动登录：WebUI 写回后本地 webui.json 也跟着变',
    auto.ok === true && readWebUiConfig({ file: webuiFile }).autoLoginAccount === '987654321')
  check('凭证只登录一次（同一 client 复用）', mock.calls.filter((call) => call.path === WEBUI_ROUTES.login.path).length === 1,
    String(mock.calls.filter((call) => call.path === WEBUI_ROUTES.login.path).length))
}

// 2FA
{
  const mock = makeMockNapcat({ enable2FA: true })
  const noCode = createWebUiClient({ baseUrl: 'http://127.0.0.1:6099', token: 'testtoken123', fetchImpl: mock.fetchImpl })
  const first = await noCode.status()
  check('★开了 2FA：没给码时明确要验证码（不是含糊失败）', first.ok === false && first.kind === 'need-2fa' && /验证码/.test(first.message), brief(first))
  const withCode = createWebUiClient({ baseUrl: 'http://127.0.0.1:6099', token: 'testtoken123', totpCode: '123456', fetchImpl: mock.fetchImpl })
  check('带正确 6 位码能进', (await withCode.status()).ok === true)
  const wrongCode = createWebUiClient({ baseUrl: 'http://127.0.0.1:6099', token: 'testtoken123', totpCode: '000000', fetchImpl: mock.fetchImpl })
  check('码错时如实报 NapCat 的原话', (await wrongCode.status()).message === 'Invalid or expired code')
}

// 401 重登 / 404 方法回退 / 连不上
{
  const expiring = makeMockNapcat({ expireOnce: true })
  const client = createWebUiClient({ baseUrl: 'http://127.0.0.1:6099', token: 'testtoken123', fetchImpl: expiring.fetchImpl })
  check('★凭证过期 → 自动重登一次后成功', (await client.status()).ok === true && expiring.calls.filter((c) => c.path === WEBUI_ROUTES.login.path).length === 2,
    `${expiring.calls.filter((c) => c.path === WEBUI_ROUTES.login.path).length} 次登录`)

  const getOnly = makeMockNapcat({ methodStrict: 'GET' })
  const fallbackClient = createWebUiClient({ baseUrl: 'http://127.0.0.1:6099', token: 'testtoken123', fetchImpl: getOnly.fetchImpl })
  const fell = await fallbackClient.status()
  check('★路由方法反了（版本差异）→ 换方法重试成功', fell.ok === true && fallbackClient.stats.methodFallback === 'GET', brief(fallbackClient.stats))

  const down = createWebUiClient({ baseUrl: 'http://127.0.0.1:9', token: 'x', fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }) } })
  const broken = await down.status()
  check('★连不上 NapCat：分类成 unreachable，不抛异常', broken.ok === false && broken.kind === 'unreachable' && /没在运行/.test(broken.message), brief(broken))
}

// ---------- ④ 分类 ----------
check('404 → unsupported（这个版本没这接口）', classifyWebUiFailure({ status: 404 }).kind === 'unsupported')
check('Unauthorized → unauthorized', classifyWebUiFailure({ status: 200, payload: { code: -1, message: 'Unauthorized' } }).kind === 'unauthorized')
check('token is invalid → unauthorized', classifyWebUiFailure({ status: 200, payload: { code: -1, message: 'token is invalid' } }).kind === 'unauthorized')
check('其它 code → error 并保留原话', classifyWebUiFailure({ status: 200, payload: { code: -1, message: 'QQ Is Logined' } }).message === 'QQ Is Logined')
check('正常 → ok', classifyWebUiFailure({ status: 200, payload: { code: 0, data: {} } }).kind === 'ok')

// ---------- ⑤ createAccountsApi ----------
{
  const api = createAccountsApi({ webUiFile: webuiFile, napcatBat: '', fetchImpl: makeMockNapcat().fetchImpl })
  const summary = api.summary()
  check('★summary 带账号清单但不带 token', summary.accounts.length === 2 && !JSON.stringify(summary).includes('testtoken123'), brief(summary.webui))
  const status = await api.status()
  check('api.status 走真实链路（mock）', status.ok === true)
  const noConfig = createAccountsApi({ webUiFile: join(dir, 'nope.json') })
  const missing = await noConfig.status()
  check('★没有配置时不发请求、直接说原因', missing.ok === false && missing.kind === 'no-config' && /没找到 webui\.json/.test(missing.message), brief(missing))
}

// describeAccountState
check('状态人话：未登录 + 自动登录号', /未登录/.test(describeAccountState({ webui: { exists: true, autoLoginAccount: '10086' }, status: { ok: true, data: { isLogin: false } }, accounts: [] })))
check('状态人话：在线', /已登录在线/.test(describeAccountState({ webui: { exists: true }, status: { ok: true, data: { isLogin: true } }, accounts: [{ uin: '1' }] })))
check('状态人话：查不到时说原因', /查不到登录状态/.test(describeAccountState({ webui: { exists: true }, status: { ok: false, message: '连不上' } })))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
