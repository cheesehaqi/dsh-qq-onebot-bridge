# 更新日志 / Changelog

## v0.3.6（2026-09-11）

**agent 主动能力 + 会话续接 + 写操作闸门**

- **会话续接（`sessionResumeEnabled` 默认开）**：`routeKey → sessionId` 落盘 `cwd/qq-sessions.json`，宿主重启后第一条消息用 `ctx.agents.resume()` 接回上一次的**完整会话记录**（不再只靠 `qq-memory/` 的 30 行窗口续命）；续接失败自动回退新建会话，`/new` 会同时清掉映射真正重开
- **agent 主动发送工具**（`agentMediaToolsEnabled` 默认开，新模块 `lib/send.js` 做校验）：
  - `qq_send_image`：把本地图片发进当前会话（超过 `imageSendMaxBytes` 自动用 ffmpeg 压缩到 1920px JPEG 再发）
  - `qq_send_file`：把本地文件发进当前会话（群=群文件 `upload_group_file`，私聊=`upload_private_file`）
  - `qq_send_voice`：按需合成一条语音（复用 `ttsProvider`，含本地 GPT-SoVITS）
  - `qq_recall`：撤回机器人自己最近发出的消息（默认 1 条，最多 5 条）
  - **安全边界**：只允许发送 cwd（+ `fileSendDirs`）内的文件，`.ssh/.dsh/.env/credentials/*.pem/*.key` 等凭据类路径一律拒绝，超出 `fileSendMaxBytes` 拒绝
- **写操作闸门（`lib/actions.js`）**：所有危险 OneBot 写操作（禁言/踢人/公告/精华/名片/上传/撤回/合并转发/好友与入群审批）统一走令牌桶 + 每日上限 `actionRatePerMinute`/`actionRatePerDay` + 审计日志 `cwd/qq-actions.log`（含被拒记录）——新增功能不会悄悄放大账号风控面
- **合并转发卡片（`forwardLongReplies` 默认关）**：群聊里超长回复（默认 ≥ `forwardThresholdChars` 600 字）改发合并转发"聊天记录"卡片，失败自动回退普通文本
- **`/撤回` 命令**：免模型撤回机器人上一条消息（默认 110 秒内可撤，`recallWindowSeconds`）
- **统一存储层（`lib/store.js`）**：原子写（临时文件+rename）、mtime+size 缓存、损坏 JSON 容错，供会话映射等新状态使用
- **onebot.js 传输层大扩充**：新增 request 帧解析（入群/加好友请求事件）、`delete_msg`/`set_group_card`/`set_group_special_title`/`set_group_whole_ban`/`set_group_leave`/`set_essence_msg`/`_send_group_notice`/`set_msg_emoji_like`/`set_group_add_request`/`set_friend_add_request`/`upload_group_file`/`upload_private_file`/`send_group_forward_msg`/`send_private_forward_msg`/`get_group_member_list`/`get_group_member_info`/`get_group_info`/`get_friend_list`/`get_group_honor_info`/`_get_group_notice`/`get_essence_msg_list`/`get_group_msg_history`/`get_version_info`/`get_status`；`parseNotice` 补 `messageId`/`duration`
- **`/health` 扩展**：会话续接状态、写操作闸门拒绝次数与审计开关
- 新增测试：`test/actions-unit.mjs`（28）、`test/send-unit.mjs`（35）、`test/onebot-api-unit.mjs`（32，起真实反向 WS 服务器+客户端验证全部写操作负载与 request/notice 事件）

## v0.3.5（2026-09-04）

**生图功能（高拓展 provider 抽象）**
- **`/画 <描述词>` 生图**（`imageGenEnabled` 默认关闭）：群聊需 @机器人（防白嫖），私聊直接可用；生成后自动落盘 `cwd/qq-images/` 并发回图片段
- **双后端，与 TTS 同款拓展架构**（新模块 `lib/imagegen.js`，新增后端=加一个分支）：
  - `imageGenProvider: openai`——任意 OpenAI 兼容 `/images/generations`（DALL·E / 智谱 CogView / SiliconFlow…），`imageGenBaseUrl`/`imageGenApiKey`/`imageGenModel`/`imageGenSize` 可配，自动处理 `b64_json` 与 `url` 两种响应
  - `imageGenProvider: local`——本地 Stable Diffusion WebUI（AUTOMATIC1111 `/sdapi/v1/txt2img`），`imageGenSteps`/`imageGenCfgScale`/`imageGenSampler` 可配
