/**
 * Tiny JSON store helpers shared by bridge-level state (session map, stats,
 * counters). Writes are atomic (temp file + rename) so a host crash can never
 * leave a half-written file behind, and reads are mtime-cached so hot paths
 * (every inbound message) do not re-parse the same file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Read and parse a JSON file; returns `fallback` when missing or corrupt. */
export function readJson(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write JSON atomically (temp file in the same directory, then rename). */
export function writeJsonAtomic(file, value, { pretty = false } = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = join(dirname(file), `.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`)
    writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0), 'utf8')
    try {
      renameSync(tmp, file)
    } catch {
      // Windows cannot always rename onto an existing file: remove then rename.
      rmSync(file, { force: true })
      renameSync(tmp, file)
    }
    return true
  } catch {
    return false
  }
}

/** Append one line to a log file, capped so it never grows unbounded. */
export function appendCappedLine(file, line, { maxBytes = 512 * 1024, keepBytes = 64 * 1024 } = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    let size = 0
    try { size = statSync(file).size } catch { size = 0 }
    if (size > maxBytes) {
      const tail = readFileSync(file, 'utf8').slice(-keepBytes)
      writeFileSync(file, tail, 'utf8')
    }
    writeFileSync(file, `${line}\n`, { flag: 'a' })
  } catch { /* best effort */ }
}

/**
 * File-backed JSON document with mtime caching.
 * `read()` returns the cached object; `mutate(fn)` reads, lets `fn` change it
 * and writes the result atomically.
 */
export class JsonStore {
  constructor(file, { fallback = {}, pretty = false } = {}) {
    this.file = file
    this.fallback = fallback
    this.pretty = pretty
    this.cached = null
    this.stamp = ''
  }

  /** mtime + size: a same-millisecond rewrite with different content still invalidates. */
  #stamp() {
    try {
      const stat = statSync(this.file)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return ''
    }
  }

  /** Load (re-reading when the file changed on disk). */
  read() {
    const stamp = this.#stamp()
    if (this.cached !== null && stamp !== '' && stamp === this.stamp) return this.cached
    const data = readJson(this.file, null)
    this.cached = data !== null && typeof data === 'object' ? data : this.#freshFallback()
    this.stamp = stamp
    return this.cached
  }

  /** A private copy of the fallback: callers must never mutate the configured default. */
  #freshFallback() {
    try { return structuredClone(this.fallback) } catch { return JSON.parse(JSON.stringify(this.fallback)) }
  }

  /** Replace the whole document. */
  write(value) {
    this.cached = value
    const ok = writeJsonAtomic(this.file, value, { pretty: this.pretty })
    this.stamp = this.#stamp()
    return ok
  }

  /** Read → mutate → write. Returns whatever `fn` returns. */
  mutate(fn) {
    const data = this.read()
    const result = fn(data)
    this.write(data)
    return result
  }

  /** Delete the document (used by /new to forget a resumed session). */
  clear() {
    this.cached = this.#freshFallback()
    this.stamp = ''
    try { rmSync(this.file, { force: true }) } catch { /* best effort */ }
  }
}
