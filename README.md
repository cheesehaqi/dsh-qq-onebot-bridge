# dsh-qq-onebot-bridge

QQ ↔ DeepSeek Harness 双向桥插件（独立 bundle）。QQ 消息直接驱动 DSH agent 会话，agent 回复自动发回 QQ。

## 功能总览

- **双向消息桥**：QQ（群聊/私聊）消息进入 DSH agent 会话；回复自动分段发回 QQ（OneBot v11 反向 WebSocket）
- **会话续接**：`routeKey → sessionId` 落盘，宿主重启后自动 `resume` 上次的完整会话记录（不是只补记忆窗口）；`/new` 才真正重开
- **agent 主动能力**：agent 可调用 `qq_send_image` / `qq_send_file` / `qq_send_voice` / `qq_recall`——把本地图片、文件、语音发进当前会话，或撤回自己刚发的消息（只允许 cwd 与 `fileSendDirs` 内的文件，凭据类路径一律拒绝）
- **写操作闸门**：禁言/踢人/公告/精华/名片/上传/撤回/合并转发等危险写操作统一限频（每分钟/每日上限）+ 审计日志 `cwd/qq-actions.log`
- **会话分组**：每个群一个独立会话（`sessionMode: chat`）或每群每人一个会话（`user`）；每个私聊用户一个独立会话，互不串上下文；agent 系统提示注入当前会话归属（chatScope）
- **持久化记忆**：每个群/私聊的最近对话自动落盘到 `cwd/qq-memory/`，宿主重启后自动注入新会话——小鲸鱼不会失忆（`memoryEnabled` 开关；`/new` 清除当前会话的记忆）
- **定时提醒**：`30分钟后提醒我喝水`、`明天9点提醒我开会`——到点自动发消息提醒（群聊需 @机器人，@ 时可省略"提醒"字样如「明天9点开会」；私聊需带提醒关键词；提醒跨宿主重启保留，`/reminders` 查看待执行列表）
- **群管理套件**：`/summary` 总结最近聊天；群投票（`投票：问题？A 选项 B 选项`，回复字母投票，自动开奖）；共享待办（`/todo` + 「记一下：xxx」）；管理员命令 `/mute` `/unmute` `/kick`（**踢人需二次确认**）`/clear`（仅 `adminUsers` 白名单可用）
- **语音回复（TTS）**：文字回复后自动跟一条语音——云端（默认 Azure 晓晓，`ttsProvider` 可切任意 OpenAI 兼容服务）或**本地 GPT-SoVITS 语音克隆**（`ttsProvider: local`，零 API 成本，3-10 秒参考音频即克隆音色）；`ttsEnabled` 默认关闭
- **避开高峰期**：工作日 9:00-12:00 与 14:00-18:00 不回复任何消息（`quietHoursEnabled` 默认关闭，时段可改，周末自动豁免；已排定的提醒/开奖不受影响）
- **互动功能**：`/help` 命令菜单；戳一戳卖萌回复（`pokeEnabled`）；语音朗读（@我引用文字说「读一下」或 `/读 文字`）；每日签到打卡（`checkinEnabled` 默认关闭）；新人入群自动欢迎（`welcomeEnabled` 默认关闭）
- **生图**：`/画 描述词` 生成图片发回（`imageGenEnabled` 默认关闭，群聊需 @；`imageGenProvider: openai` 接任意 OpenAI 兼容 `/images/generations`，或 `local` 接本地 Stable Diffusion WebUI——高拓展，加后端只需一个分支）
- **群洞察与日报**：`statsEnabled` 发言统计（`/统计` 今日榜、`/周榜` 周榜）；`/荣誉` `/公告` `/群精华` 只读查询；`dailyReportEnabled` 每日定时群日报（agent 总结当天聊天）；`/mc <地址>` 查询 MC 服务器状态；`recurringReminderEnabled` 支持「每天8点」「每周一9点」「每个工作日15点」重复提醒
- **防撤回与群规**：`antiRecallEnabled` 补发被撤回的消息（含图片）；`filterEnabled` 敏感词过滤（提醒/撤回/禁言三种处置，词表热重载）；`floodEnabled` 刷屏警告与阶梯禁言；入群/加好友验证（`verifyEnabled`，管理员 `/同意 <序号>` 审批、口令或答对验证题自动放行）
- **群管套件**：`/mute` `/unmute` `/kick` `/clear`，以及 `/公告` `/精华` `/名片` `/头衔` `/全员禁言`（全部走统一写操作闸门）
- **零成本互动包**：关键词问答库（`/kw add`，命中即回、零 token）、今日人品/运势/抽签/塔罗（按 QQ 号+日期确定性生成）、骰子与随机抽人、积分经济（发言/签到得积分、`/转账`）、群内小游戏（成语接龙 373 词库、猜数字）——全部本地计算，不消耗模型
- **实用小工具**：`/health` 运行诊断、私聊文件自动转存到本机、`/export` 聊天记录导出 markdown
- **语音转文字（STT）**：群聊中 @机器人并引用（回复）一条语音 → 转写文字并回复；私聊语音直接转写。支持智谱 GLM-ASR-2512 或任意 OpenAI 兼容 `/audio/transcriptions` 端点（如 SiliconFlow）
- **私聊识图**：私聊中用户发送的图片/动画表情自动下载到 `cwd/qq-images/` 并注入会话，agent 用 `describe_image` 主动查看并回应（`privateImageView` 开关）
- **引用解析**：@机器人并引用文本/图片/语音时自动展开（图片落盘到 `cwd/qq-replies/` 供 `describe_image` 查看，语音自动转写）
- **表情系统**：黄脸表情表 + 回复里 `[face:名字]` 标记替换 + 图片表情收藏（`autoCollectStickers`）+ 会话内 `qq_face_list` / `qq_face_send` 工具（`faceEnabled` 总开关）
- **会话命令**：`/new` 重置当前会话、`/status` 查看会话状态、`/撤回` 撤回机器人上一条消息
- **安全控制**：`allowUsers` / `allowGroups` 白名单、`accessToken` 鉴权、`replyOnlyWhenMentioned` 群聊仅@回复
- **人设解耦**：插件**不包含任何人设/记忆内容**——人设与群规则经 dsh-mnemon 的 `USER.md`/`MEMORY.md` 注入会话（见文末说明）

