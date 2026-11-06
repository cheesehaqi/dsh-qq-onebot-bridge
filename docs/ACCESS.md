# 准入组合真值表 / Access matrix

这份文档只回答一件事：**四个准入门（`allowAllChats` / `allowUsersPrivateOnly` / `acceptPrivate` / `replyOnlyWhenMentioned`）加上两份名单叠在一起，什么消息会被放行。**

代码里这两层是分开的、顺序固定：

```
① allowsChat(config, message)      ← 名单层（谁能进）
② 门控（acceptPrivate / replyOnlyWhenMentioned） ← 行为层（进了之后理不理）
```

判定顺序写死在实现里，改文档前请先对照 `lib/bridge.js` 的 `allowsChat()` 与 `#onMessage`。

---

## 一、名单层：`allowsChat`

按顺序短路，**先命中的那条决定结果**：

| 顺序 | 条件 | 结果 |
|---|---|---|
| 1 | `allowAllChats === true` | **放行**（私聊与群都放行，下面的名单全部失效） |
| 2 | 私聊 且 发送者在 `allowUsers` 里 | 放行 |
| 3 | 私聊 且 `verifyPending === true`（真有他的待审申请） | 放行 |
| 4 | 私聊（其余情况） | **拒绝**（`allowUsers` 为空 = 拒绝所有私聊） |
| 5 | 群 且 群号不在 `allowGroups` 里 | **拒绝** |
| 6 | 群 且 `allowUsersPrivateOnly === true` | 放行（**不再看** `allowUsers`） |
| 7 | 群 且 `allowUsers` 非空 且 发送者不在 `allowUsers` 里 | **拒绝**（"成员不在 QQ 用户白名单"） |
| 8 | 群（其余情况） | 放行 |

> 第 6 行就是 `allowUsersPrivateOnly` 的全部作用：**它只影响群分支，不影响私聊**。

## 二、行为层：两个门控

名单层放行之后，还有两道"理不理"的闸：

| 开关 | 默认 | 作用 |
|---|---|---|
| `acceptPrivate` | 开 | 关掉后**私聊一律不回**（`acceptPrivate=false，私聊已关闭`）。私聊语音转文字不受它限制。 |
| `replyOnlyWhenMentioned` | 开 | 群里**没 @ 机器人就不回**（`群聊未 @ 机器人`）。`atMe` 的判定依赖 `botQq`（0 = 每条群消息都当 @）。 |

这两道闸**不改变谁可以进来**，只决定进来之后是否继续处理。

## 三、常见组合

| `allowAllChats` | `allowUsersPrivateOnly` | 私聊 | 群聊 |
|---|---|---|---|
| 关 | 关（默认） | 必须在 `allowUsers` 里 | 群在 `allowGroups` 里 **且** 发送者在 `allowUsers` 里 |
| 关 | 开 | 必须在 `allowUsers` 里 | 只需群在 `allowGroups` 里（发送者不限） |
| 开 | 任意 | 全部放行 | 全部放行（但 @ 门槛仍看 `replyOnlyWhenMentioned`） |

## 四、几个容易踩的点

1. **`allowUsers` 空 = 拒绝所有私聊**（安全默认）。想让机器人能私聊，必须先把自己的号加进去。
2. **管理员也要在 `allowUsers` 里**：管理员名单不是"绕过白名单"，消息先过名单层。
3. **`allowAllChats` 不会关掉 @ 门槛**：开了它仍然要 @，除非同时关掉 `replyOnlyWhenMentioned`。
4. **`allowUsersPrivateOnly` 默认关**：关着时群里的发送者也要在 `allowUsers` 里——这是 0.8.4 之前的行为，保持兼容。
5. **`verifyPending` 只对私聊生效**：入群/加好友验证期间申请人可以私聊答题，但群里该按 `allowGroups` 走。

## 五、对应的测试

| 行为 | 测试 |
|---|---|
| 名单层八条分支 | `test/guards-unit.mjs`（`allowsChat` 矩阵，含 `allowUsersPrivateOnly` 四条） |
| 白名单校验（号码类型/负数/去重） | `test/settings-unit.mjs` |
| 开关在设置页的顺序与分组 | `test/settings-unit.mjs`（「AI账号与白名单」组断言） |
