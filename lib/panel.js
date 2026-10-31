/**
 * v0.6「轻量化设计」：DSH 设置里那块「QQ助手」面板的**纯逻辑**。
 *
 * 这个文件不碰网络、不碰磁盘，只做三件事，方便单测：
 *   1. `PANEL_GROUPS`：精选出来、适合在设置界面里开关的功能（不是把 224 个键全铺上去——
 *      那样面板本身就"重"了，也失去意义）；
 *   2. `panelSnapshot()`：把运行中的生效值整理成前端要渲染的形状；
 *   3. `upsertPatchValue()` / `readPatchValue()`：只动 profile 的 `cordis.patch.yml` 里
 *      **本插件那一个条目**的 config 块，逐行做 upsert，保留注释与其它条目的原样。
 */

import { capabilityLines } from './capability.js'

/**
 * 一个开关在面板里的样子。
 * - `hint`：**这个开关到底做什么** + 需要什么 + 关掉会怎样（用户反馈"就写了串英文，都没写需要额外软件"，
 *   所以每行都必须是完整说明，空提示会被单测判红）；
 * - `needs`：依赖标记（空 = 开箱即用）。取值词表见 `PANEL_NEEDS`，界面渲染成一个小标签，
 *   让人一眼看出"这个开关要额外装东西/填密钥"。
 * `key` 必须与 lib/index.js 的 schema 一致（单测钉死）。
 */
const row = (key, label, hint = '', needs = '') => ({ key, label, hint, needs, type: 'boolean' })

/**
 * **时段列表**控件（v0.6.8）：`quietHours` 这种"一串 H:MM-H:MM"的键，原来只能改配置文件。
 *
 * 语义照抄引擎侧 `parseQuietRanges` / `isQuietTime`（lib/bridge.js）：
 *   - `H:MM-H:MM`（小时 1–2 位、允许全角冒号、起止之间可有空格）；
 *   - **支持跨夜**（`22:00-06:00` 表示 22:00 到次日 06:00）；
 *   - 起止相同视为无效（那条会被引擎忽略，所以这里直接拒）；
 *   - 上限 8 段（够用，且避免把一行塞爆）。
 */
const times = (key, label, hint = '', needs = '') => ({ key, label, hint, needs, type: 'times' })

/** 时段上限：超过就拒（面板一行也放不下更多）。 */
export const QUIET_MAX_RANGES = 8

/** 全角数字/冒号归一（与引擎侧 parseQuietRanges 同口径）。 */
function normalizeRangeText(text) {
  const fullWidthDigits = '０１２３４５６７８９'
  return String(text ?? '')
    .replace(/[：]/g, ':')
    .replace(/[－—–]/g, '-')
    .replace(/[０-９]/g, (ch) => String(fullWidthDigits.indexOf(ch)))
}

/**
 * 校验并归一化一组时段；返回 `{ ok, ranges, reason }`。
 * `ranges` 是归一化后的 `H:MM-H:MM` 字符串（写进配置的就是它），`reason` 给界面直接显示。
 */
export function normalizeQuietRanges(value) {
  if (!Array.isArray(value)) return { ok: false, ranges: [], reason: '时段必须是数组（如 ["9:00-12:00","14:00-18:00"]）' }
  if (value.length > QUIET_MAX_RANGES) return { ok: false, ranges: [], reason: `最多 ${QUIET_MAX_RANGES} 段时段（收到 ${value.length} 段）` }
  const ranges = []
  for (const raw of value) {
    const text = normalizeRangeText(raw).trim()
    const match = /^(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2}):(\d{1,2})$/.exec(text)
    if (!match) return { ok: false, ranges: [], reason: `看不懂这个时段：${String(raw)}（要写成 9:00-12:00 这样的 H:MM-H:MM）` }
    const [h1, m1, h2, m2] = match.slice(1).map(Number)
    if (h1 > 23 || m1 > 59 || h2 > 23 || m2 > 59) {
      return { ok: false, ranges: [], reason: `时段越界：${String(raw)}（小时 0–23、分钟 0–59）` }
    }
    if (h1 === h2 && m1 === m2) return { ok: false, ranges: [], reason: `起止时间相同：${String(raw)}（这条不起作用，去掉它）` }
    ranges.push(`${String(h1).padStart(2, '0')}:${String(m1).padStart(2, '0')}-${String(h2).padStart(2, '0')}:${String(m2).padStart(2, '0')}`)
  }
  return { ok: true, ranges, reason: '' }
}

/**
 * **数字列表**控件（v0.6.8）：`allowUsers` / `allowGroups` 这种"一串 QQ 号 / 群号"的键。
 *
 * schema 里它们是 `z.array(z.number().step(1))`（**数字**数组），而 OneBot 的 `user_id` 在
 * `lib/onebot.js` 里就被 `Number(...)` 转成数字，`#allowed()` 用 `includes` 比的就是数字——
 * 所以这里必须写**数字**，写成字符串（`"2000000001"`）会让白名单永远匹配不上。
 */
const list = (key, label, hint = '', needs = '') => ({ key, label, hint, needs, type: 'list' })

/** 白名单最多多少条（够了；再多就该用白名单文件而不是面板）。 */
export const LIST_MAX_ITEMS = 50

/**
 * **正则列表**（v0.7.8，自定义注入句式）：和上面的 `list` 是两种东西——
 * 号码列表是 `number[]`、界面按数字校验；这里是**字符串原文**（正则里的 `\` `.` `(` 一个都不能丢，
 * 也不能 trim 掉首尾空格以外的东西），所以单独一个 `patterns` 类型。
 */
const patterns = (key, label, hint = '', needs = '') => ({ key, label, hint, needs, type: 'patterns' })

/** 自定义句式的上限（与 `lib/taint.js` 的 `EXTRA_PATTERN_LIMITS` 保持一致）。 */
export const PATTERN_MAX_ITEMS = 20
export const PATTERN_MAX_LENGTH = 200

/**
 * `numberMeta` 里的 min/max 读成"数字或 null"。
 * ⚠️ 不能直接 `Number(meta.min)`：schema 没写范围时这里是 `null`，而 `Number(null) === 0`，
 * 会让界面与服务端把这一行夹死在 [0,0]（`botQq` 这种没有 schema 范围的键就永远改不了）。
 */
export function metaNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * 校验并归一化一份"号码列表"；返回 `{ ok, list, reason }`。
 * 只收**正整数**（QQ 号 / 群号），去重、保序；上限 `LIST_MAX_ITEMS`。
 */
export function normalizeNumberList(value) {
  if (!Array.isArray(value)) return { ok: false, list: [], reason: '白名单必须是数组（如 [2000000001]）' }
  if (value.length > LIST_MAX_ITEMS) return { ok: false, list: [], reason: `最多 ${LIST_MAX_ITEMS} 条（收到 ${value.length} 条）` }
  const list = []
  for (const raw of value) {
    const num = typeof raw === 'number' ? raw : NaN
    if (!Number.isFinite(num)) {
      return { ok: false, list: [], reason: `只接受数字号码（收到 ${JSON.stringify(raw)}）——QQ 号/群号别加引号` }
    }
    if (!Number.isInteger(num) || num <= 0) return { ok: false, list: [], reason: `号码必须是正整数（收到 ${num}）` }
    if (!list.includes(num)) list.push(num)
  }
  return { ok: true, list, reason: '' }
}

/**
 * 校验**正则列表**（v0.7.8，`taintExtraPatterns`）：
 *   - 只收**字符串**数组（不是号码数组——差一位就是"正则变成数字"的灾难）；
 *   - 每条 trim 后非空、≤ 200 字、能编译成 `new RegExp(text, 'i')`；
 *   - 去重、最多 20 条。
 *
 * 在这里先编译，是为了让坏正则的报错发生在**点保存**时（用户看得见），
 * 而不是等某条消息进来、在入站路径上抛异常（那时只会在 trace 里留一条，用户根本没盯着 trace）。
 */
export function normalizePatternList(value) {
  if (!Array.isArray(value)) return { ok: false, list: [], reason: `自定义句式必须是数组（收到 ${Array.isArray(value) ? 'array' : typeof value}）` }
  const list = []
  for (const raw of value) {
    if (typeof raw !== 'string') {
      return { ok: false, list: [], reason: `每一条都必须是字符串（收到 ${JSON.stringify(raw)}）` }
    }
    const text = raw.trim()
    if (text === '') continue
    if (text.length > PATTERN_MAX_LENGTH) {
      return { ok: false, list: [], reason: `单条最多 ${PATTERN_MAX_LENGTH} 字（这条 ${text.length} 字）——正则太长会把消息处理拖慢` }
    }
    try {
      // 编译一次就够：桥在启动时也会编译，这里只是提前把错误暴露给用户。
      new RegExp(text, 'i')
    } catch (error) {
      return { ok: false, list: [], reason: `正则不合法：${error?.message ?? error}（这一条：${text.slice(0, 40)}）` }
    }
    if (!list.includes(text)) list.push(text)
  }
  if (list.length > PATTERN_MAX_ITEMS) {
    return { ok: false, list: [], reason: `最多 ${PATTERN_MAX_ITEMS} 条（收到 ${list.length} 条）` }
  }
  return { ok: true, list, reason: '' }
}

/** 一个**数值**控件（v0.6.7）：风控里那些"阈值"原来只能在配置里手改，现在面板直接给数字。
 *
 * 范围/步长/默认值**从 schema 读**（`numberMeta`，见 lib/index.js 的 `numberMetaOf`）——
 * 面板里不抄第二份，否则改了一处、另一处不跟着变，界面就会允许写出 schema 会拒的值。
 * 这里只声明"这个键是数值行 + 单位 + 说明"。
 */
const num = (key, label, hint = '', unit = '', needs = '') => ({ key, label, hint, unit, needs, type: 'number' })

/**
 * **开关 + 数值合成一行**（v0.6.7）：开关是总闸，数值是它的阈值，两个必须在同一行里。
 *
 * 为什么（用户 2026-10-17：「你这两个怎么不合并在一起」）：原来它们是两行、名字还几乎一样
 * （「每分钟进模型上限」+「每分钟进模型上限·数值」），要上下对照才知道谁管谁；合成一行后
 * 就是"这里一个开关、旁边一个数字"，关系写在脸上。
 *
 * 键照旧是**两个**（`key` = 布尔、`number.key` = 数值），写配置时各写各的（POST 一次只写一个键），
 * 所以服务端校验与 `PANEL_ROW_BY_KEY` 都按"展开后的两个键"工作，见文件末尾的展开。
 */
