/**
 * 群资产（群文件 / 群文件夹 / 群相册）的纯逻辑：文案排版 + 文件名匹配 + 下载名消毒。
 *
 * 这里不碰网络、不碰 OneBot、不做任何 IO：真实数据由 bridge 调
 * get_group_root_files / get_group_files_by_folder / get_group_file_url /
 * get_qun_album_list 拿到后传进来，所以整个模块可以脱离 bridge 单测。
 *
 * 时间字段沿用 OneBot 的**秒**级时间戳（0 表示"没有"），与 lib/members.js 保持一致。
 * 群文件/群相册的字段各家实现不一样、缺字段也是常态，所以取值一律宽容：
 * 认不出来的段直接省略，绝不留空括号，也绝不抛错。
 */

/** 正文超长时追加的提示语（与 lib/forward.js 用同一句）。 */
const TRUNCATED_MARK = '…（内容过长已截断）'

/** limit 默认值。 */
const DEFAULT_LIMIT = 20

/** maxChars 默认值。 */
const DEFAULT_MAX_CHARS = 1500

/** 落盘文件名长度上限（NTFS 上限 255，这里留足余量）。 */
const MAX_DOWNLOAD_NAME_CHARS = 120

/** Windows 非法字符（含路径分隔符）+ 控制字符，一律**删除**而不是替换成下划线。 */
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001F\u007F]/g

/** Windows 保留设备名（不含扩展名形式，带扩展名的先切掉扩展名再判）。 */
const RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/** 大小单位：到 GB 封顶（群文件不会更大，再进位没意义）。 */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB']

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 空白（含全角空格）压成单个半角空格并 trim。 */
function collapse(value) {
  return String(value ?? '').replace(/[\s\u3000]+/g, ' ').trim()
}

/** 可选的字符串参数：空串/非字符串时回落到默认值。 */
function nonEmptyString(value, fallback) {
  return (typeof value === 'string' && value.trim() !== '') ? value : fallback
}

/** limit 防御性取值：非有限数或 < 1 时回落到 20（挡住 0/NaN/'abc'/undefined）。 */
function normalizeLimit(limit, fallback = DEFAULT_LIMIT) {
  const value = Number(limit)
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

/** maxChars 防御性取值：非有限数或 < 1 时回落到 1500。 */
function normalizeMaxChars(value, fallback = DEFAULT_MAX_CHARS) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/**
 * 人类可读的文件大小。规则（测试里锁死）：
 * - 非有限数、负数、0 → `未知大小`（0 字节在群文件里通常就是"没拿到大小"）；
 * - < 1024 → `512 B`：四舍五入到整字节，不带小数；
 * - ≥ 1024 → 依次进位到 KB / MB / GB（GB 封顶，不再进位 TB）；
 * - 只保留一位小数，且**整数不显示小数位**：900.0 KB 写成 `900 KB`，
 *   1536 写成 `1.5 KB`，1048576 写成 `1 MB`；
 * - 只做一次四舍五入，**不因进位后取整而回退单位**：1023.96 KB 显示 `1024 KB`。
 */
export function formatFileSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '未知大小'
  if (value < 1024) return `${Math.round(value)} B`
  let size = value
  let unit = 0
  while (size >= 1024 && unit < SIZE_UNITS.length - 1) {
    size /= 1024
    unit++
  }
  const rounded = size.toFixed(1).replace(/\.0$/, '')
  return `${rounded} ${SIZE_UNITS[unit]}`
}

