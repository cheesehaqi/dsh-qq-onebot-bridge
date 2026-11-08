# dsh-qq-onebot-bridge 交接（2026-11-08，v0.8.5 之后）

> 给新会话用：粘在第一条消息里，或让新会话读这个文件。

## 一、仓库状态

```
路径    D:\Deepseek\dsh-qq-onebot-bridge
分支    main
HEAD    f972b10  tooling(audit): 第 ⑥ 项打包形态检查
版本    0.8.5（tag：v0.8.0 … v0.8.5 都在）
未提交  0
```

**关键事实**：`lib/` 自 v0.8.5 起**未改动**（`git diff --stat v0.8.5..HEAD -- lib/` 为空）。最近的改动全在 `control/` + `test/` + `docs/` + `tools/`。

## 二、这台机器上的验证口径（每次改完都跑）

```
node tools/audit.mjs            # 6 项结构体检，退出码 0/1
逐套跑 test/*-unit.mjs          # 当前 74 套 / 4381 断言 / 0 失败
```

`tools/audit.mjs` 现在查：① 语法 ② 页面元素时序（`$('id')` 必须出现在 `<script>` 之前，动态白名单 6 个）
③ 前端 `/api` 调用都有实现 ④ 每个路由至少在 `test/` 里出现 ⑤ 关键文件行数下限 ⑥ 打包形态（`scripts` 引用的文件必须在 `package.json` 的 `files` 里）。

## 三、给别人（551123）的承诺与事实

- 他的补丁面是 `lib/bridge.js`、`lib/index.js`、`lib/panel.js`，加 `control/lib/server.mjs`、`control/lib/supervisor.mjs`、`control/ui.html`、`config.mjs`、`package.json` 的 `files`；
- **0.8.4 的补丁面行号（0.8.5 未变）**：
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
- 删除一律走 `D:\Deepseek\scripts\safe-delete.ps1`；
- 改非 ASCII 文件只能用 read/edit/write 或 Node 的 `readFileSync`/`writeFileSync`（**不要**用 PowerShell 的 `Get-Content`/`Set-Content`）；
- 写补丁脚本时别在模板字符串里嵌反引号（踩过三次），复杂替换直接用 `edit` 工具；
- 对外文字里的每个数字都要先用命令核（踩过：把"3 条 POST 路由"写成"3 条路由"，实际 1 条）。

## 五、下一步候选（按用户已表态的口径）

用户说"先准备一下新的功能"。已聊过但**尚未开工**的方向：

| 候选 | 动到哪 | 备注 |
|---|---|---|
| **多实例并行 + 会话隔离** | `lib/`（大改） | 真正的下一版（0.9）；动手前要先在 #5 帖里预告动哪几个文件 |
| 群管理写操作补全（群名片/群公告/精华） | `lib/` | 受 ActionGate 限制，需先定白名单 |
| 控制台「日志导出为诊断包」 | `control/` | 已有诊断包能力，只差页面入口 |
| 控制台「设置项变更历史」 | `control/` | 复用 op-log（`qq-account-oplog`） |
| 控制台「一键体检报告」页面 | `control/` | 后端 `/api/acceptance` 已有，页面只做展示 |

`lib/` 不动的那些可以随时做；`lib/` 的（多实例）建议攒成一个版本发，减少 551123 重锚次数。

## 六、本次会话做了什么（供追溯，不必重读）

v0.8.4：端口连通性测试、账号「连接」列、长列表折叠、日志导出头、接口全部重检、面板搜文件、白名单语义拆分（`allowUsersPrivateOnly`，默认关）、设置页改名「QQ 用户」「QQ 群聊」。
v0.8.5：两套接口契约测试（46 条，路由覆盖 41/41，抓出 `unlinkSync` 未 import 导致「删除备份/回收站还原」一直 500）、文件与插件目录下钻、端口全景、回收站批量清理、日志按 traceId 看链路、`docs/ACCESS.md` 准入真值表、`tools/audit.mjs`（含第 ⑥ 项打包形态检查）、`tools/` 进 `files`。