const numSwitch = (key, label, hint, numberKey, numberLabel, numberHint, unit = '') => ({
  key,
  label,
  hint,
  needs: '',
  unit,
  type: 'switchNumber',
  number: { key: numberKey, label: numberLabel, hint: numberHint, unit, needs: '', type: 'number' },
})

/** 依赖标记的词表（界面按这个顺序渲染，别随意加近义词）。 */
export const PANEL_NEEDS = {
  service: '需自备服务',
  key: '需自备密钥',
  file: '需自备词表',
  config: '需配置',
  admin: '需群管理员',
  napcat: '需 NapCat 扩展',
  npmodel: '不需模型',
}

/**
 * 分组：前 4 组是日常会动的；后 3 组标 `advanced`，界面里默认折叠。
 * 之所以不直接暴露全部布尔键：面板要的是"能一眼看完的开关"，其余仍走配置文件。
 */
export const PANEL_GROUPS = [
  {
    /**
     * **AI 账号与白名单**（v0.6.8；2026-10-19「做一个白名单添加面板」、2026-10-20「白名单改成 AI 账号与白名单」
     * + 「拉到对话基础上边」）。
     *
     * 为什么排在最前：它回答的是"**这是哪个机器人账号、它认谁**"——白名单空着，别的开关调得再对机器人也不说话。
     *
     * 为什么把 `botQq` 也放这一组：它和两个白名单是同一类东西。
     *   - `botQq`：判断"群里 @ 的是不是它"「戳一戳」是不是戳它（0 = 不判断）；
     *   - `allowUsers` / `allowGroups`：**为空 = 全部拒绝**（`lib/bridge.js` 的 `#allowed()`）。
     * 真机上最容易踩的两个坑正好对应这两处："NapCat 登录成功但机器人一声不吭"（白名单空）、
     * "戳一戳没反应"（botQq 没配）。
     */
    id: 'whitelist',
    title: 'AI账号与白名单',
    note: '这一组决定**机器人是谁、它认谁**。`AI 账号` 填机器人自己的 QQ（0 = 不判断）；'
      + '两个白名单**空 = 全部拒绝**（刻意的安全默认）：私聊必须把对方 QQ 加进「允许的用户」，'
      + '群消息必须把群号加进「允许的群」。号码填**数字**、不用加引号；改完点开关/保存即生效（宿主热重载）。'
      + '**白名单是在建会话之前就拦下的**：不在名单里的会话**根本不会被创建**，所以不会"回一句拒绝"，'
      + '而是在 trace 里直接记「白名单」被拒 —— 排查时看 `/为什么`，不要等它回话。'
      + '**管理员名单里的号也必须出现在「允许的用户」里**，否则消息先被白名单拦下，命令自然不会响应。',
    rows: [
      /**
       * 白名单组里的 `botQq`：**不画 ± 按钮**（用户 2026-10-20「AI账号那一栏为啥还有加减啊」）——
       * QQ 号是"填一次就完事"的标识，不是"一点一点调"的阈值，旁边挂两个加减键看着就像调试参数。
       */
      { ...num('botQq', 'AI 账号（机器人 QQ 号）', '机器人**自己**的 QQ 号（不是你的）。群里判断「@ 的是不是它」、「戳一戳」是不是戳它都要用。**0 = 不判断**：群里每条消息都当 @ 处理，戳一戳一律不理。', '号'), noStepper: true },
      // ★ v0.6.8（用户 2026-10-20「不需要添加白名单的功能，会理会所有的群聊和会话，但是群聊还是要 @ 的」）：
      //   开了它下面两个名单就不生效；但群里的 @ 门槛**不变**（那是 replyOnlyWhenMentioned 的事）。
      //   名字改成「回应所有人」（2026-10-20「应该换个名字」）：一句话说清效果，和「群里只理被 @ 的」同一套句式。
      row('allowAllChats', '回应所有人', '打开后**所有私聊和所有群**都会响应，下面两个白名单不再生效。**群里的 @ 门槛不变**：仍然要 @ 到它才回（除非你关掉「群里只理被 @ 的」）。默认关。'),
      // 两个"准入门"开关也放这里：它们和下面两个白名单是同一件事——**谁能让它开口**。
      row('replyOnlyWhenMentioned', '群里只理被 @ 的', '群里只有 @ 到机器人才回话；私聊不受影响。判断"@ 的是不是它"要看上面的 AI 账号（0 = 每条群消息都当 @）。关掉后群里每句话都会进模型（费额度）。'),
      row('acceptPrivate', '允许私聊', '私聊是否响应（仍然受下面的「允许的用户」白名单限制）。关掉后私聊一律不理。'),
      { ...list('allowUsers', '允许的用户（QQ 号）', '私聊白名单：只有列表里的 QQ 号可以私聊机器人。**空 = 拒绝所有私聊**。群消息也要求发送者在这个列表里（列表非空时）。'), dependsOn: 'allowAllChats', dependsActive: false, switchLabel: '回应所有人' },
      { ...list('allowGroups', '允许的群（群号）', '群白名单：只有列表里的群会收到回复。**空 = 拒绝所有群消息**（进群申请、撤回通知这类 notice 不受影响）。'), dependsOn: 'allowAllChats', dependsActive: false, switchLabel: '回应所有人' },
      /**
       * ★ v0.7.0：管理员名单（`adminUsers`）终于进面板 —— 以前只能改 YAML，
       * 而它正是 `/设管理`、`/批量踢`、`/退群` 这些命令的准入门。
       * ⚠️ 它**不**在「允许的用户」之外生效：消息先过 `allowUsers`，所以管理员必须同时在两边。
       * 这也**不是**扩展开关，不受 `allowAllChats` 影响（管理员名单始终要显式填）。
       */
      list('adminUsers', '管理员（QQ 号）', '这些号可以执行管理命令（`/设管理`、`/批量踢`、`/退群`、`/成员 @某人` 等）。'
        + '**必须同时出现在「允许的用户」里**，否则消息先被白名单拦下。'
        + '**空 = 没有管理员**（管理命令一律不响应，这是安全默认）。'),
    ],
  },
  {
    id: 'chat',
    title: '对话基础',
    rows: [
      row('memoryEnabled', '长期记忆', '把每个会话最近的对话存到 <cwd>/qq-memory/，宿主重启后重新注入，机器人才"记得"之前聊过什么。关掉后不再记住群里的事。', PANEL_NEEDS.config),
      row('sessionResumeEnabled', '会话续接', '宿主重启后接着用同一个会话（完整上下文，不只是记忆窗口）。关掉后每次重启都是新会话。'),
      // ★ v0.6.9：「回复带引用」属于**回复的样子**，不是"谁能让它开口" —— 所以放对话基础，不塞进白名单组。
      row('quoteReplyEnabled', '回复带引用', '回复时引用被回答的那条消息（QQ 原生「回复」）。**只作用于群聊**（私聊一对一，引用没意义）；**默认关**：多人同时提问时更清楚，但它会改变群里的观感。打开后**不用任何特殊问法**——所有群回复都会带引用。引用失败（消息被撤回/ID 过期/客户端不支持）会**自动去掉引用重发一次**，不会把回复弄丢。'),
      row('dedupEnabled', '重复消息去重', '忽略重复的入站消息（NapCat 重连后重复投递的那条），时间窗见下面的「去重窗口」（默认 300 秒）。'),
      num('dedupWindowSeconds', '去重窗口', '同一条消息在多长时间内重复到达算"重复"（NapCat 重连后常见）。上面"重复消息去重"打开时才起作用。', '秒'),
      /**
       * ★ v0.7.7：长回复被切开时**在标点处断**（默认开）。
       * 只有超过「单条上限」的长回复才会触发分批，所以这个开关平时看不见效果；
       * 关掉 = 每批不再往回找标点（**分批本身照旧**：仍按单条上限切成多条，只是变成等长硬切）。
       * ⚠️ 这个语义被第三方实测纠正过（issue #4，2026-10-27）：5000 字 + 上限 1700，
       *    关掉后仍是 1700/1700/1600 三批 —— 所以提示里不能写"退回"，那会被读成"不再分条"。
       */
      row('longReplySplitOnPunctuation', '长回复按标点断开', '回复超过单条上限、需要拆成多条时，**优先在句末标点断开**（找不到句末就退到逗号/顿号，再不行才硬切），不会把一句话从中间劈开。**默认开**。关掉后**仍然会按单条上限切成多条**（分批不受影响），只是每批不再往回找标点、变成等长硬切（会有句子被劈成两半）。只有超长回复才会触发分批，普通对话看不到区别。'),
    ],
  },
  {
    /**
     * 两个限流闸合并成一组（用户 2026-10-17：「对话基础的会话上限和风控里的会话上限有什么区别」
     * ——分在两组里各叫一个"上限"确实容易混）。按**管道顺序**排：先入站（进模型），后出站（发出去）。
     * 两个都**默认关**（与仓库既有口径一致）。
     */
    id: 'limits',
    title: '限流：入站 / 出站',
    note: '两个闸**默认都关**，可以只开一个。**入站**（每分钟进模型）在消息**还没进模型**时拦，省的是模型额度；'
      + '**出站**（回复限流）在模型已经生成回复、**发出去之前**拦，防的是 QQ 端发太快被风控（代价是那次模型回合白烧）。'
      + '命令的回复只走出站闸（`/help` 之类不烧模型，不受入站上限影响）。',
    rows: [
      // 开关 + 数值**同一行**（用户 2026-10-17：「你这两个怎么不合并在一起」）。
      numSwitch('chatTurnLimitEnabled', '每分钟进模型上限', '每个会话**每分钟最多让几条消息进模型**（入站风控，**默认关**）：右边是它的数值，超出的直接丢弃并记账（不排队），免得一个群刷屏把模型额度和响应都吃光。',
        'chatTurnsPerMinute', '每分钟进模型条数', '每个会话每分钟最多几个回合（默认 5，范围 1–10）。**左边的开关关着时这个数字不起作用。**', '条/分钟'),
      numSwitch('rateLimitEnabled', '出站回复限流', '每个会话在「出站回复窗口」内最多回几条（**出站**，默认关，主要防 QQ 风控）：超出的回复**丢弃不发**并记账——注意那次模型回合已经烧掉了，所以它是"最后一道闸"，不是省额度的手段。',
        'rateLimitMaxReplies', '出站回复上限', '一个窗口内最多回几条（默认 10 条）。**左边的开关关着时这个数字不起作用。**', '条'),
      num('rateLimitWindowSeconds', '出站回复窗口', '上面「出站回复限流」那个上限按多长的窗口算（默认 60 秒，范围 5–3600）。', '秒'),
    ],
  },
  {
    /**
     * 避开高峰期（v0.6.8）：功能早就有（`quietHoursEnabled` / `quietHours` / `quietWeekendExempt`），
     * 但面板里一个都没暴露 —— 只能去改配置文件。现在整组搬进来：开关 + 周末豁免 + 时段列表。
     * 语义与引擎侧完全一致（见 lib/bridge.js 的 parseQuietRanges / isQuietTime）：**支持跨夜**。
     */
    id: 'quiet',
    title: '避开高峰期',
    note: '静默时段内机器人**不回复任何入站消息**（不处理、不消耗模型调用，trace 里记原因）；'
      + '**已排定的定时提醒/投票开奖照常执行**。时段写成 `9:00-12:00`，**支持跨夜**（`22:00-6:00` 表示 22 点到次日 6 点）。',
    rows: [
      row('quietHoursEnabled', '避开高峰期', '开启后，下面那些时段内机器人**不回复**（也不烧模型）。默认关，关着时行为与之前完全一样。'),
      row('quietWeekendExempt', '周末不静默', '周六、周日**不套用**上面的时段（默认开）。关掉就七天都按同一个时段静默。'),
      // `dependsOn`：这条时段只在「避开高峰期」开关打开时才生效——服务端会把状态带给界面，
      // 免得出用户"设了时段却还在回复"（2026-10-20 真机就是这么踩的）。
      { ...times('quietHours', '静默时段', '要静默的时间段，可多段；支持跨夜（`22:00-6:00`）。起止时间相同的那条不起作用、会被拒。'), dependsOn: 'quietHoursEnabled', switchLabel: '避开高峰期' },
    ],
  },
  {
    id: 'ops',
    title: '群运营工具箱',
    rows: [
      row('groupOpsEnabled', '群运营总开关', '打开后下面这些命令才响应：原生群打卡、@全体余量、禁言名单、批量踢、群待办、群资料、文件整理、相册上传、运营周报。**大多数子命令要求机器人是该群管理员**；关掉后整组命令都不响应。', PANEL_NEEDS.admin),
      row('opsReadEnabled', '只读查询', '/全体余量 /禁言名单 /群资料 /入群通知 等只读查询（纯查询，不改群）。需要先打开上面的总开关。', PANEL_NEEDS.napcat),
      row('opsAdminEnabled', '管理员设置', '/设管理、/撤管理（set_group_admin）。需要机器人是管理员；目标必须**在本群里**，否则 NapCat 会报 get Uid Error（面板所在的宿主会把它翻译成中文原因）。', PANEL_NEEDS.admin),
      row('opsInvitePolicyEnabled', '邀请策略', '/邀请策略 关闭|需审核|免审核|百人以下 —— 四个取值来自 NapCat 的文档字面量。需要机器人是管理员。', PANEL_NEEDS.admin),
      row('opsAddOptionEnabled', '加群方式', '/加群方式 <1–5> [问题=… 答案=…]。add_type 在 NapCat 里是裸号码、没有官方枚举，所以机器人不替你"翻译"这些数字的含义。需要机器人是管理员。', PANEL_NEEDS.admin),
      row('requestSyncEnabled', '申请补拉', '/申请：主动把待处理的入群申请与可疑好友申请拉进审批队列，离线期间错过的也不会漏（审批用 /待审、/同意 N、/拒绝 N）。', PANEL_NEEDS.napcat),
      row('adminWatchEnabled', '管理员变动播报 + 权限自愈', '监听管理员变动：机器人被授权/被撤权时在群里说明；被撤之后写命令会直接告诉你"我不是管理员"，不会去瞎调接口。'),
      row('nativeSignEnabled', 'QQ 原生群打卡', '/群打卡 —— QQ **原生**的群打卡（set_group_sign）。注意它跟本地签到（娱乐组里的"本地签到"）是两回事。', PANEL_NEEDS.admin),
      row('opsKickEnabled', '批量踢', '/批量踢：需要**在群里二次确认**才会真正执行，防误触。需要机器人是管理员。', PANEL_NEEDS.admin),
      row('opsTodoEnabled', '群待办', '/待办、/完成待办、/取消待办（引用一条消息来指定）。需要机器人是管理员。', PANEL_NEEDS.admin),
      row('opsReportEnabled', '运营周报', '/周报，以及喂给它的运营计数（消息、入群、退群、踢人、禁言、打卡、表情回应）。', ''),
      num('opsReportDays', '运营周报·天数', '/周报 统计最近多少天（默认 7 天）。', '天'),
    ],
  },
  {
    id: 'fun',
    title: '娱乐与互动',
    rows: [
      row('fortuneEnabled', '每日运势', '今日人品/运势、抽签、塔罗；按人按天确定性生成——**不调模型、不联网**。', PANEL_NEEDS.npmodel),
      row('diceEnabled', '骰子', '骰子与随机抽选（.r 3d6 / 掷骰 2d6+1 / /抽一个 A B C），纯本地计算。', PANEL_NEEDS.npmodel),
      row('pointsEnabled', '积分', '积分经济（默认关）：聊天与签到赚积分，/积分 看余额、/排行榜 看排行、/转账 @某人 数量 转账。赚取规则见 pointsPerMessage / pointsDailyCap / pointsCheckinBonus。', PANEL_NEEDS.config),
      row('gameEnabled', '小游戏', '群内小游戏：成语接龙、猜数字。说"接龙"/"猜数字"开始，"不玩了"结束。'),
      row('checkinEnabled', '本地签到', '本地打卡（默认关）：群里发关键词（默认"签到"）即打卡，连续天数与总天数按会话存在 <cwd>/qq-checkin/，/签到榜 看排行。**与 QQ 原生群打卡是两件事**（那个要开"群运营"里的 /群打卡）。', PANEL_NEEDS.config),
      row('voteEnabled', '投票', '群投票："投票：问题？A 选项 B 选项"，成员回选项字母投票；/vote、/vote-end 管理，时长见 voteDurationSeconds。'),
      row('todoEnabled', '待办提醒', '共享待办：/todo add|list|done|clear，或直接说"记一下：xxx"；按会话存在 <cwd>/qq-todos/。'),
      row('statsEnabled', '活跃统计', '群活跃统计（默认关）：按人按天统计发言数，/统计、/活跃榜、/周榜 查看；日报也用它。保留天数见 statsKeepDays。', PANEL_NEEDS.config),
      row('mcStatusEnabled', 'MC 服务器状态', 'Minecraft Java 服务器状态：/mc 主机[:端口]，走官方的 Server List Ping 协议——**不需要 API key，只读**。超时见 mcStatusTimeoutMs。', PANEL_NEEDS.npmodel),
      row('pokeEnabled', '戳一戳回应', '被戳一戳时回一句随机可爱话（仅白名单会话）。文案与频率见 pokeReplies / pokeBackText / pokeCooldownSeconds。'),
      num('pokePerHour', '戳一戳·每小时上限', '每个会话每小时最多主动戳几次（默认 5 次，免得互相戳到停不下来）。', '次/小时'),
      row('welcomeEnabled', '入群欢迎', '新人入群时 @ 他并发送欢迎语（默认关，文案见 welcomeText），只对白名单群生效。'),
    ],
  },
  {
    id: 'media',
    title: '语音与媒体',
    // 组级提示：这一组的能力**插件与 DSH 都不自带**，必须用户自己准备，所以默认全关。
    note: '注意：**语音回复（TTS）与 AI 生图 DSH 与本插件都不自带**——要么本机自己装服务（如 GPT-SoVITS），'
      + '要么去第三方申请密钥，然后在配置里填地址与密钥；**语音转文字 DSH 自带**（实验性的「语音输入」bundle，'
      + '需要你在 DSH 里自行启用，首次用会下载本地 SenseVoice 模型），也可以改配自己的云服务。'
      + '所以这一组**默认全部关闭**；没准备好就别开，开了只会看到"合成失败"的日志。'
      + '另外 OCR / 相册 / 群文件 / 成员查询这些走的是 **NapCat 的专有接口**，换别的 OneBot 实现会不可用。',
    rows: [
      row('ttsEnabled', '语音回复', '每条文字回复后附带一条语音。**DSH 与本插件都不自带 TTS**，要你自己准备：本机装 GPT-SoVITS（ttsProvider=local，配 ttsLocalUrl 与参考音频/提示文本），或去云端申请密钥（Azure 需 ttsApiKey + ttsAzureRegion；OpenAI 兼容需 ttsBaseUrl + ttsModel + ttsApiKey）。没准备时只会回文字，失败原因会记进 trace。', PANEL_NEEDS.service),
      row('sttEnabled', '语音转文字', '群里 @机器人 时引用一条语音、或私聊直接发语音，先转写再回答。**默认走 DSH 自带的本地识别**（`sttProvider: dsh`，SenseVoice，音频不出本机、不需要任何密钥）——前提是你已经在 profile 里启用实验性的「语音输入」bundle（首次使用会下载模型）。想改用云端就把 `sttProvider` 设成 `cloud`，再配 sttBaseUrl / sttModel / sttApiKey（例如智谱 glm-asr）。', PANEL_NEEDS.config),
      row('voiceReadingEnabled', '朗读语音消息', '@机器人 引用一条文字消息说"读一下/念出来"，或 /读 <文本>，机器人用 TTS 念出来。**默认关**，因为它要你自己准备 TTS 服务（DSH 不自带；与"语音回复"共用配置：本地 GPT-SoVITS 或云端密钥）。', PANEL_NEEDS.service),
      row('imageGenEnabled', 'AI 生图', '/画 <描述词> 生成图片并发回来（群里需 @机器人）。**DSH 与本插件都不自带生图模型**，要你自己准备：任何 OpenAI 兼容的图片接口——填 imageGenProvider / imageGenBaseUrl / imageGenApiKey / imageGenModel / imageGenSize；本地部署的（如 SD WebUI / ComfyUI 的兼容接口）也行，把地址填成它即可。图片保存与清理见 imageRetentionDays / imageTrashDir。', PANEL_NEEDS.service),
      row('ocrEnabled', '图片文字识别', '/ocr 读出用户发送或引用图片里的文字（只读）。走 NapCat 的 ocr_image 能力，**不需要额外密钥**。', PANEL_NEEDS.napcat),
      row('albumEnabled', '群相册上传', '/相册 列出群相册（只读）。走 NapCat 的群相册接口，需要机器人在群里有相应权限。', PANEL_NEEDS.napcat),
      row('groupFileEnabled', '群文件', '/文件 列出群文件与目录、/文件 <文件夹> 进入子目录（只读）。条数与大小上限见 groupFileListLimit / groupFileMaxBytes。', PANEL_NEEDS.napcat),
      row('fileTransferEnabled', '私聊文件转存', '私聊里把用户发来的文件存到 <cwd>/qq-files/ 并回复本地路径。大小上限见 fileTransferMaxBytes；给模型回传文件用 fileSendDirs / fileSendMaxBytes。', PANEL_NEEDS.config),
    ],
  },
  {
    id: 'safety',
    title: '安全与风控',
    advanced: true,
    rows: [
      row('verifyEnabled', '入群验证', '入群/加好友申请先进队列，给管理员推一道挑战题；管理员回 /同意 <id>，或对方答对才通过（默认关）。关键词与超时见 verifyKeyword / verifyTimeoutSeconds / verifyMaxPending。', PANEL_NEEDS.config),
      row('filterEnabled', '内容过滤', '敏感词过滤（默认关）：按**本地词表文件**匹配，命中后警告/撤回/禁言（动作见 filterAction）。需要自己准备词表：filterWordsFile。', PANEL_NEEDS.file),
      /**
       * ★ v0.7.9「防线三」：出站脱敏。
       *
       * 入站有内容过滤、注入有 dry-run、污点有窗口，但**发出去之前**原来什么都不查 ——
       * 群里问"你配置怎么写的"，模型贴出 sk-… / 私钥块就直接进群了。这三行补这一道。
       * 只认"确定是密钥"的格式；QQ 号 / 手机号 / URL 一律不碰（机器人本来就要发）。
       */
      row('outboundRedactEnabled', '出站脱敏（挡住密钥）', '发送前检查文本里的密钥并打码：`sk-…`、`gh*_…`、`AKIA…`、`xox…-`、JWT、`Bearer …`、整段 `PRIVATE KEY`。**默认关**；只处理文本段，不动图片/文件/语音；**QQ 号、手机号、URL 不在范围内**（误伤成本太高）。每次命中都写 trace，且 trace 里只写"命中了哪条规则"，**不写原文**。'),
      row('outboundRedactBlock', '出站脱敏·命中即拦截', '关着 = **打码后照发**（保留首尾几位，方便认出是哪把 key）；打开 = **整条不发**并在 trace 里说明。默认关：突然不回话会让人以为机器人坏了。只在上面「出站脱敏」打开时生效。'),
      patterns('outboundRedactPatterns', '自定义脱敏规则（正则）', '每行一条**正则**（不区分大小写，最多 20 条、每条 200 字以内），用来挡你自己的密钥格式（比如内网 token）。'
        + '**默认空**：不填就只用内置 7 条。' + '写错的正则会**跳过并记 trace**，不会让桥崩，也不会静默失效。只在上面「出站脱敏」打开时生效。'),
      row('floodEnabled', '刷屏治理', '短时间消息过多先警告、再禁言（默认关）。阈值就是下面四行（改完即时生效）。', PANEL_NEEDS.config),
      num('floodWindowSeconds', '刷屏·统计窗口', '「刷屏治理」在多长的窗口里数消息（默认 10 秒）。要先把上面「刷屏治理」打开。', '秒'),
      num('floodMaxMessages', '刷屏·窗口内条数', '同一个成员在一个窗口内超过这么多条就触发（默认 8 条）。', '条'),
      num('floodStrikeLimit', '刷屏·几次后禁言', '警告几次之后升级为禁言（默认 3 次）。', '次'),
      num('floodMuteSeconds', '刷屏·禁言时长', '升级为禁言时禁多久（默认 300 秒）。', '秒'),
      row('antiRecallEnabled', '防撤回', '缓存最近的入站消息，有人撤回时把内容重新发出来（默认关）。缓存大小与时效见 antiRecallCacheSize / antiRecallMaxAgeMinutes / antiRecallCooldownSeconds。', PANEL_NEEDS.config),
      row('keywordEnabled', '关键词回复', '**本地词表**命中就立刻回复（默认关）——不调模型、也不需要 @机器人。需要自己准备词表文件：keywordFile。', PANEL_NEEDS.file),
      row('leaveGroupEnabled', '允许 /退群', '允许管理员用 /退群 让机器人退出该群（默认关；执行前需要在群里二次确认）。', PANEL_NEEDS.admin),
    ],
  },
  {
    id: 'record',
    title: '记录与通知',
    advanced: true,
    rows: [
      row('traceEnabled', '轨迹 trace', '全链路追踪：每条入站消息有 traceId，每个决策（**包括每次静默丢弃**）都记 stage/ok/reason/耗时到 <cwd>/qq-trace.jsonl。控制台的实时事件流、体检、验收台全靠它——关掉后排查会瞎。级别与落盘见 traceLevel / traceFile。', PANEL_NEEDS.config),
      row('recordInbound', '入站录制', '把每个入站帧按可回放的形状记到 <cwd>/qq-inbox.jsonl。**控制台的离线回放依赖它**（关掉就没法重放历史消息）。'),
      row('historyArchiveEnabled', '历史归档', '把白名单消息归档到 <cwd>/qq-history/YYYY-MM-DD.jsonl，比轮转的 qq-inbox.jsonl 保留得久得多，/找 依赖它。注入/回放的帧不入档。'),
      row('historySearchEnabled', '历史检索', '/找 全文检索历史归档（读本地文件，不联网、不调模型）。', PANEL_NEEDS.npmodel),
      row('exportEnabled', '导出对话', '把一个会话的对话导出成文件（本地生成，方便备份或存档）。'),
      row('dailyReportEnabled', '每日日报', '每天把当天的统计推给指定会话（默认关）。**需要额外的两个前提**：打开"活跃统计"，并配好推送目标。', PANEL_NEEDS.config),
      row('broadcastEnabled', '定时播报', '按计划把内容发到指定群（默认关）。任务本身在配置/控制台的「定时任务」里维护，面板这里只是总开关。', PANEL_NEEDS.config),
      row('notifyEnabled', '推送通知', '把关键事件（掉线、异常、审批等）推送到指定目标（默认关）。需要先配好推送目标。', PANEL_NEEDS.config),
    ],
  },
  {
    /**
     * v0.7.0「实验性与扩展」：把**可能变动 / 需要自担风险**的开关集中在一组，
     * 默认折叠 + 标题写明 EXPERIMENTAL。第一条就是工具 provider 链。
     */
    id: 'experimental',
    title: '实验性（EXPERIMENTAL）',
    advanced: true,
    note: '这里的开关**默认全关**，行为可能在后续版本变动，出问题请带上 `/为什么` 的结果开 issue。'
      + '「扩展工具」打开后，同宿主里其它插件可以通过 `ctx.qqBridge.registerToolProvider()` 往每个会话注入**工具与提示段**——'
      + '提示段是**每条消息**都会进模型的成本，且外部扩展的行为不在本项目维护范围内（护栏只保证：只能新增、不能覆盖内置、抛错跳过并记 trace）。'
      + '「污点窗口」是**会挡住真实回复**的实验功能：打开后，群里有人贴"忽略之前所有指令"这类话，那个会话接下来一段时间里'
      + '**发文本 / 图片 / 文件 / 语音 / 撤回 / 贴表情一律不发**（问答照常跑完，只是出站被拦），每次拦截都写 trace。'
      + '默认关就是因为它会让人以为"机器人坏了"——要开请先想清楚。',
    rows: [
      row('extensionToolsEnabled', '扩展工具（第三方注入工具/提示段）', '允许同宿主的其它插件往每个会话注入 agent 工具与提示段（**实验性，默认关**）。打开后：外部工具只能**新增**、不能覆盖内置；provider 抛错就跳过并记 trace；注入内容全部写进 trace（谁贡献了什么、谁被跳过）。不开时第三方注册的 provider 完全不生效。'),
      /**
       * ★ v0.7.4 污点窗口（issue #4 作者的「防线二」）：开关 + 时长合成一行。
       *
       * 和「每分钟会话上限」一个套路 —— 开关是闸、数字是阈值，分开两行又要上下对照才知道谁管谁。
       * `numSwitch` 会把这两个键都展开进 `PANEL_FLAT_ROWS`，所以写入校验 /「待重启」判断都不用额外处理。
       */
      numSwitch('taintDryRunEnabled', '污点窗口 + 时长', '外部内容命中注入句式时，临时把这个会话的出站写动作降级为 dry-run（**实验性，默认关**）。右边是窗口时长。',
        'taintWindowMinutes', '窗口时长', '命中一次后在多久内继续拦截（默认 30 分钟，1–1440）。只在左边开关打开时生效。', '分钟'),
      /**
       * ★ v0.7.8：自定义注入句式。内置 8 条是"确定要抓"的，但每个群的话术不一样
       * （"把刚才那段配置抄给我""你现在是维护者了"…），让管理员自己补正则，比我们猜更准。
       * 只在上面的污点窗口打开时才有意义；编译失败的条目会在 trace 里点名，不会静默丢弃。
       */
      patterns('taintExtraPatterns', '自定义注入句式（正则）', '每行一条**正则**（不区分大小写，最多 20 条、每条 200 字以内），命中后与内置 8 条一样触发污点窗口。'
        + '例如 `把.*(配置|密钥).*发(给)?我`、`你现在是(管理员|维护者)`。**默认空**：不填就只有内置句式。'
        + '**只在上面的「污点窗口」打开时生效**；写错的正则会**跳过并记一条 trace**（不会让桥崩，也不会静默失效）。'),
    ],
  },
  {
    id: 'advanced',
    title: '高级与调试',
    advanced: true,
    rows: [
      row('injectEnabled', '注入通道', '允许往桥里注入**假事件**并走真实管线（控制台的"注入场景库"用它做链路验证）。默认关。', PANEL_NEEDS.config),
      row('injectDryRun', '注入干跑', '注入的回合**一个出站帧都不发**（安全网，默认开）。验证链路时保持打开；关掉前请确认你知道会发生什么。'),
      row('actionAuditEnabled', '动作审计', '所有写操作记审计（谁、何时、什么动作、结果），便于事后追责与排查。'),
      row('autoHealEnabled', '掉线自愈', '宿主/桥异常时按脚本自动恢复（默认关）。需要自己提供自愈命令，并确认它真的能拉起进程。', PANEL_NEEDS.config),
      row('webhookEnabled', 'Webhook 接收', '给外部系统一个入口，把事件推进桥里（默认关）。需要外部调用方与配套的密钥配置。', PANEL_NEEDS.config),
      row('groupReadEnabled', '只读群信息', '/群信息、/精华 等只读查询：群号、人数、管理员、群公告与精华消息。走 NapCat 的只读接口，不改动群里任何东西。', PANEL_NEEDS.napcat),
      row('memberQueryEnabled', '成员查询', '/成员 列出群成员（昵称、群名片、角色、入群时间），只读，不会 @ 到任何人；成员很多的大群可能分批返回。', PANEL_NEEDS.napcat),
      row('friendListEnabled', '好友列表', '列出机器人账号的好友（默认关，只读）。这等于把机器人的社交关系摊开，按需再开。', PANEL_NEEDS.napcat),
      row('historyQueryEnabled', '历史消息查询', '按需拉取群/私聊的历史消息（只读），用于补上下文。', PANEL_NEEDS.napcat),
    ],
  },
]

