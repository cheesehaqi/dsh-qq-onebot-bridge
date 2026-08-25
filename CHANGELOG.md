# 更新日志 / Changelog

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
