/**
 * v0.6「轻量化设计」：DSH 设置面板的测试。
 *
 * 三层：
 *   1. 纯逻辑（lib/panel.js）：分组快照、patch 文本的读/写；
 *   2. 路由契约（lib/settings-routes.js）：用假 webServer 捕获注册，直接调 handler；
 *   3. 客户端 bundle（client/client.js）：在桩掉的 __ModuleLoader__ 里真的执行一遍，
 *      确认它导出 inject/apply 并注册了 settings.section——并钉住它 fetch 的路由名
 *      与服务端注册的路由名一致（两边的名字漂移会在这里红）。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PANEL_GROUPS, PANEL_KEYS, PANEL_NEEDS, normalizeRepoUrl, panelAccountLink, panelFooterLinks,
  panelFooterLinksWithConsole, panelSnapshot, readPatchValue, upsertPatchValue,
} from '../lib/panel.js'
import {
  argvProfile, consoleStartCommand, mountQqAiPanel, napcatWebUiUrl, panelLinkSources, probePort, profileDirOf,
  resolveProfile,
} from '../lib/settings-routes.js'
import { Config } from '../lib/index.js'

/**
 * 解析 YAML 用平台自己那份 `yaml` 包（不引第三方依赖，也不把本机路径写进仓库）：
 * 从 profile 目录（`$DSH_HOME` 下的 profiles/<名字>）起解析——profile 里一定有它。
 * 解析不到就**如实降级**（只做结构检查并标注），绝不假装"验过了"。
 */
const loadYaml = async () => {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const bases = [
    join(import.meta.dirname, '..', 'package.json'),
    join(home, 'profiles', 'desktop', 'package.json'),
    join(home, 'profiles', 'web', 'package.json'),
  ]
  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve('yaml')
      const mod = await import(pathToFileURL(resolved).href)
      return mod.default ?? mod
    } catch { /* 试下一个 */ }
  }
  return null
}
const YAML = await loadYaml()

const JSON_HEADERS = { 'content-type': 'application/json' }

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (value) => {
  try { return JSON.stringify(value ?? null).slice(0, 160) } catch { return String(value) }
}

// ---------------------------------------------------------------- 1. 纯逻辑 ----
const dict = Config?.dict ?? {}
const missing = PANEL_KEYS.filter((key) => !(key in dict))
const notBoolean = PANEL_KEYS.filter((key) => key in dict && String(dict[key]?.type) !== 'boolean')
check('面板里的每个开关都在 schema 里', missing.length === 0, missing.join(','))
check('面板里的每个开关都是布尔键（只有布尔才能当开关）', notBoolean.length === 0, notBoolean.join(','))
check('面板分组都有 id/title 且开关不重复',
  PANEL_GROUPS.every((group) => group.id && group.title && group.rows.length > 0)
  && new Set(PANEL_KEYS).size === PANEL_KEYS.length,
  `${PANEL_GROUPS.length} 组 / ${PANEL_KEYS.length} 开关`)

// ---- 说明必须"写全"（用户反馈：有些开关只写了标签，没说需要额外软件/模型）----
const needsVocabulary = new Set(Object.values(PANEL_NEEDS))
const allRows = PANEL_GROUPS.flatMap((group) => group.rows)
const shortHints = allRows.filter((entry) => !entry.hint || entry.hint.trim().length < 20)
check('每个开关都有像样的说明（≥20 字，不许空着或一句带过）',
  shortHints.length === 0, shortHints.map((entry) => entry.key).join(','))
const badNeeds = allRows.filter((entry) => entry.needs !== '' && !needsVocabulary.has(entry.needs))
check('依赖标记只用词表里的值（界面按它渲染小标签）',
  badNeeds.length === 0, badNeeds.map((entry) => `${entry.key}=${entry.needs}`).join(','))
// 证据型守卫：schema 里同族存在"外部服务/密钥"类配置键的开关，面板**必须**标出依赖，
// 否则"AI 生图只写一行英文、没说需要额外服务"这类漏写会再次发生。
const externalHintKeys = ['apiKey', 'baseUrl', 'provider', 'model', 'region']
const needMarkers = new Set(Object.values(PANEL_NEEDS))
const missed = PANEL_KEYS.filter((key) => {
  const stem = key.replace(/(Enabled|Local|InGroup|Only)$/, '').toLowerCase().slice(0, 4)
  const family = Object.keys(dict).filter((other) => other !== key && other.toLowerCase().startsWith(stem))
  const needsExternal = family.some((other) => externalHintKeys.some((marker) => other.toLowerCase().includes(marker.toLowerCase())))
  if (!needsExternal) return false
  const entry = allRows.find((row) => row.key === key)
  return !entry || entry.needs === '' || !needMarkers.has(entry.needs)
})
check('凡 schema 里带 apiKey/baseUrl/provider/model 的开关都标了依赖',
  missed.length === 0, missed.join(','))
check('依赖分布合理（既有"开箱即用"也有需要准备的，且总数为 59）',
  allRows.filter((entry) => entry.needs === '').length >= 5
  && allRows.filter((entry) => entry.needs !== '').length >= 20
  && allRows.length === 59,
  `开箱即用 ${allRows.filter((entry) => entry.needs === '').length} / 需准备 ${allRows.filter((entry) => entry.needs !== '').length}`)
check('生图/语音这些"要装东西"的功能，说明里点明了需要什么',
  ['imageGenEnabled', 'ttsEnabled'].every((key) => {
    const entry = allRows.find((row) => row.key === key)
    return entry && entry.needs !== '' && /不自带|自己准备|自己装/.test(entry.hint)
  }))
// 用户要求：**TTS/生图 DSH 不自带**必须说清楚；但**语音转文字 DSH 自带**（实验性，需自行启用）——
// 这两件事口径不同，都要如实写，别一杆子打成"都不自带"（我自己就写错过一次）。
const notBundledRows = ['ttsEnabled', 'imageGenEnabled', 'voiceReadingEnabled']
check('TTS / 生图这几行说明里点明"DSH 与本插件都不自带"',
  notBundledRows.every((key) => {
    const entry = allRows.find((row) => row.key === key)
    return entry && /不自带/.test(entry.hint)
  }), notBundledRows.map((key) => `${key}:${/不自带/.test(allRows.find((row) => row.key === key)?.hint ?? '')}`).join(' '))
const sttRow = allRows.find((row) => row.key === 'sttEnabled')
check('语音转文字的说明写的是"DSH 自带（实验性，需自行启用）"，不是"不自带"',
  /DSH 自带/.test(sttRow?.hint ?? '') && /启用/.test(sttRow?.hint ?? '') && !/都不自带/.test(sttRow?.hint ?? ''),
  String(sttRow?.hint).slice(0, 70))
// schema 描述也要一致（配置文件里看得到）
check('schema 描述口径一致：STT 说 DSH SHIPS，TTS/生图说 NOT BUNDLED',
  /DSH SHIPS STT/.test(String(dict.sttEnabled?.meta?.description))
  && /NOT BUNDLED/.test(String(dict.ttsEnabled?.meta?.description))
  && /NOT BUNDLED/.test(String(dict.imageGenEnabled?.meta?.description))
  && !/no TTS service/.test(String(dict.imageGenEnabled?.meta?.description)))
const mediaGroup = PANEL_GROUPS.find((group) => group.id === 'media')
check('"语音与媒体"这一组有组级提示，且把 STT 的例外写清（自带但要启用）',
  typeof mediaGroup?.note === 'string' && /不自带/.test(mediaGroup.note)
  && /语音转文字 DSH 自带/.test(mediaGroup.note) && /默认(全部)?关/.test(mediaGroup.note),
  String(mediaGroup?.note).slice(0, 70))
