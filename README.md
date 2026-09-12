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
                  │ 反向 WebSocket（OneBot 连我们）
                  ▼
        dsh-qq-onebot-bridge（本插件）
                  │ ctx.agents.create / followup
                  ▼
        DSH agent 会话（每群/每私聊用户一个）
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

`test/` 下为 WS 协议模拟脚本（模拟 OneBot 端连入并断言收发）：

- `protocol-smoke.mjs` 协议冒烟；`sim-group.mjs` / `sim-private.mjs` 群聊/私聊；`sim-user.mjs` 每用户会话
- `sim-quote.mjs` 引用解析；`sim-face.mjs` / `sim-sticker*.mjs` 表情链路；`live-status.mjs` 在线状态

运行（宿主运行时）：`node test/sim-group.mjs`。语音转文字链路建议直接用 QQ 实测（模拟脚本需真实 STT 调用）。

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
| 单条消息的完整决策链 | 控制台「实时事件流」点任意一行 → 「决策链」显示时间轴、停在哪一步、为什么 |
| 为什么机器人不回复 | 「实时事件流」筛"仅被拒/失败"，最常见原因直接列出（如 `mention: 群聊未 @ 机器人`） |
| 每个端口的占用与在线 | 控制台「端口 / 进程」（6700 的连接数即机器人在线） |
| 一键排查 | 控制台「一键体检」：15-19 项 pass/fail + 修复建议（依赖路径、端口、链路、快照、错误、闸门拒绝…） |
| 生效配置（为什么功能没生效） | 控制台「运行快照」里的"关闭中的开关"；完整字段在 `qq-runtime.json` 的 `features`（不含任何密钥） |
| 打包给别人看 | 「导出诊断包」→ 一个 zip（事件流/审计/桥日志/宿主日志/运行快照/体检报告/环境信息） |
| 文件级排查 | `qq-trace.jsonl`（结构化事件，可 `jq`/grep）、`qq-bridge-debug.log`、`qq-actions.log`（写操作审计）、`qq-host-out.log`/`err.log` |

相关配置：`traceEnabled`（默认开）、`traceLevel`（`debug` 全量 / `warn` 只留问题）、`traceMemorySize`、`traceFile`。
调试接口（控制台，token + Origin 双重校验）：`/api/trace`、`/api/stream`（SSE）、`/api/runtime`、`/api/diagnose`、`/api/export`。

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
| 安全 | 只绑 `127.0.0.1`；所有 API 需要 token；带 `Origin` 的跨站请求一律拒绝 |

> 以后若想做真正的托盘/桌面程序，直接包一层 Electron/Tauri 复用同一套 HTTP API 即可，逻辑无需重写。

## 更新日志

最近五个版本（始终滚动展示）：

- **v0.4.0** — 「一切皆可调试」+ 独立控制台（`control/`）：traceId 全链路结构化事件（每个静默分支都有 reason）、SSE 实时事件流与决策链、一键体检、诊断包导出、运行快照与生效配置；控制台独立进程 8799，端口/进程/日志/扫码总览与启停、启动预检与杀进程护栏、token + Origin 鉴权（**本地预发布，暂未发布**）
- **v0.3.9** — 群洞察与定时播报：发言统计（`/统计` `/周榜`）、`/荣誉` `/公告` `/群精华` 只读查询、每日群日报（默认关闭）、重复提醒（每天/每周/工作日）、`/mc` 查 MC 服务器状态
- **v0.3.8** — 防撤回、敏感词/刷屏防护、入群与加好友验证（管理员 `/同意 <序号>` 审批），群管 API 补齐（`/公告` `/精华` `/名片` `/头衔` `/全员禁言`），既有群管命令纳入写操作闸门
- **v0.3.7** — 零成本互动包：关键词问答库（默认关闭）、今日人品/运势/抽签/塔罗、骰子与随机抽人、积分经济（默认关闭）、成语接龙（373 词库）与猜数字（默认关闭）；修复 `stop()` disposer 与接龙判定规则
- **v0.3.6** — agent 主动能力与会话续接：`qq_send_image/qq_send_file/qq_send_voice/qq_recall` 工具、宿主重启后 `resume` 完整会话、合并转发长回复、统一写操作闸门（限频+审计）、`/撤回`

完整历史见 [CHANGELOG.md](CHANGELOG.md)。