## 架构

```
QQ 客户端 ←→ OneBot 实现（NapCat / LLOneBot / OpenShamrock / Lagrange…）
                  │ 反向 WebSocket（OneBot 连我们；端口 6700）
                  ▼
        dsh-qq-onebot-bridge（本插件）
                  │ ctx.agents.create / followup
                  ▼
        DSH agent 会话（每群/每私聊用户一个）

旁路（都不参与回复决策，出问题也不影响发消息）：
  每条入站事件 ──► qq-inbox.jsonl          （录制：可离线回放）
  每个决策点   ──► qq-trace.jsonl          （结构化事件：stage/ok/reason/耗时/traceId）
  快照每 2s    ──► qq-runtime.json         （会话/闸门/生效配置/录制与注入状态）
  qq-inject.jsonl ◄── 控制台写、桥轮询读   （注入：默认 dry-run，出站全拦截）

独立控制台 control/（进程 8799，不依赖 DSH 桌面端）
  ├─ 读：端口/进程、事件流、决策链、体检、录制列表、运行快照
  ├─ 写：启停宿主/NapCat/TTS、释放端口、离线回放（沙箱 + dry-run）、事件注入
  └─ 鉴权：仅 127.0.0.1 + token + 同源 Origin 校验
```

## 安装 / 卸载

```sh
# 安装（本地目录）
dsh plugin --profile web add <本目录>

# 卸载（随时可移除，独立 bundle 不影响其它插件）
dsh plugin --profile web remove dsh-qq-onebot-bridge
```

装/卸后重启 `dsh web` 生效。

## 配置