check('快照把组级提示带给界面',
  panelSnapshot({}, { defaults: {} }).groups.find((group) => group.id === 'media')?.note?.includes('不自带') === true)

// 用户的规则：**需要额外安装/配密钥的功能一律默认关**（"因为这些需要额外安装扩展"）。
// 这条把规则钉进 schema：以后谁把这类开关的默认值改回 true，测试直接红。
const externalNeeds = new Set([PANEL_NEEDS.service, PANEL_NEEDS.key])
const shouldBeOff = allRows.filter((entry) => externalNeeds.has(entry.needs))
const wronglyOn = shouldBeOff.filter((entry) => dict[entry.key]?.meta?.default !== false)
check('凡标了「需外部服务 / 需密钥」的开关都必须默认关',
  wronglyOn.length === 0,
  `检查了 ${shouldBeOff.length} 个：` + (wronglyOn.map((entry) => entry.key).join(',') || '全部默认关 ✅'))

const snapshot = panelSnapshot({ ttsEnabled: true, groupOpsEnabled: false }, { defaults: { ttsEnabled: false, groupOpsEnabled: false } })
const flat = snapshot.groups.flatMap((group) => group.rows)
const tts = flat.find((row) => row.key === 'ttsEnabled')
const ops = flat.find((row) => row.key === 'groupOpsEnabled')
check('快照把生效值整理成布尔 + 标出"非默认"及其**方向**',
  tts?.value === true && tts?.nonDefault === true && tts?.defaultValue === false
  && ops?.value === false && ops?.nonDefault === false && ops?.defaultValue === false,
  brief({ tts, ops }))
check('快照没有 fileValues 时 pending 一律 false（不假装知道配置文件）',
  flat.every((row) => row.pending === false && row.fileValue === null))

const PATCH = `# 顶部注释
- id: dsh-qq-onebot-bridge
  name: dsh-qq-onebot-bridge
  config:
    cwd: /work/qq-bridge
    ttsEnabled: true
    # 保留这行注释
    allowUsers:
      - 10001
- id: dsh-mnemon
  config:
    ttsEnabled: true
`
check('readPatchValue 读到本插件条目里的值', readPatchValue(PATCH, 'ttsEnabled') === true)
check('readPatchValue 不会被别的插件条目的同名键骗到',
  readPatchValue(PATCH.replace('    ttsEnabled: true\n    # 保留这行注释', '    # 保留这行注释'), 'ttsEnabled') === null,
  String(readPatchValue(PATCH.replace('    ttsEnabled: true\n    # 保留这行注释', '    # 保留这行注释'), 'ttsEnabled')))
const updated = upsertPatchValue(PATCH, 'ttsEnabled', false)
check('upsert 改掉已有的键', updated.ok === true && updated.changed === true
  && /^    ttsEnabled: false$/m.test(updated.yaml), updated.reason)
check('upsert 不影响其它条目与注释',
  updated.yaml.includes('- id: dsh-mnemon') && updated.yaml.includes('# 保留这行注释')
  && updated.yaml.includes('# 顶部注释') && updated.yaml.endsWith('\n'))
const inserted = upsertPatchValue(PATCH, 'pointsEnabled', true)
check('upsert 能插入新键（缩进对齐 config 块）',
  inserted.ok === true && /^    pointsEnabled: true$/m.test(inserted.yaml)
  && inserted.yaml.indexOf('pointsEnabled') < inserted.yaml.indexOf('- id: dsh-mnemon'),
  inserted.reason)
check('upsert 对同值写入是幂等的（changed=false）',
  upsertPatchValue(updated.yaml, 'ttsEnabled', false).changed === false)
check('upsert 拒绝非布尔值', upsertPatchValue(PATCH, 'ttsEnabled', 'yes').ok === false)
check('upsert 在没有本插件条目时如实拒绝',
  upsertPatchValue('- id: other\n  config:\n    a: 1\n', 'ttsEnabled', true).reason.includes('没有 dsh-qq-onebot-bridge'))
check('upsert 对空文件如实拒绝', upsertPatchValue('', 'ttsEnabled', true).ok === false)

// ---- 第二轮对抗性审查用"逐条回退"证明过：下面这些加固此前**没有任何断言覆盖**（回退了也全绿）----
const parseYaml = (text) => {
  try { return { doc: YAML.parse(text), error: null } } catch (error) { return { doc: null, error: error.message } }
}
// R1：4 空格缩进的合法 patch（yaml.stringify(…,{indent:4}) 的产物形态）不许被写成非法 YAML
const fourSpace = '-   id: dsh-qq-onebot-bridge\n    config:\n        ttsEnabled: true\n        port: 6700\n-   id: other\n    config:\n        a: 1\n'
const r1 = upsertPatchValue(fourSpace, 'ttsEnabled', false)
check('R1 4 空格缩进：写回仍是合法 YAML 且缩进不变、兄弟键还在',
  r1.ok === true && parseYaml(r1.yaml).error === null
  && /^ {8}ttsEnabled: false$/m.test(r1.yaml) && /^ {8}port: 6700$/m.test(r1.yaml),
  parseYaml(r1.yaml).error ?? '')
// R2：多行字符串里"长得像键"的行不许被当成真键。
// 关键：字符串内容行必须**真的以 `ttsEnabled:` 开头**（只是缩进不同）——否则"必须正好在子键缩进"
// 这条判定去掉也测不出来（第一版夹具就是这样，回退矩阵当场证明它没覆盖）。
const blockScalar = '- id: dsh-qq-onebot-bridge\n  config:\n    welcomeTemplate: |\n      ttsEnabled: false\n      第二行\n    ttsEnabled: true\n'
const r2 = upsertPatchValue(blockScalar, 'ttsEnabled', false)
check('R2 多行字符串：内容没被动、真键被改、YAML 仍合法',
  parseYaml(r2.yaml).error === null && r2.yaml.includes('\n      ttsEnabled: false\n')
  && readPatchValue(r2.yaml, 'ttsEnabled') === false, parseYaml(r2.yaml).error ?? '')
check('R2b 多行字符串：读的时候也不被伪键骗到（只剩字符串那一行时必须返回 null）',
  readPatchValue(blockScalar.replace('    ttsEnabled: true\n', ''), 'ttsEnabled') === null)
// R3：CRLF 下同值写入必须幂等，且新行不混排行尾
const crlfPatch = '- id: dsh-qq-onebot-bridge\r\n  config:\r\n    ttsEnabled: true\r\n'
check('R3a CRLF：同值写入幂等（changed=false，文本一字不动）',
  upsertPatchValue(crlfPatch, 'ttsEnabled', true).changed === false)
const r3 = upsertPatchValue(crlfPatch, 'diceEnabled', true)
check('R3b CRLF：新增行后仍全是 CRLF（不混排）',
  r3.yaml.includes('\r\n') && !/[^\r]\n/.test(r3.yaml), JSON.stringify(r3.yaml.slice(-30)))
// R4：同名条目多条时改**最后一条**（DSH 的 dsh-plugin-manager 用 findLast）
const dupEntries = '- id: dsh-qq-onebot-bridge\n  config:\n    ttsEnabled: true\n- id: dsh-qq-onebot-bridge\n  config:\n    ttsEnabled: true\n'
const r4 = upsertPatchValue(dupEntries, 'ttsEnabled', false)
const r4doc = parseYaml(r4.yaml).doc
check('R4 重复条目：改的是最后一条，读的也是最后一条',
  Array.isArray(r4doc) && r4doc[0].config.ttsEnabled === true && r4doc[1].config.ttsEnabled === false
  && readPatchValue(r4.yaml, 'ttsEnabled') === false,
  JSON.stringify(r4doc?.map((entry) => entry.config?.ttsEnabled)))
