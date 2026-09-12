# 更新日志 / Changelog

## v0.4.0（2026-09-11，**本地预发布：未推送 GitHub、未打发布包**）

**设计理念：一切皆可调试（Everything Debuggable）**

> 用户 2026-09-12 指定 v0.4 的设计理念。落到 6 条硬约束：① 无静默分支（任何"不回复/丢弃/降级"都留 reason）② 可关联（一条消息一个 traceId 贯穿到底）③ 可回放 ④ 可体检 ⑤ 可导出诊断包 ⑥ 可注入。纲领全文见 Mnemon 文档 `2d6f1b23`。①②④⑤ 见下（阶段 1+2），③⑥ 见「录制 · 离线回放 · 事件注入」（阶段 3），6 条约束的实时验收见「硬约束验收台」（阶段 4）。

- **插件侧结构化追踪（新模块 `lib/trace.js`）**：每条入站消息分配 `traceId`，所有决策点写入统一事件 `{ts, level, module, traceId, chatKey, stage, ok, reason, ms, data}`
  - 双写：`cwd/qq-trace.jsonl`（4 MiB 上限、尾部保留 512 KiB 轮转）+ 内存环（`traceMemorySize`，供 `/health` 与快照）
  - `beginTrace()` 句柄提供 `mark()`（记录一步 + 距上一步耗时）与 `step()`（外部调用计时，失败自动记 error 并保留原错误）
  - 事件中的 `data` 会做可序列化兜底，循环引用不会污染内存环或写坏 JSONL
- **桥内逐分支埋点**：白名单（区分私聊/群/成员）、静默时段、去重、敏感词/刷屏、入群验证、关键词、小游戏、私聊关闭、**群聊未 @**、空文本、引用解析、媒体下载、转文字、各命令分支、提醒登记、以及 **agent 转交 / 回合开始 / 回合结束（含耗时）/ 模型空输出 / 回复发送与出站限流丢弃**——每一处都带中文 reason
- **运行快照 `qq-runtime.json`**（跨进程给控制台读）：会话列表（含是否续接、最近回合）、提醒/投票/游戏/待审计数、写操作闸门统计、trace 汇总、**生效配置**（`features`：哪些开关是开的/关的，绝不含任何密钥或口令内容）
- **控制台升级成调试器（`control/`）**：
  - `/api/trace`（按 level/stage/chatKey/ok/traceId 过滤）、`/api/stream`（SSE 实时事件流）、`/api/runtime`、`/api/diagnose`、`/api/export`
  - 增量 tailer（`createTraceTailer`）只读新增字节，处理文件轮转；首次连接回吐最近一段，新客户端不至于全盲
  - **一键体检**（`control/lib/diagnose.mjs`）：把"机器人没反应先查这些"的人工清单自动化成 15-19 项 pass/fail（依赖路径、五个端口、机器人是否连上、桥是否活跃、快照新鲜度、会话/闸门/生效配置、error/warn、静默丢弃汇总、写操作拒绝、事件文件），每项附修复建议与 blocker/warn 分级
  - **诊断包导出**：零依赖 ZIP 写入器（`control/lib/zip.mjs`，store 方式 + CRC32 + UTF-8 名），打包 trace/审计/桥日志/宿主日志/运行快照/体检报告/环境信息
  - 面板新增「实时事件流（可过滤/暂停，点行看决策链）」「决策链时间轴」「一键体检」「运行快照（会话+生效配置）」「错误徽标」，并且**面板自身也自曝脚本错误**；支持 `&stream=0` 静态模式（弱网/远程/自动截图）