profile 的 `cordis.patch.yml` 覆盖 `id: dsh-qq-onebot-bridge` 的 config（完整示例见 `examples/cordis.patch.example.yml`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 反向 WS 监听地址 |
| `port` | `6700` | 反向 WS 监听端口 |
| `accessToken` | `''` | OneBot 端须携带的 Bearer token（空=不校验） |
| `allowUsers` | `[]` | 私聊用户白名单（**空=拒绝所有私聊**，务必填入自己的 QQ 号） |
| `allowGroups` | `[]` | 群白名单（**空=拒绝所有群消息**，列出机器人服务的群号） |
| `botQq` | `0` | 机器人 QQ 号（用于群内 @ 检测；0=任何群消息视为@） |
| `replyOnlyWhenMentioned` | `true` | 群聊仅 @机器人 才回复 |
| `acceptPrivate` | `true` | 是否回复私聊（私聊仍需 allowUsers 放行） |
| `autoCollectStickers` | `false` | 自动收藏消息里的图片表情到本地图库 |
| `faceEnabled` | `true` | 表情功能总开关（[face:] 标记 + qq_face_* 工具） |
| `sessionMode` | `chat` | 群会话分组：`chat`=每群一会话；`user`=每群每人一会话 |
| `cwd` | `''` | 会话工作目录（同时决定 `qq-faces/`、`qq-replies/`、`qq-bridge-debug.log` 的位置） |
| `provider` | `''` | LLM provider 覆盖（空=agent 默认） |
| `model` | `''` | LLM 模型覆盖（空=agent 默认） |
| `maxMessageLength` | `1700` | 单条出站消息最大字符数（超出自动分段） |
| `botName` | `小鲸鱼` | 机器人显示名（合并转发卡片的署名） |
| `sessionResumeEnabled` | `true` | 宿主重启后 `resume` 上次会话（完整记录续接）；关掉则每次重启都新建会话 |
| `agentMediaToolsEnabled` | `true` | 暴露 `qq_send_image` / `qq_send_file` / `qq_send_voice` / `qq_recall` 工具 |
| `fileSendDirs` | `[]` | agent 允许发送文件的额外目录（会话 cwd 始终允许） |
| `fileSendMaxBytes` | `52428800` | agent 可发送的单文件大小上限（字节，默认 50 MiB） |
| `imageSendMaxBytes` | `4194304` | 图片超过此大小（默认 4 MiB）先用 ffmpeg 压缩再发 |
| `recallWindowSeconds` | `110` | 出站消息可被 `qq_recall` / `/撤回` 撤回的时间窗（秒） |
| `forwardLongReplies` | `false` | 群聊超长回复改发合并转发卡片 |
| `forwardThresholdChars` | `600` | 触发合并转发的字数阈值 |
| `actionRatePerMinute` | `20` | 写操作闸门：全部会话合计每分钟上限 |
| `actionRatePerDay` | `500` | 写操作闸门：全部会话合计每日上限 |
| `actionAuditEnabled` | `true` | 写操作与拒绝记录写入 `cwd/qq-actions.log` |
| `keywordEnabled` | `false` | 关键词问答库（**默认关闭**）：命中本地词库直接回复，不走模型、不需要 @ |
| `keywordFile` | `''` | 词库文件路径（空=`cwd/qq-keywords.json`）；支持 exact/contains/regex、随机多答、图片、作用域与冷却 |
| `fortuneEnabled` | `true` | 今日人品/运势、抽签、塔罗（按 QQ 号+日期确定性生成，纯本地） |
| `diceEnabled` | `true` | 骰子（`.r 3d6`）与随机抽人（`/抽一个 A B C`） |
| `pointsEnabled` | `false` | 积分经济（**默认关闭**）：`/积分` `/排行榜` `/转账 @某人 数量` |
| `pointsPerMessage` | `1` | 每条消息获得的积分（0=聊天不得分） |
| `pointsDailyCap` | `20` | 每人每日通过聊天可得积分上限 |
| `pointsCheckinBonus` | `5` | 每日签到额外奖励积分 |
| `gameEnabled` | `false` | 群内小游戏（**默认关闭**）：成语接龙、猜数字 |
| `idiomChainTimeoutSeconds` | `120` | 接龙闲置超时（秒） |
| `guessNumberMax` | `100` | 猜数字上限（1~N） |
| `guessNumberMaxTries` | `10` | 猜数字可用次数 |
| `antiRecallEnabled` | `false` | 防撤回（**默认关闭**）：缓存最近消息，被撤回时补发内容 |
| `antiRecallInGroup` | `true` | 补发到群里（false=私聊发给第一个管理员） |
| `antiRecallImages` | `true` | 一并补发被撤回的图片（最多 3 张） |
| `antiRecallCacheSize` | `50` | 每会话缓存的消息条数 |
| `antiRecallMaxAgeMinutes` | `120` | 缓存消息可恢复时长（分钟） |
| `antiRecallCooldownSeconds` | `5` | 同一会话两次补发的最小间隔 |
| `filterEnabled` | `false` | 敏感词过滤（**默认关闭**） |
| `filterWordsFile` | `''` | 词表路径（空=`cwd/qq-badwords.txt`；`#` 注释、`re:` 正则、改动自动热重载） |
| `filterAction` | `warn` | 处置方式：`warn` 提醒 / `recall` 撤回 / `mute` 禁言 |
| `filterMuteSeconds` | `300` | `mute` 处置与刷屏升级时的禁言秒数 |
| `filterWhitelist` | `[]` | 白名单词/正则（命中即放行） |
| `floodEnabled` | `false` | 刷屏防护（**默认关闭**） |
| `floodWindowSeconds` | `10` | 刷屏统计窗口（秒） |
| `floodMaxMessages` | `8` | 窗口内允许的消息条数 |
| `floodMuteSeconds` | `300` | 刷屏升级禁言秒数 |
| `floodStrikeLimit` | `3` | 警告几次后禁言 |
| `verifyEnabled` | `false` | 入群/加好友验证（**默认关闭**）：请求进队列并私聊推送管理员 |
| `verifyKeyword` | `''` | 口令：验证消息包含它则自动放行（空=全部人工审批） |
| `verifyTimeoutSeconds` | `300` | 请求超时时间（超时出队并提醒管理员） |
| `verifyMaxPending` | `20` | 待审队列上限 |
| `statsEnabled` | `false` | 发言统计（**默认关闭**）：`/统计` 今日活跃榜、`/周榜` 周榜，并作为日报数据源 |
| `statsKeepDays` | `30` | 发言统计保留天数 |
| `groupReadEnabled` | `true` | 只读群信息：`/荣誉` `/公告` `/群精华` |
| `mcStatusEnabled` | `true` | `/mc <host[:port]>` 查询 Minecraft Java 服务器状态（Server List Ping，无 Key） |
| `mcStatusTimeoutMs` | `5000` | MC 状态查询超时（毫秒） |
| `recurringReminderEnabled` | `true` | 重复提醒：「每天8点」「每周一9点」「每个工作日15点」 |
| `dailyReportEnabled` | `false` | 每日群日报（**默认关闭**）：到点让 agent 总结当天聊天并发到群里 |
| `dailyReportTime` | `22:00` | 日报时间（本地 HH:mm） |
| `dailyReportChats` | `[]` | 固定接收日报的会话（如 `["g:100000001"]`；为空则用 `/日报 on` 的开关，再为空则回落到全部群白名单） |
| `sttEnabled` | `false` | 语音转文字总开关 |
| `sttBaseUrl` | `https://open.bigmodel.cn/api/paas/v4` | STT 端点（OpenAI 兼容 `/audio/transcriptions`） |
| `sttModel` | `glm-asr-2512` | STT 模型（智谱 `glm-asr-2512` / SiliconFlow `FunAudioLLM/SenseVoiceSmall`） |
| `sttApiKey` | `''` | STT API Key（可复用智谱 GLM 系列的 key） |
| `privateImageView` | `true` | 私聊中主动下载查看对方发送的图片/动画表情（存 `cwd/qq-images/`，agent 用 describe_image 查看） |
| `visionMode` | `tool` | 识图方式：`tool`=存盘后由 `visionToolName` 工具查看（稳定）；`native`=原生多模态附件直传模型（DSH 0.1.1+，文本模型自动降级） |
| `visionToolName` | `describe_image` | `tool` 模式下使用的识图工具名 |
| `imageRetentionDays` | `14` | 下载图片（qq-images/qq-replies）保留天数，宿主启动时清理更旧的 |
| `imageTrashEnabled` | `true` | **删除策略：只回收不销毁**——过期图片移动到 `cwd/qq-trash/<日期>/` 而不是删除（失败则保留原文件） |
| `imageTrashDir` | `''` | 回收目录（空=`cwd/qq-trash`）；该目录**不会自动清理**，由你自行处理（本机可 `scripts/safe-delete.ps1` 送进回收站） |
| `memoryEnabled` | `true` | 每会话持久化记忆（最近对话存 `cwd/qq-memory/`，宿主重启后自动恢复；`/new` 清除） |
| `memoryMaxEntries` | `30` | 每个会话保留的对话条数上限 |
| `rateLimitEnabled` | `false` | 回复限流开关（默认关闭）；开启后每会话窗口内最多回复 `rateLimitMaxReplies` 条 |
| `rateLimitMaxReplies` | `10` | 限流窗口内每会话最大回复数 |
| `rateLimitWindowSeconds` | `60` | 限流滑动窗口（秒） |
| `dedupEnabled` | `true` | 消息去重（同一 message_id 窗口内重复投递忽略，防重连重发） |
| `dedupWindowSeconds` | `300` | 去重窗口（秒） |
| `reminderEnabled` | `true` | 定时提醒总开关（群聊需 @，私聊直接说；存 `cwd/qq-reminders.json` 跨重启保留） |
| `reminderMaxPerChat` | `10` | 每个会话最多同时保留的提醒数 |
| `quietHoursEnabled` | `false` | 避开高峰期开关（**默认关闭**）；开启后工作日静默时段内不回复任何入站消息（不消耗模型调用），已排定的定时提醒/投票开奖照常 |
| `quietHours` | `['9:00-12:00', '14:00-18:00']` | 静默时段（本地时间 `H:MM-H:MM`，全角冒号自动归一化；可跨午夜如 `22:00-2:00`） |
| `quietWeekendExempt` | `true` | 周六/周日不受静默时段限制 |
| `ttsEnabled` | `false` | 语音回复总开关（默认关闭；开启后每条文字回复后跟随一条语音） |
| `ttsProvider` | `azure` | 合成方案：`azure`（微软晓晓）/ `openai`（任意 OpenAI 兼容 `/audio/speech`）/ `local`（**本地 GPT-SoVITS 语音克隆，零 API 成本**） |
| `ttsApiKey` | `''` | Azure / OpenAI 兼容服务的 key（`local` 不需要） |
| `ttsVoice` | `zh-CN-XiaoxiaoNeural` | 云端音色名 |
| `ttsStyle` | `chat` | Azure 语气风格（cheerful/sad…） |
| `ttsMaxChars` | `120` | 语音朗读最大字符数（超出截断，只影响语音不影响文字） |
| `ttsLocalUrl` | `http://127.0.0.1:9880` | 本地 GPT-SoVITS api_v2 服务地址 |
| `ttsLocalRefAudio` | `''` | **本地 TTS 必填**：音色参考音频绝对路径（3-10 秒 wav，如 `D:/voice/xiaojingyu.wav`） |
| `ttsLocalPromptText` | `''` | 参考音频的台词（可留空） |
| `ttsLocalTextLang` | `zh` | 合成文本语言 |
| `ttsLocalPromptLang` | `zh` | 参考音频台词语言 |
| `ttsLocalConvertToMp3` | `true` | 本地 wav 输出用 ffmpeg 自动转 mp3 再发送（QQ/NapCat 兼容性更好） |
| `pokeEnabled` | `true` | 戳一戳回复开关（白名单会话内被戳随机卖萌回复） |
| `pokeReplies` | `[...]` | 戳一戳回复文案列表（随机选一条） |
| `pokeCooldownSeconds` | `15` | 每会话戳一戳回复最小间隔（秒，防刷） |
| `voiceReadingEnabled` | `true` | 语音朗读：@机器人引用文字说「读一下/念出来」，或 `/读 <文字>`（走 ttsProvider 合成） |
| `checkinEnabled` | `false` | 每日签到（**默认关闭**）：说「签到」打卡，连续/累计天数存 `cwd/qq-checkin/`；「签到榜」看排行 |
| `checkinKeyword` | `签到` | 签到触发词 |
| `welcomeEnabled` | `false` | 入群欢迎语（**默认关闭**）：新人进群自动 @+欢迎文案（机器人自己入群不触发） |
| `welcomeText` | `''` | 欢迎文案（空=内置默认文案） |
| `imageGenEnabled` | `false` | 生图开关（**默认关闭**）：`/画 <描述词>` 生成图片（群聊需 @机器人） |
| `imageGenProvider` | `openai` | 生图后端：`openai`=任意 OpenAI 兼容 `/images/generations`（DALL·E/CogView/SiliconFlow…）；`local`=本地 SD WebUI（AUTOMATIC1111） |
| `imageGenBaseUrl` | `''` | 后端地址（空=按 provider 取默认：api.openai.com 或 127.0.0.1:7860） |
| `imageGenApiKey` | `''` | OpenAI 兼容服务 key（local 不需要） |
| `imageGenModel` | `''` | 模型 id（空=服务默认，如 gpt-image-1；local 忽略） |
| `imageGenSize` | `1024x1024` | 图片尺寸 WxH（local 支持任意尺寸如 768x512） |
| `imageGenSteps` | `20` | 采样步数（仅 local） |
| `imageGenCfgScale` | `7` | CFG 提示词强度（仅 local） |
| `imageGenSampler` | `''` | 采样器（仅 local，空=WebUI 默认） |
| `imageGenCooldownSeconds` | `60` | 每会话两次生图最小间隔（秒，成本/刷屏防护） |
| `imageGenDailyLimit` | `20` | 每会话每日生图上限 |
| `imageGenMaxPromptChars` | `400` | 描述词最大字数（超出截断） |
| `imageGenCommand` | `/画` | 生图触发命令 |
| `traceEnabled` | `true` | 全链路结构化事件（每条消息一个 traceId，每个分支带 reason）；关掉则控制台只剩端口/日志能力 |
| `traceLevel` | `debug` | `debug` 记录全部事件（含每次静默/拒绝）；`warn` 只留问题，用于长期运行省磁盘 |
| `traceMemorySize` | `500` | 内存里保留的最近事件数（控制台决策链用），落盘另受 4MiB 轮转上限约束 |
| `traceFile` | `''` | 事件文件路径（空=`cwd/qq-trace.jsonl`） |
| `recordInbound` | `true` | **录制**：把收到的每条消息/通知/请求写进 `qq-inbox.jsonl`（可离线回放）；只写本机、不影响回复 |
| `inboxFile` | `''` | 录制文件路径（空=`cwd/qq-inbox.jsonl`，按 2MiB 轮转） |
| `inboxRedact` | `false` | 录制时把 6 位以上数字（QQ 号）脱敏后再落盘，便于把录制文件发给别人 |
| `injectEnabled` | `false` | **事件注入通道**（默认关闭）：开启后桥每 `injectIntervalMs` 轮询 `qq-inject.jsonl`，把新行喂进真实管线 |
| `injectFile` | `''` | 注入队列路径（空=`cwd/qq-inject.jsonl`）；启动时已有的历史行会被跳过并记一条原因 |
| `injectDryRun` | `true` | **强烈建议保持 `true`**：注入触发的所有出站调用（发消息/撤回/群管…）都被拦截并计数，绝不真发 QQ；**异步 agent 回合的回复同样被拦下**（原文记进事件流） |
| `injectIntervalMs` | `2000` | 注入队列轮询间隔（毫秒，最小 500） |