// 新增：config 第一层是列表时**拒绝写入**（此前会写出宿主解析不了的 YAML）
const sequenceConfig = '- id: dsh-qq-onebot-bridge\n  config:\n    - 10001\n    - 10002\n- id: other\n'
const rSeq = upsertPatchValue(sequenceConfig, 'ttsEnabled', true)
check('序列开头的 config：拒绝写入并说明原因（不产出非法 YAML）',
  rSeq.ok === false && rSeq.yaml === sequenceConfig && rSeq.reason.includes('列表'), rSeq.reason)
// 新增：带引号 / 带行尾注释的条目 id 也要认（否则会误报"没有这个条目"）
const quotedId = '- id: "dsh-qq-onebot-bridge" # 本插件\n  config:\n    ttsEnabled: true\n'
const rQuoted = upsertPatchValue(quotedId, 'ttsEnabled', false)
check('带引号与行尾注释的条目 id 能认出来',
  rQuoted.ok === true && rQuoted.changed === true && readPatchValue(rQuoted.yaml, 'ttsEnabled') === false,
  rQuoted.reason)

// ---- 底部链接（更新日志 / 调试）----
check('normalizeRepoUrl 把 git+…git 变成能点的 https 地址',
  normalizeRepoUrl('git+https://github.com/me/repo.git') === 'https://github.com/me/repo'
  && normalizeRepoUrl('https://github.com/me/repo/') === 'https://github.com/me/repo'
  && normalizeRepoUrl('') === '',
  normalizeRepoUrl('git+https://github.com/me/repo.git'))
const links = panelFooterLinks({ version: '9.9.9', repoUrl: 'git+https://github.com/me/repo.git', consolePort: 8801 })
const changelog = links.find((link) => link.id === 'changelog')
const consoleLink = links.find((link) => link.id === 'console')
check('底部有更新日志与调试台，且链接由真实素材拼出',
  changelog?.href === 'https://github.com/me/repo/blob/main/CHANGELOG.md'
  && changelog.label.includes('9.9.9')
  && consoleLink?.href === 'http://127.0.0.1:8801/'
  && links.some((link) => link.id === 'readme-debug'),
  links.map((link) => `${link.id}=${link.href}`).join(' | '))
check('调试台链接里不含 token（本机密钥不进面板）',
  links.every((link) => !/token=/i.test(link.href)) && consoleLink.href.startsWith('http://127.0.0.1:'))
const bareLinks = panelFooterLinks({ version: '1.0.0', repoUrl: '', consolePort: 8799 })
check('没有仓库地址时只给调试台（不编造链接）',
  bareLinks.length === 1 && bareLinks[0]?.id === 'console',
  bareLinks.map((link) => link.id).join(','))
// 「QQ助手账号」= 机器人账号的登录/扫码页（NapCat WebUI）。href 指宿主自己的 /qqai/account：
// token 由服务端读出后走 302，**不进面板载荷**（同"调试台"入口的规矩）。
// ⚠️ 它**不是底部"相关链接"里的一条**（用户 2026-10-04 两轮修正："应该把账号登陆调到最上方" →
// "不对不对应该在QQ助手的下边"）：现在由 `panelAccountLink()` 单独给，客户端渲染在标题正下方。
const accountLink = panelAccountLink()
check('账号入口是独立的一项（不在底部链接里），且它自己不带 token',
  accountLink.href === '/qqai/account' && accountLink.label.includes('QQ助手账号')
  && !/token=/i.test(accountLink.href)
  && !links.some((link) => link.id === 'account') && !bareLinks.some((link) => link.id === 'account'),
  `${brief(accountLink)} · 底部=${links.map((link) => link.id).join(',')}`)
check('底部链接顺序固定为 更新日志 → 调试文档 → 调试台（账号入口不掺在里面）',
  links.map((link) => link.id).join(',') === 'changelog,readme-debug,console'
  && bareLinks.map((link) => link.id).join(',') === 'console',
  `完整=${links.map((link) => link.id).join(',')} 无仓库=${bareLinks.map((link) => link.id).join(',')}`)
// 调试台是**独立进程**：面板必须如实标出"运行中/未启动"，并给出可复制的启动命令（否则用户对着"连不上"发懵）。
const offConsole = panelFooterLinksWithConsole({
  version: '1.0.0', repoUrl: '', consolePort: 8799, consoleRunning: false, startCommand: 'node x.mjs',
}).find((link) => link.id === 'console')
check('调试台没启动时：链接改指宿主入口，并写明启动命令',
  offConsole.href === '/qqai/console' && offConsole.running === false
  && offConsole.state.includes('未启动') && offConsole.state.includes('node x.mjs'),
  offConsole.state)
const onConsole = panelFooterLinksWithConsole({
  version: '1.0.0', repoUrl: '', consolePort: 8799, consoleRunning: true, startCommand: 'node x.mjs',
}).find((link) => link.id === 'console')
check('调试台在跑时：标"运行中"，且不再让用户去启动',
  onConsole.running === true && onConsole.state.includes('运行中') && !onConsole.state.includes('node x.mjs'),
  onConsole.state)
// 配置读不到时必须降级而不是抛：插件根目录不存在、或 qq-control.json 是坏 JSON。
const missingRoot = panelLinkSources({ root: '/definitely/not/here' })
check('读不到 package.json / qq-control.json 时降级（版本空、端口回落 8799）',
  missingRoot.version === '' && missingRoot.repoUrl === '' && missingRoot.consolePort === 8799,
  brief(missingRoot))
const brokenRoot = mkdtempSync(join(tmpdir(), 'qq-broken-'))
writeFileSync(join(brokenRoot, 'package.json'), '{ 这不是 JSON', 'utf8')
writeFileSync(join(brokenRoot, 'qq-control.json'), '{ 也不是', 'utf8')
const broken = panelLinkSources({ root: brokenRoot })
check('坏 JSON 也不抛，按默认值走', broken.consolePort === 8799 && broken.version === '', brief(broken))
rmSync(brokenRoot, { recursive: true, force: true })

// ---------------------------------------------------------------- 2. 路由 ---- ----
const dir = mkdtempSync(join(tmpdir(), 'qq-panel-'))
const profileDir = join(dir, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })
const patchPath = join(profileDir, 'cordis.patch.yml')
writeFileSync(patchPath, PATCH, 'utf8')

const registered = []
const disposed = []
const fakeHost = {
  webServer: {
    register(route) {
      if (registered.some((item) => item.path === route.path)) throw new Error(`duplicate route ${route.path}`)
      registered.push(route)
      return () => { disposed.push(route.path); const at = registered.indexOf(route); if (at >= 0) registered.splice(at, 1) }
    },
  },
}
const env = { DSH_HOME: dir }
const dispose = mountQqAiPanel(fakeHost, {
  profile: 'web',
  config: { ttsEnabled: true },
  defaults: { ttsEnabled: false },
  readFile: readFileSync,
  writeFile: writeFileSync,
  copy: copyFileSync,
  exists: existsSync,
  ensureDir: (target) => mkdirSync(target, { recursive: true }),
  env,
  // 探测必须注入：否则断言会随"本机 8799 有没有在跑"而变（这坑真踩过一次）。
  probe: async () => false,
})
const makeResponse = () => {
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(body) { out.body = body ?? '' },
  }
}
const fakeRequest = (method, body, headers = {}) => ({
  method,
  headers,
  async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
})

check('挂载了四条路由（读面板 + 写开关 + 调试台入口 + 账号入口）',
  registered.length === 4 && registered.some((r) => r.path === '/qqai/panel')
  && registered.some((r) => r.path === '/qqai/panel/set') && registered.some((r) => r.path === '/qqai/console')
  && registered.some((r) => r.path === '/qqai/account'),
  registered.map((r) => r.path).join(','))