- **删除策略：先回收，不销毁（用户规则 2026-09-12）**：图片保留期清理不再 `unlink`，而是把过期文件**移动**到 `cwd/qq-trash/<日期>/`（`imageTrashEnabled` 默认开、`imageTrashDir` 可改）；移动失败则**保留原文件**并记日志，绝不静默销毁。回收目录不自动清理，由使用者自行处理（本机可用 `scripts/safe-delete.ps1` 送进 Windows 回收站）。新增 `lib/store.js` 的 `expiredFiles()` / `moveToTrash()` 纯函数与 9 项测试
- 新增测试：`test/trace-unit.mjs`（41）、`test/trace-branches-unit.mjs`（29：11 类静默分支逐一断言带 reason、traceId 贯穿到出站回复、runtime 快照不含密钥）、`test/console-debug-unit.mjs`（70+：trace 读取/尾部增量/过滤/决策链/汇总、体检分支与文本、ZIP CRC 与结构、新接口真实 HTTP 往返、**面板静态校验**——脚本语法/元素 id/调用接口是否存在）、`test/live-stream.mjs`（真宿主 SSE + 决策链实测）

### 独立控制台（control/）

- **独立进程、独立端口**：`control/bin/qq-control.mjs` 自带 HTTP 服务，只绑 `127.0.0.1:8799`（可 `--port` 改），不依赖 DSH 桌面端或 web 宿主——宿主挂了控制台照常可用
- **端口单一真源** `control/lib/config.mjs`：`qq-control.json` 统一管理控制台 8799 / 宿主 3080 / OneBot 6700 / NapCat 6099 / GPT-SoVITS 9880；node 可执行文件、`dsh bin.js`（自动扫 npx 缓存取最新）、NapCat 启动脚本与二维码路径、TTS 脚本、日志路径全部**自动探测 + 可覆盖**
- **监管能力** `control/lib/supervisor.mjs`：解析 `netstat -ano` + `tasklist` 得到每个端口的监听状态/占用 PID/进程名，以及 6700 上的连接数（=机器人在线）；支持启动/停止/重启宿主（`--no-open`、日志重定向）、启动/停止 NapCat 与 QQ、启动/停止 GPT-SoVITS、一键全停、释放被占端口
- **启动预检**：启动宿主前先探 3080/6700，被占则拒绝启动并报出「端口←进程#PID」，消灭"端口被占 → 表现为长时间重新连接"的静默失败
- **杀进程护栏** `assertKillAllowed`：只允许结束"占用受管端口"或"已知机器人进程"（node/QQ/NapCat/python），拒绝杀控制台自身与无关 PID
- **安全模型** `control/lib/server.mjs`：所有 `/api/*` 需 token（query 或 `X-Control-Token`）；带 `Origin` 的请求必须来自控制台自身的源（阻断任何跨站页面驱动本机进程操作）；日志名白名单防路径穿越；配置写入只接受白名单字段与合法端口
- **单页控制台** `control/ui.html`（无外部依赖、离线可用）：五端口状态灯、机器人/宿主在线徽标、QQ/NapCat/Python 进程与二维码新鲜度、按用途分组的操作按钮、三份日志（宿主 stdout/stderr、桥调试日志）自动跟随、路径配置表单；启动器 `control/启动控制台.bat`，也可 `npm run control`
- 新增测试 `test/control-unit.mjs`（76 项）：netstat/tasklist 解析（含 IPv6、表头、ESTABLISHED）、端口摘要与中文标签、日志尾部与 3080 token 提取、二维码新鲜度、配置探测/覆盖/保存/提醒、杀进程护栏正反例、启动命令构造与端口占用拒绝、**真实 HTTP 往返**（UI、404、401 无/错 token、403 跨站 Origin、状态/日志/各 mutation、路径穿越拦截、非法 JSON、非法端口过滤）、`killTree`/`inspect`/`readUi` 容错

### 录制 · 离线回放 · 事件注入（阶段 3：可回放 + 可注入）

- **录制（新模块 `lib/inbox.js`，`recordInbound` 默认开）**：桥收到的每条消息/通知/请求按**可回放形状**追加到 `cwd/qq-inbox.jsonl`（单行 JSON：`{v,ts,kind,frame}`，只保留业务字段，socket/未知字段一律丢弃；文本截断 2000 字；2 MiB 上限、尾部保留 256 KiB 轮转）
  - `inboxRedact`（默认关）：落盘前把 6 位以上数字（QQ 号）脱敏，便于把录制文件发给别人排查
  - 注入的帧**不会**被二次录制，避免"注入 → 录制 → 回放 → 注入"自激
