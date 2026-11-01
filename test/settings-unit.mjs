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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PANEL_FLAT_ROWS, PANEL_GROUPS, PANEL_KEYS, PANEL_NEEDS, PANEL_NOTES, PANEL_ROW_BY_KEY, QUIET_MAX_RANGES, extensionStatusLines, normalizeNumberList, normalizeQuietRanges, normalizeRepoUrl, panelFooterLinks, panelFooterLinksWithConsole,
  panelSnapshot, readPatchValue, upsertPatchValue,
} from '../lib/panel.js'
import { detectNapcatBat, planNapcatAction } from '../lib/napcat-launch.js'
import {
  argvProfile, consoleLaunchPlan, consoleStartCommand, mountQqAiPanel, napcatWebUiUrl, panelLinkSources, probePort, profileDirOf,
  redactSecrets, resolveProfile, sameSiteGuard, shimHeartbeatFresh, spawnBackgroundProcess, spawnDetachedProcess,
} from '../lib/settings-routes.js'
import { Config, configDefaults, numberMetaOf } from '../lib/index.js'

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
// 「开关 + 数值」合并行在界面上是**一行**、在配置里是**两个键**：
// 数"几个开关几个数值"必须用展开后的逐键表（PANEL_FLAT_ROWS），不能直接平铺分组。
const panelRows = PANEL_FLAT_ROWS
const boolRows = panelRows.filter((entry) => (entry.type ?? 'boolean') === 'boolean')
const numRows = panelRows.filter((entry) => entry.type === 'number')
check('面板里的每个开关都在 schema 里', missing.length === 0, missing.join(','))
check('面板里的每个**布尔**行都是布尔键（只有布尔才能当开关）',
  boolRows.every((entry) => String(dict[entry.key]?.type) === 'boolean'),
  boolRows.filter((entry) => String(dict[entry.key]?.type) !== 'boolean').map((entry) => entry.key).join(','))
/**
 * v0.6.7 数值控件：**类型与范围都必须和 schema 一致**。
 * 范围不在这里手抄——`numberMetaOf()` 从 schema 现读，这条只负责钉住"面板登记的就是 schema 的数值键"。
 */
const numberMeta = numberMetaOf()
/**
 * 数值行必须都是 schema 的 number 键、且单位写全。
 * 范围**不是每行都有**（例如 `botQq` 只要求是整数、schema 没有 min/max）：
 * 有范围的必须来自 schema（min<max），没范围的 snapshot 里必须是 `null`——不能变成 0（那会把输入夹死在 [0,0]）。
 */
check('面板里的每个**数值**行都是 schema 的数值键（有范围的由 schema 给，没范围的是 null）',
  numRows.length > 0 && numRows.every((entry) => {
    const meta = numberMeta[entry.key]
    if (String(dict[entry.key]?.type) !== 'number' || entry.unit === '' || meta === undefined) return false
    const hasRange = Number.isFinite(meta.min) && Number.isFinite(meta.max) && meta.max > meta.min
    if (hasRange) return true
    const row = panelSnapshot({}, { defaults: {}, numberMeta }).groups.flatMap((group) => group.rows)
      .find((item) => item.key === entry.key)
    return row?.min === null && row?.max === null
  }),
  numRows.filter((entry) => {
    const meta = numberMeta[entry.key]
    return String(dict[entry.key]?.type) !== 'number' || !meta
  }).map((entry) => entry.key).join(','))
check('★「每分钟会话上限」按需求登记：数值 1–10、默认 5，且**默认不开启**（用户 2026-10-16 两次确认）',
  numberMeta.chatTurnsPerMinute?.min === 1 && numberMeta.chatTurnsPerMinute?.max === 10
  && numberMeta.chatTurnsPerMinute?.default === 5
  && String(dict.chatTurnLimitEnabled?.type) === 'boolean' && dict.chatTurnLimitEnabled?.meta?.default === false
  && numRows.some((entry) => entry.key === 'chatTurnsPerMinute' && entry.unit === '条/分钟')
  && boolRows.some((entry) => entry.key === 'chatTurnLimitEnabled'),
  brief({ meta: numberMeta.chatTurnsPerMinute, enabledDefault: dict.chatTurnLimitEnabled?.meta?.default }))
check('面板分组都有 id/title 且开关不重复',
  PANEL_GROUPS.every((group) => group.id && group.title && group.rows.length > 0)
  && new Set(PANEL_KEYS).size === PANEL_KEYS.length,
  `${PANEL_GROUPS.length} 组 / ${PANEL_KEYS.length} 键（${boolRows.length} 开关 + ${numRows.length} 数值）`)

// ---- 说明必须"写全"（用户反馈：有些开关只写了标签，没说需要额外软件/模型）----
const needsVocabulary = new Set(Object.values(PANEL_NEEDS))
const allRows = PANEL_FLAT_ROWS
/**
 * ★ v0.7.8：面板 ↔ schema 的契约，只钉**一个方向**（面板键必须都在 schema 里）。
 *
 * 为什么不钉反方向：schema 有 234 个键，面板刻意只暴露常用的那部分
 * （连接地址、端口、token、模型参数、提示词都不进面板）。但反方向必须成立——
 * 面板里写了一个 schema 里不存在的键，用户点保存会被服务端拒掉，那就是"界面在、功能没有"的假开关。
 */
{
  const schemaKeys = new Set(Object.keys(Config({})))
  const missingInSchema = PANEL_KEYS.filter((key) => !schemaKeys.has(key))
  check('★★面板登记的每个键都在 schema 里（否则是"点了保存会被拒"的假开关）',
    missingInSchema.length === 0, JSON.stringify(missingInSchema.slice(0, 8)))
  const dupes = PANEL_KEYS.filter((key, index) => PANEL_KEYS.indexOf(key) !== index)
  check('★★面板键没有重复登记（重复会让一行覆盖另一行）', dupes.length === 0, JSON.stringify(dupes))
  check('面板是 schema 的**子集**（刻意只暴露常用的一部分）',
    PANEL_KEYS.length < schemaKeys.size && PANEL_KEYS.length >= 60,
    `面板 ${PANEL_KEYS.length} / schema ${schemaKeys.size}`)
  check('★面板说明里写清"其余键在配置文件里"（v0.7.8）',
    /cordis\.patch\.yml/.test(PANEL_NOTES.scope) && /常用/.test(PANEL_NOTES.scope),
    PANEL_NOTES.scope.slice(0, 40))
}
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
check('依赖分布合理（既有"开箱即用"也有需要准备的，且总数为 87 = 69 开关 + 12 数值 + 1 时段 + 3 名单 + 2 句式）',
  allRows.filter((entry) => entry.needs === '').length >= 5
  && allRows.filter((entry) => entry.needs !== '').length >= 20
  && allRows.length === 87
  && boolRows.length === 69 && numRows.length === 12
  && allRows.filter((entry) => entry.type === 'times').length === 1
  && allRows.filter((entry) => entry.type === 'list').length === 3
  && allRows.filter((entry) => entry.type === 'patterns').length === 2,
  `开箱即用 ${allRows.filter((entry) => entry.needs === '').length} / 需准备 ${allRows.filter((entry) => entry.needs !== '').length} / 共 ${allRows.length}`)
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

/**
 * ---- v0.6.7：数值键的读写（风控阈值）----
 * 面板从"只能开关"扩到"能改数值"，这条链路要三处都通：写进 YAML（还是数字，不是字符串）、
 * 读回来还是数字、同值写入幂等（否则每点一次都会重写文件）。
 */
{
  const numeric = upsertPatchValue(PATCH, 'chatTurnsPerMinute', 7)
  check('★upsert 能写数值键（写成数字字面量，不加引号）',
    numeric.ok === true && numeric.changed === true && /^ {4}chatTurnsPerMinute: 7$/m.test(numeric.yaml),
    numeric.reason)
  check('数值写回后能读成数字（不是字符串）',
    readPatchValue(numeric.yaml, 'chatTurnsPerMinute') === 7,
    String(readPatchValue(numeric.yaml, 'chatTurnsPerMinute')))
  check('数值同值写入幂等（changed=false，不重写文件）',
    upsertPatchValue(numeric.yaml, 'chatTurnsPerMinute', 7).changed === false)
  check('改数值会变（changed=true）',
    upsertPatchValue(numeric.yaml, 'chatTurnsPerMinute', 3).changed === true
    && /^ {4}chatTurnsPerMinute: 3$/m.test(upsertPatchValue(numeric.yaml, 'chatTurnsPerMinute', 3).yaml))
  check('upsert 拒绝小数（这几项 schema 都是 step(1)）',
    upsertPatchValue(PATCH, 'chatTurnsPerMinute', 3.5).ok === false)
  check('readPatchValue 不会把布尔读成数字、也不会把引号里的数字当数字',
    readPatchValue('    ttsEnabled: true\n', 'ttsEnabled') === null
    && readPatchValue('- id: dsh-qq-onebot-bridge\n  config:\n    n: "7"\n', 'n') === null)
}
/**
 * ★ v0.6.8 真机修复：插件可以作为 `dsh.profile.bundles` 成员挂载（挂载声明在**包自带 bundle 层**），
 * 这时 profile 的 `cordis.patch.yml` 里一条本插件条目都没有 —— 以前点任何开关都报
 * "没有 dsh-qq-onebot-bridge 条目"，现在必须**追加一条**（patch 的用途就是按 id 覆盖/追加）。
 */
const noEntry = upsertPatchValue('- id: other\n  config:\n    a: 1\n', 'ttsEnabled', true)
check('★upsert：patch 里没有本插件条目时**追加一条**（原有条目一字不动）',
  noEntry.ok === true && noEntry.changed === true
  && /^- id: dsh-qq-onebot-bridge$/m.test(noEntry.yaml)
  && /^\s+name: dsh-qq-onebot-bridge$/m.test(noEntry.yaml)
  && /^\s+config:$/m.test(noEntry.yaml) && /^\s{4}ttsEnabled: true$/m.test(noEntry.yaml)
  && noEntry.yaml.startsWith('- id: other\n  config:\n    a: 1\n'),
  brief(noEntry.yaml))
check('★upsert：追加出来的整份文件仍是合法 YAML（一条数组）',
  (() => { try { const doc = YAML.parse(noEntry.yaml); return Array.isArray(doc) && doc.length === 2 } catch { return false } })(),
  brief(noEntry.yaml))
check('★upsert：空文件 / 只有注释 / 空的 [] 都能写出条目',
  upsertPatchValue('', 'ttsEnabled', true).ok === true && /^- id: dsh-qq-onebot-bridge$/m.test(upsertPatchValue('', 'ttsEnabled', true).yaml)
  && upsertPatchValue('# 只有注释\n', 'ttsEnabled', true).ok === true
  && upsertPatchValue('[]\n', 'ttsEnabled', true).ok === true
  && !upsertPatchValue('[]\n', 'ttsEnabled', true).yaml.includes('[]'),
  brief(upsertPatchValue('[]\n', 'ttsEnabled', true).yaml))
check('★upsert：不是条目数组的 patch 仍然如实拒绝（不猜结构）',
  upsertPatchValue('plugins:\n  a: 1\n', 'ttsEnabled', true).ok === false)
const noConfig = upsertPatchValue('- id: dsh-qq-onebot-bridge\n  name: dsh-qq-onebot-bridge\n', 'ttsEnabled', true)
check('★upsert：条目存在但没有 config 块时补一个（不重复加条目）',
  noConfig.ok === true && (noConfig.yaml.match(/- id: dsh-qq-onebot-bridge/g) || []).length === 1
  && /^\s+config:$/m.test(noConfig.yaml) && /^\s{4}ttsEnabled: true$/m.test(noConfig.yaml),
  brief(noConfig.yaml))

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
check('「相关链接」里有更新日志与调试台，且链接由真实素材拼出',
  changelog?.href === 'https://github.com/me/repo/blob/main/CHANGELOG.md'
  && changelog.label.includes('9.9.9')
  && consoleLink?.href === 'http://127.0.0.1:8801/'
  && links.some((link) => link.id === 'readme-debug'),
  links.map((link) => `${link.id}=${link.href}`).join(' | '))
/**
 * 相关链接**不**放"问题反馈"（v0.7.0 一度加过，用户当场要求移除）：
 * 面板里只留账号 / 更新日志 / 调试文档 / 调试台四条，别再加第五条。
 */
check('★相关链接里没有"问题反馈"（五条：账号 / 更新日志 / 调试文档 / 调试台 / 账号中心）',
  !links.some((link) => link.id === 'feedback')
  && links.map((link) => link.id).join(',') === 'accounts,account,changelog,readme-debug,console',
  links.map((link) => link.id).join(','))
check('调试台链接里不含 token（本机密钥不进面板）',
  links.every((link) => !/token=/i.test(link.href)) && consoleLink.href.startsWith('http://127.0.0.1:'))
const bareLinks = panelFooterLinks({ version: '1.0.0', repoUrl: '', consolePort: 8799 })
check('没有仓库地址时只给账号入口、调试台与账号中心（不编造链接）',
  bareLinks.length === 3 && bareLinks.every((link) => ['account', 'console', 'accounts'].includes(link.id)),
  bareLinks.map((link) => link.id).join(','))
// 「NapCat 账号」= 机器人账号的登录/扫码页（NapCat WebUI）。href 指宿主自己的 /qqai/account：
// token 由服务端读出后走 302，**不进面板载荷**（同"调试台"入口的规矩）。
// ⚠️ 它**就是「相关链接」这一组里的第一条**（用户 2026-10-04 四条指示的最终口径：
// "应该把账号登陆调到最上方" → "不对不对应该在QQ助手的下边" →
//  "还是挪回到之前的位置吧，直接把相关链接整体拉到最上边" → "再把调试台和更新日志换一下位置"）。
// ⚠️ 它**就是「相关链接」这一组里的第一条**（用户 2026-10-04 **七条**指示的最终口径：
// "应该把账号登陆调到最上方" → "不对不对应该在QQ助手的下边" →
//  "还是挪回到之前的位置吧，直接把相关链接整体拉到最上边" → "再把调试台和更新日志换一下位置" →
//  "更新日志改到相关链接的最底下" → "嗯，还是把更新日志位置改回去吧" → "调试台改到调试文档下方"）。
const accountLink = links.find((link) => link.id === 'account')
check('账号中心排第一；账号入口在其后，且不带 token',
  accountLink?.href === '/qqai/account' && accountLink.label.includes('NapCat 账号')
  && !/token=/i.test(accountLink.href) && links[0]?.id === 'accounts' && bareLinks[0]?.id === 'accounts',
  `${brief(accountLink)} · 完整=${links.map((link) => link.id).join(',')}`)
check('顺序固定为 账号中心 → 账号 → 更新日志 → 调试文档 → 调试台',
  links.map((link) => link.id).join(',') === 'accounts,account,changelog,readme-debug,console'
  && bareLinks.map((link) => link.id).join(',') === 'accounts,account,console',
  `完整=${links.map((link) => link.id).join(',')} 无仓库=${bareLinks.map((link) => link.id).join(',')}`)
// 调试台是**独立进程**：面板必须如实标出"运行中/未启动"，并给出可复制的启动命令（否则用户对着"连不上"发懵）。
const offConsole = panelFooterLinksWithConsole({
  version: '1.0.0', repoUrl: '', consolePort: 8799, consoleRunning: false, startCommand: 'node x.mjs',
}).find((link) => link.id === 'console')
check('调试台没启动时：链接改指宿主入口，并说明"点一下会自动拉起"（手动命令仍给出来）',
  offConsole.href === '/qqai/console' && offConsole.running === false
  && offConsole.state.includes('未启动') && offConsole.state.includes('自动拉起')
  && offConsole.hint.includes('node x.mjs'),
  `${offConsole.state} ｜ ${offConsole.hint}`)
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
  // `cwd` 决定面板从哪读运行快照（qq-runtime.json）；不给就会去读仓库根目录那份旧的。
  config: { ttsEnabled: true, cwd: dir },
  // 用**真实**的 schema 默认值（v0.6.8 起含数值与时段默认）：面板的"默认："徽标就靠它。
  defaults: configDefaults(),
  readFile: readFileSync,
  writeFile: writeFileSync,
  copy: copyFileSync,
  exists: existsSync,
  ensureDir: (target) => mkdirSync(target, { recursive: true }),
  env,
  // 数值控件的范围来自 schema（真实宿主由 lib/index.js 传进来）——测试也要接上，
  // 否则数值写入会因为"范围未知"被拒（这是刻意的 fail closed）。
  numberMeta: numberMetaOf(),
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

check('挂载了九条路由（读面板 + 写开关 + 批量写 + 调试台 + 账号 + 二维码 + 启动 NapCat + 重启登录 + 账号中心）',
  registered.length === 9 && registered.some((r) => r.path === '/qqai/panel')
  && registered.some((r) => r.path === '/qqai/panel/set-batch')
  && registered.some((r) => r.path === '/qqai/panel/set') && registered.some((r) => r.path === '/qqai/console')
  && registered.some((r) => r.path === '/qqai/account') && registered.some((r) => r.path === '/qqai/napcat/start')
  && registered.some((r) => r.path === '/qqai/napcat/relogin') && registered.some((r) => r.path === '/qqai/napcat/qr')
  && registered.some((r) => r.path === '/qqai/accounts'),
  registered.map((r) => r.path).join(','))

