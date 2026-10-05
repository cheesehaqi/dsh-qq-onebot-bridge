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

    const CSS = `
.qqai-wrap{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary,#111)}
.qqai-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.qqai-title{font-size:15px;font-weight:600}
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

    function Row({ row, busy, onToggle }) {
      const on = row.value === true
      return h('div', { className: 'qqai-row' },
        h('div', { className: 'qqai-text' },
          h('label', { className: 'qqai-label' }, row.label,
            row.pending === true ? h('span', { className: 'qqai-badge', title: '配置文件里的值与当前生效值不一致' }, '待重启') : null,
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
        h('button', {
          className: 'qqai-switch',
          // 与官方 Switch 一致：语义与视觉都挂在 aria-checked 上（不再用自定义 data-on）。
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          disabled: busy === true,
          title: on ? '点一下关闭' : '点一下开启',
          'aria-label': `${row.label}：${on ? '开' : '关'}`,
          onClick: () => onToggle(row.key, !on),
        }, h('span', { className: 'qqai-knob' })))
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
          h('span', { className: 'qqai-hint' }, `NapCat：${running === true ? `运行中（127.0.0.1:${port}）` : '未运行'}${qr.fresh === true ? ` · 二维码 ${qr.ageSeconds} 秒前刷新` : ''}`)),
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

    function Group({ group, busy, onToggle }) {
      const note = group.note ? h('div', { className: 'qqai-note' }, richText(group.note)) : null
      const body = h('div', null, note, group.rows.map((row) => h(Row, { key: row.key, row, busy, onToggle })))
      if (group.advanced !== true) {
        return h('div', { className: 'qqai-group' },
          h('div', { className: 'qqai-group-head', style: { padding: '10px 12px', fontWeight: 600, background: 'var(--dsw-alias-bg-layer-2,#f6f7f9)' } }, group.title),
          body)
      }
      return h('details', { className: 'qqai-group' },
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

    function QqAiPanel() {
      const [state, setState] = useState({ status: 'loading', data: null, error: '', flash: '', busyKey: '', busyAction: '', qrStamp: Date.now() })

      const load = useCallback(async () => {
        try {
          const data = await callJson('/qqai/panel')
          // 保留 qrStamp（用它做二维码的防缓存参数），其余按新载荷覆盖。
          setState((prev) => ({ ...prev, status: 'ready', data, error: '', flash: '', busyKey: '' }))
        } catch (error) {
          setState((prev) => ({ ...prev, status: 'error', data: null, error: String(error?.message ?? error), flash: '', busyKey: '' }))
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const toggle = useCallback(async (key, value) => {
        setState((prev) => ({ ...prev, busyKey: key, error: '', flash: '' }))
        try {
          const result = await callJson('/qqai/panel/set', { method: 'POST', body: JSON.stringify({ key, value }) })
          setState({
            status: 'ready',
            data: result.panel ?? state.data,
            busyKey: '',
            busyAction: '',
            error: '',
            flash: `${key} → ${value ? '开' : '关'}${result.changed === true ? '（已写入配置）' : '（无需改动）'}${result.note ? ' · ' + result.note : ''}`,
          })
        } catch (error) {
          setState((prev) => ({ ...prev, busyKey: '', error: `写入失败：${String(error?.message ?? error)}` }))
        }
      }, [state.data])

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
          setState({
            status: 'ready',
            data: payload.panel ?? state.data,
            busyKey: '',
            busyAction: '',
            error: payload.ok === true ? '' : `${label}：${payload.reason}`,
            flash: payload.ok === true ? `${label}：${payload.reason}${payload.note ? `（${payload.note}）` : ''}` : '',
          })
        } catch (error) {
          setState((prev) => ({ ...prev, busyAction: '', error: `${label}失败：${String(error?.message ?? error)}` }))
        }
      }, [state.data])

      if (state.status === 'loading') return h('div', { className: 'qqai-wrap' }, h('style', null, CSS), h('div', { className: 'qqai-meta' }, '读取中…'))
      if (state.status === 'error') {
        return h('div', { className: 'qqai-wrap' },
          h('style', null, CSS),
          h('div', { className: 'qqai-err' }, `读取面板失败：${state.error}`, h('div', null, '如果是刚装好插件，先重启一次 DSH 让路由挂上。')),
          h('button', { className: 'qqai-retry', onClick: () => { setState({ status: 'loading', data: null, error: '', flash: '', busyKey: '' }); void load() } }, '重试'))
      }

      const data = state.data
      return h('div', { className: 'qqai-wrap' },
        h('style', null, CSS),
        h('div', { className: 'qqai-head' },
          h('span', { className: 'qqai-title' }, 'QQ助手'),
          h('button', { onClick: () => void load(), disabled: state.busyKey !== '' }, '刷新')),
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
        h('div', { className: 'qqai-meta' },
          `profile：${data.profile} · 配置文件：${data.patchFile}${data.patchExists === false ? '（不存在）' : ''}`),
        h('div', { className: 'qqai-meta' }, data.notes?.apply ?? ''),
        h('div', { className: 'qqai-meta' }, data.notes?.scope ?? ''),
        state.flash ? h('div', { className: 'qqai-flash' }, state.flash) : null,
        state.error ? h('div', { className: 'qqai-err' }, state.error) : null,
        (Array.isArray(data.warnings) ? data.warnings : []).map((text, index) => h('div', { key: `warn-${index}`, className: 'qqai-warn' }, `⚠️ ${text}`)),
        data.groups.map((group) => h(Group, { key: group.id, group, busy: state.busyKey !== '', onToggle: toggle })),
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
