# 更新日志 / Changelog

## v0.5.2（2026-09-14 发布）— 无人值守 / Unattended

> 本版主题：**无人值守**。三件事——外部事件能主动进群、定时内容自己发、掉线了自己爬起来。全部默认关闭，写操作与出站一律走既有的闸门/限流/trace 体系。

### 入站 webhook（`webhookEnabled`，默认关）

- 独立 HTTP 端点（默认只绑 `127.0.0.1:8798`），`POST /hook/<来源名>` → 渲染成一条 QQ 消息发到配置的会话
- 三种 `format` 适配器：`github`（push / pull_request / issues / issue_comment / workflow_run 含 CI 成功失败 / release）、`uptime-kuma`（心跳 0 宕机 / 1 恢复 / 2 待定 / 3 维护）、`generic`（任意 JSON + `{a.b.c}` 占位符模板，取不到值填 `（无）`）
- **鉴权必须二选一**：`token`（`X-Webhook-Token` 头或 `?token=`）或 `secret`（GitHub 风格 `X-Hub-Signature-256` 对**原始请求体**做 HMAC-SHA256）；比较全部走 `crypto.timingSafeEqual`（长度不等先各自 SHA-256 到等长，不会抛错）。**既无 token 也无 secret 的来源在构造时直接剔除且不注册路由**——不存在未鉴权的开放端点
- 体积上限 `webhookMaxBodyBytes`（默认 64 KiB）：超限回 **413**，并且是先回状态码再 `request.resume()` 排水、`socket.end()` 优雅关闭（初版用 `socket.destroy()` 是 abortive close，客户端只看到 `fetch failed` 拿不到 413 —— 这条是实测才暴露的）
- 每来源滑动一分钟限频 `webhookRatePerMinute`（默认 30），超限 **429**；`status()` 暴露每个来源的 `received` / `dropped` / `lastAt`（只暴露名字与计数，**不含 token/secret**）
- 每次事件都写 trace：收到、渲染失败、发送被拦（限流或注入回合）都有中文 reason

### 定时播报（`broadcastEnabled` + `broadcastJobs`，默认关）

- 三种任务：`rss`（自带 RSS 2.0 / Atom / RDF 解析器，**零第三方依赖**；按 guid/link 去重，跨宿主重启不重复；支持 `keyword` 过滤与 `maxItems`）、`weather`（Open-Meteo，免费无 key；WMO 天气码译成中文 + emoji）、`mc`（复用既有 Server List Ping）
- 排期两种写法：`at: "HH:MM"`（可配 `weekdays`，0=周日，最多向后找 8 天）或 `everyMinutes`（下限 5，优先于 `at`）；定时器延迟夹取到 `[0, 2^31-1]`，间隔类按"上次计划时间 + 间隔"递推，**执行耗时不会让排期漂移**
- 去重与统计（`seen` / `lastAt` / `lastReason` / `runs` / `failures`）落盘 `qq-broadcast.json`，`stop()` 时保存、启动时恢复
- 失败必留中文 `lastReason` 且**不发送空消息**；`/播报` 列任务与下次时间、webhook 状态与收/丢计数，`/播报 测试 <任务 id>` 立即触发一次（管理员）

### 掉线自愈（`autoHealEnabled` + `autoHealCommand`，默认关）

- QQ 客户端断开时按配置命令把它拉起来：**只启动、绝不杀进程**（杀进程仍归控制台，那边有专门护栏），`detached + shell + stdio:'ignore' + unref`，不阻塞宿主也不连坐子进程
- 冷却 `autoHealCooldownSeconds`（默认 300s）+ 每小时上限 `autoHealMaxPerHour`（默认 3）；**命中冷却或上限都会写 trace 说明原因**，不静默；`autoHealEnabled=true` 却没配命令也照样留 reason
- 与既有 `notifyEnabled` 出站告警互补：告警负责"告诉你掉了"，自愈负责"拉回来"

### 新增配置键（默认值）