/**
 * 键 → 行描述（写入校验要知道这一行是布尔还是数值、范围多少）。
 *
 * ⚠️ 「开关 + 数值」那种合并行在**写配置**时仍是两个键（POST 一次只写一个），
 * 所以这里按**展开后的逐键描述**建表：合并行的开关记成 `type: 'boolean'`、
 * 内嵌数值记成 `type: 'number'`。别按 `PANEL_GROUPS.flatMap` 直接平铺——
 * 那样合并行的数值键会整个漏出白名单，界面上改数字会被 400 拒掉。
 */
function expandRow(entry) {
  if (entry.type === 'switchNumber' && entry.number) {
    return [{ ...entry, type: 'boolean' }, { ...entry.number, needs: entry.number.needs ?? '', type: 'number' }]
  }
  return [entry]
}
/** 面板允许改的键（白名单）：设置界面绝不变成"任意配置编辑器"。 */
export const PANEL_KEYS = PANEL_GROUPS.flatMap((group) => group.rows.flatMap((entry) => expandRow(entry).map((item) => item.key)))
export const PANEL_ROW_BY_KEY = new Map(PANEL_GROUPS.flatMap((group) => group.rows.flatMap((entry) => expandRow(entry).map((item) => [item.key, item]))))
/** 展开后的逐键行（测试用它数"到底几个开关几个数值"；合并行算两行）。 */
export const PANEL_FLAT_ROWS = [...PANEL_ROW_BY_KEY.values()]