- **离线回放（新模块 `control/lib/replay.mjs`）**：在**沙箱目录**里用**真实桥代码 + 真实 OneBot 服务端**重跑录制的消息
  - 三重隔离：① `config.cwd` 强制指向沙箱（状态/事件/媒体/运行时全部落在沙箱内），只把线上决策状态**拷贝**进去（词库、积分、签到、提醒、统计、记忆、待办、表情），源目录一个字节都不改；② `OneBotServer` 开启 dry-run 且**从不 `start()`**——没有 socket、没有监听端口，出站调用全部被拦截并计数；③ 模型回合用一条带 `[回放]` 前缀的模拟回复代替（只验证链路与分支，不冒充模型措辞）
  - 结论逐条给出 `会回复 / 静默 / 出错 / 只调用了非发送动作` + **原因** + **会发送什么**（动作名与分段文本）+ 完整决策链；沙箱默认保留最近 5 次，更旧的**移入回收站**（`qq-replay/_trash/<日期>/`）
  - **保真度来源**：桥把线上 28 项决策配置写进运行时快照的 `replay` 段（白名单、安静时段、各功能开关…），否则"白名单为空 = 拒绝一切"的默认值会让回放全部误判为静默；快照仍**不含任何密钥**（口令只写"是否已配置"）
  - 回放参数支持"试配置"：请求里可覆盖任意插件配置键（如临时打开 `keywordEnabled`、改 `quietHours`），`cwd`/事件文件等沙箱关键键**强制忽略**
- **事件注入（`injectEnabled` 默认关）**：控制台写一行到 `cwd/qq-inject.jsonl`，桥按 `injectIntervalMs`（默认 2000ms）轮询，新行经**真实管线**处理（白名单/@ 门/命令/agent 全走一遍）
  - `injectDryRun` **默认 true**：注入触发的所有出站调用被拦截并在事件流里计数（"注入完成：N 个出站调用被拦截"），绝不真发 QQ
  - 只消费**启动之后**追加的行；启动时队列里已有的历史行会被跳过，并留下一条事件说明跳过了多少行、规则是什么（无静默分支）
  - 注入通道未开启时控制台**直接报错并指出开关名**，不会静默入队；控制台「清空注入队列」把文件**移入回收站**而非删除
- **控制台新增「录制 · 回放 · 注入」面板**：录制列表（序号/时间/类型/可读内容/一键回放）、回放结果文本、注入表单（消息/通知/请求 + 群号/QQ 号/文本/@ 开关）、注入队列状态（行数 · 本次已消费 · dry-run 开关）
  - 新接口：`GET /api/inbox`、`POST /api/replay`、`POST /api/inject`、`POST /api/queue/clear`（仍受 token + Origin 双重校验；回放条数、下标数量、回复文本长度、时间预算全部在服务端裁剪）
