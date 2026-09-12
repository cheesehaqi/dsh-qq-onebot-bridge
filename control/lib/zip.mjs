/**
 * Minimal ZIP writer (store method, no compression, no dependencies).
 *
 * Used for the one-click diagnostic bundle: a plain .zip the user can send to
 * someone else, produced without pulling in an archiver. CRC-32 is computed with
 * the standard table; entries are written with UTF-8 names (flag bit 11).
 */
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

export function crc32(buffer) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/** DOS date/time pair for one timestamp. */
export function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1F)
  const day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F)
  return { time, date: day }
}

/**
 * @param entries [{ name, data (Buffer|string), mtime? }]
 * @returns Buffer of a valid .zip
 */
export function buildZip(entries, { now = new Date() } = {}) {
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const nameBuffer = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8')
    const crc = crc32(data)
    const { time, date } = dosDateTime(entry.mtime ?? now)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0x0800, 6)      // UTF-8 name flag
    local.writeUInt16LE(0, 8)           // store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuffer, data)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)         // version made by
    header.writeUInt16LE(20, 6)         // version needed
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(date, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(nameBuffer.length, 28)
    header.writeUInt16LE(0, 30)         // extra
    header.writeUInt16LE(0, 32)         // comment
    header.writeUInt16LE(0, 34)         // disk
    header.writeUInt16LE(0, 36)         // internal attrs
    header.writeUInt32LE(0, 38)         // external attrs
    header.writeUInt32LE(offset, 42)
    central.push(header, nameBuffer)

    offset += local.length + nameBuffer.length + data.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuffer, end])
}

/** Read a file into a zip entry (missing/unreadable files are skipped). */
export function fileEntry(file, { name = '', tailBytes = 0, readFile = readFileSync, stat = statSync } = {}) {
  try {
    const buffer = readFile(file)
    const data = tailBytes > 0 && buffer.length > tailBytes ? buffer.subarray(buffer.length - tailBytes) : buffer
    return { name: name || basename(file), data, mtime: stat(file).mtime }
  } catch {
    return null
  }
}
