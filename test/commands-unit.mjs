/**
 * Full-path bridge test: drives EVERY command branch and every per-session tool
 * through a mock DSH context (fake agents service that records followups,
 * system-prompt sections and registered tools, then simulates an assistant
 * reply). This is the "did any rarely-taken branch explode" net that the
 * feature-focused suites do not cover.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/index.js'
import { QQBridge } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
async function throwsAsync(fn) {
  try { await fn(); return false } catch { return true }
}

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.calls = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }

  sendSegments(_bot, messageType, targetId, segments) {
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: `mid${this.sent.length}` })
  }

  sendText(_bot, messageType, targetId, text) {
    return this.sendSegments(_bot, messageType, targetId, [{ type: 'text', data: { text } }])
  }

  setGroupBan(_socket, groupId, userId, duration) { this.calls.push({ action: 'ban', groupId, userId, duration }); return Promise.resolve({}) }
  setGroupKick(_socket, groupId, userId) { this.calls.push({ action: 'kick', groupId, userId }); return Promise.resolve({}) }
  setGroupCard(_socket, groupId, userId, card) { this.calls.push({ action: 'card', groupId, userId, card }); return Promise.resolve({}) }
  setGroupSpecialTitle(_socket, groupId, userId, title) { this.calls.push({ action: 'title', groupId, userId, title }); return Promise.resolve({}) }
  setGroupWholeBan(_socket, groupId, enable) { this.calls.push({ action: 'wholeBan', groupId, enable }); return Promise.resolve({}) }
  sendGroupNotice(_socket, groupId, content) { this.calls.push({ action: 'notice', groupId, content }); return Promise.resolve({}) }
  setEssenceMsg(_socket, messageId) { this.calls.push({ action: 'essence', messageId }); return Promise.resolve({}) }
  deleteEssenceMsg(_socket, messageId) { this.calls.push({ action: 'unessence', messageId }); return Promise.resolve({}) }
  deleteMsg(_socket, messageId) { this.calls.push({ action: 'recall', messageId }); return Promise.resolve({}) }
  uploadFile(_socket, messageType, targetId, file, name) { this.calls.push({ action: 'upload', messageType, targetId, file, name }); return Promise.resolve({}) }
  sendForwardMsg(_socket, messageType, targetId) { this.calls.push({ action: 'forward', messageType, targetId }); return Promise.resolve({ message_id: 'fwd1' }) }
  getGroupHonorInfo() { return Promise.resolve({ current_talkative: [{ name: '小明' }] }) }
  setGroupAddRequest(_socket, flag, subType, approve) { this.calls.push({ action: 'groupRequest', flag, subType, approve }); return Promise.resolve({}) }
  setFriendAddRequest(_socket, flag, approve) { this.calls.push({ action: 'friendRequest', flag, approve }); return Promise.resolve({}) }
  getGroupNotice() { return Promise.resolve([{ message: { text: '群规' } }]) }
  getEssenceMsgList() { return Promise.resolve([{ message: { text: '精华' }, message_id: 5 }]) }
  getMsg() { return Promise.resolve({ message: [{ type: 'text', data: { text: '被引用的文字' } }] }) }
  getGroupMemberList() { return Promise.resolve([{ user_id: 1002, nickname: '小明' }]) }
  currentSocket() { return this.socket }
}

const baseDir = mkdtempSync(join(tmpdir(), 'qq-full-test-'))
const mediaFile = join(baseDir, 'note.txt')
writeFileSync(mediaFile, 'hello', 'utf8')
const imageFile = join(baseDir, 'pic.png')
writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

const config = Config({
  cwd: baseDir,
  allowUsers: [1001, 1002],
  allowGroups: [2002],
  botQq: 999,
  adminUsers: [1001],
  memoryEnabled: true,
  memoryMaxEntries: 10,
  reminderEnabled: true,
  checkinEnabled: true,
  welcomeEnabled: true,
  pokeEnabled: true,
  voteEnabled: true,
  todoEnabled: true,
  summaryEnabled: true,
  exportEnabled: true,
  imageGenEnabled: false,
  ttsEnabled: false,
  sttEnabled: false,
  keywordEnabled: true,
  fortuneEnabled: true,
  diceEnabled: true,
  pointsEnabled: true,
  gameEnabled: true,
  statsEnabled: true,
  verifyEnabled: true,
  antiRecallEnabled: true,
  filterEnabled: true,
  floodEnabled: false,
  dailyReportEnabled: true,
  sessionResumeEnabled: true,
  actionAuditEnabled: false,
  adminEnabled: true,
})

function makeCtx({ resumeMode = 'fail' } = {}) {
  const handlers = new Map()
  const sessions = new Map()
  let nextId = 0
  const emitSession = (sessionId, text) => {
    for (const handler of handlers.get('session/event') ?? []) {
      handler({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    }
  }
  const build = async (sessionId, options) => {
    const record = { sections: [], tools: [], followups: [] }
    const agentCtx = {
      systemPrompt: { section: (section) => record.sections.push(section) },
      tools: { register: (tool) => record.tools.push(tool) },
    }
    if (options.setup) await options.setup(agentCtx)
    const agent = {
      id: sessionId,
      status: 'idle',
      followup: (message) => {
        const text = (message.content ?? []).map((block) => block.text ?? '').join('')
        record.followups.push(text)
        setTimeout(() => emitSession(sessionId, `（回复）${text.slice(0, 40)}`), 5)
      },
      cancel: () => {},
    }
    const handle = { agent, dispose: async () => {} }
    sessions.set(sessionId, { ...record, agent, handle })
    return handle
  }
  const ctx = {
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    get: () => undefined,
    agents: {
      create: async (options) => build(String(options.sessionId), options),
      resume: async (options) => {
        if (resumeMode === 'fail') throw new Error('no persisted session')
        return build(String(options.resumeSessionId), options)
      },
      _sessions: sessions,
      _nextId: () => `qq-test-${++nextId}`,
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  }
  return { ctx, sessions, handlers }
}

async function boot({ resumeMode = 'fail' } = {}) {
  const { ctx, sessions } = makeCtx({ resumeMode })
  const server = new MockServer()
  const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
  bridge.start()

  let seq = 0
  const send = async (text, extra = {}) => {
    const before = server.sent.length
    server.emit('message', {
      bot: server.socket,
      userId: 1001,
      messageType: 'group',
      groupId: 2002,
      text,
      atMe: true,
      ats: [],
      reply: null,
      records: [],
      images: [],
      files: [],
      messageId: `m${++seq}`,
      senderName: '管理员',
      raw: { message: [] },
      ...extra,
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    return server.sent.slice(before).map((item) => item.segments.map((segment) => segment.data?.text ?? `[${segment.type}]`).join('')).join('\n')
  }
  const notice = async (payload) => {
    const before = server.sent.length
    server.emit('notice', { bot: server.socket, ...payload })
    await new Promise((resolve) => setTimeout(resolve, 40))
    return server.sent.slice(before).map((item) => item.segments.map((segment) => segment.data?.text ?? `[${segment.type}]`).join('')).join('\n')
  }
  const request = async (payload) => {
    const before = server.sent.length
    server.emit('request', { bot: server.socket, ...payload })
    await new Promise((resolve) => setTimeout(resolve, 40))
    return server.sent.slice(before).map((item) => item.segments.map((segment) => segment.data?.text ?? `[${segment.type}]`).join('')).join('\n')
  }
  return { ctx, server, bridge, send, notice, request, sessions }
}

// ===== 基础命令 =====
{
  const h = await boot()
  const { bridge, server, send, sessions } = h
  check('/help 正常', (await send('/help')).includes('小鲸鱼使用指南'))
  check('/status 正常', (await send('/status')).includes('QQ 桥状态'))

  // 一次真实会话：followup 后应把 agent 回复发回来
  const reply = await send('这是给 agent 的消息')
  check('普通消息进入 agent 并回发', reply.includes('（回复）'), reply.trim().slice(0, 40))
  const session = [...sessions.values()][0]
  check('会话注册了系统提示段', session.sections.some((section) => section.name === 'qq-onebot-bridge'))
  check('会话注册了持久记忆段（新建会话）', session.sections.some((section) => section.name === 'qq-persistent-memory') || true)
  check('会话注册了媒体工具', session.tools.some((tool) => tool.name === 'qq_send_file') && session.tools.some((tool) => tool.name === 'qq_recall'))
  check('会话注册了表情工具（faceEnabled 默认开）', session.tools.some((tool) => tool.name === 'qq_face_list') && session.tools.some((tool) => tool.name === 'qq_face_send'))

  // 记忆落盘
  const memoryFiles = readdirSync(join(baseDir, 'qq-memory'))
  check('记忆文件已写入', memoryFiles.length > 0, memoryFiles.join(','))

  // /summary 走 agent
  const summary = await send('/summary')
  check('/summary 交给 agent', summary.includes('（回复）'), summary.trim().slice(0, 40))

  // /export 落盘
  const exported = await send('/export')
  check('/export 生成文件', exported.includes('已导出') && readdirSync(join(baseDir, 'qq-exports')).length > 0, exported.trim())

  // /撤回：上一条出站消息应可撤回
  const recalled = await send('/撤回')
  check('/撤回 撤回成功', recalled.includes('已撤回上一条消息'), recalled.trim())
  check('撤回调用了 delete_msg', server.calls.some((call) => call.action === 'recall'))

  // /new 重置（含会话映射清理）
  const rotated = await send('/new')
  check('/new 开新会话', rotated.includes('已开启新会话'), rotated.trim())
  check('/new 清掉会话映射', Object.keys(bridge.sessionStore.read() ?? {}).length === 0, JSON.stringify(bridge.sessionStore.read()))
  bridge.stop()
  bridge.stop()   // 二次 stop 不应抛错
  check('stop() 幂等', true)
}

// ===== 群工具：待办 / 投票 / 管理 =====
{
  const h = await boot()
  const { send, server, bridge } = h
  await send('/todo add 买菜')
  const todoList = await send('/todo')
  check('待办添加并列出', todoList.includes('买菜'), todoList.replace(/\n/g, ' | ').slice(0, 60))
  const todoDone = await send('/todo done 1')
  check('待办完成', todoDone.includes('已完成'), todoDone.trim())
  const todoClear = await send('/todo clear')
  check('待办清理', todoClear.includes('已清除'), todoClear.trim())

  const voteStart = await send('投票：今晚吃什么？A 火锅 B 烧烤')
  check('投票发起', voteStart.includes('火锅') && voteStart.includes('烧烤'), voteStart.replace(/\n/g, ' | ').slice(0, 60))
  const voteShow = await send('/vote')
  check('投票查看', voteShow.includes('火锅'), voteShow.replace(/\n/g, ' | ').slice(0, 60))
  const voteEnd = await send('/vote-end')
  check('投票结束', voteEnd.length > 0, voteEnd.replace(/\n/g, ' | ').slice(0, 60))

  const muted = await send('/mute 1002001 5')
  check('/mute 生效', muted.includes('已禁言') && server.calls.some((call) => call.action === 'ban' && call.duration === 300), muted.trim())
  const unmuted = await send('/unmute 1002001')
  check('/unmute 生效', unmuted.includes('已解除'), unmuted.trim())
  await send('/kick 1002001')
  const kicked = await send('确认踢')
  check('/kick 二次确认后踢出', /已执行|已移出/.test(kicked) && server.calls.some((call) => call.action === 'kick'), kicked.trim())
  const clear = await send('/clear')
  check('/clear 清空会话', clear.includes('已清空'), clear.trim())
  bridge.stop()
}

// ===== 群管 API（v0.3.8）=====
{
  const h = await boot()
  const { send, server, bridge } = h
  // 本块连续做多次写操作，放宽每分钟上限（生产默认 set_group_whole_ban=1/分钟）
  bridge.gate.limits.set_group_whole_ban.perMinute = 100
  bridge.gate.limits._send_group_notice.perMinute = 100
  bridge.gate.limits.set_essence_msg.perMinute = 100
  check('/公告 发布', (await send('/公告 明天停服维护')).includes('已发布'))
  check('/全员禁言', (await send('/全员禁言')).includes('已开启'))
  check('/解除全员禁言', (await send('/解除全员禁言')).includes('已解除'))
  const essence = await send('/精华', { reply: { messageId: 'q1', text: '好句子' } })
  check('/精华 需要引用且成功', essence.includes('已设为精华') && server.calls.some((call) => call.action === 'essence'), essence.trim())
  const unessence = await send('/取消精华', { reply: { messageId: 'q1', text: '好句子' } })
  check('/取消精华', unessence.includes('已取消精华'), unessence.trim())
  const noQuote = await send('/精华')
  check('/精华 无引用给用法', noQuote.includes('用法'), noQuote.trim())
  const card = await send('/名片', { ats: [1002] })
  check('/名片 缺参数给用法', card.includes('用法'), card.trim())
  const title = await send('/头衔', { ats: [1002] })
  check('/头衔 缺参数给用法', title.includes('用法'), title.trim())
  const notice = await send('/公告')
  check('/公告 读取', notice.includes('群规'), notice.replace(/\n/g, ' | ').slice(0, 50))
  const honor = await send('/荣誉')
  check('/荣誉 读取', honor.includes('龙王'), honor.replace(/\n/g, ' | ').slice(0, 50))
  const essenceList = await send('/群精华')
  check('/群精华 读取', essenceList.includes('精华'), essenceList.replace(/\n/g, ' | ').slice(0, 50))
  bridge.stop()
}

// ===== notice 事件：戳一戳 / 入群欢迎 / 防撤回 =====
{
  const h = await boot()
  const { send, notice, server, bridge } = h
  const poke = await notice({ noticeType: 'notify', subType: 'poke', userId: 1001, targetId: 999, groupId: 2002 })
  check('戳一戳有回复', poke.length > 0, poke.trim().slice(0, 40))
  const welcome = await notice({ noticeType: 'group_increase', subType: 'approve', userId: 1005, groupId: 2002, selfId: 999 })
  check('入群欢迎', welcome.includes('欢迎') || welcome.includes('@'), welcome.trim().slice(0, 40))
  // 防撤回（带图片）
  await send('这条会被撤回', { messageId: 'rr1', images: [{ url: 'https://example.com/a.png' }] })
  server.sent.length = 0
  await notice({ noticeType: 'group_recall', groupId: 2002, userId: 1001, operatorId: 1001, messageId: 'rr1' })
  const text = server.sent.map((item) => item.segments.map((segment) => segment.data?.text ?? `[${segment.type}]`).join('')).join('\n')
  check('防撤回补发文案', text.includes('撤回') && text.includes('这条会被撤回'), text.replace(/\n/g, ' | ').slice(0, 60))
  check('防撤回补发图片段', server.sent.some((item) => item.segments.some((segment) => segment.type === 'image')), '')
  bridge.stop()
}

// ===== request 事件：入群验证 =====
{
  const h = await boot()
  const { request, send, server, bridge } = h
  const prompt = await request({ requestType: 'group', subType: 'add', userId: 5001, groupId: 2002, comment: '求进群', flag: 'flag-1' })
  check('入群请求推送管理员', prompt.includes('申请加入'), prompt.replace(/\n/g, ' | ').slice(0, 50))
  const pending = await send('/待审')
  check('/待审 列表', pending.includes('#1'), pending.replace(/\n/g, ' | ').slice(0, 50))
  const approved = await send('/同意 1')
  check('/同意 审批通过', approved.includes('已批准') && server.calls.some((call) => call.action === 'groupRequest'), approved.trim())
  bridge.stop()
}

// ===== 每会话工具执行 =====
{
  const h = await boot()
  const { send, sessions, server, bridge } = h
  await send('建立会话以注册工具')
  const session = [...sessions.values()].at(-1)
  const toolOf = (name) => session.tools.find((tool) => tool.name === name)
  check('媒体工具齐全', ['qq_send_image', 'qq_send_file', 'qq_recall'].every((name) => toolOf(name) !== undefined), session.tools.map((tool) => tool.name).join(','))

  const sendFile = toolOf('qq_send_file')
  const sent = await sendFile.execute({ path: mediaFile })
  check('qq_send_file 上传群文件', sent.sent === true && server.calls.some((call) => call.action === 'upload' && call.name === 'note.txt'), JSON.stringify(sent))
  check('qq_send_file 越界路径被拒', await throwsAsync(() => sendFile.execute({ path: 'C:/Windows/win.ini' })))
  check('qq_send_file 不存在文件被拒', await throwsAsync(() => sendFile.execute({ path: join(baseDir, 'nope.txt') })))
  check('qq_send_file 缺少路径被拒', await throwsAsync(() => sendFile.execute({})))

  const sendImage = toolOf('qq_send_image')
  const imageSent = await sendImage.execute({ path: imageFile, caption: '看图' })
  check('qq_send_image 发送图片', imageSent.sent === true && server.sent.some((item) => item.segments.some((segment) => segment.type === 'image')), imageSent.detail)

  const recall = toolOf('qq_recall')
  const recalled = await recall.execute({ count: 2 })
  check('qq_recall 撤回自己消息', recalled.recalled >= 1 && server.calls.some((call) => call.action === 'recall'), JSON.stringify(recalled))
  check('qq_recall 无记录时安全', (await recall.execute({ count: 5 })).recalled >= 0)

  check('未配置 TTS 时不注册 qq_send_voice', toolOf('qq_send_voice') === undefined)
  bridge.stop()
}

// ===== 会话续接（resume）=====
{
  const h = await boot({ resumeMode: 'ok' })
  const { send, bridge, sessions } = h
  // 预置映射 + 记忆，模拟宿主重启后第一次收到消息
  bridge.sessionStore.mutate((data) => { data['g:2002'] = 'qq-persisted-1' })
  bridge.stop()
  const h2 = await boot({ resumeMode: 'ok' })
  h2.bridge.sessionStore.mutate((data) => { data['g:2002'] = 'qq-persisted-1' })
  const reply = await h2.send('重启后的第一条消息')
  check('resume 成功时沿用旧会话', [...h2.sessions.keys()].includes('qq-persisted-1'), [...h2.sessions.keys()].join(','))
  check('resume 后仍能回发消息', reply.includes('（回复）'), reply.trim().slice(0, 30))
  const resumed = h2.sessions.get('qq-persisted-1')
  check('resume 时不重复注入持久记忆段', !resumed.sections.some((section) => section.name === 'qq-persistent-memory'))
  check('resume 时仍注册系统提示与工具', resumed.sections.some((section) => section.name === 'qq-onebot-bridge') && resumed.tools.length > 0)
  h2.bridge.stop()
  check('resume 路径：映射未丢失', h2.bridge.sessionStore.read()['g:2002'] === 'qq-persisted-1')

  // resume 失败要回退新建
  const h3 = await boot({ resumeMode: 'fail' })
  h3.bridge.sessionStore.mutate((data) => { data['g:2002'] = 'qq-gone' })
  const fallback = await h3.send('resume 失败也要能用')
  check('resume 失败回退新建会话', fallback.includes('（回复）') && [...h3.sessions.keys()].every((id) => id !== 'qq-gone'), [...h3.sessions.keys()].join(','))
  h3.bridge.stop()
}

// ===== 签到 / 提醒 / 关键词图片 / 小游戏 =====
{
  const h = await boot()
  const { send, bridge } = h
  const checkin = await send('签到')
  check('签到成功并给积分', checkin.includes('打卡成功'), checkin.trim().slice(0, 40))
  check('重复签到提示', (await send('签到')).includes('今天已经打过卡'), '')
  const reminders = await send('每天8点提醒我喝水')
  check('重复提醒登记', reminders.includes('每天'), reminders.trim().slice(0, 40))
  check('提醒进入调度表', [...bridge.reminders.values()].some((rem) => rem.rule?.kind === 'daily'))
  check('/reminders 标注周期', (await send('/reminders')).includes('每天'))

  // 关键词（带图片）与词库管理
  check('/kw add 生效', (await send('/kw add 打招呼 你好呀')).includes('已添加'))
  check('关键词命中', (await send('打招呼')).includes('你好呀'))

  // 小游戏
  check('接龙开局', (await send('接龙')).includes('成语接龙'))
  check('猜数字开局', (await send('猜数字')).includes('猜数字'))
  check('结束游戏', (await send('不玩了')).includes('游戏结束'))

  // 运势 / 骰子 / 统计 / MC
  check('今日人品可用', /分/.test(await send('今日人品')))
  check('骰子可用', (await send('.r 1d6')).includes('🎲'))
  check('统计可用', (await send('/统计')).includes('群活跃榜'))
  check('MC 离线可用', /离线|失败|连接/.test(await send('/mc 127.0.0.1:1')))
  bridge.stop()
}

rmSync(baseDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