`webhookEnabled`(false) `webhookPort`(8798) `webhookSources`([]) `webhookRatePerMinute`(30) `webhookMaxBodyBytes`(65536) `broadcastEnabled`(false) `broadcastJobs`([]) `broadcastStateFile`("") `autoHealEnabled`(false) `autoHealCommand`("") `autoHealCooldownSeconds`(300) `autoHealMaxPerHour`(3) —— 配置键总数 175 → **187**，`test/static-unit.mjs` 的双向校验（schema ↔ 代码读取）全部通过。

### 测试

- 新增 4 套：`feed-unit`（144，RSS/Atom/RDF、CDATA、实体、时间解析、截断）、`webhook-unit`（114，含真实 HTTP 往返：鉴权/413/429/405/400/500 与 status 计数）、`broadcast-unit`（189，假 timers 推进到点触发、间隔不漂移、去重、快照往返）、`unattended-unit`（桥层：webhook 真发到群、`/播报` 管理、自愈冷却与上限、**注入回合 0 出站**）
- 全量 **49 套 / 2860 断言全绿**（v0.5.1 为 45 套 / 2306）
- 过程中由测试逼出的真 bug 随手修掉：`formatFeedItems` 的 `limit` 参数算了没用、feed 标题张冠李戴（channel 无 title 时取了第一条 item 的标题）、`stripHtml` 先解实体再删标签导致 `&lt;大新闻&gt;` 被吃掉、CDATA 整段被标签正则吞掉、413 因 abortive close 拿不到状态码、`renderWebhook` 遇 BigInt 序列化抛错

## v0.5.1（2026-09-13 发布）— 审查修复 / Audit fixes

> 本版是 v0.5.0 的补丁：发布后做了一轮**对抗性审查 + 隐私审计**，抓出并修掉 8 个缺陷（3 个 P1、5 个 P2）。没有新功能。

### 修复

- **`/成员 <昵称>` 对没设群名片的成员永远查不到**（P1）：`String(item?.card ?? item?.nickname ?? '')` 在 `card: ''` 时得到空串，`''.includes('小红')` 恒为 false——而"成员没设群名片"是默认形态。改为"去空白后回落到昵称"（与 `lib/members.js` 的显示名规则同源）
- **转发卡片展开为空时仍起一个空模型回合**（P1）：`forwardExpandEnabled=false`、`get_forward_msg` 返回空、或调用失败这三种情况下，`hasForwards` 豁免让流程继续走到 agent，模型收到一个**内容为空的 user turn**（白烧 token，还可能在群里自说自话）。现在在 handoff 前复查 `effectiveText`，为空则 drop 并写明"转发卡片展开后没有可读内容"
- **`/ocr` 与 `/好友` 在注入/回放回合仍会真的访问 QQ**（P1/P2）：`get_msg`（解析引用图）与 `get_friend_list` 的参数都不带 `group_id`/`user_id`，落不进作用域 dry-run 的拦截条件。`/ocr` 的离线判断原本放在 `get_msg` **之后**（等于没拦），现已提到函数第一行；`/好友` 补上同样的显式判断
- **`/读图` 被 `/读` 语音朗读整条吃掉**（P2）：`/^\/读\s*(.*)$/` 匹配了 `/读图`，于是发出一条朗读"图"字的语音并消耗 TTS，OCR 别名形同虚设。朗读命令改为要求空白分隔，并显式排除 OCR 别名
- **归档写入失败完全静默**（P2）：`HistoryArchive.append()` 吞异常只返回 `false`，调用方丢弃了返回值；磁盘满/目录不可写时历史会静默丢失，`/找` 还会回答"最近 N 天没找到"。现在失败写一条 `stage:'archive'` 的 error 事件（同一故障只报一次，恢复后重新计数）
- **控制台「群资产」读错配置键**（P2）：面板读的是 `historyDir`——这个键在插件 schema 里根本不存在（插件用 `historyArchiveDir`），自定义归档目录时面板永远显示"0 个文件 / 没找到"却不报错。已改为同一键名，并新增 `exists` 标记与"目录还不存在"提示
- **`/取` 的两处隐私/资源问题**（P2）：私聊投递失败时会把**本机绝对路径**发进群里（泄露部署者的用户名与目录结构），现在只回文件名、完整路径仅进本机日志；`qq-files/` 也纳入保留期清理（原文：只清 `qq-images`/`qq-replies`，下载目录永不清理）。另外投递注定被闸门拒时不再先下载（50 MiB 上限 × 反复 `/取` 可以撑满磁盘）
- 细节：单条消息最多展开 3 张转发卡片时，trace 现在会说明"另有 N 张卡片未展开"（原先静默丢弃）；`groupFileListLimit` 的说明补上"同时也限制 `/相册` 显示条数"（实际行为如此，原文只写群文件）