/**
 * 这一行"现在是否不起作用"（v0.6.8 的 `dependsOn` 机制）。
 *
 * 两种方向都有，所以用 `dependsActive` 区分：
 *   - 默认（`dependsActive !== false`）：绑定的开关**关着**时失效。例：静默时段（`quietHours` ↔ `quietHoursEnabled`）；
 *   - `dependsActive: false`：绑定的开关**开着**时失效。例：两个白名单 ↔ `allowAllChats`（不设白名单）。
 */
export function rowInactive(entry, config = {}) {
  if (typeof entry.dependsOn !== 'string') return false
  const flag = config?.[entry.dependsOn] === true
  return entry.dependsActive === false ? flag : !flag
}

/**
 * 把生效配置整理成前端要的形状。
 * `defaults` 传 schema 的默认值（可选），仅在界面里做"非默认"提示用。
 * `fileValues` 传配置文件里的原始值（可选）：与生效值不一致 = 待重启。
 * `numberMeta` 传数值键的 `{ min, max, step, default }`（由 lib/index.js 从 schema 现读），
 * 数值行的范围**唯一来源**就是它——面板不抄第二份。
 */
/**
 * 「实验性」组的运行时状态行（v0.7.0）。
 *
 * 这是 issue #4 里 `chips`（provider 自己声明"工具在面板里的展示名与用途"）的**替代方案**：
 * 不再发明一套展示契约，而是如实显示**运行时事实**——出口挂没挂上（走哪条机制）、登记的 provider 有谁、
 * 最近一次注入注入了几个工具 / 跳过什么。数据来自运行中的桥（`bridge.extensionReport()`），
 * 拿不到（老宿主 / TUI / 面板被单独调用）就只给一行"开关状态"，不编造。
 */
