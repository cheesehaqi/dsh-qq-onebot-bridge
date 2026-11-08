# dsh-qq-onebot-bridge 交接（2026-11-09，v0.8.7）

> 给新会话用：粘在第一条消息里，或让新会话读这个文件。

## 一、仓库状态

```
路径    工作区根下的 dsh-qq-onebot-bridge（不进仓库的绝对路径，按你本机实际位置）
分支    main
HEAD    v0.8.7 发布提交（用 `git log -1` 看实际哈希）
版本    0.8.7（tag：v0.8.0 … v0.8.7 都在）
本次发布  「控制台 Ctrl+K 命令面板」：改 control/ui.html（面板 + 快捷键），test/console-layout-unit.mjs 25 → 40 条；
        「语音调试并入控制台」：ui.html 的语音分组 + iframe 懒加载 `/voice?embed=1`，voice.html 支持 embed 模式；
        顺手修 test/settings-history-unit.mjs 里的真实绝对路径（privacy 会扫已跟踪文件）；
已发布  「一键体检报告」：control/lib/report.mjs、control/report.html、test/report-unit.mjs；
        「设置项变更历史」：control/lib/history.mjs、test/settings-history-unit.mjs；
        「语音调试」：lib/voice.js、lib/voice-routes.js、control/voice.html、test/voice-unit.mjs；
        「调试台布局重构」：改 control/ui.html（左侧六组导航 + 卡片 data-tab），新增 test/console-layout-unit.mjs；
        改了 lib/settings-routes.js（挂 3 条宿主路由）、lib/tts.js（注入 fetchImpl）；
        前两项改了 control/lib/{server,supervisor}.mjs、control/bin/qq-control.mjs、control/ui.html；
        三者都改了 docs/DEBUG*.md、README*.md、CHANGELOG.md、docs/HANDOFF.md
```

**关键事实**：`lib/` 自 v0.8.6 起**新增**了语音调试相关文件（`voice.js` / `voice-routes.js`，并在 `settings-routes.js`、`tts.js` 里各加了一小段）；
`lib/bridge.js`、`lib/index.js`（551123 的补丁面）**仍未改动**；`lib/panel.js` 只在 `upsertPatchValue`（833 行之后）加了可选参数 `allowString`，**217–247 的锚点未变**。

## 二、这台机器上的验证口径（每次改完都跑）

```
node tools/audit.mjs            # 6 项结构体检，退出码 0/1（46 路由全部有测试提到）
逐套跑 test/*-unit.mjs          # 当前 78 套 / 4744 断言 / 0 失败
```

`tools/audit.mjs` 现在查：① 语法 ② 页面元素时序（`$('id')` 必须出现在 `<script>` 之前，动态白名单 6 个）
②b 页面脚本没有同名函数重复声明（同一个 `<script>` 里后者会**静默覆盖**前者 —— 2026-11-08 真踩过：新加的 `loadHistory` 顶掉了事件流历史的加载器）
③ 前端 `/api` 调用都有实现 ④ 每个路由至少在 `test/` 里出现 ⑤ 关键文件行数下限 ⑥ 打包形态（`scripts` 引用的文件必须在 `package.json` 的 `files` 里）。

## 三、给别人（551123）的承诺与事实

- 他的补丁面是 `lib/bridge.js`、`lib/index.js`、`lib/panel.js`，加 `control/lib/server.mjs`、`control/lib/supervisor.mjs`、`control/ui.html`、`control/lib/config.mjs`、`package.json` 的 `files`；
- **0.8.4 的补丁面行号（0.8.5、0.8.6 均未变）**：
  ```
  lib/bridge.js   323 → 323,3；3180 → 3182；3652 → 3654
                  allowUsersPrivateOnly 出现在 323/325、3182、3654
  lib/index.js    70,0 → 71
  lib/panel.js    217,2｜221｜231｜234,3 → 234,6｜240 → 243｜244 → 247
  ```
- 他在 #5 帖里跟进；回信由用户本人发（"以后回信让我来"）；
- 他两条实测结论（对设计有参考）：trace.moe 的 `top1−top2 gap` 不能当"出处已确定"门槛（真命中 0.0029/0.0003）；Lens 的 `exact` 段可能为空（要拉 `type=all` 自己分段）。

## 四、节制

