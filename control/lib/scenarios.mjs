/**
 * 注入场景库（v0.5.5 阶段 4）：把"要验一条什么路径"变成一次点击。
 *
 * 为什么需要它：注入通道（`qq-inject.jsonl` → 桥轮询 → 真实管线）能覆盖
 * 「群里 @我 / 撤回 / 入群申请 / 敏感词 / 管理员写操作」这些平时很难复现的分支，
 * 但每次手写 spec 既容易写错、也容易漏掉关键字段（比如 notice 注入必须带 groupId）。
 * 这里把**内置场景**固定下来：每个场景都声明它要验哪条链路，参数校验失败时给中文原因。
 *
 * 本模块零依赖、零 I/O：只产出 spec（形状与 lib/inbox.js 的 expandInjection 一致），
 * 由控制台走既有的 /api/inject 写进队列——它自己绝不碰文件、也绝不改配置。
 */

/** 消息类场景默认用的演示文本（不要写成会被关键词/敏感词误伤的内容）。 */
const DEMO_TEXT = '这条是控制台注入的演示消息，用来验证管线而不打扰真人'

/**
 * 内置场景表。`needs` 声明必填参数（控制台据此校验并给中文提示）；
 * `note` 说明它专门验证哪条链路——注入结果不好看时，先看这里对不对。
 */
export const SCENARIOS = [
  {
    id: 'group-mention',
    name: '群里 @我 说话',
    note: '验证「@ 门 → 会话 → 模型回合」的主链路',
    kind: 'message',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId, text }) => ({ kind: 'message', groupId, userId, atMe: true, text: text || DEMO_TEXT }),
  },
  {
    id: 'group-chat',
    name: '群里普通聊天（不 @）',
    note: '验证 replyOnlyWhenMentioned 的门控：应当**静默丢弃并写 reason**',
    kind: 'message',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId, text }) => ({ kind: 'message', groupId, userId, atMe: false, text: text || '大家好啊（没 @机器人）' }),
  },
  {
    id: 'group-recall',
    name: '有人撤回消息',
    note: '验证防撤回链路（notice group_recall）',
    kind: 'notice',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId }) => ({ kind: 'notice', noticeType: 'group_recall', groupId, userId, messageId: `inj-recall-${Date.now()}` }),
  },
  {
    id: 'poke',
    name: '被戳一戳',
    note: '验证戳一戳链路（notice notify/poke）与回戳/文案开关',
    kind: 'notice',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId }) => ({ kind: 'notice', noticeType: 'notify', subType: 'poke', groupId, userId }),
  },
  {
    id: 'group-increase',
    name: '有人入群',
    note: '验证入群欢迎 + 运营计数（join）',
    kind: 'notice',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId }) => ({ kind: 'notice', noticeType: 'group_increase', groupId, userId }),
  },
  {
    id: 'emoji-like',
    name: '有人给消息贴表情',
    note: '验证表情回应统计（notice group_msg_emoji_like）与 /赞榜 数据',
    kind: 'notice',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId, messageId }) => ({
      kind: 'notice', noticeType: 'group_msg_emoji_like', groupId, userId,
      messageId: messageId || `inj-msg-${Date.now()}`, likes: [{ emoji_id: '128077', count: 1 }], isAdd: true,
    }),
  },
  {
    id: 'join-request',
    name: '入群申请',
    note: '验证入群审批链路（request group/add）与 /待审',
    kind: 'request',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId, comment }) => ({ kind: 'request', requestType: 'group', subType: 'add', groupId, userId, comment: comment || '申请理由：想进来看看' }),
  },
  {
    id: 'friend-request',
    name: '加好友申请',
    note: '验证好友审批链路（request friend/add）',
    kind: 'request',
    needs: ['userId'],
    build: ({ userId, comment }) => ({ kind: 'request', requestType: 'friend', subType: 'add', userId, comment: comment || '加个好友' }),
  },
  {
    id: 'private-text',
    name: '私聊说话',
    note: '验证私聊主链路与私聊专属能力（正在输入等）',
    kind: 'message',
    needs: ['userId'],
    build: ({ userId, text }) => ({ kind: 'message', userId, text: text || '私聊注入测试' }),
  },
  {
    id: 'private-image',
    name: '私聊发图',
    note: '验证图片下载/识图链路（注入下取不到真实图片，走的是"取不到"的分支）',
    kind: 'message',
    needs: ['userId'],
    build: ({ userId }) => ({ kind: 'message', userId, text: '看这张图', images: ['https://example.invalid/demo.png'] }),
  },
  {
    id: 'ocr',
    name: '@我 发图 + /ocr',
    note: '验证 OCR 命令的离线闸门（dry-run 下应当明确说"不访问 QQ"）',
    kind: 'message',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId }) => ({ kind: 'message', groupId, userId, atMe: true, text: '/ocr', images: ['https://example.invalid/demo.png'] }),
  },
  {
    id: 'forward-card',
    name: '转发卡片（带展开正文）',
    note: '验证合并转发链路（注入时用 forwardText 提供确定性正文）',
    kind: 'message',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId }) => ({
      kind: 'message', groupId, userId, atMe: true, text: '',
      forwards: ['inj-forward-1'], forwardText: '（注入的转发正文）第一层：群里在讨论晚饭吃什么；第二层：结论是吃鱼。',
    }),
  },
  {
    id: 'admin-kick',
    name: '管理员 /kick（写操作）',
    note: '验证写操作过 ActionGate + 干跑不记账（注入回合 0 出站）',
    kind: 'message',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId, target }) => ({ kind: 'message', groupId, userId, atMe: true, text: `/kick ${target || '10001'}`, ats: [] }),
  },
  {
    id: 'ops-checkin',
    name: '/群打卡（原生签到）',
    note: '验证群运营写操作（set_group_sign）在注入回合被拦下且给出真实原因',
    kind: 'message',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId }) => ({ kind: 'message', groupId, userId, atMe: true, text: '/群打卡' }),
  },
  {
    id: 'ops-batch-kick',
    name: '/批量踢（两步确认第一步）',
    note: '验证批量踢的确认流程（第一步只提示，不发请求）',
    kind: 'message',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId, target }) => ({ kind: 'message', groupId, userId, atMe: true, text: `/批量踢 ${target || '10001'} 10002` }),
  },
  {
    id: 'badword',
    name: '触发敏感词',
    note: '验证内容过滤链路（撤回/禁言需先把 filterEnabled 打开，否则只留 reason）',
    kind: 'message',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId, word }) => ({ kind: 'message', groupId, userId, atMe: true, text: `这句里有敏感词：${word || '测试词'}` }),
  },
  {
    id: 'long-text',
    name: '超长消息',
    note: '验证长文本分片/合并转发阈值',
    kind: 'message',
    needs: ['groupId', 'userId'],
    build: ({ groupId, userId, length }) => ({ kind: 'message', groupId, userId, atMe: true, text: '长'.repeat(Math.max(50, Math.min(4000, Number(length) || 1800))) }),
  },
]

