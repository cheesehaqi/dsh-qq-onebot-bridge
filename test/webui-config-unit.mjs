/**
 * webui.json 编辑单测：端口/回环校验、备份、拒绝对外监听、不改 2FA 与 token。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountsApi } from '../control/lib/accounts.mjs'

let passed = 0
let failed = 0
const check = (name, ok, extra = '') => {
  if (ok) { passed++; console.log('PASS', name, extra) } else { failed++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-webui-'))
const configDir = join(dir, 'config')
mkdirSync(configDir, { recursive: true })
const file = join(configDir, 'webui.json')
const original = { host: '127.0.0.1', port: 6099, token: 'secret-token-123', enable2FA: true, autoLoginAccount: '3030856788' }
writeFileSync(file, JSON.stringify(original, null, 2), 'utf8')

const api = createAccountsApi({ webUiFile: file })

// ① 拒绝对外监听
const wan = api.updateWebUiConfig({ host: '0.0.0.0' })
check('★拒绝 0.0.0.0（不把面板暴露到局域网）', wan.ok === false && /回环/.test(wan.message), wan.message)
check('拒绝后文件未变', JSON.parse(readFileSync(file, 'utf8')).host === '127.0.0.1')

// ② 端口校验
check('端口越界被拒', api.updateWebUiConfig({ port: 70000 }).ok === false)
check('端口非整数被拒', api.updateWebUiConfig({ port: 'abc' }).ok === false)

// ③ 正常改端口
const saved = api.updateWebUiConfig({ port: 7000, now: () => Date.UTC(2026, 10, 1, 0, 20, 0) })
check('★改端口成功且要求重启', saved.ok === true && saved.requiresRestart === true, saved.message)
check('★写了备份文件', typeof saved.backup === 'string' && existsSync(saved.backup))
const after = JSON.parse(readFileSync(file, 'utf8'))
check('端口已改', after.port === 7000)
check('★token 原样保留（不经界面改）', after.token === original.token)
check('★2FA 原样保留', after.enable2FA === original.enable2FA)
check('★autoLoginAccount 原样保留', after.autoLoginAccount === original.autoLoginAccount)

// ④ 无变化不写
const same = api.updateWebUiConfig({ port: 7000 })
check('没有变化时明确说"未写入"', same.ok === false && same.kind === 'no-change', same.message)
check('备份只有一份（没重复写）', readdirSync(configDir).filter((n) => n.includes('.bak-')).length === 1)

// ⑤ 坏 JSON
writeFileSync(join(configDir, 'webui2.json'), '{ bad json', 'utf8')
const brokenApi = createAccountsApi({ webUiFile: join(configDir, 'webui2.json') })
check('坏 JSON 被拒且不覆盖', brokenApi.updateWebUiConfig({ port: 7001 }).ok === false)

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