- **发版动作**（bump / tag / push release / 打包）必须先说明再动；日常代码改动直接做；
- 删除一律走工作区的 `scripts/safe-delete.ps1`（回收站优先，绝不裸删）；
- 改非 ASCII 文件只能用 read/edit/write 或 Node 的 `readFileSync`/`writeFileSync`（**不要**用 PowerShell 的 `Get-Content`/`Set-Content`）；
- 写补丁脚本时别在模板字符串里嵌反引号（踩过 2 次：`qq-release-085.mjs`、`qq-audit-pack-check.mjs` 都是 `SyntaxError`），复杂替换直接用 `edit` 工具；
- PowerShell 里 `node -e` 带中文/引号/反斜杠会被拆坏（踩过多次：`Expected unicode escape`、`Unterminated regexp`）——改成写临时 `.mjs` 再用 `node` 跑；
- 对外文字里的每个数字都要先用命令核（踩过：把"1 条 POST 动作"写成"3 条路由"；更早还有"新增 7 套测试"实为 6 套、"assistantText 覆盖对象与空数组"实际不覆盖）。

## 五、未提交的新功能（2026-11-08）

5.1 / 5.2 没动 `lib/`；5.3（语音调试）为了拿到宿主里的 `speechToText` 服务，新增了 `lib/voice.js`、`lib/voice-routes.js`
并在 `lib/settings-routes.js` / `lib/tts.js` 里各加了一小段 —— **`lib/bridge.js`、`lib/index.js` 仍未动**；`lib/panel.js` 仅新增可选 `allowString`（锚点 217–247 未变）。

### 5.1 一键体检报告

- 接口：`GET /api/report[?fresh=1]`（token + Origin 同其它接口；`fresh=1` 绕过体检的 5 秒缓存）。
  supervisor 新增 `healthReport({ force })`：**一次**体检 + **一次**验收（复用同一份体检，不重复扫 netstat/tasklist）。
- 页面：`/report`（`control/report.html`，独立同源本地页，和 `/accounts` 同一套 token 透传）。
  只读、零外部依赖、可打印成 PDF、可一键复制整段文本；结论优先级 **阻断 > 告警 > 证据不足 > 全绿**。
- 纯函数：`control/lib/report.mjs`（分组表、结论、先修列表、关键事实、文本视图），页面只负责画。
- 控制台入口：`ui.html` 右上角「体检报告」（`.reportLink` 自动带 token）＋ 一键体检卡里的「完整报告 →」；
  报告页的「去看 →」用 `/?token=…&focus=<id>` 深链回控制台，`focusCard(id, false)` 滚整张卡片并高亮
  （CSS `scroll-margin-top:100px` 避开吸顶标题；1.2s / 3.2s 各校一次，因为事件流是异步加载的）。
- 测试：`test/report-unit.mjs`（85 条）覆盖纯函数分支、真实 supervisor 合成、HTTP 往返与门禁、页面静态校验。

### 5.2 设置项变更历史

- 纯函数：`control/lib/history.mjs` —— 设置对象扁平化（数组按下标）、old→new diff（新增/删除/修改）、
  `token/secret/password/apiKey` 类键永不落盘（只记 `***` 并标 `secret`）、超长值截断、关键词过滤、文本视图。
- 接口：`GET /api/history?limit&q`；supervisor 新增 `settingsSnapshot()` / `recordSettingsChange()` / `settingsHistory()`。
- 记录点：server 的 POST 分发里对**写设置的接口**（`/api/config`、`/api/accounts/config`、`/api/accounts/network*`）
  前后各拍一次设置文件快照 → diff；启动/停止/回放/注入等"操作"不记（那是事件流与审计日志的事）。
  盯文件而不是盯接口参数：接口会加会改，文件不会。
- 存储：`<控制台启动时的工作目录>/qq-settings-history.jsonl`（位置启动钉死，避免"改 cwd 导致历史搬家"；
  256 KB 封顶、超了只留尾部 64 KB）。
- 页面：控制台「设置项变更历史」卡（关键词即时过滤、复制文本、30 秒自动刷新），只读、不提供还原。
- 测试：`test/settings-history-unit.mjs`（68 条）—— 含"历史文件里不得出现明文 token"的断言。
- **顺手修掉的真问题**：`--port` 只该对本次运行生效，但以前在界面上保存任意设置都会把临时端口写进
  `qq-control.json`（之后双击 bat 端口冲突）。现在写盘时用启动时文件里的端口，除非这次保存明确改了它。

### 5.3 语音调试（TTS / STT）

老功能回访：语音模块以前只能靠"给机器人发语音 / 开语音回复"间接验证。这次给它一个**单独的调试入口**。

