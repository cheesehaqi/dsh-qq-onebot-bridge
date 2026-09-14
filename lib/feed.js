/**
 * 定时播报（lib/feed.js）：订阅源（RSS 2.0 / RSS 1.0 RDF / Atom）的**最小解析器** + 播报文案排版。
 *
 * 本插件零第三方依赖，所以这里不引任何 XML 解析库，只做「够用」的轻量扫描：
 * - 标签用 `/<name\b[^>]*>/i` 这类宽松正则捞，**不写完整 XML 解析器**（不处理嵌套语义、
 *   不校验命名空间），只按「起标签 → 同名止标签」切片；
 * - 容错优先：CDATA、属性单/双引号、自闭合标签、大小写标签差异、命名空间前缀
 *   （`dc:date` / `content:encoded`）、畸形/截断/纯文本/HTML 页面，一律安全返回，**绝不抛错**；
 * - 时间字段沿用「能解析成毫秒时间戳就解析，解析不了 → 0」的约定（与 lib/assets.js 一致），
 *   排序时 0 当作「没有时间」排最后，且**保持原顺序**。
 *
 * 纯逻辑：不碰网络、不碰 OneBot、不做任何 IO。真实抓取由 bridge 传进 xml 文本，
 * 所以整个模块可以脱离 bridge 单测（test/feed-unit.mjs）。
 */

/** 正文超长时追加的提示语（与 lib/forward.js、lib/assets.js 用同一句）。 */
const TRUNCATED_MARK = '…（内容过长已截断）'

/** 单条摘要的字符上限（超出加 `…`）。 */
const SUMMARY_MAX_CHARS = 300

/** maxChars 默认值。 */
const DEFAULT_MAX_CHARS = 1200

/** maxTitleChars 默认值。 */
const DEFAULT_MAX_TITLE_CHARS = 60

/** parseFeed 的 limit 默认值。 */
const DEFAULT_PARSE_LIMIT = 10

/** formatFeedItems 的 limit 默认值。 */
const DEFAULT_FORMAT_LIMIT = 5

/** 摘要字段优先级：Atom 的 content 比 summary 完整，RSS 的 content:encoded 比 description 完整。 */
const SUMMARY_TAGS = ['content:encoded', 'content', 'summary', 'description']

/** 时间字段优先级：pubDate（RSS）→ published / updated（Atom）→ dc:date（RDF）。 */
const DATE_TAGS = ['pubDate', 'published', 'updated', 'dc:date']

/** 取出标签内全部内容（含 `<![CDATA[...]]>` 包裹），捕获组 1 是内层文本。 */
const TAGS = (name) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'ig')

/** 自闭合的 `<name ... />`（RSS 里少见，但 `<content:encoded/>` 之类会出现）。 */
const SELF_CLOSING = (name) => new RegExp(`<${name}\\b[^>]*/>`, 'ig')

/**
 * HTML 实体表。数字实体（`&#123;` / `&#x1F600;`）单独走码点还原。
 * 只收常见那几个，认不出的实体原样保留（宁可显示 `&foo;` 也不吃掉内容）。
 */
const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
}

/** 实体解码用：一段文本里出现的所有实体引用（命名 / 十进制 / 十六进制）。 */
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi

/** script / style：有止标签就吃到止标签（含），没有就吃到文末（截断 HTML 里这是最合理的选择）。 */
const DROP_BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi

/** 任意标签（含注释、声明）。 */
const TAG_RE = /<[^>]*>|<!--[\s\S]*?-->/g

/**
 * CDATA 段：只剥**外壳**，内容留在原地等后面的标签扫描处理。
 * 必须排在 TAG_RE 之前：`<![CDATA[今天的 &lt;大新闻&gt;]]>` 整体能落进 `<[^>]*>`，
 * 先走 TAG_RE 会把内容一起吞掉（曾经踩过这个坑）。
 */
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/g