- **日志尾部读取器加固（`createLineTailer`）**：半行缓冲（正在写入的那一行绝不以半截 JSON 交出）；位置**立即定位**且队列文件不存在时从 0 开始（否则文件首次被创建时首行会被吞掉——真机测试抓到的 bug）；文件被替换/截断视为全新内容
- **注入安全边界（真机测试抓到的漏网）**：dry-run 窗口只覆盖同步阶段，而 agent 回合是**异步**的——模型几秒到几分钟后才回话，那条回复原本会真的发到 QQ。现在给注入帧的会话打"注入回合"记账，`#onSessionEvent` 会把该回合的 `assistant/message` 也拦下，原文写进事件流（`注入回合的模型回复已被拦截（dry-run，未发送）：…`）；收到**真实消息**时立即解除标记，绝不连坐真人；回合结束（含宿主已知的 `turn/end` 报错）也会清账，避免漏拦下一回合。确定性覆盖见 `test/inject-guard-unit.mjs`（15 项：基线发送、注入回合拦截、注入后真人恢复、注入回合报错不连坐、连续两次注入都拦、私聊同理、同步出站仍进 dry-run）
- **回放与注入在事件流里分开标记**：回放的帧标 `replay: 离线回放（沙箱 + dry-run，不碰 QQ）`，注入的帧标 `inject: 来自注入器`；`STAGES` 增加 `inject` / `replay` 中文标签。回放帧也不再被误判成注入（后者会命中上面的拦截逻辑，导致回放永远看不到本该发出的回复）
- 新增测试：
  - `test/inbox-unit.mjs`（116）：字段白名单/序列化/脱敏/轮转/坏行容错、`describeFrame`、`expandInjection` 全分支（群/私聊/通知/请求/纯图片/引用/缺参中文报错）、注入行往返一致、tailer 半行容错与四种定位语义
  - `test/replay-unit.mjs`（74）：沙箱计划与拷贝（敏感文件永不复制、媒体目录只提示）、强制配置（cwd/事件文件/dry-run/关闭外发）、mock 上下文与模拟回合事件顺序、结论归因（只有 level=error 才算出错，被拒分支是正常决策）、回收站剪枝、编排（单条/批量/上限/预算/异常/通知类）
  - `test/replay-console-unit.mjs`（53）：`hintConfig` 白名单（拒绝 cwd/traceFile/未知键）、真实 supervisor 读写录制与注入（含坏行、通道未开启、清空进回收站、失败报告形状）、四个新接口的真实 HTTP 往返与参数裁剪、**面板静态校验**（新元素/新函数/内联 onclick 全部存在、脚本可解析）
  - `test/inject-guard-unit.mjs`（15）：注入帧**绝不真的发出 QQ 消息**的时序全覆盖（见上）
  - `test/replay-live.mjs`（23）：真实桥代码的离线回放验收——关键词命中会回复、未 @ 会静默、私聊命令可用、安静时段给原因；断言 sandbox 隔离、dry-run、无 QQ 连接、无新增监听端口、源目录字节与 mtime 不变
  - `test/replay-live-host.mjs`（38，真机）：真实消息落盘 → 控制台列表 → 离线回放结论与线上一致（白名单来自线上快照、链路出现 `replay` 标记）→ 注入在轮询间隔内被消费、dry-run 拦下全部出站、注入帧不被二次录制 → 历史注入被明确跳过 → 注入回合的模型回复被拦下且原文未出现在任何出站里（模型 300s 内没回话时如实记为 WARN 而非假失败）

### 硬约束验收台（阶段 4：验收）

- **新模块 `control/lib/acceptance.mjs`（纯函数）**：把 6 条硬约束逐条用**机器上现有的产物**算成 `✅ 达标 / ⚠️ 有提示 / ❌ 不达标 / ❔ 证据不足`，附证据文本、修复提示与关键指标；结论分 `all-green / partial / unknown / broken` 四种
  - ① 无静默分支：最近 500 条事件里所有 `ok:false`（被拒/失败）事件必须带非空 reason，缺的按 stage 点名（空白字符串也算缺）
  - ② 可关联：消息级事件的 traceId 覆盖率 + 有多少条消息真正走完 `inbound→reply`（只有被拦下没走到回复时是"告警"而不是"不达标"，并说明可能原因）
  - ③ 可回放：录制条数 + 最近一次回放的统计与**安全保证**（dry-run 必须开、QQ 连接必须 0、cwd 必须已沙箱化——任一不满足直接判不达标）+ 沙箱数量
  - ④ 可体检：体检的通过/失败/blocker 数与结论，失败项点名（blocker→不达标，普通失败→告警）
  - ⑤ 可导出：诊断包会收集的 6 类产物有几类在位，或最近一次导出的体积与文件名
  - ⑥ 可注入：通道开关 + dry-run 开关（**关掉即不达标**，因为注入会真的发到 QQ）+ 本次已消费行数 + 队列行数 + **拦下过几次异步 agent 回合的回复**