- **宿主侧**（唯一真正能碰到语音服务的地方）：新增 `lib/voice.js`（判定 + 试合成/试转写的纯逻辑）与
  `lib/voice-routes.js`（`GET /qqai/voice/status`、`POST /qqai/voice/tts`、`POST /qqai/voice/stt`），
  在 `lib/settings-routes.js` 的 `mountQqAiPanel` 里挂载/注销；`lib/tts.js` 的 `synthesizeTts` 新增可注入的 `fetchImpl`。
  同源 + `application/json` + 体积门禁（TTS 64 KB / STT 10 MB），**不发 QQ**。
- **控制台**：supervisor 找宿主有两步 —— ① `qq-host-out.log` 里带 token 的地址（控制台启动的宿主）；
  ② 找不到就从本机监听端口里认出 DSH 宿主（桌面端自己起的宿主端口随机；插件路由不要 token）。
  新增 `GET /api/voice/status`、`POST /api/voice/tts`、`POST /api/voice/stt`；STT 请求体单独放宽到 9 MB（其它接口仍 64 KB）。
  找到旧版宿主（没有 `/qqai/voice/*`）时会明确提示"重启一次宿主"，不会糊成"连不上"。
- **语音调试是控制台里的一个分组**（`data-tab="voice"`，侧栏第七项）：点它只切 tab，内容 iframe 懒加载 `/voice?embed=1&token=…`（第一次切过去才发请求；`embed` 模式隐藏大标题与「回控制台」）。`/voice` 仍可直接打开（收藏/深链），页面代码没有复制进控制台。
  页面内容：状态 + 卡点、一句话试听（`<audio>`）、录音（MediaRecorder）或选文件（ffmpeg 转 16k WAV）后看转写结果；**细调**全部按次覆盖、不写回配置：
  Azure（音色 / 风格 / 语速% / 音调 st / 音量%）、OpenAI（音色 / 语速）、GPT-SoVITS（参考音频 / 参考文本 / 参考语言 /
  语速 / `temperature` / `top_k` / `top_p` / `repetition_penalty` / `seed`）、**通用音调**（±12 半音：Azure 走 prosody，
  其它 provider 走 `lib/audio-fx.js` 的内置变调 = 重采样 + WSOLA，本地 wav 不依赖 ffmpeg）、STT（语言：自动/中/英/日，默认自动、云端模型）。
  越界参数直接报错（不悄悄夹紧）；试听保留最近 5 条（带播放器与参数摘要）方便 A/B。
- 测试：`test/voice-unit.mjs`（128 条）、`test/tts-unit.mjs`（20 条）；`test/settings-unit.mjs` 的路由数断言 9 → 12（新增 3 条宿主路由）。
- **要重启宿主**：`/qqai/voice/*` 是新注册的宿主路由；热重载会复用 ESM 模块缓存（不会重新求值），
  所以旧宿主里没有这三条 —— 桌面端就是重启一次 DSH（用户机器上宿主是 DSH 桌面进程 8316，监听 62041+6700，
  控制台通过端口发现找到它）。
- **控制台自己也要重启**：`/voice` 页面路由与 `/api/voice/*` 都是进程启动时注册的代码，旧控制台进程里没有。
- 截图：`_screens/qq-voice-debug-2026-11-08.png`（截图用的是本机临时假宿主 18877，真链路的验证在单测里）。

### 5.4 调试台布局重构

- `control/ui.html`：左侧导航六个分组（总览 / 实时事件 / 诊断与报告 / 录制 · 回放 · 注入 / 数据与任务 / 日志），
  卡片用 `data-tab` 归组、`showTab()` 只切可见性（DOM / 轮询 / SSE 都不动，隐藏的卡片照常更新）；
  右上角只留四个全局动作（刷新 / 一键体检 / 导出诊断包 / 体检报告），**语音调试**移到左侧导航。
- `?tab=` 可深链；报告页「去看 →」的 `focusCard()` 会先切到目标分组再滚动。
- 测试：`test/console-layout-unit.mjs`（25 条）：六组齐全、15 张卡都有归属、关键元素/函数不丢、右上角动作不被挤走。

### 5.5 控制台 Ctrl+K 命令面板（v0.8.7）

- `control/ui.html`：`Ctrl+K`（⌘K）打开/关闭、`Esc` 关闭；输入过滤、↑↓ 选择、回车执行；
  条目分三类：**分组**（`showTab`）、**卡片**（`focusCard`，会自动切组再滚）、**动作**（刷新 / 一键体检 / 导出诊断包 / 打开体检报告 / 打开语音调试）；
