# dsh-qq-onebot-bridge 交接（2026-11-08，v0.8.6）

> 给新会话用：粘在第一条消息里，或让新会话读这个文件。

## 一、仓库状态

```
路径    工作区根下的 dsh-qq-onebot-bridge（不进仓库的绝对路径，按你本机实际位置）
分支    main
HEAD    v0.8.6 发布提交（本次会话；用 `git log -1` 看实际哈希）
版本    0.8.6（tag：v0.8.0 … v0.8.6 都在）
已发布  「一键体检报告」：control/lib/report.mjs、control/report.html、test/report-unit.mjs；
        「设置项变更历史」：control/lib/history.mjs、test/settings-history-unit.mjs；
        「语音调试」：lib/voice.js、lib/voice-routes.js、control/voice.html、test/voice-unit.mjs；
        「调试台布局重构」：改 control/ui.html（左侧六组导航 + 卡片 data-tab），新增 test/console-layout-unit.mjs；
        改了 lib/settings-routes.js（挂 3 条宿主路由）、lib/tts.js（注入 fetchImpl）；
        前两项改了 control/lib/{server,supervisor}.mjs、control/bin/qq-control.mjs、control/ui.html；
        三者都改了 docs/DEBUG*.md、README*.md、CHANGELOG.md、docs/HANDOFF.md
```

**关键事实**：`lib/` 自 v0.8.6 起**新增**了语音调试相关文件（`voice.js` / `voice-routes.js`，并在 `settings-routes.js`、`tts.js` 里各加了一小段）；
`lib/bridge.js`、`lib/index.js`、`lib/panel.js`（551123 的补丁面）**仍未改动**。

## 二、这台机器上的验证口径（每次改完都跑）

```
node tools/audit.mjs            # 6 项结构体检，退出码 0/1（45 路由全部有测试提到）
逐套跑 test/*-unit.mjs          # 当前 78 套 / 4695 断言 / 0 失败
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
并在 `lib/settings-routes.js` / `lib/tts.js` 里各加了一小段 —— **`lib/bridge.js`、`lib/index.js`、`lib/panel.js`（551123 的补丁面）仍未动**。

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
- **独立页 `/voice`**（`control/voice.html`，从控制台左侧导航进入）：状态 + 卡点、一句话试听（`<audio>`）、
  录音（MediaRecorder）或选文件（ffmpeg 转 16k WAV）后看转写结果；**细调**全部按次覆盖、不写回配置：
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
