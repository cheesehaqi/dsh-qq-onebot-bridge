/**
 * v0.6「轻量化设计」：DSH 设置 → QQ助手。
 *
 * 这是**客户端 bundle**：DSH 的模块加载器按 `package.json` 的
 * `dsh.client`（`platform: web`）+ `exports["./client"]` 把它喂给浏览器，
 * 入口形态与官方/第三方插件一致：
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 *
 * 面板只做两件事：`GET /qqai/panel` 读当前生效值，`POST /qqai/panel/set` 写回
 * profile 的 cordis.patch.yml（服务端路由见 lib/settings-routes.js）。
 * 不引第三方 UI 库（只用 react），样式全走 DSH 主题变量，所以深浅色都跟原生一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-onebot-bridge',
  factory: (require) => {
    // ⚠️ 平台契约（v0.6 真机事故的教训）：客户端 bundle 是用**经典 <script>** 注入的，
    // 页面里没有 `exports` / `module`——每个 bundle 都得像平台自己的 bundle 那样自带这两行
    // CJS 垫片；而加载器只把 `factory(require)` 的**返回值**当作模块导出
    // （见 dsh-client-modules/lib/client.js:683）。少了这两行，宿主启动就会
    // 直接报 `dsh-qq-onebot-bridge: import failed: exports is not defined` 而整个起不来。
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /**
     * 这份**前端 bundle** 的版本（改客户端代码时记得同步；`settings-unit` 有断言钉死它 = package.json 版本）。
     *
     * 它和服务端载荷里的 `pluginVersion` 对不上，就说明"页面攥着旧的前端、宿主已经换了新代码"——
     * 浏览器只在**页面加载时**取一次 bundle，没法热替换，所以只能刷新一次页面。
     * 与其让用户对着没变化的界面猜，不如自己认出来并给一个「刷新页面」按钮（见下面的 qqai-stale 横幅）。
     */
    const CLIENT_VERSION = '0.8.0'

    const CSS = `
.qqai-wrap{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary,#111)}
.qqai-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.qqai-title{font-size:15px;font-weight:600}
/* 标题右侧的版本号：小一号、次要色——它是"宿主加载的那份代码"的版本，用来判断要不要重载。 */
.qqai-ver{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary,#6b7280)}
/* 面板搜索（v0.6.9）：10 组 78 键，靠滚太慢。纯前端过滤，靠右对齐挨着「刷新」。 */
/* 「实验性」组的运行时状态行（v0.7.0）：出口挂载 / provider / 最近一次注入。 */
.qqai-status{margin:8px 12px 0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f6f7f9);font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-all}
.qqai-search{margin-left:auto;width:170px;height:26px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l3,#0000001f);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font:inherit;font-size:12px}
.qqai-search:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#2563eb));outline-offset:1px}
.qqai-meta{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:1.6}
.qqai-group{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}
.qqai-group>summary{cursor:pointer;padding:10px 12px;font-weight:600;list-style:none;background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.qqai-group>summary::-webkit-details-marker{display:none}
.qqai-row{display:flex;align-items:center;gap:12px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1,#eef0f3)}
.qqai-row:first-of-type{border-top:none}
.qqai-row:hover{background:var(--dsw-alias-bg-layer-2,#f8fafc)}
.qqai-text{flex:1;min-width:0}
.qqai-label{display:block}
.qqai-hint,.qqai-key{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;line-height:1.5}
.qqai-key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.qqai-badge{margin-left:6px;padding:1px 6px;border-radius:999px;font-size:10px;color:var(--dsw-alias-state-warn-primary,#b45309);border:1px solid currentColor}
.qqai-need{margin-left:6px;padding:1px 6px;border-radius:999px;font-size:10px;white-space:nowrap;color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-bg-layer-2,#f1f5f9);border:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.qqai-hint b{font-weight:600;color:var(--dsw-alias-label-primary,#111)}
/* 开关照抄平台自己的 Switch.module.css（dsh-client-ui-primitives/lib/Switch.module.css）：
   之前我用的是"卡片同色轨道 + 白圆点"，浅色主题下 OFF 态等于隐形（用户反馈"关了以后感觉按钮消失了一样"）。
   官方取值（design token 表实测）：轨道 OFF = --dsw-alias-border-l3（浅色 #0000001f / 深色 #ffffff29），
   轨道 ON = --dsw-alias-brand-primary（浅色近黑 / 深色近白），圆点 OFF = --dsw-alias-switch-thumb，
   圆点 ON = --dsw-alias-label-primary-foreground；状态一律挂 aria-checked，视觉与无障碍语义不会打架。 */
.qqai-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,#0000001f);cursor:pointer;transition:background .12s ease}
.qqai-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#1f2328)}
.qqai-switch:disabled{cursor:default;opacity:.5}
.qqai-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:2px}
.qqai-knob{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .12s ease}
.qqai-switch[aria-checked="true"] .qqai-knob{background:var(--dsw-alias-label-primary-foreground,#fff);transform:translateX(16px)}
.qqai-flash{padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f1f5f9);color:var(--dsw-alias-state-success-primary,#15803d)}
.qqai-err{padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-state-error-primary,#dc2626);white-space:pre-wrap}
/* 前端 bundle 落后于宿主时的那条横幅（黄色，跟错误条区分开）。 */
.qqai-stale{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary,#b45309);background:var(--dsw-alias-bg-layer-2,#fffbeb);color:var(--dsw-alias-state-warn-primary,#b45309);font-size:12px}
.qqai-stale button{margin-left:auto;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-state-warn-primary,#b45309);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.qqai-stale button:hover{background:var(--dsw-alias-bg-layer-1,#fff)}
.qqai-warn{padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary,#b45309);color:var(--dsw-alias-state-warn-primary,#b45309)}
.qqai-note{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f3);background:var(--dsw-alias-bg-layer-2,#f8fafc);color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;line-height:1.6}
.qqai-note b{font-weight:600;color:var(--dsw-alias-label-primary,#111)}
/* 「相关链接」整组在页面的最上边（标题正下方、开关分组之前）：账号入口是组里第一条。
   2026-10-04 定稿："还是挪回到之前的位置吧，直接把相关链接整体拉到最上边"。
   注意：整行就是一个链接（含右边那段灰色说明），所以行本身要 cursor:pointer、且不要默认下划线。 */
.qqai-links{display:flex;flex-direction:column;gap:8px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.qqai-link-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;text-decoration:none;cursor:pointer}
.qqai-link{color:var(--dsw-alias-brand-primary,#2563eb);font-weight:600}
.qqai-link-row:hover .qqai-link{text-decoration:underline}
/* 快捷操作：启动 NapCat / 重新登录。按钮照平台的做法：细边框 + 主题 token，不自己配色。 */
.qqai-actions{display:flex;flex-direction:column;gap:8px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.qqai-action-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.qqai-action{border:1px solid var(--dsw-alias-border-l3,#0000001f);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
.qqai-action:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.qqai-qr{display:flex;gap:12px;align-items:flex-start}
.qqai-qr-img{display:block;width:176px;height:176px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:#fff}
.qqai-qr-side{display:flex;flex-direction:column;gap:6px;font-size:12px}
.qqai-qr-title{font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.qqai-action:disabled{cursor:default;opacity:.5}
/* 数值控件（v0.6.7）：风控阈值这类"数字"，不要再让用户去手改 YAML。
   观感对齐平台：细边框 + 主题 token，−/+ 与输入框同高。
   输入框必须关掉原生上下箭头（Chromium 的 ::-webkit-inner/outer-spin-button）：
   我们两边已经有 −/+ 了，那个又小又难点，纯属重复，视觉上也脏（用户 2026-10-17：「右边的上下控制层
   感觉没必要啊，而且还不方便，影响美观」）。appearance:textfield 是 Firefox 的写法，一并带上。
   注意：这段是 JS 模板字符串里的 CSS，注释里不能出现反引号（会把模板提前闭合），
   也不要写 markdown 的星号强调——<style> 的文本会被浅渲染测试当成页面文字收进去。 */
.qqai-num{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.qqai-num-btn{width:26px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l3,#0000001f);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font:inherit;font-size:14px;line-height:1;cursor:pointer}
.qqai-num-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.qqai-num-btn:disabled{cursor:default;opacity:.4}
.qqai-num-input{width:60px;height:24px;box-sizing:border-box;padding:0 6px;border:1px solid var(--dsw-alias-border-l3,#0000001f);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font:inherit;font-size:12px;text-align:center;-moz-appearance:textfield;appearance:textfield}
.qqai-num-input::-webkit-outer-spin-button,.qqai-num-input::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0}
/* 没有 ± 的那种数值行（如 AI 账号）：输入框放宽，11 位 QQ 号才放得下。 */
.qqai-num-input.wide{width:112px}
.qqai-num-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#2563eb));outline-offset:1px}
.qqai-unit{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap}
/* 「开关 + 数值」合并行右侧那一组：开关与数字并排（中间留 10px，别让它们粘在一起）。 */
.qqai-row-ctl{display:flex;align-items:center;gap:10px;flex:0 0 auto}
/* 时段列表（v0.6.8）：每段一行「[开始] – [结束] ×」，最下面一个「+ 加一段」。 */
.qqai-times{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:0 0 auto}
.qqai-time{display:flex;align-items:center;gap:6px}
.qqai-time-input{height:24px;box-sizing:border-box;padding:0 4px;border:1px solid var(--dsw-alias-border-l3,#0000001f);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font:inherit;font-size:12px}
.qqai-time-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#2563eb));outline-offset:1px}
.qqai-time-dash{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}
.qqai-time-del{width:24px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l3,#0000001f);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;font-size:13px;line-height:1;cursor:pointer}
.qqai-time-del:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#b91c1c);background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.qqai-time-add{align-self:flex-end;height:24px;padding:0 8px;border:1px dashed var(--dsw-alias-border-l3,#0000001f);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;font-size:12px;cursor:pointer}
.qqai-time-add:hover:not(:disabled){color:var(--dsw-alias-label-primary,#111);border-color:var(--dsw-alias-brand-primary,#2563eb)}
.qqai-time-add:disabled{cursor:default;opacity:.4}
.qqai-time-raw{font-size:12px;color:var(--dsw-alias-state-warn-primary,#b45309)}
/* 号码列表（白名单）：一条一个 chip，下面一个输入框 + 添加。 */
.qqai-list{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:0 0 auto}
.qqai-chip{display:flex;align-items:center;gap:6px;padding:2px 2px 2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,#0000001f);background:var(--dsw-alias-bg-layer-2,#f6f7f9)}
.qqai-chip-text{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary,#111)}
.qqai-list-input{width:120px;height:24px;box-sizing:border-box;padding:0 6px;border:1px solid var(--dsw-alias-border-l3,#0000001f);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font:inherit;font-size:12px}
.qqai-list-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#2563eb));outline-offset:1px}
/* 「最近来信」快捷加入（v0.6.8）：从最近的入站消息里一键把号码加进白名单。 */
.qqai-suggest{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;padding-top:2px}
/* 「这行绑定的开关是关的，所以不起作用」（v0.6.8）：琥珀色小字，故意比正常说明显眼。 */
.qqai-inactive{font-size:11px;color:var(--dsw-alias-state-warn-primary,#b45309);font-weight:500}
/* 桥的连接状态行（v0.6.8）：已连接=绿、被拦=琥珀、没在跑=灰。 */
.qqai-bridge{padding:6px 10px;border-radius:8px;font-size:12px;border:1px solid transparent}
.qqai-bridge.ok{background:var(--dsw-alias-bg-layer-2,#f0fdf4);border-color:var(--dsw-alias-state-success-primary,#15803d);color:var(--dsw-alias-state-success-primary,#15803d)}
.qqai-bridge.warn{background:var(--dsw-alias-bg-layer-2,#fffbeb);border-color:var(--dsw-alias-state-warn-primary,#b45309);color:var(--dsw-alias-state-warn-primary,#b45309)}
.qqai-bridge.off{background:var(--dsw-alias-bg-layer-2,#f6f7f9);border-color:var(--dsw-alias-border-l3,#0000001f);color:var(--dsw-alias-label-secondary,#6b7280)}
.qqai-state{font-size:11px}
.qqai-state.on{color:var(--dsw-alias-state-success-primary,#15803d)}
.qqai-state.off{color:var(--dsw-alias-state-warn-primary,#b45309)}
`

    async function callJson(path, options) {
      const response = await fetch(path, {
        cache: 'no-store',
        ...options,
        headers: { 'content-type': 'application/json', ...(options && options.headers) },
      })
      let payload = null
      try { payload = await response.json() } catch { /* 非 JSON 时下面按状态码报错 */ }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.reason || `HTTP ${response.status}`)
      }
      return payload
    }

    /**
     * 极简富文本：只认 `**加粗**`（说明里用它点出"需要什么"），其余原样输出。
     * 不引 markdown 库——面板要的是轻量；也绝不把文本塞进 innerHTML。
     */
    function richText(text) {
      const parts = String(text ?? '').split('**')
      return parts.map((part, index) => (index % 2 === 1 ? h('b', { key: index }, part) : part))
    }

    /**
     * 写入后"立即更新状态"用的三件小事（v0.6.8）：
     *   - `findRowFor`：在载荷里找到某个键对应的行——「开关 + 数值」合并行的数值键嵌在 `row.number` 里；
     *   - `sameValue`：数组按内容比（时段列表）；
     *   - `applyWrittenValue`：**乐观更新**——把刚写进去的值先落到本地载荷里（并清掉 pending），
     *     这样点完开关立刻就动，不用等宿主那 ~2.3 秒的热重载。
     */
    function findRowFor(data, key) {
      const groups = Array.isArray(data?.groups) ? data.groups : []
      for (const group of groups) {
        for (const row of group.rows ?? []) {
          if (row.key === key) return row
          if (row.number && row.number.key === key) return row.number
        }
      }
      return null
    }

    function sameValue(a, b) {
      if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
      return a === b
    }

    /**
     * 把"刚写进去的值"盖到载荷上（v0.6.8）。
     *
     * `pending` 默认**保留服务端说法**：写进配置不等于生效，宿主还要热重载（~2.3 秒），
     * 这段时间显示新值 + 「更新中」徽标才是诚实的；`clearPending` 只在"确定已经生效"时用。
     */
    function applyWrittenValue(data, key, value, { clearPending = false } = {}) {
      if (!data || !Array.isArray(data.groups)) return data
      const groups = data.groups.map((group) => ({
        ...group,
        rows: (group.rows ?? []).map((row) => {
          const patch = (item) => (clearPending ? { ...item, value, pending: false } : { ...item, value })
          if (row.key === key) return patch(row)
          if (row.number && row.number.key === key) return { ...row, number: patch(row.number) }
          return row
        }),
      }))
      return { ...data, groups }
    }

    /**
     * 还没"生效"的本地写入（key → 值）。
     *
     * 为什么要有它（用户 2026-10-19「为啥静默时段还是需要刷新」）：写完 3 秒后自动刷新一次，
     * 如果那一刻宿主的重载还没完成，载荷里这一行会**回到旧值**（只多一个「更新中」徽标）——
     * 界面上看起来就像"刚改的东西被吞了"，于是又得手动刷新一次。
     * 现在把写过的值记在 `optimisticValues` 里，**每次拉载荷都盖回去**，
     * 直到某一趟载荷里该键确实生效（值相同且 pending 不再是 true）才把它从表里删掉。
     */
    const optimisticValues = new Map()

    /** 把还没生效的本地写入盖到载荷上；顺带清理已经生效的条目。 */
    function applyOptimistic(data) {
      if (!data || optimisticValues.size === 0) return data
      let merged = data
      for (const [key, value] of [...optimisticValues.entries()]) {
        const row = findRowFor(merged, key)
        if (!row) { optimisticValues.delete(key); continue }
        if (row.pending !== true && sameValue(row.value, value)) { optimisticValues.delete(key); continue }
        merged = applyWrittenValue(merged, key, value)
      }
      return merged
    }

    /**
     * 开关本体（布尔行与「开关 + 数值」合并行共用一份，别各写一遍）。
     * 语义与视觉都挂在 aria-checked 上（与官方 Switch 一致）。
     */
    function SwitchControl({ on, busy, label, onChange }) {
      return h('button', {
        className: 'qqai-switch',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        disabled: busy === true,
        title: on ? '点一下关闭' : '点一下开启',
        'aria-label': `${label}：${on ? '开' : '关'}`,
        onClick: () => onChange(!on),
      }, h('span', { className: 'qqai-knob' }))
    }

    /**
     * 数值本体（`−` / 输入框 / `+`）：数值行与「开关 + 数值」合并行共用。
     *
     * 三条规矩：
     *   ① **范围来自服务端**（`spec.min/max/step`，由 schema 现读）——界面只做夹取，不做"我猜能被接受"的判断；
     *      真正的校验在 `POST /qqai/panel/set`，越界/小数会被 400 拒掉并说明范围。
     *   ② 输入过程中**不写**，回车 / 失焦 / 点 ± 才写一次（每敲一个字符就写配置，会把 patch 写烂）。
     *   ③ 写到一半的非法输入（空、`--`、超范围）回滚成上一个生效值，不弹一堆错。
     */
    function NumberControl({ spec, busy, label, onCommit }) {
      const min = Number.isFinite(spec.min) ? spec.min : null
      const max = Number.isFinite(spec.max) ? spec.max : null
      const step = Number.isFinite(spec.step) && spec.step > 0 ? spec.step : 1
      const clamp = (raw) => {
        const num = Number(raw)
        if (!Number.isFinite(num)) return null
        let next = Math.round(num / step) * step
        if (min !== null && next < min) next = min
        if (max !== null && next > max) next = max
        return next
      }
      const [draft, setDraft] = React.useState(String(spec.value ?? ''))
      // 服务端把新值推回来之后（保存成功 / 别的窗口改了），输入框跟着生效值走。
      React.useEffect(() => { setDraft(String(spec.value ?? '')) }, [spec.value])
      const commit = (raw) => {
        const next = clamp(raw)
        if (next === null) { setDraft(String(spec.value ?? '')); return }
        setDraft(String(next))
        if (next !== Number(spec.value)) onCommit(next)
      }
      /**
       * `spec.noStepper`（v0.6.8）：这一行是"标识"而不是"阈值"——比如「AI 账号（机器人 QQ 号）」，
       * 填一次就完事，旁边挂 ± 既没用又像调试参数（用户 2026-10-20「AI账号那一栏为啥还有加减啊」）。
       * 不画 ± 时把输入框放宽一点，11 位 QQ 号才放得下。
       */
      const noStepper = spec.noStepper === true
      return h('div', { className: 'qqai-num' },
        noStepper ? null : h('button', {
          className: 'qqai-num-btn', type: 'button', disabled: busy === true,
          title: `减 ${step}${min !== null ? `（最小 ${min}）` : ''}`, 'aria-label': `${label}：减`,
          onClick: () => commit(Number(spec.value) - step),
        }, '−'),
        h('input', {
          className: noStepper ? 'qqai-num-input wide' : 'qqai-num-input', type: 'number', inputMode: 'numeric',
          min, max, step, value: draft, disabled: busy === true,
          'aria-label': label,
          onChange: (event) => setDraft(event.target.value),
          onBlur: (event) => commit(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') commit(event.target.value)
            if (event.key === 'Escape') setDraft(String(spec.value ?? ''))
          },
        }),
        noStepper ? null : h('button', {
          className: 'qqai-num-btn', type: 'button', disabled: busy === true,
          title: `加 ${step}${max !== null ? `（最大 ${max}）` : ''}`, 'aria-label': `${label}：加`,
          onClick: () => commit(Number(spec.value) + step),
        }, '+'),
        spec.unit ? h('span', { className: 'qqai-unit' }, spec.unit) : null)
    }

    /** 布尔行：左边标签+说明，右边一个开关。 */
    function Row({ row, busy, onSet }) {
      const on = row.value === true
      return h('div', { className: 'qqai-row' },
        h('div', { className: 'qqai-text' },
          h('label', { className: 'qqai-label' }, row.label,
            row.pending === true ? h('span', { className: 'qqai-badge', title: '已写入配置，正在等宿主应用（一般 2–3 秒）；期间显示的就是刚改的值' }, '更新中') : null,
            // 直接标出**出厂默认值**（不用"非默认"这种说法）：把徽标和右边的开关一对比，
            // 就知道自己改没改过。用户原话："改成'默认：状态'这样子好一点，而不是显示非默认一条"。
            row.defaultValue === true || row.defaultValue === false
              ? h('span', {
                className: 'qqai-need',
                title: `出厂默认：${row.defaultValue === true ? '开' : '关'} · 当前：${on ? '开' : '关'}`
                  + (row.nonDefault === true ? '（你改过）' : '（与出厂一致）'),
              }, `默认：${row.defaultValue === true ? '开' : '关'}`)
              : null,
            row.needs ? h('span', { className: 'qqai-need', title: '这个功能要额外准备的东西' }, row.needs) : null),
          row.hint ? h('span', { className: 'qqai-hint', title: row.hint }, richText(row.hint)) : null,
          h('span', { className: 'qqai-key' }, row.key)),
        h(SwitchControl, { on, busy, label: row.label, onChange: (next) => onSet(row.key, next) }))
    }

    /**
     * 数值行（v0.6.7）：`−` / 输入框 / `+`。
     *
     * 三条规矩：
     *   ① **范围来自服务端**（`row.min/max/step`，由 schema 现读）——界面只做夹取，不做"我猜能被接受"的判断；
     *      真正的校验在 `POST /qqai/panel/set`，越界/小数会被 400 拒掉并说明范围。
     *   ② 输入过程中**不写**，回车 / 失焦 / 点 ± 才写一次（每敲一个字符就写配置，会把 patch 写烂）。
     *   ③ 写到一半的非法输入（空、`--`、超范围）回滚成上一个生效值，不弹一堆错。
     */
    /** 数值行：左边标签+说明，右边 `− n +`（控件本体见 NumberControl）。 */
    function NumberRow({ row, busy, onSet }) {
      const min = Number.isFinite(row.min) ? row.min : null
      const max = Number.isFinite(row.max) ? row.max : null
      const range = min !== null && max !== null ? `${min}–${max}` : (min !== null ? `≥ ${min}` : (max !== null ? `≤ ${max}` : ''))
      return h('div', { className: 'qqai-row' },
        h('div', { className: 'qqai-text' },
          h('label', { className: 'qqai-label' }, row.label,
            row.pending === true ? h('span', { className: 'qqai-badge', title: '已写入配置，正在等宿主应用（一般 2–3 秒）；期间显示的就是刚改的值' }, '更新中') : null,
            row.defaultValue !== null && row.defaultValue !== undefined
              ? h('span', {
                className: 'qqai-need',
                title: `出厂默认：${row.defaultValue}${row.unit ? ' ' + row.unit : ''} · 当前：${row.value}${row.unit ? ' ' + row.unit : ''}`
                  + (row.nonDefault === true ? '（你改过）' : '（与出厂一致）')
                  + (range ? ` · 范围：${range}` : ''),
              }, `默认：${row.defaultValue}${row.unit ? ' ' + row.unit : ''}`)
              : null,
            row.needs ? h('span', { className: 'qqai-need', title: '这个功能要额外准备的东西' }, row.needs) : null),
          row.hint ? h('span', { className: 'qqai-hint', title: row.hint }, richText(row.hint)) : null,
          h('span', { className: 'qqai-key' }, range ? `${row.key}（${range}）` : row.key)),
        h(NumberControl, { spec: row, busy, label: row.label, onCommit: (next) => onSet(row.key, next) }))
    }

    /**
     * 「开关 + 数值」合并行（v0.6.7，用户 2026-10-17：「你这两个怎么不合并在一起」）：
     * 开关是总闸、数值是它的阈值，**同一行**里左右并排——不用再上下对照谁管谁。
     * 两个键各自独立写（点开关写布尔、改数字写数值），服务端一次只收一个键。
     */
    function SwitchNumberRow({ row, busy, onSet }) {
      const on = row.value === true
      const num = row.number ?? {}
      const min = Number.isFinite(num.min) ? num.min : null
      const max = Number.isFinite(num.max) ? num.max : null
      const range = min !== null && max !== null ? `${min}–${max}` : ''
      const numDefault = num.defaultValue !== null && num.defaultValue !== undefined
        ? `${num.defaultValue}${num.unit ? ' ' + num.unit : ''}`
        : ''
      return h('div', { className: 'qqai-row' },
        h('div', { className: 'qqai-text' },
          h('label', { className: 'qqai-label' }, row.label,
            row.pending === true || num.pending === true
              ? h('span', { className: 'qqai-badge', title: '已写入配置，正在等宿主应用（一般 2–3 秒）；期间显示的就是刚改的值' }, '更新中')
              : null,
            row.defaultValue === true || row.defaultValue === false
              ? h('span', {
                className: 'qqai-need',
                title: `出厂默认：${row.defaultValue === true ? '开' : '关'} · 当前：${on ? '开' : '关'}`
                  + (row.nonDefault === true ? '（你改过）' : '（与出厂一致）'),
              }, `默认：${row.defaultValue === true ? '开' : '关'}`)
              : null,
            numDefault !== ''
              ? h('span', { className: 'qqai-need', title: `${num.label}出厂默认 ${numDefault}${range ? ` · 范围 ${range}` : ''}` }, `数值默认：${numDefault}`)
              : null,
            row.needs ? h('span', { className: 'qqai-need', title: '这个功能要额外准备的东西' }, row.needs) : null),
          row.hint ? h('span', { className: 'qqai-hint', title: row.hint }, richText(row.hint)) : null,
          h('span', { className: 'qqai-key' }, `${row.key} + ${num.key ?? '?'}${range ? `（${range}）` : ''}`)),
        h('div', { className: 'qqai-row-ctl' },
          h(SwitchControl, { on, busy, label: row.label, onChange: (next) => onSet(row.key, next) }),
          h(NumberControl, { spec: num, busy, label: num.label || row.label, onCommit: (next) => onSet(num.key, next) })))
    }

    /** `H:MM-H:MM` → `{ start: 'HH:MM', end: 'HH:MM' }`；看不懂就 null（原样显示，绝不丢数据）。 */
    function parseRange(text) {
      const match = /^(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2}):(\d{1,2})$/.exec(String(text ?? '').trim())
      if (!match) return null
      const pad = (hour, minute) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      return { start: pad(match[1], match[2]), end: pad(match[3], match[4]) }
    }

    /**
     * 时段列表行（v0.6.8）：`quietHours` 这种 `H:MM-H:MM` 的数组。
     *
     * 每段一行两个 `<input type="time">`（原生时间控件、24 小时制）+ 一个删除按钮，最下面「+ 加一段」。
     * 每次改动**整组提交**（`onSet(row.key, 完整数组)`）——服务端会归一化成 `HH:MM-HH:MM` 再写回，
     * 所以界面里看到的永远是配置里的真实形状；校验失败（起止相同、越界、超 8 段）由服务端 400 说原因。
     */
    function TimesRow({ row, busy, onSet }) {
      const list = Array.isArray(row.value) ? row.value : []
      const maxRanges = Number.isFinite(row.maxRanges) ? row.maxRanges : 8
      const defList = Array.isArray(row.defaultValue) ? row.defaultValue : null
      const commit = (next) => onSet(row.key, next)
      const edit = (index, field, value) => {
        const pairs = list.map((raw) => parseRange(raw))
        const current = pairs[index]
        if (!current || !value) return
        const patched = { ...current, [field]: String(value).slice(0, 5) }
        if (patched.start === patched.end) return // 起止相同：服务端会拒，这里先不发
        commit(pairs.map((pair, at) => (at === index ? patched : pair)).map((pair) => `${pair.start}-${pair.end}`))
      }
      return h('div', { className: 'qqai-row' },
        h('div', { className: 'qqai-text' },
          h('label', { className: 'qqai-label' }, row.label,
            row.pending === true ? h('span', { className: 'qqai-badge', title: '已写入配置，正在等宿主应用（一般 2–3 秒）；期间显示的就是刚改的值' }, '更新中') : null,
            defList !== null
              ? h('span', {
                className: 'qqai-need',
                title: `出厂默认：${defList.length === 0 ? '（空）' : defList.join(' / ')}`
                  + (row.nonDefault === true ? '（你改过）' : '（与出厂一致）'),
              }, `默认：${defList.length === 0 ? '空' : `${defList.length} 段`}`)
              : null,
            row.needs ? h('span', { className: 'qqai-need', title: '这个功能要额外准备的东西' }, row.needs) : null),
          row.hint ? h('span', { className: 'qqai-hint', title: row.hint }, richText(row.hint)) : null,
          // ★ v0.6.8：这些时段绑定在一个开关上，开关关着就**不会生效**——必须说出来
          //   （2026-10-20 真机：用户设了时段却还在回复，因为「避开高峰期」开关是另一个键、没开）。
          row.inactive === true
            ? h('span', { className: 'qqai-inactive' }, `⚠️ ${row.inactiveReason || '开关关着，这些时段不起作用'}`)
            : null,
          h('span', { className: 'qqai-key' }, `${row.key}（${list.length} / ${maxRanges} 段）`)),
        h('div', { className: 'qqai-times' },
          list.length === 0 ? h('span', { className: 'qqai-unit' }, '（空 = 不会静默）') : null,
          list.map((raw, index) => {
            const pair = parseRange(raw)
            // 解析不出来的老写法（比如带中文、全角冒号）原样显示，别默默当成"空"
            if (!pair) return h('div', { className: 'qqai-time', key: index }, h('span', { className: 'qqai-time-raw' }, `${raw}（看不懂 H:MM-H:MM，改掉它）`))
            return h('div', { className: 'qqai-time', key: index },
              h('input', {
                // ⚠️ 时间输入框**不跟冷却一起禁用**（v0.6.8）：改一段要动"开始 + 结束"两个框，
                //    如果第一下就把它们变灰 3 秒，用户根本改不完一段——这比"多点一次"更烦。
                className: 'qqai-time-input', type: 'time', value: pair.start,
                'aria-label': `${row.label}第 ${index + 1} 段开始`, onChange: (event) => edit(index, 'start', event.target.value),
              }),
              h('span', { className: 'qqai-time-dash' }, '–'),
              h('input', {
                className: 'qqai-time-input', type: 'time', value: pair.end,
                'aria-label': `${row.label}第 ${index + 1} 段结束`, onChange: (event) => edit(index, 'end', event.target.value),
              }),
              h('button', {
                className: 'qqai-time-del', type: 'button', disabled: busy === true,
                title: '删掉这一段', 'aria-label': `${row.label}第 ${index + 1} 段：删除`,
                onClick: () => commit(list.filter((unused, at) => at !== index)),
              }, '×'))
          }),
          h('button', {
            className: 'qqai-time-add', type: 'button', disabled: busy === true || list.length >= maxRanges,
            title: list.length >= maxRanges ? `最多 ${maxRanges} 段` : '加一段 09:00–12:00，再点开改时间',
            onClick: () => commit([...list, '09:00-12:00']),
          }, `+ 加一段（${list.length}/${maxRanges}）`)))
    }

    /**
     * 号码列表行（v0.6.8，白名单 `allowUsers` / `allowGroups`）。
     *
     * 每一条显示成一个号码 chip（`×` 删掉），最下面一个输入框 + 「+ 添加」：
     *   - 只收数字（输入框里非数字直接过滤掉），提交时转成 **Number**——schema 是 `z.array(z.number())`，
     *     写成字符串的话 `#allowed()` 的 `includes` 永远匹配不上（这是白名单最容易踩的坑）；
     *   - 加完立刻写入（走同一条"乐观更新 + 3 秒冷却 + 自动刷新"，服务端会校验/去重）。
     */
    function ListRow({ row, busy, onSet, bridge }) {
      const list = Array.isArray(row.value) ? row.value : []
      const maxItems = Number.isFinite(row.maxItems) ? row.maxItems : 50
      const defList = Array.isArray(row.defaultValue) ? row.defaultValue : null
      const [draft, setDraft] = React.useState('')
      const full = list.length >= maxItems
      /**
       * ★ v0.6.8「快捷加入」：从**最近来信**里挑（运行快照的 `recentChats`），一键加进白名单——
       * 不用让用户自己去查 QQ 号/群号（这也是最容易填错的一步）。
       */
      const kind = row.key === 'allowGroups' ? 'group' : 'user'
      const suggestions = (Array.isArray(bridge?.recentChats) ? bridge.recentChats : [])
        .filter((item) => item && item.kind === kind && Number.isInteger(item.id) && !list.includes(item.id))
        .slice(0, 4)
      const add = () => {
        const num = Number(String(draft).trim())
        if (!Number.isInteger(num) || num <= 0) return
        setDraft('')
        if (list.includes(num)) return
        onSet(row.key, [...list, num])
      }
      return h('div', { className: 'qqai-row' },
        h('div', { className: 'qqai-text' },
          h('label', { className: 'qqai-label' }, row.label,
            row.pending === true ? h('span', { className: 'qqai-badge', title: '已写入配置，正在等宿主应用（一般 2–3 秒）；期间显示的就是刚改的值' }, '更新中') : null,
            defList !== null
              ? h('span', {
                className: 'qqai-need',
                title: `出厂默认：${defList.length === 0 ? '（空）' : defList.join(' / ')}`
                  + (row.nonDefault === true ? '（你改过）' : '（与出厂一致）'),
              }, `默认：${defList.length === 0 ? '空' : `${defList.length} 条`}`)
              : null,
            row.needs ? h('span', { className: 'qqai-need', title: '这个功能要额外准备的东西' }, row.needs) : null),
          row.hint ? h('span', { className: 'qqai-hint', title: row.hint }, richText(row.hint)) : null,
          // ★ v0.6.8：上面的「回应所有人」开着时，这个名单不生效——必须标出来，
          //   否则用户会以为"我加了人怎么还是谁都回"。
          row.inactive === true
            ? h('span', { className: 'qqai-inactive' }, `⚠️ ${row.inactiveReason || '上面的开关开着，这个名单不起作用'}`)
            : null,
          h('span', { className: 'qqai-key' }, `${row.key}（${list.length} / ${maxItems} 条）`)),
        h('div', { className: 'qqai-list' },
          list.length === 0 ? h('span', { className: 'qqai-unit' }, '（空 = 全部拒绝）') : null,
          list.map((item, index) => h('div', { className: 'qqai-chip', key: index },
            h('span', { className: 'qqai-chip-text' }, String(item)),
            h('button', {
              className: 'qqai-time-del', type: 'button', disabled: busy === true,
              title: '删掉这一条', 'aria-label': `${row.label}：删掉 ${item}`,
              onClick: () => onSet(row.key, list.filter((unused, at) => at !== index)),
            }, '×'))),
          h('div', { className: 'qqai-time' },
            h('input', {
              className: 'qqai-list-input', type: 'text', inputMode: 'numeric', placeholder: 'QQ号 / 群号',
              value: draft, disabled: busy === true || full,
              'aria-label': `${row.label}：要添加的号码`,
              // 只留数字：QQ 号/群号都是纯数字，粘进来带空格或符号也能用。
              onChange: (event) => setDraft(String(event.target.value).replace(/[^0-9]/g, '').slice(0, 12)),
              onKeyDown: (event) => {
                if (event.key === 'Enter') add()
                if (event.key === 'Escape') setDraft('')
              },
            }),
            h('button', {
              className: 'qqai-time-add', type: 'button',
              disabled: busy === true || full || draft === '',
              title: full ? `最多 ${maxItems} 条` : '加进白名单',
              onClick: add,
            }, `+ 添加（${list.length}/${maxItems}）`)),
          suggestions.length > 0
            ? h('div', { className: 'qqai-suggest' },
              h('span', { className: 'qqai-unit' }, '最近来信：'),
              suggestions.map((item) => h('button', {
                className: 'qqai-time-add', type: 'button', key: `sug-${item.id}`,
                disabled: busy === true || full,
                title: `${item.id} 最近给机器人发过消息 —— 点一下加进白名单`,
                onClick: () => onSet(row.key, [...list, item.id]),
              }, `+ ${item.id}`)))
            : null))
    }

    /**
     * 正则列表行（v0.7.8，`taintExtraPatterns`：自定义注入句式）。
     *
     * 与 `ListRow`（号码）的区别：这里是**字符串原文**，所以
     *   - 输入框不做字符过滤（正则里的 `\d`、`.`、`(` 都得原样保留）；
     *   - 提交前在本地先 `new RegExp` 试一次，坏正则**当场在行内报错**，不写进配置、也不等服务端；
     *   - 每条都显示原文（用 `<code>` 等宽），因为正则里的空格与反斜杠肉眼必须看得出。
     */
    function PatternsRow({ row, busy, onSet }) {
      const list = Array.isArray(row.value) ? row.value : []
      const maxItems = Number.isFinite(row.maxItems) ? row.maxItems : 20
      const maxLength = Number.isFinite(row.maxLength) ? row.maxLength : 200
      const defList = Array.isArray(row.defaultValue) ? row.defaultValue : null
      const [draft, setDraft] = React.useState('')
      const [error, setError] = React.useState('')
      const full = list.length >= maxItems
      const add = () => {
        const text = String(draft).trim()
        if (text === '') return
        if (text.length > maxLength) { setError(`一条最多 ${maxLength} 字（这条 ${text.length} 字）`); return }
        try { new RegExp(text, 'i') } catch (err) { setError(`正则不合法：${err && err.message ? err.message : err}`); return }
        if (list.includes(text)) { setError('这条已经加过了'); return }
        setError('')
        setDraft('')
        onSet(row.key, [...list, text])
      }
      return h('div', { className: 'qqai-row' },
        h('div', { className: 'qqai-text' },
          h('label', { className: 'qqai-label' }, row.label,
            row.pending === true ? h('span', { className: 'qqai-badge', title: '已写入配置，正在等宿主应用（一般 2–3 秒）；期间显示的就是刚改的值' }, '待生效') : null,
            defList !== null
              ? h('span', { className: 'qqai-need', title: `出厂默认：${defList.length === 0 ? '（空）' : defList.join(' / ')}` }, `默认：${defList.length === 0 ? '空' : `${defList.length} 条`}`)
              : null),
          row.hint ? h('span', { className: 'qqai-hint', title: row.hint }, richText(row.hint)) : null,
          h('span', { className: 'qqai-key' }, `${row.key}（${list.length} / ${maxItems} 条）`)),
        h('div', { className: 'qqai-list' },
          list.length === 0 ? h('span', { className: 'qqai-unit' }, '（空 = 只用内置的 8 条句式）') : null,
          list.map((item, index) => h('div', { className: 'qqai-chip', key: index },
            h('code', { className: 'qqai-chip-text' }, String(item)),
            h('button', {
              className: 'qqai-time-del', type: 'button', disabled: busy === true,
              title: '删掉这一条', 'aria-label': `${row.label}：删掉 ${item}`,
              onClick: () => onSet(row.key, list.filter((unused, at) => at !== index)),
            }, '×'))),
          h('div', { className: 'qqai-time' },
            h('input', {
              className: 'qqai-list-input', type: 'text', placeholder: '正则，例如：把.*(配置|密钥).*发(给)?我',
              value: draft, disabled: busy === true || full, spellCheck: false,
              'aria-label': `${row.label}：要添加的正则`,
              onChange: (event) => { setDraft(String(event.target.value).slice(0, maxLength + 20)); setError('') },
              onKeyDown: (event) => {
                if (event.key === 'Enter') add()
                if (event.key === 'Escape') { setDraft(''); setError('') }
              },
            }),
            h('button', {
              className: 'qqai-time-add', type: 'button',
              disabled: busy === true || full || draft.trim() === '',
              title: full ? `最多 ${maxItems} 条` : '加一条自定义句式',
              onClick: add,
            }, `+ 添加（${list.length}/${maxItems}）`)),
          error !== '' ? h('span', { className: 'qqai-inactive' }, `⚠️ ${error}`) : null))
    }

    /**
     * 桥的连接状态一行（v0.6.8）。
     *
     * 用户 2026-10-19「为啥登陆了以后没有任何反馈啊」「但是能登上 NapCat」——NapCat 那边登录成功，
     * 面板却什么都看不出来。这一行读的是插件自己的运行快照（`qq-runtime.json`）：
     *   - 桥在不在跳（快照 30 秒内有没有更新）；
     *   - 最近一条**入站**消息是什么时候（有它 = QQ 那边真的连上了）；
     *   - 最近一条消息**为什么没回**（白名单 / 静默 / 限流……）。
     */
    function agoText(seconds) {
      if (!Number.isFinite(seconds)) return ''
      if (seconds < 90) return `${Math.round(seconds)} 秒前`
      if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟前`
      return `${Math.round(seconds / 3600)} 小时前`
    }

    function BridgeLine({ bridge }) {
      if (!bridge) return null
      // 只有"快照文件都没有"才算没跑起来：快照是按需写的，空闲时几分钟不更新很正常。
      if (bridge.present !== true) {
        return h('div', { className: 'qqai-bridge off' },
          `桥：还没有运行快照${bridge.reason ? ` —— ${bridge.reason}` : ''}`)
      }
      const parts = ['桥：已连接']
      if (bridge.botOnline === true) parts.push('账号在线')
      else if (bridge.botOnline === false) parts.push('账号离线')
      if (bridge.lastInboundAgoSeconds !== null && bridge.lastInboundAgoSeconds !== undefined) {
        parts.push(`最近收到消息 ${agoText(bridge.lastInboundAgoSeconds)}`)
      } else {
        parts.push('还没收到过任何消息')
      }
      const blocked = bridge.topReason
      const head = parts.join(' · ')
      // 有拦截原因就变琥珀色并写清原因；否则空闲太久也只是补一句"没活动"，不当成故障。
      const idle = !blocked && Number(bridge.ageSeconds) > 120 ? `（${agoText(bridge.ageSeconds)}没有活动）` : ''
      return h('div', {
        className: `qqai-bridge ${blocked ? 'warn' : 'ok'}`,
        title: `运行快照：${bridge.file ?? ''}（有事件才写）`,
      }, blocked
        ? `${head} —— 最近被拦下：${bridge.topReason.reason}（${bridge.topReason.count} 次）`
        : `${head}${idle}`)
    }

    /**
     * 「相关链接」一组：账号入口（第一条，机器人账号登录 / 扫码）+ 更新日志 / 调试文档 / 调试台。
     *
     * 位置是用户 2026-10-04 连着几条指示定稿的："应该把账号登陆调到最上方" →
     * "不对不对应该在QQ助手的下边" → "还是挪回到之前的位置吧，直接把相关链接整体拉到最上边" →
     * "调试台改到调试文档下方"。
     * ⇒ 现在这**整组**渲染在标题正下方、开关分组之前，顺序由服务端 `links` 数组决定（数组顺序＝界面顺序）。
     *
     * ⚠️ **整行都要能点**（2026-10-04 真机"点击账号没反应"之后改的）：原来只有那行蓝色标签是 `<a>`，
     * 右边那段灰色说明文字是普通 `<span>`——点在说明上什么都不会发生，看着就是"点了没反应"。
     * 现在整行是一个 `<a>`（label + 状态 + 说明都在里面），点哪儿都能进。
     *
     * ⚠️ **桌面端里"相对地址 = 点了没反应"**（2026-10-04 真机，读 `app.asar` 定的案）：桌面端主窗口
     *   `setWindowOpenHandler(({url}) => { http(s) 才 shell.openExternal(url); 一律 deny 开新窗口 })`。
     * 面板里的账号/调试台入口是**相对地址**（`/qqai/account`），在桌面端（渲染基址 `dsh-app://app/`）
     * 会解析成 `dsh-app://app/qqai/account` ⇒ 协议不是 http(s)、又不许开窗口 ⇒ **什么都不发生**。
     * 所以在这类宿主里改成：先向宿主取 `?format=json` 拿到**绝对 http 地址**，再 `window.open(url)` ——
     * 那个地址是 http，桌面端会交给系统浏览器打开（和平台自己的外链同一个待遇）。
     * 网页版（http 宿主）保持原来的默认导航，别多此一举。
     */
    const isDesktopShell = () => typeof location !== 'undefined' && String(location.protocol ?? '') === 'dsh-app:'

    /** 桌面端专用：把相对入口解析成绝对 http 地址再开（取不到就退回默认导航）。 */
    async function openViaHost(href) {
      const url = await fetch(`${href}${href.includes('?') ? '&' : '?'}format=json`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((payload) => (payload?.url ? String(payload.url) : ''))
        .catch(() => '')
      if (url === '') return false
      window.open(url, '_blank', 'noopener,noreferrer')
      return true
    }

    function Links({ links }) {
      if (!Array.isArray(links) || links.length === 0) return null
      return h('div', { className: 'qqai-links' },
        h('div', { className: 'qqai-meta' }, '相关链接'),
        links.map((link) => h('a', {
          key: link.id,
          className: 'qqai-link-row',
          href: link.href,
          target: '_blank',
          rel: 'noreferrer',
          title: link.hint ?? '',
          // 只有**同源相对**入口在桌面端会被卡住（外链是绝对 http(s)，平台自己会交给浏览器）。
          onClick: isDesktopShell() && String(link.href).startsWith('/')
            ? (event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              event.preventDefault()
              void openViaHost(link.href)
            }
            : undefined,
        },
        h('span', { className: 'qqai-link' }, link.label),
        link.state ? h('span', { className: `qqai-state ${link.running === true ? 'on' : 'off'}` }, link.state) : null,
        link.hint ? h('span', { className: 'qqai-hint' }, richText(link.hint)) : null)))
    }

    /**
     * 快捷操作：**启动 NapCat** / **重新登录**。
     *
     * 为什么要有（用户 2026-10-04："不能自己快捷启动吗？比如加到哪个控制选项中"）：
     * 以前只能让用户自己去右键"以管理员身份运行 launcher.bat"，而这台机器上双击自提权是**静默失败**的。
     * 现在点一下就行——代价是弹一次 UAC，点「是」即可。
     *
     * 这两条会 POST 到宿主的 `/qqai/napcat/start` 与 `/qqai/napcat/relogin`；
     * 服务端只按**加载器 PID** 清理，绝不会按镜像名杀 QQ（那会连用户自己的 QQ 一起杀掉）。
     */
    function Actions({ napcat, busy, onAction, qrStamp, onRefreshQr }) {
      const running = napcat?.running === true
      const port = napcat?.port ?? 6099
      const qr = napcat?.qr ?? {}
      // busy 没传 / 不是字符串时都按"没有请求在跑"处理（曾经把 undefined 当成"忙"，按钮一直灰着）。
      const pending = typeof busy === 'string' && busy !== ''
      const starting = busy === '/qqai/napcat/start' || busy === '/qqai/napcat/relogin'
      /**
       * 按钮旁边那句状态（用户 2026-10-04："应该在启动旁边加个提示，比如过会会出现二维码，
       * 而不是什么也没有"）——把"接下来会发生什么"直接写出来，别让用户对着空白猜。
       */
      const status = starting
        ? '正在启动 NapCat…等几秒，二维码会出现在下面'
        : running === true
          ? `NapCat：运行中（127.0.0.1:${port}）${qr.fresh === true ? ` · 二维码 ${qr.ageSeconds} 秒前刷新` : ''}`
          : 'NapCat：未运行 · 点「启动 NapCat」后等几秒，二维码会出现在下面'
      return h('div', { className: 'qqai-actions' },
        h('div', { className: 'qqai-meta' }, '快捷操作'),
        h('div', { className: 'qqai-action-row' },
          h('button', {
            className: 'qqai-action',
            disabled: running === true || pending,
            title: running === true ? 'NapCat 已经在运行了' : '以管理员身份启动 NapCat（本机策略下不会弹 UAC，命令直接执行）',
            onClick: () => onAction('/qqai/napcat/start', '启动 NapCat'),
          }, running === true ? 'NapCat 运行中' : (busy === '/qqai/napcat/start' ? '请求中…' : '启动 NapCat')),
          h('button', {
            className: 'qqai-action',
            disabled: pending,
            title: '只结束 NapCat 加载器（不会碰你自己开的 QQ），然后重新走一遍登录流程',
            onClick: () => onAction('/qqai/napcat/relogin', '重新登录'),
          }, busy === '/qqai/napcat/relogin' ? '请求中…' : '重新登录（扫码）'),
          h('span', { className: 'qqai-hint' }, status)),
        /**
         * **把二维码直接贴在这里**（用户 2026-10-04 连着两次："没弹出二维码啊"）。
         * NapCat 的码本来只印在它自己的控制台窗口里，而我们把输出重定向进日志了 ⇒ 窗口是空的、看不到码。
         * 现在只要 `cache/qrcode.png` 还新鲜（≤5 分钟），面板就把图显示出来，点「刷新二维码」重新取一张。
         */
        qr.fresh === true
          ? h('div', { className: 'qqai-qr' },
            h('img', {
              className: 'qqai-qr-img',
              src: `${qr.url}?t=${qrStamp}`,
              alt: 'NapCat 登录二维码',
              width: 176,
              height: 176,
            }),
            h('div', { className: 'qqai-qr-side' },
              h('div', { className: 'qqai-qr-title' }, '用手机 QQ 扫码登录'),
              h('div', { className: 'qqai-hint' }, '二维码由 NapCat 生成在 cache/qrcode.png；超过 5 分钟会自动隐藏。'),
              h('button', {
                className: 'qqai-action',
                disabled: pending,
                title: '重新拉取这张二维码图（NapCat 会自己刷新码）',
                onClick: () => (typeof onRefreshQr === 'function' ? onRefreshQr() : undefined),
              }, '刷新二维码')))
          // 运行中但**码已过期**：不能什么都不显示——那看起来就像"没有二维码"（用户已经问过一次了）。
          : (running === true
            ? h('div', { className: 'qqai-hint' }, qr.ageSeconds >= 0
              ? `二维码已过期（${qr.ageSeconds} 秒前刷新的那张，超过 5 分钟就不显示了）——点上面「重新登录（扫码）」重新生成`
              : '还没有二维码——点上面「启动 NapCat」，或直接点「重新登录（扫码）」')
            : null))
    }

    /**
     * 面板搜索（v0.6.9）：10 组 78 个键，找某个开关只能靠滚 —— 顶部给一个输入框，
     * **纯前端过滤**（不发请求、不改配置），按中文标签 / 配置键名 / 说明文字匹配。
     *
     * 规则：
     *   - 组名命中 ⇒ 整组都留下（想找「白名单」就整组看）；
     *   - 否则只留命中的行；一行都不剩的组整组隐藏；
     *   - 搜索时「进阶」组自动展开（否则结果全折叠着，看着像没搜到）。
     * 返回 `{ groups, rows }`，`rows` 用于顶部显示"匹配 N 组 / M 行"。
     */
    function filterGroups(groups, query) {
      const list = Array.isArray(groups) ? groups : []
      const needle = String(query ?? '').trim().toLowerCase()
      if (needle === '') return { groups: list, rows: 0, filtering: false }
      const hit = (text) => String(text ?? '').toLowerCase().includes(needle)
      const kept = []
      let rows = 0
      for (const group of list) {
        const groupRows = Array.isArray(group.rows) ? group.rows : []
        const titleHit = hit(group.title)
        const matched = titleHit
          ? groupRows
          : groupRows.filter((row) => hit(row.label) || hit(row.key) || hit(row.hint)
            || (row.number && (hit(row.number.label) || hit(row.number.key))))
        if (matched.length === 0) continue
        rows += matched.length
        kept.push({ ...group, rows: matched })
      }
      return { groups: kept, rows, filtering: true }
    }

    function Group({ group, busy, onSet, bridge, expandAdvanced = false }) {
      const note = group.note ? h('div', { className: 'qqai-note' }, richText(group.note)) : null
      // ★ v0.7.0：组级**运行时状态**（目前只有「实验性」组有：出口挂载 / provider / 最近一次注入）。
      const status = Array.isArray(group.status) && group.status.length > 0
        ? h('div', { className: 'qqai-status' }, group.status.map((line, index) => h('div', { key: `st-${index}` }, line)))
        : null
      // 五种行混排：布尔 / 数值 / 「开关 + 数值」合并行 / 时段列表 / 号码列表，按 `row.type` 分派。
      const body = h('div', null, note, status, group.rows.map((row) => (
        row.type === 'switchNumber'
          ? h(SwitchNumberRow, { key: row.key, row, busy, onSet })
          : row.type === 'times'
            ? h(TimesRow, { key: row.key, row, busy, onSet })
            : row.type === 'list'
              ? h(ListRow, { key: row.key, row, busy, onSet, bridge })
              : row.type === 'patterns'
                ? h(PatternsRow, { key: row.key, row, busy, onSet })
                : row.type === 'number'
                ? h(NumberRow, { key: row.key, row, busy, onSet })
                : h(Row, { key: row.key, row, busy, onSet })
      )))
      if (group.advanced !== true) {
        return h('div', { className: 'qqai-group' },
          h('div', { className: 'qqai-group-head', style: { padding: '10px 12px', fontWeight: 600, background: 'var(--dsw-alias-bg-layer-2,#f6f7f9)' } }, group.title),
          body)
      }
      // 搜索时强制展开：否则命中的开关藏在折叠里，看着像"没搜到"。
      return h('details', { className: 'qqai-group', open: expandAdvanced === true ? true : undefined },
        h('summary', null, `${group.title}（进阶）`),
        body)
    }

    /**
     * 渲染兜底：**插件里任何一个渲染异常都不该把整页设置带成白屏**。
     *
     * 真机事故（2026-10-04 用户："为啥点击刷新二维码会白屏"）：`onRefreshQr` 里写成
     * `setState({ qrStamp })`（整对象替换）→ 把 `data` 清掉 → 下一帧读 `data.napcat` 抛错 →
     * React 直接把整棵树卸掉，用户看到的就是**一片白**，连"哪出错了"都不知道。
     * 根因已在 `onRefreshQr` 修掉（改成函数式更新），这里再加一道边界：以后再有类似 bug，
     * 面板位置会显示一句人话 + 重试按钮，而不是白屏。
     */
    class PanelBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: '' } }
      static getDerivedStateFromError(error) { return { error: String(error?.message ?? error) } }
      render() {
        if (this.state.error !== '') {
          return h('div', { className: 'qqai-wrap' },
            h('style', null, CSS),
            h('div', { className: 'qqai-err' }, `QQ助手面板渲染出错：${this.state.error}`,
              h('div', null, '（已隔离，不影响其它设置项。点下面重试，若一直失败请把这句话报给开发者。）')),
            h('button', {
              className: 'qqai-retry',
              onClick: () => this.setState({ error: '' }),
            }, '重试'))
        }
        return this.props.children
      }
    }

    /** 写入值的人话显示：布尔说"开/关"，数值直接写，时段说"N 段"。 */
    function shownValue(value) {
      if (Array.isArray(value)) return `${value.length} ${value.every((item) => typeof item === 'number') ? '条' : '段'}`
      if (typeof value === 'number') return String(value)
      return value ? '开' : '关'
    }

    /**
     * 待写队列 + 合并计时器（v0.6.8「连续开几个开关鬼畜」的修法，见 QqAiPanel.flushQueue）：
     * 放在工厂作用域（不是组件里），这样多次渲染共用同一份队列。
     */
    const pendingWrites = new Map()
    let flushTimer = null
    let flushing = false
    /** 写完之后"变灰不许按"的时长：要盖住宿主热重载（实测 ~2.3 秒）。 */
    const COOLING_MS = 3000
    let coolTimer = null

    function QqAiPanel() {
      const [state, setState] = useState({ status: 'loading', data: null, error: '', flash: '', busyKey: '', busyAction: '', qrStamp: Date.now(), watchingQr: false, refreshing: false, cooling: false, filter: '' })

      /**
       * 拉一次面板。
       *
       * `announce`：只有**用户点「刷新」**时才为真——按钮要变成「刷新中…」，成功后还要回一句
       * "已刷新：N 组 / M 行 · 宿主 vX.Y.Z"。为什么要有这句（v0.6.8）：以前点刷新，
       * 成功时界面**一个像素都不变**（载荷一样就什么都不动），看起来就像按钮坏了；
       * 而后台自动轮询（盯二维码）不该弹提示，所以只有手动刷新才 announce。
       *
       * 载荷一律先过 `applyOptimistic`：还有没生效的本地写入时，把它们盖回去——
       * 否则"写完 3 秒自动刷新"若碰上宿主还没重载完，界面会**退回旧值**（用户 2026-10-19
       * 「为啥静默时段还是需要刷新」）。
       */
      const load = useCallback(async (options) => {
        const announce = options?.announce === true
        if (announce) setState((prev) => ({ ...prev, refreshing: true }))
        try {
          const data = applyOptimistic(await callJson('/qqai/panel'))
          const groups = Array.isArray(data?.groups) ? data.groups : []
          const rowCount = groups.reduce((sum, group) => sum + (Array.isArray(group.rows) ? group.rows.length : 0), 0)
          // 保留 qrStamp（用它做二维码的防缓存参数），其余按新载荷覆盖。
          setState((prev) => ({
            ...prev,
            status: 'ready',
            data,
            error: '',
            flash: announce ? `已刷新：${groups.length} 组 / ${rowCount} 行 · 宿主 v${data?.pluginVersion ?? '?'}` : '',
            busyKey: '',
            refreshing: false,
          }))
        } catch (error) {
          setState((prev) => ({ ...prev, status: 'error', data: null, error: String(error?.message ?? error), flash: '', busyKey: '', refreshing: false }))
        }
      }, [])

      useEffect(() => { void load() }, [load])

      /**
       * **合并写入**（v0.6.8，用户 2026-10-19「连续开了几个开关以后就会鬼畜」）：
       *   每写一个键宿主就要热重载一次（实测 ~2.3 秒），连点几个开关 = 几次重载互相打断 ⇒ 面板鬼畜。
       *   所以点击只进"待写队列"，350ms 内的多次点击**合成一次批量写入**（`/qqai/panel/set-batch`），
       *   一次写盘 ⇒ 宿主只重载一次。点完界面立刻变（乐观更新，开关自带官方那种滑动动画）。
       *
       * ⚠️ 写完**不自动轮询**（用户 2026-10-19「还是改成玩家进行手动刷新」）：
       *   生效与否由用户点「刷新」自己看——在这之前那一行会带「更新中」徽标，状态是诚实的。
       */
      const flushQueue = useCallback(async () => {
        if (pendingWrites.size === 0 || flushing === true) return
        const entries = [...pendingWrites.entries()].map(([key, value]) => ({ key, value }))
        pendingWrites.clear()
        flushing = true
        setState((prev) => ({ ...prev, busyKey: entries[0].key, error: '' }))
        try {
          const result = entries.length === 1
            ? await callJson('/qqai/panel/set', { method: 'POST', body: JSON.stringify(entries[0]) })
            : await callJson('/qqai/panel/set-batch', { method: 'POST', body: JSON.stringify({ entries }) })
          let data = result.panel ?? state.data
          // 写成功了：值记进"未生效"表，之后每次拉载荷都会把它盖回去，直到宿主真的用上。
          if (result.changed === true) for (const item of entries) optimisticValues.set(item.key, item.value)
          for (const item of entries) data = applyWrittenValue(data, item.key, item.value)
          const label = entries.length === 1 ? `${entries[0].key} → ${shownValue(entries[0].value)}` : `${entries.length} 个开关`
          /**
           * ⚠️ 必须用**函数式**更新（`(prev) => ({ ...prev, … })`）。
           * 这里以前写成 `setState({ status: 'ready', … })` —— React 的 `setState(object)` 是**整对象替换**，
           * 会把 `cooling`（还有 qrStamp / watchingQr）一起抹掉 ⇒ 350ms 时控件就"又亮了"，
           * 3 秒的冷却形同虚设（用户 2026-10-19「不是灰三秒吗？为啥一下就亮了」）。
           */
          setState((prev) => ({
            ...prev,
            status: 'ready',
            data,
            busyKey: '',
            busyAction: '',
            error: '',
            flash: `${label}${result.changed === true
              ? `（已写入配置，${COOLING_MS / 1000} 秒内先别动，之后自动刷新…）`
              : '（无需改动）'}`,
          }))
        } catch (error) {
          // 写失败：把这几个键从"未生效"表里撤掉（否则界面会一直显示一个没写进去的值），
          // 立刻解锁（不必等那 3 秒），并把面板拉回真实状态。
          for (const item of entries) optimisticValues.delete(item.key)
          if (coolTimer !== null) { clearTimeout(coolTimer); coolTimer = null }
          setState((prev) => ({ ...prev, busyKey: '', cooling: false, error: `写入失败：${String(error?.message ?? error)}` }))
          void load()
        } finally {
          flushing = false
        }
      }, [load, state.data])

      /**
       * 点一下开关（**启用或关闭都一样**）：
       *   ① 立刻改本地状态（乐观更新，开关带官方那种滑动动画）；
       *   ② **马上变灰锁 3 秒**（`COOLING_MS`）——期间所有开关/数字/按钮不可点；
       *   ③ 350ms 后把这一下（或这几下）合成一次写入；
       *   ④ 3 秒到了自动刷新一次，拿回重载后的真实值。
       * 为什么锁 3 秒：实测宿主应用 patch 要 ~2.3 秒（重载插件 + 重挂路由）。锁住就不会"重载没完
       * 又点下一个开关 ⇒ 几次重载互相打断"的鬼畜；刷新的那一次正好把「更新中」抹掉。
       */
      const toggle = useCallback((key, value) => {
        pendingWrites.set(key, value)
        // 记进"未生效"表：这 350ms + 之后的 3 秒里若有人点「刷新」，界面也不会退回旧值。
        optimisticValues.set(key, value)
        setState((prev) => ({
          ...prev,
          error: '',
          cooling: true,
          flash: `${key} → ${shownValue(value)}（已改，${COOLING_MS / 1000} 秒内先别动，之后自动刷新…）`,
          data: applyWrittenValue(prev.data, key, value),
        }))
        if (coolTimer !== null) clearTimeout(coolTimer)
        coolTimer = setTimeout(() => {
          coolTimer = null
          setState((prev) => ({ ...prev, cooling: false }))
          void load({ announce: true })
        }, COOLING_MS)
        if (flushTimer !== null) clearTimeout(flushTimer)
        flushTimer = setTimeout(() => { flushTimer = null; void flushQueue() }, 350)
      }, [flushQueue, load])

      /**
       * 快捷操作（启动 NapCat / 重新登录）。
       * 这里故意**不用** callJson：`ok:false` 的那些回执（比如"已经在运行了""没找到加载器"）
       * 是**解释**不是错误，得原样显示给用户，不能因为 ok!==true 就抛成异常。
       */
      const runAction = useCallback(async (path, label) => {
        setState((prev) => ({ ...prev, busyAction: path, error: '', flash: '' }))
        try {
          const response = await fetch(path, {
            method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: '{}',
          })
          let payload = null
          try { payload = await response.json() } catch { /* 下面按状态码报错 */ }
          if (payload === null) throw new Error(`HTTP ${response.status}`)
          setState((prev) => ({
            ...prev,
            status: 'ready',
            data: payload.panel ?? prev.data,
            busyKey: '',
            busyAction: '',
            error: payload.ok === true ? '' : `${label}：${payload.reason}`,
            flash: payload.ok === true ? `${label}：${payload.reason}${payload.note ? `（${payload.note}）` : ''}` : '',
            // 启动/重启成功 ⇒ **开始盯二维码**（用户 2026-10-04："应该在启动旁边加个提示，
            // 比如过会会出现二维码，而不是什么也没有"）——NapCat 起来后还要几秒才写出那张图，
            // 所以这段时间面板自己每 3 秒刷一次，图一出来就自动显示。
            watchingQr: payload.ok === true ? true : prev.watchingQr,
          }))
        } catch (error) {
          setState((prev) => ({ ...prev, busyAction: '', error: `${label}失败：${String(error?.message ?? error)}` }))
        }
      }, [state.data])

      /**
       * 盯着二维码：启动/重启之后，NapCat 要过几秒才把码写进 `cache/qrcode.png`。
       * 这里每 3 秒拉一次面板，**图一出现就停**（并在下面把它显示出来）；
       * 90 秒还没等到就停下并给一句人话，免得用户对着"什么都没有"发呆。
       */
      useEffect(() => {
        if (state.watchingQr !== true) return undefined
        const timer = setInterval(() => { void load() }, 3000)
        const giveUp = setTimeout(() => {
          setState((prev) => (prev.watchingQr === true
            ? { ...prev, watchingQr: false, flash: '还没看到二维码：点「QQ助手账号」看看扫码页，或再点一次「启动 NapCat」' }
            : prev))
        }, 90_000)
        return () => { clearInterval(timer); clearTimeout(giveUp) }
      }, [state.watchingQr, load])
      useEffect(() => {
        if (state.watchingQr === true && state.data?.napcat?.qr?.fresh === true) {
          setState((prev) => ({ ...prev, watchingQr: false, flash: '二维码已经出来了，用手机 QQ 扫下面那张即可' }))
        }
      }, [state.data, state.watchingQr])

      if (state.status === 'loading') return h('div', { className: 'qqai-wrap' }, h('style', null, CSS), h('div', { className: 'qqai-meta' }, '读取中…'))
      if (state.status === 'error') {
        return h('div', { className: 'qqai-wrap' },
          h('style', null, CSS),
          h('div', { className: 'qqai-err' }, `读取面板失败：${state.error}`, h('div', null, '如果是刚装好插件，先刷新一次页面；还不行再重启 DSH 让路由挂上。')),
          h('button', { className: 'qqai-retry', onClick: () => { setState({ status: 'loading', data: null, error: '', flash: '', busyKey: '' }); void load() } }, '重试'))
      }

      const data = state.data
      /**
       * 前端 bundle 落后于宿主：浏览器只在**页面加载时**取一次 bundle，插件更新后当前页面还攥着旧的那份。
       * 与其让人对着没变化的界面猜，不如直接说出来并给一个按钮（一次性动作，不需要重启 DSH）。
       */
      const hostVersion = typeof data.pluginVersion === 'string' ? data.pluginVersion : ''
      const staleClient = hostVersion !== '' && hostVersion !== '?' && hostVersion !== CLIENT_VERSION
      // ★ v0.6.9 面板搜索：纯前端过滤（不发请求、不改配置），见 filterGroups()。
      const shown = filterGroups(data.groups, state.filter)
      return h('div', { className: 'qqai-wrap' },
        h('style', null, CSS),
        staleClient
          ? h('div', { className: 'qqai-stale' },
            h('span', null, `面板前端还是 v${CLIENT_VERSION}，宿主已经是 v${hostVersion} —— 刷新一次页面即可（不用重启 DSH）`),
            h('button', { type: 'button', onClick: () => { try { location.reload() } catch { /* 桌面端不允许就手动刷新 */ } } }, '刷新页面'))
          : null,
        h('div', { className: 'qqai-head' },
          h('span', { className: 'qqai-title' }, 'QQ助手',
            // 显示的版本 = **宿主里正加载的那份代码**（服务端在模块加载时读 package.json）。
            // 它没变 ⇒ 说明宿主还在跑旧代码（页面上看不到新加的分组时，先看这里再决定要不要重载）。
            typeof data.pluginVersion === 'string' && data.pluginVersion !== ''
              ? h('span', { className: 'qqai-ver', title: '宿主当前加载的插件版本；点「刷新」看它有没有变' }, ` v${data.pluginVersion}`)
              : null),
          h('input', {
            className: 'qqai-search', type: 'search', value: state.filter ?? '',
            placeholder: '搜索开关 / 配置键名…', 'aria-label': '搜索面板里的开关',
            title: '按中文标签或配置键名过滤（纯前端，不改任何配置）；清空恢复全部',
            onChange: (event) => {
              const value = String(event.target.value ?? '')
              // 函数式更新：整对象替换会把 data 一起清掉（真机白屏事故，见 PanelBoundary 的注释）。
              setState((prev) => ({ ...prev, filter: value }))
            },
          }),
          h('button', {
            className: 'qqai-refresh',
            onClick: () => void load({ announce: true }),
            disabled: state.busyKey !== '' || state.refreshing === true || state.cooling === true,
            title: '重新从宿主拉一次面板数据（会显示拉到了几组几行、宿主是哪一版）',
          }, state.refreshing === true ? '刷新中…' : '刷新')),
        // 顶部第一块是「快捷操作」（启动 NapCat / 重新登录）——用户 2026-10-04："把快捷操作拉到相关链接上边"。
        // 理由也顺：没起来的时候，"把它启动起来"比"点开账号页"更该先看到。
        h(Actions, {
          napcat: data.napcat,
          busy: state.busyAction,
          onAction: runAction,
          qrStamp: state.qrStamp,
          onRefreshQr: () => {
            // ⚠️ 这里**必须**用函数式更新（`(prev) => ({...prev, ...})`）：整对象替换会把 `data` 一起清掉，
            //    下一帧 `data.napcat` 取不到 → React 渲染直接抛错 → **整页白屏**（真机踩过）。
            setState((prev) => ({ ...prev, qrStamp: Date.now() }))
            void load()
          },
        }),
        // 紧接着是「相关链接」整组（第一条是账号入口）。
        h(Links, { links: data.links }),
        // ★ v0.6.8：桥的连接状态（"登录了 NapCat 却一点反馈都没有"就靠这一行回答）。
        h(BridgeLine, { bridge: data.bridge }),
        h('div', { className: 'qqai-meta' },
          `profile：${data.profile} · 配置文件：${data.patchFile}${data.patchExists === false ? '（不存在）' : ''}`),
        h('div', { className: 'qqai-meta' }, data.notes?.apply ?? ''),
        h('div', { className: 'qqai-meta' }, data.notes?.scope ?? ''),
        state.flash ? h('div', { className: 'qqai-flash' }, state.flash) : null,
        state.error ? h('div', { className: 'qqai-err' }, state.error) : null,
        (Array.isArray(data.warnings) ? data.warnings : []).map((text, index) => h('div', { key: `warn-${index}`, className: 'qqai-warn' }, `⚠️ ${text}`)),
        // 搜索状态那一行：只在真在搜的时候出现（平时不占地方）。
        shown.filtering
          ? h('div', { className: 'qqai-meta' },
            shown.groups.length === 0
              ? `没有匹配「${state.filter}」的开关 —— 换个词，或清空搜索框`
              : `匹配 ${shown.groups.length} 组 / ${shown.rows} 行（搜索是纯前端过滤，不影响配置）`)
          : null,
        shown.groups.map((group) => h(Group, {
          key: group.id,
          group,
          busy: state.busyKey !== '' || state.cooling === true,
          onSet: toggle,
          bridge: data.bridge,
          expandAdvanced: shown.filtering === true,
        })),
      )
    }

    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'qqai', order: 45, label: () => 'QQ助手' },
        () => h(PanelBoundary, null, h(QqAiPanel, null)),
      ))
    }

    return module.exports
  },
})