### 测试

- 新增 `test/inject-assets-unit.mjs`（28 条）：起**真实** OneBotServer + 真 WebSocket 客户端，走**真实注入通道**，逐条验证 7 个新命令"注入回合 0 出站帧 + 回复理由诚实"，并用正对照证明 6 个出站动作在非 dry-run 下**确实**发出（没有正对照，A 段就是空测试）
- `seeing-unit` 71→86、`find-unit` 59→72：把上述 5 个修复逐个钉住；并做了**反向验证**（把 `lib/bridge.js` 换回修复前版本，新断言各挂 8 条），确认不是恒真断言
- `privacy-unit` 32→33：新增"文件名里也不能有真实 QQ 号"，并修掉它自己的一个假阳性——`.gitignore` 匹配器把目录规则 `qq-*/` 去掉末尾斜杠后当文件规则用，导致 `qq-badwords.txt`（插件会写出的敏感词表）被误判为"已忽略"。同时补齐跨行 YAML 列表的私有号采集
- `.gitignore` 补上 `qq-*.txt`（`qq-badwords.txt` 原文未被任何规则覆盖：`.json/.jsonl/.log` 命中、`.txt` 全都不命中）

## v0.5.0（2026-09-13 发布）— 看得见 · 找得回 / See it, find it

> 本版主题：**看得见 · 找得回**。一半是把"已经封装好、却从没接上线"的能力接通（合并转发、群成员、群资料、群历史、表情回应），一半是补上"群里的东西能找回来"（群文件、相册、OCR、历史检索 + 按天归档）。同时修掉一个**违反 v0.4 第一条硬约束**的洞：合并转发卡片此前在传输层被静默丢弃。

### 合并转发展开（先修洞，再加功能）

- **问题**：`parseMessage` 只认 text/at/reply/record/image/file，没有 `forward` 分支；于是"只发一张聊天记录卡片"的消息在 `#onFrame` 就因"text/records/images/files 全空"被 `return` 掉——**不产生 message 事件、trace 里连一条记录都没有**。而 `get_forward_msg` 的封装注释一直写着"used to expand recalled cards"，这条路径从没接上
- 现在：`parseMessage` 识别 `[CQ:forward]` 与数组形式的 `forward` 段；`#onFrame` 不再因此早退；桥内新增 `#expandForwards`，用 `get_forward_msg` 取节点并交给新的纯模块 `lib/forward.js` 规范化 + 排版成 `[转发聊天记录] 昵称: 内容`（默认最多 50 条 / 4000 字，只展开一层不递归，`forwardExpandEnabled` 可关）
- **同时修掉一个自引入的门控逃逸**：空文本分支原本让 `else if` 链整体跳过，于是"群里没 @ 机器人的转发卡片"会绕过 @ 门（也绕过私聊的 `acceptPrivate` 门）——白调一次 OneBot、白跑一个模型回合。现在空文本路径自己过这两道门并写 reason（由桥层测试 `seeing-unit` 抓出）
- 回放/注入（dry-run）不访问 QQ：注入可直接带 `forwardText` 喂一份正文；录制白名单新增 `forwards` / `forwardText`，注入规格新增 `forwards` / `forwardText`

