/**
 * Opening the console as an app window (no address bar, looks like a desktop
 * app) using the Edge/Chrome already installed — zero extra dependencies.
 * Pure helpers so the behaviour is unit-testable without launching anything.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const PROGRAM_FILES = process.env['ProgramFiles'] ?? 'C:\\Program Files'
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
const LOCAL_APP_DATA = process.env['LOCALAPPDATA'] ?? ''

/** Chromium-based browsers that support `--app=<url>`, in preference order. */
export const BROWSER_CANDIDATES = [
  `${PROGRAM_FILES_X86}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${PROGRAM_FILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${PROGRAM_FILES}\\Google\\Chrome\\Application\\chrome.exe`,
  `${PROGRAM_FILES_X86}\\Google\\Chrome\\Application\\chrome.exe`,
  LOCAL_APP_DATA ? `${LOCAL_APP_DATA}\\Google\\Chrome\\Application\\chrome.exe` : '',
].filter(Boolean)

/** First installed Chromium browser ('' when none is found). */
export function pickBrowser({ exists = existsSync, candidates = BROWSER_CANDIDATES } = {}) {
  for (const candidate of candidates) {
    try { if (candidate && exists(candidate)) return candidate } catch { /* ignore */ }
  }
  return ''
}

/**
 * Command that shows `url` as an app window.
 * mode: 'app' when a Chromium browser is available, else 'default' (system browser).
 */
export function buildOpenCommand(url, { browser = '', windowSize = '1280,880' } = {}) {
  if (!url) return { mode: 'none', command: '', args: [] }
  if (browser) return { mode: 'app', command: browser, args: [`--app=${url}`, `--window-size=${windowSize}`] }
  return { mode: 'default', command: 'cmd.exe', args: ['/c', 'start', '', url] }
}

/** Launch the panel window; never throws (returns what it did). */
export function openPanel(url, { browser, spawnImpl = spawn, exists = existsSync, logger = console } = {}) {
  const chosen = browser ?? pickBrowser({ exists })
  const { mode, command, args } = buildOpenCommand(url, { browser: chosen })
  if (mode === 'none') return { ok: false, mode, command, args }
  try {
    spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref?.()
    return { ok: true, mode, command, args }
  } catch (error) {
    logger?.warn?.(`打开窗口失败（可用浏览器手动访问）：${error.message}`)
    return { ok: false, mode, command, args }
  }
}
