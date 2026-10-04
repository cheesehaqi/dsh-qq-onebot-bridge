/**
 * v0.6「轻量化设计」：DSH 设置里那块「QQ助手」面板的**纯逻辑**。
 *
 * 这个文件不碰网络、不碰磁盘，只做三件事，方便单测：
 *   1. `PANEL_GROUPS`：精选出来、适合在设置界面里开关的功能（不是把 224 个键全铺上去——
 *      那样面板本身就"重"了，也失去意义）；
 *   2. `panelSnapshot()`：把运行中的生效值整理成前端要渲染的形状；
 *   3. `upsertPatchValue()` / `readPatchValue()`：只动 profile 的 `cordis.patch.yml` 里
 *      **本插件那一个条目**的 config 块，逐行做 upsert，保留注释与其它条目的原样。
 */

/** 一个开关在面板里的样子。`hint` 说明"关掉会怎样"，`key` 必须与 lib/index.js 的 schema 一致。 */
const row = (key, label, hint = '') => ({ key, label, hint })

/**
 * 分组：前 4 组是日常会动的；后 3 组标 `advanced`，界面里默认折叠。
 * 之所以不直接暴露全部布尔键：面板要的是"能一眼看完的开关"，其余仍走配置文件。
 */
export const PANEL_GROUPS = [
  {
    id: 'chat',
    title: '对话基础',
    rows: [
      row('replyOnlyWhenMentioned', '群里只理被 @ 的', '关掉后群里每句话都会进模型（费额度）'),
      row('acceptPrivate', '允许私聊', '关掉后私聊一律不理'),
      row('memoryEnabled', '长期记忆', '关掉后不再记住群里的事'),
      row('sessionResumeEnabled', '会话续接', '关掉后每次都是新会话'),
      row('dedupEnabled', '重复消息去重', ''),
      row('rateLimitEnabled', '回复限流', ''),
    ],
  },
  {
    id: 'ops',
    title: '群运营工具箱',
    rows: [
      row('groupOpsEnabled', '群运营总开关', '关掉后下面这些命令全部不响应'),
      row('opsReadEnabled', '只读查询', '/全体余量 /禁言名单 /群详细 /打卡名册 /管理员名单'),
      row('opsAdminEnabled', '管理员设置', '/设管理 · /撤管理'),
      row('opsInvitePolicyEnabled', '邀请策略', '/邀请策略'),
      row('opsAddOptionEnabled', '加群方式', '/加群方式'),
      row('requestSyncEnabled', '申请补拉', '/申请（把没人管的入群申请补进审批队列）'),
      row('adminWatchEnabled', '管理员变动播报 + 权限自愈', '机器人被撤管理员时会说明原因'),
      row('nativeSignEnabled', 'QQ 原生群打卡', '/群打卡'),
      row('opsKickEnabled', '批量踢', '/批量踢（二次确认）'),
      row('opsTodoEnabled', '群待办', '/待办'),
      row('opsReportEnabled', '运营周报', '/周报'),
    ],
  },
  {
    id: 'fun',
    title: '娱乐与互动',
    rows: [
      row('fortuneEnabled', '每日运势', ''),
      row('diceEnabled', '骰子', ''),
      row('pointsEnabled', '积分', ''),
      row('gameEnabled', '小游戏', ''),
      row('checkinEnabled', '本地签到', '与 QQ 原生打卡是两件事'),
      row('voteEnabled', '投票', ''),
      row('todoEnabled', '待办提醒', ''),
      row('statsEnabled', '活跃统计', ''),
      row('mcStatusEnabled', 'MC 服务器状态', ''),
      row('pokeEnabled', '戳一戳回应', ''),
      row('welcomeEnabled', '入群欢迎', ''),
    ],
  },
  {
    id: 'media',
    title: '语音与媒体',
    rows: [
      row('ttsEnabled', '语音回复', '需要本地 GPT-SoVITS 或云端 TTS 可用'),
      row('sttEnabled', '语音转文字', '你发语音时先转写再回答'),
      row('voiceReadingEnabled', '朗读语音消息', ''),
      row('imageGenEnabled', 'AI 生图', ''),
      row('ocrEnabled', '图片文字识别', ''),
      row('albumEnabled', '群相册上传', ''),
      row('groupFileEnabled', '群文件', ''),
      row('fileTransferEnabled', '私聊文件转存', ''),
    ],
  },
  {
    id: 'safety',
    title: '安全与风控',
    advanced: true,
    rows: [
      row('verifyEnabled', '入群验证', '进群先答对问题'),
      row('filterEnabled', '内容过滤', ''),
      row('floodEnabled', '刷屏治理', ''),
      row('antiRecallEnabled', '防撤回', ''),
      row('keywordEnabled', '关键词回复', ''),
      row('leaveGroupEnabled', '允许 /退群', ''),
    ],
  },
  {
    id: 'record',
    title: '记录与通知',
    advanced: true,
    rows: [
      row('traceEnabled', '轨迹 trace', '控制台的调试依据，关掉后排查会瞎'),
      row('recordInbound', '入站录制', '回放功能依赖它'),
      row('historyArchiveEnabled', '历史归档', ''),
      row('historySearchEnabled', '历史检索', ''),
      row('exportEnabled', '导出对话', ''),
      row('dailyReportEnabled', '每日日报', ''),
      row('broadcastEnabled', '定时播报', ''),
      row('notifyEnabled', '推送通知', ''),
    ],
  },
  {
    id: 'advanced',
    title: '高级与调试',
    advanced: true,
    rows: [
      row('injectEnabled', '注入通道', '给回放/干跑用的假事件入口'),
      row('injectDryRun', '注入干跑', '开着时注入回合一个出站帧都不发'),
      row('actionAuditEnabled', '动作审计', ''),
      row('autoHealEnabled', '掉线自愈', '需要配自愈脚本'),
      row('webhookEnabled', 'Webhook 接收', ''),
      row('groupReadEnabled', '只读群信息', '/群信息 /精华 等'),
      row('memberQueryEnabled', '成员查询', '/成员'),
      row('friendListEnabled', '好友列表', ''),
      row('historyQueryEnabled', '历史消息查询', ''),
    ],
  },
]