/**
 * 落单的 CDATA 尾巴。
 * 截断/畸形的源里常见只有 `]]>` 没有开头的 `CDATA[`，这不是内容，一并清掉。
 */
const CDATA_TAIL_RE = /\]\]>/g

/** 单个实体引用 → 字符；认不出来（含非法码点）就原样返回。 */
function decodeEntity(match, body) {
  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X'
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
    if (!Number.isFinite(code) || code <= 0 || code > 0x10FFFF) return match
    try {
      return String.fromCodePoint(code)
    } catch {
      return match
    }
  }
  const named = ENTITIES[body.toLowerCase()]
  return named === undefined ? match : named
}

/**
 * 解码常见命名实体 + 数字实体（含十六进制）。输入非字符串 → 空串；非法码点原样保留。
 * 只给内部少数地方（如 `<link>` 文本、`guid`）用；正文一律走 stripHtml。
 */
function decodeEntities(value) {
  if (typeof value !== 'string' || value === '') return ''
  return value.replace(ENTITY_RE, decodeEntity)
}

/** 多个连续空白（含全角空格）压成单个半角空格并 trim。 */
function collapse(value) {
  return String(value ?? '').replace(/[\s\u3000]+/g, ' ').trim()
}

/** 可选的数值参数：非有限数或 < 1 时回落到默认值（与 lib/assets.js 的 normalizeLimit 同规则）。 */
function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/**
 * 把任意一段带标签的文本洗成纯文本。
 *
 * 处理顺序（顺序本身很重要，测试里锁死）：
 * 1. 去掉 `<script>` / `<style>` 整段（含内容；有止标签吃到止标签，没闭合就吃到文末）；
 * 2. **先给实体占位**（`&lt;` → `\u00000\u0000`，绝不含尖括号），再剥 CDATA 外壳、再删标签 ——
 *    否则 `&lt;大新闻&gt;` 会先被还原成 `<大新闻>`，接着被当成标签删掉（真实源里这种写法很常见）；
 * 3. 占位还原成字符，清掉落单的 `]]>`，压空白，trim。
 *
 * 只做这些，不写完整 XML/HTML 解析器。输入非字符串（null / 数字 / 对象）→ `''`，绝不抛错。
 * @returns {string}
 */
export function stripHtml(value) {
  if (typeof value !== 'string' || value === '') return ''
  const holders = []
  const safe = value
    .replace(DROP_BLOCK_RE, ' ')
    // 占位符只用数字包在 \u0000 里：绝不能含 `<` / `>`，否则下一步的标签扫描会被占位符自己搞乱
    .replace(ENTITY_RE, (match, body) => {
      const index = holders.length
      holders.push(decodeEntity(match, body))
      return `\u0000${index}\u0000`
    })
    .replace(CDATA_RE, '$1')
    .replace(TAG_RE, ' ')
    .replace(CDATA_TAIL_RE, ' ')
  const restored = safe.replace(/\u0000(\d+)\u0000/g, (match, index) => {
    const decoded = holders[Number(index)]
    return decoded === undefined ? match : decoded
  })
  return collapse(restored)
}