export function extensionStatusLines(config = {}, extensions = null) {
  const enabled = config?.extensionToolsEnabled === true
  if (extensions === null || typeof extensions !== 'object') {
    return [enabled ? '扩展工具：已开启（运行时状态暂不可读）' : '扩展工具：未开启（默认关）']
  }
  const mount = extensions.mounted
  const mountText = mount === null || mount === undefined
    ? '出口：未挂载（宿主没有 ctx.provide/set，降级到模块注册表）'
    : mount.ok === true
      ? `出口：已挂载（via ${mount.via}）`
      : `出口：挂载失败（${mount.reason || '原因未知'}）`
  const providers = Array.isArray(extensions.providers) ? extensions.providers : []
  const lines = [
    mountText,
    `扩展工具：${enabled ? '已开启' : '未开启（默认关）'} · 已登记 provider：${providers.length === 0 ? '无' : providers.join('、')}`,
  ]
  /**
   * 用量计数（v0.7.0）：回答"到底有没有人在用这个 API"。
   * 全 0 时**整行不显示** —— 绝大多数人根本没用过出口，显示一串 0 只会让人怀疑
   * "你是不是在统计我 / 往哪儿上报"。数字出现时也必须一句话讲清它是**本机内存计数**。
   */
  const usage = extensions.usage
  if (usage && typeof usage === 'object') {
    const names = ['sendText', 'sendImage', 'sendFile', 'sendVoice', 'recall', 'react']
    const total = names.reduce((sum, name) => sum + (Number(usage[name]) || 0), 0)
    if (total > 0) {
      const parts = names.map((name) => `${name} ${Number(usage[name]) || 0}`)
      lines.push(`出口被调用（本机计数：只在内存里累加，不含消息内容、不外传、重启清零）：${parts.join(' · ')}`)
    }
  }
  const last = extensions.lastInjection
  if (last && typeof last === 'object') {
    const tools = Array.isArray(last.tools) ? last.tools : []
    const sections = Array.isArray(last.sections) ? last.sections : []
    const skipped = Number(last.skippedTotal) || 0
    lines.push(`最近一次注入（${last.chatKey ?? '?'}）：${tools.length} 个工具 / ${sections.length} 段提示`
      + (skipped > 0 ? ` · 跳过 ${skipped} 项：${(last.skipped ?? []).join('；')}` : ''))
  } else {
    lines.push('最近一次注入：还没有（provider 只在新建会话时注入）')
  }
  /**
   * v0.7.4 污点窗口：「现在有没有会话正被拦」必须一眼看到 ——
   * 这个功能的副作用就是"回复发不出去"，如果还要去翻 trace 才知道，用户只会以为机器人坏了。
   */
  const taint = extensions.taint
  if (taint && typeof taint === 'object') {
    const active = Array.isArray(taint.active) ? taint.active : []
    if (taint.enabled !== true) {
      // 关着时不刷屏：只在这组本来就显示状态时给一句，说明它没生效。
      lines.push(`污点窗口：未开启（默认关）· 窗口时长 ${Number(taint.windowMinutes) || 30} 分钟`)
    } else if (active.length === 0) {
      lines.push(`污点窗口：已开启（${Number(taint.windowMinutes) || 30} 分钟）· 当前没有会话在窗口内`)
    } else {
      const detail = active.slice(0, 3).map((item) => `${item.chatKey}（剩 ${Math.max(1, Math.ceil((Number(item.remainingMs) || 0) / 60_000))} 分钟）`).join('、')
      lines.push(`⚠️ 污点窗口：${active.length} 个会话正在被拦 —— ${detail}${active.length > 3 ? ' …' : ''}；这些会话的出站写动作不会发到 QQ`)
    }
  }
  return lines
}

/**
 * v0.7.9：出站脱敏的运行时状态（面板「安全与风控」组）。
 *
 * 为什么单独一行：这个功能**会改写到要发出去的文字**，用户必须一眼看到"它现在是开是关、
 * 已经改过多少条"；否则"为什么我发出去的 key 少了几个字符"就成了灵异事件。
 * 计数是内存计数（重启清零），和出口用量同一口径。
 */
export function redactStatusLines(config = {}, stats = null) {
  const enabled = config?.outboundRedactEnabled === true
  const block = config?.outboundRedactBlock === true
  const hits = Number(stats?.hits) || 0
  const blocked = Number(stats?.blocked) || 0
  if (!enabled) return ['出站脱敏：未开启（默认关）—— 发出去的密钥不会被改写']
  const mode = block ? '命中即拦截（整条不发）' : '命中即打码（保留首尾）'
  const counted = hits === 0 && blocked === 0
    ? '本机还没拦到过密钥'
    : `本机计数：脱敏 ${hits} 处 / 拦截 ${blocked} 条（内存计数，重启清零）`
  return [`出站脱敏：已开启 · ${mode}`, counted]
}

/**
 * v0.7.9：能力矩阵状态行（面板「高级与调试」组）。
 *
 * 回答的是"换了 OneBot 实现之后，哪些功能会失效"——以前只能等某个功能用到才炸。
 * 这里只做**展示**：探测与统计都在 `lib/capability.js` 与桥里，面板不重新实现判断逻辑。
 */
