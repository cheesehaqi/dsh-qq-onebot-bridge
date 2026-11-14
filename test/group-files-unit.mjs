/**
 * 群文件搜索纯逻辑单测：命令解析、路径拆分、根目录/子文件夹匹配。
 */
import { matchGroupFiles, parseFileSearch, parseGroupFilePath } from '../lib/group-files.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed += 1; console.log('PASS', name, extra) }
  else { failed += 1; console.log('FAIL', name, extra) }
}

check('搜索命令：找 关键词', parseFileSearch('找 报告')?.keyword === '报告')
check('搜索命令：搜索 关键词', parseFileSearch('搜索 截图')?.keyword === '截图')
check('搜索命令：不是搜索返回 null', parseFileSearch('资料') === null && parseFileSearch('找  ') === null)

check('路径：文件夹/文件名', JSON.stringify(parseGroupFilePath('资料/报告.pdf')) === JSON.stringify({ folder: '资料', name: '报告.pdf' }))
check('路径：Windows 反斜杠', JSON.stringify(parseGroupFilePath('a\\b\\c.txt')) === JSON.stringify({ folder: 'a/b', name: 'c.txt' }))
check('路径：只有文件名', JSON.stringify(parseGroupFilePath('root.txt')) === JSON.stringify({ folder: '', name: 'root.txt' }))

const matches = matchGroupFiles({
  keyword: '报告',
  limit: 10,
  rootFiles: [{ file_name: '总报告.pdf', file_size: 100 }, { file_name: '别的.txt', file_size: 20 }],
  folders: [
    { name: '资料', files: [{ file_name: '季度报告.docx', file_size: 200 }, { file_name: '截图.png', file_size: 30 }] },
    { name: '归档', files: [{ file_name: '旧报告.zip', file_size: 300 }] },
  ],
})
check('匹配：根目录 + 子文件夹，按关键词', matches.length === 3
  && matches[0].name === '总报告.pdf' && matches[0].folder === ''
  && matches[1].folder === '资料' && matches[1].name === '季度报告.docx'
  && matches[2].folder === '归档', JSON.stringify(matches.map((item) => `${item.folder}/${item.name}`)))
check('匹配：大小/原始 file 保留', matches[1].size === 200 && matches[1].file.file_name === '季度报告.docx')
check('匹配：limit 生效', matchGroupFiles({
  keyword: 'a', limit: 1,
  rootFiles: [{ file_name: 'a1' }, { file_name: 'a2' }],
}).length === 1)
check('匹配：空关键词返回空', matchGroupFiles({ keyword: '', rootFiles: [{ file_name: 'a' }] }).length === 0)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