## 用户侧（OneBot 实现）配置

以 NapCat 为例：OneBot11 配置里把 WebSocket 客户端地址填成：

```
ws://127.0.0.1:6700/
```

其它实现同理（LLOneBot 填反向 WebSocket、OpenShamrock 填被动 WebSocket、go-cqhttp 填 `ws-reverse`）。若本插件配了 `accessToken`，OneBot 端填同一 token。

## 语音转文字（STT）

**触发规则**（最终版）：

| 场景 | 行为 |
|---|---|
| 群聊：@机器人 + 引用（回复）一条语音 | ✅ 转写被引用语音并以文字回复 |
| 群聊：单独发语音（不@/不引用） | ❌ 不触发 |
| 私聊：直接发语音 | ✅ 转写并回复（不受 acceptPrivate 限制） |
| 私聊：文字 + 引用语音 | ✅ 转写被引用语音 |

实现链路：消息里的引用 → `get_msg` 找到被引用消息 → 其中含 `record` 段 → OneBot `get_record`（`out_format` mp3/wav，响应含 `base64`）→ POST `{sttBaseUrl}/audio/transcriptions`（multipart 字段 **`file`** 二进制）→ 转写文本注入会话。

注意事项：
- 智谱 GLM-ASR-2512 限 wav/mp3、**≤ 30 秒**、≤ 25MB；更长的语音请换 SiliconFlow 等端点
- 智谱接口的 multipart 字段必须是 `file`（二进制）——文档里写的 `file_base64` 实测会报 1214 错误