const getHandler = registered.find((r) => r.path === '/qqai/panel').handler
const setHandler = registered.find((r) => r.path === '/qqai/panel/set').handler

const readRes = makeResponse()
await getHandler(fakeRequest('GET'), readRes)
const readBody = JSON.parse(readRes.out.body)
check('GET /qqai/panel 返回分组 + profile + 配置文件路径',
  readRes.out.status === 200 && readBody.ok === true && readBody.groups.length === PANEL_GROUPS.length
  && readBody.profile === 'web' && readBody.patchFile.endsWith('cordis.patch.yml'), brief({ status: readRes.out.status }))
check('GET 里带上"待重启"信息（生效值 vs 文件值）',
  readBody.groups.flatMap((g) => g.rows).find((row) => row.key === 'ttsEnabled')?.pending === false,
  brief(readBody.groups.flatMap((g) => g.rows).find((row) => row.key === 'ttsEnabled')))
check('GET 带上底部链接（更新日志 + 调试台）',
  Array.isArray(readBody.links) && readBody.links.some((link) => link.id === 'changelog')
  && readBody.links.some((link) => link.id === 'console')
  && readBody.links.every((link) => typeof link.href === 'string' && link.href !== ''),
  brief(readBody.links?.map((link) => link.id)))
// 载荷形状：账号入口单独一个 `account` 字段（客户端拿它渲染标题正下方那一行），**不在 links 里**。
check('GET 把账号入口单独给出（account 字段），而不是塞进底部 links',
  readBody.account?.href === '/qqai/account' && readBody.account.label.includes('QQ助手账号')
  && !readBody.links.some((link) => link.id === 'account'),
  brief({ account: readBody.account, links: readBody.links?.map((link) => link.id) }))

const writeRes = makeResponse()
await setHandler(fakeRequest('POST', { key: 'ttsEnabled', value: false }, JSON_HEADERS), writeRes)
const writeBody = JSON.parse(writeRes.out.body)
check('POST 写成功后返回最新面板', writeRes.out.status === 200 && writeBody.ok === true && writeBody.changed === true, brief(writeBody.reason))
check('POST 真的改了文件（且生效值未变 → 该行标 pending）',
  readFileSync(patchPath, 'utf8').includes('ttsEnabled: false')
  && writeBody.panel.groups.flatMap((g) => g.rows).find((r) => r.key === 'ttsEnabled')?.pending === true,
  brief(writeBody.panel.groups.flatMap((g) => g.rows).find((r) => r.key === 'ttsEnabled')))
check('POST 留了备份 .bak-qqai', existsSync(`${patchPath}.bak-qqai`))
const rejected = makeResponse()
await setHandler(fakeRequest('POST', { key: 'port', value: 1234 }, JSON_HEADERS), rejected)
check('POST 拒绝白名单外的键（面板不会变成任意配置编辑器）',
  rejected.out.status === 400 && JSON.parse(rejected.out.body).reason.includes('白名单'), rejected.out.body)
const rejected2 = makeResponse()
await setHandler(fakeRequest('POST', { key: 'ttsEnabled', value: 'yes' }, JSON_HEADERS), rejected2)
check('POST 拒绝非布尔值', rejected2.out.status === 400, rejected2.out.body)
const wrongMethod = makeResponse()
await getHandler(fakeRequest('POST'), wrongMethod)
check('方法不对给 405', wrongMethod.out.status === 405, String(wrongMethod.out.status))

// ---- 跨站写保护（对抗性审查实测过：text/plain 简单请求原本能改配置）----
const jheaders = { 'content-type': 'application/json' }
const crossOrigin = makeResponse()
await setHandler(fakeRequest('POST', { key: 'filterEnabled', value: true }, { ...jheaders, origin: 'https://evil.example' }), crossOrigin)
check('拒绝跨站 Origin 的写请求（403，且不落盘）',
  crossOrigin.out.status === 403 && /Origin/.test(JSON.parse(crossOrigin.out.body).reason)
  && !readFileSync(patchPath, 'utf8').includes('filterEnabled'), crossOrigin.out.body.slice(0, 90))
const crossSite = makeResponse()
await setHandler(fakeRequest('POST', { key: 'filterEnabled', value: true }, { ...jheaders, 'sec-fetch-site': 'cross-site' }), crossSite)
check('拒绝 sec-fetch-site: cross-site 的写请求', crossSite.out.status === 403, crossSite.out.body.slice(0, 80))
const plainType = makeResponse()
await setHandler(fakeRequest('POST', { key: 'filterEnabled', value: true }, { 'content-type': 'text/plain' }), plainType)
check('拒绝 text/plain 的写请求（CORS 简单请求没有预检）',
  plainType.out.status === 403 && /application\/json/.test(JSON.parse(plainType.out.body).reason), plainType.out.body.slice(0, 90))