/** 面板允许改的键（白名单）：设置界面绝不变成"任意配置编辑器"。 */
export const PANEL_KEYS = PANEL_GROUPS.flatMap((group) => group.rows.map((entry) => entry.key))

/**
 * 把生效配置整理成前端要的形状。
 * `defaults` 传 schema 的默认值（可选），仅在界面里做"非默认"提示用。
 * `fileValues` 传配置文件里的原始值（可选）：与生效值不一致 = 待重启。
 */
export function panelSnapshot(config = {}, { defaults = {}, fileValues = null } = {}) {
  const groups = PANEL_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    advanced: group.advanced === true,
    rows: group.rows.map((entry) => {
      const value = config?.[entry.key]
      const fromFile = fileValues && Object.hasOwn(fileValues, entry.key) ? fileValues[entry.key] : null
      return {
        key: entry.key,
        label: entry.label,
        hint: entry.hint,
        value: value === true,
        nonDefault: Object.hasOwn(defaults, entry.key) ? value !== defaults[entry.key] : false,
        fileValue: fromFile === null ? null : fromFile === true,
        pending: fromFile === null ? false : fromFile !== (value === true),
      }
    }),
  }))
  return { ok: true, version: 1, groups }
}

// ── 文本层：行尾与末尾换行必须原样保留（Windows 上 patch 常是 CRLF，改动后混排会很难看）──

/** 行尾风格：出现 CRLF 就按 CRLF 写回。 */
function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** 拆行：同时记住行尾与"末尾有没有换行"。 */
function splitLines(text) {
  const eol = detectEol(text)
  const trailing = text.endsWith('\n')
  const body = trailing ? text.slice(0, -1) : text
  return { eol, trailing, lines: body.split(eol).map((line) => line.replace(/\r$/, '')) }
}

/** 拼回：行尾与末尾换行按拆行时的信息还原。 */
function joinLines(meta, lines) {
  return lines.join(meta.eol) + (meta.trailing ? meta.eol : '')
}