- 面板默认隐藏，点击遮罩关闭，没有匹配项时明确显示；侧栏顶部有可见入口「🔍 搜索 / 跳转 Ctrl K」；
- 侧栏选中块 `#navGlow` 跟着当前分组滑动（`moveNavGlow()` 按 `offsetTop/offsetHeight` 对位；首屏不播动画，窄屏横排隐藏，`prefers-reduced-motion` 不做动画）；
- 测试：`test/console-layout-unit.mjs` 25 → **39 条**（元素/默认隐藏、五个函数、快捷键、条目覆盖、上下键/回车、复用 focusCard、侧栏可见入口与 kbd 提示、脚注说明、选中块对位/切组/首屏与窄屏、语音分组 iframe）。

### 5.6 语音调试并入控制台（v0.8.7）

- 侧栏「🎙️ 语音调试」由外链改为第七个分组（`data-tab="voice"`）；`showTab('voice')` 首次进入才给 iframe 设 `src=/voice?embed=1&token=…`（懒加载，不拖首屏）；
- `control/voice.html` 新增 `embed=1` 模式：隐藏大标题「语音调试 / 回控制台」，只留状态条与「刷新状态」，背景透明、边距收紧；
- `/voice` 路由保留（收藏/深链/直接打开）；页面代码没有复制进 `ui.html`；
- 状态 pill：TTS/STT 都关 → **未启用**，只关一个 → **部分未启用**（不再写「都没启用」）；
- 细调预设：`localStorage`（`qq-voice-presets-v1`，version 1）存命名预设，支持应用/删除/导入/导出；上次试听参数存 `qq-voice-tune-last-v1`，按 provider 匹配后刷新自动恢复；
- 试听可带走：每条记录可下载音频（`<a download>`，wav/mp3）、复制参数 JSON；最近记录可复制 Markdown 对比表；输入框 **Ctrl+Enter** 直接合成；
- 状态卡点**全部列出**（`blockerHints()` 遍历 `blockers[]`）；每 15 秒自动刷新 + `visibilitychange`/`focus` 立即刷新（改开关不用手点）；
- 页内语音开关与后端切换：「语音回复（TTS）」「语音转文字（STT）」+ TTS 后端（`azure/openai/local`）、STT 后端（`dsh/cloud`）→ `POST /api/voice/toggle` → 宿主 `/qqai/panel/set-batch`（校验 + 批量写 + 热重载），未知后端直接拒绝；改完 2–3 秒自动刷新；
- 测试：`voice-unit`（152 条，含预设/下载复制/全部卡点/自动刷新/页内开关、后端切换、服务配置与页内启停）、`console-layout-unit`（40 条，分组数/iframe/embed/体检趋势）。

### 5.7 启动语音服务修复（v0.8.7）

- 根因：`<工作目录>\GPT-SoVITS\TTS控制.bat` 是 **UTF-8 无 BOM**，`cmd` 按 GBK 解析中文行 → 一窗「'xxx' 不是内部或外部命令」，菜单起不来、9880 一直没有监听；
- `control/lib/supervisor.mjs` 的 `startTts()` 改为**优先直接拉** `GPT-SoVITS\.venv\Scripts\pythonw.exe api_v2.py -a 127.0.0.1 -p 9880`（日志 `qq-tts-out.log`/`qq-tts-err.log`），最多等 20 秒确认端口；没监听时返回“还在加载/看 err 日志”，不再盲报成功；找不到 venv/api 才回退启动脚本；
- **必须用 pythonw 而不是 python**：python.exe 在窗口被隐藏/关闭时会触发 Intel Fortran 的 `forrtl: error (200): program aborting due to window-CLOSE event` 直接中止（真机 03:33 复现，日志在 `qq-tts-err.log`）；pythonw 无控制台，实测 65 秒加载完并监听 9880；
- 测试：`control-unit`（182 条）新增「直接拉 api_v2.py」。
- 命名统一：控制台按钮/配置项/诊断项改为「语音服务（GPT-SoVITS）」，按钮简称「启动语音服务 / 停止语音服务」（TTS 后端可切，不能把 GPT-SoVITS 当整个语音模块）；面板「相关链接」的「调试台（独立控制台）」改为「控制台（独立进程）」（`lib/panel.js` 1093 行，锚点 217–247 未变）。
- 隐私加固：控制台启动日志 token 打码；诊断包脱敏覆盖 token / apiKey / Bearer / `sk-…`；`privacy-unit` 42 条、`control-unit` 183 条。