- 成本/刷屏防护：`imageGenCooldownSeconds`（每会话冷却，默认 60s）+ `imageGenDailyLimit`（每日限额，默认 20）+ `imageGenMaxPromptChars`（描述词长度上限）
- `/help` 菜单在开启时显示生图用法；新增 `test/imagegen-unit.mjs`（15 项），全套 113 项

## v0.3.4（2026-09-01）

**第一梯队互动功能**
- **`/help` 命令帮助**：`/help` / `帮助` / `菜单` 动态列出可用命令（按功能开关与管理员身份展示）
- **戳一戳回复**（`pokeEnabled` 默认开启）：OneBot notice poke 事件，白名单会话内被戳时随机卖萌回复（`pokeReplies` 可配，`pokeCooldownSeconds` 限频）
- **语音朗读**（`voiceReadingEnabled` 默认开启）：@机器人引用文字说「读一下/念出来」，或 `/读 <文字>`——用 TTS 把文字念成语音发回（复用 ttsProvider，wav 自动转 mp3）
- **每日签到**（`checkinEnabled` **默认关闭**）：说「签到」打卡，连续/累计天数按会话持久化到 `cwd/qq-checkin/`；「签到榜」查看排行（新模块 `lib/checkin.js`）
- **入群欢迎语**（`welcomeEnabled` **默认关闭**）：notice group_increase 事件，@新人 + 欢迎文案（`welcomeText` 可配；机器人自己入群不触发）
- onebot.js 新增 `parseNotice` 与 notice 事件、消息透传 `senderName`
- 新增测试 `test/checkin-unit.mjs`（19 项）+ `test/notice-unit.mjs`（9 项），全套 98 项

## v0.3.3（2026-08-29）

**本地 TTS：GPT-SoVITS 零成本语音克隆**
- `ttsProvider` 新增 `local`：接入本地 GPT-SoVITS api_v2 服务（默认 `http://127.0.0.1:9880`），零 API 成本、零云端依赖，3-10 秒参考音频即克隆音色（`ttsLocalRefAudio` + `ttsLocalPromptText`）
- 本地合成输出 wav 自动用 ffmpeg 转 mp3 后发送（`ttsLocalConvertToMp3` 可关，兼容 QQ/NapCat record 段）
- 云端方案（azure/openai）保持不变；`ttsEnabled` 依旧默认关闭
- 新增 `buildLocalTtsRequest`（test/tts-unit.mjs 增至 12 项）
- 附 `TTS控制.bat` 一键启停本地服务（单实例守护，监听 127.0.0.1:9880）

## v0.3.2（2026-08-28）

**避开高峰期静默**
- 避开高峰期（`quietHoursEnabled` **默认关闭**）：开启后在工作日的静默时段内，机器人不回复任何入站消息（不处理、不消耗模型调用，调试日志记录跳过原因）
- 默认时段（`quietHours`）：`9:00-12:00` 与 `14:00-18:00`（本地时间 `H:MM-H:MM`，可自行修改；全角冒号自动归一化，支持跨午夜如 `22:00-2:00`）
- 周末豁免（`quietWeekendExempt` 默认开启）：周六/周日不受静默时段限制
- 已排定的定时提醒与投票开奖不受影响，仍会照常触发
- `/health` 新增避开高峰期状态行（开关/时段/周末豁免一目了然）
- 新增 `test/quiet-unit.mjs`（时段解析 + 工作日/周末/边界判定，24 项）

## v0.3.1（2026-08-28）