## 会话分组

- 群聊：`sessionMode: chat`（默认）下每个群一个独立会话，全群共享上下文；`user` 下每群每人一个会话
- 私聊：每个私聊用户一个独立会话，与群聊完全隔离
- 会话创建时 agent 系统提示注入 chatScope（"你正在 QQ 群 xxx 里聊天"/"你在和用户 xxx 私聊"），并要求不串上下文
- `/new` 仅重置**当前**会话；会话存内存，宿主重启后重建（不持久化）

## 表情系统

- 回复文本里写 `[face:鼓掌]` 等标记会替换为对应 CQ 表情段（黄脸表见 `lib/faces.js`，约 70 个）
- `faceEnabled=true` 时每个会话注册 `qq_face_list` / `qq_face_send` 工具
- 手动把图片放进 `cwd/qq-faces/` 自动登记为可发送表情（文件名=表情名），删除文件自动剔除
- `autoCollectStickers=true` 时自动收藏群消息里的图片表情

## 命令与调试

- `/new`：结束当前会话并开新会话
- `/status`：查看当前会话状态与 sessionId 前缀
- 调试日志：`{cwd}/qq-bridge-debug.log`（消息路由、语音转写、agent 事件，按时间戳追加）
- 宿主错误日志：启动 dsh web 时把 stderr 重定向到文件（如 `D:\qq-work\qq-host-err.log`）可查启动崩溃
- 关键日志标记：`voice fetched via get_record`、`quoted voice transcribed`、`followup sent (voice)`、`group msg without @bot ignored`