### 5.8 语音后端切换的写入白名单（v0.8.7）

- 现象：语音页切 `ttsProvider/sttProvider` 报「不在面板白名单里的键」——`panel/set(-batch)` 只放行面板行（开关），后端键不在里；
- 修复：`lib/settings-routes.js` 对 `ttsProvider` / `sttProvider` 单独放行并按枚举校验；`lib/panel.js` 的 `upsertPatchValue` 增加 `allowString`（默认关，只对这两把键放行），字符串写成带引号的 YAML；
- 同一套白名单也放行了**非密钥文本配置**（`ttsVoice / ttsModel / ttsBaseUrl / ttsLocalUrl / ttsLocalRefAudio / ttsLocalPromptText / sttModel / sttBaseUrl`，带长度上限）；密钥仍不放行；
- **宿主必须重启一次**：这两个文件是宿主侧代码，ESM 热重载不会重新求值；不重启时切后端仍会报同样的白名单错误；控制台侧不用重启；
- 锚点：`panel.js` 217–247 未变（新增代码在 833 行之后）；
- 测试：`settings-unit` 297 条（+4：后端键放行 / 非法值拒绝 / 文本配置写入 / 长度上限）、`voice-unit` 151 条。

### 5.9 体检趋势（v0.8.7）

- `control/lib/supervisor.mjs`：`diagnose()` 每次**真正扫一轮**（缓存命中不算）追加一行
  `qq-health-history.jsonl`（时间/结论/计数，`appendCappedLine` 256 KB 封顶）；`healthHistory({limit})` 倒序读回；
- `GET /api/health/history?limit=30`（token + Origin）；控制台「诊断与报告」新增「体检趋势」卡（30 秒自动刷新，显示失败数变化）；
- 测试：`report-unit` 87 条（+2）、`console-layout-unit` 40 条（+1）；路由总数 45 → 46。

### 5.10 语音「服务配置」编辑（v0.8.7）

- 语音页「语音模块状态」下新增 `details`：音色 / TTS 模型 / 本地服务地址 / 参考音频路径 / 参考文本 / STT 模型；
- 只提交填了值的字段（空 = 不改），走 `POST /api/voice/toggle` 的 `values` → 宿主 `/qqai/panel/set-batch`；**密钥不在此页**（只在 DSH 设置页改）；
- 同一张卡里还有「启动 / 停止语音服务」（仅 TTS 后端 = local 时可用）：调控制台 `/api/tts/start|stop`，启动后 5/20/40 秒自动刷新；
- 宿主白名单同步放行这 8 把文本键（带长度上限），`upsertPatchValue` 的 `allowString` 覆盖；**仍需重启宿主一次**；
- 测试：`voice-unit` 152 条、`settings-unit` 297 条。

### 5.11 隐私加固：日志与诊断包里的 token（v0.8.7）

- `control/bin/qq-control.mjs` 启动输出统一打码为 `token=<已隐藏>`（`--open` 仍用内部带 token 的 URL），token 只留在 `qq-control.json`；
- `control/lib/redact.mjs` 新增 `maskSecrets()`：URL 参数、JSON 的 token/apiKey 字段、YAML 赋值、`Bearer …`、`sk-…` 全部替换为 `<已隐藏>`；`redactObject` 对 token/apiKey/secret/password 键整段打码；
- `qq-host-out.log` 是 DSH 自己的输出（可能含宿主 token），插件改不了；文档明确「不要原样发人，用脱敏诊断包」；
- 测试：`privacy-unit` 42 条（+2）、`control-unit` 183 条（+1）。

## 六、下一步候选（按用户已表态的口径）

用户说"先准备一下新的功能，继续添加功能"，又说"很久没开发以前的老功能了，比如语音模块"。已聊过但**尚未开工**的方向
（「一键体检报告」「设置项变更历史」「语音调试」已于 2026-11-08 做完，见上一节）：

| 候选 | 动到哪 | 备注 |
|---|---|---|
| **多实例并行 + 会话隔离** | `lib/`（大改） | 真正的下一版（0.9）；动手前要先在 #5 帖里预告动哪几个文件 |
| 群管理写操作补全（群名片/群公告/精华） | `lib/` | 受 ActionGate 限制，需先定白名单 |
| 控制台「日志导出为诊断包」 | `control/` | 已有诊断包能力，只差页面入口（注意：控制台与账号中心其实都已有一键导出按钮，做之前先确认缺的是"选项/历史"还是"入口"） |