export function capabilityStatusLines(capability = null) {
  if (capability === null || typeof capability !== 'object') {
    return ['OneBot 能力矩阵：还没有结果（桥还没连上过，或宿主刚启动）']
  }
  try {
    const lines = capabilityLines(capability, { maxLines: 3 })
    // v0.7.9：有「能力体检」结论就多一行 —— 面板上看不出"这功能是真不支持、还是我还没用到"最容易误判。
    const conformance = capability.conformance
    if (conformance && typeof conformance === 'object' && conformance.summary) {
      const stamp = Number(conformance.at) > 0
        ? new Date(Number(conformance.at)).toLocaleString('zh-CN', { hour12: false })
        : ''
      lines.push(`能力体检${stamp ? `（${stamp}）` : ''}：${conformance.summary}`
        + (Array.isArray(conformance.provenUnsupported) && conformance.provenUnsupported.length > 0
          ? ` · 已确认不可用 ${conformance.provenUnsupported.join('、')}`
          : ''))
    } else {
      lines.push('能力体检：还没跑过（发 /能力体检 跑一次，只读探针）')
    }
    return lines
  } catch (error) {
    return [`OneBot 能力矩阵：读取失败（${String(error?.message ?? error).slice(0, 60)}）`]
  }
}

export function panelSnapshot(config = {}, { defaults = {}, fileValues = null, numberMeta = {}, extensions = null, capability = null, redactStats = null } = {}) {
  const groups = PANEL_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    advanced: group.advanced === true,
    // 组级提示（例如"这一组的能力插件不自带"）——原样带给界面。
    note: group.note ?? '',
    // 组级**运行时状态**（v0.7.0）：目前只有「实验性」组用，显示出口挂载/provider/最近一次注入。
    status: group.id === 'experimental' ? extensionStatusLines(config, extensions)
      : group.id === 'advanced' ? capabilityStatusLines(capability)
        : group.id === 'safety' ? redactStatusLines(config, redactStats) : [],
    rows: group.rows.map((entry) => {
      const value = config?.[entry.key]
      const fromFile = fileValues && Object.hasOwn(fileValues, entry.key) ? fileValues[entry.key] : null
      const hasDefault = Object.hasOwn(defaults, entry.key)
      const base = { key: entry.key, label: entry.label, hint: entry.hint, needs: entry.needs ?? '', type: entry.type ?? 'boolean' }
      /** 合并行：开关用一个键、数值用另一个键，两边各自判"默认/待重启"，一起带给前端。 */
      if (base.type === 'switchNumber') {
        const num = entry.number ?? {}
        const numValue = config?.[num.key]
        const numFromFile = fileValues && Object.hasOwn(fileValues, num.key) ? fileValues[num.key] : null
        const numMeta = numberMeta?.[num.key] ?? {}
        const numCurrent = Number(numValue)
        const numOk = Number.isFinite(numCurrent) ? numCurrent : (Number.isFinite(Number(numMeta.default)) ? Number(numMeta.default) : 0)
        const numFile = numFromFile === null ? null : Number(numFromFile)
        return {
          ...base,
          value: value === true,
          defaultValue: hasDefault ? defaults[entry.key] === true : null,
          nonDefault: hasDefault ? value !== defaults[entry.key] : false,
          fileValue: fromFile === null ? null : fromFile === true,
          pending: fromFile === null ? false : fromFile !== (value === true),
          number: {
            key: num.key,
            label: num.label,
            hint: num.hint,
            unit: num.unit ?? '',
            value: numOk,
            min: metaNumberOrNull(numMeta.min),
            max: metaNumberOrNull(numMeta.max),
            step: Number.isFinite(Number(numMeta.step)) && Number(numMeta.step) > 0 ? Number(numMeta.step) : 1,
            defaultValue: Object.hasOwn(defaults, num.key) ? Number(defaults[num.key]) : null,
            nonDefault: Object.hasOwn(defaults, num.key) ? numOk !== Number(defaults[num.key]) : false,
            fileValue: numFile !== null && Number.isFinite(numFile) ? numFile : null,
            pending: numFile !== null && Number.isFinite(numFile) ? numFile !== numOk : false,
          },
        }
      }
      if (base.type === 'number') {
        const meta = numberMeta?.[entry.key] ?? {}
        const current = Number(value)
        const currentOk = Number.isFinite(current) ? current : (Number.isFinite(Number(meta.default)) ? Number(meta.default) : 0)
        const fileNumber = fromFile === null ? null : Number(fromFile)
        return {
          ...base,
          value: currentOk,
          unit: entry.unit ?? '',
          /**
           * ⚠️ `Number(null) === 0`：schema 没写 `min()`/`max()` 时 meta 里是 `null`，
           * 直接 `Number.isFinite(Number(meta.min))` 会把它变成 **0**，于是界面把这一行夹死在 [0,0]、
           * 服务端也会拒掉任何非 0 的值（`botQq` 就是第一个撞上的键）。这里显式把 null 当"没有范围"。
           */
          min: metaNumberOrNull(meta.min),
          max: metaNumberOrNull(meta.max),
          step: Number.isFinite(Number(meta.step)) && Number(meta.step) > 0 ? Number(meta.step) : 1,
          // 「不是阈值、是标识」的数值行（`botQq`）不画 ± 按钮，见那行的注释。
          noStepper: entry.noStepper === true,
          defaultValue: hasDefault ? Number(defaults[entry.key]) : null,
          nonDefault: hasDefault ? currentOk !== Number(defaults[entry.key]) : false,
          fileValue: fileNumber !== null && Number.isFinite(fileNumber) ? fileNumber : null,
          pending: fileNumber !== null && Number.isFinite(fileNumber) ? fileNumber !== currentOk : false,
        }
      }
      /** 时段列表（v0.6.8）：值是一串 `H:MM-H:MM`；"待重启"按整串比较（顺序也算不同）。 */
      if (base.type === 'times') {
        const def = Array.isArray(defaults[entry.key]) ? defaults[entry.key].map(String) : null
        // 生效配置里没这个键时（宿主总会补默认值，这里是防御）回落 schema 默认，而不是显示成空。
        const list = Array.isArray(value) ? value.map(String) : (def ?? [])
        const fileList = Array.isArray(fromFile) ? fromFile.map(String) : null
        /**
         * `dependsOn`（v0.6.8）：绑定它的开关关着时，这些时段**不会生效**——把状态带给界面，
         * 免得用户"设了时段却还在回复"（2026-10-20 真机就是这么踩的：开关是另一个键）。
         */
        const switchOff = rowInactive(entry, config)
        return {
          ...base,
          value: list,
          maxRanges: QUIET_MAX_RANGES,
          inactive: switchOff,
          inactiveReason: switchOff ? `上面「${entry.switchLabel ?? entry.dependsOn}」的开关是关的 —— 这些时段现在不起作用` : '',
          defaultValue: def,
          nonDefault: def === null ? false : JSON.stringify(list) !== JSON.stringify(def),
          fileValue: fileList,
          pending: fileList === null ? false : JSON.stringify(fileList) !== JSON.stringify(list),
        }
      }
      /**
       * 号码列表（v0.6.8，白名单）：值是**数字**数组（schema 就是 `z.array(z.number())`，
       * OneBot 那边 `user_id` 也是数字），这里不做字符串化——否则写回去的类型就不对了。
       */
      if (base.type === 'list') {
        const def = Array.isArray(defaults[entry.key]) ? defaults[entry.key] : null
        const current = Array.isArray(value) ? value : (def ?? [])
        const fileList = Array.isArray(fromFile) ? fromFile : null
        // 白名单两个名单的 `dependsOn: 'allowAllChats'`（开关**打开**时名单失效）——见 `rowInactive`。
        const inactive = rowInactive(entry, config)
        return {
          ...base,
          value: current,
          maxItems: LIST_MAX_ITEMS,
          inactive,
          inactiveReason: inactive ? `上面「${entry.switchLabel ?? entry.dependsOn}」开着 —— 这个名单现在不起作用` : '',
          defaultValue: def,
          nonDefault: def === null ? false : JSON.stringify(current) !== JSON.stringify(def),
          fileValue: fileList,
          pending: fileList === null ? false : JSON.stringify(fileList) !== JSON.stringify(current),
        }
      }
      /**
       * 正则列表（v0.7.8，自定义注入句式）：值是**字符串数组**，原样带给界面（不做数字转换）。
       * `maxLength` 一起下发，界面据此在输入框旁给出字数提示；服务端仍会各自再校验一遍。
       */
      if (base.type === 'patterns') {
        const def = Array.isArray(defaults[entry.key]) ? defaults[entry.key].map(String) : null
        const current = (Array.isArray(value) ? value : (def ?? [])).map(String)
        const fileList = Array.isArray(fromFile) ? fromFile.map(String) : null
        return {
          ...base,
          value: current,
          maxItems: PATTERN_MAX_ITEMS,
          maxLength: PATTERN_MAX_LENGTH,
          defaultValue: def,
          nonDefault: def === null ? false : JSON.stringify(current) !== JSON.stringify(def),
          fileValue: fileList,
          pending: fileList === null ? false : JSON.stringify(fileList) !== JSON.stringify(current),
        }
      }
      return {
        ...base,
        value: value === true,        // `nonDefault` 只说"与默认值不同"——**方向**必须一起给：否则用户看到「非默认」会以为"关着"，
        // 而真机上多数情况其实是"默认关、我把它打开了"（用户原话："正常来讲非默认不是关着的吗？"）。
        defaultValue: hasDefault ? defaults[entry.key] === true : null,
        nonDefault: hasDefault ? value !== defaults[entry.key] : false,
        fileValue: fromFile === null ? null : fromFile === true,
        pending: fromFile === null ? false : fromFile !== (value === true),
      }
    }),
  }))
  return { ok: true, version: 1, groups }
}

// ── 文本层：行尾与末尾换行必须原样保留（Windows 上 patch 常是 CRLF，改动后混排会很难看）──

/** 行尾风格：出现 CRLF 就按 CRLF 写回。 */
function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** 拆行：同时记住行尾与"末尾有没有换行"。 */
function splitLines(text) {
  const eol = detectEol(text)
  const trailing = text.endsWith('\n')
  const body = trailing ? text.slice(0, -1) : text
  return { eol, trailing, lines: body.split(eol).map((line) => line.replace(/\r$/, '')) }
}

/** 拼回：行尾与末尾换行按拆行时的信息还原。 */
function joinLines(meta, lines) {
  return lines.join(meta.eol) + (meta.trailing ? meta.eol : '')
}