### 接通既有能力（封装早就在，只是没人调用）

- `/成员` 列群成员（身份/等级/头衔/禁言中排序）、`/成员 @某人|昵称|QQ号` 看详情（入群时间/最后发言/禁言状态）；agent 工具 `qq_member_info`（群聊专用）
- `/群信息`（群名/群号/人数上限/群主/建群时间）
- `/好友`（**默认关闭**，隐私项，仅私聊里的管理员可用）
- agent 工具 `qq_recent_history`：拉本会话最近 N 条消息（`get_group_msg_history` / NapCat `get_friend_msg_history`），纯逻辑交给新模块 `lib/history.js`
- agent 工具 `qq_react`：给消息贴表情回应（`set_msg_emoji_like`）而不是发一条消息，写操作过闸门；默认作用于本回合收到的消息
- `/退群 确认`（**默认关闭**，必须显式二次确认，走闸门；`DEFAULT_ACTION_LIMITS` 新增 `set_group_leave` 限额）

### 群资产

- `/文件`、`/文件 <文件夹名>`：列群文件与文件夹（`get_group_root_files` / `get_group_files_by_folder`）
- `/取 <文件名>`：`get_group_file_url` 取链后下载到 `cwd/qq-files/`，**只发到发起人私聊**（群里只留一句提示，不往群里丢文件）；精确/前缀/模糊匹配，文件名经 `sanitizeDownloadName` 消毒（去路径、去 Windows 非法字符、保留名加前缀、120 字上限保留扩展名）
- `/相册`：列群相册（NapCat `get_qun_album_list`）
- `/ocr`：对本条或引用的图片调用 NapCat `ocr_image` 读出文字（不消耗模型）
- 排版与匹配逻辑集中在新的纯模块 `lib/assets.js`

### 历史归档与检索

- 每条白名单会话的真实消息按天归档到 `cwd/qq-history/YYYY-MM-DD.jsonl`（新模块 `lib/archive.js`，用记录自身的 `ts` 算本地日期，避免东八区凌晨落错分片）；**注入/回放的假事件不入档**，`/` 开头的命令也不入档
- `/找 关键词`：大小写不敏感、空格分隔多词为 AND、只搜当前会话、可配天数与条数；agent 工具 `qq_search_history` 同源同口径
- 保留期默认 90 天，过期分片在宿主启动时**移入** `qq-trash/<日期>/`（`prune` 只移不删，与图片清理同一套"never destroy"约定）
- 控制台新增「群资产 · 历史检索」卡片与 `GET /api/archive`（无 `q` 返回概览、带 `q` 走检索，复用插件同一套解析），`control-unit` 增加真实 HTTP 往返断言

### 修复（本版自测抓出的 6 个真缺陷）

1. **门控逃逸**：空文本 + 转发卡片绕过 @ 门与 `acceptPrivate` 门（`seeing-unit` 抓出）
2. `/文件`、`/文件 <文件夹>`、`/相册` 把格式化函数的**返回对象**直接插进模板串，群里看到的是 `[object Object]`（`find-unit` 抓出）
3. `/找` 无参数：正则要求命令后至少一个字符，导致"用法"提示是死代码、命令落到模型路径（`find-unit` 抓出）
4. 归档把 `/` 命令也写进去：每次 `/找 X` 都会命中自己刚敲的查询词，"没找到"永远不可达（`find-unit` 抓出）
5. 启动 prune 的回收目录日期套了两层（外层还是 UTC 日期，与内层本地日期错位）（`find-unit` 抓出）
6. **前缀撞车**：`/取` 把既有的 `/取消精华` 吃掉（`commands-unit` 抓出，与历史 `/vote-end` 同一类坑）；`/文件` 同样收紧为"必须空白分隔"

### 验证

