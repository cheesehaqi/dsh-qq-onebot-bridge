/**
 * 控制台布局（左侧导航 + 分组 tab）的结构测试。
 *
 * 背景：调试台卡片越加越多，一根长滚动条找不到东西。现在按用途分成
 * 总览 / 实时事件 / 诊断与报告 / 录制·回放·注入 / 数据与任务 / 日志 六组；
 * 右上角只保留四个全局动作（刷新 / 一键体检 / 导出诊断包 / 体检报告），
 * 「语音调试」挪到左侧导航（它本来就是独立页）。
 *
 * 这些断言只读 HTML/脚本，不启动服务，避免"页面能开但分组漏了一张卡"这类静默问题。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const html = readFileSync(join(import.meta.dirname, '..', 'control', 'ui.html'), 'utf8')
const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? ''
const voiceHtml = readFileSync(join(import.meta.dirname, '..', 'control', 'voice.html'), 'utf8')

check('脚本可解析', (() => { try { new Function(script); return true } catch { return false } })())

const NAV_TABS = ['overview', 'live', 'diagnose', 'replay', 'data', 'logs', 'voice']
const navTabs = /<aside id="nav">[\s\S]*?<\/aside>/.exec(html)?.[0] ?? ''
const navItems = [...navTabs.matchAll(/class="navitem[^"]*" data-tab="([a-z]+)"/g)].map((m) => m[1])
check('左侧导航有七个分组且顺序固定', navItems.join(',') === NAV_TABS.join(','), navItems.join(','))
check('分组都有中文标题', ['总览', '实时事件', '诊断与报告', '录制 · 回放 · 注入', '数据与任务', '日志', '语音调试']
  .every((label) => navTabs.includes(label)))

const sectionTabs = [...html.matchAll(/<section class="card"[^>]*data-tab="([a-z]+)"/g)].map((m) => m[1])
check('每张卡片都归到某个分组', sectionTabs.length === 18, String(sectionTabs.length))
check('分组值都在导航里', sectionTabs.every((tab) => NAV_TABS.includes(tab)))
check('总览分组包含端口/操作/运行快照/登录二维码',
  sectionTabs.filter((tab) => tab === 'overview').length === 4, String(sectionTabs.filter((tab) => tab === 'overview').length))
check('诊断分组包含验收台/一键体检/变更历史/体检趋势',
  sectionTabs.filter((tab) => tab === 'diagnose').length === 4)
check('实时分组包含事件流与决策链', sectionTabs.filter((tab) => tab === 'live').length === 2)
check('数据分组包含群资产/性能/定时任务/群配置/群活跃', sectionTabs.filter((tab) => tab === 'data').length === 5)
check('群活跃卡读 /api/activity 并渲染趋势/活跃成员/CSV',
  html.includes('id="activityOut"') && html.includes('id="activityDays"')
  && script.includes("api('/api/activity?days='")
  && script.includes('topMembers') && script.includes('function downloadActivityCsv(')
  && script.includes('qq-activity-'), 'activity')

check('非当前分组的卡片默认隐藏（CSS）',
  /main > section\[data-tab\]\s*\{\s*display:\s*none/.test(html) && /\.tab-active\s*\{\s*display:\s*block/.test(html))
check('内容区单列铺开（两列高度差会在行尾留下大块空白）',
  /main \{[\s\S]*?grid-template-columns:minmax\(0,1fr\)/.test(html))
check('内容区不再限宽（宽屏右侧不会空一条）', !/main \{[\s\S]*?max-width:1200px/.test(html))
check('体检趋势卡接 /api/health/history 并定时刷新',
  html.includes('id="healthTrend"') && script.includes("api('/api/health/history?limit=30')")
  && /setInterval\(\(\) => \{ if \(!document\.hidden\) loadHealthHistory\(false\); \}, 30000\)/.test(script))
check('卡片按内容高度排列（行轨道被拉伸会制造假空隙）',
  /main \{[\s\S]*?align-content:start/.test(html))
check('showTab 负责切换可见性并同步 URL',
  /function showTab\(name, push = true\)/.test(script)
  && script.includes("classList.toggle('tab-active'") && script.includes('history.replaceState'))
check('深链 ?tab= 会选中对应分组', script.includes("get('tab') || 'overview'"))
check('「去看 →」会先切到目标卡片所在分组', /const section = el\.closest\('section\[data-tab\]'\)[\s\S]{0,120}showTab\(section\.dataset\.tab, false\)/.test(script))
check('分组里没有的 tab 名会回落到总览', /TAB_NAMES\.includes\(name\) \? name : 'overview'/.test(script))

// 右上角只留四个全局动作；语音调试挪进侧栏
const header = /<header>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? ''
const headerButtons = [...header.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1].trim())
check('右上角四个动作保持不变',
  headerButtons.join(',') === '刷新,一键体检,导出诊断包,体检报告', headerButtons.join(','))
check('右上角不再放语音调试', !header.includes('voiceLink') && !header.includes('语音调试'))
check('语音调试是控制台里的一个分组（不再跳独立页）',
  navTabs.includes('data-tab="voice"') && !navTabs.includes('class="navitem voiceLink"'))
check('语音分组用 iframe 装 /voice（懒加载 + 带 token）',
  /<iframe id="voiceFrame"[^>]*>/.test(html)
  && /function loadVoiceFrame\(\)/.test(script)
  && script.includes("'/voice?embed=1'")
  && script.includes("loadVoiceFrame();"))
check('体检报告仍是右上角的本地页入口', header.includes('class="reportLink"') && header.includes('/report'))
check('语音页支持 embed（隐藏大标题与回控制台）',
  /classList\.add\('embed'\)/.test(voiceHtml) && /body\.embed header \.brand/.test(voiceHtml))

// 改布局不能把卡片/函数弄丢
for (const id of ['ports', 'acceptance', 'streamBox', 'chain', 'diag', 'history', 'runtime',
  'inbox', 'archOut', 'perfOut', 'jobsOut', 'groupsOut', 'log', 'qrImg', 'healthTrend',
  'logQ', 'logErrors', 'logCount', 'activityOut', 'activityState', 'activityDays']) {
  if (!html.includes(`id="${id}"`)) { failed++; console.log('FAIL', `卡片元素丢了 #${id}`) }
}
check('关键卡片元素都还在', true)
for (const fn of ['showTab', 'focusCard', 'refresh', 'runDiagnose', 'loadAcceptance', 'loadChangeHistory', 'loadHealthHistory',
  'renderLog', 'downloadLog', 'copyLog', 'filteredStream', 'streamJsonl', 'downloadStream', 'copyStream', 'loadActivity', 'downloadActivityCsv']) {
  if (!new RegExp(`(async )?function ${fn}\\(`).test(script)) { failed++; console.log('FAIL', `缺少函数 ${fn}`) }
}
check('关键函数都还在', true)
check('日志页支持关键词/错误过滤与下载复制（token 打码）',
  html.includes('id="logQ"') && html.includes('id="logErrors"')
  && script.includes('function filteredLogLines(')
  && script.includes('function maskLogText(')
  && script.includes('maskLogText(rows.join')
  && script.includes('qq-${currentLog}-filtered.log')
  && html.includes('只看错误/告警'), 'logs')
check('页面报错卡不属于任何分组（永远可见）',
  /<section class="card badbox" id="pageErrors"[^>]*>/.test(html) && !/id="pageErrors"[^>]*data-tab=/.test(html))

// ---------------------------------------------------------- 命令面板（Ctrl+K） ----
for (const id of ['palette', 'paletteInput', 'paletteList']) {
  if (!html.includes(`id="${id}"`)) { failed++; console.log('FAIL', `命令面板缺少 #${id}`) }
}
check('实时事件可导出当前筛选（JSONL + token 打码）',
  html.includes('导出当前筛选') && script.includes('function streamJsonl(')
  && script.includes('maskLogText(filteredStream()')
  && script.includes('application/x-ndjson'), 'live')
check('命令面板记住最近使用（最多 5 条，⭐ 置顶）',
  script.includes('PALETTE_RECENT_KEY') && script.includes('function paletteRecentLabels(')
  && script.includes('function rememberPaletteUse(') && script.includes("'⭐ '"))
check('命令面板默认隐藏', /id="palette"[^>]*display:none/.test(html))
for (const fn of ['buildPaletteItems', 'renderPalette', 'runPalette', 'openPalette', 'closePalette']) {
  if (!new RegExp(`function ${fn}\\(`).test(script)) { failed++; console.log('FAIL', `缺少函数 ${fn}`) }
}
check('命令面板函数齐全', true)
check('Ctrl+K / Esc 都接了快捷键',
  /event\.key\.toLowerCase\(\) === 'k'/.test(script) && /event\.key === 'Escape'/.test(script))
check('面板项覆盖六个分组', /TAB_NAMES\.map\(\(name\) => \(\{ label: '分组：'/.test(script))
check('面板项覆盖卡片与四个全局动作',
  /label: '卡片：'/.test(script)
  && ['刷新状态', '一键体检', '导出诊断包', '打开体检报告', '打开语音调试']
    .every((label) => script.includes(`动作：${label}`)))
check('卡片跳转复用 focusCard', /label: '卡片：' \+ label, run: \(\) => focusCard\(target\)/.test(script))
check('面板输入支持上下键与回车',
  /ArrowDown/.test(script) && /ArrowUp/.test(script) && /event\.key === 'Enter'/.test(script))
check('侧栏有可见的「搜索 / 跳转」入口（不只靠快捷键）',
  /<button id="paletteOpen"[^>]*>[\s\S]*?Ctrl K/.test(html)
  && /getElementById\('paletteOpen'\)\.onclick = \(\) => openPalette\(\)/.test(script))
check('侧栏说明里也写了 Ctrl+K', /Ctrl\+K 搜索 \/ 跳转/.test(html))

// 侧栏动态选中块
check('侧栏有滑动选中块', /<div id="navGlow"><\/div>/.test(html) && /#navGlow \{[\s\S]*?transition:transform/.test(html))
check('选中块按真实布局对位（offsetTop/offsetHeight）',
  /function moveNavGlow\(animate = true\)/.test(script)
  && /active\.offsetHeight/.test(script) && /active\.offsetTop/.test(script))
check('切分组会移动选中块', /moveNavGlow\(\);[\s\S]{0,120}if \(push\)/.test(script))
check('首屏不播动画、窄屏隐藏、尊重 reduced-motion',
  /moveNavGlow\(false\)/.test(script) && /max-width: 900px/.test(script) && /prefers-reduced-motion: reduce/.test(html))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
