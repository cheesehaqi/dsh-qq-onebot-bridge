/** 群资产纯逻辑（lib/assets.js）单元测试：文案排版 / 文件名匹配 / 下载名消毒，不碰网络。 */
import {
  formatFileSize,
  formatGroupFiles,
  formatGroupFolders,
  matchFileName,
  sanitizeDownloadName,
  formatAlbumList,
} from '../lib/assets.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
/** 相等断言的小包装，失败时把期望值一起打出来。 */
function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/** 时间戳一律用本地时间构造，避免时区差异。 */
const tNew = new Date(2026, 8, 13, 10, 20, 0).getTime() / 1000 // 2026-09-13 10:20
const tMid = new Date(2026, 8, 12, 9, 0, 0).getTime() / 1000 // 2026-09-12 09:00

const MARK = '…（内容过长已截断）'
/** 取正文（去掉表头行），并摘掉截断标记，方便断言硬截断长度。 */
function bodyOf(result) {
  return result.text.split('\n').slice(1).join('\n').replace(MARK, '')
}

// ---- formatFileSize：0/非法/各量级/进位边界 ----
eq('0 字节算未知大小', formatFileSize(0), '未知大小')
eq('undefined 算未知大小', formatFileSize(undefined), '未知大小')
eq('null 算未知大小', formatFileSize(null), '未知大小')
eq('NaN 算未知大小', formatFileSize(Number.NaN), '未知大小')
eq('负数算未知大小', formatFileSize(-1), '未知大小')
eq('非数字字符串算未知大小', formatFileSize('abc'), '未知大小')
eq('小于 1KB 用 B', formatFileSize(512), '512 B')
eq('1023 字节仍是 B', formatFileSize(1023), '1023 B')
eq('B 级小数四舍五入到整字节', formatFileSize(100.6), '101 B')
eq('数字字符串也能算', formatFileSize('2048'), '2 KB')
eq('正好 1024 进位成 1 KB', formatFileSize(1024), '1 KB')
eq('1.5 KB 保留一位小数', formatFileSize(1536), '1.5 KB')
eq('整数不显示 .0（900.0 KB → 900 KB）', formatFileSize(921600), '900 KB')
eq('正好 1 MB 不带小数', formatFileSize(1024 * 1024), '1 MB')
eq('1.5 MB 保留一位小数', formatFileSize(1536 * 1024), '1.5 MB')
eq('1 GB 不带小数', formatFileSize(1024 ** 3), '1 GB')
eq('GB 封顶不再进位 TB', formatFileSize(1024 ** 4), '1024 GB')

// ---- formatGroupFiles：表头 / 行格式 / 排序 / 截断 ----
const fileA = { file_id: 'f-a', file_name: 'a.txt', busid: 102, file_size: 1536 * 1024, upload_time: tNew, uploader: 10001, uploader_name: '张三' }
const fileB = { file_id: 'f-b', file_name: 'b.zip', file_size: 921600, upload_time: tMid, uploader_name: '李四' }
const fileC = { file_id: 'f-c', file_name: 'c.bin', file_size: 0, uploader: 0 }
const fileList = [fileB, fileC, fileA] // 故意乱序传入
const listResult1 = formatGroupFiles(fileList)
const fl1 = listResult1.text.split('\n')
eq('文件列表表头', fl1[0], '[群文件 共 3 个]')
eq('最新上传排第一（大小·上传者·时间）', fl1[1], '1. a.txt（1.5 MB · 张三 · 2026-09-13 10:20）')
eq('其次按上传时间降序', fl1[2], '2. b.zip（900 KB · 李四 · 2026-09-12 09:00）')
eq('缺上传者/时间/大小不留空括号', fl1[3], '3. c.bin（未知大小）')
check('文件列表行数 = 表头 + 条目', fl1.length === 4, String(fl1.length))
check('文件列表 shown/total', listResult1.shown === 3 && listResult1.total === 3, `${listResult1.shown}/${listResult1.total}`)
check('文件列表 truncated=false', listResult1.truncated === false)
check('排序不改动入参数组', fileList[0].file_id === 'f-b' && fileList[2].file_id === 'f-a', fileList.map((f) => f.file_id).join(','))

// 同时间按文件名升序；缺时间排最后
const tieList = [
  { file_name: 'z.txt', upload_time: tMid },
  { file_name: 'a.txt', upload_time: tMid },
  { file_name: 'm.txt', file_size: 10 },
]
const tl1 = formatGroupFiles(tieList).text.split('\n')
check('时间相同按文件名升序', tl1[1].includes('a.txt') && tl1[2].includes('z.txt'), `${tl1[1]} / ${tl1[2]}`)
check('缺上传时间排最后', tl1[3].includes('m.txt'), tl1[3])