## 测试

三类脚本，共 1517 项断言（`test/*-unit.mjs`）+ 3 个真机脚本：

```sh
# 1) 单元测试：不联网、不起宿主，纯逻辑 + 临时目录（推荐每次改完都跑）
node test/control-unit.mjs        # 也可以逐个跑：node test/<name>-unit.mjs
#    36 个文件：桥的分支/命令/守卫、控制台 HTTP 与体检、录制回放与注入、注入安全边界、硬约束验收台…
#    一次性全跑（PowerShell）：
#    Get-ChildItem test -Filter '*-unit.mjs' | ForEach-Object { node $_.FullName }

# 2) 回放的端到端验收：真实桥代码 + 真实 OneBot 服务端，沙箱 + dry-run，不需要宿主
node test/replay-live.mjs

# 3) 真机脚本（需要宿主/控制台已在运行，自己扮演 OneBot 客户端连 6700）
node test/live-e2e.mjs        # 消息 → 回复 全链路
node test/live-stream.mjs     # 实时事件流 / 决策链 / 体检接口（控制台 8799）
node test/replay-live-host.mjs --token <控制台 token>   # 录制 → 离线回放 → 注入
```

老版本的 `sim-*.mjs` 协议模拟脚本保留在 `test/` 下，仍可用于手工排查（`node test/sim-group.mjs` 等，需宿主运行）。
语音转文字链路建议直接用 QQ 实测（模拟脚本需真实 STT 调用）。

## 记忆与人设说明（重要）

本插件**不内置任何人设、偏好或群规则**。小鲸鱼人设、问答偏好、群内行为规则等记忆内容由 **dsh-mnemon 插件**的运行时记忆（`~/.mnemon/runtime/USER.md` + `MEMORY.md`）注入每个 QQ 会话——插件只负责"功能"，记忆只负责"灵魂"，两者完全解耦。换人设只改 Mnemon 记忆，换功能只动本插件。

## ⚠️ 风险与合规说明（使用前必读）

### 账号风控风险
- 本插件通过**第三方协议实现**（NapCat 等）接入 QQ，**不是腾讯官方接口**，与《QQ 软件许可及服务协议》相悖，QQ 官方明确禁止非官方客户端/协议
- 使用第三方协议存在**账号被限制登录、冻结、甚至永久封禁**的风险，且可能波及其他正常使用的 QQ 账号（同设备/同 IP）
- 建议使用**机器人小号**运行，绝不要用大号/常用号
- 常见风控诱因：高频发言、短时间大量消息、发送营销/广告/违规内容、被多人举报、异常登录设备
- 缓解建议：降低回复频率、仅在小群/自用场景运行、不 24 小时刷屏、严格内容合规

### 内容风控
- agent 生成的一切内容都会以机器人账号身份发出，**使用者对该账号发布的内容负全部责任**
- 建议在人设/系统提示中约束输出合规内容；违规内容既触发账号处罚，也可能带来法律责任

### 安全风险
- `allowUsers` / `allowGroups` 未配置（为空）时，插件**默认拒绝所有私聊与群消息**——请显式填入自己的 QQ 号与群号后再使用；配置白名单后，白名单外的任何人都无法驱动你的 agent
- 插件只监听 `127.0.0.1`，不要改成 `0.0.0.0` 暴露公网
- 语音与图片会上传到第三方云服务（STT API）处理，**敏感语音请勿发送**

### 合规提示
- 仅用于个人学习、内部小范围交流；不得用于批量营销、广告、骚扰、群控等用途
- 遵守所在地区法律法规与腾讯平台规则
- 使用第三方协议**风险自负**，本插件不提供任何免封号承诺

### 免责声明
本插件仅供技术学习与个人研究使用。使用者应自行评估并承担使用第三方 QQ 协议的全部风险与后果。

## 安全注意

- `allowUsers` / `allowGroups` 为空时默认拒绝一切消息——使用前务必填入自己的 QQ 号与群号
- 端口仅监听 127.0.0.1；不要对外暴露
- OneBot 实现本身有 QQ 封号风险，使用第三方机器人协议需自行评估

## 调试（v0.4「一切皆可调试」）

每条入站消息都有一个 **traceId**，每个决策点（**包括每一次"不回复/丢弃/降级"**）都会留下 `stage + ok + reason + 耗时`。这是本版本的核心设计理念：出问题时不用猜。

