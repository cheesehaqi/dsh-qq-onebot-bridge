/**
 * lib/feed.js 单测：订阅源（RSS 2.0 / RSS 1.0 RDF / Atom）最小解析器 + 播报文案排版。
 * 全部用**手写的真实格式小片段**，不联网、不依赖任何第三方解析库。
 */
import { parseFeed, formatFeedItems, stripHtml } from '../lib/feed.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

// —— 1. RSS 2.0 完整用例（CDATA + 命名空间扩展标签 + RFC822 时间） ——
const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <!-- 一份最小的 RSS 2.0 源 -->
  <channel>
    <title>某某日报</title>
    <link>https://example.com/</link>
    <description>一份测试源</description>
    <item>
      <title><![CDATA[今天的 &lt;大新闻&gt; 有点多]]></title>
      <link>https://example.com/a</link>
      <description><![CDATA[<p>正文 &amp; 细节</p>]]></description>
      <pubDate>Mon, 02 Jan 2026 15:04:05 +0800</pubDate>
      <guid isPermaLink="false">tag:example.com,2026:a</guid>
    </item>
    <item>
      <title>第二条</title>
      <link>https://example.com/b</link>
      <content:encoded><![CDATA[<b>富文本</b>摘要]]></content:encoded>
      <dc:date>2025-12-31T23:59:59Z</dc:date>
    </item>
  </channel>
</rss>`
const rss2 = parseFeed(RSS2)
check('RSS 2.0 条目数', rss2.items.length === 2, `len=${rss2.items.length}`)
check('RSS 2.0 feed 标题', rss2.title === '某某日报', rss2.title)
check('RSS 2.0 reason 为空', rss2.reason === '')
check('RSS 2.0 排序（新的在前）', rss2.items[0].link === 'https://example.com/a', rss2.items.map((i) => i.link).join(','))
check('RSS 2.0 CDATA 标题解实体压空白', rss2.items[0].title === '今天的 <大新闻> 有点多', rss2.items[0].title)
check('RSS 2.0 CDATA 描述去 HTML 并解实体', rss2.items[0].summary === '正文 & 细节', rss2.items[0].summary)
check('RSS 2.0 时间戳字段是毫秒数', rss2.items[0].pubDate === 1767337445000, String(rss2.items[0].pubDate))
check('RSS 2.0 id 用 guid 原文', rss2.items[0].id === 'tag:example.com,2026:a', rss2.items[0].id)
check('content:encoded 生效', rss2.items[1].summary === '富文本 摘要', rss2.items[1].summary)
check('dc:date 生效', rss2.items[1].pubDate === 1767225599000, String(rss2.items[1].pubDate))
check('缺 guid 时 id 回落到 link', rss2.items[1].id === 'https://example.com/b', rss2.items[1].id)

// —— 2. Atom 完整用例（href 属性链接 + ISO8601 时间） ——
const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 测试源</title>
  <updated>2026-01-03T00:00:00Z</updated>
  <entry>
    <title>Atom 条目一</title>
    <link rel="alternate" href="https://ex.org/1"/>
    <summary>一段 &hellip; 摘要</summary>
    <updated>2026-01-02T03:04:05Z</updated>
    <id>urn:uuid:1</id>
  </entry>
  <entry>
    <title>Atom 条目二</title>
    <link href='https://ex.org/2'/>
    <content type="html">&lt;p&gt;内容&lt;/p&gt;</content>
    <published>2026-01-03T00:00:00Z</published>
  </entry>
</feed>`
const atom = parseFeed(ATOM)
check('Atom 条目数', atom.items.length === 2, `len=${atom.items.length}`)
check('Atom feed 标题', atom.title === 'Atom 测试源', atom.title)
check('Atom 按 updated/published 降序', atom.items[0].title === 'Atom 条目二', atom.items.map((i) => i.title).join(','))
check('Atom link 用 href 属性', atom.items[0].link === 'https://ex.org/2', atom.items[0].link)
check('Atom 单引号 href 也认', atom.items[1].link === 'https://ex.org/1', atom.items[1].link)
check('Atom content 反转义后去标签', atom.items[0].summary === '<p>内容</p>', atom.items[0].summary)
check('Atom summary 解 &hellip;', atom.items[1].summary === '一段 … 摘要', atom.items[1].summary)
check('Atom published 时间戳', atom.items[0].pubDate === 1767398400000, String(atom.items[0].pubDate))
check('Atom 缺 link/id 时 id 回落 link', atom.items[0].id === 'https://ex.org/2', atom.items[0].id)
check('Atom 保留 <id> 原文', atom.items[1].id === 'urn:uuid:1', atom.items[1].id)

