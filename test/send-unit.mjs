/** Unit tests for outbound-media path validation and forward-card decisions (no network). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_FILE_SEND_MAX_BYTES, describeSendRoots, isInside, labelOfSendPath, resolveSendPath, shouldForwardText } from '../lib/send.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'qq-send-test-'))
const cwd = join(root, 'work')
const extra = join(root, 'extra')
const outside = join(root, 'outside')
mkdirSync(cwd, { recursive: true })
mkdirSync(extra, { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(cwd, 'pic.png'), Buffer.alloc(1024, 1))
writeFileSync(join(cwd, 'big.bin'), Buffer.alloc(2048, 1))
writeFileSync(join(extra, 'shared.zip'), Buffer.alloc(64, 1))
writeFileSync(join(outside, 'secret.txt'), 'nope', 'utf8')
mkdirSync(join(cwd, '.ssh'), { recursive: true })
writeFileSync(join(cwd, '.ssh', 'id_rsa'), 'key', 'utf8')
writeFileSync(join(cwd, '.env'), 'TOKEN=1', 'utf8')
writeFileSync(join(cwd, 'server.pem'), 'key', 'utf8')
writeFileSync(join(cwd, 'credentials.json'), '{}', 'utf8')
mkdirSync(join(cwd, 'sub'), { recursive: true })
writeFileSync(join(cwd, 'sub', 'nested.txt'), 'ok', 'utf8')

const opts = { cwd, extraDirs: [extra], maxBytes: DEFAULT_FILE_SEND_MAX_BYTES }

// ---- isInside / roots ----
check('isInside 同目录', isInside(cwd, cwd) === true)
check('isInside 子目录', isInside(cwd, join(cwd, 'sub', 'a.txt')) === true)
check('isInside 相似前缀被拒', isInside('/data/work', '/data/work-evil/a.txt') === false)
check('roots 含 cwd 与额外目录', describeSendRoots({ cwd, extraDirs: [extra] }).length === 2)
check('roots 忽略空串', describeSendRoots({ cwd, extraDirs: ['', '  '] }).length === 1)

// ---- 合法路径 ----
check('绝对路径通过', resolveSendPath(join(cwd, 'pic.png'), opts) === resolve(cwd, 'pic.png'))
check('相对路径通过', resolveSendPath('pic.png', opts) === resolve(cwd, 'pic.png'))
check('子目录路径通过', resolveSendPath(join('sub', 'nested.txt'), opts) === resolve(cwd, 'sub', 'nested.txt'))
check('额外目录通过', resolveSendPath(join(extra, 'shared.zip'), opts) === resolve(extra, 'shared.zip'))

// ---- 越界与非法 ----
function rejects(name, value, options = opts) {
  try {
    resolveSendPath(value, options)
    check(name, false, '未抛错')
  } catch (error) {
    check(name, /目录内|不存在|不是文件|过大|路径|禁止/.test(error.message), error.message.slice(0, 40))
  }
}
rejects('外部目录被拒', join(outside, 'secret.txt'))
rejects('空路径被拒', '   ')
rejects('不存在被拒', join(cwd, 'missing.png'))
rejects('目录被拒', cwd)
rejects('NUL 字节被拒', `${cwd}\0x.png`)
rejects('超长路径被拒', `${cwd}\\${'a'.repeat(420)}`)
check('大小写不同的相似目录被拒', (() => {
  try { resolveSendPath(`${cwd}-evil/x.txt`, opts); return false } catch { return true }
})())

// ---- 凭据类文件 ----
rejects('.ssh 目录被拒', join(cwd, '.ssh', 'id_rsa'))
rejects('.env 被拒', join(cwd, '.env'))
rejects('.env.local 被拒', join(cwd, '.env.local'))
rejects('pem 被拒', join(cwd, 'server.pem'))
rejects('credentials.json 被拒', join(cwd, 'credentials.json'))
writeFileSync(join(cwd, 'notes.key'), 'x', 'utf8')
rejects('.key 扩展被拒', join(cwd, 'notes.key'))

// ---- 体积 ----
rejects('超出 maxBytes 被拒', join(cwd, 'big.bin'), { ...opts, maxBytes: 1024 })
check('刚好等于上限通过', resolveSendPath(join(cwd, 'big.bin'), { ...opts, maxBytes: 2048 }) === resolve(cwd, 'big.bin'))
check('默认上限为 50MiB', DEFAULT_FILE_SEND_MAX_BYTES === 52428800)
check('labelOfSendPath 返回文件名', labelOfSendPath(join(cwd, 'pic.png')) === 'pic.png')

// ---- 合并转发判定 ----
const long = 'x'.repeat(600)
const short = 'x'.repeat(599)
check('开关关闭时不转发', shouldForwardText(long, { enabled: false }) === false)
check('开关开启且达到阈值', shouldForwardText(long, { enabled: true }) === true)
check('阈值以下不转发', shouldForwardText(short, { enabled: true }) === false)
check('force 可绕过开关', shouldForwardText(long, { enabled: false, force: true }) === true)
check('私聊永不转发', shouldForwardText(long, { enabled: true, force: true, messageType: 'private' }) === false)
check('阈值下限 200 生效', shouldForwardText('x'.repeat(150), { enabled: true, threshold: 10 }) === false)
check('自定义阈值生效', shouldForwardText('x'.repeat(250), { enabled: true, threshold: 200 }) === true)
check('空文本不转发', shouldForwardText('', { enabled: true }) === false)
check('undefined 不抛错', shouldForwardText(undefined, { enabled: true }) === false)

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