/**
 * 从 profile 的 patch 文本里读出本插件条目上某个键的原始值；没有则 null。
 *
 * v0.6.7 起也认**数值**（`chatTurnsPerMinute: 5`）：面板的数值控件要靠它判"待重启"。
 * v0.6.8 起也认**流式数组**（`quietHours: ["9:00-12:00","14:00-18:00"]`，也就是我们自己写出去的形状）。
 * 只认这几种字面量——引号包住的标量、`null`、块序列（`- 9:00-12:00` 那种多行写法）、表达式
 * 一律当"读不出"，绝不猜（调用方会把它显示成"未知/待重启"而不是编一个值）。
 */
export function readPatchValue(yamlText, key, pluginId = 'dsh-qq-onebot-bridge') {
  const block = pluginBlock(yamlText, pluginId)
  if (!block || !block.childIndent) return null
  const line = block.lines.find((entry) => keyLine(entry.text, key, block.childIndent))
  if (!line) return null
  const raw = line.text.slice(line.text.indexOf(':') + 1).trim()
  const bare = raw.replace(/\s+#.*$/, '')
  // 流式数组：只认**我们自己写出去的**那种（JSON 也合法 YAML）。
  if (bare.startsWith('[')) {
    try {
      const parsed = JSON.parse(bare)
      // **保留元素类型**：时段是字符串、白名单是数字——统一 map(String) 会让白名单的"更新中"永远判不出来。
      return Array.isArray(parsed) ? parsed : null
    } catch { return null }
  }
  // 引号包住的一律当"读不出"：`"7"` 在 YAML 里是**字符串**，而这几项 schema 是数字——
  // 把它显示成 7 会让人以为已经生效，实际宿主会校验失败。宁可显示"未知/待重启"。
  if (/^['"]/.test(bare)) return null
  if (bare === 'true') return true
  if (bare === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(bare)) return Number(bare)
  return null
}

/**
 * 在 patch 文本里 upsert 一个键（只动本插件条目）。
 * 返回 `{ ok, yaml, changed, reason }`——失败时 `yaml` 原样返回，调用方据此拒绝写入。
 *
 * 三条"不许猜"的规矩（都是对抗性审查用可复现用例逼出来的）：
 *   ① **缩进从文件里量**，不假设 `config` 的子键就是"父缩进 + 2"——用 `yaml.stringify(…, {indent:4})`
 *      产出的 4 空格 patch 是合法的，硬编码 +2 会把它改成非法 YAML，宿主下次启动直接拒载；
 *   ② **键必须正好在 config 的直接子层**（缩进 === childIndent）——否则多行字符串（`|` 块）里
 *      恰好长得像 `key: value` 的那一行会被当成真键，进而写出重复键或错误缩进；
 *   ③ **CRLF / 末尾换行原样保留**，比较时忽略行尾——否则"已经是这个值"永远判不出来，每点一次都重写。
 */
export function upsertPatchValue(yamlText, key, value, { pluginId = 'dsh-qq-onebot-bridge', note = '' } = {}) {
  // v0.6.7：布尔开关之外再接受**整数**（数值型风控阈值）。浮点数一律拒绝——
  // 这些键在 schema 里都是 `step(1)`，写个 3.5 进去宿主启动会校验失败。
  const isNumber = typeof value === 'number'
  const isList = Array.isArray(value)
  if (!isNumber && !isList && typeof value !== 'boolean') {
    return { ok: false, yaml: yamlText, changed: false, reason: '只接受布尔开关（true/false）、整数或数组' }
  }
  if (isNumber && !Number.isInteger(value)) return { ok: false, yaml: yamlText, changed: false, reason: '只接受整数（这几项阈值都是整数值）' }
  if (isList) {
    // 数组两种：纯字符串（静默时段）或纯正整数（白名单的 QQ 号/群号）；混着来一律拒。
    const allStrings = value.every((item) => typeof item === 'string')
    const allNumbers = value.every((item) => typeof item === 'number' && Number.isInteger(item) && item > 0)
    if (!allStrings && !allNumbers) {
      return { ok: false, yaml: yamlText, changed: false, reason: '数组要么全是字符串（时段），要么全是正整数（QQ 号/群号）' }
    }
  }
  const text = String(yamlText ?? '')
  const rendered = isList ? JSON.stringify(value) : (isNumber ? String(value) : (value ? 'true' : 'false'))
  /**
   * ★ v0.6.8 真机修复：插件装在 profile 里**不一定在 patch 层有自己条目**。
   *
   * 现在推荐（也是本机实际用法）是把包名放进 `package.json` 的 `dsh.profile.bundles`，
   * 由**包自带的 bundle 层**（本仓库根目录 `cordis.patch.yml` 里的 `- insert:`）挂载；
   * 那种情况下 profile 的 `cordis.patch.yml` 里压根没有 `- id: dsh-qq-onebot-bridge`，
   * 原来这里直接报"没有该条目（先把它装进该 profile）"——用户点任何开关都是这句红字。
   *
   * patch 文件本来就是"按 id 覆盖/追加条目"的地方（同一份文件里 mnemon 就是这么写的），
   * 所以正确做法是**没有条目就追加一条**（`- id: … / name: … / config:`），而不是拒绝。
   */
  const block = text.trim() === '' ? null : pluginBlock(text, pluginId)
  if (!block) return appendConfigEntry(text, pluginId, key, rendered)
  if (!block.configIndent) return insertConfigBlock(text, pluginId, block, key, rendered)
  if (!block.childIndent) {
    return {
      ok: false,
      yaml: text,
      changed: false,
      reason: block.sequenceChild
        ? `${pluginId} 的 config 块第一层是列表，量不出映射子键的缩进——宁可不写，也不产出宿主解析不了的 YAML`
        : `${pluginId} 的 config 块读不出子键缩进，为安全起见不写`,
    }
  }

  const meta = splitLines(text)
  const lines = meta.lines
  const existing = block.lines.find((entry) => keyLine(entry.text, key, block.childIndent))
  // 数组写成 YAML 的**流式序列**（`["a","b"]`，JSON 也是合法 YAML）：一行写完，行扫描不会被打乱。
  const next = `${block.childIndent}${key}: ${rendered}`

  if (existing) {
    if (existing.text.trimEnd() === next) return { ok: true, yaml: text, changed: false, reason: '已经是这个值' }
    /**
     * ★ v0.6.8：老键可能是**块写法**（`quietHours:` 换行后缩进的 `- 9:00-12:00`）。
     * 只换第一行会把下面那几行留在原地 ⇒ 同一个键两处定义、YAML 直接坏掉。
     * 所以把"该键的续行"（比子键缩进更深、或夹在其中的空行）一起换成这一行流式写法。
     */
    let removeEnd = existing.index + 1
    for (let scan = existing.index + 1; scan < lines.length; scan += 1) {
      if (lines[scan].trim() === '') continue          // 空行先跨过去，后面还有续行就一起删
      const indent = /^(\s*)/.exec(lines[scan])[1]
      if (indent.length > block.childIndent.length) { removeEnd = scan + 1; continue }
      break
    }
    lines.splice(existing.index, removeEnd - existing.index, next)
    return { ok: true, yaml: joinLines(meta, lines), changed: true, reason: '' }
  }
  // 新键插在 config 块**末尾**（下一条同缩进的内容之前），保留块内的注释与顺序。
  const insert = note ? [`${block.childIndent}# ${note}`, next] : [next]
  lines.splice(block.configEnd, 0, ...insert)
  return { ok: true, yaml: joinLines(meta, lines), changed: true, reason: '' }
}

/**
 * 这份 patch 里**没有本插件条目**时：按 patch 的口径**追加一条**（`- id / name / config`）。
 *
 * 依据（本机真机 2026-10-19）：插件可以作为 `dsh.profile.bundles` 的成员挂载，真正的挂载声明在
 * **包自带的 bundle 层**（本仓库根目录 `cordis.patch.yml` 的 `- insert:`），profile 的 patch 里
 * 可以一条都没有。而 profile patch 的用途正是"按 id 覆盖/追加条目"——同一份文件里 mnemon 就是
 * 这样写的。所以这里追加而不是报错。
 *
 * 只动**末尾**：已有条目、注释、顺序全部原样保留。
 */
function appendConfigEntry(text, pluginId, key, rendered) {
  const eol = detectEol(text)
  const entryText = [
    `- id: ${pluginId}`,
    `  name: ${pluginId}`,
    '  config:',
    `    ${key}: ${rendered}`,
  ].join(eol)
  const contentLines = text.split(/\r?\n/).filter((line) => line.trim() !== '' && !/^\s*#/.test(line))
  // 空文件 / 只有注释 / 空的 `[]` ⇒ 直接写成一个数组（注释留在前面，YAML 允许）。
  if (contentLines.length === 0 || (contentLines.length === 1 && contentLines[0].trim() === '[]')) {
    const head = text.replace(/\r?\n?\s*\[\]\s*$/, '').replace(/\s+$/, '')
    return { ok: true, yaml: (head === '' ? entryText : `${head}${eol}${entryText}`) + eol, changed: true, reason: '' }
  }
  // 顶层必须是"条目数组"：第一行内容不是 `- ...` 就不敢乱塞（可能是 `plugins:` 映射写法）。
  if (!/^\s*-/.test(contentLines[0])) {
    return {
      ok: false,
      yaml: text,
      changed: false,
      reason: `这份 patch 不是条目数组（第一行内容不是 - id: 开头的列表项），不敢往里加 ${pluginId} 条目；请手动加一条`,
    }
  }
  const base = text.endsWith('\n') || text.endsWith('\r') ? text : text + eol
  return { ok: true, yaml: base + entryText + eol, changed: true, reason: '' }
}

/** 条目存在但没有 `config:` 块：在 id 行后面补一个（缩进按条目自身推）。 */
function insertConfigBlock(text, pluginId, block, key, rendered) {
  const meta = splitLines(text)
  const lines = meta.lines
  const entryIndent = /^(\s*)/.exec(lines[block.start] ?? '')[1]
  const childIndent = `${entryIndent}  `
  lines.splice(block.start + 1, 0, `${childIndent}config:`, `${childIndent}  ${key}: ${rendered}`)
  return { ok: true, yaml: joinLines(meta, lines), changed: true, reason: '' }
}

/** 这一行是不是"正好在 childIndent 这一层"的 `key:`（注释行、多行字符串内容、更深层都不算）。 */
function keyLine(text, key, childIndent) {
  if (/^\s*#/.test(text)) return false
  const indent = /^(\s*)/.exec(text)[1]
  if (indent !== childIndent) return false
  return new RegExp(`^${childIndent}${key}\\s*:`).test(text)
}

/**
 * 定位本插件条目：`- id: <pluginId>` → 它下面的 `config:` → 子键缩进与结束位置。
 * 纯行扫描（不解析 YAML），因此能原样保留注释与排版。
 *
 * 同名条目有多条时取**最后一条**：DSH 自己（dsh-plugin-manager）也是 `findLast`，
 * 面板必须和平台改同一条，否则会出现"点了没反应"（平台生效的是后一条）。
 */
function pluginBlock(yamlText, pluginId) {
  const { lines } = splitLines(String(yamlText ?? ''))
  // id 允许加引号、也允许行尾注释——不然一个合法的 patch 会被误报成"没有这个条目"。
  const entryRe = new RegExp(`^(\\s*)-\\s+id:\\s*["']?${pluginId}["']?\\s*(?:#.*)?$`)
  let start = -1
  let entryIndent = ''
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = entryRe.exec(lines[index])
    if (match) { start = index; entryIndent = match[1]; break }
  }
  if (start === -1) return null

  // 条目的范围：到下一个同缩进的 `- ` 或文件末尾。
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (new RegExp(`^${entryIndent}-\\s`).test(lines[index])) { end = index; break }
  }
  const entryLines = []
  for (let index = start; index < end; index += 1) entryLines.push({ index, text: lines[index] })

  // config 块：条目内的 `config:` 行（值必须为空，带内容的 config 不是块）。
  const configLine = entryLines.find((entry) => /^\s*config\s*:\s*$/.test(entry.text))
  if (!configLine) return { start, end, lines: entryLines, configIndent: '', childIndent: '', configEnd: end }
  const parentIndent = /^(\s*)/.exec(configLine.text)[1]

  // 子键缩进**从文件里量**：config 之后第一行"比父缩进深"的内容行（跳过空行与注释）。
  let childIndent = ''
  let configEnd = end
  let sequenceChild = false
  for (let index = configLine.index + 1; index < end; index += 1) {
    const text = lines[index]
    if (text.trim() === '' || /^\s*#/.test(text)) continue
    const indent = /^(\s*)/.exec(text)[1]
    if (indent.length <= parentIndent.length) { configEnd = index; break }
    if (childIndent === '') {
      // 第一层就是序列项（`- 10001`）时**量不出映射子键的缩进**：宁可不写，
      // 也不能把 `key:` 写在序列缩进上（js-yaml 会判 bad indentation，宿主启动直接拒载）。
      if (/^\s*-\s/.test(text)) { sequenceChild = true; break }
      childIndent = indent
    }
  }
  if (sequenceChild) return { start, end, lines: entryLines, configIndent: `${parentIndent}  `, childIndent: '', configEnd, sequenceChild: true }
  // config 是空的（后面没有更深的内容行）：只能按 YAML 的 2 空格惯例给一个，且仅在此时才猜。
  if (childIndent === '') childIndent = `${parentIndent}  `
  return { start, end, lines: entryLines, configIndent: `${parentIndent}  `, childIndent, configEnd }
}

/** 面板返回给前端的"这批开关需要重启吗"说明（不猜：由 pending 徽标逐行显示）。 */
export const PANEL_NOTES = {
  apply: '写入 profile 的 cordis.patch.yml 后会触发 DSH 热重载该插件条目（QQ 桥会短暂重连一下），随后新开关生效；若宿主没开热重载，重启宿主后生效。写入是原子的（先写临时文件再改名），并留一份 .bak-qqai 备份。',
  /**
   * v0.7.8：把"面板只覆盖一部分配置"说清楚（issue #4 作者核对时发现过疑问）。
   * 实际比例：schema 234 个键，面板登记 83 个 —— 连接地址、端口、token、模型参数、提示词这类改起来要么需要
   * 专业知识、要么改错就把桥弄坏，所以刻意只留在配置文件里。这里不写具体数字（会过期），只讲边界与去处。
   */
  scope: '这里只放了**常用的功能开关**（约三分之一）：连接地址、端口、access token、模型参数、提示词这类配置**只在** '
    + 'profile 的 `cordis.patch.yml` 里改（改错容易把桥弄坏，所以不放进面板）。改完保存会热重载；'
    + '任何配置的**生效值**都能在 `/为什么` 与诊断包里看到 —— 面板上看不到的键，不代表它没生效。',
}

/** `git+https://github.com/me/repo.git` → `https://github.com/me/repo`（面板要的是能点的链接）。 */
export function normalizeRepoUrl(url) {
  const raw = String(url ?? '').trim()
  if (raw === '') return ''
  return raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
}

/**
 * 面板的「相关链接」一组（客户端把它渲染在**标题正下方、开关分组之前**）。
 *
 * 顺序（用户 2026-10-04 连着**七条**指示才定稿，其中两条是"改回去／再挪"）：
 *   "应该把账号登陆调到最上方" → "不对不对应该在QQ助手的下边" →
 *   "**还是挪回到之前的位置吧，直接把相关链接整体拉到最上边**" →
 *   "**再把调试台和更新日志换一下位置**" → "更新日志改到相关链接的最底下" →
 *   "嗯，还是把更新日志位置改回去吧" → "**调试台改到调试文档下方**"。
 *   ① **QQ助手账号**（机器人账号的登录/扫码；没登录时下面几项都没意义，所以永远第一）
 *   ② 更新日志  ③ 调试文档  ④ **调试台**（最底下）
 * ⇒ 结论：账号入口**永远第一**（它留在数组头上的字面量里），**「调试台」永远最后**
 *   （`panelFooterLinksWithConsole` 会按 id 找到它再加"运行中/未启动"状态，顺序不受影响）。
 *   别再把它拆成独立一段，也别再改这四条的先后。
 *
 * 目标全部由真实来源推导（版本/仓库来自 package.json，端口来自控制台的 qq-control.json），不写死地址；
 * 控制台 token **故意不进面板**（它是本机密钥），所以只给根地址 + 一句"怎么拿到带 token 的地址"。
 * 账号入口指向宿主自己的 `/qqai/account`：服务端读 NapCat 的 token 后 302，token 同样**不进面板载荷**。
 */
export function panelFooterLinks({ version = '', repoUrl = '', consolePort = 8799 } = {}) {
  const repo = normalizeRepoUrl(repoUrl)
  const links = [{
    id: 'account',
    label: 'QQ助手账号（登录 / 扫码）',
    // 用户 2026-10-04："这旁边加一个描述，比如需要先运行 NapCat"——
    // 点开只会跳到一个连不上的页面，先说明前提，并指一句该去哪儿启动。
    hint: '机器人账号的扫码 / 登录状态页；**需要先运行 NapCat**（没起来就点上面的「启动 NapCat」），点开就是带 token 的地址，不用手输',
    href: '/qqai/account',
  }]
  if (repo !== '') {
    links.push({
      id: 'changelog',
      label: version ? `更新日志（v${version}）` : '更新日志',
      hint: '每个版本的改动、修掉的缺陷与测试计数',
      href: `${repo}/blob/main/CHANGELOG.md`,
    })
    links.push({
      id: 'readme-debug',
      label: '调试文档',
      /**
       * v0.7.2：这一大段从 README 搬到了 `docs/DEBUG.md`（用户："太占 README 了"），
       * 所以链接跟着改指向文件本身 —— 原来的 `#调试…` 锚点已经不存在了。
       */
      hint: 'trace / 回放 / 体检 / 注入的完整用法（docs/DEBUG.md）',
      href: `${repo}/blob/main/docs/DEBUG.md`,
    })
  }
  // 调试台压在最底下（用户 2026-10-04："调试台改到调试文档下方"）——没有仓库信息时它也是最后一条。
  links.push({
    id: 'console',
    label: '调试台（独立控制台）',
    hint: `实时事件流 · trace 检索 · 体检 · 诊断包 · 离线回放 · 注入；本机 127.0.0.1:${consolePort}`,
    href: `http://127.0.0.1:${consolePort}/`,
  })
  // v0.7.11：账号中心（调试台里的 `/accounts` 页）——和调试台同一套"没跑就拉起来"的行为。
  // href 走宿主入口（不是裸 http）：入口会在服务端补上 token 再 302，省得用户看到"token 无效"。
  links.push({
    id: 'accounts',
    label: '账号中心（本地页面）',
    hint: 'QQ 登录状态 / 扫码登录 / 快速登录 / 自动登录 / 版本与设备；只在本机，token 不进面板',
    href: '/qqai/accounts',
  })
  return links
}

/**
 * 「相关链接」组 + **调试台的真实状态**。
 * 为什么要状态：调试台是**独立进程**（`control/`，默认 8799）。第一版只给了一个裸链接，用户点进去
 * 只看到连不上、还不知道为什么；v0.6.4 起**点这个链接会顺手把它拉起来**（见 `consoleEntry`），
 * 所以这里只负责如实标出"运行中 / 未启动（点一下会自动拉起）"。
 * `href` 指宿主自己的 `/qqai/console`：**跑着**就 302 到带 token 的地址（token 在服务端读出、
 * 不进面板载荷），**没跑**就先拉起、起来了再 302，起不来才回一页说明。
 */
export function panelFooterLinksWithConsole({
  version = '', repoUrl = '', consolePort = 8799, consoleRunning = false, startCommand = '',
} = {}) {
  const links = panelFooterLinks({ version, repoUrl, consolePort })
  const consoleLink = links.find((link) => link.id === 'console')
  if (consoleLink) {
    consoleLink.href = '/qqai/console'
    consoleLink.running = consoleRunning === true
    consoleLink.state = consoleRunning === true
      // 不把裸地址摆在这里：控制台**必须带 token** 才能交互，裸地址打开就是"满屏 token 无效的静态页"
      // （2026-10-06 真机踩到：用户以为"只是个页面、点哪都没反应"）。端口放到括号里做参考。
      ? `运行中 · 端口 ${consolePort}（点开自动带 token）`
      : '未启动 · 点一下会自动拉起'
    consoleLink.hint = consoleRunning === true
      ? '实时事件流 · trace 检索 · 体检 · 诊断包 · 离线回放 · 注入（点开就是带 token 的地址）'
      : `没在运行时点这个链接会自动把它拉起来（本机 node 进程，不用提权；手动命令仍是 ${startCommand || 'node control/bin/qq-control.mjs'}）`
  }
  return links
}