- **`GET /api/acceptance`**（token + 同源 Origin 校验）返回 `{ ok, verdict, totals, report, text }`；旧控制台缺少该方法时返回可读的"不支持"原因而不是 500
- **supervisor**：新增 `acceptance()`，顺带把"回放结果/导出结果"缓存成验收证据（`lastReplay` / `lastExport`），并给体检加 5 秒短时缓存（面板与验收台同时刷新时不再重复扫 `netstat`+`tasklist`）
- **面板**：顶部新增「硬约束验收台」卡片（6 行状态灯 + 证据 + 提示 + 「去看 →」跳转到对应卡片并高亮），加载即算、每 30 秒自动重算、**回放结束后立刻重算**（③ 的证据当场更新）
- 新增测试 `test/acceptance-unit.mjs`（68）：6 条约束的达标/告警/不达标/证据不足分支（含"回放期间有 QQ 连接""dry-run 被关掉""消息级事件缺 traceId"等危险分支必须判不达标）、汇总口径与文本视图、真实 supervisor 汇总（临时目录里造事件/快照/录制/沙箱，验证口径与回收站不计数）、`/api/acceptance` 的真实 HTTP 往返与 token/Origin 门禁、**面板静态校验**（新卡片元素、新函数、跳转目标、内联 onclick 全部存在）
- 阶段 4 完成意味着 6 条硬约束**全部落地且有测试与实时验收**：①无静默分支 ②traceId 贯穿 ③可回放 ④可体检 ⑤可导出 ⑥可注入

## v0.3.9（2026-09-11）

**群洞察与定时播报：活跃统计、群荣誉/公告/精华、每日群日报、重复提醒、MC 服务器状态**

- **群活跃统计**（`statsEnabled` **默认关闭**，新模块 `lib/stats.js`）：每个会话按天记录成员发言条数（`/` 开头的命令不计入），`/统计` 看今日榜、`/周榜` 看近 7 天榜；数据存 `cwd/qq-stats/<会话>.json`（原子写、`statsKeepDays` 天自动裁剪）
- **只读群信息查询**（`groupReadEnabled` 默认开）：`/荣誉`（`get_group_honor_info`，龙王/群聊之火/群聊炽焰/快乐源泉）、`/公告`（`_get_group_notice` 读取群公告）、`/群精华`（`get_essence_msg_list`）——全部只读，无风控增量
- **每日群日报**（`dailyReportEnabled` **默认关闭**）：到 `dailyReportTime`（默认 22:00）自动让 agent 用当天聊天记录 + 发言统计写一份口语化日报发到群里
  - 目标会话 = `dailyReportChats` 显式配置 ∪ 用 `/日报 on` 自助开启的群（两者都为空时回落到全部 `allowGroups`）
  - 复用会话续接通路：日报以 followup 进入该群会话，回复走既有出站链路；`/日报` 查看状态、`/日报 on|off` 切换（仅管理员）