**状态通知 + GIF 抽帧**
- 状态变更通知（`notifyEnabled` 默认关闭）：宿主直连推送服务（PushPlus 或任意 JSON webhook，`notifyPushUrl`/`notifyToken`），机器人上线/掉线/桥就绪时推送——掉线通知不经 QQ，机器人都断了也能送达；`notifyCooldownSeconds` 防抖（默认 300s）
- GIF 动画表情抽帧（`gifFrameExtract` 默认开启）：识图前用 ffmpeg 把 gif 第一帧抽成 png（`ffmpegPath` 可配），动画表情对识图工具/模型的兼容性显著提升

## v0.3.0（2026-08-26）

**语音回复（TTS）与实用小工具**
- **语音回复 TTS**（`ttsEnabled` 默认关闭，需 key 与显式开启）：文字回复后自动跟一条语音（record 段）；默认配置 **Azure Speech**（晓晓 + `chat` 风格，`ttsAzureRegion`/`ttsVoice`/`ttsStyle`/`ttsMaxChars` 可调），也可一键切换 `ttsProvider: openai` 接任意 OpenAI 兼容 `/audio/speech`（OpenAI/Minimax/豆包…，`ttsBaseUrl`/`ttsModel`/`ttsVoice`）
- **`/health` 诊断**：插件版本、宿主运行时长、会话/提醒/投票/记忆数、识图与语音开关状态
- **私聊文件转存**：用户发来的文件自动下载到 `cwd/qq-files/` 并回复保存路径（`fileTransferEnabled`、`fileTransferMaxBytes` 默认 50MB）
- **`/export` 聊天导出**：把本会话持久化记录导出为 markdown 文件（`cwd/qq-exports/`，`exportEnabled`）
- 新增 `lib/tts.js`（Azure SSML / OpenAI 兼容双实现）+ `test/tts-unit.mjs`（6 项）；onebot.js 支持 file 段解析

## v0.2.9（2026-08-26）

**群管理套件**
- `/summary`：基于持久化记忆让 agent 总结本会话最近聊天（谁说了什么、有没有@我）
- 群投票：「投票：问题？A 选项 B 选项」→ 群友回复字母投票，到时自动公布（`/vote` 查进度、`/vote-end` 提前结束、`voteDurationSeconds` 可配时长）
- 共享待办：「/todo add xxx」「记一下：xxx」添加；`/todo` 查看、`/todo done N` 完成、`/todo clear` 清除已完成（每会话持久化到 `cwd/qq-todos/`）
- 管理员命令（`adminUsers` 白名单，生产已配本人）：
  - `/mute <QQ号或@某人> [分钟]`、`/unmute <QQ号或@某人>`（set_group_ban）
  - `/kick <QQ号或@某人>` → **需 60 秒内回复「确认踢」二次确认**才执行，回复「取消」放弃
  - `/clear` 清空当前会话与持久化记忆
- OneBotServer 新增 `setGroupBan`/`setGroupKick` 动作与 `ats` 透传
- 新增 `test/grouptools-unit.mjs`（投票解析 + 待办持久化，10 项）

## v0.2.8（2026-08-26）

**风控与稳定**
- 回复限流（`rateLimitEnabled`，**默认关闭**）：开启后每会话在 `rateLimitWindowSeconds`（默认 60s）内最多回复 `rateLimitMaxReplies`（默认 10）条，超出静默丢弃并记日志
- 消息去重（`dedupEnabled`，默认开启）：同一 message_id 在 `dedupWindowSeconds`（默认 300s）内重复投递（NapCat 重连重发）会被忽略，避免机器人重复回复
- 生产配置里已附两组的注释示例，按需开启

## v0.2.7（2026-08-26）

**维护性优化**
- 调试日志自动轮转：`qq-bridge-debug.log` 超过 2 MiB 时仅保留末尾 128 KiB，不再无限增长
- 图片保留期清理：宿主启动时自动删除 `qq-images/`、`qq-replies/` 中超过 `imageRetentionDays`（默认 14 天）的下载图片
- 新增 `test/reminder-unit.mjs`：提醒时间解析的 13 项纯单元测试（相对/绝对时间、关键词策略、内容提取）

## v0.2.6（2026-08-26）