| 想看什么 | 在哪看 |
|---|---|
| **6 条硬约束此刻达标吗** | 控制台最上面「**硬约束验收台**」：6 行状态灯 + 机器上现有的证据 + 该点哪里的提示，每 30 秒自动重算 |
| 单条消息的完整决策链 | 控制台「实时事件流」点任意一行 → 「决策链」显示时间轴、停在哪一步、为什么 |
| 为什么机器人不回复 | 「实时事件流」筛"仅被拒/失败"，最常见原因直接列出（如 `mention: 群聊未 @ 机器人`） |
| 每个端口的占用与在线 | 控制台「端口 / 进程」（6700 的连接数即机器人在线） |
| 一键排查 | 控制台「一键体检」：15-19 项 pass/fail + 修复建议（依赖路径、端口、链路、快照、错误、闸门拒绝…） |
| 生效配置（为什么功能没生效） | 控制台「运行快照」里的"关闭中的开关"；完整字段在 `qq-runtime.json` 的 `features`（不含任何密钥） |
| 打包给别人看 | 「导出诊断包」→ 一个 zip（事件流/审计/桥日志/宿主日志/运行快照/体检报告/环境信息） |
| 文件级排查 | `qq-trace.jsonl`（结构化事件，可 `jq`/grep）、`qq-bridge-debug.log`、`qq-actions.log`（写操作审计）、`qq-host-out.log`/`err.log` |

相关配置：`traceEnabled`（默认开）、`traceLevel`（`debug` 全量 / `warn` 只留问题）、`traceMemorySize`、`traceFile`。
调试接口（控制台，token + Origin 双重校验）：`/api/trace`、`/api/stream`（SSE）、`/api/runtime`、`/api/diagnose`、`/api/export`。

### 录制 · 离线回放 · 事件注入（v0.4 阶段 3）

前两项解决了"现在发生了什么"，这三项解决"这条消息当时为什么这样、换成别的输入会怎样"。

| 能力 | 怎么用 | 说明 |
|---|---|---|
| 录制 | 自动 | 桥收到的每条消息/通知/请求都追加到 `qq-inbox.jsonl`（可 JSON 逐行解析、按大小轮转），只写本机、不改任何回复行为 |
| 离线回放 | 控制台「录制 · 回放 · 注入」→ 某行「回放这条」／「回放最近 5 条」 | 在**沙箱目录**里用**真实桥代码**重跑这条消息：dry-run 拦截所有出站、不建任何 QQ 连接、源目录一个字节都不改。结论逐条给出"会回复/静默/出错 + 原因 + 会发送什么" |
| 事件注入 | 控制台填 群号/QQ 号/文本 → 「注入」 | 写一行到 `qq-inject.jsonl`，桥按 `injectIntervalMs`（默认 2s）轮询后**走真实管线**处理；`injectDryRun`（默认开）下所有出站调用被拦截并计数，注入内容永远不会真的发到 QQ |

回放的保真度来自**运行时快照里的线上决策配置**（白名单、安静时段、各功能开关等 28 项，见 `qq-runtime.json` 的 `replay`）：否则插件默认值里"白名单为空 = 拒绝一切"会让回放全部判成静默。回放里**不含真实模型输出**——模型那一轮用一条带 `[回放]` 前缀的模拟回复代替，用来验证链路与分支，不验证措辞。

排障要点：

- 注入通道未开启时会**直接报错并说明开关名**（`injectEnabled`），不会静默丢进队列；
- 注入触发的 **agent 回合是异步的**：dry-run 窗口只在同步阶段开着，所以模型真正的回复会在事件流里被单独拦下（`注入回合的模型回复已被拦截（dry-run，未发送）：<原文>`）——注入既能走真实管线，又不会漏发一条；真人消息不受影响（收到真实消息立即解除该标记）；
- 回放的帧在事件流里标为 `replay: 离线回放（沙箱 + dry-run，不碰 QQ）`，注入的帧标为 `inject: 来自注入器`，两者不会互相误判；
- 桥启动时若队列里已有历史行，会跳过它们并在事件流里记一条"本次启动跳过 N 行（只处理启动后新增的行）"，避免重启后重放旧注入；
- 注入的帧不会被二次录制（否则回放/注入会互相激发）；
- 回放沙箱默认保留最近 5 次，更旧的**移入回收站**（`qq-replay/_trash/<日期>/`），不做物理删除。

相关配置：`recordInbound`（默认开）、`inboxFile`、`inboxRedact`、`injectEnabled`（默认关）、`injectFile`、`injectDryRun`（默认开）、`injectIntervalMs`。
调试接口：`/api/inbox`、`/api/replay`、`/api/inject`、`/api/queue/clear`。

### 硬约束验收台（v0.4 阶段 4）

上面两条解决了"现在发生了什么"和"当时为什么这样"。验收台解决第三个问题：**设计理念有没有真的落地**。

`GET /api/acceptance` 把 6 条硬约束逐条用**机器上现有的产物**算成 `✅ 达标 / ⚠️ 有提示 / ❌ 不达标 / ❔ 证据不足`，并给出证据与下一步：

| 约束 | 判定用的证据 |
|---|---|
| ① 无静默分支 | 最近 500 条事件里所有 `ok:false`（被拒/失败）事件是否都带非空 reason；缺的会点名 stage |
| ② 可关联（traceId） | 消息级事件的 traceId 覆盖率、有多少条消息真正走完 `inbound→reply` |
| ③ 可回放 | 录制条数 + 最近一次回放的统计与**安全保证**（dry-run 开、QQ 连接 0、cwd 已沙箱化）；dry-run 被关掉直接判不达标 |
| ④ 可体检 | 体检通过数/失败数/blocker 数与结论，失败项点名 |
| ⑤ 可导出 | 诊断包会收集的产物有几类在位（或最近一次导出的体积与文件名） |
| ⑥ 可注入 | 通道开关、dry-run 开关（关掉→不达标，因为会真发 QQ）、已消费行数、以及**拦下过几次异步 agent 回合的回复** |

