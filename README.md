# dsh-qq-onebot-bridge

QQ ↔ DeepSeek Harness 双向桥插件（独立 bundle）。QQ 消息直接驱动 DSH agent 会话，agent 回复自动发回 QQ。

当前版本 **v0.8.0** · [发布记录（Releases）](https://github.com/cheesehaqi/dsh-qq-onebot-bridge/releases) · [更新日志](CHANGELOG.md)

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

### 官方桌面端（DSH Desktop）

官方桌面端（Electron 版 `DeepSeek Harness.exe`）跑的是 `~/.dsh/profiles/desktop` 这个 profile，**由应用独占管理**（CLI 会拒绝 `dsh --profile desktop`），它和 CLI 版**共用同一个 DSH 运行时版本**——所以本插件从 v0.5.9 起声明的 peer 范围同时覆盖 `^0.1.x` 与 `^0.2.0-rc.2`，两边都能直接装、**不需要 `dsh plugin allow-version` 豁免**。

装法与 web 版一致，只是走桌面端的插件管理界面：

1. 桌面端 → 设置 → 插件 → 安装，选**本地目录**（就是本插件所在的目录，也就是 `dsh plugin --profile web add` 时填的那个路径），或直接填 GitHub 仓库地址；
2. 配置同样写在 `~/.dsh/profiles/desktop/cordis.patch.yml`（`id: dsh-qq-onebot-bridge` 的 config），不要写进仓库；
3. 重启桌面端生效。

> 手动/本地目录安装（不经市场）时注意：光有依赖还不够，**必须同时把 `dsh-qq-onebot-bridge` 加进该 profile `package.json` 的 `dsh.profile.bundles`**，加载器才会挂载它——只装依赖的话它只会出现在"已装依赖"里而不工作（本机实测）。市场安装会自动处理这一步。

> ⚠️ **一台机器只允许一个实例托管 QQ 桥**：web 宿主与桌面端可以都装本插件，但两者抢同一个 OneBot 端口（默认 6700），只有一个能绑上——另一个会在日志里说明原因并**每 15 秒重试**，等端口释放后自动接管（v0.5.9 起不再崩溃、也不会拖住宿主启动）。**不要用"给另一个 profile 改个端口"来让两个都跑**：它们共用同一份 `cwd`（`qq-sessions.json` / `qq-memory/` / `qq-reminders.json` / 积分与统计…都在那儿），两个实例同时读写会互相覆盖，`injectDryRun:false` 时注入队列里的动作还会真的发两遍。要固定由某一个托管，正确做法是**只在一个 profile 里启用本插件**（另一个从 `dsh.profile.bundles` 里去掉），或者把 `cwd` 也分成两个不同目录。

## 在 DSH 设置里开关功能（v0.6「QQ助手」页）

装好插件、**重启一次宿主**（让面板路由挂上）之后：**DSH → 设置 → QQ助手**。

- **11 组、7 组直接铺开**：**AI账号与白名单** / 对话基础 / **限流：入站 / 出站** / **避开高峰期** / 群运营工具箱 / 娱乐与互动 / 语音与媒体；
  **安全与风控 · 记录与通知 · 实验性 · 高级与调试**四组标「进阶」、默认折叠。共 **87 个键**（69 开关 + 12 数值 + 1 时段列表 + 3 名单 + 2 句式列表），
  从 **238 个配置键**里精选 —— 面板只放"日常会动的"，其余仍在 `cordis.patch.yml`（见下面的「v0.7.x 新增开关」）。
  顶部**搜索框**按中文标签 / 配置键名过滤（纯前端）。
  - 两个限流闸放在**同一组**、按管道顺序排，就是为了别混：**每分钟进模型上限**（入站，消息还没进模型就拦，省模型额度）vs **出站回复限流**（模型已生成、发出去之前拦，防 QQ 端发太快被风控）。两个**默认都关**，可以只开一个。
  - **开关和它的数值在同一行里**：左边开关、右边 `− n +`，不用再上下对照「XX」和「XX·数值」谁管谁。
  - **避开高峰期（v0.6.8）**：功能本来就有，但以前只能改 YAML；现在整组搬进面板——开关、**周末不静默**、以及**静默时段列表**（每段两个原生时间控件，支持跨夜 `22:00-6:00`，最多 8 段）。
  - **回复带引用（v0.6.9）**：打开后回复会引用被回答的那条消息（QQ 原生「回复」），多人同时提问时更清楚；**默认关**（单人聊天会显得啰嗦），引用失败（消息被撤回 / ID 过期 / 客户端不支持）会**自动去掉引用重发一次**。它放在**「对话基础」**组——那是"回复的样子"，不是"谁能让它开口"。
  - **AI账号与白名单（v0.6.8）**：这一组回答"机器人是谁、它认谁"——**AI 账号**（`botQq`，判断 @ 与戳一戳）、**回应所有人**、「群里只理被 @ 的」「允许私聊」两个准入门、以及 `allowUsers` / `allowGroups` 两个白名单（**空列表 = 全部拒绝**）。不想维护名单时把「回应所有人」打开：**所有私聊和所有群都会响应**，但**群里的 @ 门槛不变**（仍要 @ 到它）。它们以前都得改 YAML；现在面板里直接填号码（输入框 + 「添加」，号码以**数字**写进配置，写成字符串会让白名单永远匹配不上），还能从「最近来信」一键加入；「回应所有人」开着时两个名单行会标成"现在不起作用"。
- **数值项（v0.6.7）**：风控里那些"阈值"不再要你去手改 YAML——**每分钟进模型条数**（1–10，默认 5）、出站回复的上限与窗口、去重窗口、刷屏治理四项、戳一戳每小时上限、周报天数，都在面板里用 `− 数字 +` 直接改。**范围与步长从 schema 现读**（不抄第二份），越界/小数会被服务端 400 拒掉并说清范围。
- **每行都写清楚**：中文标签 + 一句话"关掉会怎样" + **配置键名**（方便你去配置文件里找同名键），右侧是拨动开关；行尾徽标 `非默认`（与 schema 默认值不同）、`更新中`（配置文件里的值与当前生效值不一致）。
- **点一下即写入**：只改 profile 的 `cordis.patch.yml` 里**本插件那一个 config 块**（其它条目与注释原样保留）；白名单之外的键、非布尔值一律拒绝。写入是**先写临时文件再 rename 的原子替换**，并留一份 `.bak-qqai` 备份。
- **生效方式**：写入后 DSH 会热重载本插件条目（QQ 桥会**短暂重连一两秒**）；若宿主没开热重载，重启宿主后生效。
- **没装 web 服务的宿主**（如 TUI profile）不会有这一页——此时用 `ctx.inject(['webServer'])` 的那段代码**根本不会执行**，插件照常工作。
- **页面最上面是一组「相关链接」**（v0.6.3 起，原来在页面最底下）：依次是 **`QQ助手账号（登录 / 扫码）`**（→ 宿主的 `/qqai/account`，点开即已登录的 NapCat 页面）、`更新日志（v0.6.3）`（GitHub 的 `CHANGELOG.md`）、`调试文档`（README 调试章节）、**`调试台（独立控制台）`（压在最底下）**。地址由 `package.json` / `qq-control.json` 推导。
  - **调试台是独立进程，插件不会自动启动它**：面板会探一次 `127.0.0.1:8799` 并如实标「运行中 / 未启动」；没启动时那一行直接给出可复制的启动命令。
  - 点「调试台」走宿主的 `/qqai/console`：**跑着**就 302 到**带 token** 的地址（省掉手抄 token），**没跑**就回一页说明先跑哪条命令——不会再出现"点进去只看到连不上"。token 只在服务端读，**不进面板数据**。

> 想改的键不在面板里？直接编辑 profile 的 `cordis.patch.yml`（面板顶行会显示它是哪个文件）。面板刻意只放"日常会动的开关"，不做成任意配置编辑器。

## 配置

profile 的 `cordis.patch.yml` 覆盖 `id: dsh-qq-onebot-bridge` 的 config（完整示例见 `examples/cordis.patch.example.yml`）：

> ⚠️ **别改错文件**：仓库根目录也有一个同名 `cordis.patch.yml`，那是**安装用的 bundle patch**（4 行，只有 `insert: - id: …`），**不要往里填配置**。真正要改的是 **profile 目录**里的那份，例如 `~/.dsh/profiles/web/cordis.patch.yml`（Windows：`C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml`）——它在仓库外，**密钥写在那里才不会进 git**。

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
| `chatTurnLimitEnabled` | `false` | **每分钟会话上限总开关**（**默认关闭**）：关着时完全不限流；打开后按下一行的数字生效 |
| `chatTurnsPerMinute` | `5` | 每分钟会话上限的**数值**（1–10，默认 5）：每个会话每分钟最多让几条消息**进模型**，超出的丢弃并记账（不排队）。与 `rateLimitMaxReplies` 不同——那个管"回出去多少条"，这个管"进模型多少次"。面板「安全与风控」里用 `− 数字 +` 改 |
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

### v0.7.x 新增开关（面板里能改，也列在这里方便查默认值）

> 面板只覆盖 **87 / 238** 个键（刻意只放日常会动的；连接地址、端口、token、模型参数、提示词只在配置文件里）。
> 下面这几个是 v0.7 加的，默认值**都在面板里能看到**，这里只是给"看文档的人"一个索引。

| 键 | 默认 | 面板位置 | 说明 |
|---|---|---|---|
| `quoteReplyEnabled` | `false` | 对话基础 | 回复时引用被回答的那条消息（只作用于群聊）；引用失败会自动去掉引用重发一次 |
| `longReplySplitOnPunctuation` | `true` | 对话基础 | 长回复分批时优先在句末 → 句内标点断开；**关掉后仍然按单条上限切成多条**，只是变成等长硬切 |
| `extensionToolsEnabled` | `false` | 实验性 | 允许同宿主其它插件通过 `ctx.qqBridge.registerToolProvider()` 注入工具与提示段（只能新增、抛错跳过并记 trace） |
| `taintDryRunEnabled` | `false` | 实验性 | **污点窗口**：入站命中注入句式后，该会话一段时间内所有出站写动作降级为 dry-run（问答照常），每次拦截都写 trace |
| `taintWindowMinutes` | `30` | 实验性（与上一项同一行） | 污点窗口时长（1–1440 分钟） |
| `taintExtraPatterns` | `[]` | 实验性 | **自定义注入句式**：正则数组（≤20 条、每条 ≤200 字、大小写不敏感、内置 8 条优先）；坏正则保存时 400 拒掉 |
| `outboundRedactEnabled` | `false` | 安全与风控 | **出站脱敏（防线三，v0.7.9）**：发送前把文本里的密钥打码（`sk-…` / `gh*_…` / `AKIA…` / `xox…` / JWT / `Bearer …` / 私钥块）。**QQ 号 / 手机号 / URL 不碰**；只处理文本段 |
| `outboundRedactBlock` | `false` | 安全与风控 | 命中时的动作：`false` = 打码后照发，`true` = **整条不发**并记 trace |
| `outboundRedactPatterns` | `[]` | 安全与风控 | 自定义脱敏规则（正则数组，≤20 条 / ≤200 字）；坏正则跳过并记 trace |

> 想知道"换了 OneBot 实现之后哪些功能会失效"：见 **[docs/COMPAT.md](docs/COMPAT.md)**，
> 或者直接发 `/health` —— 第一行是识别到的实现，后面会点名失败过的动作与最可能的原因。

## 用户侧（OneBot 实现）配置

以 NapCat 为例：OneBot11 配置里把 WebSocket 客户端地址填成：

```
ws://127.0.0.1:6700/
```

其它实现同理（LLOneBot 填反向 WebSocket、OpenShamrock 填被动 WebSocket、go-cqhttp 填 `ws-reverse`）。若本插件配了 `accessToken`，OneBot 端填同一 token。

### NapCat 一键启动与排障（v0.6.5）

**机器人在线只要求 NapCat 反过来连 6700**，不要求你能从这里启动它——但登录/扫码那一步通常得把 NapCat 拉起来。

- **不用手抄路径**：DSH 面板「快捷操作 → 启动 NapCat」与控制台「启动 NapCat」会**自己探测**常见安装位置
  （`%LOCALAPPDATA%\Programs\NapCat\bootmain\`、`%ProgramFiles%\NapCat\bootmain\`、`~\.dsh-qq\`）。
  都没找到时才需要填：控制台「配置 → NapCat 启动脚本」= `…\NapCat\bootmain\launcher.bat`
  （**别填同目录的 `napcat.bat`**：那一版它只是拉起加载器 + `pause`，实测秒退什么都不做）。
  控制台与 DSH 面板读的是**同一份** `qq-control.json`，填一次两边都生效。
- **两个文件都在你的工作目录里**（`qq-control.json` 的 `cwd`）：
  `qq-napcat-launch.cmd`（**垫片脚本**，点「启动 NapCat」那一刻才生成，所以安装包里没有它，别去插件目录翻）
  与 `qq-napcat-launch.log`（提权窗口是隐藏的，启动脚本的输出全在这里）。
- **成功判据是日志里的心跳行**（`=== shim start … ===`）：提权那一跳被系统拦下时，powershell 退出码仍是 0、
  6099 也可能一直在监听（NapCat 本来就在跑），只有心跳能证明"命令真的落地了"。没有心跳时界面会说
  "这次点击什么都没发生"，请**用管理员身份重开控制台/宿主**，或手动右键 `launcher.bat` →「以管理员身份运行」。
- **本机策略 `ConsentPromptBehaviorAdmin=0` 时提权不弹窗**，看不到 UAC 是正常的（不是"没反应"）。
- **「桥：无快照」怎么读**（v0.6.5 起鼠标停上去有完整解释）：① 快照停在 N 分钟前 ⇒ 桥停了/插件被禁用；
  ② 宿主没跑 ⇒ 快照由宿主里的插件写出，先启动宿主；③ 宿主在跑却没快照 ⇒ 插件没启用，
  或**插件的工作目录与控制台配的不是同一个**（插件把快照写成 `<它自己的工作目录>\qq-runtime.json`；
  用控制台「启动宿主」两边就一致）。

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

## 扩展接缝（v0.7.0）

同宿主里的其它插件可以**不改本插件源码**地"发一条消息、看一眼收发、加一组工具"，但**没有**绕过护栏的第二条路：

```js
// ① 实例出口（宿主把它挂成 ctx.qqBridge；挂不上时用下面那个 import 兜底）
const r = await ctx.qqBridge.sendText('g:123456', '你好')     // { ok, reason, chatKey }
await ctx.qqBridge.sendImage('u:1001', '/abs/pic.png', '配文')
ctx.qqBridge.sessions()   // [{ chatKey, sessionId, turnActive }]（只读副本）
ctx.qqBridge.config()     // 配置快照：token / apiKey / secret / password / cookie 已抹掉

// ② 只读事件（ctx.on 或 api.on；返回取消订阅函数）
ctx.on('qqbridge:inbound',  (e) => console.log(e.chatKey, e.text))
ctx.on('qqbridge:outbound', (e) => console.log(e.chatKey, e.kind, e.text))

// ③ 实验性：工具 provider（需要打开面板「实验性」组里的开关）
ctx.qqBridge.registerToolProvider(({ agentCtx, route, key, config, workspaceRoot }) => ({
  tools: [ /* defineTool(...) 的返回值 */ ],
  sections: [ /* { name?, order?, text } */ ],
}), { name: 'my-plugin' })

// ④ 拿不到 ctx 时（插件加载顺序 / 独立进程）：包导出了入口，别再写 file:// 绝对路径
import { getExtensionApi } from 'dsh-qq-onebot-bridge/extension'
const api = getExtensionApi()

// ⑤ 桥实例标识：宿主重建桥（重启 / 热重载 / 面板点开关）后这个值会变，
//    第三方据此判断"我注册的 provider 还在不在原实例上"，不用靠轮询猜
if (api.instanceId !== lastInstanceId) { lastInstanceId = api.instanceId; reRegister() }
```

- **发送一律复用原有护栏**（出站限流 / 注入抑制 / 分段 / 合并转发 / 路径解析 / ActionGate 配额 / TTS 可用性），
  **并额外检查目标是否在白名单**——否则第三方能绕过白名单主动打扰名单外的人/群，而风控封的是机器人自己的号。
- **入站事件在白名单 / 静默 / 去重之后、命令与模型之前**发出：监听**不可能**绕过门禁；文本是归一化后的那份。
- **只读**：事件不能改写内容、不能拦截消息；监听器抛错或异步 reject 只记一条 debug。
- **工具 provider 是实验功能、默认关**：只能新增（不能覆盖 10 个内置 `qq_*` 工具）、provider 抛错只跳过它自己、
  每 provider **16 工具 / 4 段**、总计 **40 / 12** 的上限；注入与跳过全部进 trace。**外部扩展的行为不在本项目维护范围内。**
  （工具上限 v0.7.1 从 8 抬到 16：有真实使用者按"一个包一类工具"拆分，正好卡在 8 上。提示段仍是 4 —— 那是每条消息的固定成本。）
- **写 provider 的三条注意事项**（① 是第三方实战报告，②③ 已按宿主源码核对）：
  ① **不要改写 `agentCtx.tools`**（比如给 `.register` 赋值）。`agentCtx.tools` 背后是宿主**共享的** `ToolRuntime`
     （`@deepseek-ai/dsh-tools` 里 `class ToolRuntime extends Service`；`register()` 内部是
     `this.layers.effect(this.ctx, layer => layer.tools.insert(name, definition))`）。第三方实测：直接赋值会落到
     进程级实例上，**所有** agent 一起被改，且没有任何警告。想按会话过滤工具，正确做法是 `Object.create(tools)` 造视图 +
     只 `defineProperty` 一个 `register`，再用 Proxy 只拦 `tools` 这一个键，其余（`systemPrompt` / `context` / `ctx`）反射透传。
  ② **`tools.restrict({ allow, deny })` 只作用于全局工具**，不是"把这一层收窄成几个"。按 `@deepseek-ai/dsh-tools@0.2.0-rc.2`
     的类型原话：*"Per-scope filter over global tools. Restrictions intersect and do not affect scoped registrations"*，
     `allow` 是 *"Global tool names that stay visible; everything else is removed"*。
     所以：**没被点名的全局工具会静默消失**（预设层的 `web_search` 也会），而**自己 scope 里注册的工具不受影响**。
  ③ 上面那个 `restrict` 还有一半是不静默的：名字必须是**已知全局工具**，写错名字（以及空 filter、`run_code`、scope 内名字）
     会**直接抛错**（`unknown global tool` / `requires a scoped context` / `is a no-op`）。
     要收窄优先用 `deny`（只禁点名的），或者把过滤做在自己的视图层，别去动共享 runtime。
- **写 provider 的四条注意事项**（v0.7.3，来自第一个真实第三方插件的实测，出处见 issue #4 作者的 `ext/README.md`）：
  ① **参数必须是标准 JSON Schema**：直接返回裸工具对象时，宿主用 `assertSupportedJsonSchema` 校验，
     属性里写 `required: true` 会被**直接拒**，必须写成对象顶层的 `required: ['name']` 数组。
     用本项目的 `defineTool({...})` 则自动转成这份标准形状（推荐）。
  ② **provider 里不要放 per-apply 状态**：cordis 的 live reload 只重新 `apply()`、**复用同一个模块实例**，
     状态写在 `apply` 内会每次多堆一个同名 provider（新工具因重名被跳过，trace 里一串 skipped）。状态请放模块级。
  ③ **注册会随桥实例消亡**：桥重启 / 热重载 / 面板点开关都会重建实例，你的 provider 就不在了 ——
     所以第三方应自己重挂（例如每 5s 检查一次 `api === lastApi && api.toolProviders().includes(你的名字)`，
     不在就重新 `registerToolProvider`；别做成"注册成功就停"的一次性轮询）。
  ④ **改 JS 要重启宿主**：改 `cordis.patch.yml` 的 config 会触发热重载（重跑 `apply`），但改 `index.js`
     本身不会重新 import —— 常见做法是把工具实现放在 `body.mjs`，每次 `apply` 带时间戳重新 import 它。
- 不做的事（评估过）：**出站内容改写 / 可拦截事件**（等于开"替机器人说话""静默吞消息"的旁路）、多账号多实例、向量记忆。

### 第三方扩展（社区）

- **[551123 / dsh-qq-onebot-bridge · `patches/0.7.9/ext`](https://github.com/551123/dsh-qq-onebot-bridge/tree/patches/0.7.9/ext)** ——
  第一个真正用 `registerToolProvider` 的插件集：小屋 / 页面与笔记 / 工作区 / 表情四个包、20 个工具，
  按我们的 tag 维护，`ext/README.md` 里写了安装方式与五条硬约束（`file://` 解析、标准 JSON Schema、同步返回、状态放模块级…）。
  **由作者本人维护，不在本项目的支持范围内**；这里只做指路，出问题请去他仓库提。
  链接约定（作者与他约定的，写在这里免得每次都要问）：**分支永远叫 `patches/<我们的 tag>`、`ext/` 永远在分支根目录**，
  所以这条链接只需跟着最新 tag 改；分支里是 1 个提交还是十几个，都不影响这个地址。

### 兼容承诺（我们怎么改这些接口）

公开的东西一旦有人用，就不能随手改了——所以规则先写在这里：

- **只增不改**：新增方法 / 新增事件字段 / 新增返回字段 → **不升版本**，老调用方不受影响。
- **删改现有名字或形状**（改名、改参数顺序、改变返回值含义、把异步改成同步…）→ **升 `version`**（现在是 `1`），
  并且旧版**至少保留一个小版本**，README 上标 `deprecated`，到期才删。
- **事件只读**不变：不会给 `inbound` / `outbound` 加"能改内容 / 能拦消息"的返回值——要那种能力请另开插件，不走这个接缝。
- **"有没有人在用"看得到，但不是"统计"**：只有出口**真的被调用过**，面板「实验性」组才多出一行
  `出口被调用（本机计数：只在内存里累加，不含消息内容、不外传、重启清零）：sendText N · …`。
  全 0 时整行**不显示**。它不落盘、不进 `qq-runtime.json`、不发任何请求，面板也只由本机宿主提供 ——
  换句话说：**它数的是"别人有没有调用这个 API"，不是"你在用什么"**；没数字就说明没人在用，
  那时任何破坏性改动都不疼，一旦有数字，上面三条就生效。
- 内部实现（私有方法、文件格式、trace 字段）**不在此承诺范围内**，随便重构。

### 关于 fork：上游只有一条线

- **本仓库只维护 `main` + tag**（例如 `v0.7.4`）。GitHub 上的 fork 是**别人的副本**：它不等于上游分支，
  也不会自动进这里——fork 里有多少提交，这条 `main` 一条都不受影响。
- **我们不合并、也不 rebase 别人的 fork 历史**：那些提交按 fork 作者自己的节奏演进，硬并进来历史会读不懂。
  想贡献就开 issue 或 PR（小改动直接 PR 最快）；想长期维护一条自己的线也完全没问题——按我们的 tag rebase 即可。
  我们不会去抄你的提交历史，但**想法可以取**（v0.7.4 的「污点窗口」就来自 issue #4 作者的补丁分支）。
- 装的时候认准**本仓库或 npm 包**，别从任意 fork 装——里面的代码可能被改过，而 README 与 CHANGELOG 只描述这条线。
- **给"按字面锚点做补丁"的人**：我们重构不会为兼容放慢，但会在 CHANGELOG 里点出来——
  尤其是 `lib/bridge.js` **顶部的 import 块**、以及某个函数被**整块重写**这种会让人重锚的改动。
  （这条是 issue #4 作者要求的：他的补丁库靠"在 pristine 的哪个唯一字符串处替换"定位，import 一动锚点就没了。）

## 命令与调试

**命令清单不写死在 README 里**，因为它是**按你打开的开关动态生成**的 —— 在 QQ 里发 **`/help`**（或「帮助」「菜单」）
就能看到**当前这份配置真正可用的命令**（关掉的玩法不会出现，省得你以为是坏的）。

下面是按用途的摘要，细节见 `docs/FEATURES.md`：

| 用途 | 常用命令 |
|---|---|
| 会话 | `/new` 新对话 · `/status` 会话状态 · `/summary` 群聊总结 · `/export` 导出记录 |
| 查询 | **`/为什么`** 某条消息为什么没回 · `/health` 运行诊断 · `/成员` 名单/详情 · `/群信息` `/公告` `/荣誉` `/精华` · `/找一个历史` · `/文件` `/取` `/相册` `/ocr` |
| 玩法 | 「签到」打卡 · `/签到榜` · `/积分` `/排行榜` `/转账` · 「今日人品」「抽签」 · `.r 3d6` · 「接龙」「猜数字」 · `/画` 生图 · `/读` 朗读 |
| 群运营 | `/mute` `/unmute` `/kick` `/clear` · `/公告` `/全员禁言` `/名片` `/头衔` · `/批量踢` · `/禁言名单` `/全体余量` · `/退群`（慎用） |
| 管理/调试 | `/reminders` 提醒 · `/todo` 待办 · `/日报` · `/kw` 词库 · `/播报` · `/赞榜` `/谁赞了` · `/点赞` `/戳` · **`/能力体检`**（只读探针，见下） |

两条最常用的（单独说清楚）：

- **`/为什么`（v0.6.9）**：引用那条消息发 `/为什么`（或 `/为什么 <消息id>`、不带参数查本会话最近一条），
  它把 trace 的决策链翻译成人话：`收到消息✅ → 白名单✅ → 静默时段⛔` + 「卡在「静默时段」：…」。
  群聊仅管理员可用；只给环节与原因，不回显消息原文。
- **`/health`**：一次性体检（连接、闸门、录制/注入状态、配置生效值），和面板顶部那份诊断同源。
- **`/能力体检`（v0.7.9）**：对当前 OneBot 实现跑一轮**只读**探针（21 个 `get_*` 动作，逐个分类成
  「支持 / 不支持 / 参数不符 / 权限不足 / 无响应」），回答"这个功能是真不支持，还是我还没用到"。
  **写操作永远不探**（会改 QQ 状态）；群里仅管理员可触发。详见 [docs/COMPAT.md](docs/COMPAT.md)。

- 调试日志：`{cwd}/qq-bridge-debug.log`（消息路由、语音转写、agent 事件，按时间戳追加）
- 宿主错误日志：启动 dsh web 时把 stderr 重定向到文件（如 `%LOCALAPPDATA%\qq-host-err.log`）可查启动崩溃
- 关键日志标记：`voice fetched via get_record`、`quoted voice transcribed`、`followup sent (voice)`、`group msg without @bot ignored`

## 测试

65 个单测脚本，共 4224 项断言（`test/*-unit.mjs`）+ 3 个真机脚本：

```sh

# 1) 单元测试：不联网、不起宿主，纯逻辑 + 临时目录（推荐每次改完都跑）

node test/control-unit.mjs        # 也可以逐个跑：node test/<name>-unit.mjs

#    62 个文件：桥的分支/命令/守卫、控制台 HTTP 与体检、录制回放与注入、注入安全边界、硬约束验收台、

#    `/为什么` 的决策链翻译（why-unit）…

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
- **密钥泄露**：模型看到的内容（群聊、文件、网页回显）可能包含你的密钥，被它复述进群。插件现在有**三道防线**：
  ① 注入回合 dry-run（`injectDryRun`）② 污点窗口（`taintDryRunEnabled`，命中注入句式后窗口内出站全拦）
  ③ **出站脱敏**（`outboundRedactEnabled`，v0.7.9，默认关）—— 发送前把 `sk-…` / `gh*_…` / `AKIA…` / JWT /
  `Bearer …` / 整段私钥打码（或按 `outboundRedactBlock` 整条拦下），并在 trace 里注明命中了哪条规则（**不写原文**）。
  这三道都需要自己打开；关着就等于没有这层保护。

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
- **提示注入**：模型看到的外部内容（别人转发的话、群文件、网页回显）可能夹带指令。默认做法是照常处理，
  只在系统提示里要求"外部内容不可信"；想更进一步，打开面板「实验性」里的**污点窗口**——
  命中注入句式后那段时间的出站写动作全部降级为 dry-run（**副作用：回复发不出去，只在 trace 与面板状态行里可见**）

## 更多文档

- **[docs/DEBUG.md](docs/DEBUG.md)** —— 调试 / 排障：trace、离线回放、事件注入、一键体检、诊断包、硬约束验收台
- **[docs/EXTENSIONS.md](docs/EXTENSIONS.md)** —— **扩展接缝**：`ctx.qqBridge` 的出口、只读事件、工具 provider 的七条规矩、`instanceId`、污点 `source`、会影响到第三方的配置键
- **[docs/COMPAT.md](docs/COMPAT.md)** —— **换 OneBot 实现会怎样**：71 个 action 的三层分级（标准 / 扩展 / NapCat 专属）、换实现的检查清单、以及为什么不做"主动探针"
- **[docs/FEATURES.md](docs/FEATURES.md)** —— v0.5 能力细节：合并转发展开、`/文件` `/取` `/相册` `/ocr`、按天归档与 `/找`、群成员与群信息、表情反应

## 独立控制台（control/，自 v0.4.0）

插件自带一个**独立的本地运维端**，不依赖 DSH 桌面端：宿主挂掉时它照常可用，端口与进程一目了然。

```sh

# 启动（默认 http://127.0.0.1:8799，启动后打印带 token 的地址）

npm run control            # 或 node control/bin/qq-control.mjs --open

# 直接打开「账号中心」（本地页面 /accounts）：没在跑就顺手把控制台起来
npm run accounts           # 或双击 control/账号中心.bat

# 在桌面建一个「QQ 账号中心」快捷方式（双击即用，指向上面的 bat）
npm run shortcut

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
| 账号中心 | **`/accounts`**（v0.7.11 起）：本地页面直接看 NapCat WebUI 的地址与打码 token、登录状态、扫码二维码、快速登录列表与本机账号配置；可一键「快速登录」或「设为自动登录」。**只连本机**，`webui.json` 的 token 只在服务端使用；NapCat 没起时如实说「连不上」而不是报错 |
| 安全 | 只绑 `127.0.0.1`；所有 API 需要 token；带 `Origin` 的跨站请求一律拒绝 |

> 以后若想做真正的托盘/桌面程序，直接包一层 Electron/Tauri 复用同一套 HTTP API 即可，逻辑无需重写。

### 排障：NapCat「点重启没反应 / 自己起不来」

真机上踩过的现象与原因，写在这里省得再查一遍：

| 现象 | 原因 | 处理 |
|---|---|---|
| 手动跑 `napcat.bat`，只打印一行 `argv[0]:.\NapCatWinBootMain.exe` 就退出，QQ 没起 | 该 bat 里是 **`NapCatWinBootMain.exe` 不带参数**；引导器需要 QQ 号才干活 | 用带参数的启动方式：`NapCatWinBootMain.exe <QQ号>`（同目录的 `quick.bat` 就是这么写的），或 `launcher.bat` |
| 用 `spawn` 拉起却没反应，直接跑又正常 | bat 里用的是 `.\NapCatWinBootMain.exe` **相对路径**，`cwd` 不对就找不到 exe | 启动时把 `cwd` 设到 `bootmain/` 目录 |
| 控制台点「重启 NapCat」只报「连不上」 | 旧实现只调 WebUI 的 `RestartNapCat`，进程不在时必然失败 | v0.7.11 起：连不上就**用 QQ 号拉起**（`autoLoginAccount` → `onebot11_<uin>.json` 兜底），没有 uin 再退回 `launcher.bat` |
| 拉起时弹出 UAC / 需要管理员 | `launcher.bat` 会 `net session` 自检，非管理员就调 `launcher-elevate.ps1` 用 `wt.exe` 提权 | 进程无法静默提权，**UAC 必须本人点**；不想提权就用 `NapCatWinBootMain.exe <QQ号>` 的直启方式 |
| 页面显示「NapCat 连不上（可能正在重启）」 | 6099 在 NapCat 重启窗口内不监听 | 页面已自动重试 3 次（间隔 2 秒）；仍失败会给「重试」按钮，等十几秒再点 |

排查顺序建议：先看 `6099` 有没有在听 → 再看 `QQ.exe` 有没有起来 → 都正常但页面还报连不上，再回去看 `webui.json` 的端口与 token。

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

> **每个发过的版本都有 Release 页**（27 个 tag 全覆盖：该版改了什么 + 与上一版的完整 diff 链接）：
> <https://github.com/cheesehaqi/dsh-qq-onebot-bridge/releases> —— 想快速判断"要不要升级"看这里；
> 想读完整历史（缺陷清单、测试计数）看 `CHANGELOG.md`。

最近五个版本（始终滚动展示）：

- **v0.8.0** — 「本地账号中心」：`/accounts` 11 个分区（基础信息 / 账号配置 / 网络配置 / 文件 / 插件 / 运行日志 / 实时测试 / 运行与设备 / 系统配置 / 操作记录 / 关于）；网络配置可增删改与启停、系统配置可改端口与回环地址、插件可启停卸载，写前均有 `.bak` 备份；实时测试支持「单发 / 即时调试 15 秒」并能点开事件看完整链路；修掉 `assistantText` 在 `content` 非数组时崩溃（会吞掉整条回复）
- **v0.7.10** — 「能力体检 + 两处测试口径修正」：① **`/能力体检`**（`lib/conformance.js`）—— 21 个**只读**探针（状态/版本/登录号/群与好友/成员/荣誉/精华/公告/群文件/历史消息/@全体余量/禁言名单/群打卡/群相册/系统消息…），逐个分类成「支持 / 不支持 / 参数不符 / 权限不足 / 无响应 / 没有数据」，回答"这功能是真不支持还是我没用到"；写操作**永远不探**，且 `assertProbeSafety()` 会拒绝任何 `send_/set_/delete_/upload_/mark_` 条目 —— 手滑加一条写操作，体检直接拒跑。结果落到 trace、面板「高级与调试」与 `knownUnsupported`。② 两处测试口径：`inject-guard-unit` 的 7 处数组全等改成**后缀匹配**（宿主给正文加前缀不再整段崩，且不会把「注入的消息」认成「注入的消息二」）；`privacy-unit` 区分「git 检出缺 `.gitignore`（照红）」与「npm 包形态缺（显式跳过）」。面板不变（87 键）。
- **v0.7.9** — 「换桥会怎样 + 防线三」：① **能力矩阵**（`lib/capability.js`）—— 插件一共调 71 个 OneBot action，按 **standard 32 / extension 31 / napcat 4** 三层分级；连上后读 `get_version_info` 认实现（NapCat/LLOneBot/Lagrange/…），`#call` 唯一出口挂**被动账本**（成功计数、失败记次数与错误，**不记参数**），首次失败写一条 warn trace 并直接判断「大概率是当前实现不支持」还是「查连接/权限」；`/health` 与面板「高级与调试」都能看到；新增 **docs/COMPAT.md 中英**（三层表 + 换实现检查清单）。② **出站脱敏**（防线三，`outboundRedactEnabled` 默认关）—— 发送前把 `sk-…` / `gh*_…` / `AKIA…` / JWT / `Bearer …` / 整段私钥打码（保留首尾），`outboundRedactBlock` 可改成整条拦下；**QQ 号/手机号/URL 不碰**；收口在 `sendSegments`（16 个出站调用点全覆盖）；trace 只写命中的规则名、**不写原文**。③ 面板「安全与风控」「高级与调试」两组新增状态行；至此三道防线齐：注入 dry-run → 污点窗口 → 出站脱敏。
- **v0.7.8** — 「自定义注入句式 + 四处收拾」：① **`taintExtraPatterns`**（正则数组，默认空）—— 污点窗口除了内置 8 条，还能让管理员按群补句式（≤20 条 / 每条 ≤200 字 / 大小写不敏感 / 内置优先）；**坏正则不静默**：面板点保存时服务端先编译，语法错当场 400 且不改文件；配置文件里手写错的，桥启动时写 trace 点名。② 面板说明讲清「只覆盖约三分之一」（235 个键里登记 84 个，连接/端口/token/模型参数只在 YAML 里），并新增「面板键 ⊆ schema」的测试防线。③ 新增 **`.gitattributes`**（`* text=auto eol=lf`），消掉每次提交的 CRLF 噪音。④ `package.json` 补 `engines.node>=20` 与 `author`。⑤ 新增 **`docs/EXTENSIONS.md` 中英**（扩展接缝参考：出口 API / 只读事件 / provider 七条规矩 / instanceId / 污点 source）；⑥ 修正 `punctuation: false` 的措辞（**仍会按上限分批**，只是不找标点）。
- **v0.7.7** — 「按标点断句变成配置键」：新增 **`longReplySplitOnPunctuation`**（默认开，面板「对话基础」里一行）——`#replyTo` 的调用点直接读它，所以第三方不用再改我们的函数签名或调用点（v0.7.6 只给了函数参数，没接线）。只有**超过单条上限**的长回复才触发分批，普通对话看不到区别；关掉后**仍然会按单条上限切成多条**（分批不受影响），只是每批不再往回找标点、变成等长硬切。

**更早的版本（v0.4 线及之前）见 [CHANGELOG.md](CHANGELOG.md)** —— 完整历史、每个版本的缺陷清单与测试计数都在那里。
也可以直接在 [Releases](https://github.com/cheesehaqi/dsh-qq-onebot-bridge/releases) 页按版本过滤（每版都带 `compare/v上一版...v本版` 的 diff 链接）。