const getHandler = registered.find((r) => r.path === '/qqai/panel').handler
const setHandler = registered.find((r) => r.path === '/qqai/panel/set').handler
// v0.6.8：合并写入单独一条路由（连点开关时前端攒批走它）。
const batchHandler = registered.find((r) => r.path === '/qqai/panel/set-batch').handler

const readRes = makeResponse()
await getHandler(fakeRequest('GET'), readRes)
const readBody = JSON.parse(readRes.out.body)
check('GET /qqai/panel 返回分组 + profile + 配置文件路径',
  readRes.out.status === 200 && readBody.ok === true && readBody.groups.length === PANEL_GROUPS.length
  && readBody.profile === 'web' && readBody.patchFile.endsWith('cordis.patch.yml'), brief({ status: readRes.out.status }))
check('GET 里带上"更新中"信息（生效值 vs 文件值）',
  readBody.groups.flatMap((g) => g.rows).find((row) => row.key === 'ttsEnabled')?.pending === false,
  brief(readBody.groups.flatMap((g) => g.rows).find((row) => row.key === 'ttsEnabled')))
check('GET 带上「相关链接」（账号入口 + 更新日志 + 调试台）',
  Array.isArray(readBody.links) && readBody.links.some((link) => link.id === 'changelog')
  && readBody.links.some((link) => link.id === 'console')
  && readBody.links.every((link) => typeof link.href === 'string' && link.href !== ''),
  brief(readBody.links?.map((link) => link.id)))
// 载荷形状：账号入口**就在 links 里**（第一条），没有单独的 account 字段——
// 客户端把整组渲染在标题正下方（用户 2026-10-04："直接把相关链接整体拉到最上边"）。
check('GET 的 links 第一条就是账号中心入口（没有额外的 account 字段）',
  readBody.links[0]?.id === 'accounts' && readBody.links[0]?.href === '/qqai/accounts'
  && readBody.account === undefined,
  brief({ account: readBody.account, links: readBody.links?.map((link) => link.id) }))
/**
 * ★ v0.6.8：载荷里必须带 `pluginVersion`，且等于 package.json 的版本。
 * 它是"宿主里正加载的那份代码"的版本——页面看不到新分组时，用户先看它就知道要不要重载。
 */
const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
check('★面板载荷带 pluginVersion（= package.json 的版本，用来判断宿主有没有重载）',
  typeof readBody.pluginVersion === 'string' && readBody.pluginVersion === pkgVersion,
  brief({ pluginVersion: readBody.pluginVersion }))
/**
 * ★ v0.6.9：这个值必须**每次现读**。宿主热重载复用 Node 的 ESM 模块缓存，把版本缓存在模块加载时
 * 会让面板永远报宿主启动那一刻的版本（真机实测 0.6.9 报成 0.6.8，前端还会误报「前端落后」）。
 */