/** 给控制台用的清单（只暴露元数据，不带 build 函数，避免把函数塞进 JSON）。 */
export function listScenarios() {
  return SCENARIOS.map((scenario) => ({
    id: scenario.id,
    name: scenario.name,
    note: scenario.note,
    kind: scenario.kind,
    needs: [...scenario.needs],
  }))
}

/**
 * 按 id 生成注入 spec。
 * 返回 `{ ok, spec, reason, scenario }`：缺参数时 reason 直接说缺哪个，不猜默认值。
 */
export function buildScenario(id, params = {}) {
  const scenario = SCENARIOS.find((item) => item.id === String(id ?? '').trim())
  if (!scenario) {
    return { ok: false, spec: null, reason: `未知场景：${String(id ?? '')}（用 /api/scenarios 看清单）`, scenario: null }
  }
  const input = params && typeof params === 'object' ? params : {}
  const missing = []
  const normalized = {}
  for (const key of scenario.needs) {
    const raw = input[key]
    const value = key === 'userId' || key === 'groupId' || key === 'target' ? Number(raw) : raw
    if (key === 'userId' || key === 'groupId' || key === 'target') {
      if (!Number.isFinite(value) || value <= 0) missing.push(key === 'target' ? 'target（被操作的 QQ 号）' : key)
      else normalized[key] = value
    } else if (typeof raw !== 'string' || raw.trim() === '') {
      missing.push(key)
    } else {
      normalized[key] = raw.trim()
    }
  }
  if (missing.length > 0) {
    return { ok: false, spec: null, reason: `场景「${scenario.name}」缺少参数：${missing.join('、')}`, scenario: { id: scenario.id, name: scenario.name } }
  }
  // 可选参数原样带过去（文本、条数等），但只认字符串/数字，避免把对象塞进注入帧。
  for (const [key, value] of Object.entries(input)) {
    if (key in normalized) continue
    if (typeof value === 'string' || typeof value === 'number') normalized[key] = value
  }
  try {
    const spec = scenario.build(normalized)
    return { ok: true, spec, reason: '', scenario: { id: scenario.id, name: scenario.name, note: scenario.note } }
  } catch (error) {
    return { ok: false, spec: null, reason: `场景「${scenario.name}」生成失败：${error.message}`, scenario: { id: scenario.id, name: scenario.name } }
  }
}
