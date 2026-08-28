# 更新日志 / Changelog

## v0.3.2（2026-08-28）

**避开高峰期静默**
- 避开高峰期（`quietHoursEnabled` **默认关闭**）：开启后在工作日的静默时段内，机器人不回复任何入站消息（不处理、不消耗模型调用，调试日志记录跳过原因）
- 默认时段（`quietHours`）：`9:00-12:00` 与 `14:00-18:00`（本地时间 `H:MM-H:MM`，可自行修改；全角冒号自动归一化，支持跨午夜如 `22:00-2:00`）
- 周末豁免（`quietWeekendExempt` 默认开启）：周六/周日不受静默时段限制
- 已排定的定时提醒与投票开奖不受影响，仍会照常触发
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