// —— 3. RSS 1.0 / RDF 完整用例（item 在 channel 外） ——
const RDF = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="https://rdf.example/">
    <title>RDF 源</title>
    <link>https://rdf.example/</link>
    <description>RDF 站点描述</description>
  </channel>
  <item rdf:about="https://rdf.example/1">
    <title>RDF 条目一</title>
    <link>https://rdf.example/1</link>
    <description>第一条说明</description>
    <dc:date>2026-01-01T00:00:00Z</dc:date>
  </item>
  <item rdf:about="https://rdf.example/2">
    <title>RDF 条目二</title>
    <link>https://rdf.example/2</link>
    <description>第二条说明</description>
    <dc:date>2026-01-05T12:00:00Z</dc:date>
  </item>
</rdf:RDF>`
const rdf = parseFeed(RDF)
check('RDF 条目数', rdf.items.length === 2, `len=${rdf.items.length}`)
check('RDF feed 标题取 channel > title', rdf.title === 'RDF 源', rdf.title)
check('RDF 排序用 dc:date', rdf.items[0].title === 'RDF 条目二' && rdf.items[1].title === 'RDF 条目一', rdf.items.map((i) => i.title).join(','))
check('RDF 链接取 <link> 文本', rdf.items[0].link === 'https://rdf.example/2', rdf.items[0].link)
check('RDF 摘要取 description', rdf.items[0].summary === '第二条说明', rdf.items[0].summary)
check('RDF 无 guid 时 id 回落 link', rdf.items[0].id === 'https://rdf.example/2', rdf.items[0].id)
check('RDF 时间戳正确', rdf.items[0].pubDate === 1767614400000, String(rdf.items[0].pubDate))

// —— 4. 标签大小写差异 + 自闭合标签 + 无引号属性 ——
const UPPER = '<RSS><CHANNEL><TITLE>大写源</TITLE><ITEM><TITLE>大写条目</TITLE><LINK>https://ex.org/u</LINK><DESCRIPTION>说明</DESCRIPTION></ITEM></CHANNEL></RSS>'
const upper = parseFeed(UPPER)
check('全大写标签也能解析', upper.items.length === 1 && upper.title === '大写源', JSON.stringify(upper.title))
check('全大写条目标题/链接', upper.items[0].title === '大写条目' && upper.items[0].link === 'https://ex.org/u', JSON.stringify(upper.items[0]))
const NOQUOTE = '<feed><title>x</title><entry><title>t</title><LINK HREF=https://ex.org/nq /></entry></feed>'
check('无引号 href 属性', parseFeed(NOQUOTE).items[0].link === 'https://ex.org/nq', parseFeed(NOQUOTE).items[0].link)
check('自闭合 link 不吞后续内容', parseFeed(NOQUOTE).items[0].title === 't')

// —— 5. 摘要字段优先级 content:encoded > content > summary > description ——
const PRIO = '<feed><title>x</title><entry><title>t</title><description>desc</description><summary>sum</summary><content>cont</content><content:encoded>enc</content:encoded></entry></feed>'
check('摘要优先取 content:encoded', parseFeed(PRIO).items[0].summary === 'enc', parseFeed(PRIO).items[0].summary)
const PRIO2 = '<feed><title>x</title><entry><title>t</title><description>desc</description><summary>sum</summary></entry></feed>'
check('无 encoded 时取 summary', parseFeed(PRIO2).items[0].summary === 'sum', parseFeed(PRIO2).items[0].summary)
const PRIO3 = '<feed><title>x</title><entry><title>t</title><content type="html">正文</content></entry></feed>'
check('只有 content 时取 content', parseFeed(PRIO3).items[0].summary === '正文', parseFeed(PRIO3).items[0].summary)

// —— 5b. 跨行 CDATA 与 CDATA 里的实体 ——
const CDATA = '<item><title><![CDATA[\n  多行\n  标题 &amp; 尾巴 &#8212; 结束\n]]></title><description><![CDATA[<div class="x">\n  <p>第一段</p>\n  <p>第二段 &#x1F600;</p>\n</div>]]></description></item>'
const cdata = parseFeed(CDATA).items[0]
check('CDATA 标题压掉换行与缩进', cdata.title === '多行 标题 & 尾巴 — 结束', JSON.stringify(cdata.title))
check('CDATA 描述去标签压空白并解实体', cdata.summary === '第一段 第二段 😀', JSON.stringify(cdata.summary))

// —— 6. 摘要超长截断到 300 字（含省略号） ——
const LONGDESC = `<item><title>长文</title><description>${'字'.repeat(350)}</description></item>`
const longSummary = parseFeed(LONGDESC).items[0].summary
check('摘要截断到 300 字 + 省略号', longSummary.length === 301 && longSummary.endsWith('…'), `len=${longSummary.length}`)
check('摘要截断保留前 300 字', longSummary.startsWith('字'.repeat(300)))

// —— 7. 时间解析：RFC822 / ISO8601 / 解析不了 → 0 ——
const dateOfItem = (xml) => parseFeed(`<item><title>t</title>${xml}</item>`).items[0].pubDate
check('RFC822 时间', dateOfItem('<pubDate>Mon, 02 Jan 2026 15:04:05 +0800</pubDate>') === 1767337445000)
check('ISO8601 时间', dateOfItem('<pubDate>2026-01-02T03:04:05Z</pubDate>') === 1767323045000)
check('只有日期的时间', dateOfItem('<pubDate>2026-01-02</pubDate>') === 1767312000000)
check('无法解析的时间 → 0', dateOfItem('<pubDate>sometime</pubDate>') === 0)
check('中文描述当时间 → 0', dateOfItem('<pubDate>第 3 期</pubDate>') === 0)
check('非法日期 → 0', dateOfItem('<pubDate>Mon, 32 Jan 2026 15:04:05 +0800</pubDate>') === 0)
check('完全没有时间字段 → 0', dateOfItem('<description>没有时间</description>') === 0)
check('时间字段优先级 pubDate 先于 dc:date', dateOfItem('<dc:date>2020-01-01T00:00:00Z</dc:date><pubDate>Mon, 02 Jan 2026 15:04:05 +0800</pubDate>') === 1767337445000)

// —— 8. 排序：时间降序；时间全为 0 时保持原顺序 ——
const UNSORTED = `<rss><channel><title>乱序</title>
<item><title>中间</title><link>https://ex.org/m</link><pubDate>2026-01-02T00:00:00Z</pubDate></item>
<item><title>最新</title><link>https://ex.org/n</link><pubDate>2026-03-02T00:00:00Z</pubDate></item>
<item><title>最旧</title><link>https://ex.org/o</link><pubDate>2025-12-02T00:00:00Z</pubDate></item>
</channel></rss>`
check('乱序条目按时间降序', parseFeed(UNSORTED).items.map((i) => i.title).join(',') === '最新,中间,最旧', parseFeed(UNSORTED).items.map((i) => i.title).join(','))
const NO_TIME = '<rss><channel><title>无时间</title><item><title>甲</title></item><item><title>乙</title></item><item><title>丙</title></item></channel></rss>'
check('时间全为 0 时保持原顺序', parseFeed(NO_TIME).items.map((i) => i.title).join('') === '甲乙丙', parseFeed(NO_TIME).items.map((i) => i.title).join(''))

// —— 9. limit 截断与防御 ——
const FIVE = `<rss><channel><title>五条</title>${[0, 1, 2, 3, 4].map((n) => `<item><title>第${n}条</title><pubDate>2026-01-0${n + 1}T00:00:00Z</pubDate></item>`).join('')}</channel></rss>`
check('limit 默认 10（5 条全给）', parseFeed(FIVE).items.length === 5, `len=${parseFeed(FIVE).items.length}`)
const limited = parseFeed(FIVE, { limit: 2 })
check('limit 截断到 2 条', limited.items.length === 2, `len=${limited.items.length}`)
check('limit 截断后保留最新两条', limited.items.map((i) => i.title).join(',') === '第4条,第3条', limited.items.map((i) => i.title).join(','))
check('limit 为 0 回落到 10', parseFeed(FIVE, { limit: 0 }).items.length === 5)
check('limit 为 NaN 回落到 10', parseFeed(FIVE, { limit: NaN }).items.length === 5)
check('limit 为非数字字符串回落到 10', parseFeed(FIVE, { limit: 'x' }).items.length === 5)
check('options 为 null 不崩', parseFeed(RSS2, null).items.length === 2)
check('options 为非对象不崩', parseFeed(RSS2, 'nope').items.length === 2)
check('now 参数不影响结果', parseFeed(RSS2, { now: 0 }).items.length === 2)

// —— 10. 缺字段兜底 ——
const BARE = parseFeed('<item><title>只有标题</title></item>')
check('缺 link/summary 时给空串', BARE.items[0].link === '' && BARE.items[0].summary === '' && BARE.items[0].id === '', JSON.stringify(BARE.items[0]))
const NO_TITLE = parseFeed('<item><link>https://ex.org/x</link></item>')
check('缺 title → 空串', NO_TITLE.items[0].title === '', JSON.stringify(NO_TITLE.items[0]))
check('缺 title 的条目仍保留', NO_TITLE.items.length === 1 && NO_TITLE.items[0].link === 'https://ex.org/x')
check('空 title 标签 → 空串', parseFeed('<item><title></title><link>https://ex.org/e</link></item>').items[0].title === '')
check('只有空标签的条目也保留', parseFeed('<item><title></title></item>').items.length === 1)
const NO_FEED_TITLE = parseFeed('<rss><channel><item><title>无源标题</title></item></channel></rss>')
check('feed 标题缺失 → 空串', NO_FEED_TITLE.title === '' && NO_FEED_TITLE.reason === '')
check('不把条目标题当 feed 标题', NO_FEED_TITLE.title === '')
check('rdf:about 属性不会当标题', parseFeed(RDF).title === 'RDF 源')

// —— 11. 畸形输入：绝不抛错 ——
check('空串 → 内容为空', parseFeed('').reason === '内容为空' && parseFeed('').items.length === 0)
check('空白串 → 内容为空', parseFeed('   \n\t ').reason === '内容为空')
check('null → 内容为空', parseFeed(null).reason === '内容为空')
check('undefined → 内容为空', parseFeed(undefined).reason === '内容为空')
check('数组 → 内容为空', parseFeed(['<item><title>a</title></item>']).reason === '内容为空')
check('数字 → 内容为空', parseFeed(42).reason === '内容为空')
check('纯文本 → 没有解析出条目', parseFeed('这不是 XML，只是一段话').reason === '没有解析出条目')
check('HTML 页面 → 没有解析出条目', parseFeed('<html><body><h1>首页</h1><p>正文</p></body></html>').reason === '没有解析出条目')
check('截断的 XML 不抛错（条目没闭合）', parseFeed('<rss><channel><title>t</title><item><title>未闭合').items.length === 0)
check('未闭合的 item 标签不抛错', parseFeed('<item><title>未闭合').items.length === 0)
check('空 channel → 没有解析出条目', parseFeed('<rss><channel></channel></rss>').reason === '没有解析出条目')
check('只有声明没有内容', parseFeed('<?xml version="1.0"?>').reason === '没有解析出条目')
check('item 里塞垃圾也能返回', parseFeed('<item>???</item>').items.length === 1)
check('超长垃圾输入不抛错', parseFeed(`<rss><channel><title>t</title>${'<item>'.repeat(200)}${'x'.repeat(50000)}`).reason === '没有解析出条目')
check('截断在多字节中间的 XML 不抛错', parseFeed('<?xml version="1.0"?><rss><channel><title>中文标题被截').reason === '没有解析出条目')
check('entry 在前时优先 item 块', parseFeed('<rss><channel><title>混排</title><entry><title>entry 在前</title></entry><item><title>item 在后</title></item></channel></rss>').items[0].title === 'item 在后')
check('完全没有 item 的 Atom 用 entry', parseFeed('<feed><title>f</title><entry><title>只有 entry</title></entry></feed>').items[0].title === '只有 entry')

// —— 12. stripHtml ——
check('stripHtml 去 script 整段', stripHtml('<script>var a = 1;</script>可见') === '可见', stripHtml('<script>var a = 1;</script>可见'))
check('stripHtml 去 style 整段', stripHtml('前<style>.x { color: red }</style>后') === '前 后', stripHtml('前<style>.x { color: red }</style>后'))
check('stripHtml 去 script 属性与换行', stripHtml('<script type="text/javascript">\nfoo();\n</script>标题') === '标题', stripHtml('<script type="text/javascript">\nfoo();\n</script>标题'))
check('stripHtml 去标签（标签处留空格）', stripHtml('<p>段落<b>加粗</b></p>') === '段落 加粗', stripHtml('<p>段落<b>加粗</b></p>'))
check('stripHtml 解命名实体', stripHtml('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;') === `a & b <c> "d" 'e'`, stripHtml('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;'))
check('stripHtml 解 &nbsp; &mdash; &hellip;', stripHtml('a&nbsp;b&mdash;c&hellip;') === 'a b—c…', stripHtml('a&nbsp;b&mdash;c&hellip;'))
check('stripHtml 解十进制数字实体', stripHtml('&#20013;&#25991;') === '中文', stripHtml('&#20013;&#25991;'))
check('stripHtml 解十六进制实体', stripHtml('&#x1F600;') === '😀', stripHtml('&#x1F600;'))
check('stripHtml 非法码点原样保留', stripHtml('&#x110000;') === '&#x110000;', stripHtml('&#x110000;'))
check('stripHtml 压空白并 trim', stripHtml('  a\n\n  b\t c  ') === 'a b c', stripHtml('  a\n\n  b\t c  '))
check('stripHtml 去注释', stripHtml('前<!-- 注释 -->后') === '前 后', stripHtml('前<!-- 注释 -->后'))
check('stripHtml 展开裸 CDATA 包裹', stripHtml('<![CDATA[原文标签 <b>]]>') === '原文标签', stripHtml('<![CDATA[原文标签 <b>]]>'))
check('stripHtml 非字符串 → 空串', stripHtml(null) === '' && stripHtml(undefined) === '' && stripHtml(42) === '' && stripHtml({}) === '')
check('stripHtml 空串 → 空串', stripHtml('') === '' && stripHtml('   ') === '')

// —— 13. formatFeedItems：表头两行与单条三段 ——
const fmtItems = [
  { title: '第一条新闻', link: 'https://ex.org/1', summary: '第一段摘要' },
  { title: '第二条新闻', link: 'https://ex.org/2', summary: '' },
]
const f1 = formatFeedItems(fmtItems, { title: '某某日报' })
const f1Lines = f1.text.split('\n')
check('排版首行 📰 标题', f1Lines[0] === '📰 某某日报', f1Lines[0])
check('排版第二行条数摘要', f1Lines[1] === '共 2 条，显示前 2 条', f1Lines[1])
check('排版条目序号与书名号', f1Lines[2] === '1. 【第一条新闻】', f1Lines[2])
check('排版摘要行缩进三空格', f1Lines[3] === '   第一段摘要', f1Lines[3])
check('排版链接行缩进三空格', f1Lines[4] === '   https://ex.org/1', f1Lines[4])
check('摘要为空时省略摘要行', f1Lines[5] === '2. 【第二条新闻】' && f1Lines[6] === '   https://ex.org/2', JSON.stringify(f1Lines.slice(5)))
check('无截断时 truncated=false', f1.truncated === false)
check('used/total/chars 语义', f1.used === 2 && f1.total === 2 && f1.chars === f1.text.length, `used=${f1.used} total=${f1.total} chars=${f1.chars}`)
const f2 = formatFeedItems(fmtItems)
check('不给 title 时不输出 📰 行', f2.text.startsWith('共 2 条，显示前 2 条'), f2.text.split('\n')[0])
const f3 = formatFeedItems([{ title: '没有链接', summary: '' }])
check('无 link 时省略链接行', f3.text === '共 1 条，显示前 1 条\n1. 【没有链接】', f3.text)

// —— 14. formatFeedItems：maxTitleChars ——
const f4 = formatFeedItems([{ title: '一二三四五六七八九十', link: '', summary: '' }], { maxTitleChars: 8 })
check('maxTitleChars 截断标题并加省略号', f4.text === '共 1 条，显示前 1 条\n1. 【一二三四五六七八…】', f4.text)
const f5 = formatFeedItems([{ title: '一二三四五六七八九十', link: '', summary: '' }])
check('maxTitleChars 默认 60 不误截', f5.text.includes('【一二三四五六七八九十】'), f5.text)
check('maxTitleChars 为 0 回落默认 60', formatFeedItems([{ title: '短标题' }], { maxTitleChars: 0 }).text.includes('【短标题】'))

// —— 15. formatFeedItems：maxChars 硬截断 ——
const LONG_ITEMS = [{ title: '标题一二三四五', link: '', summary: '摘'.repeat(100) }]
const f6 = formatFeedItems(LONG_ITEMS, { maxChars: 10 })
check('maxChars 截断标记用同一句', f6.text.endsWith('…（内容过长已截断）'), f6.text.slice(-14))
check('maxChars 表头完整保留', f6.text.split('\n')[0] === '共 1 条，显示前 1 条', f6.text.split('\n')[0])
check('maxChars 正文被截到 10 字', f6.text.endsWith('1. 【标题一二三四…（内容过长已截断）') && !f6.text.includes('摘摘摘'), f6.text)
check('maxChars 截断时 used 仍算已排入的条数', f6.used === 1 && f6.total === 1, `used=${f6.used}`)
// maxChars 是正文（不含表头两行）的硬上限。
// 边界用例用**只有标题行**的条目，正文长度才是确定的 "1. 【标题一二三四五】" = 12
const ONLY_TITLE = [{ title: '标题一二三四五', link: '', summary: '' }]
const bodyLen = '1. 【标题一二三四五】'.length
const f7 = formatFeedItems(ONLY_TITLE, { maxChars: bodyLen })
check('maxChars 等于正文长度时不截断', f7.truncated === false && f7.text === `共 1 条，显示前 1 条\n1. 【标题一二三四五】`, f7.text)
const f8 = formatFeedItems(ONLY_TITLE, { maxChars: bodyLen - 1 })
check('maxChars 少 1 字即截断', f8.truncated === true && f8.text.endsWith('…（内容过长已截断）'), f8.text.slice(-14))
check('maxChars 截断后 chars 与文本一致', f8.chars === f8.text.length, `chars=${f8.chars}`)
const f8b = formatFeedItems(LONG_ITEMS, { maxChars: bodyLen })
check('maxChars 不等时长摘要也会被截掉', f8b.truncated === true && f8b.text.endsWith('…（内容过长已截断）'), f8b.text)

// —— 16. formatFeedItems：limit ——
const TEN = Array.from({ length: 10 }, (_, i) => ({ title: `条目${i}`, link: `https://ex.org/${i}`, summary: '' }))
const f9 = formatFeedItems(TEN, { limit: 3 })
check('排版 limit 截断 used=3/total=10', f9.used === 3 && f9.total === 10, `used=${f9.used} total=${f9.total}`)
check('排版 limit 条数行提示显示前 3 条', f9.text.split('\n')[0] === '共 10 条，显示前 3 条', f9.text.split('\n')[0])
check('排版 limit 默认 5 条', formatFeedItems(TEN).used === 5, `used=${formatFeedItems(TEN).used}`)
check('排版 limit 为 0 回落默认 5', formatFeedItems(TEN, { limit: 0 }).used === 5)
check('排版 limit 为 NaN 回落默认 5', formatFeedItems(TEN, { limit: NaN }).used === 5)
check('排版 limit 为负数回落默认 5', formatFeedItems(TEN, { limit: -3 }).used === 5)
check('排版 limit 为 Infinity 回落默认 5', formatFeedItems(TEN, { limit: Infinity }).used === 5)