const sameOrigin = makeResponse()
await setHandler(fakeRequest('POST', { key: 'filterEnabled', value: true }, { ...jheaders, origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-site' }), sameOrigin)
// 首轮审查放过、二轮审查收紧：**异端口的本机页面**不再放行（改前它被当"同源"信任）。
const otherLocalPort = makeResponse()
await setHandler(fakeRequest('POST', { key: 'filterEnabled', value: true }, { ...JSON_HEADERS, origin: 'http://127.0.0.1:3080' }), otherLocalPort)
check('异端口的本机 Origin 被拒（收紧后：只有同源/同站或 dsh-* 协议放行）',
  otherLocalPort.out.status === 403, otherLocalPort.out.body.slice(0, 80))
// 二轮 P1：**没有 Content-Type** 的 CORS 简单请求（无预检）必须被拒——这是旧版最大的绕过口子。
const noContentType = makeResponse()
await setHandler(fakeRequest('POST', { key: 'filterEnabled', value: true }), noContentType)
check('没有 Content-Type 的写请求被拒（简单请求不发预检，旧版这里能改配置）',
  noContentType.out.status === 403 && /application\/json/.test(JSON.parse(noContentType.out.body).reason),
  noContentType.out.body.slice(0, 90))
// 二轮 P1：非 http 协议（扩展/本地文件/data:）不再当"自家协议"信任
for (const evilOrigin of ['chrome-extension://evil', 'file://', 'data:text/html,x']) {
  const res = makeResponse()
  await setHandler(fakeRequest('POST', { key: 'filterEnabled', value: true }, { ...JSON_HEADERS, origin: evilOrigin }), res)
  check(`拒绝非 http 来源：${evilOrigin}`, res.out.status === 403, String(res.out.status))
}
// 浏览器自己打的 same-origin 标记可信（页面改不了它）
const browserSameOrigin = makeResponse()
await setHandler(fakeRequest('POST', { key: 'filterEnabled', value: true }, { ...JSON_HEADERS, origin: 'https://whatever.invalid', 'sec-fetch-site': 'same-origin' }), browserSameOrigin)
check('sec-fetch-site: same-origin 视为可信（浏览器担保，页面无法伪造）',
  browserSameOrigin.out.status === 200, browserSameOrigin.out.body.slice(0, 60))
// 官方桌面端的页面源是 `dsh-app://app` 这类自定义协议：它必须放行，否则桌面端里点开关毫无反应。
const appScheme = makeResponse()
await setHandler(fakeRequest('POST', { key: 'filterEnabled', value: false }, { ...jheaders, origin: 'dsh-app://app', 'sec-fetch-site': 'same-origin' }), appScheme)
check('自定义协议源（桌面端 dsh-app://）放行',
  appScheme.out.status === 200 && JSON.parse(appScheme.out.body).ok === true, appScheme.out.body.slice(0, 70))
const remoteHost = makeResponse()
await setHandler(fakeRequest('POST', { key: 'filterEnabled', value: true }, { ...jheaders, origin: 'http://192.168.1.9:3080' }), remoteHost)
check('http(s) 的非本机 Origin 一律拒绝', remoteHost.out.status === 403, remoteHost.out.body.slice(0, 70))
// ---- 写入失败必须"原文件不动"（审查者用注入 rename=EPERM 复现过旧版会覆盖）----
const brokenDir = join(dir, 'profiles', 'broken')
mkdirSync(brokenDir, { recursive: true })
const brokenPatch = join(brokenDir, 'cordis.patch.yml')
const originalBroken = '- id: dsh-qq-onebot-bridge\n  config:\n    ttsEnabled: true\n'
writeFileSync(brokenPatch, originalBroken, 'utf8')
const brokenRoutes = []
const brokenHost = {
  webServer: { register(route) { brokenRoutes.push(route); return () => { const at = brokenRoutes.indexOf(route); if (at >= 0) brokenRoutes.splice(at, 1) } } },
}
mountQqAiPanel(brokenHost, {
  profile: 'web', config: { ttsEnabled: true }, env, probe: async () => false,
  dir: brokenDir,
  rename: () => { const error = new Error('EPERM: operation not permitted'); error.code = 'EPERM'; throw error },
})
const failRes = makeResponse()
await brokenRoutes.find((r) => r.path === '/qqai/panel/set').handler(
  fakeRequest('POST', { key: 'ttsEnabled', value: false }, jheaders), failRes)
const leftovers = (await import('node:fs')).readdirSync(brokenDir)
check('rename 失败时：500、原文件逐字节不动、不留临时文件',
  failRes.out.status === 500 && /原文件保持不动/.test(JSON.parse(failRes.out.body).reason)
  && readFileSync(brokenPatch, 'utf8') === originalBroken
  && leftovers.filter((name) => name.includes('.tmp') || name.includes('orphan')).length === 0,
  `status=${failRes.out.status} leftovers=${JSON.stringify(leftovers)}`)

// R8：**读失败**（不是文件不存在）必须如实报，不能被说成"没有配置文件"。
const dirPatchDir = join(dir, 'profiles', 'asdir')
mkdirSync(join(dirPatchDir, 'cordis.patch.yml'), { recursive: true })   // 让 patch 路径是个目录 → 读必然失败
const dirRoutes = []
mountQqAiPanel({
  webServer: { register(route) { dirRoutes.push(route); return () => { const at = dirRoutes.indexOf(route); if (at >= 0) dirRoutes.splice(at, 1) } } },
}, { profile: 'web', config: {}, env, dir: dirPatchDir, probe: async () => false })
const dirRead = makeResponse()
await dirRoutes.find((r) => r.path === '/qqai/panel').handler(fakeRequest('GET'), dirRead)
const dirBody = JSON.parse(dirRead.out.body)
check('R8 读失败与"文件不存在"分开报（patchReason 带真原因）',
  dirBody.patchExists === false && String(dirBody.patchReason).includes('读配置文件失败'), brief(dirBody.patchReason))
const dirWrite = makeResponse()
await dirRoutes.find((r) => r.path === '/qqai/panel/set').handler(fakeRequest('POST', { key: 'ttsEnabled', value: false }, JSON_HEADERS), dirWrite)
check('R8b 写请求在读不到配置时回 400 并带上真原因',
  dirWrite.out.status === 400 && String(JSON.parse(dirWrite.out.body).reason).includes('读配置文件失败'),
  dirWrite.out.body.slice(0, 90))

// R9：注册到一半失败（第二条路由撞名）必须**回滚**已注册的那条，否则之后永远挂不上。
const rolledBack = []
const flakyHost = {
  webServer: {
    register(route) {
      if (route.path === '/qqai/console') throw new Error('duplicate route /qqai/console')
      rolledBack.push(route.path)
      return () => { const at = rolledBack.indexOf(route.path); if (at >= 0) rolledBack.splice(at, 1) }
    },
  },
}
let threw = false
try {
  mountQqAiPanel(flakyHost, { profile: 'web', config: {}, env, dir: patchPath.replace('/cordis.patch.yml', ''), probe: async () => false })
} catch { threw = true }
check('R9 注册半途失败会回滚已注册的路由（不留半挂状态）',
  threw === true && rolledBack.length === 0, `threw=${threw} left=${JSON.stringify(rolledBack)}`)

// 分层警告：家目录 patch 里也有本插件时，面板必须说明"它盖过 profile 层"。
const homeDir = join(dir, 'home')
mkdirSync(homeDir, { recursive: true })
writeFileSync(join(homeDir, 'cordis.patch.yml'), '- id: dsh-qq-onebot-bridge\n  config:\n    ttsEnabled: true\n', 'utf8')
const warnRoutes = []
mountQqAiPanel({
  webServer: { register(route) { warnRoutes.push(route); return () => { const at = warnRoutes.indexOf(route); if (at >= 0) warnRoutes.splice(at, 1) } } },
}, { profile: 'web', config: {}, env: { ...env, DSH_HOME: homeDir }, dir: patchPath.replace('/cordis.patch.yml', ''), probe: async () => false })
const warnRes = makeResponse()
await warnRoutes.find((r) => r.path === '/qqai/panel').handler(fakeRequest('GET'), warnRes)
const warnBody = JSON.parse(warnRes.out.body)
check('家目录 patch 也配了本插件时，面板给出"它盖过 profile 层"的警告',
  Array.isArray(warnBody.warnings) && warnBody.warnings.length === 1
  && warnBody.warnings[0].includes('盖过'), brief(warnBody.warnings))
check('GET 里如实标出调试台状态（本条注入"没在跑"，与实际机器无关）',
  readBody.links.find((link) => link.id === 'console')?.running === false
  && readBody.links.find((link) => link.id === 'console')?.state.includes('未启动'),
  brief(readBody.links.find((link) => link.id === 'console')?.state))

// ---- 调试台入口的两条分支（token 只在服务端用，绝不进面板载荷）----
const fakeRoot = join(dir, 'plugin-root')
mkdirSync(fakeRoot, { recursive: true })
const FAKE_TOKEN = 'tok-not-a-real-secret-1234'
writeFileSync(join(fakeRoot, 'package.json'), JSON.stringify({ version: '1.2.3', repository: { url: 'git+https://github.com/me/r.git' } }), 'utf8')
writeFileSync(join(fakeRoot, 'qq-control.json'), JSON.stringify({ ports: { control: 8799 }, token: FAKE_TOKEN }), 'utf8')

const mountConsole = (running) => {
  const seen = []
  const hostStub = {
    webServer: {
      register(route) { seen.push(route); return () => { const at = seen.indexOf(route); if (at >= 0) seen.splice(at, 1) } },
    },
  }
  mountQqAiPanel(hostStub, {
    profile: 'web', config: {}, readFile: readFileSync, writeFile: writeFileSync, env,
    linkSources: { root: fakeRoot }, probe: async () => running,
  })
  return seen
}

const notRunningRoutes = mountConsole(false)
const consoleEntryOff = notRunningRoutes.find((r) => r.path === '/qqai/console')
const offRes = makeResponse()
await consoleEntryOff.handler(fakeRequest('GET'), offRes)
check('调试台没跑时：入口回一页"怎么启动"（不是死链）',
  offRes.out.status === 200 && offRes.out.body.includes('没有在运行')
  && offRes.out.body.includes('qq-control.mjs') && offRes.out.headers['content-type'].includes('text/html'),
  String(offRes.out.status))
const consoleCross = makeResponse()
await consoleEntryOff.handler(fakeRequest('GET', undefined, { origin: 'https://evil.example' }), consoleCross)
check('调试台入口也拒绝跨站（它会把带 token 的地址交出去）',
  consoleCross.out.status === 403, String(consoleCross.out.status))

const runningRoutes = mountConsole(true)
const consoleEntryOn = runningRoutes.find((r) => r.path === '/qqai/console')
const onRes = makeResponse()
await consoleEntryOn.handler(fakeRequest('GET'), onRes)
check('调试台在跑时：302 到带 token 的地址（省掉用户手抄 token）',
  onRes.out.status === 302 && String(onRes.out.headers.location).includes('127.0.0.1:8799/?token=')
  && String(onRes.out.headers.location).includes(FAKE_TOKEN),
  String(onRes.out.headers.location).replace(FAKE_TOKEN, '<token>'))
const panelRes = makeResponse()
await runningRoutes.find((r) => r.path === '/qqai/panel').handler(fakeRequest('GET'), panelRes)
check('面板载荷里**没有** token（密钥只走 302，不进 JSON）',
  !panelRes.out.body.includes(FAKE_TOKEN)
  && JSON.parse(panelRes.out.body).links.find((link) => link.id === 'console').running === true,
  `payload 含 token: ${panelRes.out.body.includes(FAKE_TOKEN)}`)
// 端口探测本身也要确定化：自己起一个临时端口来验"有人听"，再关掉验"没人听"。
const probeServer = createServer(() => {})
await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve))
const probePortNumber = probeServer.address().port
const reachable = await probePort(probePortNumber)
await new Promise((resolve) => probeServer.close(resolve))
const unreachable = await probePort(probePortNumber)
check('端口探测能分辨"有人听/没人听"（自己的临时端口，不碰 8799）',
  reachable === true && unreachable === false, `listen=${reachable} closed=${unreachable}`)
check('启动命令指向控制台入口脚本',
  consoleStartCommand({ root: fakeRoot }).includes(join('control', 'bin', 'qq-control.mjs')),
  consoleStartCommand({ root: fakeRoot }))

// ---- 「QQ助手账号」入口（NapCat WebUI 的免密钥跳转）----
// 落点与参数写法照 NapCat 4.18.28 前端实测：`/webui/?token=<明文 token>`（前端自己算 hash 再登录）。
const napcatRoot = join(dir, 'napcat-root')
mkdirSync(join(napcatRoot, 'bootmain', 'config'), { recursive: true })
const NAPCAT_TOKEN = 'nap-token-not-a-real-secret-9876'
writeFileSync(join(napcatRoot, 'qq-control.json'), JSON.stringify({
  ports: { control: 8799, napcat: 6099 },
  napcatBat: join(napcatRoot, 'bootmain', 'napcat.bat'),
}), 'utf8')
writeFileSync(join(napcatRoot, 'bootmain', 'config', 'webui.json'), JSON.stringify({ token: NAPCAT_TOKEN }), 'utf8')
writeFileSync(join(napcatRoot, 'bootmain', 'config', 'webui-notoken.json'), JSON.stringify({ token: '' }), 'utf8')
const accountUrl = napcatWebUiUrl({ pluginRoot: napcatRoot })
check('账号入口的落点是 NapCat 的 /webui/?token=（实测过的形状：带尾斜杠、明文 token）',
  accountUrl === `http://127.0.0.1:6099/webui/?token=${NAPCAT_TOKEN}`, accountUrl.replace(NAPCAT_TOKEN, '<token>'))
const badControlRoot = join(dir, 'napcat-bad')
mkdirSync(badControlRoot, { recursive: true })
writeFileSync(join(badControlRoot, 'qq-control.json'), '{ 这不是 JSON', 'utf8')
check('读不到控制台配置时：账号入口退回裸 /webui/（不抛、也不编 token）',
  napcatWebUiUrl({ pluginRoot: badControlRoot }) === 'http://127.0.0.1:6099/webui/'
  && napcatWebUiUrl({ pluginRoot: join(dir, 'definitely-missing') }) === 'http://127.0.0.1:6099/webui/',
  napcatWebUiUrl({ pluginRoot: badControlRoot }))
const noTokenRoot = join(dir, 'napcat-notoken')
mkdirSync(join(noTokenRoot, 'bootmain', 'config'), { recursive: true })
writeFileSync(join(noTokenRoot, 'qq-control.json'), JSON.stringify({
  ports: { napcat: 6201 }, napcatBat: join(noTokenRoot, 'bootmain', 'napcat.bat'),
}), 'utf8')
writeFileSync(join(noTokenRoot, 'bootmain', 'config', 'webui.json'), JSON.stringify({ token: '' }), 'utf8')
check('webui.json 里没有 token 时：只给裸地址，端口仍按 qq-control.json 走',
  napcatWebUiUrl({ pluginRoot: noTokenRoot }) === 'http://127.0.0.1:6201/webui/',
  napcatWebUiUrl({ pluginRoot: noTokenRoot }))

const accountRoutes = []
mountQqAiPanel({
  webServer: {
    register(route) { accountRoutes.push(route); return () => { const at = accountRoutes.indexOf(route); if (at >= 0) accountRoutes.splice(at, 1) } },
  },
}, {
  profile: 'web', config: {}, readFile: readFileSync, writeFile: writeFileSync, env,
  linkSources: { root: napcatRoot }, probe: async () => false,
})
const accountEntryRoute = accountRoutes.find((r) => r.path === '/qqai/account')
const accountRes = makeResponse()
await accountEntryRoute.handler(fakeRequest('GET'), accountRes)
check('GET /qqai/account → 302 到带 token 的 NapCat 页面（免手抄密钥）',
  accountRes.out.status === 302 && accountRes.out.headers.location === accountUrl
  && accountRes.out.headers['cache-control'] === 'no-store',
  String(accountRes.out.headers.location).replace(NAPCAT_TOKEN, '<token>'))
const accountCross = makeResponse()
await accountEntryRoute.handler(fakeRequest('GET', undefined, { origin: 'https://evil.example' }), accountCross)
check('账号入口拒绝跨站（它会把带 token 的地址交出去）',
  accountCross.out.status === 403, String(accountCross.out.status))
// 面板载荷里绝不能出现 NapCat 的 token（同"调试台 token 不进载荷"的规矩）。
const accountPanel = makeResponse()
await accountRoutes.find((r) => r.path === '/qqai/panel').handler(fakeRequest('GET'), accountPanel)
check('面板载荷里**没有** NapCat token（密钥只走 302）',
  !accountPanel.out.body.includes(NAPCAT_TOKEN))

dispose()
check('dispose 注销了全部路由（配置热重载后能重新挂载，不会撞 duplicate route）',
  registered.length === 0 && disposed.length === 4, `left=${registered.length}`)
mountQqAiPanel(fakeHost, {
  profile: 'web', config: {}, readFile: readFileSync, writeFile: writeFileSync, env,
})
check('注销后可以再次挂载（模拟宿主重建插件条目）', registered.length === 4, String(registered.length))

// ------------------------------------------------- 3. 客户端 bundle 冒烟 ---- ----
const clientText = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')
let loaded = null
const sandboxWindow = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
const fakeReact = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (fn) => fn }
try {
  /**
   * 严格照抄真实加载器的契约（dsh-client-modules/lib/client.js:683）：
   *   `exports: registered.factory(this.makeRequire(ownerId, edges))`
   *   —— 只传一个 `require`，取**返回值**当模块导出；而 bundle 本体是用经典
   *   `<script>` 注入的，所以页面作用域里**根本没有 `module` / `exports`**。
   * 这里就用同样的作用域（只有 window）与同样的调用方式跑一遍：
   * 少了 CJS 垫片、或依赖全局 exports 的 bundle 会在这里当场炸——
   * 这正是 v0.6 真机事故（`import failed: exports is not defined`）的复现条件。
   */
  // eslint-disable-next-line no-new-func
  const run = new Function('window', clientText)
  run(sandboxWindow)
  check('客户端 bundle 通过 __ModuleLoader__.load 注册', loaded?.id === 'dsh-qq-onebot-bridge', String(loaded?.id))
  check('客户端 bundle 自带 CJS 垫片（经典 script 里没有 exports/module）',
    clientText.includes('var module = { exports: {} }') && clientText.includes('var exports = module.exports'),
    '缺少垫片会让宿主启动直接失败')
  const requireStub = (name) => {
    if (name === 'react') return fakeReact
    throw new Error(`客户端 bundle 试图 require 未注入的包：${name}`)
  }
  const exported = loaded.factory(requireStub)
  check('客户端导出 inject=[slots] 与 apply()（取 factory 返回值，与加载器一致）',
    Array.isArray(exported?.inject) && exported.inject.includes('slots') && typeof exported.apply === 'function',
    brief(exported?.inject))
  let slotCall = null
  let registered2 = null
  exported.apply({
    slots: {
      // 真实注册表对**未声明的 slot 名**会抛错（stub 若来者不拒就永远发现不了写错的 slot 名）。
      inject: (name, factory) => {
        if (name !== 'settings.section') throw new Error(`unknown slot: ${name}`)
        slotCall = name
        registered2 = factory()
      },
      register: (options, render) => {
        if (options?.name !== 'settings.section') throw new Error(`slot mismatch: ${options?.name}`)
        return { options, render }
      },
    },
  })
  check('客户端把页面注册进 settings.section，id=qqai',
    slotCall === 'settings.section' && registered2?.options?.id === 'qqai'
    && typeof registered2.options.label() === 'string' && typeof registered2.render === 'function',
    brief({ slot: slotCall, id: registered2?.options?.id, label: registered2?.options?.label?.() }))
  check('设置页显示名是「QQ助手」（导航与标题同一处来源）',
    registered2?.options?.label?.() === 'QQ助手' && clientText.includes("'QQ助手'")
    && !/QQai/.test(clientText), registered2?.options?.label?.())
  check('客户端 fetch 的路由名与服务端注册的一致（防前后端漂移）',
    clientText.includes('/qqai/panel') && clientText.includes('/qqai/panel/set')
    && registered.some((r) => r.path === '/qqai/panel') && registered.some((r) => r.path === '/qqai/panel/set'))
  check('客户端会把底部链接渲染出来（放在页面最底下）',
    clientText.includes('qqai-footer') && clientText.includes('data.links')
    && clientText.includes("target: '_blank'") && clientText.includes('rel: \'noreferrer\''))
  // 开关必须照抄平台自己的 Switch.module.css——用户实测过一次"关了以后按钮像消失了"：
  // OFF 轨道用卡片同色 + 白色圆点，浅色主题下就是隐形。这里把官方的三个 token 钉死。
  check('开关用的是平台官方 Switch 的 token（OFF 轨道可见、OFF 圆点专用色）',
    clientText.includes('--dsw-alias-border-l3') && clientText.includes('--dsw-alias-switch-thumb')
    && clientText.includes('--dsw-alias-brand-primary')
    && !/\.qqai-switch\{[^}]*--dsw-alias-bg-layer-2/.test(clientText),
    '轨道/圆点必须用官方 token，别再用卡片同色')
  check('开关的语义挂在 role=switch + aria-checked（与官方一致，不再用 data-on）',
    clientText.includes("role: 'switch'") && clientText.includes("'aria-checked'")
    && !clientText.includes("'data-on'"))
} catch (error) {
  check('客户端 bundle 能被执行', false, String(error?.message ?? error))
}

