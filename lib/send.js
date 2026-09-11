/**
 * Outbound media helpers: validation of paths the AGENT is allowed to send into
 * QQ, and the "long reply becomes a merged-forward card" decision.
 * Pure functions (no bridge instance) so they stay unit-testable.
 */
import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve, sep } from 'node:path'

export const DEFAULT_FILE_SEND_MAX_BYTES = 50 * 1024 * 1024

// Credential-shaped paths are never sendable, even when they sit inside an allowed root.
const FORBIDDEN_DIR = /(^|[\\/])\.(dsh|ssh|aws|gnupg|kube|docker|azure)([\\/]|$)/i
const FORBIDDEN_ENV = /(^|[\\/])\.env(\.|$)/i
const FORBIDDEN_EXT = /\.(pem|key|pfx|p12|kdbx|jks|keystore)$/i
const FORBIDDEN_NAME = /(^|[\\/])(credentials(\.json)?|id_rsa|id_ed25519|id_ecdsa|known_hosts|\.netrc|\.git-credentials|token\.json)$/i

/** True when `target` is `root` itself or lives inside it (prefix-safe). */
export function isInside(root, target) {
  const base = resolve(root)
  const value = resolve(target)
  return value === base || value.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/** Directories the agent may send files from: the session cwd plus configured extras. */
export function describeSendRoots({ cwd = process.cwd(), extraDirs = [] } = {}) {
  const roots = [resolve(cwd)]
  for (const dir of extraDirs ?? []) {
    const value = String(dir ?? '').trim()
    if (value) roots.push(resolve(value))
  }
  return roots
}

/**
 * Validate one agent-provided outbound path.
 * @returns the absolute path, or throws an Error with a Chinese explanation.
 */
export function resolveSendPath(raw, { cwd = process.cwd(), extraDirs = [], maxBytes = DEFAULT_FILE_SEND_MAX_BYTES } = {}) {
  const value = String(raw ?? '').trim()
  if (!value) throw new Error('未提供文件路径')
  if (value.includes('\0')) throw new Error('路径非法')
  if (value.length > 400) throw new Error('路径过长')
  const abs = isAbsolute(value) ? resolve(value) : resolve(cwd, value)
  const roots = describeSendRoots({ cwd, extraDirs })
  if (!roots.some((root) => isInside(root, abs))) {
    throw new Error(`路径不在允许发送的目录内：${roots.join(' / ')}`)
  }
  if (FORBIDDEN_DIR.test(abs) || FORBIDDEN_ENV.test(abs) || FORBIDDEN_EXT.test(abs) || FORBIDDEN_NAME.test(abs)) {
    throw new Error('该路径被安全策略禁止外发（凭据/密钥类文件）')
  }
  if (!existsSync(abs)) throw new Error(`文件不存在：${abs}`)
  let stat
  try { stat = statSync(abs) } catch (error) { throw new Error(`无法读取文件：${error.message}`) }
  if (!stat.isFile()) throw new Error('目标不是文件')
  const limit = Math.max(1, Number(maxBytes) || DEFAULT_FILE_SEND_MAX_BYTES)
  if (stat.size > limit) {
    throw new Error(`文件过大：${(stat.size / 1048576).toFixed(1)} MB（上限 ${Math.round(limit / 1048576)} MB）`)
  }
  return abs
}

/** Long group replies may be delivered as a merged-forward card instead of a wall of text. */
export function shouldForwardText(text, { enabled = false, force = false, threshold = 600, messageType = 'group' } = {}) {
  if (!force && enabled !== true) return false
  if (messageType !== 'group') return false
  const min = Math.max(200, Number(threshold) || 600)
  return String(text ?? '').length >= min
}

/** Human-readable label for a validated send path. */
export function labelOfSendPath(abs) {
  return basename(String(abs))
}