每一项都能点「去看 →」跳到对应卡片（事件流/决策链/回放结果/体检/日志/注入）；结论为 `all-green / partial / unknown / broken` 四种。
纯函数实现（`control/lib/acceptance.mjs`），所以每条分支都有断言覆盖；面板每 30 秒自动刷新，回放结束后立刻重算。

## 独立控制台（control/，v0.4.0 本地预发布）

插件自带一个**独立的本地运维端**，不依赖 DSH 桌面端：宿主挂掉时它照常可用，端口与进程一目了然。

```sh
# 启动（默认 http://127.0.0.1:8799，启动后打印带 token 的地址）
npm run control            # 或 node control/bin/qq-control.mjs --open
# 也可以双击 control/启动控制台.bat
```

| 能力 | 说明 |
|---|---|
| 端口总览 | 控制台 8799 / 宿主 3080 / OneBot 6700 / NapCat 6099 / GPT-SoVITS 9880 的监听状态、占用 PID 与进程名；6700 的连接数即"机器人在线" |
| 启停 | 启动/停止/重启宿主（自动带 `--no-open`，日志重定向到 `qq-host-out.log`/`qq-host-err.log`）、启动/停止 NapCat 与 QQ、启动/停止 GPT-SoVITS、一键全停 |
| 启动预检 | 起宿主前检查 3080/6700，被占则直接报「端口←进程#PID」，而不是静默失败 |
| 释放端口 | 对占用受管端口的进程一键 `taskkill /T /F`（护栏：只允许受管端口占用者与已知机器人进程，绝不误杀无关 PID） |
| 日志 | 宿主 stdout / stderr / 桥调试日志，自动跟随、可切行数 |
| 扫码状态 | 显示 NapCat 二维码图片是否存在、是否新鲜，并一键打开 6099 扫码页 |
| 配置 | `qq-control.json` 是端口与路径的唯一真源（自动探测 node、dsh bin.js、NapCat、TTS 脚本；可在 UI 里改路径）；**6700 被 NapCat 配置写死，勿改** |
| 调试 | 「录制 · 回放 · 注入」：列出 `qq-inbox.jsonl` 里录到的每条消息，可一键离线回放（沙箱 + dry-run）或注入合成事件；注入队列状态（行数 / 本次已消费 / dry-run）直接显示 |
| 验收 | 顶部「硬约束验收台」：6 条硬约束的实时证据（无静默分支 / traceId 贯穿 / 可回放 / 可体检 / 可导出 / 可注入），不达标项直接说明该点哪里；`GET /api/acceptance` |
| 安全 | 只绑 `127.0.0.1`；所有 API 需要 token；带 `Origin` 的跨站请求一律拒绝 |

> 以后若想做真正的托盘/桌面程序，直接包一层 Electron/Tauri 复用同一套 HTTP API 即可，逻辑无需重写。

## 更新日志

最近五个版本（始终滚动展示）：

- **v0.4.0** — 「一切皆可调试」+ 独立控制台（`control/`）：traceId 全链路结构化事件（每个静默分支都有 reason）、SSE 实时事件流与决策链、一键体检、诊断包导出、运行快照与生效配置；**录制 / 离线回放 / 事件注入**（`qq-inbox.jsonl` 录制每条入站事件 → 沙箱内用真实桥代码 dry-run 重跑并给出"会回复/静默 + 原因"→ 控制台注入合成事件走真实管线，异步 agent 回合的回复也会被拦下，全链路不碰 QQ）；**硬约束验收台**（6 条约束逐条给实时证据与"该点哪里"）；控制台独立进程 8799，端口/进程/日志/扫码总览与启停、启动预检与杀进程护栏、token + Origin 鉴权（**本地预发布，暂未发布**）
- **v0.3.9** — 群洞察与定时播报：发言统计（`/统计` `/周榜`）、`/荣誉` `/公告` `/群精华` 只读查询、每日群日报（默认关闭）、重复提醒（每天/每周/工作日）、`/mc` 查 MC 服务器状态
- **v0.3.8** — 防撤回、敏感词/刷屏防护、入群与加好友验证（管理员 `/同意 <序号>` 审批），群管 API 补齐（`/公告` `/精华` `/名片` `/头衔` `/全员禁言`），既有群管命令纳入写操作闸门
- **v0.3.7** — 零成本互动包：关键词问答库（默认关闭）、今日人品/运势/抽签/塔罗、骰子与随机抽人、积分经济（默认关闭）、成语接龙（373 词库）与猜数字（默认关闭）；修复 `stop()` disposer 与接龙判定规则
- **v0.3.6** — agent 主动能力与会话续接：`qq_send_image/qq_send_file/qq_send_voice/qq_recall` 工具、宿主重启后 `resume` 完整会话、合并转发长回复、统一写操作闸门（限频+审计）、`/撤回`

完整历史见 [CHANGELOG.md](CHANGELOG.md)。