- 单测 44 套 / 2247 断言全绿（新增 `forward-unit` 111、`members-unit` 104、`history-unit` 81、`archive-unit` 86、`assets-unit` 132、桥层 `seeing-unit` 71、桥层 `find-unit` 59，`control-unit` 95→99）
- 真机（宿主 3080 / 控制台 8799）：注入带 `forwardText` 的转发帧 → trace 出现 `forward` 阶段成功事件、模型回合收到完整两条记录；`/成员`、`/群信息`、`/找`、`/文件`、`/相册`、`/ocr` 六条新命令在真机分发正确；`/api/archive` 概览与检索均返回真实数据；UI 新卡片渲染正常

## v0.4.1（2026-09-13 发布）— 依赖解析与安装修复 / Dependency resolution & install fixes

> 本版修社区反馈的安装问题（[issue #1](https://github.com/cheesehaqi/dsh-qq-onebot-bridge/issues/1)）：干净环境下插件加载即 `ERR_MODULE_NOT_FOUND: Cannot find package 'schemastery'`，连带把成因相同的安装/声明问题一起收口。

### 修复

- **`schemastery` 改用作用域名 `@deepseek-ai/schemastery`**：`lib/index.js`、`lib/bridge.js` 原本写的是裸名 `import z from 'schemastery'`，而 `package.json` 只声明了 `@deepseek-ai/schemastery`——**裸名是另一个包**（未带作用域的 `schemastery@3.18.0`，官方为 `@deepseek-ai/schemastery@3.18.1`），只有在"同 profile 里别的插件恰好把它 hoist 到共享 node_modules"时才解析得到（本机就是被 `dsh-mnemon` 的依赖 hoist 兜住的）。DSH 并没有"裸名别名注入"机制，官方包全部使用作用域名；干净环境必然加载失败
- **peer 版本区间补上 `^0.1.5-rc.1`**：预发布区间不会跨补丁线，`^0.1.2-rc.1` 不匹配 `0.1.5-rc.1` / `0.1.5-rc.2`，在 DSH 0.1.5-rc.1 上会出现 peer 解析问题（`--omit=peer` 能绕过，但根因在声明）
- **静态回归防线**（`test/static-unit.mjs` 新增三项）：lib/ 里每个第三方 import 必须在 `package.json` 的 dependencies/peerDependencies/optionalDependencies 中声明；官方依赖禁止退化成裸名（`@deepseek-ai/x` 的 basename 不得作为 import 规格名出现）；并校验规格名扫描确实抓到官方依赖，避免正则失效导致假通过。这类"在我机器上能跑"的依赖问题以后直接测挂
- **文档纠错与补全**：README 中"裸名 `schemastery` 由 DSH 以别名注入"的说法**是错的**，已删除并改写为正确的部署事实；同时补充本地目录安装说明——`dsh plugin add <目录>` 走 pnpm 的 `link:`，不会安装被链接包自己的依赖，需先在插件目录执行 `npm install --omit=dev`（`ws`），从插件市场安装则会随依赖一起装好

### 验证

- 干净环境复现与回归：无 hoist 裸包的沙箱里，修复前 `ERR_MODULE_NOT_FOUND: Cannot find package 'schemastery' imported from lib/index.js`；修复后插件入口正常加载（152 个配置键）
- 37 套单测 / 1596 断言全绿（新增 3 项静态防线）；本机 `node_modules` 里手工建的"裸名→作用域名"别名 junction 已移除，本地解析口径与干净环境一致，避免再次掩盖同类问题

## v0.4.0（2026-09-12 发布）— 一切皆可调试 / Everything Debuggable

> 本版主题：**一切皆可调试**。出问题时不用猜——每条消息都有 traceId，每个"没回复"都有原因，任何一条历史消息都能离线重跑，假事件能喂进真实管线，而且这 6 条约束在控制台里随时可验收（阶段 1→4：可观测地基 → 控制台调试层 → 录制/回放/注入 → 硬约束验收台）。

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