// ---- 浅渲染冒烟：把面板组件（连同 Group/Row/Footer）真的跑一遍并收集文本 ----
// 上一轮审查指出：组件从未被渲染过，只比对源码字符串，写错一个字段名也发现不了。
// 这里用一个最小 React 桩（createElement 记元素树、函数组件被真的调用、useState 按序喂状态）。
const makeReactStub = () => {
  let slot = 0
  let states = []
  const stub = {
    setStates: (list) => { states = list; slot = 0 },
    resetSlot: () => { slot = 0 },
    createElement: (type, props, ...children) => ({
      type, props: { ...(props ?? {}), children: children.length > 0 ? children : undefined },
    }),
    useState: () => {
      const value = states[Math.min(slot, states.length - 1)]
      slot += 1
      return [value, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  return stub
}
const reactStub = makeReactStub()
const shallowText = (element, states) => {
  reactStub.setStates(states)
  const text = []
  const hrefs = []
  const switches = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return }
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node.type === 'function') { reactStub.resetSlot(); walk(node.type({ ...(node.props ?? {}) })); return }
    // 链接目标在属性上，不在文本里——单独收集，否则断言会"看着渲染出来了其实没验链接"。
    if (typeof node.props?.href === 'string') hrefs.push(node.props.href)
    // 开关的状态也只在属性上：收集起来验 aria-checked 的映射。
    if (node.props?.role === 'switch') switches.push({ checked: node.props['aria-checked'], disabled: node.props.disabled === true })
    walk(node.props?.children)
  }
  walk(element)
  return { text: text.join(' | '), hrefs, switches }
}
try {
  // 用同一个 React 桩重新执行一遍 bundle，拿到真正的面板组件（组件闭包里的 React 必须就是它）
  let spec = null
  // eslint-disable-next-line no-new-func
  new Function('window', clientText)({ __ModuleLoader__: { load: (loaded) => { spec = loaded } } })
  const exportedForRender = spec.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`客户端 bundle 试图 require 未注入的包：${name}`)
  })
  let element = null
  exportedForRender.apply({
    slots: {
      inject: (name, factory) => { if (name !== 'settings.section') throw new Error(name); element = factory() },
      register: (options, render) => ({ options, render }),
    },
  })
  const render = element.render()

  const loading = shallowText(render, [{ status: 'loading', data: null, error: '', flash: '', busyKey: '' }])
  check('浅渲染：加载态能渲染出来（不抛异常）', loading.text.includes('读取中…'), loading.text.slice(0, 70))

  const fixture = {
    status: 'ready',
    error: '',
    flash: 'ttsEnabled → 关（已写入配置）',
    busyKey: '',
    data: {
      profile: 'desktop',
      patchFile: '/srv/dsh/profiles/desktop/cordis.patch.yml',
      patchExists: true,
      notes: { apply: '写入说明', scope: '范围说明' },
      // 账号入口是**单独一个字段**（客户端渲染在「QQ助手」标题正下方），不在 links 里。
      account: {
        id: 'account',
        label: 'QQ助手账号（登录 / 扫码）',
        href: '/qqai/account',
        hint: '机器人账号的登录状态与扫码页；点开就是带 token 的地址，不用手输',
      },
      links: [
        { id: 'changelog', label: '更新日志（v9.9.9）', href: 'https://example.invalid/CHANGELOG.md', hint: '每个版本的改动' },
        { id: 'console', label: '调试台（独立控制台）', href: '/qqai/console', running: false, state: '未启动 · 需要单独运行：node x', hint: '调试台是独立进程' },
      ],
      groups: [{
        id: 'chat',
        title: '对话基础',
        advanced: false,
        rows: [{
          key: 'ttsEnabled',
          label: '语音回复',
          hint: '**需要额外的语音服务**：本地 GPT-SoVITS 或云端 TTS。',
          needs: '需外部服务',
          value: false,
          defaultValue: false,
          nonDefault: true,
          fileValue: true,
          pending: true,
        }],
      }],
    },
  }
  const ready = shallowText(render, [fixture])
  const readyText = ready.text
  check('浅渲染：标题/分组/开关标签与键名都出现',
    readyText.includes('QQ助手') && readyText.includes('对话基础') && readyText.includes('语音回复')
    && readyText.includes('ttsEnabled'), readyText.slice(0, 120))
  // 用户 2026-10-04 两轮修正的最终口径：账号入口在**「QQ助手」标题的下边**（不在底部"相关链接"里）。
  // 浅渲染按树的顺序收集文本，所以"先后"就是界面上的上下：标题 → 账号入口 → 第一个分组 → 底部链接。
  check('账号入口渲染在「QQ助手」标题正下方（在第一个分组之前）',
    readyText.includes('QQ助手账号（登录 / 扫码）') && readyText.includes('不用手输')
    && readyText.indexOf('QQ助手账号') > readyText.indexOf('QQ助手')
    && readyText.indexOf('QQ助手账号') < readyText.indexOf('对话基础'),
    readyText.slice(0, 160))
  check('账号入口的链接目标真的挂上了（/qqai/account）', ready.hrefs.includes('/qqai/account'), ready.hrefs.join(' | '))
  check('底部"相关链接"里不再重复一条账号入口（只有更新日志与调试台）',
    readyText.lastIndexOf('QQ助手账号') === readyText.indexOf('QQ助手账号')
    && readyText.includes('相关链接') && readyText.includes('更新日志（v9.9.9）'),
    readyText.slice(-160))
  check('浅渲染：直接显示出厂默认值（默认：开/关），不再出现"非默认"字样',
    readyText.includes('默认：关') && !readyText.includes('非默认'))
  const flipped = shallowText(render, [{
    ...fixture,
    data: {
      ...fixture.data,
      groups: [{
        ...fixture.data.groups[0],
        rows: [{ ...fixture.data.groups[0].rows[0], value: false, defaultValue: true, nonDefault: true, pending: false }],
      }],
    },
  }])
  check('浅渲染：默认开的那一行写「默认：开」',
    flipped.text.includes('默认：开') && !flipped.text.includes('非默认'), flipped.text.slice(0, 120))
  check('浅渲染：依赖标记与说明都渲染出来（** 被解析成加粗而不是原样显示）',
    readyText.includes('需外部服务') && readyText.includes('需要额外的语音服务')
    && !readyText.includes('**'), readyText.slice(-160))
  check('浅渲染：底部链接与调试台状态都渲染出来（链接目标查 href 属性）',
    readyText.includes('更新日志（v9.9.9）') && readyText.includes('调试台（独立控制台）')
    && ready.hrefs.includes('/qqai/console') && ready.hrefs.some((href) => href.includes('CHANGELOG.md'))
    && readyText.includes('未启动 · 需要单独运行：node x'),
    `${readyText.slice(-100)}  hrefs=${JSON.stringify(ready.hrefs)}`)

  const errorRendered = shallowText(render, [{ status: 'error', data: null, error: '连接失败', flash: '', busyKey: '' }])
  check('浅渲染：错误态把真原因显示出来（不是白屏）',
    errorRendered.text.includes('读取面板失败') && errorRendered.text.includes('连接失败'), errorRendered.text.slice(0, 90))
  // 开关的"开/关"必须真的映射到 aria-checked（视觉就是靠它上色的）
  check('浅渲染：开关状态映射到 aria-checked（关=false / 开=true）',
    ready.switches.length === 1 && ready.switches[0].checked === 'false', JSON.stringify(ready.switches))
  const onFixture = { ...fixture, data: { ...fixture.data, groups: [{ ...fixture.data.groups[0], rows: [{ ...fixture.data.groups[0].rows[0], value: true, pending: false }] }] } }
  const onRendered = shallowText(render, [onFixture])
  check('浅渲染：打开的行渲染成 aria-checked=true',
    onRendered.switches.length === 1 && onRendered.switches[0].checked === 'true', JSON.stringify(onRendered.switches))
} catch (error) {
  check('浅渲染冒烟', false, String(error?.message ?? error))
}