check('★pluginVersion 是每次现读的（不是模块加载时的缓存常量）',
  (() => {
    const source = readFileSync(new URL('../lib/settings-routes.js', import.meta.url), 'utf8')
    return /function readPluginVersion\(\)/.test(source)
      && /pluginVersion: readPluginVersion\(\)/.test(source)
      && !/const PLUGIN_VERSION = \(/.test(source)
  })(),
  'settings-routes.js 里版本读取方式')
/**
 * ★ 前端 bundle 里那份 `CLIENT_VERSION` 必须与 package.json 一致：
 * 它是"页面攥着的前端是哪一版"的判据——不同步的话，横幅要么永远误报、要么永远不报。
 */
check('★客户端 CLIENT_VERSION 与 package.json 版本一致（横幅判据不能错位）',
  readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8').includes(`const CLIENT_VERSION = '${pkgVersion}'`),
  `期望 CLIENT_VERSION = '${pkgVersion}'`)
/**
 * ★ v0.6.8（用户 2026-10-19「为啥登陆了以后没有任何反馈啊」「但是能登上 NapCat」）：
 *   面板必须能回答"桥连上没有 / 最近有没有收到消息 / 为什么没回"。
 *   数据源是插件写的 `qq-runtime.json`；测试夹具里没有这个文件 ⇒ 必须如实报"还没有运行快照"，
 *   绝不能假装"在线"。
 */
check('★面板载荷带桥的运行状态（没有快照时如实说没有，不假装在线）',
  readBody.bridge !== undefined && typeof readBody.bridge === 'object'
  && readBody.bridge.present === false
  && typeof readBody.bridge.reason === 'string' && readBody.bridge.reason.includes('运行快照')
  && typeof readBody.bridge.file === 'string',
  brief(readBody.bridge))
// 真的放一份快照进去：入站时间、被拦原因都要能读出来。
{
  const snapshotFile = join(dir, 'qq-runtime.json')
  const now = Date.now()
  writeFileSync(snapshotFile, JSON.stringify({
    updatedAt: now,
    uptimeSeconds: 42,
    botOnline: true,
    trace: { total: 3, topReasons: [{ reason: 'whitelist: 私聊用户不在 allowUsers 白名单', count: 2 }] },
    recentTraces: [
      { id: 't-1', chatKey: 'u:2000000001', startedAt: now - 5000, stages: ['inbound'] },
      { id: 't-2', chatKey: 'g:3000000001', startedAt: now - 6000, stages: ['inbound'] },
      { id: 't-3', chatKey: 'u:2000000001', startedAt: now - 7000, stages: ['inbound'] },
    ],
  }), 'utf8')
  const res = makeResponse()
  await getHandler(fakeRequest('GET'), res)
  const body = JSON.parse(res.out.body)
  check('★有快照时：桥=已连接、账号在线、最近消息 5 秒前、被拦原因读得到',
    body.bridge?.present === true && body.bridge.botOnline === true
    && body.bridge.lastInboundAgoSeconds >= 4 && body.bridge.lastInboundAgoSeconds <= 8
    && body.bridge.topReason?.count === 2 && String(body.bridge.topReason.reason).includes('白名单'),
    brief(body.bridge))
  /**
   * ★ v0.6.8「快捷加入」：最近来信里的会话要按 user/group 分好、去掉重复——白名单面板拿它一键加号码。
   */
  check('★最近来信按 user/group 分好并去重（给白名单做一键加入）',
    Array.isArray(body.bridge.recentChats) && body.bridge.recentChats.length === 2
    && body.bridge.recentChats[0].kind === 'user' && body.bridge.recentChats[0].id === 2000000001
    && body.bridge.recentChats[1].kind === 'group' && body.bridge.recentChats[1].id === 3000000001,
    brief(body.bridge.recentChats))
  // 快照是**按需**写的（空闲时几分钟不更新很正常）⇒ 久没更新**不算**故障，仍显示"已连接"。
  writeFileSync(snapshotFile, JSON.stringify({ updatedAt: Date.now() - 120_000, trace: {}, recentTraces: [] }), 'utf8')
  const stale = makeResponse()
  await getHandler(fakeRequest('GET'), stale)
  check('★快照久没更新不算死（空闲≠故障：present 仍为 true，只有文件缺失才算没跑）',
    JSON.parse(stale.out.body).bridge?.present === true && JSON.parse(stale.out.body).bridge.ageSeconds > 60,
    brief(JSON.parse(stale.out.body).bridge))
  rmSync(snapshotFile, { force: true })
}

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

/**
 * ★ v0.6.7：数值控件（风控阈值）的写入校验。
 * 取值范围**由 schema 现读**（`numberMeta`），所以 11 必须被拒、7 必须通过，
 * 而且落盘的是一个**数字字面量**（`chatTurnsPerMinute: 7`），不是字符串。
 */
const numOk = makeResponse()
await setHandler(fakeRequest('POST', { key: 'chatTurnsPerMinute', value: 7 }, JSON_HEADERS), numOk)
const numOkBody = JSON.parse(numOk.out.body)
check('★POST 接受合法的数值（7，落在 1–10 内）并写进配置',
  numOk.out.status === 200 && numOkBody.ok === true && numOkBody.changed === true
  && /^\s*chatTurnsPerMinute: 7$/m.test(readFileSync(patchPath, 'utf8')),
  brief({ status: numOk.out.status, reason: numOkBody.reason }))
check('★数值写成功后回的面板里，该行带 schema 的范围、文件值是 7、且标成更新中',
  (() => {
    // 注意：这里挂载用的生效 config 里没有这个键（测试夹具），所以 value 走默认 5、
    // fileValue 是刚写进去的 7 ⇒ pending=true 是**正确**的（宿主热重载后才会变成 7）。
    // 数值键现在嵌在「开关 + 数值」合并行的 `number` 里，不再是顶层行。
    const combo = numOkBody.panel?.groups.flatMap((g) => g.rows).find((r) => r.key === 'chatTurnLimitEnabled')
    const row = combo?.number
    return combo?.type === 'switchNumber' && row?.key === 'chatTurnsPerMinute'
      && row.value === 5 && row.fileValue === 7
      && row.min === 1 && row.max === 10 && row.unit === '条/分钟' && row.pending === true
  })(),
  brief(numOkBody.panel?.groups.flatMap((g) => g.rows).find((r) => r.type === 'switchNumber')?.number))
/**
 * ★ v0.7.4：污点窗口时长（1–1440）走**同一条数值写入路径**。
 *   它是「开关 + 数值」合成行里的那个数字键，写盘时必须按数字写、越界必须拒 ——
 *   否则用户会改成一个不生效的值（0 分钟 = 窗口立刻过期，看着像"没生效"）。
 */
const taintNumOk = makeResponse()
await setHandler(fakeRequest('POST', { key: 'taintWindowMinutes', value: 45 }, JSON_HEADERS), taintNumOk)
check('★POST 接受污点窗口时长（45，落在 1–1440）并写进配置',
  taintNumOk.out.status === 200 && /^\s*taintWindowMinutes: 45$/m.test(readFileSync(patchPath, 'utf8')),
  brief({ status: taintNumOk.out.status }))
for (const [label, value] of [['0（下限外）', 0], ['1441（上限外）', 1441], ['小数（2.5）', 2.5]]) {
  const res = makeResponse()
  await setHandler(fakeRequest('POST', { key: 'taintWindowMinutes', value }, JSON_HEADERS), res)
  check(`★POST 拒绝污点窗口时长${label}，且不改文件`,
    res.out.status === 400 && /^\s*taintWindowMinutes: 45$/m.test(readFileSync(patchPath, 'utf8')),
    brief({ status: res.out.status, reason: JSON.parse(res.out.body).reason }))
}
for (const [label, value, expect] of [
  ['超上限（11）', 11, '范围'],
  ['低于下限（0）', 0, '范围'],
  ['小数（3.5）', 3.5, '整数'],
  ['字符串（"7"）', '7', '数值项'],
  ['布尔（true）', true, '数值项'],
]) {
  const res = makeResponse()
  await setHandler(fakeRequest('POST', { key: 'chatTurnsPerMinute', value }, JSON_HEADERS), res)
  const body = JSON.parse(res.out.body)
  check(`★POST 拒绝${label}，并把原因说清楚`,
    res.out.status === 400 && String(body.reason).includes(expect)
    && (expect !== '范围' || /1–10/.test(body.reason)),
    brief({ status: res.out.status, reason: body.reason }))
}
check('数值写入失败时**没有**改动配置文件（仍是 7）',
  /^\s*chatTurnsPerMinute: 7$/m.test(readFileSync(patchPath, 'utf8')),
  readFileSync(patchPath, 'utf8').split(/\r?\n/).find((line) => line.includes('chatTurnsPerMinute')) ?? '(无)')
/**
 * ★ v0.6.8：避开高峰期的时段列表（`quietHours`）。
 * 功能早就有、但面板里一个都没暴露；这里钉四件事：
 *   ① 三个键都在面板白名单里（开关/周末豁免/时段）；
 *   ② 时段按引擎口径归一化（`9:0-12:0` → `09:00-12:00`，跨夜合法，起止相同要拒，最多 8 段）；
 *   ③ 写进配置的是**流式数组**，且 `readPatchValue` 能读回（"更新中"才判得出来）；
 *   ④ 非法输入一律 400 且**不动文件**。
 */
const quietKeys = ['quietHoursEnabled', 'quietWeekendExempt', 'quietHours']
check('★避开高峰期的三个键都在面板白名单里',
  quietKeys.every((key) => PANEL_KEYS.includes(key)), quietKeys.filter((key) => !PANEL_KEYS.includes(key)).join(','))
const quietGroup = PANEL_GROUPS.find((group) => group.id === 'quiet')
check('★避开高峰期是一整组（开关 + 周末豁免 + 时段）',
  quietGroup !== undefined && quietGroup.title === '避开高峰期'
  && quietGroup.rows.map((row) => row.key).join(',') === 'quietHoursEnabled,quietWeekendExempt,quietHours'
  && quietGroup.rows.find((row) => row.key === 'quietHours')?.type === 'times',
  brief(quietGroup && quietGroup.rows.map((row) => `${row.key}:${row.type ?? 'boolean'}`)))
check('★时段归一化：`9:0-12:0` → `09:00-12:00`，跨夜 `22:00-6:00` → `22:00-06:00`',
  JSON.stringify(normalizeQuietRanges(['9:0-12:0'])) === JSON.stringify({ ok: true, ranges: ['09:00-12:00'], reason: '' })
  && JSON.stringify(normalizeQuietRanges(['22:00-6:00']).ranges) === JSON.stringify(['22:00-06:00']),
  brief(normalizeQuietRanges(['9:0-12:0'])))
/**
 * ★ v0.6.8（用户 2026-10-20「我设定了咋还是回复」）：时段绑在「避开高峰期」开关上，
 *   开关关着时服务端必须把 `inactive` 带给界面（界面据此显示琥珀色提醒）。
 */
check('★时段行会带上「开关关着所以不生效」的状态',
  (() => {
    const off = panelSnapshot({ quietHoursEnabled: false, quietHours: ['00:00-12:00'] }, { defaults: {}, numberMeta })
    const on = panelSnapshot({ quietHoursEnabled: true, quietHours: ['00:00-12:00'] }, { defaults: {}, numberMeta })
    const rowOff = off.groups.flatMap((group) => group.rows).find((row) => row.key === 'quietHours')
    const rowOn = on.groups.flatMap((group) => group.rows).find((row) => row.key === 'quietHours')
    return rowOff?.inactive === true && /避开高峰期/.test(rowOff.inactiveReason)
      && rowOn?.inactive !== true
  })(),
  brief(panelSnapshot({ quietHoursEnabled: false }, { numberMeta }).groups.flatMap((g) => g.rows).find((r) => r.key === 'quietHours')))
/**
 * ★ v0.6.8（用户 2026-10-20「不需要添加白名单的功能…但是群聊还是要 @ 的」）：
 *   `allowAllChats` 打开后两个名单失效 ⇒ 服务端要标 `inactive`，界面才不会让人以为"加了人不生效"。
 *   方向与时段的相反（这个开关**打开**才失效），由 `dependsActive: false` 表达。
 */
check('★「回应所有人」打开后两个名单标成不生效（方向与时段相反）',
  (() => {
    const rowsOf = (cfg) => panelSnapshot(cfg, { defaults: {}, numberMeta }).groups.flatMap((group) => group.rows)
    const off = rowsOf({ allowAllChats: false })
    const on = rowsOf({ allowAllChats: true })
    const pick = (rows, key) => rows.find((row) => row.key === key)
    return pick(off, 'allowUsers')?.inactive === false
      && pick(off, 'allowGroups')?.inactive === false
      && pick(on, 'allowUsers')?.inactive === true && /回应所有人/.test(pick(on, 'allowUsers').inactiveReason)
      && pick(on, 'allowGroups')?.inactive === true
  })(),
  brief(panelSnapshot({ allowAllChats: true }, { defaults: {}, numberMeta }).groups.flatMap((g) => g.rows).find((r) => r.key === 'allowUsers')))
for (const [label, value, expect] of [
  ['起止相同（9:00-9:00）', ['9:00-9:00'], '起止时间相同'],
  ['小时越界（7:00-25:00）', ['7:00-25:00'], '越界'],
  ['看不懂（abc）', ['abc'], '看不懂'],
  ['不是数组（"9:00-12:00"）', '9:00-12:00', '必须是数组'],
  ['超过 8 段', Array.from({ length: 9 }, (unused, index) => `${index}:00-${index + 1}:00`), '最多 8 段'],
]) {
  const result = normalizeQuietRanges(value)
  check(`★时段校验拒绝${label}并说明原因`,
    result.ok === false && String(result.reason).includes(expect), brief(result))
}
const quietOk = makeResponse()
await setHandler(fakeRequest('POST', { key: 'quietHours', value: ['9:0-12:0', '22:00-6:00'] }, JSON_HEADERS), quietOk)
const quietOkBody = JSON.parse(quietOk.out.body)
check('★POST 接受时段并**归一化后**写进配置（流式数组）',
  quietOk.out.status === 200 && quietOkBody.ok === true && quietOkBody.changed === true
  && /^\s*quietHours: \["09:00-12:00","22:00-06:00"\]$/m.test(readFileSync(patchPath, 'utf8')),
  brief({ status: quietOk.out.status, reason: quietOkBody.reason, line: readFileSync(patchPath, 'utf8').split(/\r?\n/).find((line) => line.includes('quietHours')) }))
check('★readPatchValue 能读回流式数组（"更新中"判得出来）',
  JSON.stringify(readPatchValue(readFileSync(patchPath, 'utf8'), 'quietHours')) === JSON.stringify(['09:00-12:00', '22:00-06:00']),
  brief(readPatchValue(readFileSync(patchPath, 'utf8'), 'quietHours')))
check('★时段写成功后回的面板里，该行带默认时段并标成更新中',
  (() => {
    // 夹具的生效 config 里没有 quietHours ⇒ value 回落 schema 默认（9:00-12:00 / 14:00-18:00），
    // fileValue 是刚写进去的归一化数组 ⇒ pending 正确。宿主热重载后 value 才会变成写进去的值。
    const row = quietOkBody.panel?.groups.flatMap((group) => group.rows).find((item) => item.key === 'quietHours')
    return row?.type === 'times'
      && JSON.stringify(row.value) === JSON.stringify(['9:00-12:00', '14:00-18:00'])
      && JSON.stringify(row.fileValue) === JSON.stringify(['09:00-12:00', '22:00-06:00'])
      && row.pending === true
      && Array.isArray(row.defaultValue) && row.maxRanges === QUIET_MAX_RANGES
  })(),
  brief(quietOkBody.panel?.groups.flatMap((group) => group.rows).find((item) => item.key === 'quietHours')))
const quietBad = makeResponse()
await setHandler(fakeRequest('POST', { key: 'quietHours', value: ['9:00-9:00'] }, JSON_HEADERS), quietBad)
check('★非法时段 400 且**不动文件**',
  quietBad.out.status === 400 && /起止时间相同/.test(JSON.parse(quietBad.out.body).reason)
  && /quietHours: \["09:00-12:00","22:00-06:00"\]/m.test(readFileSync(patchPath, 'utf8')),
  brief({ status: quietBad.out.status, reason: JSON.parse(quietBad.out.body).reason }))
const quietWrongType = makeResponse()
await setHandler(fakeRequest('POST', { key: 'quietHours', value: [1, 2] }, JSON_HEADERS), quietWrongType)
check('★时段里的非字符串被拒', quietWrongType.out.status === 400, quietWrongType.out.body.slice(0, 90))
const quietEmpty = makeResponse()
await setHandler(fakeRequest('POST', { key: 'quietHours', value: [] }, JSON_HEADERS), quietEmpty)
check('★空数组可以写（= 不静默任何时段）',
  quietEmpty.out.status === 200 && /^\s*quietHours: \[\]$/m.test(readFileSync(patchPath, 'utf8')),
  brief({ status: quietEmpty.out.status, line: readFileSync(patchPath, 'utf8').split(/\r?\n/).find((line) => line.includes('quietHours')) }))
/**
 * ★ 块写法（老配置常见：`quietHours:` 换行后缩进的 `- "9:00-12:00"`）写回时必须整段替换成流式序列，
 *   否则会留下孤立的 `- ...` 行 ⇒ 同一个键两处定义、YAML 直接坏掉。这条钉住"只剩一处 + 读得回来"。
 */
const blockYaml = [
  'plugins:',
  '  - id: dsh-qq-onebot-bridge',
  '    config:',
  '      quietHours:',
  '        - "9:00-12:00"',
  '        - "14:00-18:00"',
  '      ttsEnabled: true',
  '',
].join('\n')
const blockOut = upsertPatchValue(blockYaml, 'quietHours', ['09:00-12:00', '22:00-06:00'])
check('★块写法的时段被整段换成流式（不留孤立的 - 行，其它键与顺序不动）',
  blockOut.ok === true && blockOut.changed === true
  && (blockOut.yaml.match(/quietHours/g) || []).length === 1
  && /^\s*quietHours: \["09:00-12:00","22:00-06:00"\]$/m.test(blockOut.yaml)
  && blockOut.yaml.includes('ttsEnabled: true')
  && !/- "9:00-12:00"/.test(blockOut.yaml),
  brief(blockOut.yaml))
check('★块写法换完还能读回（"更新中"照常判）',
  JSON.stringify(readPatchValue(blockOut.yaml, 'quietHours')) === JSON.stringify(['09:00-12:00', '22:00-06:00']),
  brief(readPatchValue(blockOut.yaml, 'quietHours')))
// 恢复到默认两段，后面的断言（以及"配置没被弄坏"这条）继续按常规跑。
await setHandler(fakeRequest('POST', { key: 'quietHours', value: ['9:00-12:00', '14:00-18:00'] }, JSON_HEADERS), makeResponse())

/**
 * ★ v0.6.8：**合并写入**。连点几个开关时前端攒成一个批次发过来——一次写盘 ⇒ 宿主只重载一次
 * （每写一个键都重载一次的话，几次重载会互相打断，面板就"鬼畜"）。
 * 规矩：整批校验、整批写；有一条不合法就**一个字都不写**。
 */
const batchOk = makeResponse()
await batchHandler(fakeRequest('POST', { entries: [{ key: 'ttsEnabled', value: true }, { key: 'chatTurnsPerMinute', value: 9 }] }, JSON_HEADERS), batchOk)
const batchBody = JSON.parse(batchOk.out.body)
check('★批量写入：一次请求写多个键（count/keys 回报，两个键都落盘）',
  batchOk.out.status === 200 && batchBody.ok === true && batchBody.changed === true
  && batchBody.count === 2 && JSON.stringify(batchBody.keys) === JSON.stringify(['ttsEnabled', 'chatTurnsPerMinute'])
  && /^\s*ttsEnabled: true$/m.test(readFileSync(patchPath, 'utf8'))
  && /^\s*chatTurnsPerMinute: 9$/m.test(readFileSync(patchPath, 'utf8')),
  brief({ status: batchOk.out.status, count: batchBody.count, keys: batchBody.keys }))
const batchBad = makeResponse()
await batchHandler(fakeRequest('POST', { entries: [{ key: 'ttsEnabled', value: false }, { key: 'chatTurnsPerMinute', value: 99 }] }, JSON_HEADERS), batchBad)
check('★批量写入：有一条不合法就整批拒绝（不做部分写入——ttsEnabled 仍是 true）',
  batchBad.out.status === 400 && /99/.test(JSON.parse(batchBad.out.body).reason)
  && /^\s*ttsEnabled: true$/m.test(readFileSync(patchPath, 'utf8')),
  brief({ status: batchBad.out.status, reason: JSON.parse(batchBad.out.body).reason }))
const batchEmpty = makeResponse()
await batchHandler(fakeRequest('POST', { entries: [] }, JSON_HEADERS), batchEmpty)
check('★批量写入：空批次 400（不写盘）', batchEmpty.out.status === 400, batchEmpty.out.body.slice(0, 90))
const batchUnknown = makeResponse()
await batchHandler(fakeRequest('POST', { entries: [{ key: 'port', value: 1234 }] }, JSON_HEADERS), batchUnknown)
check('★批量写入：白名单外的键整批拒掉', batchUnknown.out.status === 400 && /白名单/.test(batchUnknown.out.body), batchUnknown.out.body.slice(0, 90))
// 还原这两个键，后面的断言继续按常规跑。
await batchHandler(fakeRequest('POST', { entries: [{ key: 'ttsEnabled', value: false }, { key: 'chatTurnsPerMinute', value: 5 }] }, JSON_HEADERS), makeResponse())
/**
 * ★ v0.6.8（用户 2026-10-19「做一个白名单添加面板」）：
 *   `allowUsers` / `allowGroups` 是 `z.array(z.number())`，而 OneBot 的 user_id 也是数字 ⇒
 *   写进去的必须是**数字**（写成字符串 `"2000000001"` 会让 `#allowed()` 的 includes 永远匹配不上）。
 */
/** ★ 2026-10-20 用户指定位置：「白名单放到对话基础下边」→ 后来又「拉到对话基础上边」：**第一组**。 */
check('★「AI账号与白名单」是**第一组**（在「对话基础」上面）',
  PANEL_GROUPS[0]?.id === 'whitelist' && PANEL_GROUPS[1]?.id === 'chat',
  brief(PANEL_GROUPS.slice(0, 3).map((group) => group.id)))
/**
 * ★ v0.7.0「实验性」组的运行时状态行（这是 issue #4 说的 `chips` 的替代方案）：
 *   不发明展示契约，直接如实报告 出口挂载 / provider / 最近一次注入。
 */
check('★「实验性」组的状态行：挂载机制 / provider / 最近一次注入',
  (() => {
    const lines = extensionStatusLines({ extensionToolsEnabled: true }, {
      mounted: { ok: true, via: 'ctx.provide', reason: '' },
      enabled: true,
      providers: ['my-plugin'],
      lastInjection: { chatKey: 'g:2002', tools: ['ext_a'], sections: ['ext:my-plugin:1'], skippedTotal: 1, skipped: ['my-plugin→撞名'] },
    })
    return lines.length === 3
      && /已挂载（via ctx\.provide）/.test(lines[0])
      && /已登记 provider：my-plugin/.test(lines[1])
      && /最近一次注入（g:2002）：1 个工具 \/ 1 段提示 · 跳过 1 项/.test(lines[2])
  })(),
  brief(extensionStatusLines({ extensionToolsEnabled: true }, { mounted: { ok: true, via: 'ctx.provide' }, providers: [] })))
check('★状态行在拿不到运行时数据时只说实话，不编造挂载结果',
  (() => {
    const lines = extensionStatusLines({ extensionToolsEnabled: false }, null)
    return lines.length === 1 && /未开启（默认关）/.test(lines[0])
  })())
/**
 * ★ 隐私（用户 2026-10-25「这个对隐私敏感的人真的没问题吗？不会以我盗窃他信息吧」）：
 *   用量计数**全 0 时整行不显示**（绝大多数人看不到任何"被统计"的字样）；
 *   有数字时也必须一句话讲清：**本机内存计数、不含内容、不外传、重启清零**。
 */
check('★用量计数全 0 时整行不显示（不给隐私敏感的人看到"被统计"的字样）',
  (() => {
    const lines = extensionStatusLines({}, {
      mounted: { ok: true, via: 'ctx.provide', reason: '' }, providers: [], lastInjection: null,
      usage: { sendText: 0, sendImage: 0, sendFile: 0, sendVoice: 0, recall: 0, react: 0 },
    })
    return lines.length === 3 && !lines.some((line) => /出口被调用/.test(line))
  })(),
  brief(extensionStatusLines({}, {
    mounted: { ok: true, via: 'ctx.provide' }, providers: [], lastInjection: null,
    usage: { sendText: 0, react: 0 },
  })))
check('★用量计数非 0 时明确写成"本机内存计数：不含内容 / 不外传 / 重启清零"',
  (() => {
    const lines = extensionStatusLines({}, {
      mounted: { ok: true, via: 'ctx.provide', reason: '' }, providers: [], lastInjection: null,
      usage: { sendText: 2, sendImage: 0, sendFile: 0, sendVoice: 0, recall: 0, react: 1 },
    })
    const line = lines.find((item) => /出口被调用/.test(item)) ?? ''
    return /本机计数/.test(line) && /不含消息内容/.test(line) && /不外传/.test(line) && /重启清零/.test(line)
      && /sendText 2/.test(line) && /react 1/.test(line)
  })())
check('运行时状态行会真的渲染出来（group.status）',
  (() => {
    const snap = panelSnapshot({ extensionToolsEnabled: true }, {
      defaults: {},
      numberMeta,
      extensions: { mounted: { ok: true, via: 'ctx.set', reason: '' }, providers: ['p1'], lastInjection: null },
    })
    const group = snap.groups.find((item) => item.id === 'experimental')
    return Array.isArray(group.status) && group.status.some((line) => /ctx\.set/.test(line))
      && group.status.some((line) => /还没有/.test(line))
  })())
/**
 * ★ v0.7.0：管理员名单（`adminUsers`）进面板 —— 以前只能改 YAML，而它是 /设管理、/批量踢 的准入门。
 *   三条钉子：① 它是「AI账号与白名单」组里的 list 行；② 标签写明"必须同时在允许的用户里"；
 *   ③ 组提示里也补了同一句（消息先过 allowUsers，管理员不在里面命令就不会响应）。
 */
check('★adminUsers 面板行存在，且标签与组提示都写明它受 allowUsers 约束',
  (() => {
    const group = PANEL_GROUPS.find((item) => item.id === 'whitelist')
    const row = group.rows.find((item) => item.key === 'adminUsers')
    return row !== undefined && row.type === 'list'
      && /管理员/.test(row.label)
      && /必须同时出现在「允许的用户」里/.test(String(row.hint))
      && /管理员名单里的号也必须出现在「允许的用户」里/.test(String(group.note))
  })(),
  brief(PANEL_GROUPS.find((item) => item.id === 'whitelist')?.rows.map((row) => `${row.key}:${row.type}`)))
/**
 * ★ 2026-10-20 用户改名：「白名单」→「**AI账号与白名单**」，并把 `botQq` 也收进这一组
 *   （三者是同一类东西：这是哪个机器人账号、它认谁）。
 */
check('★「AI账号与白名单」只放"谁能让它开口"（不放回复样式）',
  (() => {
    const group = PANEL_GROUPS.find((item) => item.id === 'whitelist')
    const chat = PANEL_GROUPS.find((item) => item.id === 'chat')
    return group !== undefined && group.title === 'AI账号与白名单'
      // 准入门（群里只理被 @ 的 / 允许私聊）和白名单是同一件事：谁能让它开口
      && group.rows.map((row) => `${row.key}:${row.type}`).join(',') === 'botQq:number,allowAllChats:boolean,replyOnlyWhenMentioned:boolean,acceptPrivate:boolean,allowUsers:list,allowGroups:list,adminUsers:list'
      // 对话基础里不再留这两个开关（避免两处都能改、看着像重复）
      && !chat.rows.some((row) => row.key === 'replyOnlyWhenMentioned' || row.key === 'acceptPrivate')
      /**
       * ★ v0.6.9（用户："回复带引用这玩意不应该放入别的列表里吗"）：
       * 「回复带引用」是**回复的样式**，不是"谁能让它开口" ⇒ 归「对话基础」，不塞进白名单组。
       */
      && chat.rows.some((row) => row.key === 'quoteReplyEnabled')
      && !group.rows.some((row) => row.key === 'quoteReplyEnabled')
  })(),
  brief(PANEL_GROUPS.find((item) => item.id === 'whitelist')?.rows.map((row) => `${row.key}:${row.type}`)))
for (const [label, value, expect] of [
  ['字符串号码（"2000000001"）', ['2000000001'], '只接受数字号码'],
  ['负数（-1）', [-1], '正整数'],
  ['小数（1.5）', [1.5], '正整数'],
  ['不是数组', '2000000001', '必须是数组'],
  ['超过 50 条', Array.from({ length: 51 }, (unused, index) => 1000000 + index), '最多 50 条'],
]) {
  const result = normalizeNumberList(value)
  check(`★白名单校验拒绝${label}并说明原因`,
    result.ok === false && String(result.reason).includes(expect), brief(result))
}
check('★白名单去重（同一个号码写两次只留一条）',
  JSON.stringify(normalizeNumberList([2000000001, 2000000001]).list) === JSON.stringify([2000000001]),
  brief(normalizeNumberList([2000000001, 2000000001])))
const allowOk = makeResponse()
await setHandler(fakeRequest('POST', { key: 'allowGroups', value: [3000000001] }, JSON_HEADERS), allowOk)
check('★POST 白名单写进配置（数字、不带引号）',
  allowOk.out.status === 200 && /^\s*allowGroups: \[3000000001\]$/m.test(readFileSync(patchPath, 'utf8'))
  && JSON.stringify(readPatchValue(readFileSync(patchPath, 'utf8'), 'allowGroups')) === JSON.stringify([3000000001]),
  brief({ status: allowOk.out.status, line: readFileSync(patchPath, 'utf8').split(/\r?\n/).find((line) => line.includes('allowGroups')) }))
const allowBad = makeResponse()
await setHandler(fakeRequest('POST', { key: 'allowUsers', value: ['2000000001'] }, JSON_HEADERS), allowBad)
check('★POST 拒绝字符串号码（会把白名单变成永远匹配不上的死配置）',
  allowBad.out.status === 400 && /只接受数字号码/.test(JSON.parse(allowBad.out.body).reason),
  brief(JSON.parse(allowBad.out.body).reason))
/**
 * ★ v0.7.0：新进面板的 `adminUsers` 也必须能**真的写进配置**（和 allowGroups 同一条路）。
 *   它同样是 `z.array(z.number())` —— 写成字符串会让 `#isAdmin()` 的 includes 永远匹配不上，
 *   于是"填了管理员却什么命令都不响应"，而且**不报错**。
 */
const adminOk = makeResponse()
await setHandler(fakeRequest('POST', { key: 'adminUsers', value: [100000003] }, JSON_HEADERS), adminOk)
check('★POST 管理员名单写进配置（数字、不带引号），且能读回来',
  adminOk.out.status === 200
  && /^\s*adminUsers: \[100000003\]$/m.test(readFileSync(patchPath, 'utf8'))
  && JSON.stringify(readPatchValue(readFileSync(patchPath, 'utf8'), 'adminUsers')) === JSON.stringify([100000003]),
  brief({ status: adminOk.out.status, line: readFileSync(patchPath, 'utf8').split(/\r?\n/).find((line) => line.includes('adminUsers')) }))
const adminBad = makeResponse()
await setHandler(fakeRequest('POST', { key: 'adminUsers', value: ['100000003'] }, JSON_HEADERS), adminBad)
check('★POST 也拒绝把管理员写成字符串（否则永远匹配不上）',
  adminBad.out.status === 400 && /只接受数字号码/.test(JSON.parse(adminBad.out.body).reason),
  brief(JSON.parse(adminBad.out.body).reason))
/**
 * ★★ v0.7.8（实验性）：自定义注入句式 `taintExtraPatterns` 走面板写入路径。
 *   与白名单的关键差别：这里必须是**字符串原文**（正则里的 `\` `.` 一个都不能丢），
 *   而且坏正则要在**点保存时**就被拒（而不是等某条消息进来才炸）。
 */
const patternOk = makeResponse()
await setHandler(fakeRequest('POST', { key: 'taintExtraPatterns', value: ['把.*(配置|密钥).*发(给)?我'] }, JSON_HEADERS), patternOk)
check('★★POST 自定义句式写进配置（字符串原样保留，反斜杠/括号不丢）',
  patternOk.out.status === 200
  && JSON.stringify(readPatchValue(readFileSync(patchPath, 'utf8'), 'taintExtraPatterns')) === JSON.stringify(['把.*(配置|密钥).*发(给)?我']),
  brief({ status: patternOk.out.status, reason: JSON.parse(patternOk.out.body).reason }))
for (const [label, value, expect] of [
  ['坏正则', ['(?<bad'], '正则不合法'],
  ['不是字符串', [123], '必须是字符串'],
  ['超长（201 字）', ['x'.repeat(201)], '最多 200 字'],
  ['不是数组', '把.*发我', '必须是数组'],
]) {
  const before = readFileSync(patchPath, 'utf8')
  const res = makeResponse()
  await setHandler(fakeRequest('POST', { key: 'taintExtraPatterns', value }, JSON_HEADERS), res)
  check(`★★POST 拒绝自定义句式的${label}，且不改文件`,
    res.out.status === 400 && String(JSON.parse(res.out.body).reason).includes(expect)
    && readFileSync(patchPath, 'utf8') === before,
    brief({ status: res.out.status, reason: JSON.parse(res.out.body).reason }))
}
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

/**
 * v0.6.4：调试台支持**一键拉起** —— 没在跑时入口自己起一个（普通 node 进程，不需要提权）。
 * 测试里把 spawnBackground 注入掉（**绝不真的起进程**），`flipAfter` 用来模拟"起来要等一会儿"。
 */
const mountConsole = (running, { flipAfter = 0, withEntry = true } = {}) => {
  const seen = []
  const spawns = []
  let probes = 0
  const hostStub = {
    webServer: {
      register(route) { seen.push(route); return () => { const at = seen.indexOf(route); if (at >= 0) seen.splice(at, 1) } },
    },
  }
  mountQqAiPanel(hostStub, {
    profile: 'web', config: {}, readFile: readFileSync, writeFile: writeFileSync, env,
    linkSources: { root: fakeRoot },
    probe: async () => { probes += 1; return flipAfter > 0 && probes > flipAfter ? true : running },
    exists: (file) => (withEntry || !String(file).endsWith('qq-control.mjs')),
    consoleWaitMs: flipAfter > 0 ? 1200 : 0,
    spawnBackground: ({ command, args, cwd, env }) => { spawns.push({ command, args, cwd, env }); return { pid: 4321 } },
  })
  return { routes: seen, spawns }
}

// ① 启动计划（纯函数；exists 注入，免得依赖临时目录里真有没有入口文件）
{
  const plan = consoleLaunchPlan({ root: fakeRoot, execPath: 'C:\\node\\node.exe', exists: () => true })
  check('consoleLaunchPlan：用宿主自己的 node 跑控制台入口，cwd 指插件根',
    plan.ok === true && plan.command === 'C:\\node\\node.exe'
    && plan.args.length === 1 && String(plan.args[0]).endsWith('qq-control.mjs') && plan.cwd === fakeRoot,
    brief(plan))
  const missing = consoleLaunchPlan({ root: join(fakeRoot, 'nope'), exists: () => false })
  check('consoleLaunchPlan：入口不存在时明确拒绝（不假装能起）',
    missing.ok === false && missing.reason.includes('找不到控制台入口'), brief(missing))
  /**
   * ★ 2026-10-16 真机抓到：**桌面端的 `process.execPath` 是 Electron 本体**，直接拿它跑 .mjs
   *   会被当成"一个 Electron 应用的入口"再开一个完整实例（实测控制台进程的命令行就是
   *   `"…\DeepSeek Harness.exe" …\qq-control.mjs`）。官方文档的解法是 `ELECTRON_RUN_AS_NODE`。
   */
  check('consoleLaunchPlan：桌面端（Electron）补 ELECTRON_RUN_AS_NODE=1，不再开第二个 Electron 实例',
    consoleLaunchPlan({ root: fakeRoot, execPath: 'D:\\app\\DeepSeek Harness.exe', exists: () => true, electron: true }).env?.ELECTRON_RUN_AS_NODE === '1',
    brief(consoleLaunchPlan({ root: fakeRoot, execPath: 'D:\\app\\DeepSeek Harness.exe', exists: () => true, electron: true }).env))
  check('consoleLaunchPlan：CLI 宿主（真 node.exe）不补这个变量',
    consoleLaunchPlan({ root: fakeRoot, execPath: 'C:\\node\\node.exe', exists: () => true, electron: false }).env === null)
}

// ② 没在跑 + 拉得起来 ⇒ 直接 302 进去（这就是"一键拉起"）
{
  const startable = mountConsole(false, { flipAfter: 1 })
  const autoRes = makeResponse()
  await startable.routes.find((r) => r.path === '/qqai/console')
    .handler(fakeRequest('GET', undefined, { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' }), autoRes)
  check('★点「调试台」时它没在跑 → 自动拉起并 302 进带 token 的地址（一键，不用敲命令）',
    autoRes.out.status === 302
    && String(autoRes.out.headers.location).includes(`127.0.0.1:8799/?token=${FAKE_TOKEN}`)
    && startable.spawns.length === 1
    && String(startable.spawns[0].args[0]).endsWith('qq-control.mjs') && startable.spawns[0].cwd === fakeRoot,
    `status=${autoRes.out.status} spawns=${startable.spawns.length}`)
  /**
   * `spawnBackgroundProcess` 只**追加**注入的 env（不能覆盖宿主环境，否则 PATH/代理/DSH_* 全丢）。
   */
  {
    const seen = []
    const spawned = spawnBackgroundProcess({
      command: 'D:\\app\\DeepSeek Harness.exe', args: ['x.mjs'], cwd: fakeRoot,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      spawnImpl: (command, args, options) => { seen.push(options); return { pid: 1, unref() {} } },
    })
    // 注意：宿主环境**本身可能就带着** ELECTRON_RUN_AS_NODE（DSH 给工具子进程设过），
    // 所以判据是"宿主原有的键一个不少 + 我们的键被设上"，不是"键数 +1"。
    const missing = Object.keys(process.env).filter((key) => !(key in (seen[0].env ?? {})))
    check('★后台拉起把 env 合并进宿主环境（宿主变量一个不少，只追加）',
      spawned.pid === 1 && seen[0].env?.ELECTRON_RUN_AS_NODE === '1' && missing.length === 0
      && seen[0].windowsHide === true && seen[0].detached === undefined,
      brief({ missing, merged: Object.keys(seen[0].env ?? {}).length }))
    const noEnv = []
    spawnBackgroundProcess({ command: 'node.exe', args: ['x.mjs'], spawnImpl: (command, args, options) => { noEnv.push(options); return { pid: 2, unref() {} } } })
    check('不传 env 时不塞 env 字段（走宿主默认环境）', noEnv[0].env === undefined, brief(Object.keys(noEnv[0])))
  }
}

// ③ 拉起后端口一直不通 ⇒ 如实说明（页面与 JSON 都带原因）
{
  const stuck = mountConsole(false, { flipAfter: 0 })
  const stuckRes = makeResponse()
  await stuck.routes.find((r) => r.path === '/qqai/console').handler(fakeRequest('GET'), stuckRes)
  check('★拉起后端口一直不通 → 页面如实说明"已经拉起进程但端口没通"，并给出手动命令',
    stuckRes.out.status === 200 && stuckRes.out.body.includes('没能自动起来')
    && stuckRes.out.body.includes('端口 8799 还没通') && stuckRes.out.body.includes('qq-control.mjs'),
    String(stuckRes.out.status))
  const stuckJson = makeResponse()
  await stuck.routes.find((r) => r.path === '/qqai/console').handler(
    { method: 'GET', url: '/qqai/console?format=json', headers: {}, socket: null, async *[Symbol.asyncIterator]() {} },
    stuckJson)
  const stuckBody = JSON.parse(stuckJson.out.body)
  check('★`?format=json` 带出"拉起了但没通"的原因（桌面端据此提示）',
    stuckJson.out.status === 200 && stuckBody.ok === false && stuckBody.running === false
    && stuckBody.started === true && stuckBody.pid === 4321 && String(stuckBody.reason).includes('还没通'),
    brief(stuckBody))
}

// ④ 入口文件缺失 ⇒ 不硬拉，如实拒绝
{
  const noEntry = mountConsole(false, { withEntry: false })
  const noEntryRes = makeResponse()
  await noEntry.routes.find((r) => r.path === '/qqai/console').handler(fakeRequest('GET'), noEntryRes)
  check('★控制台入口文件不存在时不硬拉，页面上写明原因',
    noEntry.spawns.length === 0 && noEntryRes.out.body.includes('找不到控制台入口'),
    String(noEntryRes.out.status))
}

const notRunningRoutes = mountConsole(false).routes
const consoleEntryOff = notRunningRoutes.find((r) => r.path === '/qqai/console')
const offRes = makeResponse()
await consoleEntryOff.handler(fakeRequest('GET'), offRes)
check('调试台没跑时：入口不再是死链（回一页说明 + 手动命令）',
  offRes.out.status === 200 && offRes.out.body.includes('没能自动起来')
  && offRes.out.body.includes('qq-control.mjs') && offRes.out.headers['content-type'].includes('text/html'),
  String(offRes.out.status))
check('★拉起了但没确认到端口 → 说明页会自己再试一次（带 retry 标记，不会无限循环）',
  offRes.out.body.includes("location.replace(location.pathname + '?retry=1')")
  && offRes.out.body.includes('if (true && !new URLSearchParams'),
  offRes.out.body.includes('retry=1') ? '含一次性重试脚本' : '没有重试脚本')

// ★真机踩到的坑：端口通了但 token 还没落盘 ⇒ 绝不能拿一条"没有 token 的地址"把用户送进去
//   （那版页面满屏"token 无效"、点哪都没反应，看起来就像"只是个页面"）。
{
  const noTokenRoot = mkdtempSync(join(tmpdir(), 'qq-console-notoken-'))
  writeFileSync(join(noTokenRoot, 'qq-control.json'), JSON.stringify({ ports: { control: 8799 } }), 'utf8')
  const seen = []
  const hostStub = { webServer: { register(route) { seen.push(route); return () => {} } } }
  mountQqAiPanel(hostStub, {
    profile: 'web', config: {}, readFile: readFileSync, writeFile: writeFileSync, env,
    linkSources: { root: noTokenRoot },
    probe: async () => true, exists: () => true, consoleWaitMs: 0, consoleTokenWaitMs: 0,
    spawnBackground: () => ({ pid: 1 }),
  })
  const res = makeResponse()
  await seen.find((r) => r.path === '/qqai/console').handler(
    { method: 'GET', url: '/qqai/console?format=json', headers: {}, socket: null, async *[Symbol.asyncIterator]() {} }, res)
  const body = JSON.parse(res.out.body)
  check('★控制台在跑但读不到 token 时如实标出 tokenReady:false（而不是给一条"无效地址"）',
    body.ok === true && body.running === true && body.tokenReady === false && !String(body.url).includes('token='),
    brief(body))
  rmSync(noTokenRoot, { recursive: true, force: true })
}
const consoleCross = makeResponse()
await consoleEntryOff.handler(fakeRequest('GET', undefined, { origin: 'https://evil.example' }), consoleCross)
check('调试台入口也拒绝跨站（它会把带 token 的地址交出去）',
  consoleCross.out.status === 403, String(consoleCross.out.status))
// ★ 同一个"点了没反应"的坑：浏览器点「调试台」是导航请求（same-origin、无 Origin），必须放行。
const consoleNav = makeResponse()
await consoleEntryOff.handler(fakeRequest('GET', undefined, {
  'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
  accept: 'text/html,*/*',
}), consoleNav)
check('★浏览器点「调试台」（导航：same-origin、无 Origin）也放行 —— 同样的坑，这个从 v0.6.0 起就是坏的',
  consoleNav.out.status === 200 && consoleNav.out.headers['content-type'].includes('text/html'),
  String(consoleNav.out.status))
// 桌面端同样拿不到相对地址：`?format=json` 要如实说"没在跑 + 启动命令"
const consoleJson = makeResponse()
await consoleEntryOff.handler(
  { method: 'GET', url: '/qqai/console?format=json', headers: {}, socket: null, async *[Symbol.asyncIterator]() {} },
  consoleJson)
const consoleJsonBody = JSON.parse(consoleJson.out.body)
check('调试台入口的 `?format=json` 回 `{ok:false, running:false, command}`（桌面端据此提示）',
  consoleJson.out.status === 200 && consoleJsonBody.ok === false && consoleJsonBody.running === false
  && String(consoleJsonBody.command).includes('qq-control.mjs'),
  brief(consoleJsonBody))
const consoleSameSite = makeResponse()
await consoleEntryOff.handler(fakeRequest('GET', undefined, { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' }), consoleSameSite)
check('调试台入口仍然拒绝"同站不同端口"（same-site）', consoleSameSite.out.status === 403, String(consoleSameSite.out.status))

const runningRoutes = mountConsole(true).routes
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

// ---- 「NapCat 账号」入口（NapCat WebUI 的免密钥跳转）----
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
/**
 * ✋ 2026-10-04 真机事故回归：**浏览器点链接的请求头形状**。
 * 当时面板里「NapCat 账号」「调试台」点了完全没反应 —— 因为浏览器发导航请求时是
 * `Sec-Fetch-Site: same-origin` + **不带 Origin**，而守卫的"没有 Origin"分支只放行 `''`/`none`，
 * 于是正常点击被判成"来源不明的请求" → 403。我当时的 smoke 手动补了 `Origin`，正好走另一分支，
 * 所以没测出来。下面把这四种真实形状**逐个钉死**（这才是测试该覆盖的东西，不是我自己编的头）。
 */
const navHeaders = (site) => ({
  'sec-fetch-site': site,
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-user': '?1',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36',
})
const accountNav = makeResponse()
await accountEntryRoute.handler(fakeRequest('GET', undefined, navHeaders('same-origin')), accountNav)
check('★浏览器点链接（导航：same-origin、无 Origin）必须 302 —— 这次"点了没反应"的根因',
  accountNav.out.status === 302 && accountNav.out.headers.location === accountUrl,
  `${accountNav.out.status} ${String(accountNav.out.headers.location ?? accountNav.out.body).slice(0, 80)}`)
/**
 * ★ 桌面端（渲染基址 `dsh-app://app/`）点不动账号入口：桌面主窗口只放行 http(s) 外链到系统浏览器，
 * 相对地址 `dsh-app://app/qqai/account` 会被直接 deny。所以给客户端一条 `?format=json` 的路：
 * 它拿到**绝对 http 地址**再自己开。这里把两种形状都钉住。
 */
const accountJson = makeResponse()
await accountEntryRoute.handler({ method: 'GET', url: '/qqai/account?format=json', headers: {}, socket: null, async *[Symbol.asyncIterator]() {} }, accountJson)
check('★`?format=json` 回的是绝对地址（桌面端拿它自己开），不是 302',
  accountJson.out.status === 200 && JSON.parse(accountJson.out.body).url === accountUrl,
  String(accountJson.out.body).replace(NAPCAT_TOKEN, '<token>'))
const accountJsonCross = makeResponse()
await accountEntryRoute.handler(
  { method: 'GET', url: '/qqai/account?format=json', headers: { origin: 'https://evil.example' }, socket: null, async *[Symbol.asyncIterator]() {} },
  accountJsonCross)
check('`?format=json` 同样受守卫保护（跨站拿不到带 token 的地址）', accountJsonCross.out.status === 403, String(accountJsonCross.out.status))
// 上面那条测试用的是**真实浏览器发不出来的**组合（Origin=evil + same-origin 标记）。
// 这里显式记录服务端的语义：`sec-fetch-site: same-origin` 单独就够（浏览器按发起方 URL 算的，
// 页面改不了；代理场景下 Origin 与 Host 本来就可能不等）。改动这条守卫前先看 lib 里的注释。
check('记录：same-origin 标记被单独信任（不是漏洞，是为代理场景有意留的）',
  sameSiteGuard({ headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' } }, { requireJson: false }).ok === true
  && sameSiteGuard({ headers: { origin: 'https://evil.example' } }, { requireJson: false }).ok === false,
  '前者浏览器发不出来；后者才是真实跨站请求的形状 → 必须拒')
const accountAddressBar = makeResponse()
await accountEntryRoute.handler(fakeRequest('GET', undefined, navHeaders('none')), accountAddressBar)
check('地址栏直达（sec-fetch-site: none）也 302', accountAddressBar.out.status === 302, String(accountAddressBar.out.status))
const accountScript = makeResponse()
await accountEntryRoute.handler(fakeRequest('GET'), accountScript)
check('本机脚本 / curl（没有任何 Sec-Fetch 标记）仍 302', accountScript.out.status === 302, String(accountScript.out.status))
const accountSameSite = makeResponse()
await accountEntryRoute.handler(fakeRequest('GET', undefined, navHeaders('same-site')), accountSameSite)
check('同站不同端口（sec-fetch-site: same-site）仍然拒 —— 本机别的服务不得拿走 token',
  accountSameSite.out.status === 403, String(accountSameSite.out.status))
const accountCrossNav = makeResponse()
await accountEntryRoute.handler(fakeRequest('GET', undefined, navHeaders('cross-site')), accountCrossNav)
check('跨站导航（别的网站上的 <a href> 指过来）仍然 403', accountCrossNav.out.status === 403, String(accountCrossNav.out.status))
// 面板载荷里绝不能出现 NapCat 的 token（同"调试台 token 不进载荷"的规矩）。
const accountPanel = makeResponse()
await accountRoutes.find((r) => r.path === '/qqai/panel').handler(fakeRequest('GET'), accountPanel)
check('面板载荷里**没有** NapCat token（密钥只走 302）',
  !accountPanel.out.body.includes(NAPCAT_TOKEN))

/**
 * ---- 快捷操作：启动 NapCat / 重新登录（用户："不能自己快捷启动吗？比如加到哪个控制选项中"）----
 * 决策逻辑是纯函数（`planNapcatAction`），执行走注入的 spawnDetached —— 测试**绝不真的拉进程**。
 */
/**
 * 一条快捷操作的"有效命令文本" = 提权命令 + 它要执行的垫片脚本内容。
 * 2026-10-04 起真正的脏活（cd /d、call launcher.bat、taskkill、日志重定向）都在垫片里，
 * 提权命令只指向垫片路径——所以断言要看这两者合起来，别只看 args。
 */
const planText = (plan) => `${(plan.args ?? []).join(' ')}\n${plan.shim?.content ?? ''}`

const planStart = planNapcatAction('start', {
  bat: 'C:\\NapCat\\bootmain\\launcher.bat', running: false, loaders: [], exists: () => true,
  logFile: 'C:\\QQAI\\qq-napcat-launch.log', shimFile: 'C:\\QQAI\\qq-napcat-launch.cmd',
})
check('快捷启动：没在跑时给出提权启动命令（两条分支都套 RunAs —— 才能脱离宿主进程树）',
  planStart.ok === true && planText(planStart).includes("Verb = 'RunAs'")
  && planText(planStart).includes('launcher.bat'),
  planText(planStart).slice(-140))
check('快捷启动：已经在跑时不去重复拉一个，并指路「重新登录」',
  planNapcatAction('start', { bat: 'C:\\x\\launcher.bat', running: true, exists: () => true }).ok === false
  && planNapcatAction('start', { bat: 'C:\\x\\launcher.bat', running: true, exists: () => true }).focus === 'relogin')
const planSwitched = planNapcatAction('start', {
  bat: 'C:\\NapCat\\bootmain\\napcat.bat', running: false, exists: (file) => /launcher\.bat$/i.test(file),
  shimFile: 'C:\\QQAI\\qq-napcat-launch.cmd', logFile: 'C:\\QQAI\\qq-napcat-launch.log',
})
check('快捷启动：配置里写的是 napcat.bat 时自动改用同目录 launcher.bat（并说明原因）',
  planSwitched.ok === true && planText(planSwitched).includes('launcher.bat')
  && planSwitched.note.includes('launcher.bat'),
  planSwitched.note)
const planRelogin = planNapcatAction('relogin', {
  bat: 'C:\\NapCat\\bootmain\\launcher.bat',
  loaders: [{ pid: 4100, name: 'NapCatWinBootMain.exe' }, { pid: 4200, name: 'QQ.exe' }],
  exists: () => true,
  logFile: 'C:\\QQAI\\qq-napcat-launch.log', shimFile: 'C:\\QQAI\\qq-napcat-launch.cmd',
})
check('重新登录：只按加载器 PID 杀（QQ.exe 那个 PID 不在命令里）',
  planRelogin.ok === true && planText(planRelogin).includes('taskkill /PID 4100 /T /F')
  && !planText(planRelogin).includes('4200'),
  planText(planRelogin).slice(-160))
check('重新登录：拿不到加载器 PID 就拒绝（绝不退回按名杀 QQ）',
  planNapcatAction('relogin', { bat: 'C:\\x\\launcher.bat', loaders: [], exists: () => true }).ok === false
  && planNapcatAction('relogin', { bat: 'C:\\x\\launcher.bat', loaders: [], exists: () => true }).reason.includes('QQ'),
  planNapcatAction('relogin', { bat: 'C:\\x\\launcher.bat', loaders: [], exists: () => true }).reason.slice(0, 60))
check('快捷操作：没配启动脚本时明确拒绝', planNapcatAction('start', { bat: '', exists: () => true }).ok === false
  && planNapcatAction('start', { bat: '', exists: () => true }).reason.includes('napcatBat'))
check('载荷里带上 NapCat 的运行状态（按钮据此禁用）',
  typeof JSON.parse(accountPanel.out.body).napcat?.running === 'boolean'
  && JSON.parse(accountPanel.out.body).napcat?.port > 0,
  brief(JSON.parse(accountPanel.out.body).napcat))
/**
 * ★ 用户连着两次问"没弹出二维码啊"：看到的是**空窗口**（我们把启动输出重定向进日志了）。
 * 解决＝面板直接贴图：载荷给 `napcat.qr`，`GET /qqai/napcat/qr` 把 `cache/qrcode.png` 交出去。
 */
{
  const qrRoutes = []
  const freshQr = () => Date.now() - 30_000
  const staleQr = () => Date.now() - 400_000
  const mountQr = (mtimeMs) => {
    qrRoutes.length = 0
    mountQqAiPanel({
      webServer: { register(route) { qrRoutes.push(route); return () => { const at = qrRoutes.indexOf(route); if (at >= 0) qrRoutes.splice(at, 1) } } },
    }, {
      profile: 'web', config: {}, readFile: readFileSync, writeFile: writeFileSync, env,
      linkSources: { root: napcatRoot }, probe: async () => true, exists: () => true, napcatWaitMs: 0,
      stat: () => ({ mtimeMs: mtimeMs() }),
      readBinary: (file) => Buffer.from(`PNG:${file}`, 'utf8'),
      spawnDetached: async () => ({ pid: 1, failed: false, code: 0, stdout: '', stderr: '' }),
      exec: (command, args, options, callback) => (typeof options === 'function' ? options : callback)(null, '', ''),
    })
    return qrRoutes.find((r) => r.path === '/qqai/napcat/qr')
  }

  const fresh = mountQr(freshQr)
  const qrRes = makeResponse()
  await fresh.handler(fakeRequest('GET', undefined, { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors' }), qrRes)
  check('★二维码新鲜时：GET /qqai/napcat/qr 直接回 PNG（面板据此内嵌图片）',
    qrRes.out.status === 200 && String(qrRes.out.headers['content-type']).includes('image/png')
    && Buffer.isBuffer(qrRes.out.body) && qrRes.out.body.toString('utf8').startsWith('PNG:'),
    `${qrRes.out.status} ${qrRes.out.headers['content-type']} ${String(qrRes.out.body).slice(0, 40)}`)
  const qrPanel = makeResponse()
  await qrRoutes.find((r) => r.path === '/qqai/panel').handler(fakeRequest('GET'), qrPanel)
  const qrPayload = JSON.parse(qrPanel.out.body).napcat.qr
  check('★载荷里的 napcat.qr 指路 /qqai/napcat/qr（新鲜时给 url，附年龄）',
    qrPayload.fresh === true && qrPayload.url === '/qqai/napcat/qr' && qrPayload.ageSeconds >= 0,
    brief(qrPayload))

  const stale = mountQr(staleQr)
  const staleRes = makeResponse()
  await stale.handler(fakeRequest('GET'), staleRes)
  const staleBody = JSON.parse(staleRes.out.body)
  check('★二维码过期（>5 分钟）时：404 + 人话（让人去点「重新登录」刷新）',
    staleRes.out.status === 404 && staleBody.ok === false && staleBody.reason.includes('过期'),
    brief(staleBody.reason))
  const stalePanel = makeResponse()
  await qrRoutes.find((r) => r.path === '/qqai/panel').handler(fakeRequest('GET'), stalePanel)
  check('过期时载荷不给 url（客户端就不会显示一张废图）',
    JSON.parse(stalePanel.out.body).napcat.qr.fresh === false
    && JSON.parse(stalePanel.out.body).napcat.qr.url === '',
    brief(JSON.parse(stalePanel.out.body).napcat.qr))
  const postQr = makeResponse()
  await stale.handler(fakeRequest('POST', {}, JSON_HEADERS), postQr)
  check('二维码路由拒绝 POST', postQr.out.status === 405, String(postQr.out.status))
  const crossQr = makeResponse()
  await stale.handler(fakeRequest('GET', undefined, { origin: 'https://evil.example' }), crossQr)
  check('二维码路由拒绝跨站（本机文件不外流）', crossQr.out.status === 403, String(crossQr.out.status))
}
// 提权命令必须**先判断自己是不是管理员**：宿主已经是管理员时 RunAs 不会弹 UAC（真机实测），
// 非管理员时这台机器上 RunAs 会被静默拒绝 —— 两条分支都要写清楚，且各打一个标记给调用方。
check('提权命令里有"是否管理员"判断 + 两条分支标记（QAI-ELEVATED / QAI-RUNAS）',
  planStart.args.join(' ').includes('IsInRole') && planStart.args.join(' ').includes('QAI-ELEVATED')
  && planStart.args.join(' ').includes('QAI-RUNAS') && planStart.args.join(' ').includes("'RunAs'"),
  planStart.args.join(' ').slice(-150))
check('★提权命令只把**垫片路径**交给 cmd（不允许再塞复杂内层命令 —— 真机上引号会被打乱、压根不执行）',
  planStart.args.join(' ').includes(`@('/c','C:\\QQAI\\qq-napcat-launch.cmd')`)
  && !/&&|>>|taskkill|call "/.test(planStart.args.join(' ')),
  planStart.args.join(' ').slice(-170))
/**
 * ★ 管理员宿主改走 WMI（真机：`-Verb RunAs` 在已是管理员的宿主里偶尔静默什么都不做），
 *   而且 `if {}` 与 `else {}` 之间**不能有分号**（PowerShell 语法；真机报过
 *   `else : 无法将"else"项识别为 cmdlet`）；脚本里也不放字面量双引号（用 `[char]34` 拼）。
 */
check('★管理员分支走 WMI Win32_Process.Create，且 if/else 之间没有分号',
  planStart.args.join(' ').includes('Invoke-CimMethod -ClassName Win32_Process')
  && planStart.args.join(' ').includes('[char]34')
  && !/\} *; *else/.test(planStart.args.join(' '))
  && planStart.args.join(' ').includes("Verb = 'RunAs'"),
  planStart.args.join(' ').slice(-200))

/**
 * ★ 2026-10-04 真机总根源的回归：**`detached: true` 会让子进程压根不执行命令**
 * （Node 26 + Windows 实测：同一命令 detached 时 exit=0、输出全空、落盘标记都没生成；
 * 去掉它立刻正常）。这里用假 spawnImpl 钉住"绝不能传 detached"。
 */
{
  const seen = []
  const fakeSpawn = (command, args, options) => {
    seen.push({ command, args, options })
    const listeners = {}
    const child = {
      pid: 4321,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      once(event, handler) { listeners[event] = handler; return child },
      unref: () => {},
    }
    setTimeout(() => listeners.exit?.(0), 0)
    return child
  }
  const result = await spawnDetachedProcess({ command: 'powershell.exe', args: ['-NoProfile'], spawnImpl: fakeSpawn, waitMs: 50 })
  check('★spawnDetachedProcess 不传 detached（传了的话命令根本不会执行 —— 真机总根源）',
    seen.length === 1 && seen[0].options.detached === undefined && seen[0].options.windowsHide === true
    && Array.isArray(seen[0].options.stdio) && seen[0].options.stdio[1] === 'pipe' && result.pid === 4321,
    JSON.stringify({ options: seen[0]?.options, pid: result.pid }))
  const failed = await spawnDetachedProcess({ command: 'x', spawnImpl: () => { throw new Error('ENOENT 找不到 powershell.exe') }, waitMs: 50 })
  check('spawnDetachedProcess 把 spawn 抛出的错误如实带回（不静默）',
    failed.failed === true && String(failed.message).includes('ENOENT'), brief(failed))
}

// ---- 快捷操作路由：真的会拉起进程，所以 spawn / exec 全部注入（测试绝不动真机）----
{
  const spawned = []
  const shims = []
  const actionRoutes = []
  /**
   * 启动日志的 mtime 桩：**点击之前是 5 秒前的旧文件**，`spawnDetached` 之后才前进
   *（真机上就是垫片跑起来写了那行心跳）。这样才测得出"只认这次新写进去的心跳"——
   * 拿一个恒定不变的 mtime 当桩，会把 `since` 判据整个测没。
   */
  let napcatLogMtime = Date.now() - 5000
  const shimRanNow = () => { napcatLogMtime = Math.max(Date.now(), napcatLogMtime + 1) }
  mountQqAiPanel({
    webServer: {
      register(route) { actionRoutes.push(route); return () => { const at = actionRoutes.indexOf(route); if (at >= 0) actionRoutes.splice(at, 1) } },
    },
  }, {
    profile: 'web', config: {}, readFile: readFileSync, env,
    // 垫片要先落盘再执行 —— 这里把写入内容抓下来（断言"真正执行的脏活"）。
    writeFile: (file, content, encoding) => { shims.push({ file, content }); return writeFileSync(file, content, encoding) },
    // 垫片心跳桩：日志文件视作"含心跳行"，mtime 由 spawnDetached 推进（见上面的 napcatLogMtime）。
    stat: (target) => (String(target).endsWith('.log') ? { mtimeMs: napcatLogMtime } : statSync(target)),
    readFile: (target, encoding) => (String(target).endsWith('.log') ? '=== shim start 2026/10/06 1:00:00 ===\r\n' : readFileSync(target, encoding)),
    linkSources: { root: napcatRoot },
    probe: async () => false,                                  // 6099 没在听
    exists: (file) => /launcher\.bat$/i.test(file),             // 同目录只有 launcher.bat
    napcatWaitMs: 0,                                            // 单测别真等 8 秒
    spawnDetached: async ({ command, args }) => { spawned.push({ command, args }); shimRanNow(); return { pid: 4242, failed: false, code: 0, stdout: 'QAI-ELEVATED', stderr: '' } },
    exec: (command, args, options, callback) => {
      const done = typeof options === 'function' ? options : callback
      // 假 tasklist：一个 NapCat 加载器 + 一个个人 QQ（后者绝不能被写进命令）
      done(null, '"NapCatWinBootMain.exe","4100","Console","1","1 K"\n"QQ.exe","4200","Console","1","1 K"\n', '')
    },
  })
  const startRoute = actionRoutes.find((r) => r.path === '/qqai/napcat/start')
  const reloginRoute = actionRoutes.find((r) => r.path === '/qqai/napcat/relogin')

  const startRes = makeResponse()
  await startRoute.handler(fakeRequest('POST', {}, JSON_HEADERS), startRes)
  const startBody = JSON.parse(startRes.out.body)
  check('POST /qqai/napcat/start 写了垫片、并拉起了提权进程（垫片里才是 launcher.bat）',
    startRes.out.status === 200 && startBody.ok === true && startBody.pid === 4242
    && spawned.length === 1 && spawned[0].args.join(' ').includes('qq-napcat-launch.cmd')
    && shims.length === 1 && shims[0].content.includes('launcher.bat')
    && shims[0].content.includes('cd /d "'),
    brief({ status: startRes.out.status, spawned: spawned.length, shim: shims[0]?.file }))
  check('启动接口回的是人话（说自己走的哪条分支 + 扫码提示），并带回最新面板',
    startBody.reason.includes('管理员') && startBody.reason.includes('扫码') && startBody.panel?.links?.length > 0,
    brief(startBody.reason))
  check('★启动之后会去确认结果：8 秒内 6099 没起来就如实说"还没起来"（不再盲报成功）',
    startBody.elevated === true && startBody.started === false
    && startBody.reason.includes('还没起来') && startBody.reason.includes('已是管理员'),
    brief({ elevated: startBody.elevated, started: startBody.started, reason: startBody.reason.slice(0, 80) }))
  check('启动接口拒绝 GET（这是个会拉进程的动作）',
    await (async () => { const r = makeResponse(); await startRoute.handler(fakeRequest('GET'), r); return r.out.status })() === 405)
  const startPlain = makeResponse()
  await startRoute.handler(fakeRequest('POST', {}, { 'content-type': 'text/plain' }), startPlain)
  check('启动接口拒绝非 JSON（CORS 简单请求挡在门外）', startPlain.out.status === 403, String(startPlain.out.status))
  const startCross = makeResponse()
  await startRoute.handler(fakeRequest('POST', {}, { ...JSON_HEADERS, origin: 'https://evil.example' }), startCross)
  check('启动接口拒绝跨站', startCross.out.status === 403, String(startCross.out.status))

  const reloginRes = makeResponse()
  await reloginRoute.handler(fakeRequest('POST', {}, JSON_HEADERS), reloginRes)
  const reloginBody = JSON.parse(reloginRes.out.body)
  check('POST /qqai/napcat/relogin 只按加载器 PID 清理（假 tasklist 里的 QQ.exe 4200 没被写进垫片）',
    reloginRes.out.status === 200 && reloginBody.ok === true
    && String(shims[1]?.content ?? '').includes('taskkill /PID 4100')
    && !String(shims[1]?.content ?? '').includes('4200')
    && spawned[1]?.args.join(' ').includes('qq-napcat-launch.cmd'),
    brief({ status: reloginRes.out.status, cmd: String(spawned[1]?.args.join(' ')).slice(-90) }))

  /**
   * ★ issue #2 的另一半（2026-10-16）：「搞了很久都说没有 napcat 脚本」。
   *   面板原来只认 `qq-control.json` 里的 `napcatBat`，配置为空就直接说"未配置"；
   *   而控制台早就会自己探测常见安装位置 ⇒ 同一台机器上"控制台能用、面板说没配"。
   *   现在两边共用 `detectNapcatBat`（见 lib/napcat-launch.js）。
   */
  check('★配置里没填 napcatBat 时，面板自己也去常见位置探测（不再干说"未配置"）',
    detectNapcatBat({
      env: { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' },
      exists: (file) => String(file).endsWith('bootmain\\napcat.bat'),
    }) === 'C:\\Users\\someone\\AppData\\Local\\Programs\\NapCat\\bootmain\\napcat.bat',
    detectNapcatBat({ env: {}, exists: () => false }) || '(探测不到时应为空串)')
  check('探测表把用户填的路径排在第一位（填了就用它）',
    detectNapcatBat({ configured: 'D:\\My\\napcat.bat', env: {}, exists: () => true }) === 'D:\\My\\napcat.bat'
    && detectNapcatBat({ configured: 'D:\\My\\napcat.bat', env: {}, exists: () => false }) === '')
  {
    // 空配置 + 探测不到 NapCat 的机器：报错必须是**人话 + 下一步**（原来只有"未配置 NapCat 启动脚本"）
    const noBatRoutes = []
    mountQqAiPanel({
      webServer: { register(route) { noBatRoutes.push(route); return () => { const at = noBatRoutes.indexOf(route); if (at >= 0) noBatRoutes.splice(at, 1) } } },
    }, {
      profile: 'web', config: {}, readFile: (file) => (String(file).endsWith('qq-control.json') ? '{"cwd":"C:\\\\QQAI"}' : readFileSync(file)),
      writeFile: writeFileSync, env: { DSH_HOME: dir }, linkSources: { root: napcatRoot },
      probe: async () => false, exists: () => false, napcatWaitMs: 0,
      // 探测不到就**绝不能**真去拉进程
      spawnDetached: () => { throw new Error('不该被调用') },
      exec: (command, args, options, callback) => (typeof options === 'function' ? options : callback)(null, '', ''),
    })
    const noBat = makeResponse()
    await noBatRoutes.find((r) => r.path === '/qqai/napcat/start').handler(fakeRequest('POST', {}, JSON_HEADERS), noBat)
    const noBatBody = JSON.parse(noBat.out.body)
    check('★没配、也探测不到 NapCat 时：报错说清"填哪个文件、填在哪"',
      noBatBody.ok === false && noBatBody.reason.includes('launcher.bat') && noBatBody.reason.includes('qq-control.json'),
      brief(noBatBody.reason))
  }

  // 已经在跑时：不重复拉，指路"重新登录"
  const runningRoutes = []
  mountQqAiPanel({
    webServer: { register(route) { runningRoutes.push(route); return () => { const at = runningRoutes.indexOf(route); if (at >= 0) runningRoutes.splice(at, 1) } } },
  }, {
    profile: 'web', config: {}, readFile: readFileSync, writeFile: writeFileSync, env,
    linkSources: { root: napcatRoot }, probe: async () => true, exists: () => true,
    spawnDetached: () => { throw new Error('不该被调用') },
    exec: (command, args, options, callback) => (typeof options === 'function' ? options : callback)(null, '', ''),
  })
  const runningStart = makeResponse()
  await runningRoutes.find((r) => r.path === '/qqai/napcat/start').handler(fakeRequest('POST', {}, JSON_HEADERS), runningStart)
  const runningBody = JSON.parse(runningStart.out.body)
  check('NapCat 已在运行时：启动接口不重复拉进程，改为提示用「重新登录」',
    runningBody.ok === false && runningBody.reason.includes('重新登录'), brief(runningBody.reason))
  const runningPanel = makeResponse()
  await runningRoutes.find((r) => r.path === '/qqai/panel').handler(fakeRequest('GET'), runningPanel)
  check('载荷里的 napcat.running 跟着探测结果走（true）',
    JSON.parse(runningPanel.out.body).napcat.running === true, brief(JSON.parse(runningPanel.out.body).napcat))

  /**
   * ★ 2026-10-04 真机事故的回归：**提权失败必须如实报，不许盲报"已请求启动"**。
   * 现场：桌面端（非管理员）点按钮 → powershell 的 `-Verb RunAs` 被静默拒绝 → 什么都没发生，
   * 而旧实现把子进程输出丢了（stdio: 'ignore'），面板照样显示"已请求启动" ⇒ 用户"点了没反应"。
   * 现在：抓到 exitCode / stderr 就必须回给用户。
   */
  const failRoutes = []
  mountQqAiPanel({
    webServer: { register(route) { failRoutes.push(route); return () => { const at = failRoutes.indexOf(route); if (at >= 0) failRoutes.splice(at, 1) } } },
  }, {
    profile: 'web', config: {}, readFile: readFileSync, writeFile: writeFileSync, env,
    linkSources: { root: napcatRoot }, probe: async () => false, exists: () => true, napcatWaitMs: 0,
    spawnDetached: async () => ({
      pid: 0, failed: true, code: -1, stdout: '',
      stderr: 'Start-Process : 此操作需要提升权限。/ This operation requires elevation.',
    }),
    exec: (command, args, options, callback) => (typeof options === 'function' ? options : callback)(null, '', ''),
  })
  const denied = makeResponse()
  await failRoutes.find((r) => r.path === '/qqai/napcat/start').handler(fakeRequest('POST', {}, JSON_HEADERS), denied)
  const deniedBody = JSON.parse(denied.out.body)
  check('★提权被拒时：ok=false 且把 powershell 的原话带出来（不再显示假成功）',
    deniedBody.ok === false && deniedBody.started === false
    && deniedBody.reason.includes('没发出去') && deniedBody.reason.includes('elevation'),
    brief(deniedBody.reason))
  /**
   * ★ 2026-10-04 真机根因回归：**提权后 `%cd%` 会变成 `C:\Windows\System32`**，
   * 而 launcher.bat 用 `%cd%` 拼自己的路径（`%cd%\NapCatWinBootMain.exe` 等）⇒ 它去找
   * `System32\NapCatWinBootMain.exe`，报一句 "is not recognized..." 就退出，界面上什么都看不到。
   * 所以命令里必须自己 `cd /d "<脚本目录>"`，并且把输出重定向到日志（隐藏窗口里的报错要留痕）。
   */
  check('★启动命令自己 `cd /d` 回脚本目录（提权后 %cd% 会跑到 System32 —— "点了没反应"的根因之一）',
    planText(planStart).includes('cd /d "C:\\NapCat\\bootmain"') && planText(planStart).includes('launcher.bat'),
    planText(planStart).slice(-190))
  check('★启动命令把 launcher 的输出重定向到日志（提权窗口是隐藏的，报错不能没人看见）',
    planText(planStart).includes('>> "') && planText(planStart).includes('2>&1')
    && String(planStart.shim?.logFile ?? '').endsWith('.log'),
    `${planStart.shim?.logFile} ← ${planStart.shim?.content ?? ''}`)
  /**
   * 那个 cmd 窗口现在是空的（输出都进日志了），所以垫片自己要往窗口里写两行"指路"：
   * 输出在哪、二维码去哪看——否则用户看到的就是"窗口运行了但什么都没有"（真机反馈过两次）。
   * 注意 `chcp 65001`：不切码页，中文在 cmd 里就是乱码。
   */
  /**
   * ★ 隐私（2026-10-06 审计）：NapCat 会把 `[WebUi] WebUi Token: …` 打进启动日志，
   *   而接口会把日志"最后一行"贴回面板 —— 万一那一刻正好是 token 行，密钥就进了浏览器。
   *   现在回显前先打码（URL 里的 ?token= 也一起挡）。
   */
  check('★回显日志前把密钥打码（NapCat 的 WebUi Token 行不会进面板）',
    redactSecrets('10-05 23:07 [info] [WebUi] WebUi Token: placeholder-token') === '10-05 23:07 [info] [WebUi] WebUi Token: <已隐藏>'
    && redactSecrets('User Panel Url: http://127.0.0.1:6099/webui?token=placeholder-token').includes('token=<已隐藏>')
    && redactSecrets('password: hunter2secret').includes('<已隐藏>')
    && redactSecrets('10-05 23:07 [info] 等待网络连接...') === '10-05 23:07 [info] 等待网络连接...',
    redactSecrets('WebUi Token: placeholder-token'))
  check('★垫片会收紧启动日志的权限（撤掉继承的 Users:(RX)，只留本人+管理员+SYSTEM）',
    String(planStart.shim?.content ?? '').includes('icacls "')
    && String(planStart.shim?.content ?? '').includes('/inheritance:r')
    && String(planStart.shim?.content ?? '').includes('*S-1-5-32-544:F')
    && String(planStart.shim?.content ?? '').includes('>nul 2>&1'),
    String(planStart.shim?.content ?? '').split('\r\n').find((l) => l.includes('icacls')) ?? '（垫片里没有 icacls）')

  check('★垫片往窗口里写两行指路（输出在哪 / 二维码去哪看），并先切 UTF-8 码页',
    String(planStart.shim?.content ?? '').includes('chcp 65001')
    && String(planStart.shim?.content ?? '').includes('[QQ助手] NapCat 正在启动')
    && String(planStart.shim?.content ?? '').includes('二维码会自动显示在 DSH 面板'),
    String(planStart.shim?.content ?? '').split('\r\n').slice(0, 5).join(' ｜ '))
  check('重新登录的垫片也带 `cd /d`、日志重定向与 taskkill（同一条坑，别只修一半）',
    planText(planRelogin).includes('cd /d "C:\\NapCat\\bootmain"') && planText(planRelogin).includes('>> "')
    && planText(planRelogin).includes('taskkill /PID 4100'),
    planText(planRelogin).slice(-160))
  const nonzero = []
  mountQqAiPanel({
    webServer: { register(route) { nonzero.push(route); return () => { const at = nonzero.indexOf(route); if (at >= 0) nonzero.splice(at, 1) } } },
  }, {
    profile: 'web', config: {}, readFile: readFileSync, writeFile: writeFileSync, env,
    linkSources: { root: napcatRoot }, probe: async () => false, exists: () => true, napcatWaitMs: 0,
    spawnDetached: async () => ({ pid: 9, failed: false, code: 1, stdout: '', stderr: 'Access is denied' }),
    exec: (command, args, options, callback) => (typeof options === 'function' ? options : callback)(null, '', ''),
  })
  const nzRes = makeResponse()
  await nonzero.find((r) => r.path === '/qqai/napcat/start').handler(fakeRequest('POST', {}, JSON_HEADERS), nzRes)
  check('★非零退出码也算失败：如实报"Access is denied"',
    JSON.parse(nzRes.out.body).ok === false && JSON.parse(nzRes.out.body).reason.includes('Access is denied'),
    brief(JSON.parse(nzRes.out.body).reason))
  /**
   * ★ 假成功回归（真机抓到：NapCat 本来就在跑时，提权被悄悄拦下、垫片根本没执行，
   *   而"6099 在听"这条判据永远为真 ⇒ 界面报"重启成功"，其实什么都没发生）。
   *   现在以**垫片心跳**为判据：没心跳就 `ok:false` + 说明这次点击什么都没发生。
   */
  const noHeartbeat = []
  mountQqAiPanel({
    webServer: { register(route) { noHeartbeat.push(route); return () => { const at = noHeartbeat.indexOf(route); if (at >= 0) noHeartbeat.splice(at, 1) } } },
  }, {
    profile: 'web', config: {}, readFile: readFileSync, writeFile: writeFileSync, env,
    linkSources: { root: napcatRoot }, probe: async () => true, exists: () => true, napcatWaitMs: 0,
    // 日志文件"很旧"（或干脆不存在）⇒ 没有心跳
    stat: () => ({ mtimeMs: Date.now() - 600_000 }),
    spawnDetached: async () => ({ pid: 7, failed: false, code: 0, stdout: 'QAI-ELEVATED', stderr: '' }),
    exec: (command, args, options, callback) => (typeof options === 'function' ? options : callback)(null, '"NapCatWinBootMain.exe","4100","Console","1","1 K"\n', ''),
  })
  const noBeatRes = makeResponse()
  await noHeartbeat.find((r) => r.path === '/qqai/napcat/relogin').handler(fakeRequest('POST', {}, JSON_HEADERS), noBeatRes)
  const noBeatBody = JSON.parse(noBeatRes.out.body)
  check('★垫片没留下心跳时：ok=false，并明说"这次点击什么都没发生"（不再拿 6099 在听当成功）',
    noBeatBody.ok === false && noBeatBody.shimRan === false
    && noBeatBody.reason.includes('没有留下心跳') && noBeatBody.reason.includes('什么都没发生'),
    brief(noBeatBody.reason.slice(0, 120)))
  check('shimHeartbeatFresh：新鲜 + 有心跳 → true；文件太旧 / 读不到 / 没有心跳行 → false',
    shimHeartbeatFresh('x.log', { stat: () => ({ mtimeMs: Date.now() }), readFile: () => '=== shim start 1:00 ===\n' }) === true
    && shimHeartbeatFresh('x.log', { stat: () => ({ mtimeMs: Date.now() - 600_000 }), readFile: () => '=== shim start 1:00 ===\n' }) === false
    && shimHeartbeatFresh('x.log', { stat: () => ({ mtimeMs: Date.now() }), readFile: () => 'launcher output only\n' }) === false
    && shimHeartbeatFresh('x.log', { stat: () => { throw new Error('ENOENT') }, readFile: () => '' }) === false,
    '心跳是"命令真的落地了"的唯一可靠证据')
}

dispose()
check('dispose 注销了全部路由（配置热重载后能重新挂载，不会撞 duplicate route）',
  registered.length === 0 && disposed.length === 9, `left=${registered.length}`)
mountQqAiPanel(fakeHost, {
  profile: 'web', config: {}, readFile: readFileSync, writeFile: writeFileSync, env,
})
check('注销后可以再次挂载（模拟宿主重建插件条目）', registered.length === 9, String(registered.length))

// ------------------------------------------------- 3. 客户端 bundle 冒烟 ---- ----
const clientText = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')
let loaded = null
const sandboxWindow = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
// 最小 React 桩：`Component` 是给**渲染边界**（class 组件）用的——错误边界只能是 class，
// 所以桩里得有它，否则 bundle 一执行就 "Class extends value undefined"。
const fakeComponent = class { constructor(props) { this.props = props ?? {}; this.state = {} } setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } } }
const fakeReact = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  Component: fakeComponent,
}
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
    && clientText.includes('/qqai/napcat/start') && clientText.includes('/qqai/napcat/relogin')
    && registered.some((r) => r.path === '/qqai/panel') && registered.some((r) => r.path === '/qqai/panel/set'))
  check('快捷操作把 ok:false 当"解释"显示（不当异常抛掉）——按钮点不动时用户要看到原因',
    clientText.includes('payload.ok === true') && clientText.includes('busyAction'))
  /**
   * ★ v0.6.7：数值行在客户端真的被分派到 NumberRow（不是画成一个开关），
   *   且提交的是**数字**、范围来自服务端载荷（`row.min/max/step`）而不是客户端写死。
   */
  check('★客户端按 row.type 分派数值控件，提交数字而不是"开/关"',
    clientText.includes("row.type === 'number'") && clientText.includes('function NumberRow')
    && clientText.includes('spec.min') && clientText.includes('spec.max') && clientText.includes('spec.step')
    && clientText.includes("typeof value === 'number'") && !/NumberRow[\s\S]{0,600}onSet\(row\.key, !/.test(clientText),
    `NumberRow=${clientText.includes('function NumberRow')}`)
  /**
   * ★ 2026-10-17 用户报：「你这两个怎么不合并在一起」——开关与它的数值必须在**同一行**里渲染，
   *   不能再拆成两行上下对照。这条钉住：有合并组件、有分派、两个键各自写。
   */
  check('★「开关 + 数值」合成一行（SwitchNumberRow），两个键各自写',
    clientText.includes('function SwitchNumberRow')
    && clientText.includes("row.type === 'switchNumber'")
    && /onSet\(row\.key, next\)/.test(clientText) && /onSet\(num\.key, next\)/.test(clientText),
    `SwitchNumberRow=${clientText.includes('function SwitchNumberRow')}`)
  /**
   * ★ v0.6.8：时段列表行（TimesRow）——`quietHours` 用两个原生时间控件编辑，整组提交。
   * 钉住：有组件、有分派、用了 `type="time"`、并且**整组**提交（不是单段）。
   */
  check('★时段行（TimesRow）用原生时间控件编辑，整组提交',
    clientText.includes('function TimesRow')
    && clientText.includes("row.type === 'times'")
    && clientText.includes("type: 'time'")
    && /TimesRow[\s\S]{0,2600}onSet\(row\.key, next\)/.test(clientText),
    `TimesRow=${clientText.includes('function TimesRow')}`)
  /**
   * ★ v0.6.8：点「刷新」以前**什么都不显示**（载荷没变 ⇒ 界面一个像素都不动，看着像按钮坏了）。
   * 现在必须：按钮进入「刷新中…」、成功后回一句"已刷新：N 组 / M 行 · 宿主 vX"、标题旁显示版本号。
   */
  check('★「刷新」有反馈（刷新中… / 已刷新：N 组 · 宿主版本），标题旁显示 pluginVersion',
    clientText.includes('刷新中…')
    && clientText.includes('announce: true')
    && clientText.includes('已刷新：')
    && clientText.includes('data.pluginVersion')
    && clientText.includes('qqai-ver'),
    `刷新中=${clientText.includes('刷新中…')} announce=${clientText.includes('announce: true')}`)
  /**
   * ★ v0.6.8（用户 2026-10-19 连续几条：「点击完以后就会立即更新状态」「连续开了几个开关以后就会鬼畜」
   *   「改回启用就刷新，但是启用以后会 3 秒内变灰不让按」「启用或者关闭」）：
   *   ① **乐观更新**：点完立刻变（`applyWrittenValue` 清掉 pending），开关保留官方那种滑动动画；
   *   ② **合并写入**：350ms 内的多次点击攒成一个批次走 `/qqai/panel/set-batch`，一次写盘 ⇒ 宿主只重载一次；
   *   ③ **写完锁 3 秒**（`COOLING_MS`，盖住宿主 ~2.3 秒的热重载），期间所有开关/数字/按钮**变灰不可点**；
   *   ④ 3 秒后**自动刷新一次**（不是轮询），拿到重载后的真实值。
   *   「启用或者关闭」都走同一条路——只要 `changed` 就锁。
   */
  check('★点完立即变 + 马上变灰锁 3 秒 + 350ms 攒批 + 3 秒后自动刷新一次（不轮询）',
    clientText.includes('function applyWrittenValue')
    && clientText.includes('const pendingWrites = new Map()')
    && clientText.includes("void flushQueue() }, 350)")
    && clientText.includes("'/qqai/panel/set-batch'")
    && clientText.includes('const COOLING_MS = 3000')
    // 锁是在**点击那一刻**就开始的（启用/关闭都一样），不是写完才开始
    && /const toggle = useCallback\([\s\S]{0,900}cooling: true/.test(clientText)
    && /const toggle = useCallback\([\s\S]{0,1600}\}, COOLING_MS\)/.test(clientText)
    && clientText.includes('秒内先别动，之后自动刷新')
    && clientText.includes("busy: state.busyKey !== '' || state.cooling === true")
    && clientText.includes('state.refreshing === true || state.cooling === true')
    && /setTimeout\(\(\) => \{[\s\S]{0,260}void load\(\{ announce: true \}\)[\s\S]{0,60}\}, COOLING_MS\)/.test(clientText)
    && !clientText.includes('waitUntilEffective')
    && !/setTimeout\(resolve, 700\)/.test(clientText)
    && clientText.includes('transition:transform .12s ease'),
    `batch=${clientText.includes('/qqai/panel/set-batch')} cool=${clientText.includes('COOLING_MS')} poll=${clientText.includes('waitUntilEffective')}`)
  /**
   * ★ v0.6.8（用户 2026-10-19「为啥静默时段还是需要刷新」）：
   *   写完之后自动刷新那一次，如果宿主还没重载完，载荷里这一行会**退回旧值**——
   *   界面上就等于"刚改的被吞了"，还得再手动刷一次。
   *   所以没生效的写入要记在 `optimisticValues` 里，**每次拉载荷都盖回去**，
   *   直到某趟载荷里该键确实生效（值相同且 pending 不是 true）才删掉。
   */
  check('★写完的旧值不会"退回去"（未生效写入每次拉载荷都盖回来，生效后才清）',
    clientText.includes('const optimisticValues = new Map()')
    && clientText.includes('function applyOptimistic(data)')
    && clientText.includes('const data = applyOptimistic(await callJson(')
    && /applyOptimistic[\s\S]{0,700}pending !== true && sameValue\(row\.value, value\)/.test(clientText)
    && /const toggle = useCallback\([\s\S]{0,700}optimisticValues\.set\(key, value\)/.test(clientText)
    && /optimisticValues\.delete\(item\.key\)/.test(clientText),
    `sticky=${clientText.includes('optimisticValues')}`)
  /**
   * ★ v0.6.8（用户 2026-10-19「不是灰三秒吗？为啥一下就亮了」）：
   *   `setState(object)` 在函数组件里是**整对象替换**——写成功后如果那么写，会把 `cooling` 一起抹掉，
   *   350ms 时控件就重新亮了。所有"写成功/拉载荷"必须走函数式更新，保住 cooling 等字段。
   */
  check('★冷却不会被写成功后的 setState 抹掉（写成功路径必须函数式更新）',
    /setState\(\(prev\) => \(\{[\s\S]{0,500}status: 'ready'/.test(clientText)
    // 老写法是 `setState({\n  status: 'ready',\n  data, …`——整对象替换会把 cooling 抹掉
    && !/setState\(\{\s*\n\s*status: 'ready',\s*\n\s*data,/.test(clientText)
    && /setState\(\(prev\) => \(\{ \.\.\.prev, busyKey: '', cooling: false/.test(clientText),
    `functional=${/setState\(\(prev\) => \(\{[\s\S]{0,500}status: 'ready'/.test(clientText)}`)
  /**
   * ★ 2026-10-17 用户报：「右边的上下控制层感觉没必要啊，而且还不方便，影响美观」——
   *   那是 `<input type="number">` 的**原生上下箭头**，与我们的 −/+ 重复。必须靠 CSS 关掉，
   *   否则只要有人再写一遍 `type="number"` 而忘了这条，那对小箭头就会自己长回来。
   */
  check('★数值输入框关掉了原生上下箭头（只留 −/+，别让 Chromium 再画一对小的）',
    clientText.includes('::-webkit-inner-spin-button') && clientText.includes('::-webkit-outer-spin-button')
    && /spin-button\{[^}]*appearance:none/.test(clientText)
    && clientText.includes('appearance:textfield'),
    `spin=${clientText.includes('::-webkit-inner-spin-button')} textfield=${clientText.includes('appearance:textfield')}`)
  /**
   * ★ v0.6.8（用户 2026-10-20「AI账号那一栏为啥还有加减啊」）：
   *   `botQq` 是**标识**不是阈值 ⇒ 不画 ± 按钮（`noStepper`），输入框放宽；其它数值行照旧带 ±。
   */
  check('★「AI 账号」不画 ±（标识不是阈值），输入框加宽',
    clientText.includes('spec.noStepper === true')
    && clientText.includes("className: noStepper ? 'qqai-num-input wide' : 'qqai-num-input'")
    && clientText.includes('.qqai-num-input.wide{width:112px}')
    && (() => {
      const snap = panelSnapshot({ botQq: 2000000001 }, { defaults: { botQq: 0 }, numberMeta })
      const rows = snap.groups.flatMap((group) => group.rows)
      return rows.find((row) => row.key === 'botQq')?.noStepper === true
        && rows.find((row) => row.key === 'dedupWindowSeconds')?.noStepper === false
    })(),
    `noStepper=${clientText.includes('spec.noStepper === true')}`)
  /**
   * ★ 桌面端（`dsh-app://app/`）的链接：主窗口只把 http(s) 外链丢给系统浏览器，相对地址会被 deny。
   * 客户端必须：认得出桌面宿主、对**相对入口**改走 `?format=json` + `window.open(绝对地址)`，
   * 而**网页版保持默认导航**（别把本来就好的路径改坏）。
   */
  check('★客户端认得出桌面宿主，并对相对入口改走 `?format=json` + window.open(绝对地址)',
    clientText.includes("=== 'dsh-app:'") && clientText.includes('format=json')
    && clientText.includes('window.open(url') && clientText.includes("String(link.href).startsWith('/')"),
    '桌面端开不了 dsh-app:// 新窗口，必须让系统浏览器去开 http 地址')
  /**
   * ★ "没弹出二维码啊"的正面回答：面板里直接贴图（image/png 那条路由）+ 一个刷新按钮。
   */
  check('★客户端在二维码新鲜时内嵌 <img>（src 指向 /qqai/napcat/qr，带时间戳防缓存）',
    clientText.includes('qqai-qr-img') && clientText.includes('qr.url')
    && clientText.includes('?t=${qrStamp}') && clientText.includes('刷新二维码'),
    clientText.includes('qqai-qr-img') ? 'ok' : '缺少内嵌二维码')
  /**
   * ★ 白屏回归（用户 2026-10-04："为啥点击刷新二维码会白屏"）：
   *   `setState({ qrStamp })` 整对象替换会把 `data` 一起清掉 → 下一帧读 `data.napcat` 抛错 → **整页白**。
   *   两条断言：①「刷新二维码」必须走函数式更新；② 面板外面套一层渲染边界（以后再有类似 bug 也只显示一句话）。
   */
  check('★「刷新二维码」用函数式 setState（整对象替换会清掉 data → 白屏）',
    clientText.includes('setState((prev) => ({ ...prev, qrStamp: Date.now() }))'),
    '必须保留 data，只更新 qrStamp')
  check('★面板外面套了渲染边界（渲染出错显示一句话，而不是整页白屏）',
    clientText.includes('class PanelBoundary extends React.Component')
    && clientText.includes('getDerivedStateFromError')
    && clientText.includes('h(PanelBoundary, null, h(QqAiPanel, null))'),
    '没有边界的话，插件里任何渲染异常都会把整个设置页带白')
  /**
   * ★ 用户 2026-10-04："应该在启动旁边加个提示，比如过会会出现二维码，而不是什么也没有"。
   *   两件事都要有：①按钮旁边那句"等几秒二维码会出现"；②**真的会自动出现**——
   *   启动成功后开始盯二维码（每 3 秒刷一次面板），图一出来就停并提示去扫。
   */
  check('★「启动 NapCat」旁边的状态写明"等几秒，二维码会出现在下面"（渲染出来的文本在浅渲染那段再验）',
    clientText.includes('二维码会出现在下面') && clientText.includes('正在启动 NapCat…等几秒'),
    clientText.includes('二维码会出现在下面') ? 'ok' : '缺少这句提示')
  check('★启动成功后自动盯二维码（每 3 秒刷面板、出现即停、90 秒给一句人话）',
    clientText.includes('watchingQr') && clientText.includes('setInterval(() => { void load() }, 3000)')
    && clientText.includes('90_000') && clientText.includes('二维码已经出来了'),
    '光有提示不够——图得自己出现')
  check('客户端把「相关链接」整组渲染出来（挂 data.links，不再是页脚）',
    clientText.includes('qqai-links') && clientText.includes('data.links')
    && !clientText.includes('qqai-footer')
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
    // 渲染边界是 class 组件（React 只支持 class 做错误边界）——桩里必须给 Component。
    Component: fakeComponent,
  }
  return stub
}
const reactStub = makeReactStub()
const shallowText = (element, states) => {
  reactStub.setStates(states)
  const text = []
  const hrefs = []
  const switches = []
  const linkRows = []   // 每个 <a> 自己的文本：用来验"整行是不是都能点"
  const buttons = []    // 按钮：文案 + 是否禁用（快捷操作的禁用态靠它验）
  const inputs = []     // 输入框：type + value（时段行/数值行的控件靠它验）
  /** 收集某个子树里的纯文本（组件的孩子都是已经 createElement 出来的节点，够用）。 */
  const textOf = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    return textOf(node.props?.children)
  }
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return }
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node.type === 'function') {
      // class 组件（渲染边界）要 `new` 出来再走它的 render()——直接当函数调用会抛
      // "Class constructor cannot be invoked without 'new'"。
      if (node.type.prototype !== undefined && typeof node.type.prototype.render === 'function') {
        const instance = new node.type(node.props ?? {})
        walk(instance.render())
        return
      }
      reactStub.resetSlot(); walk(node.type({ ...(node.props ?? {}) })); return
    }
    // 链接目标在属性上，不在文本里——单独收集，否则断言会"看着渲染出来了其实没验链接"。
    if (typeof node.props?.href === 'string') {
      hrefs.push(node.props.href)
      linkRows.push({ href: node.props.href, target: node.props.target, text: textOf(node.props.children) })
    }
    // 开关的状态也只在属性上：收集起来验 aria-checked 的映射。
    if (node.props?.role === 'switch') switches.push({ checked: node.props['aria-checked'], disabled: node.props.disabled === true })
    if (node.type === 'button') buttons.push({ text: textOf(node.props?.children), disabled: node.props?.disabled === true })
    // 时间/数字输入框也只在属性上：收集 type + value，用来验"时段行真的画出了两个时间控件"。
    if (node.type === 'input') inputs.push({ type: node.props?.type, value: node.props?.value, label: node.props?.['aria-label'] })
    walk(node.props?.children)
  }
  walk(element)
  return { text: text.join(' | '), hrefs, switches, linkRows, buttons, inputs }
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
/** 前端 bundle 里声明的版本（用它构造"前端与宿主一致"的夹具）。 */
const clientVersion = (() => {
  const match = /const CLIENT_VERSION = '([^']+)'/.exec(clientText)
  return match ? match[1] : ''
})()

  const loading = shallowText(render, [{ status: 'loading', data: null, error: '', flash: '', busyKey: '' }])
  check('浅渲染：加载态能渲染出来（不抛异常）', loading.text.includes('读取中…'), loading.text.slice(0, 70))

  const fixture = {
    status: 'ready',
    error: '',
    flash: 'ttsEnabled → 关（已写入配置）',
    busyKey: '',
    busyAction: '',
    data: {
      profile: 'desktop',
      // v0.6.8：标题右侧显示的"宿主加载的那份代码"的版本（用来判断要不要重载）。
      pluginVersion: '9.9.9',
      patchFile: '/srv/dsh/profiles/desktop/cordis.patch.yml',
      patchExists: true,
      notes: { apply: '写入说明', scope: '范围说明' },
      // NapCat 的实时状态（快捷操作按钮据此禁用）
      napcat: { running: false, port: 6099 },
      // v0.6.8：桥的运行状态（"登录了却没有反馈"靠这一行回答）。
      bridge: {
        present: true, file: '/srv/dsh/qq-runtime.json', ageSeconds: 2, uptimeSeconds: 600,
        botOnline: true, lastInboundAt: 1, lastInboundAgoSeconds: 12, traceTotal: 5,
        topReason: { reason: 'whitelist: 私聊用户不在 allowUsers 白名单', count: 2 },
        // 「快捷加入」候选：用户 100000002 还没在白名单里（chip 里的是 2000000001）。
        recentChats: [
          { chatKey: 'u:100000002', kind: 'user', id: 100000002, at: 1 },
          { chatKey: 'g:3000000001', kind: 'group', id: 3000000001, at: 1 },
        ],
      },
      // 「相关链接」整组（账号第一、调试台压最底下）——渲染在标题正下方、开关分组之前。
      links: [
        { id: 'account', label: 'QQ助手账号（登录 / 扫码）', href: '/qqai/account', hint: '机器人账号的扫码 / 登录状态页；**需要先运行 NapCat**（没起来就点上面的「启动 NapCat」），点开就是带 token 的地址，不用手输' },
        { id: 'changelog', label: '更新日志（v9.9.9）', href: 'https://example.invalid/CHANGELOG.md', hint: '每个版本的改动' },
        { id: 'readme-debug', label: '调试文档', href: 'https://example.invalid/docs/DEBUG.md', hint: 'trace / 回放 / 体检 / 注入的用法' },
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
        }, {
          // 「开关 + 数值」合并行（v0.6.7）：一个开关 + 一个数字，**同一行**渲染。
          key: 'chatTurnLimitEnabled',
          label: '每分钟进模型上限',
          hint: '**入站**风控：每分钟最多让几条消息进模型（默认关）。',
          needs: '',
          type: 'switchNumber',
          value: false,
          defaultValue: false,
          nonDefault: false,
          fileValue: null,
          pending: false,
          number: {
            key: 'chatTurnsPerMinute', label: '每分钟进模型条数', unit: '条/分钟',
            value: 5, min: 1, max: 10, step: 1, defaultValue: 5, nonDefault: false, fileValue: null, pending: false,
          },
        }, {
          // 时段列表行（v0.6.8）：两个原生时间控件 + 删除按钮 + 「+ 加一段」。
          key: 'quietHours',
          label: '静默时段',
          hint: '要静默的时间段，可多段；**支持跨夜**（22:00-6:00）。',
          needs: '',
          type: 'times',
          value: ['09:00-12:00'],
          maxRanges: 8,
          defaultValue: ['9:00-12:00', '14:00-18:00'],
          nonDefault: true,
          fileValue: null,
          pending: false,
        }, {
          // 号码列表行（v0.6.8，白名单）：一条一个 chip + 输入框 + 「+ 添加」。
          key: 'allowUsers',
          label: '允许的用户（QQ 号）',
          hint: '私聊白名单：只有列表里的 QQ 号可以私聊机器人。**空 = 拒绝所有私聊**。',
          needs: '',
          type: 'list',
          value: [2000000001],
          maxItems: 50,
          defaultValue: [],
          nonDefault: true,
          fileValue: null,
          pending: false,
        }],
      }],
    },
  }
  const ready = shallowText(render, [fixture])
  const readyText = ready.text
  check('浅渲染：标题/分组/开关标签与键名都出现',
    readyText.includes('QQ助手') && readyText.includes('对话基础') && readyText.includes('语音回复')
    && readyText.includes('ttsEnabled'), readyText.slice(0, 120))
  /**
   * ★ v0.6.8：标题旁显示**宿主加载的那份代码**的版本（夹具写 9.9.9），刷新按钮也在。
   * 少这一行，用户就无法判断"看不到新分组"到底是没重载还是面板坏了。
   */
  check('★浅渲染：标题旁显示宿主版本号（v9.9.9），「刷新」按钮在',
    readyText.includes('v9.9.9') && ready.buttons.some((btn) => btn.text === '刷新'),
    `buttons=${ready.buttons.map((b) => b.text).join('')}`)
  /**
   * ★ v0.6.9 面板搜索：10 组 78 键靠滚太慢 —— 顶部一个搜索框，纯前端过滤。
   *   这里验三件事：① 框在；② 搜到就只剩命中的组/行，并显示"匹配 N 组 / M 行"；
   *   ③ 一个都搜不到时给出"换个词"的提示（而不是一片空白）。
   */
  check('★浅渲染：顶部有搜索框（纯前端过滤，不发请求）',
    ready.inputs.some((item) => item.label === '搜索面板里的开关')
    && clientText.includes('function filterGroups(groups, query)')
    && clientText.includes("className: 'qqai-search'")
    && clientText.includes('.qqai-search{'),
    `inputs=${ready.inputs.map((i) => i.label).join(' | ')}`)
  check('★搜索命中：只留匹配的组与行，并显示「匹配 N 组 / M 行」',
    (() => {
      // 夹具里的行动态：ttsEnabled / chatTurnLimit / quietHours / allowUsers —— 用「静默」命中其中之一。
      const searching = shallowText(render, [{ ...fixture, filter: '静默' }])
      return searching.text.includes('匹配')
        && searching.text.includes('静默时段')
        && !searching.text.includes('允许的用户（QQ 号）')
    })(),
    '搜索「静默」')
  check('★搜索无命中：给"换个词/清空"的提示，而不是空白',
    (() => {
      const none = shallowText(render, [{ ...fixture, filter: '绝对不存在的开关名' }])
      return none.text.includes('没有匹配') && none.text.includes('清空搜索框')
    })(),
    '搜索一个不存在的词')
  /**
   * ★ v0.6.8：桥的状态行也要渲染出来（"登录了却没有反馈"就靠它）。
   * 夹具给一份"已连接 + 被拦"的桥状态，必须看到连接与拦截原因。
   */
  check('★浅渲染：桥状态行画出「已连接」与最近的拦截原因',
    readyText.includes('桥：已连接') && readyText.includes('最近收到消息')
    && readyText.includes('最近被拦下') && readyText.includes('白名单'),
    readyText.slice(-200))
  /**
   * ★ v0.6.8 白名单行（号码列表）：chip 显示号码 + 一个输入框 + 「+ 添加/50」。
   */
  check('★浅渲染：白名单行画出号码 chip、输入框与「+ 添加」',
    readyText.includes('允许的用户（QQ 号）') && readyText.includes('2000000001')
    && readyText.includes('+ 添加（1/50）')
    && ready.inputs.some((item) => item.label === '允许的用户（QQ 号）：要添加的号码')
    && ready.buttons.some((btn) => btn.text === '×'),
    `buttons=${ready.buttons.map((b) => b.text).join('')}`)
  /**
   * ★ v0.6.8「快捷功能」：白名单行要能**从最近来信一键加入**（不用手输号码）。
   * 夹具里 `u:100000002` 不在白名单 ⇒ 必须出现「+ 100000002」；已经在列表里的 2000000001 不许再出现。
   */
  check('★浅渲染：白名单行给出「最近来信」一键加入（已在列表里的不重复给）',
    readyText.includes('最近来信')
    && ready.buttons.some((btn) => btn.text === '+ 100000002')
    && !ready.buttons.some((btn) => btn.text === '+ 2000000001'),
    `buttons=${ready.buttons.map((b) => b.text).join('')}`)
  /**
   * ★ v0.6.8：`allowAllChats` 打开时，两个名单行要显示琥珀色"现在不起作用"（别再让人白加号码）。
   */
  check('★浅渲染：名单被「回应所有人」顶掉时那行有醒目提醒',
    (() => {
      const group = fixture.data.groups[0]
      const listRow = group.rows.find((row) => row.key === 'allowUsers')
      if (!listRow) return false
      const fixture2 = {
        ...fixture,
        data: {
          ...fixture.data,
          groups: [{ ...group, rows: [{ ...listRow, inactive: true, inactiveReason: '上面「回应所有人」开着 —— 这个名单现在不起作用' }] }],
        },
      }
      const text = shallowText(render, [fixture2]).text
      return text.includes('上面「回应所有人」开着') && text.includes('这个名单现在不起作用')
    })(),
    '名单行 inactive 提醒')
  /**
   * ★ v0.6.8：前端 bundle 落后于宿主时，必须**自己说出来**并给一个「刷新页面」按钮
   * （夹具的宿主版本 9.9.9 ≠ CLIENT_VERSION，正好是"页面旧、宿主新"的场景）；
   * 版本一致时不许出现这条横幅。
   */
  check('★浅渲染：前端落后时出现「刷新页面」横幅，版本一致时不出',
    readyText.includes('刷新一次页面即可') && ready.buttons.some((btn) => btn.text === '刷新页面')
    && (() => {
      const same = shallowText(render, [{ ...fixture, data: { ...fixture.data, pluginVersion: clientVersion } }])
      return !same.text.includes('刷新一次页面即可')
    })(),
    `buttons=${ready.buttons.map((b) => b.text).join('')}`)
  // 用户 2026-10-04 **七条**指示的最终口径（其中两条是"改回去 / 再挪"）：**「相关链接」整组**在标题正下方
  // （账号入口第一、更新日志、调试文档、**调试台最底下**），开关分组在它下面。
  // 浅渲染按树的顺序收集文本，所以"先后"就是界面上的上下。
  // 注意：不能拿「QQ助手」当下界锚点——CSS 是同一棵树里的文本节点，注释里就写着「QQ助手」，
  // 那个下标在最前面（我第一次就是这么红的）。锚点用「对话基础」（确定在链接组后面）。
  check('「相关链接」整组渲染在开关分组之前（贴着头部的第一块）',
    readyText.includes('相关链接') && readyText.includes('QQ助手账号（登录 / 扫码）')
    && readyText.includes('不用手输')
    && readyText.indexOf('相关链接') < readyText.indexOf('对话基础'),
    readyText.slice(readyText.indexOf('相关链接') - 40, readyText.indexOf('相关链接') + 120))
  check('组内顺序：账号第一 → 更新日志 → 调试文档 → 调试台压最底下，链接目标都挂上了',
    readyText.indexOf('QQ助手账号') < readyText.indexOf('更新日志')
    && readyText.indexOf('更新日志') < readyText.indexOf('调试文档')
    && readyText.indexOf('调试文档') < readyText.indexOf('调试台')
    && ready.hrefs.includes('/qqai/account') && ready.hrefs.includes('/qqai/console'),
    ready.hrefs.join(' | '))
  check('账号入口在整份页面里只出现一次（不会组里 + 别处各来一条）',
    readyText.lastIndexOf('QQ助手账号') === readyText.indexOf('QQ助手账号'),
    String(readyText.split('QQ助手账号').length - 1))
  // ★ 2026-10-04 真机："点击账号没反应" —— 除了守卫那个 403，还有一半原因是**只有那行蓝字是链接**，
  //   右边那段灰色说明是普通 span，点在说明上什么都不会发生。现在整行是一个 <a>，点哪儿都能进。
  const accountRow = ready.linkRows.find((row) => row.href === '/qqai/account')
  check('★账号入口整行都可点（说明文字也在 <a> 里），且是新标签页打开',
    accountRow !== undefined
    && accountRow.text.includes('QQ助手账号（登录 / 扫码）') && accountRow.text.includes('不用手输')
    && accountRow.target === '_blank',
    brief(accountRow))
  // 用户 2026-10-04："这旁边加一个描述，比如需要先运行 NapCat"。
  check('★账号入口的说明里写明"需要先运行 NapCat"（并指路「启动 NapCat」）',
    accountRow.text.includes('需要先运行 NapCat') && accountRow.text.includes('启动 NapCat'),
    brief(accountRow.text.slice(-90)))
  const consoleRow = ready.linkRows.find((row) => row.href === '/qqai/console')
  check('调试台那一行同样整行可点（含"未启动 · 需要单独运行…"那段）',
    consoleRow !== undefined && consoleRow.text.includes('调试台（独立控制台）')
    && consoleRow.text.includes('未启动') && consoleRow.target === '_blank',
    brief(consoleRow))
  // 快捷操作（用户："不能自己快捷启动吗？比如加到哪个控制选项中"）：两个按钮，且状态跟着 napcat.running 走。
  check('浅渲染：「快捷操作」区有「启动 NapCat」与「重新登录（扫码）」两个按钮',
    readyText.includes('快捷操作') && ready.buttons.some((b) => b.text.includes('启动 NapCat'))
    && ready.buttons.some((b) => b.text.includes('重新登录')),
    brief(ready.buttons))
  // 用户 2026-10-04："应该在启动旁边加个提示，比如过会会出现二维码，而不是什么也没有"。
  check('★浅渲染：按钮旁边确实渲染出了"等几秒，二维码会出现在下面"那句',
    readyText.includes('二维码会出现在下面'),
    brief(readyText.slice(readyText.indexOf('快捷操作'), readyText.indexOf('快捷操作') + 130)))
  // 用户 2026-10-04："把快捷操作拉到相关链接上边"（也顺：没起来时"先把它启动起来"比"点开账号页"更该先看到）。
  // ⚠️ 注意仍不能用 `indexOf('相关链接')`：CSS 是同一棵树里的文本节点，它的注释里也写着这四个字
  //    （第一次就是这么红的）→ 用 lastIndexOf 取**渲染出来的那个**标题。
  check('★顺序：「快捷操作」在「相关链接」上面，两者都在开关分组之前',
    readyText.indexOf('快捷操作') < readyText.lastIndexOf('相关链接')
    && readyText.lastIndexOf('相关链接') < readyText.indexOf('对话基础'),
    `快捷操作@${readyText.indexOf('快捷操作')} 相关链接@${readyText.lastIndexOf('相关链接')} 对话基础@${readyText.indexOf('对话基础')}`)
  check('NapCat 未运行时：启动按钮可点，且写明"未运行"', (() => {
    const start = ready.buttons.find((b) => b.text.includes('启动 NapCat'))
    return start !== undefined && start.disabled === false && readyText.includes('NapCat：未运行')
  })(), brief(ready.buttons.find((b) => b.text.includes('启动 NapCat'))))
  const napcatOn = shallowText(render, [{ ...fixture, data: { ...fixture.data, napcat: { running: true, port: 6099 } } }])
  check('NapCat 已在运行时：启动按钮变禁用、文案变「NapCat 运行中」（不让人重复点）',
    napcatOn.buttons.some((b) => b.text.includes('NapCat 运行中') && b.disabled === true)
    && napcatOn.text.includes('运行中（127.0.0.1:6099）'),
    brief(napcatOn.buttons))
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
  /**
   * ★ v0.6.7「开关 + 数值」合并行：**同一行**里既有开关又有 −/+ 数字控件。
   * 只要有人把它拆回两行（或忘了分派 switchNumber），这条就红。
   */
  check('★浅渲染：合并行（开关 + 数值）在同一行里渲染出开关和 −/+ 两个按钮',
    readyText.includes('每分钟进模型上限') && readyText.includes('chatTurnLimitEnabled + chatTurnsPerMinute')
    && ready.switches.length === 2
    && ready.buttons.some((btn) => btn.text === '−') && ready.buttons.some((btn) => btn.text === '+'),
    `switches=${ready.switches.length} buttons=${ready.buttons.map((b) => b.text).join('')}`)
  /**
   * ★ v0.6.8 时段行：一段时段要画出**两个** `<input type="time">`（开始/结束）+ 一个删除按钮，
   * 并且「+ 加一段」上带段数。少了任何一样，用户就没法在面板里改静默时段。
   */
  check('★浅渲染：时段行画出两个时间控件、「+ 加一段」和段数',
    ready.inputs.filter((item) => item.type === 'time').length === 2
    && ready.inputs.some((item) => item.type === 'time' && item.value === '09:00')
    && ready.inputs.some((item) => item.type === 'time' && item.value === '12:00')
    && ready.buttons.some((btn) => btn.text === '×')
    && readyText.includes('+ 加一段（1/8）')
    && readyText.includes('quietHours（1 / 8 段）'),
    `timeInputs=${ready.inputs.filter((item) => item.type === 'time').length} buttons=${ready.buttons.map((b) => b.text).join('')}`)
  check('浅渲染：「相关链接」与调试台状态都渲染出来（链接目标查 href 属性）',
    readyText.includes('更新日志（v9.9.9）') && readyText.includes('调试台（独立控制台）')
    && ready.hrefs.includes('/qqai/console') && ready.hrefs.some((href) => href.includes('CHANGELOG.md'))
    && readyText.includes('未启动 · 需要单独运行：node x'),
    `${readyText.slice(0, 100)}  hrefs=${JSON.stringify(ready.hrefs)}`)

  const errorRendered = shallowText(render, [{ status: 'error', data: null, error: '连接失败', flash: '', busyKey: '' }])
  check('浅渲染：错误态把真原因显示出来（不是白屏）',
    errorRendered.text.includes('读取面板失败') && errorRendered.text.includes('连接失败'), errorRendered.text.slice(0, 90))
  // 开关的"开/关"必须真的映射到 aria-checked（视觉就是靠它上色的）
  check('浅渲染：开关状态映射到 aria-checked（关=false / 开=true）',
    // 夹具里现在有两个开关（布尔行 + 合并行），都关着 ⇒ 都是 'false'。
    ready.switches.length === 2 && ready.switches.every((item) => item.checked === 'false'), JSON.stringify(ready.switches))
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