**可配置识图方式**
- 新增 `visionMode: tool | native` 配置：`tool`（默认）= 图片存盘后由 agent 用 `visionToolName` 工具查看（稳定路线）；`native` = 图片作为**原生多模态附件**注入消息（DSH 0.1.1+ 附件机制，模型直接看图；文本模型自动降级为占位说明）
- 新增 `visionToolName`（默认 `describe_image`），可自由指定识图工具
- 私聊识图与 @引用图片两种场景都支持两种模式
- 生产默认保持 `tool` 模式；想体验原生多模态把 `visionMode` 改成 `native` 即可（当前原生多模态尚不稳定，自行取舍）

## v0.2.5（2026-08-26）

**定时提醒**
- 新增定时提醒：`30分钟后提醒我喝水`、`明天9点提醒我开会`、`后天 20:30 提醒我生日`
- 触发规则：群聊需 @机器人（@ 时可省略"提醒"字样，如「明天9点开会」）；私聊需带提醒关键词（提醒/记得/喊我/叫我/别忘了）
- 到点自动向原会话发送 `⏰ 提醒：<内容>`；提醒**跨宿主重启保留**（`cwd/qq-reminders.json`）
- 新增 `/reminders` 命令查看当前会话待执行提醒
- 新增配置：`reminderEnabled`（默认 `true`）、`reminderMaxPerChat`（默认 `10`）
- 支持相对时间（N秒/分钟/小时/天后）与绝对时间（今天/明天/后天 HH:mm、N点半/N点M分）
- `OneBotServer` 新增 `currentSocket()`：提醒发送自动使用最新连接（NapCat 重连后不失效）

## v0.2.4（2026-08-24）

**每会话持久化记忆**
- 每个群/私聊的最近对话自动落盘到 `cwd/qq-memory/`（每会话一个 JSON，滚动窗口）
- 宿主重启后自动把历史对话注入新会话系统提示——机器人不再失忆
- `/new` 会同时清除该会话的持久化记忆
- 新增配置：`memoryEnabled`（默认 `true`）、`memoryMaxEntries`（默认 `30`）

## v0.2.3（2026-08-23）

**安全默认值（响应上架评审）**
- 白名单语义改为「空 = 拒绝」：`allowUsers` 为空拒绝所有私聊，`allowGroups` 为空拒绝所有群消息
- 部署者必须显式填入自己的 QQ 号与群号后才能使用
- 配置描述、README（中英）、示例配置同步更新

## v0.2.2（2026-08-21）

**私聊识图**
- 私聊中用户发送的图片/动画表情（image/mface 段）自动下载到 `cwd/qq-images/` 并注入会话，agent 用 `describe_image` 查看后回应
- 下载按 Content-Type 推断扩展名（GIF 动画表情不再误存为 .png）
- 新增配置：`privateImageView`（默认 `true`）

## v0.2.1（2026-08-20）

**稳定性修复**
- 修复未处理的 Promise rejection（新增 `#safeReply` + 消息处理整体 try/catch）
- 修复 @+引用无内容时向 agent 发送空消息的问题
- 修复非语音引用误用"引用了一条语音"指令
- WS 连接 id 加计数器防碰撞
- 依赖 junction 全部指向共享树（修复 `web\node_modules\ws` 被清理导致的启动崩溃）

## v0.2.0（2026-08-20）

**插件化整合**
- 全部 QQ AI 功能整合为独立插件：双向消息桥、每群/每私聊会话分组、语音转文字、引用解析、表情系统、白名单、`/new` `/status`
- 语音转文字最终触发策略：群聊 @机器人并引用语音 → 转写回复；私聊语音直接转写（智谱 GLM-ASR-2512，可换任意 OpenAI 兼容端点）
- 私聊开启（`acceptPrivate: true`），agent 注入 chatScope 会话归属
- 完整 README（中英）、LICENSE、示例配置、风险与合规说明、测试脚本

## v0.1.1（2026-08-16）

**首个可用版本**
- OneBot v11 反向 WebSocket 双向桥
- 每群/每私聊用户独立会话（sessionMode）
- 黄脸表情表、`[face:名字]` 标记、图片表情收藏、`qq_face_list`/`qq_face_send` 工具
- `allowUsers`/`allowGroups` 白名单、`accessToken`、仅@回复