- **重复提醒**（`recurringReminderEnabled` 默认开）：`每天8点提醒我喝水`、`每周一9点开会`、`每个工作日15点打卡`——到点自动重排下一次；`/reminders` 会标注周期（`每天 08:00` / `每周一 09:00` / `每个工作日 15:00`），跨宿主重启保留
- **MC 服务器状态**（`mcStatusEnabled` 默认开，新模块 `lib/mcping.js`）：`/mc mc.example.com:25565` 走 Java 版 Server List Ping（纯 `node:net`，零依赖零 Key），显示在线人数/上限、版本、延迟与 MOTD；离线给出中文原因
- `/help` 按开关动态展示新命令
- 新增测试：`test/insight-unit.mjs`（19，统计/荣誉/公告/精华/MC/日报全链路）、`test/stats-unit.mjs`（28，统计存储、榜单、荣誉文案、日报目标选择）、`test/reminder-unit.mjs` 扩充到 32 项（重复提醒解析与下一次触发时间）
- **最终自检三件套（同日补）**：
  - `test/static-unit.mjs`（14）：静态交叉检查——lib 全部 UTF-8 合法、代码读取的每个 `config.*` 都在 schema 里、schema 没有死键（139 个键全部有人用）、`QQBridge` 无重复方法名（115 个）、所有具名 import 都能找到导出、README 中英文均为滚动五版且首版==package.json 版本
  - `test/commands-unit.mjs`（72）：用 mock DSH 上下文（假 agents 服务记录 followup/系统提示段/注册的工具，并模拟 assistant 回复）把**每条命令分支与每个会话工具**都跑一遍：会话创建与工具注册、agent 回发、`/summary /export /撤回 /new`、待办/投票/`/mute /unmute /kick+确认`/`/clear`、群管全套、戳一戳/入群欢迎/防撤回（含图片补发）、入群审批流、`qq_send_file`（上传 + 3 类拒绝路径）/`qq_send_image`/`qq_recall`、resume 成功与失败两条路径、签到/重复提醒/词库/小游戏/运势/骰子/统计/MC，以及 `stop()` 幂等
  - `test/live-e2e.mjs`（6）：**真宿主端到端**——拉起真实 `dsh web` 宿主，假 OneBot 客户端连 6700 验证 `/status`、本地运势、**真 agent 回合**（验证 `defineTool` schema 被宿主接受、`agents.create`、session 事件回发）、同一会话连续对话，以及只读命令在"返回结构异常"的假 OneBot 端下不崩；重启宿主后确认日志出现 `session resumed qq-…`（v0.3.6 会话续接在真实宿主生效）

## v0.3.8（2026-09-11）

**防撤回 + 入群验证 + 敏感词/刷屏 + 群管 API 补齐**

- **防撤回**（`antiRecallEnabled` **默认关闭**，新模块 `lib/recall.js`）：每条入站消息缓存一份（含图片 URL），收到 `group_recall` / `friend_recall` notice 时把内容补发出来
  - `antiRecallInGroup`（默认 true）= 补发到群里；设 false 则私聊推送给第一个管理员
  - `antiRecallImages` 补发被撤回的图片（最多 3 张）、`antiRecallCacheSize` 每会话缓存条数、`antiRecallMaxAgeMinutes` 可恢复时长、`antiRecallCooldownSeconds` 防刷屏
  - 机器人自己撤回的消息不补发；未缓存的消息静默忽略
- **入群/加好友验证**（`verifyEnabled` **默认关闭**，新模块 `lib/verify.js`）：请求进入待审队列并**私聊推送管理员**（含验证题与序号），默认不自动放行
  - 管理员命令：`/待审` 列表、`/同意 <序号>`、`/拒绝 <序号>`、`/同意 all`
  - `verifyKeyword` 口令命中时自动放行；申请人若在验证期私聊答对算术题也会自动放行（`#allowed` 对该申请者临时放行，无需加入白名单）
  - `verifyTimeoutSeconds` 超时后自动出队并提醒管理员（60 秒一次的后台清扫，timer 已 unref）
- **敏感词过滤**（`filterEnabled` **默认关闭**，新模块 `lib/filter.js`）：词表文件 `cwd/qq-badwords.txt`（`#` 注释、`re:` 正则、非法正则安全跳过、按 mtime 热重载），`filterAction: warn|recall|mute` 三种处置（撤回走 `delete_msg`、禁言走 `set_group_ban`），`filterWhitelist` 白名单优先，管理员豁免
- **刷屏防护**（`floodEnabled` **默认关闭**）：滑动窗口（`floodWindowSeconds`/`floodMaxMessages`）先警告、累计 `floodStrikeLimit` 次后禁言 `floodMuteSeconds`
- **群管 API 补齐**（管理员，`adminEnabled`）：`/公告 <内容>`（`_send_group_notice`）、`/精华` 与 `/取消精华`（引用消息，`set_essence_msg`/`delete_essence_msg`）、`/名片 @某人 名字`（`set_group_card`）、`/头衔 @某人 头衔`（`set_group_special_title`）、`/全员禁言` 与 `/解除全员禁言`（`set_group_whole_ban`）
- **`/mute` `/unmute` 等既有群管命令也纳入写操作闸门**（限频 + 审计），不再直接调用 OneBot
- 新增测试：`test/guards-unit.mjs`（12，防撤回/敏感词/刷屏全链路）、`test/verify-flow-unit.mjs`（15，请求队列/口令/答题/好友请求/队列上限）、`test/verify-unit.mjs`（45，队列与命令解析）、`test/stats-unit.mjs`（23，群活跃统计与荣誉文案，为 v0.3.9 打底）；`test/reminders.js` 增加重复提醒解析

