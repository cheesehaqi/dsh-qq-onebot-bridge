# dsh-qq-onebot-bridge

QQ ↔ DeepSeek Harness 双向桥插件（独立 bundle）。QQ 消息直接驱动 DSH agent 会话，agent 回复自动发回 QQ。

> **v0.4.0 主题：一切皆可调试**。每条消息一个 traceId、每个"没回复"都有中文原因、任意历史消息都能离线重跑、假事件能喂进真实管线——而且这 6 条硬约束在自带控制台里随时可验收（见「[调试](#调试v04一切皆可调试)」与「[硬约束验收台](#硬约束验收台v04-阶段-4)」）。

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
- **看得见（v0.5）**：别人**合并转发**的聊天记录不再被静默丢弃——`get_forward_msg` 展开成正文交给模型；同时接通了早已封装却没人调用的能力：`/成员`（名单/详情）、`/群信息`、`/好友`（默认关）、agent 工具 `qq_recent_history` / `qq_member_info` / `qq_react`（表情回应）、`/退群`（默认关）
- **找得回（v0.5）**：`/文件`、`/文件 文件夹名`、`/取 文件名`（下载后只发私聊）、`/相册`、`/ocr`（图片转文字）；消息按天归档到 `cwd/qq-history/`，`/找 关键词` 与 agent 工具 `qq_search_history` 在最近 N 天里检索（控制台也有「群资产 · 历史检索」卡片）
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
# 安装（本地目录）：先在被安装的目录里装运行时依赖，再注册插件
# 本地目录走 pnpm 的 link:，不会自动安装被链接包自己的依赖（ws）
cd <本目录> && npm install --omit=dev
dsh plugin --profile web add <本目录>

# 卸载（随时可移除，独立 bundle 不影响其它插件）
dsh plugin --profile web remove dsh-qq-onebot-bridge
```

装/卸后重启 `dsh web` 生效。

> 官方依赖（`@deepseek-ai/dsh-*`、`@deepseek-ai/schemastery`）声明为 `peerDependencies`，由 DSH 随 profile 一起装好，插件目录里不需要重复安装。

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

53 个单测脚本，共 3252 项断言（`test/*-unit.mjs`）+ 3 个真机脚本：

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

## 看得见 · 找得回（v0.5）

v0.5 做两件事：把**已经封装好、却从没接上线**的能力接通，再补上"群里的东西能找回来"。

### 合并转发展开（先修一个违反硬约束的洞）

以前别人把「聊天记录」合并转发给机器人时，`parseMessage` 里根本没有 `forward` 分支，这条消息在传输层就被静默丢掉——**连 trace 都没有**，直接违反 v0.4 的第一条硬约束。现在：

- `forwards` 会被识别，经 `get_forward_msg` 展开成 `[转发聊天记录] 昵称: 内容` 交给模型（默认最多 50 条 / 4000 字，只展开一层，不递归）
- 群里仍然要 @ 机器人才处理（空文本不再绕过 @ 门与 `acceptPrivate` 门——这两个门都补上了）
- `forwardExpandEnabled: false` 可关闭；回放/注入模式（dry-run）不访问 QQ，注入时可用 `forwardText` 直接喂一份正文

### 接通的既有能力

| 能力 | 用法 |
|---|---|
| 群成员 | `/成员` 看名单（按身份/等级排序，标注头衔与禁言中）· `/成员 @某人` / `/成员 昵称` / `/成员 QQ号` 看详情（身份/等级/头衔/入群时间/最后发言/禁言状态）；agent 工具 `qq_member_info` |
| 群资料 | `/群信息`（群名/群号/人数与上限/群主/建群时间） |
| 好友列表 | `/好友`（**隐私项，默认关闭** `friendListEnabled`，且仅私聊里的管理员可用） |
| 群历史 | agent 工具 `qq_recent_history`（拉本会话最近 N 条，群聊/私聊都支持） |
| 表情回应 | agent 工具 `qq_react`（给消息贴 👍 之类，而不是发一条消息；写操作，过闸门） |
| 退群 | `/退群 确认`（**默认关闭** `leaveGroupEnabled`，必须显式二次确认，走闸门） |

### 群资产（只读为主）

| 命令 | 说明 |
|---|---|
| `/文件` | 列群文件与文件夹（文件名/大小/上传者/时间） |
| `/文件 <文件夹名>` | 进文件夹列文件 |
| `/取 <文件名>` | 下载群文件到 `cwd/qq-files/` 并**只发到发起人私聊**（不往群里丢文件）；精确/前缀/模糊匹配，文件名消毒（去路径、去 Windows 非法字符、保留名加前缀） |
| `/相册` | 列群相册（NapCat `get_qun_album_list`） |
| `/ocr` | 引用一张图片发 `/ocr`，用 NapCat 的 `ocr_image` 读出图里的文字（不消耗模型） |

### 历史检索与归档

- 每条白名单会话的真实消息按天归档到 `cwd/qq-history/YYYY-MM-DD.jsonl`；**注入/回放的假事件不入档**，`/` 开头的命令也不入档（否则每次 `/找 X` 都会命中自己刚敲的查询词）
- `/找 关键词`（空格分隔 = 同时包含，大小写不敏感）检索本会话最近 N 天；agent 工具 `qq_search_history` 同源同口径
- 保留期默认 90 天，过期分片在宿主启动时**移入** `qq-trash/<日期>/` 而不是删除
- 控制台新增「群资产 · 历史检索」卡片：看归档体积与时间范围、直接检索（与群内 `/找` 复用同一套解析）

新增配置（括号内为默认值）：`forwardExpandEnabled`(true) `forwardMaxNodes`(50) `forwardMaxChars`(4000) `memberQueryEnabled`(true) `memberListLimit`(20) `friendListEnabled`(false) `historyQueryEnabled`(true) `historyQueryLimit`(20) `reactToolEnabled`(true) `leaveGroupEnabled`(false) `ocrEnabled`(true) `ocrMaxImages`(3) `groupFileEnabled`(true) `groupFileDownloadEnabled`(true) `groupFileListLimit`(20) `groupFileMaxBytes`(50 MiB) `albumEnabled`(true) `historyArchiveEnabled`(true) `historyArchiveDir`("") `historyArchiveKeepDays`(90) `historySearchEnabled`(true) `historySearchDays`(7) `historySearchLimit`(20)。

## 无人值守（v0.5.2）

三件事：外部事件能主动进群、定时内容自己发、掉线了自己爬起来。**全部默认关闭**。

### 入站 webhook（`webhookEnabled`）

本机 HTTP 端点（默认 `127.0.0.1:8798`），外部系统 POST 到 `/hook/<来源名>`，桥把它渲染成一条群消息：

| `format` | 适配的事件 |
|---|---|
| `github` | push / pull_request / issues / issue_comment / workflow_run（CI 成功失败）/ release |
| `uptime-kuma` | 心跳：宕机 / 恢复 / 待定 / 维护 |
| `generic` | 任意 JSON + `{a.b.c}` 占位符模板 |

- **鉴权必须二选一**：`token`（`X-Webhook-Token` 头或 `?token=`）或 `secret`（GitHub 风格 `X-Hub-Signature-256`，对原始请求体做 HMAC-SHA256）；**两者都没配的来源会被直接拒绝**——不存在"未鉴权的开放端点"
- 体积上限 `webhookMaxBodyBytes`（默认 64 KiB，超限 413）、每来源限频 `webhookRatePerMinute`（默认 30/分，超限 429）
- 每次都落 trace：收到、渲染失败、发送被拦（限流或注入回合）都有中文 reason；`/播报` 可看每个来源的收/丢计数

### 定时播报（`broadcastEnabled` + `broadcastJobs`）

配置驱动的任务表，三种 `kind`：

| `kind` | 内容 |
|---|---|
| `rss` | 抓 RSS 2.0 / Atom / RDF（自带解析器，**零第三方依赖**）；只播**新条目**（按 guid/link 去重，跨宿主重启不重复），支持 `keyword` 过滤与 `maxItems` |
| `weather` | Open-Meteo（免费、无需 key）：当前温度与天气、当日最高/最低、降水概率；WMO 天气码翻成中文 + emoji |
| `mc` | 复用既有 Server List Ping 查 MC 服务器状态 |

排期两种写法：`at: "HH:MM"`（可配 `weekdays`，0=周日），或 `everyMinutes`（最小 5 分钟，优先于 `at`）。去重与统计落盘 `qq-broadcast.json`，重启不丢。

管理命令（管理员）：`/播报` 列出任务与下次触发时间、webhook 状态与收/丢计数；`/播报 测试 <任务 id>` 立即发一次。

### 掉线自愈（`autoHealEnabled` + `autoHealCommand`）

QQ 客户端断开时，按配置的启动命令把它拉起来：

- **只启动、绝不杀进程**（杀进程仍归控制台，那边有专门护栏）
- 冷却 `autoHealCooldownSeconds`（默认 300s）+ 每小时上限 `autoHealMaxPerHour`（默认 3 次）；命中冷却是**写 trace 说明原因**，不静默
- 与既有 `notifyEnabled` 出站告警互补：告警负责告诉你"掉了"，自愈负责"拉回来"

新增配置键（括号内为默认值）：`webhookEnabled`(false) `webhookPort`(8798) `webhookSources`([]) `webhookRatePerMinute`(30) `webhookMaxBodyBytes`(65536) `broadcastEnabled`(false) `broadcastJobs`([]) `broadcastStateFile`("") `autoHealEnabled`(false) `autoHealCommand`("") `autoHealCooldownSeconds`(300) `autoHealMaxPerHour`(3)。

## 互动：点一下就完事（v0.5.3）

总开关 `engageEnabled`（默认 false），下面每个能力还有自己的子开关，全部默认关。所有写操作都过 ActionGate + 出站配额，且**注入/回放回合一律不写 QQ**（`injectDryRun: false` 的"真发模式"除外）。

### 先做了真机探针，再写代码

按钮这类能力**没有猜**：直接读本机装的那份 NapCat（`bootmain/napcat.mjs`，QQ 9.9.32-50969），逐个确认 action 名、参数形状与入站事件。结论写进了 `lib/engage.js` 的文件头，也被 `test/engage-bridge-unit.mjs` 逐条钉住。

探针结论里最重要的一条是**否定**：这个构建**发不了内联按钮**——`"keyboard"` / `"button"` 段名在整个 bundle 里出现 **0 次**，OB11 段枚举只有 text/image/music/video/record/file/at/reply/json/face/mface/markdown/node/forward/xml/poke/dice/rps/miniapp/contact/location/onlinefile/flashtransfer；只有 `click_inline_keyboard_button`（点**别人**发的按钮）。所以「点一下就完事」用的是真实可用的轻互动，而不是做一个注定发不出去的按钮面板。

| 能力 | 开关 | action（已探针确认） | 说明 |
|---|---|---|---|
| 主动戳一戳 | `pokeCommandEnabled` | `group_poke` / `friend_poke` | `/戳 @某人` 或 `/戳 <QQ号>`（管理员）。白名单 + ActionGate + 每小时配额三层 |
| 被戳回戳 | `pokeBackEnabled` | 同上 | 被戳时**真的戳回去**，可配 `pokeBackText` 同时回一句话；仍受既有 `pokeEnabled` 总开关与冷却约束 |
| 正在输入 | `typingEnabled` | `set_input_status` | 私聊里模型动脑前发「正在输入」、回复落地即撤销。真机探针：该 action **只支持 C2C 私聊**，群聊会如实记 reason 而不是白发一次注定失败的调用 |
| 自动贴表情 | `emojiLikeEnabled` + `emojiLikeId` | `set_msg_emoji_like` | 收到消息贴一个表情（默认 👍＝码点 128077）。`emojiLikeMentionOnly` 默认只对"叫我/引用我"的消息生效，避免刷屏 |
| 表情回应统计 | `reactionStatsEnabled` | 入站 `notice.group_msg_emoji_like` | `/赞榜` 看本会话被回应最多的消息；`/谁赞了 <消息ID>`（或引用一条消息）看**谁**点的 |
| 点赞 | `sendLikeEnabled` | `send_like` | `/点赞 [@某人]`，一次 `sendLikeTimes`(10，QQ 上限) 个，每天每目标 `sendLikePerDay` 次 |
| 标记已读 | `markReadEnabled` | `mark_group_msg_as_read` / `mark_private_msg_as_read` | 收到消息顺手把会话标已读，不再堆红点 |

几个刻意的设计点：

- **`/谁赞了` 有两份数据**：本地统计（永远可用，标注"来源：本地统计"）与真机 `get_emoji_likes`（群里可用，标注"来源：get_emoji_likes 实时"）。注入回合不调 QQ，用本地那份并说明原因。
- **`/赞榜` 是纯本地读**：不做任何 QQ 调用，所以注入/回放回合里它照常回答，trace 里写明"只读本地 JSON，不访问 QQ"。
- **表情 ID 直接显示成真表情**：`emoji_id` 是十进制码点，`128077 → 👍`，无需查表。
- **配额拒绝也带真实信息**：`戳一戳 已达每小时上限（5/5 次）`，不是一句"操作失败"。

新增配置键（括号内为默认值）：`engageEnabled`(false) `pokeBackEnabled`(false) `pokeBackText`("") `pokeCommandEnabled`(false) `pokePerHour`(5) `typingEnabled`(false) `emojiLikeEnabled`(false) `emojiLikeId`("128077") `emojiLikeMentionOnly`(true) `emojiLikePerHour`(20) `reactionStatsEnabled`(false) `reactionStatsFile`("") `sendLikeEnabled`(false) `sendLikeTimes`(10) `sendLikePerDay`(3) `markReadEnabled`(false) `markReadPerMinute`(10)。互动状态（表情统计 + 三个配额）落在 `qq-engage.json`，跨重启不丢。

## 群运营工具箱（v0.5.4）

总开关 `groupOpsEnabled`（默认 false）。**下面每个子开关都在总开关之下**：总开关关着时，任何群运营命令都只回一句中文说明，绝不静默什么都不做。

### 同样先做真机探针（这次纠正了三个会做错的地方）

读本机 NapCat 实现包（`bootmain/napcat.mjs`，QQ 9.9.32-50969）逐条核对，结论写在 `lib/ops.js` 头部、由 `test/ops-unit.mjs` 钉住：

- **批量踢有原生 action**：`set_group_kick_members` 的 `user_id` 是**数组**，一次请求多人——不必循环 `set_group_kick`
- **群待办是三个独立 action**：`set_group_todo` / `complete_group_todo` / `cancel_group_todo`
- **相册上传存在，但叫 `upload_image_to_qun_album`**（不是 `upload_qun_album`）
- **`set_group_member_permissions` 是局部更新**：没传的项保持不变——所以 `/群权限` 只提交你**写出来**的项

| 命令 | 开关 | 真机 action | 说明 |
|---|---|---|---|
| `/群打卡` | `nativeSignEnabled` | `set_group_sign` | QQ 的**原生群签到**；和本地「签到」积分玩法不是一回事（提示语会点明） |
| `/全体余量` | `opsReadEnabled` | `get_group_at_all_remain` | 本群与本人剩余 @全体次数；不可用时说明常见原因 |
| `/禁言名单` | `opsReadEnabled` | `get_group_shut_list` | 昵称 + 剩余时间，并标出已到期人数 |
| `/群详细` | `opsReadEnabled` | `get_group_info_ex` | 扩展群资料（人数上限/创建时间/描述/问题） |
| `/入群通知` | `opsReadEnabled` | `get_group_ignored_notifies` | 被忽略的入群申请与邀请 |
| `/批量踢 @a @b` → `/批量踢 确认` | `opsKickEnabled` | `set_group_kick_members` | 管理员；**两步确认**（60 秒有效）、分批不丢人、名单含自己直接拒绝 |
| `/待办` `/完成待办` `/取消待办` | `opsTodoEnabled` | `set/complete/cancel_group_todo` | 引用一条消息即可 |
| `/移动文件` `/重命名文件` `/删文件` `/新建文件夹` | `opsFileEnabled` | `move/rename/delete_group_file`、`create_group_file_folder` | 管理员，破坏性操作；缺参数时逐项说明缺什么 |
| `/传图 <相册ID或名字>` | `opsAlbumUploadEnabled` | `upload_image_to_qun_album` | 引用一张图片；按名字自动查相册列表换 ID，`/传图 @album_1` 可直接指定 |
| `/群名` `/群备注` | `opsProfileEnabled` | `set_group_name` / `set_group_remark` | 管理员；群名 >30 字、备注 >60 字直接拒绝 |
| `/群权限 相册=关 临时会话=关 新群聊=开` | `opsPolicyEnabled` | `set_group_member_permissions` | 管理员；只提交写出来的项 |
| `/历史可见 开\|关` | `opsPolicyEnabled` | `set_group_new_member_history_visibility` | 管理员 |
| `/周报` | `opsReportEnabled` | 本地统计 | 最近 `opsReportDays`（默认 7）天的消息/入群/退群/踢出/禁言/打卡/待办/文件整理/相册上传，以及最忙的一天 |

两个命令名的坑（都在代码里写了注释）：`/群资料` 已被既有的基础群信息查询占用 → 扩展版叫 `/群详细`；`/成员权限` 会被既有的 `/成员` 命令整条吃掉（那个命令刻意支持 `/成员张三` 这种紧贴写法）→ 改名 `/群权限`。

运营计数落在 `qq-ops.json`（按天分桶、保留 30 天、跨重启累加），`/周报` 是**纯本地读**，注入/回放回合照常回答。

新增配置键（默认值）：`groupOpsEnabled`(false) `nativeSignEnabled`(false) `opsReadEnabled`(true) `opsKickEnabled`(false) `opsKickBatchSize`(20) `opsTodoEnabled`(false) `opsFileEnabled`(false) `opsAlbumUploadEnabled`(false) `opsProfileEnabled`(false) `opsPolicyEnabled`(false) `opsReportEnabled`(false) `opsReportDays`(7) `opsCountersFile`("")。

## 独立控制台（control/，v0.4.0）

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

## 隐私与脱敏

出问题排查往往要把日志发给别人，所以本插件对"数据会去哪"有明确约定：

| 项 | 约定 |
|---|---|
| 诊断包 | 「导出诊断包」默认勾选**脱敏**：QQ 号按位掩码（保留前两位）、消息原文替换为「[已脱敏 N 字]」，包内附 `REDACTED.json` 说明口径；取消勾选才导出明文（会有提醒） |
| 运行产物 | `qq-inbox.jsonl`（消息原文）、`qq-trace.jsonl`（会话键 + 文本片段）、`qq-runtime.json`、`qq-actions.log` 等只写本机工作目录，且**全部被 `.gitignore` 覆盖**（`qq-*/`、`qq-*.json`、`qq-*.jsonl`、`qq-*.log` 通配 + 逐项列出），cwd 恰好在仓库里也不会误提交 |
| 录制脱敏 | `inboxRedact: true` 可在录制阶段就把 QQ 号脱敏 |
| 仓库本身 | 不含任何密钥/口令/真实 QQ 号：密钥只存在于你的 DSH profile 配置（仓库外）；`test/privacy-unit.mjs` 每次跑测试都会重新扫描全部被跟踪文件（真实号从你本机私有配置或 `DSH_QQ_PRIVATE_IDS` 现取，测试文件里不含真实号） |
| 控制台 | 只绑 `127.0.0.1`，所有接口需 token（存在被忽略的 `qq-control.json`），拒绝跨站 Origin |

> 部署事实：本插件是 **DSH bundle**，运行在 DSH profile 内，`@deepseek-ai/dsh-*`、`@deepseek-ai/schemastery` 等官方 peer 依赖随 profile 一起装好。**官方包必须写全作用域名**：不带作用域的 `schemastery` 是另一个包（3.18.0），只有在"别的插件恰好把它 hoist 到共享 node_modules"时才能解析——v0.4.0 之前 `lib/` 正是这么写的，换到干净环境立刻 `ERR_MODULE_NOT_FOUND`（[issue #1](https://github.com/cheesehaqi/dsh-qq-onebot-bridge/issues/1)）；现已统一用作用域名，并由 `test/static-unit.mjs` 静态守住（裸名/未声明的 import 直接测试失败）。`ws` 是普通运行时依赖，本地目录安装要按上面「安装」一节先 `npm install`。把 `lib/` 单独拷出来裸跑仍然跑不起来（设计如此，不是缺依赖）。

## 更新日志

最近五个版本（始终滚动展示）：

- **v0.5.4** — 「群运营工具箱 / Group ops toolbox」：把群运营的日常动作做成一等公民。**老规矩：先真机探针再写代码**——读本机 NapCat 实现包确认能力面，纠正了三个会做错的地方：批量踢有**原生** `set_group_kick_members`（`user_id` 是数组，不用循环）、群待办是**三个** action（set/complete/cancel_group_todo）、相册上传叫 `upload_image_to_qun_album`；另外 `set_group_member_permissions` 是**局部更新**（没传的项保持不变），所以 `/群权限` 只提交写出来的项。新增：`/群打卡`（QQ **原生**群签到，与本地积分「签到」区分）、`/全体余量`、`/禁言名单`、`/群详细`（扩展群资料）、`/入群通知`、`/批量踢`（管理员，两步确认 + 分批不截断）、`/待办` `/完成待办` `/取消待办`、`/移动文件` `/重命名文件` `/删文件` `/新建文件夹`、`/传图`（按名字换相册 ID）、`/群名` `/群备注`、`/群权限`、`/历史可见`、`/周报`（本地统计：消息/入群/退群/踢出/禁言/打卡/待办/文件整理/相册上传 + 最忙的一天）。红线：写操作全过 ActionGate，**每个新 API 都有"注入回合 0 出站"断言**，每个关闭分支点名是哪个开关，`/周报` 纯本地读。新增配置键 13 个（总数 204 → 217）；新增 2 套测试（ops 94 / 桥层 ops-bridge 96），全量 **53 套 / 3252 断言全绿**
- **v0.5.3** — 「点一下就完事 / One tap」：**先做真机探针再写代码**——直接读本机 NapCat 实现包（`bootmain/napcat.mjs`，QQ 9.9.32-50969）确认能力面，其中最重要的是一条**否定结论**：该构建 `"keyboard"`/`"button"` 段名出现 **0 次**，**发不了内联按钮**，所以本版没做按钮面板，而是把轻互动真正落地。新增：**主动戳一戳** `/戳 @某人`（管理员，`group_poke`/`friend_poke`）、**被戳回戳**（真的戳回去，可配文案）、**私聊正在输入**（`set_input_status`，探针确认只支持 C2C，群聊如实记 reason）、**自动贴表情**（`set_msg_emoji_like`，`emojiLikeMentionOnly` 默认只对叫我/引用我生效）、**表情回应统计**（`/赞榜` 本地榜单 + `/谁赞了` 群里走 `get_emoji_likes` 拿实时名单、失败/注入回合回落本地并标注来源）、**点赞** `/点赞 [@某人]`（`send_like`，每天每目标限量）、**标记已读**（`mark_*_msg_as_read`，按会话）。红线：`set_msg_emoji_like` 只带 `message_id`、scoped dry-run 拦不住 → 桥里自己判注入并给真实 reason，**注入回合逐条断言 0 出站**；每个开关的关闭分支与配额拒绝都带真实 reason。**顺手修掉两个 v0.5.2 的静默缺陷**：桥对 `JsonStore` 调了不存在的 `load()/save()`（真实 API 是 `read()/write()`），异常被吞 → **播报去重/统计跨重启丢失且毫无提示**；`#loadEngageState()` 在配额对象构造前调用导致 **restore 打空、配额跨重启失效**。新增配置键 17 个（总数 187 → 204）；新增 2 套测试（engage 109 / 桥层 engage-bridge 90），全量 **51 套 / 3062 断言全绿**
- **v0.5.2** — 「无人值守 / Unattended」：**入站 webhook**（`127.0.0.1:8798`，`POST /hook/<来源>`，github / uptime-kuma / generic 三种适配器；token 或 HMAC-SHA256 二选一鉴权，**两者都缺的来源直接不注册**；64 KiB 上限回 413、每来源限频回 429；密钥绝不进日志与运行快照）；**定时播报**（`rss` 自带 RSS/Atom/RDF 解析器并按 guid 去重、`weather` 走 Open-Meteo 免 key、`mc` 复用既有 ping；`at: HH:MM` + `weekdays` 或 `everyMinutes`，间隔递推不漂移；去重与统计落盘跨重启不重复；`/播报` 与 `/播报 测试 <id>` 管理）；**掉线自愈**（按配置命令拉起 QQ 客户端，**只启动不杀进程**，冷却 300s + 每小时 3 次上限，命中即写 trace 说明原因）。新增配置键 12 个（总数 175 → 187，静态双向校验通过）；新增 4 套测试（feed 144 / webhook 114 / broadcast 189 / 桥层 unattended 107），全量 **49 套 / 2860 断言全绿**
- **v0.5.1** — 审查修复（无新功能）：修掉发布后对抗性审查抓出的 8 个缺陷——`/成员 <昵称>` 对**没设群名片**的成员永远查不到（`card:''` 时未回落到昵称）；转发卡片展开为空（关闭开关/空载荷/调用失败）仍会起一个**内容为空的模型回合**；`/ocr` 的离线闸门放在 `get_msg` 之后、`/好友` 漏判，两者在注入/回放回合仍会真的访问 QQ；`/读图` 被 `/读` 语音朗读整条吃掉（发朗读「图」字的语音 + 消耗 TTS）；归档写入失败完全静默（`/找` 会谎报「没找到」）；控制台「群资产」读的是不存在的 `historyDir`（应为 `historyArchiveDir`），自定义目录时永远显示 0 个文件；`/取` 私聊投递失败会把**本机绝对路径**发进群、`qq-files/` 永不清理、投递注定被限流时仍先下载；trace 补上「另有 N 张转发卡片未展开」。新增 `test/inject-assets-unit.mjs`（28 条，走真实注入通道 + 正对照）与 28 条桥层回归（含**反向验证**：换回修复前的 `lib/bridge.js`，新断言各挂 8 条）
- **v0.5.0** — 「看得见 · 找得回 / See it, find it」：**合并转发不再被静默丢弃**（`parseMessage` 增加 `forwards`、`get_forward_msg` 展开成正文交给模型，空文本路径补上 @ 门与 `acceptPrivate` 门——原先是违反「无静默分支」硬约束的洞）；接通既有能力 `/成员` `/群信息` `/好友`（默认关）`/退群`（默认关）与 agent 工具 `qq_recent_history` / `qq_member_info` / `qq_react`；新增群资产 `/文件` `/取`（下载只发私聊）`/相册` `/ocr`（图片转文字）；消息按天归档 `qq-history/`，`/找` 与 `qq_search_history` 检索最近 N 天（注入/回放与命令不入档，过期分片移入 `qq-trash/<日期>/` 而非删除）；控制台新增「群资产 · 历史检索」卡片；实测抓出并修掉 5 个自引入缺陷（格式化返回值当字符串发、`/找` 无参数无用法、归档把命令自己搜出来、回收目录日期套两层）+ 1 个门控逃逸

完整历史见 [CHANGELOG.md](CHANGELOG.md)。