/** 从 profile 的 patch 文本里读出本插件条目上某个键的原始布尔值；没有则 null。 */
export function readPatchValue(yamlText, key, pluginId = 'dsh-qq-onebot-bridge') {
  const block = pluginBlock(yamlText, pluginId)
  if (!block || !block.childIndent) return null
  const line = block.lines.find((entry) => keyLine(entry.text, key, block.childIndent))
  if (!line) return null
  const raw = line.text.slice(line.text.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

/**
 * 在 patch 文本里 upsert 一个键（只动本插件条目）。
 * 返回 `{ ok, yaml, changed, reason }`——失败时 `yaml` 原样返回，调用方据此拒绝写入。
 *
 * 三条"不许猜"的规矩（都是对抗性审查用可复现用例逼出来的）：
 *   ① **缩进从文件里量**，不假设 `config` 的子键就是"父缩进 + 2"——用 `yaml.stringify(…, {indent:4})`
 *      产出的 4 空格 patch 是合法的，硬编码 +2 会把它改成非法 YAML，宿主下次启动直接拒载；
 *   ② **键必须正好在 config 的直接子层**（缩进 === childIndent）——否则多行字符串（`|` 块）里
 *      恰好长得像 `key: value` 的那一行会被当成真键，进而写出重复键或错误缩进；
 *   ③ **CRLF / 末尾换行原样保留**，比较时忽略行尾——否则"已经是这个值"永远判不出来，每点一次都重写。
 */
export function upsertPatchValue(yamlText, key, value, { pluginId = 'dsh-qq-onebot-bridge', note = '' } = {}) {
  if (typeof value !== 'boolean') return { ok: false, yaml: yamlText, changed: false, reason: '只接受布尔开关（true/false）' }
  const text = String(yamlText ?? '')
  if (text.trim() === '') return { ok: false, yaml: text, changed: false, reason: 'profile 的 cordis.patch.yml 是空的，无法写入' }
  const block = pluginBlock(text, pluginId)
  if (!block) return { ok: false, yaml: text, changed: false, reason: `这个 profile 的配置里没有 ${pluginId} 条目（先把它装进该 profile）` }
  if (!block.configIndent) return { ok: false, yaml: text, changed: false, reason: `${pluginId} 条目里没有 config 块，无法写入` }
  if (!block.childIndent) {
    return {
      ok: false,
      yaml: text,
      changed: false,
      reason: block.sequenceChild
        ? `${pluginId} 的 config 块第一层是列表，量不出映射子键的缩进——宁可不写，也不产出宿主解析不了的 YAML`
        : `${pluginId} 的 config 块读不出子键缩进，为安全起见不写`,
    }
  }

  const meta = splitLines(text)
  const lines = meta.lines
  const existing = block.lines.find((entry) => keyLine(entry.text, key, block.childIndent))
  const next = `${block.childIndent}${key}: ${value ? 'true' : 'false'}`

  if (existing) {
    if (existing.text.trimEnd() === next) return { ok: true, yaml: text, changed: false, reason: '已经是这个值' }
    lines[existing.index] = next
    return { ok: true, yaml: joinLines(meta, lines), changed: true, reason: '' }
  }
  // 新键插在 config 块**末尾**（下一条同缩进的内容之前），保留块内的注释与顺序。
  const insert = note ? [`${block.childIndent}# ${note}`, next] : [next]
  lines.splice(block.configEnd, 0, ...insert)
  return { ok: true, yaml: joinLines(meta, lines), changed: true, reason: '' }
}

/** 这一行是不是"正好在 childIndent 这一层"的 `key:`（注释行、多行字符串内容、更深层都不算）。 */
function keyLine(text, key, childIndent) {
  if (/^\s*#/.test(text)) return false
  const indent = /^(\s*)/.exec(text)[1]
  if (indent !== childIndent) return false
  return new RegExp(`^${childIndent}${key}\\s*:`).test(text)
}

/**
 * 定位本插件条目：`- id: <pluginId>` → 它下面的 `config:` → 子键缩进与结束位置。
 * 纯行扫描（不解析 YAML），因此能原样保留注释与排版。
 *
 * 同名条目有多条时取**最后一条**：DSH 自己（dsh-plugin-manager）也是 `findLast`，
 * 面板必须和平台改同一条，否则会出现"点了没反应"（平台生效的是后一条）。
 */
function pluginBlock(yamlText, pluginId) {
  const { lines } = splitLines(String(yamlText ?? ''))
  // id 允许加引号、也允许行尾注释——不然一个合法的 patch 会被误报成"没有这个条目"。
  const entryRe = new RegExp(`^(\\s*)-\\s+id:\\s*["']?${pluginId}["']?\\s*(?:#.*)?$`)
  let start = -1
  let entryIndent = ''
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = entryRe.exec(lines[index])
    if (match) { start = index; entryIndent = match[1]; break }
  }
  if (start === -1) return null

  // 条目的范围：到下一个同缩进的 `- ` 或文件末尾。
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (new RegExp(`^${entryIndent}-\\s`).test(lines[index])) { end = index; break }
  }
  const entryLines = []
  for (let index = start; index < end; index += 1) entryLines.push({ index, text: lines[index] })

  // config 块：条目内的 `config:` 行（值必须为空，带内容的 config 不是块）。
  const configLine = entryLines.find((entry) => /^\s*config\s*:\s*$/.test(entry.text))
  if (!configLine) return { start, end, lines: entryLines, configIndent: '', childIndent: '', configEnd: end }
  const parentIndent = /^(\s*)/.exec(configLine.text)[1]

  // 子键缩进**从文件里量**：config 之后第一行"比父缩进深"的内容行（跳过空行与注释）。
  let childIndent = ''
  let configEnd = end
  let sequenceChild = false
  for (let index = configLine.index + 1; index < end; index += 1) {
    const text = lines[index]
    if (text.trim() === '' || /^\s*#/.test(text)) continue
    const indent = /^(\s*)/.exec(text)[1]
    if (indent.length <= parentIndent.length) { configEnd = index; break }
    if (childIndent === '') {
      // 第一层就是序列项（`- 10001`）时**量不出映射子键的缩进**：宁可不写，
      // 也不能把 `key:` 写在序列缩进上（js-yaml 会判 bad indentation，宿主启动直接拒载）。
      if (/^\s*-\s/.test(text)) { sequenceChild = true; break }
      childIndent = indent
    }
  }
  if (sequenceChild) return { start, end, lines: entryLines, configIndent: `${parentIndent}  `, childIndent: '', configEnd, sequenceChild: true }
  // config 是空的（后面没有更深的内容行）：只能按 YAML 的 2 空格惯例给一个，且仅在此时才猜。
  if (childIndent === '') childIndent = `${parentIndent}  `
  return { start, end, lines: entryLines, configIndent: `${parentIndent}  `, childIndent, configEnd }
}

/** 面板返回给前端的"这批开关需要重启吗"说明（不猜：由 pending 徽标逐行显示）。 */
export const PANEL_NOTES = {
  apply: '写入 profile 的 cordis.patch.yml 后会触发 DSH 热重载该插件条目（QQ 桥会短暂重连一下），随后新开关生效；若宿主没开热重载，重启宿主后生效。写入是原子的（先写临时文件再改名），并留一份 .bak-qqai 备份。',
  scope: '这里只放了常用的功能开关；其余配置仍可直接改 profile 的 cordis.patch.yml。',
}

/** `git+https://github.com/me/repo.git` → `https://github.com/me/repo`（面板要的是能点的链接）。 */
export function normalizeRepoUrl(url) {
  const raw = String(url ?? '').trim()
  if (raw === '') return ''
  return raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
}

/**
 * 面板底部的链接：**更新日志**与**调试台**。
 * 目标全部由真实来源推导（版本/仓库来自 package.json，端口来自控制台的 qq-control.json），不写死地址；
 * 控制台 token **故意不进面板**（它是本机密钥），所以只给根地址 + 一句"怎么拿到带 token 的地址"。
 */
export function panelFooterLinks({ version = '', repoUrl = '', consolePort = 8799 } = {}) {
  const repo = normalizeRepoUrl(repoUrl)
  const links = []
  if (repo !== '') {
    links.push({
      id: 'changelog',
      label: version ? `更新日志（v${version}）` : '更新日志',
      hint: '每个版本的改动、修掉的缺陷与测试计数',
      href: `${repo}/blob/main/CHANGELOG.md`,
    })
    links.push({
      id: 'readme-debug',
      label: '调试文档',
      hint: 'trace / 回放 / 体检 / 注入的用法（README 的调试章节）',
      href: `${repo}#调试v04一切皆可调试`,
    })
  }
  links.push({
    id: 'console',
    label: '调试台（独立控制台）',
    hint: `实时事件流 · trace 检索 · 体检 · 诊断包 · 离线回放 · 注入；本机 127.0.0.1:${consolePort}`,
    href: `http://127.0.0.1:${consolePort}/`,
  })
  return links
}

/**
 * 底部链接 + **调试台的真实状态**。
 * 为什么要状态：调试台是**独立进程**（`control/`，默认 8799），插件不会替你启动它——
 * 第一版只给了一个裸链接，用户点进去只看到连不上，还不知道为什么。现在如实标出"运行中/未启动"，
 * 并把可直接复制的启动命令一起给出来。
 * `href` 改指宿主自己的 `/qqai/console`：**跑着**就 302 到带 token 的地址（token 在服务端读出、
 * 不进面板载荷），**没跑**就回一页"怎么启动"——不再是死链。
 */
export function panelFooterLinksWithConsole({
  version = '', repoUrl = '', consolePort = 8799, consoleRunning = false, startCommand = '',
} = {}) {
  const links = panelFooterLinks({ version, repoUrl, consolePort })
  const consoleLink = links.find((link) => link.id === 'console')
  if (consoleLink) {
    consoleLink.href = '/qqai/console'
    consoleLink.running = consoleRunning === true
    consoleLink.state = consoleRunning === true
      ? `运行中 · http://127.0.0.1:${consolePort}/`
      : `未启动 · 需要单独运行：${startCommand || 'node control/bin/qq-control.mjs'}`
    consoleLink.hint = consoleRunning === true
      ? '实时事件流 · trace 检索 · 体检 · 诊断包 · 离线回放 · 注入（点开就是带 token 的地址）'
      : '调试台是独立进程，插件不会自动启动它：先在插件目录里跑上面那条命令，再点这个链接'
  }
  return links
}