// ------------------------------------------------------------ 4. profile 解析 ----
check('argvProfile 从 --profile 取值', argvProfile(['node', 'x', '--profile', 'desktop']) === 'desktop')
check('argvProfile 没有该参数时返回 undefined',
  argvProfile(['node', 'x']) === undefined && argvProfile(['node', 'x', '--profile', '--other']) === undefined)
// 真机实测：官方桌面端**不传 --profile**，而是把 profile 目录当位置参数传进来。
// 这里用不存在的中性路径当夹具（隐私守卫不允许把本机真实路径写进仓库）。
const DESKTOP_ARGV = [
  '/opt/harness/Harness Desktop', '--expose-internals',
  '/opt/harness/app/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
  '/opt/harness/app/bundle',
  '/srv/dsh/profiles/desktop',
  '/opt/harness/runtime/primary-runtime',
]
check('resolveProfile 认得官方桌面端的位置参数（否则会改错 profile）',
  resolveProfile({ argv: DESKTOP_ARGV }).profile === 'desktop'
  && resolveProfile({ argv: DESKTOP_ARGV }).source === 'argv-path',
  JSON.stringify(resolveProfile({ argv: DESKTOP_ARGV })))
check('resolveProfile 仍然优先认 --profile',
  resolveProfile({ argv: [...DESKTOP_ARGV, '--profile', 'web'] }).profile === 'web'
  && resolveProfile({ argv: [...DESKTOP_ARGV, '--profile', 'web'] }).source === 'argv-flag')