// 缺字段兜底：file_name 没有 → 占位名；uploader 只有 QQ 号 → QQ<号>
const shaped = formatGroupFiles([
  { file_id: 'x1', file_size: 1024, upload_time: tNew, uploader: 10001 },
  { file_id: 'x2', file_name: '  ', file_size: 2048, uploader_name: '  王五  ' },
]).text.split('\n')
eq('缺 file_name 给占位名', shaped[1], '1. 未命名文件（1 KB · QQ10001 · 2026-09-13 10:20）')
eq('上传者名去空白后优先', shaped[2], '2. 未命名文件（2 KB · 王五）')

// 空列表 / 非数组 / 非对象 options
const emptyFiles = formatGroupFiles([])
eq('空群文件只有表头', emptyFiles.text, '[群文件 共 0 个]')
check('空群文件统计为 0', emptyFiles.shown === 0 && emptyFiles.total === 0 && emptyFiles.truncated === false)
eq('非数组按空列表处理（null）', formatGroupFiles(null).text, '[群文件 共 0 个]')
eq('非数组按空列表处理（字符串）', formatGroupFiles('abc').text, '[群文件 共 0 个]')
check('options 非对象也不炸', formatGroupFiles(fileList, null).shown === 3, String(formatGroupFiles(fileList, null).shown))
eq('title 可覆盖表头', formatGroupFiles([], { title: '本群文件' }).text, '[本群文件 共 0 个]')

// limit 截断 + 防御性取值
const many = Array.from({ length: 25 }, (_, i) => ({
  file_id: `m${i}`,
  file_name: `f${String(i).padStart(2, '0')}.txt`,
  file_size: 1024,
  upload_time: tNew - i,
}))
const limited = formatGroupFiles(many, { limit: 3 })
eq('limit 截断表头写显示前 M 个', limited.text.split('\n')[0], '[群文件 共 25 个，显示前 3 个]')
check('limit 截断统计', limited.shown === 3 && limited.total === 25 && limited.truncated === true, `${limited.shown}/${limited.total}/${limited.truncated}`)
eq('limit 截断后正文行数', limited.text.split('\n').length, 1 + 3)
check('limit=0 回落到 20', formatGroupFiles(many, { limit: 0 }).shown === 20, String(formatGroupFiles(many, { limit: 0 }).shown))
check('limit 非数字回落到 20', formatGroupFiles(many, { limit: 'abc' }).shown === 20)
check('limit 小数向下取整', formatGroupFiles(many, { limit: 2.9 }).shown === 2, String(formatGroupFiles(many, { limit: 2.9 }).shown))

// maxChars 硬截断
const clippedFiles = formatGroupFiles(many, { limit: 5, maxChars: 30 })
check('文件列表超长留截断标记', clippedFiles.text.includes(MARK), clippedFiles.text)
check('文件列表截断标记在末尾', clippedFiles.text.endsWith(MARK))
check('文件列表正文超长也算 truncated', clippedFiles.truncated === true)
eq('文件列表正文硬截到 maxChars', bodyOf(clippedFiles).length, 30)
check('maxChars 非正数回落到 1500', formatGroupFiles(many, { limit: 25, maxChars: 0 }).truncated === false)

// ---- formatGroupFolders ----
const folders = [
  { folder_id: 'd1', folder_name: '学习资料', total_file_count: 12, create_time: tMid, creator_name: '张三' },
  { folder_id: 'd2', folder_name: '表情包', total_file_count: 3 },
  { folder_id: 'd3' },
]
const fol1 = formatGroupFolders(folders).text.split('\n')
eq('文件夹列表表头', fol1[0], '[群文件夹 共 3 个]')
eq('文件夹行格式', fol1[1], '1. 学习资料（12 个文件）')
eq('文件夹缺名给占位名', fol1[3], '3. 未命名文件夹（0 个文件）')
eq('空文件夹只有表头', formatGroupFolders([]).text, '[群文件夹 共 0 个]')
eq('文件夹非数组也不炸', formatGroupFolders(undefined).text, '[群文件夹 共 0 个]')
const folLimited = formatGroupFolders(folders, { limit: 2 })
eq('文件夹 limit 截断表头', folLimited.text.split('\n')[0], '[群文件夹 共 3 个，显示前 2 个]')
check('文件夹 limit 截断统计', folLimited.shown === 2 && folLimited.total === 3 && folLimited.truncated === true)
eq('文件夹 title 可覆盖', formatGroupFolders([], { title: '我的文件夹' }).text, '[我的文件夹 共 0 个]')
const folClipped = formatGroupFolders(folders, { maxChars: 12 })
check('文件夹列表超长留截断标记', folClipped.text.endsWith(MARK), folClipped.text)
check('文件夹列表 truncated=true', folClipped.truncated === true)
eq('文件夹列表正文硬截到 maxChars', bodyOf(folClipped).length, 12)