## v0.3.7（2026-09-11）

**零成本互动包（纯本地计算，不消耗模型）**

- **关键词问答库**（`keywordEnabled` **默认关闭**，新模块 `lib/keywords.js`）：本地 JSON 词库 `cwd/qq-keywords.json` 命中即回，**不走模型、秒回、零 token**；支持 `exact/contains/regex` 三种匹配（优先级 exact > contains > regex，同级别长词优先）、随机多答、附带图片（http 链接自动落盘 / 本地路径）、`scope: all|group|private` 作用域、每条独立冷却、`/` 开头的命令不参与匹配；文件被手工编辑后按 mtime 自动重载；管理员用 `/kw add 触发词 回复内容`、`/kw del 触发词`、`/kw list` 维护（写入会话级词条）
- **今日人品 / 运势 / 抽签 / 塔罗**（`fortuneEnabled` 默认开）：按「QQ 号 + 日期」哈希的**确定性**结果（同一天同一人永远一致），11 档运势评语 + 12 支签 + 22 张大阿卡纳正逆位解读，全部本地（新模块 `lib/fortune.js`）
- **骰子与随机选择**（`diceEnabled` 默认开）：`.r 3d6`、`掷骰 2d6+1`、`d100`、`/抽一个 火锅 烧烤 面条`、`/随机 A、B、C`（新模块 `lib/dice.js`，含 100 骰/1000 面上限保护）
- **积分经济**（`pointsEnabled` **默认关闭**，新模块 `lib/points.js`）：发言得积分（`pointsPerMessage`，每日封顶 `pointsDailyCap`）、签到奖励（`pointsCheckinBonus`）、`/积分` 查余额、`/排行榜` 看排行、`/转账 @某人 数量` 转账（余额不足/非法金额/转给自己都有明确中文报错）；每会话一个原子写 JSON
- **群内小游戏**（`gameEnabled` **默认关闭**，新模块 `lib/games.js`）：
  - **成语接龙**：内置 **373 条真实四字成语**词库，标准接龙规则（接上一句末字）、同音不同字不算、已用过的不能再用、超时（`idiomChainTimeoutSeconds`）自动收局；进行中的一句直接吃下群消息，**免 @** 让群友顺畅接龙
  - **猜数字**：1-`guessNumberMax` 随机答案，`guessNumberMaxTries` 次机会，大小提示与次数统计
- **帮助菜单**：`/help` 按开关动态列出新命令；词库管理只对管理员显示
- **修复两个既有缺陷**：
  - `QQBridge#stop()` 把 EventEmitter 当 disposer 存进 `disposers`，卸载插件时抛 `dispose is not a function`（现在通过 `#onServer()` 包装成真正的退订函数）
  - `IdiomChain` 的判定原本要求「首字 = 上一句**首字**」（非标准接龙），已改为标准规则「首字 = 上一句**末字**」
- 新增测试：`test/features-unit.mjs`（23，用 mock OneBot 服务器驱动真实 `QQBridge` 验证词库/运势/骰子/积分/接龙/猜数字/私聊关键词/`/撤回` 全链路），`test/games-unit.mjs` 按标准接龙规则重写关键用例

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