`lib/` 不动的那些可以随时做；`lib/` 的（多实例）建议攒成一个版本发，减少 551123 重锚次数。

## 七、本次会话做了什么（供追溯，不必重读）

v0.8.4：端口连通性测试、账号「连接」列、长列表折叠、日志导出头、接口全部重检、面板搜文件、白名单语义拆分（`allowUsersPrivateOnly`，默认关）、设置页改名「QQ 用户」「QQ 群聊」。
v0.8.5：两套接口契约测试（46 条，路由覆盖 41/41，抓出 `unlinkSync` 未 import 导致「删除备份/回收站还原」一直 500）、文件与插件目录下钻、端口全景、回收站批量清理、日志按 traceId 看链路、`docs/ACCESS.md` 准入真值表、`tools/audit.mjs`（含第 ⑥ 项打包形态检查）、`tools/` 进 `files`。

v0.8.6（2026-11-08，已发布）：
- 控制台「一键体检报告」独立页 `/report` + `GET /api/report`、`control/lib/report.mjs`（纯函数）、`test/report-unit.mjs`（85 条）；控制台加「体检报告」入口与 `?focus=` 深链。
- 控制台「设置项变更历史」卡 + `GET /api/history`、`control/lib/history.mjs`（纯函数）、`test/settings-history-unit.mjs`（68 条）；顺手修掉 `--port` 临时端口被保存写进配置的问题。
- 语音调试：宿主 `/qqai/voice/{status,tts,stt}`（`lib/voice.js` + `lib/voice-routes.js`，挂在 `settings-routes.js`）＋ 控制台代理（含宿主自动发现）；独立页 `/voice`（`control/voice.html`）带按次覆盖的细调参数（Azure 语速/音调/音量、OpenAI 语速、GPT-SoVITS 参考音频与采样参数、STT 语言/模型）与最近 5 条试听；`test/voice-unit.mjs`（128 条）、`test/tts-unit.mjs`（20 条）。更新插件后要重启宿主才挂上新路由。
- 调试台布局重构：`control/ui.html` 左侧六组导航 + 卡片 `data-tab` 分组，右上角只留四个全局动作，「语音调试」移到侧栏；新增 `test/console-layout-unit.mjs`（25 条）。
- 发布：`package.json` 0.8.6、注释标签 `v0.8.6`、推送 `main` + tag；补丁面 `lib/bridge.js` / `lib/index.js` / `lib/panel.js` 仍未动。
- 验证：78 套 / 4695 断言全绿，`node tools/audit.mjs` 全过（45 路由全部有测试提到）。

v0.8.7（2026-11-09，已发布）：
- 控制台 Ctrl+K 命令面板：分组 / 卡片 / 动作三类条目，`focusCard` 自动切组再滚；侧栏顶部有可见入口「🔍 搜索 / 跳转 Ctrl K」；`test/console-layout-unit.mjs` 25 → 40 条（新增侧栏滑动选中块、体检趋势卡）。
- 体检趋势：`diagnose()` 每次真扫追加 `qq-health-history.jsonl`，`GET /api/health/history`，控制台卡片 30 秒自动刷新；`report-unit` 87 条。
- 语音调试并入控制台：侧栏第七个分组 + iframe 懒加载 `/voice?embed=1`；状态文案改为「未启用 / 部分未启用」；新增本机预设、上次参数自动恢复、试听下载/复制参数/对比表、导入导出按钮、卡点全列与自动刷新、页内开关、TTS/STT 后端切换、服务配置编辑与页内启停语音服务（写 `cordis.patch.yml`）；`test/voice-unit.mjs` 152 条。
- 顺手修掉 `test/settings-history-unit.mjs` 里的真实绝对路径（`privacy-unit` 会扫已跟踪文件）。
- 修复「启动语音服务」：`TTS控制.bat` 是 UTF-8 无 BOM，cmd 按 GBK 解析会把中文行当命令；改为直接拉 `.venv\Scripts\pythonw.exe api_v2.py`（无控制台，避免 forrtl window-CLOSE 中止）并确认 9880 是否监听（`control-unit` 183 条）。
- 隐私加固：控制台启动日志 token 打码；诊断包脱敏覆盖 token / apiKey / Bearer / `sk-…`；`privacy-unit` 42 条。
- 验证：78 套 / 4744 断言全绿；`git status` 只有源码/文档/测试改动，运行产物全部被忽略。