// ---- formatAlbumList：字段名别名依次回退 ----
const albums = [
  { album_id: 'a1', album_name: '旅行', photo_count: 8 },
  { id: 'a2', name: '日常', total_photo_count: '15' },
  { album_id: 'a3', album_name: '杂图', pic_count: 3 },
  { album_id: 'a4', album_name: '空相册' },
  { album_id: 'a5' },
]
const alb1 = formatAlbumList(albums).text.split('\n')
eq('相册列表表头', alb1[0], '[群相册 共 5 个]')
eq('相册 album_id/album_name/photo_count', alb1[1], '1. 旅行（8 张）')
eq('相册 id/name/total_photo_count 别名', alb1[2], '2. 日常（15 张）')
eq('相册 pic_count 别名', alb1[3], '3. 杂图（3 张）')
eq('相册缺张数按 0', alb1[4], '4. 空相册（0 张）')
eq('相册缺名给占位名', alb1[5], '5. 未命名相册（0 张）')
check(
  '张数字段按候选顺序优先（photo_count 先于 pic_count/total）',
  formatAlbumList([{ album_name: 'x', total_photo_count: 9, pic_count: 7, photo_count: 2 }]).text.endsWith('（2 张）'),
  formatAlbumList([{ album_name: 'x', total_photo_count: 9, pic_count: 7, photo_count: 2 }]).text,
)
eq('空相册只有表头', formatAlbumList([]).text, '[群相册 共 0 个]')
eq('相册非数组也不炸', formatAlbumList({ album_list: [] }).text, '[群相册 共 0 个]')
const albLimited = formatAlbumList(albums, { limit: 2 })
eq('相册 limit 截断表头', albLimited.text.split('\n')[0], '[群相册 共 5 个，显示前 2 个]')
check('相册 limit 截断统计', albLimited.shown === 2 && albLimited.total === 5 && albLimited.truncated === true)
eq('相册 title 可覆盖', formatAlbumList([], { title: '群相册列表' }).text, '[群相册列表 共 0 个]')
const albClipped = formatAlbumList(albums, { maxChars: 8 })
check('相册列表超长留截断标记', albClipped.text.endsWith(MARK), albClipped.text)
check('相册列表 truncated=true', albClipped.truncated === true)
eq('相册列表正文硬截到 maxChars', bodyOf(albClipped).length, 8)

// ---- matchFileName：精确 → 前缀 → 包含，多候选取最新 ----
const matchList = [
  { file_id: 'm1', file_name: 'Report.PDF', file_size: 2048, upload_time: tMid },
  { file_id: 'm2', file_name: 'report.pdf.bak', file_size: 10, upload_time: tNew },
  { file_id: 'm3', file_name: '全年report.pdf', file_size: 10, upload_time: tNew },
  { file_id: 'm4', file_name: 'other.txt' },
]
const exactHit = matchFileName(matchList, 'report.pdf')
check('精确匹配忽略大小写', exactHit.file?.file_id === 'm1', JSON.stringify(exactHit.file))
eq('精确匹配 reason 为空', exactHit.reason, '')
const prefixHit = matchFileName(matchList, 'report.pdf.b')
check('前缀匹配', prefixHit.file?.file_id === 'm2', JSON.stringify(prefixHit.file))
eq('前缀唯一命中 reason 为空', prefixHit.reason, '')
const containsHit = matchFileName(matchList, '全年')
check('包含匹配', containsHit.file?.file_id === 'm3', JSON.stringify(containsHit.file))
const fuzzyHit = matchFileName(matchList, 'report')
check('多候选取上传时间最新的', fuzzyHit.file?.file_id === 'm2', JSON.stringify(fuzzyHit.file))
eq('模糊匹配 reason 说明取最新', fuzzyHit.reason, '模糊匹配到 2 个，已取最新上传的一个')
const missHit = matchFileName(matchList, '不存在.zip')
check('未命中返回 null', missHit.file === null)
eq('未命中 reason 文案', missHit.reason, '没有找到匹配的群文件')
check('空查询返回 null', matchFileName(matchList, '').file === null)
eq('空查询 reason 文案', matchFileName(matchList, '').reason, '请给出文件名')
eq('全空白查询也算空', matchFileName(matchList, '   ').reason, '请给出文件名')
eq('undefined 查询也算空', matchFileName(matchList, undefined).reason, '请给出文件名')
eq('非数组输入按未命中处理', matchFileName(null, 'a.txt').reason, '没有找到匹配的群文件')
eq('坏条目被跳过', matchFileName([null, 'oops', { file_id: 'z' }, { file_name: '   ' }], 'z').reason, '没有找到匹配的群文件')
check('命中时返回原始条目对象', matchFileName(matchList, 'other.txt').file === matchList[3])