// —— 17. formatFeedItems：非数组 / 空数组 / 脏项 ——
const f10 = formatFeedItems(null)
check('非数组 → 占位文案', f10.text === '（没有可播报的条目）', f10.text)
check('非数组 → used/total/truncated/chars', f10.used === 0 && f10.total === 0 && f10.truncated === false && f10.chars === f10.text.length, JSON.stringify(f10))
check('字符串输入也走占位文案', formatFeedItems('nope').text === '（没有可播报的条目）')
check('undefined 输入也走占位文案', formatFeedItems(undefined).total === 0)
const f11 = formatFeedItems([])
check('空数组仍输出表头', f11.text === '共 0 条，显示前 0 条' && f11.used === 0 && f11.total === 0, f11.text)
const f12 = formatFeedItems([null, 42, 'x', { title: '', link: 'https://ex.org/z' }, { title: '好项', link: 'https://ex.org/good', summary: '有摘要' }])
check('脏项被跳过且不计数 used', f12.used === 1, `used=${f12.used}`)
check('total 仍为传入条数', f12.total === 5, `total=${f12.total}`)
check('脏项跳过后序号从 1 开始', f12.text.split('\n')[1] === '1. 【好项】', f12.text.split('\n')[1])
check('空标题项也跳过（只有链接不算）', !f12.text.includes('https://ex.org/z'))
const f13 = formatFeedItems([{ title: '带标签标题', link: '', summary: 'a&nbsp;b' }])
check('排版按纯文本处理（不再动标签与实体）', f13.text === '共 1 条，显示前 1 条\n1. 【带标签标题】\n   a&nbsp;b', f13.text)
const f14 = formatFeedItems([{ title: '  多   空白  标题  ', link: '', summary: '' }])
check('排版压空白并 trim', f14.text.includes('【多 空白 标题】'), f14.text)
check('options 为 null 不崩', formatFeedItems(fmtItems, null).used === 2)
check('options 为非对象不崩', formatFeedItems(fmtItems, 'nope').used === 2)
check('title 为空白串不输出 📰 行', !formatFeedItems(fmtItems, { title: '   ' }).text.includes('📰'))
check('title 为数字不输出 📰 行', !formatFeedItems(fmtItems, { title: 2026 }).text.includes('📰'))

// —— 18. 端到端：真实抓取形态的源 → QQ 文案 ——
const e2e = parseFeed(RSS2)
const e2eText = formatFeedItems(e2e.items, { title: e2e.title })
check('端到端首行', e2eText.text.split('\n')[0] === '📰 某某日报', e2eText.text.split('\n')[0])
check('端到端条数行', e2eText.text.split('\n')[1] === '共 2 条，显示前 2 条', e2eText.text.split('\n')[1])
check('端到端正文含标题与链接', e2eText.text.includes('1. 【今天的 <大新闻> 有点多】') && e2eText.text.includes('   https://example.com/a'), e2eText.text)
check('端到端 used/total/chars/truncated', e2eText.used === 2 && e2eText.total === 2 && e2eText.truncated === false && e2eText.chars === e2eText.text.length)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