/** 秒级时间戳 → 本地 `YYYY-MM-DD HH:mm`；0/缺失/非法 → 空串（调用方据此省略整段）。 */
function formatTimeOrEmpty(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 上传时间（秒）用于排序：缺失/0/非法一律当 0（排最后）。 */
function uploadTimeOf(item) {
  const value = Number(item?.upload_time)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** 群文件显示名：file_name 缺失/空白给占位名（排序与匹配仍按真实 file_name）。 */
function fileNameOf(item) {
  return collapse(item?.file_name) || '未命名文件'
}

/** 上传者：uploader_name 优先，其次 uploader（数字 QQ 号，0 视为没有）；都没有 → 空串。 */
function uploaderOf(item) {
  const named = collapse(item?.uploader_name)
  if (named) return named
  const raw = item?.uploader
  const id = Number(raw)
  if (Number.isFinite(id)) return id > 0 ? `QQ${id}` : ''
  return collapse(raw)
}

/**
 * 统一的「表头 + 正文 + 硬截断」收尾。
 * 截断标记本身**不计入** maxChars（与 lib/forward.js 的既有行为一致），
 * truncated = 条数超 limit 或正文超 maxChars 里任意一个成立。
 */
function listResult(rows, { cap, maxChars, title, unit, line }) {
  const total = rows.length
  if (total === 0) {
    return { text: `[${title} 共 0 ${unit}]`, shown: 0, total: 0, truncated: false }
  }
  const listTruncated = total > cap
  const shownRows = listTruncated ? rows.slice(0, cap) : rows
  const shown = shownRows.length
  const header = listTruncated
    ? `[${title} 共 ${total} ${unit}，显示前 ${shown} ${unit}]`
    : `[${title} 共 ${total} ${unit}]`
  let body = shownRows.map((row, index) => line(row, index)).join('\n')
  let charTruncated = false
  if (body.length > maxChars) {
    body = body.slice(0, maxChars)
    charTruncated = true
  }
  const text = `${header}\n${body}${charTruncated ? TRUNCATED_MARK : ''}`
  return { text, shown, total, truncated: listTruncated || charTruncated }
}

/** 单个群文件行：`1. 名字（大小 · 上传者 · 时间）`，缺上传者/时间就省略对应段。 */
function fileLine(item, index) {
  const parts = [formatFileSize(item?.file_size)]
  const uploader = uploaderOf(item)
  if (uploader) parts.push(uploader)
  const time = formatTimeOrEmpty(item?.upload_time)
  if (time) parts.push(time)
  return `${index + 1}. ${fileNameOf(item)}（${parts.join(' · ')}）`
}

/**
 * 群文件列表文案。
 * 排序：upload_time 降序（缺失/0 排最后），时间相同按文件名本地化升序。
 * files 非数组时按空列表处理（只给 `[群文件 共 0 个]`）。
 * @returns {{ text: string, shown: number, total: number, truncated: boolean }}
 */
export function formatGroupFiles(files, options = {}) {
  const opts = (options && typeof options === 'object') ? options : {}
  const rows = Array.isArray(files) ? files : []
  const sorted = [...rows].sort((a, b) => {
    const diff = uploadTimeOf(b) - uploadTimeOf(a)
    if (diff !== 0) return diff
    return fileNameOf(a).localeCompare(fileNameOf(b))
  })
  return listResult(sorted, {
    cap: normalizeLimit(opts.limit),
    maxChars: normalizeMaxChars(opts.maxChars),
    title: nonEmptyString(opts.title, '群文件'),
    unit: '个',
    line: fileLine,
  })
}

/** 群文件夹显示名：folder_name 缺失/空白给占位名。 */
function folderNameOf(item) {
  return collapse(item?.folder_name) || '未命名文件夹'
}

/** 文件夹内文件数：缺失/负数/非法 → 0。 */
function folderCountOf(item) {
  const value = Number(item?.total_file_count)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** 单个群文件夹行：`1. 名字（N 个文件）`。 */
function folderLine(item, index) {
  return `${index + 1}. ${folderNameOf(item)}（${folderCountOf(item)} 个文件）`
}

/**
 * 群文件夹列表文案（用于 `get_group_files_by_folder` 的上层目录视图）。
 * 不做重排：接口本身按创建时间返回，保持原顺序最好懂。
 * @returns {{ text: string, shown: number, total: number, truncated: boolean }}
 */
export function formatGroupFolders(folders, options = {}) {
  const opts = (options && typeof options === 'object') ? options : {}
  const rows = Array.isArray(folders) ? folders : []
  return listResult(rows, {
    cap: normalizeLimit(opts.limit),
    maxChars: normalizeMaxChars(opts.maxChars),
    title: nonEmptyString(opts.title, '群文件夹'),
    unit: '个',
    line: folderLine,
  })
}

/** 依次尝试候选字段名，返回第一个"有值"的。 */
function pickField(item, keys) {
  for (const key of keys) {
    const value = item?.[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return value
  }
  return undefined
}

/** 相册显示名：album_name 优先，其次 name，都没有给占位名。 */
function albumNameOf(item) {
  return collapse(pickField(item, ['album_name', 'name'])) || '未命名相册'
}

/** 相册照片数：photo_count / total_photo_count / pic_count 依次尝试，取不到当 0。 */
function albumCountOf(item) {
  const value = Number(pickField(item, ['photo_count', 'total_photo_count', 'pic_count']))
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** 单个相册行：`1. 名字（N 张）`。 */
function albumLine(item, index) {
  return `${index + 1}. ${albumNameOf(item)}（${albumCountOf(item)} 张）`
}

/**
 * 群相册列表文案。
 * 字段名容错：id 认 `album_id`/`id`，名字认 `album_name`/`name`，
 * 张数认 `photo_count`/`total_photo_count`/`pic_count`。
 * 同样保持接口顺序，不重排。
 * @returns {{ text: string, shown: number, total: number, truncated: boolean }}
 */
export function formatAlbumList(albums, options = {}) {
  const opts = (options && typeof options === 'object') ? options : {}
  const rows = Array.isArray(albums) ? albums : []
  return listResult(rows, {
    cap: normalizeLimit(opts.limit),
    maxChars: normalizeMaxChars(opts.maxChars),
    title: nonEmptyString(opts.title, '群相册'),
    unit: '个',
    line: albumLine,
  })
}

/**
 * 按文件名匹配群文件：先精确（大小写不敏感）→ 再前缀 → 再包含，逐级降级。
 * 同一级有多个候选时取**上传时间最新**的那个，并在 reason 里说明是模糊匹配。
 * 一个都没命中 → `{ file: null, reason: '没有找到匹配的群文件' }`；
 * query 为空 → `{ file: null, reason: '请给出文件名' }`。
 * 下传的永远是**原始条目对象**，调用方拿 file_id / busid 去要下载地址。
 * @returns {{ file: object|null, reason: string }}
 */
export function matchFileName(files, query) {
  const keyword = collapse(query)
  if (keyword === '') return { file: null, reason: '请给出文件名' }

  const rows = Array.isArray(files) ? files : []
  const needle = keyword.toLowerCase()
  const pool = []
  for (const item of rows) {
    if (item === null || item === undefined || typeof item !== 'object') continue
    const name = collapse(item.file_name)
    if (name === '') continue
    pool.push({ item, lower: name.toLowerCase() })
  }

  const exact = pool.filter((entry) => entry.lower === needle)
  const prefix = exact.length > 0 ? exact : pool.filter((entry) => entry.lower.startsWith(needle))
  const hits = prefix.length > 0 ? prefix : pool.filter((entry) => entry.lower.includes(needle))
  if (hits.length === 0) return { file: null, reason: '没有找到匹配的群文件' }

  const best = [...hits].sort((a, b) => {
    const diff = uploadTimeOf(b.item) - uploadTimeOf(a.item)
    if (diff !== 0) return diff
    return a.lower.localeCompare(b.lower)
  })[0]
  const reason = hits.length > 1 ? `模糊匹配到 ${hits.length} 个，已取最新上传的一个` : ''
  return { file: best.item, reason }
}

/** 取路径最后一段：`a/b/c`、`C:\x\y`、`/etc/passwd` 都只留最后那个名字。 */
function baseNameOf(raw) {
  const parts = String(raw ?? '').split(/[\\/]+/).filter((part) => part !== '')
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/** 消毒前半段：去路径 → 删非法字符/控制字符 → 去掉结尾的空格与点。 */
function cleanName(raw) {
  return baseNameOf(raw)
    .replace(INVALID_NAME_CHARS, '')
    .replace(/[. ]+$/, '')
    .trim()
}

/** 超长截断但保留扩展名（没有扩展名 / 扩展名过长就纯截断）。 */
function clampName(name, max = MAX_DOWNLOAD_NAME_CHARS) {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0 && name.length - dot <= 21
  if (!hasExt) return name.slice(0, max).replace(/[. ]+$/, '')
  const ext = name.slice(dot)
  const keep = Math.max(1, max - ext.length)
  const head = name.slice(0, keep).replace(/[. ]+$/, '')
  return head === '' ? ext.slice(1) : head + ext
}

/**
 * 把群文件名消毒成可安全落盘的文件名。规则（测试里锁死）：
 * 1. 去掉路径部分：`../`、`..\`、`C:\x\y`、`/etc/passwd` 只留最后一段；
 * 2. 删除 Windows 非法字符 `<>:"/\|?*` 与控制字符（是删除，不是替换成下划线）；
 * 3. 去掉结尾的空格与点（Windows 不允许这种文件名）；
 * 4. 保留名 `CON`/`PRN`/`AUX`/`NUL`/`COM1`-`COM9`/`LPT1`-`LPT9`（含带扩展名形式）
 *    前面加 `_`，例如 `CON.txt` → `_CON.txt`（`COM10` 不是保留名，不动）；
 * 5. 空名/全是非法字符 → 用 `fallback`（fallback 本身也会被消毒，兜底 'qq-file'）；
 * 6. 上限 120 字符，超长截断但保留扩展名；
 * 7. 返回值一定是**纯文件名**：不含任何路径分隔符。
 * @returns {string}
 */
export function sanitizeDownloadName(name, options = {}) {
  const opts = (options && typeof options === 'object') ? options : {}
  let value = cleanName(name)
  if (value === '') value = cleanName(opts.fallback) || 'qq-file'
  const base = value.split('.')[0]
  if (RESERVED_NAME.test(base)) value = `_${value}`
  return clampName(value)
}