// ---- sanitizeDownloadName：路径 / 非法字符 / 保留名 / 长度 ----
eq('路径穿越只留文件名', sanitizeDownloadName('../../windows/system32/evil.exe'), 'evil.exe')
eq('反斜杠路径穿越只留文件名', sanitizeDownloadName('..\\..\\windows\\system32\\evil.exe'), 'evil.exe')
eq('Windows 盘符路径只留文件名', sanitizeDownloadName('C:\\x\\y.txt'), 'y.txt')
eq('POSIX 绝对路径只留文件名', sanitizeDownloadName('/etc/passwd'), 'passwd')
eq('相对路径只留文件名', sanitizeDownloadName('./sub/dir/pic.png'), 'pic.png')
eq('结尾反斜杠算空名用兜底', sanitizeDownloadName('..\\'), 'qq-file')
eq('只有点点也算空名', sanitizeDownloadName('..'), 'qq-file')
eq('普通文件名原样保留', sanitizeDownloadName('photo.jpg'), 'photo.jpg')
eq('文件名里的空格保留', sanitizeDownloadName('我的 报表.xlsx'), '我的 报表.xlsx')
eq('非法字符全部删除', sanitizeDownloadName('a<b>c:d"e|f?g*h.txt'), 'abcdefgh.txt')
eq('控制字符（含制表/换行）全部删除', sanitizeDownloadName('bad\tna\nme.txt'), 'badname.txt')
eq('结尾空格与点全部去掉', sanitizeDownloadName('报表. . '), '报表')
eq('中间的点保留', sanitizeDownloadName('v1.2.3.zip'), 'v1.2.3.zip')
eq('保留名 CON.txt 加前缀', sanitizeDownloadName('CON.txt'), '_CON.txt')
eq('保留名小写 con 也加前缀', sanitizeDownloadName('con'), '_con')
eq('保留名 COM1 加前缀', sanitizeDownloadName('COM1'), '_COM1')
eq('保留名 LPT9 带扩展名加前缀', sanitizeDownloadName('LPT9.log'), '_LPT9.log')
eq('COM10 不是保留名', sanitizeDownloadName('COM10.txt'), 'COM10.txt')
eq('NUL 加前缀', sanitizeDownloadName('nul'), '_nul')
eq('纯非法字符用兜底', sanitizeDownloadName('***'), 'qq-file')
eq('纯斜杠用兜底', sanitizeDownloadName('///'), 'qq-file')
eq('空串用兜底', sanitizeDownloadName(''), 'qq-file')
eq('null 用兜底', sanitizeDownloadName(null), 'qq-file')
eq('undefined 用兜底', sanitizeDownloadName(undefined), 'qq-file')
eq('自定义兜底生效', sanitizeDownloadName('???', { fallback: '群文件' }), '群文件')
eq('兜底本身也会被消毒', sanitizeDownloadName('***', { fallback: '../x/y.txt' }), 'y.txt')
eq('兜底也能是空名时再退到默认', sanitizeDownloadName('***', { fallback: '..' }), 'qq-file')

const longName = `${'长'.repeat(300)}.txt`
const clippedName = sanitizeDownloadName(longName)
eq('超长名截到 120 字符', clippedName.length, 120)
check('超长名保留扩展名', clippedName.endsWith('.txt'), clippedName.slice(-8))
const longNoExt = sanitizeDownloadName('a'.repeat(300))
eq('无扩展名超长名也截到 120', longNoExt.length, 120)
check('截断后仍不含点结尾', !longNoExt.endsWith('.'), longNoExt.slice(-5))

// 返回值必须是纯文件名：任何输入都不含路径分隔符、也不为空
const dirtyNames = [
  '../../windows/system32/evil.exe',
  '..\\..\\windows\\system32\\evil.exe',
  'C:\\x\\y.txt',
  '/etc/passwd',
  'a/b\\c/d',
  'CON',
  '***',
  '',
  null,
  undefined,
  '  ',
  './././',
  'name with space.txt',
]
for (const raw of dirtyNames) {
  const out = sanitizeDownloadName(raw)
  check(
    `消毒结果是不含分隔符的纯文件名：${JSON.stringify(raw)}`,
    typeof out === 'string' && out.length > 0 && !out.includes('/') && !out.includes('\\'),
    out,
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