check('resolveProfile 也认 --profile=<name> 这种写法',
  resolveProfile({ argv: ['node', 'bin.js', '--profile=tui'] }).profile === 'tui'
  && resolveProfile({ argv: ['node', 'bin.js', '--profile=tui'] }).source === 'argv-flag')
// 位置参数里直接给 profile 名：**只有该 profile 真实存在**才认（否则会把子命令名当 profile）。
const existsOnly = (target) => String(target).replace(/\\/g, '/').endsWith('/profiles/tui/cordis.patch.yml')
// 二轮审查核对 CLI 源码后**删掉了**"位置参数给 profile 名"这条分支：CLI 只认 `--profile`，
// 位置参数是给被启动应用用的普通参数，认了会把应用参数当 profile、写到别的配置去。
check('位置参数给的裸名字不再被当成 profile（如实回落，避免写错 profile）',
  resolveProfile({ argv: ['node', 'bin.js', 'tui'], exists: existsOnly }).profile === 'web'
  && resolveProfile({ argv: ['node', 'bin.js', 'tui'], exists: existsOnly }).source === 'fallback',
  JSON.stringify(resolveProfile({ argv: ['node', 'bin.js', 'tui'], exists: existsOnly })))
check('resolveProfile 对不存在的 profile 名不瞎认，仍回落 web',
  resolveProfile({ argv: ['node', 'bin.js', 'not-a-profile'], exists: () => false }).profile === 'web'
  && resolveProfile({ argv: ['node', 'bin.js', 'not-a-profile'], exists: () => false }).source === 'fallback',
  JSON.stringify(resolveProfile({ argv: ['node', 'bin.js', 'not-a-profile'], exists: () => false })))
check('resolveProfile 兼容末尾带斜杠的 profile 路径',
  resolveProfile({ argv: ['node', 'x', 'D:/dsh/profiles/desktop/'] }).profile === 'desktop')
check('profileDirOf 用 DSH_HOME 或 ~/.dsh',
  profileDirOf('web', { DSH_HOME: 'D:/tmp/dsh' }).endsWith(join('profiles', 'web'))
  && profileDirOf('web', {}).includes(join('profiles', 'web')),
  profileDirOf('web', { DSH_HOME: 'D:/tmp/dsh' }))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