/** 清洗后的字段再截断（超长加 `…`）。 */
function clamp(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 宽松地捞标签：按文档顺序返回 `{ name, full, inner }`。
 * `name` 保留原样（便于 `dc:date` 之类的比较），匹配时不区分大小写。
 * 自闭合标签也会入列（`inner` 为空串），这样 `<link href="..."/>` 这种 Atom 写法不会漏。
 */
function tags(xml, ...names) {
  const picked = []
  for (const name of names) {
    for (const match of xml.matchAll(TAGS(name))) {
      picked.push({ name, at: match.index, full: match[0], inner: match[1] ?? '' })
    }
    for (const match of xml.matchAll(SELF_CLOSING(name))) {
      picked.push({ name, at: match.index, full: match[0], inner: '' })
    }
  }
  return picked.sort((a, b) => a.at - b.at)
}

/**
 * 取属性值：兼容单引号、双引号、无引号的写法；属性名大小写不敏感。
 * 找不到 → 空串。
 */
function attr(tag, name) {
  if (typeof tag !== 'string' || tag === '') return ''
  const pattern = new RegExp(`(?:^|[\\s"'])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  const match = pattern.exec(tag)
  if (match === null) return ''
  return match[1] ?? match[2] ?? match[3] ?? ''
}

/** 取标签的 href 属性（Atom 的 `<link href="...">`）。 */
function hrefOf(tag) {
  return attr(tag, 'href')
}

/**
 * 第一个能取到「文字」的标签内容（保留 CDATA 包裹，交给 stripHtml 展开）。
 * 没有该标签 → null（用来区分「不存在」与「存在但为空」）。
 */
function firstInner(list, names) {
  for (const name of names) {
    const hit = list.find((tag) => tag.name.toLowerCase() === name.toLowerCase())
    if (hit !== undefined) return hit.inner
  }
  return null
}

/** 第一个可用的纯文本字段（先 stripHtml，再压空白）。 */
function firstText(list, names) {
  const inner = firstInner(list, names)
  return inner === null ? '' : stripHtml(inner)
}

/**
 * 解析时间字符串 → 毫秒时间戳；认不出来 → 0。
 * 先交给 `Date.parse`（ISO8601 与 RFC822 都在它的能力范围内），
 * 再补一个**保守的** ISO8601 兜底（只有长得像 `2026-01-02T03:04:05Z` 才尝试），
 * 最后还要求年份 ≥ 1000：这样 `new Date('不是时间')`、`Date.parse('第 3 期')` 之类
 * 各家实现不一致的宽松解析不会把垃圾变成 1970 年的时间戳。
 */
function parseDate(value) {
  const raw = collapse(value)
  if (raw === '') return 0

  let ms = NaN
  const native = Date.parse(raw)
  if (Number.isFinite(native)) ms = native

  if (!Number.isFinite(ms)) {
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw)
    if (iso !== null) ms = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0), Number(iso[6] ?? 0))
  }

  if (!Number.isFinite(ms)) return 0
  return ms >= Date.UTC(1000, 0, 1) ? ms : 0
}

/** 单条目的时间：按 DATE_TAGS 优先级取第一个**能解析**的（解析不了继续试下一个）。 */
function dateOf(list) {
  for (const name of DATE_TAGS) {
    const hit = list.find((tag) => tag.name.toLowerCase() === name.toLowerCase())
    if (hit === undefined) continue
    const ms = parseDate(hit.inner)
    if (ms > 0) return ms
  }
  return 0
}

/**
 * 单条目的链接：
 * 1. 带 `href` 的 `<link>`（Atom：`<link href="..."/>`；`rel="alternate"` 或无 `rel` 的优先，
 *    `rel="self"` 排最后 —— 那是源自己的地址，不是这条内容的地址）；
 * 2. `<link>` 的文本内容（RSS 2.0 / RDF）；
 * 3. `<guid>` / `<id>`，但仅当它长得像 http(s) 地址时才用
 *    （避免把 `tag:example.com,2026:1` 这种标识符当成链接，那东西在 QQ 里点不开）。
 */
function linkOf(list, guid) {
  const links = list.filter((tag) => tag.name.toLowerCase() === 'link')
  const ranked = [...links].sort((a, b) => linkRank(a) - linkRank(b))
  for (const tag of ranked) {
    const href = collapse(decodeEntities(hrefOf(tag.full)))
    if (href !== '') return href
  }
  for (const tag of links) {
    const text = stripHtml(tag.inner)
    if (text !== '') return text
  }
  const raw = collapse(decodeEntities(guid))
  if (/^https?:\/\//i.test(raw)) return raw
  return ''
}

/** `<link>` 的取值优先级：`rel="self"` → 1，其余 → 0（稳定排序，同级保持文档顺序）。 */
function linkRank(tag) {
  return /(?:^|[\s"'])rel\s*=\s*["']?self\b/i.test(tag.full) ? 1 : 0
}

const ITEM_TAG = 'item'
const ENTRY_TAG = 'entry'

/**
 * 解析订阅源文本。支持 RSS 2.0（`<rss><channel><item>`）、
 * RSS 1.0 / RDF（`<rdf:RDF><item>`，标题在 `<channel>` 里）、Atom（`<feed><entry>`）。
 *
 * 每条返回 `{ title, link, summary, pubDate, id }`：
 * - `title` 缺失 → `''`；`summary` 取 `content:encoded` / `content` / `summary` / `description` 第一个，
 *   经 stripHtml + 压空白后**截断到 300 字**（超出加 `…`）；两者都走同一个清洗；
 * - `pubDate` 能解析成毫秒时间戳就解析，解析不了 → `0`；`id` 取 `guid` / `id`，都没有回落到 link；
 * - `items` 按时间**降序**（时间都为 0 时保持原顺序），最多 `limit` 条。
 *
 * 绝不抛错：非字符串、空串、畸形 XML、截断 XML、纯文本、HTML 页面都会安全返回。
 * @param {string} xml 订阅源原文
 * @param {{ limit?: number, now?: number }} [options] `now` 目前只用来说明「本次解析」的时间基准，不影响结果
 * @returns {{ items: Array<{ title: string, link: string, summary: string, pubDate: number, id: string }>, title: string, reason: string }}
 */
export function parseFeed(xml, options = {}) {
  const opts = (options && typeof options === 'object') ? options : {}
  const limit = positiveNumber(opts.limit, DEFAULT_PARSE_LIMIT)

  if (typeof xml !== 'string' || collapse(xml) === '') {
    return { items: [], title: '', reason: '内容为空' }
  }

  let blocks = tags(xml, ITEM_TAG)
  if (blocks.length === 0) blocks = tags(xml, ENTRY_TAG)

  const title = feedTitleOf(xml)
  if (blocks.length === 0) return { items: [], title, reason: '没有解析出条目' }

  const items = []
  for (const block of blocks) {
    const list = tags(block.inner, 'title', 'link', 'guid', 'id', ...SUMMARY_TAGS, ...DATE_TAGS)
    const summaryRaw = firstInner(list, SUMMARY_TAGS)
    const summary = summaryRaw === null ? '' : clamp(stripHtml(summaryRaw), SUMMARY_MAX_CHARS)
    const guid = firstText(list, ['guid', 'id'])
    const id = guid !== '' ? guid : linkOf(list, '')
    items.push({
      title: firstText(list, ['title']),
      link: linkOf(list, guid),
      summary,
      pubDate: dateOf(list),
      id,
    })
  }

  // 时间降序；Array#sort 稳定，所以时间全为 0 时原顺序不变。
  items.sort((a, b) => b.pubDate - a.pubDate)
  return { items: items.slice(0, limit), title, reason: '' }
}

/**
 * feed 标题：RSS 的 `<channel><title>` 优先，其次 Atom/RDF 的顶层 `<feed><title>`。
 * 取 channel 里的标题前会先把 `<item>` 段抠掉：否则 channel 自己没有 `<title>` 时，
 * 第一个被捞到的标题就是**第一条 item 的标题**，会张冠李戴。
 * 取不到 → `''`。
 */
function feedTitleOf(xml) {
  const channel = tags(xml, 'channel')[0]
  if (channel !== undefined) {
    const scope = channel.inner.replace(TAGS(ITEM_TAG), ' ')
    const inner = tags(scope, 'title')[0]
    const text = inner === undefined ? '' : stripHtml(inner.inner)
    if (text !== '') return text
  }
  const feed = tags(xml, 'feed')[0]
  if (feed !== undefined) {
    const scope = feed.inner.replace(TAGS(ENTRY_TAG), ' ')
    const inner = tags(scope, 'title')[0]
    if (inner !== undefined) return stripHtml(inner.inner)
  }
  return ''
}

/**
 * 把条目排版成给 QQ 的纯文本。
 *
 * 文案形态（测试里锁死）：
 * ```
 * 📰 标题            ← 只在 options.title 非空时出现
 * 共 N 条，显示前 M 条   ← 固定一行摘要（M 是实际排进正文的条数）
 * 1. 【标题】
 *    摘要…
 *    链接
 * 2. 【标题】         ← 摘要为空则省略摘要那一行
 *    链接
 * ```
 * 段落规则：条目之间不空行；单条内为「标题行 + 摘要行 + 链接行」，缺哪个省哪个。
 *
 * 截断：先按 `limit` 截条数，再对**正文**（不含首两行表头）按 `maxChars` 硬截断并追加
 * `…（内容过长已截断）`（标记本身不计入 maxChars，与 lib/assets.js 一致）。
 * `truncated` = 条数被 limit 截断 或 正文被 maxChars 截断。
 *
 * `used` = 实际排进正文的条数，`total` = 传入条数（含被跳过的空标题项），
 * `chars` = `text.length`。非数组输入 → `{ text: '（没有可播报的条目）', used: 0, total: 0, truncated: false }`。
 * @param {Array} items parseFeed 的 items（也接受手写的 `{ title, link, summary }` 数组）
 * @param {{ limit?: number, maxChars?: number, title?: string, maxTitleChars?: number }} [options]
 * @returns {{ text: string, used: number, total: number, truncated: boolean, chars: number }}
 */
export function formatFeedItems(items, options = {}) {
  const opts = (options && typeof options === 'object') ? options : {}
  if (!Array.isArray(items)) {
    const text = '（没有可播报的条目）'
    return { text, used: 0, total: 0, truncated: false, chars: text.length }
  }

  const limit = positiveNumber(opts.limit, DEFAULT_FORMAT_LIMIT)
  const maxChars = positiveNumber(opts.maxChars, DEFAULT_MAX_CHARS)
  const maxTitleChars = positiveNumber(opts.maxTitleChars, DEFAULT_MAX_TITLE_CHARS)
  // title 只认真正的字符串：数字/对象一律当作「没有标题」（不去 String() 硬转，免得印出个 2026）。
  const feedTitle = typeof opts.title === 'string' ? collapse(opts.title) : ''
  const total = items.length
  // 条数上限先截，再排版；total 始终是**传入**条数，所以表头能如实说明「共 N 条，显示前 M 条」。
  const source = total > limit ? items.slice(0, limit) : items

  const lines = []
  for (const item of source) {
    if (item === null || item === undefined || typeof item !== 'object') continue
    // title/summary/link 在这里一律当**纯文本**（parseFeed 已经把标签洗过一遍）：
    // 再跑一次 stripHtml 会把标题里合法的 `<大新闻>` 当成标签删掉，等于吃掉内容。
    const title = collapse(item.title)
    if (title === '') continue
    const summary = collapse(item.summary)
    const link = collapse(item.link)
    const block = [`${lines.length + 1}. 【${clamp(title, maxTitleChars)}】`]
    if (summary !== '') block.push(`   ${summary}`)
    if (link !== '') block.push(`   ${link}`)
    lines.push(block.join('\n'))
  }

  let body = lines.join('\n')
  let charTruncated = false
  if (body.length > maxChars) {
    body = body.slice(0, maxChars)
    charTruncated = true
  }

  const parts = []
  if (feedTitle !== '') parts.push(`📰 ${feedTitle}`)
  parts.push(`共 ${total} 条，显示前 ${lines.length} 条`)
  if (body !== '') parts.push(body)
  let text = parts.join('\n')
  if (charTruncated) text += TRUNCATED_MARK

  return {
    text,
    used: lines.length,
    total,
    truncated: charTruncated,
    chars: text.length,
  }
}
