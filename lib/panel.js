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

/**
 * 一个开关在面板里的样子。
 * - `hint`：**这个开关到底做什么** + 需要什么 + 关掉会怎样（用户反馈"就写了串英文，都没写需要额外软件"，
 *   所以每行都必须是完整说明，空提示会被单测判红）；
 * - `needs`：依赖标记（空 = 开箱即用）。取值词表见 `PANEL_NEEDS`，界面渲染成一个小标签，
 *   让人一眼看出"这个开关要额外装东西/填密钥"。
 * `key` 必须与 lib/index.js 的 schema 一致（单测钉死）。
 */
const row = (key, label, hint = '', needs = '') => ({ key, label, hint, needs })

/** 依赖标记的词表（界面按这个顺序渲染，别随意加近义词）。 */
export const PANEL_NEEDS = {
  service: '需自备服务',
  key: '需自备密钥',
  file: '需自备词表',
  config: '需配置',
  admin: '需群管理员',
  napcat: '需 NapCat 扩展',
  npmodel: '不需模型',
}

/**
 * 分组：前 4 组是日常会动的；后 3 组标 `advanced`，界面里默认折叠。
 * 之所以不直接暴露全部布尔键：面板要的是"能一眼看完的开关"，其余仍走配置文件。
 */
export const PANEL_GROUPS = [
  {
    id: 'chat',
    title: '对话基础',
    rows: [
      row('replyOnlyWhenMentioned', '群里只理被 @ 的', '群里只有 @ 到机器人才回话；私聊不受影响。关掉后群里每句话都会进模型（费额度）。'),
      row('acceptPrivate', '允许私聊', '私聊是否响应（仍然受 allowUsers 白名单限制）。关掉后私聊一律不理。'),
      row('memoryEnabled', '长期记忆', '把每个会话最近的对话存到 <cwd>/qq-memory/，宿主重启后重新注入，机器人才"记得"之前聊过什么。关掉后不再记住群里的事。', PANEL_NEEDS.config),
      row('sessionResumeEnabled', '会话续接', '宿主重启后接着用同一个会话（完整上下文，不只是记忆窗口）。关掉后每次重启都是新会话。'),
      row('dedupEnabled', '重复消息去重', '忽略重复的入站消息（NapCat 重连后重复投递的那条），时间窗见 dedupWindowSeconds（默认 30 秒）。'),
      row('rateLimitEnabled', '回复限流', '出站回复限流（默认关，主要防风控）：每个会话在 rateLimitWindowSeconds 内最多回 rateLimitMaxReplies 条，超出的丢弃并记账。阈值可改这两个配置键。', PANEL_NEEDS.config),
    ],
  },
  {
    id: 'ops',
    title: '群运营工具箱',
    rows: [
      row('groupOpsEnabled', '群运营总开关', '打开后下面这些命令才响应：原生群打卡、@全体余量、禁言名单、批量踢、群待办、群资料、文件整理、相册上传、运营周报。**大多数子命令要求机器人是该群管理员**；关掉后整组命令都不响应。', PANEL_NEEDS.admin),
      row('opsReadEnabled', '只读查询', '/全体余量 /禁言名单 /群资料 /入群通知 等只读查询（纯查询，不改群）。需要先打开上面的总开关。', PANEL_NEEDS.napcat),
      row('opsAdminEnabled', '管理员设置', '/设管理、/撤管理（set_group_admin）。需要机器人是管理员；目标必须**在本群里**，否则 NapCat 会报 get Uid Error（面板所在的宿主会把它翻译成中文原因）。', PANEL_NEEDS.admin),
      row('opsInvitePolicyEnabled', '邀请策略', '/邀请策略 关闭|需审核|免审核|百人以下 —— 四个取值来自 NapCat 的文档字面量。需要机器人是管理员。', PANEL_NEEDS.admin),
      row('opsAddOptionEnabled', '加群方式', '/加群方式 <1–5> [问题=… 答案=…]。add_type 在 NapCat 里是裸号码、没有官方枚举，所以机器人不替你"翻译"这些数字的含义。需要机器人是管理员。', PANEL_NEEDS.admin),
      row('requestSyncEnabled', '申请补拉', '/申请：主动把待处理的入群申请与可疑好友申请拉进审批队列，离线期间错过的也不会漏（审批用 /待审、/同意 N、/拒绝 N）。', PANEL_NEEDS.napcat),
      row('adminWatchEnabled', '管理员变动播报 + 权限自愈', '监听管理员变动：机器人被授权/被撤权时在群里说明；被撤之后写命令会直接告诉你"我不是管理员"，不会去瞎调接口。'),
      row('nativeSignEnabled', 'QQ 原生群打卡', '/群打卡 —— QQ **原生**的群打卡（set_group_sign）。注意它跟本地签到（娱乐组里的"本地签到"）是两回事。', PANEL_NEEDS.admin),
      row('opsKickEnabled', '批量踢', '/批量踢：需要**在群里二次确认**才会真正执行，防误触。需要机器人是管理员。', PANEL_NEEDS.admin),
      row('opsTodoEnabled', '群待办', '/待办、/完成待办、/取消待办（引用一条消息来指定）。需要机器人是管理员。', PANEL_NEEDS.admin),
      row('opsReportEnabled', '运营周报', '/周报，以及喂给它的运营计数（消息、入群、退群、踢人、禁言、打卡、表情回应）。天数见 opsReportDays。'),
    ],
  },
  {
    id: 'fun',
    title: '娱乐与互动',
    rows: [
      row('fortuneEnabled', '每日运势', '今日人品/运势、抽签、塔罗；按人按天确定性生成——**不调模型、不联网**。', PANEL_NEEDS.npmodel),
      row('diceEnabled', '骰子', '骰子与随机抽选（.r 3d6 / 掷骰 2d6+1 / /抽一个 A B C），纯本地计算。', PANEL_NEEDS.npmodel),
      row('pointsEnabled', '积分', '积分经济（默认关）：聊天与签到赚积分，/积分 看余额、/排行榜 看排行、/转账 @某人 数量 转账。赚取规则见 pointsPerMessage / pointsDailyCap / pointsCheckinBonus。', PANEL_NEEDS.config),
      row('gameEnabled', '小游戏', '群内小游戏：成语接龙、猜数字。说"接龙"/"猜数字"开始，"不玩了"结束。'),
      row('checkinEnabled', '本地签到', '本地打卡（默认关）：群里发关键词（默认"签到"）即打卡，连续天数与总天数按会话存在 <cwd>/qq-checkin/，/签到榜 看排行。**与 QQ 原生群打卡是两件事**（那个要开"群运营"里的 /群打卡）。', PANEL_NEEDS.config),
      row('voteEnabled', '投票', '群投票："投票：问题？A 选项 B 选项"，成员回选项字母投票；/vote、/vote-end 管理，时长见 voteDurationSeconds。'),
      row('todoEnabled', '待办提醒', '共享待办：/todo add|list|done|clear，或直接说"记一下：xxx"；按会话存在 <cwd>/qq-todos/。'),
      row('statsEnabled', '活跃统计', '群活跃统计（默认关）：按人按天统计发言数，/统计、/活跃榜、/周榜 查看；日报也用它。保留天数见 statsKeepDays。', PANEL_NEEDS.config),
      row('mcStatusEnabled', 'MC 服务器状态', 'Minecraft Java 服务器状态：/mc 主机[:端口]，走官方的 Server List Ping 协议——**不需要 API key，只读**。超时见 mcStatusTimeoutMs。', PANEL_NEEDS.npmodel),
      row('pokeEnabled', '戳一戳回应', '被戳一戳时回一句随机可爱话（仅白名单会话）。文案与频率见 pokeReplies / pokeBackText / pokePerHour / pokeCooldownSeconds。'),
      row('welcomeEnabled', '入群欢迎', '新人入群时 @ 他并发送欢迎语（默认关，文案见 welcomeText），只对白名单群生效。'),
    ],
  },
  {
    id: 'media',
    title: '语音与媒体',
    // 组级提示：这一组的能力**插件与 DSH 都不自带**，必须用户自己准备，所以默认全关。
    note: '注意：**语音回复（TTS）与 AI 生图 DSH 与本插件都不自带**——要么本机自己装服务（如 GPT-SoVITS），'
      + '要么去第三方申请密钥，然后在配置里填地址与密钥；**语音转文字 DSH 自带**（实验性的「语音输入」bundle，'
      + '需要你在 DSH 里自行启用，首次用会下载本地 SenseVoice 模型），也可以改配自己的云服务。'
      + '所以这一组**默认全部关闭**；没准备好就别开，开了只会看到"合成失败"的日志。'
      + '另外 OCR / 相册 / 群文件 / 成员查询这些走的是 **NapCat 的专有接口**，换别的 OneBot 实现会不可用。',
    rows: [
      row('ttsEnabled', '语音回复', '每条文字回复后附带一条语音。**DSH 与本插件都不自带 TTS**，要你自己准备：本机装 GPT-SoVITS（ttsProvider=local，配 ttsLocalUrl 与参考音频/提示文本），或去云端申请密钥（Azure 需 ttsApiKey + ttsAzureRegion；OpenAI 兼容需 ttsBaseUrl + ttsModel + ttsApiKey）。没准备时只会回文字，失败原因会记进 trace。', PANEL_NEEDS.service),
      row('sttEnabled', '语音转文字', '群里 @机器人 时引用一条语音、或私聊直接发语音，先转写再回答。**默认走 DSH 自带的本地识别**（`sttProvider: dsh`，SenseVoice，音频不出本机、不需要任何密钥）——前提是你已经在 profile 里启用实验性的「语音输入」bundle（首次使用会下载模型）。想改用云端就把 `sttProvider` 设成 `cloud`，再配 sttBaseUrl / sttModel / sttApiKey（例如智谱 glm-asr）。', PANEL_NEEDS.config),
      row('voiceReadingEnabled', '朗读语音消息', '@机器人 引用一条文字消息说"读一下/念出来"，或 /读 <文本>，机器人用 TTS 念出来。**默认关**，因为它要你自己准备 TTS 服务（DSH 不自带；与"语音回复"共用配置：本地 GPT-SoVITS 或云端密钥）。', PANEL_NEEDS.service),
      row('imageGenEnabled', 'AI 生图', '/画 <描述词> 生成图片并发回来（群里需 @机器人）。**DSH 与本插件都不自带生图模型**，要你自己准备：任何 OpenAI 兼容的图片接口——填 imageGenProvider / imageGenBaseUrl / imageGenApiKey / imageGenModel / imageGenSize；本地部署的（如 SD WebUI / ComfyUI 的兼容接口）也行，把地址填成它即可。图片保存与清理见 imageRetentionDays / imageTrashDir。', PANEL_NEEDS.service),
      row('ocrEnabled', '图片文字识别', '/ocr 读出用户发送或引用图片里的文字（只读）。走 NapCat 的 ocr_image 能力，**不需要额外密钥**。', PANEL_NEEDS.napcat),
      row('albumEnabled', '群相册上传', '/相册 列出群相册（只读）。走 NapCat 的群相册接口，需要机器人在群里有相应权限。', PANEL_NEEDS.napcat),
      row('groupFileEnabled', '群文件', '/文件 列出群文件与目录、/文件 <文件夹> 进入子目录（只读）。条数与大小上限见 groupFileListLimit / groupFileMaxBytes。', PANEL_NEEDS.napcat),
      row('fileTransferEnabled', '私聊文件转存', '私聊里把用户发来的文件存到 <cwd>/qq-files/ 并回复本地路径。大小上限见 fileTransferMaxBytes；给模型回传文件用 fileSendDirs / fileSendMaxBytes。', PANEL_NEEDS.config),
    ],
  },
  {
    id: 'safety',
    title: '安全与风控',
    advanced: true,
    rows: [
      row('verifyEnabled', '入群验证', '入群/加好友申请先进队列，给管理员推一道挑战题；管理员回 /同意 <id>，或对方答对才通过（默认关）。关键词与超时见 verifyKeyword / verifyTimeoutSeconds / verifyMaxPending。', PANEL_NEEDS.config),
      row('filterEnabled', '内容过滤', '敏感词过滤（默认关）：按**本地词表文件**匹配，命中后警告/撤回/禁言（动作见 filterAction）。需要自己准备词表：filterWordsFile。', PANEL_NEEDS.file),
      row('floodEnabled', '刷屏治理', '短时间消息过多先警告、再禁言（默认关）。阈值见 floodWindowSeconds / floodMaxMessages / floodMuteSeconds / floodStrikeLimit。', PANEL_NEEDS.config),
      row('antiRecallEnabled', '防撤回', '缓存最近的入站消息，有人撤回时把内容重新发出来（默认关）。缓存大小与时效见 antiRecallCacheSize / antiRecallMaxAgeMinutes / antiRecallCooldownSeconds。', PANEL_NEEDS.config),
      row('keywordEnabled', '关键词回复', '**本地词表**命中就立刻回复（默认关）——不调模型、也不需要 @机器人。需要自己准备词表文件：keywordFile。', PANEL_NEEDS.file),
      row('leaveGroupEnabled', '允许 /退群', '允许管理员用 /退群 让机器人退出该群（默认关；执行前需要在群里二次确认）。', PANEL_NEEDS.admin),
    ],
  },
  {
    id: 'record',
    title: '记录与通知',
    advanced: true,
    rows: [
      row('traceEnabled', '轨迹 trace', '全链路追踪：每条入站消息有 traceId，每个决策（**包括每次静默丢弃**）都记 stage/ok/reason/耗时到 <cwd>/qq-trace.jsonl。控制台的实时事件流、体检、验收台全靠它——关掉后排查会瞎。级别与落盘见 traceLevel / traceFile。', PANEL_NEEDS.config),
      row('recordInbound', '入站录制', '把每个入站帧按可回放的形状记到 <cwd>/qq-inbox.jsonl。**控制台的离线回放依赖它**（关掉就没法重放历史消息）。'),
      row('historyArchiveEnabled', '历史归档', '把白名单消息归档到 <cwd>/qq-history/YYYY-MM-DD.jsonl，比轮转的 qq-inbox.jsonl 保留得久得多，/找 依赖它。注入/回放的帧不入档。'),
      row('historySearchEnabled', '历史检索', '/找 全文检索历史归档（读本地文件，不联网、不调模型）。', PANEL_NEEDS.npmodel),
      row('exportEnabled', '导出对话', '把一个会话的对话导出成文件（本地生成，方便备份或存档）。'),
      row('dailyReportEnabled', '每日日报', '每天把当天的统计推给指定会话（默认关）。**需要额外的两个前提**：打开"活跃统计"，并配好推送目标。', PANEL_NEEDS.config),
      row('broadcastEnabled', '定时播报', '按计划把内容发到指定群（默认关）。任务本身在配置/控制台的「定时任务」里维护，面板这里只是总开关。', PANEL_NEEDS.config),
      row('notifyEnabled', '推送通知', '把关键事件（掉线、异常、审批等）推送到指定目标（默认关）。需要先配好推送目标。', PANEL_NEEDS.config),
    ],
  },
  {
    id: 'advanced',
    title: '高级与调试',
    advanced: true,
    rows: [
      row('injectEnabled', '注入通道', '允许往桥里注入**假事件**并走真实管线（控制台的"注入场景库"用它做链路验证）。默认关。', PANEL_NEEDS.config),
      row('injectDryRun', '注入干跑', '注入的回合**一个出站帧都不发**（安全网，默认开）。验证链路时保持打开；关掉前请确认你知道会发生什么。'),
      row('actionAuditEnabled', '动作审计', '所有写操作记审计（谁、何时、什么动作、结果），便于事后追责与排查。'),
      row('autoHealEnabled', '掉线自愈', '宿主/桥异常时按脚本自动恢复（默认关）。需要自己提供自愈命令，并确认它真的能拉起进程。', PANEL_NEEDS.config),
      row('webhookEnabled', 'Webhook 接收', '给外部系统一个入口，把事件推进桥里（默认关）。需要外部调用方与配套的密钥配置。', PANEL_NEEDS.config),
      row('groupReadEnabled', '只读群信息', '/群信息、/精华 等只读查询：群号、人数、管理员、群公告与精华消息。走 NapCat 的只读接口，不改动群里任何东西。', PANEL_NEEDS.napcat),
      row('memberQueryEnabled', '成员查询', '/成员 列出群成员（昵称、群名片、角色、入群时间），只读，不会 @ 到任何人；成员很多的大群可能分批返回。', PANEL_NEEDS.napcat),
      row('friendListEnabled', '好友列表', '列出机器人账号的好友（默认关，只读）。这等于把机器人的社交关系摊开，按需再开。', PANEL_NEEDS.napcat),
      row('historyQueryEnabled', '历史消息查询', '按需拉取群/私聊的历史消息（只读），用于补上下文。', PANEL_NEEDS.napcat),
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
    // 组级提示（例如"这一组的能力插件不自带"）——原样带给界面。
    note: group.note ?? '',
    rows: group.rows.map((entry) => {
      const value = config?.[entry.key]
      const fromFile = fileValues && Object.hasOwn(fileValues, entry.key) ? fileValues[entry.key] : null
      const hasDefault = Object.hasOwn(defaults, entry.key)
      return {
        key: entry.key,
        label: entry.label,
        hint: entry.hint,
        needs: entry.needs ?? '',
        value: value === true,
        // `nonDefault` 只说"与默认值不同"——**方向**必须一起给：否则用户看到「非默认」会以为"关着"，
        // 而真机上多数情况其实是"默认关、我把它打开了"（用户原话："正常来讲非默认不是关着的吗？"）。
        defaultValue: hasDefault ? defaults[entry.key] === true : null,
        nonDefault: hasDefault ? value !== defaults[entry.key] : false,
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
 * 面板的「相关链接」一组（客户端把它渲染在**标题正下方、开关分组之前**）。
 *
 * 顺序（用户 2026-10-04 连着**七条**指示才定稿，其中两条是"改回去／再挪"）：
 *   "应该把账号登陆调到最上方" → "不对不对应该在QQ助手的下边" →
 *   "**还是挪回到之前的位置吧，直接把相关链接整体拉到最上边**" →
 *   "**再把调试台和更新日志换一下位置**" → "更新日志改到相关链接的最底下" →
 *   "嗯，还是把更新日志位置改回去吧" → "**调试台改到调试文档下方**"。
 *   ① **QQ助手账号**（机器人账号的登录/扫码；没登录时下面几项都没意义，所以永远第一）
 *   ② 更新日志  ③ 调试文档  ④ **调试台**（最底下）
 * ⇒ 结论：账号入口**永远第一**（它留在数组头上的字面量里），**「调试台」永远最后**
 *   （`panelFooterLinksWithConsole` 会按 id 找到它再加"运行中/未启动"状态，顺序不受影响）。
 *   别再把它拆成独立一段，也别再改这四条的先后。
 *
 * 目标全部由真实来源推导（版本/仓库来自 package.json，端口来自控制台的 qq-control.json），不写死地址；
 * 控制台 token **故意不进面板**（它是本机密钥），所以只给根地址 + 一句"怎么拿到带 token 的地址"。
 * 账号入口指向宿主自己的 `/qqai/account`：服务端读 NapCat 的 token 后 302，token 同样**不进面板载荷**。
 */
export function panelFooterLinks({ version = '', repoUrl = '', consolePort = 8799 } = {}) {
  const repo = normalizeRepoUrl(repoUrl)
  const links = [{
    id: 'account',
    label: 'QQ助手账号（登录 / 扫码）',
    hint: '机器人账号的登录状态与扫码页（NapCat 控制台）；点开就是带 token 的地址，不用手输',
    href: '/qqai/account',
  }]
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
  // 调试台压在最底下（用户 2026-10-04："调试台改到调试文档下方"）——没有仓库信息时它也是最后一条。
  links.push({
    id: 'console',
    label: '调试台（独立控制台）',
    hint: `实时事件流 · trace 检索 · 体检 · 诊断包 · 离线回放 · 注入；本机 127.0.0.1:${consolePort}`,
    href: `http://127.0.0.1:${consolePort}/`,
  })
  return links
}

/**
 * 「相关链接」组 + **调试台的真实状态**。
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
