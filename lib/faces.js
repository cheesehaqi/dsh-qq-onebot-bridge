/**
 * Face library: common yellow-face (CQ:face) id map plus a local library
 * of saved image stickers (favorite faces) under <cwd>/qq-faces.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'

/** Common OneBot yellow-face ids (subset of the QQ official emoji table). */
export const FACE_IDS = {
  惊讶: 0, 撇嘴: 1, 色: 2, 发呆: 3, 得意: 4, 流泪: 5, 害羞: 6, 闭嘴: 7, 睡: 8, 大哭: 9,
  尴尬: 10, 发怒: 11, 调皮: 12, 呲牙: 13, 微笑: 14, 难过: 15, 酷: 16, 抓狂: 97, 吐: 18,
  偷笑: 19, 可爱: 21, 白眼: 22, 傲慢: 23, 饥饿: 24, 困: 25, 惊恐: 26, 流汗: 27, 憨笑: 28,
  疑问: 32, 嘘: 33, 晕: 34, 折磨: 35, 衰: 36, 骷髅: 37, 敲打: 38, 再见: 39, 擦汗: 40,
  抠鼻: 41, 鼓掌: 42, 坏笑: 44, 鄙视: 48, 委屈: 49, 快哭了: 50, 阴险: 51, 亲亲: 52,
  可怜: 54, 爱心: 66, 心碎: 67, 蛋糕: 68, 炸弹: 70, 月亮: 75, 太阳: 76, 礼物: 77,
  拥抱: 78, 强: 79, 弱: 80, 握手: 81, 胜利: 82, 抱拳: 83, 拳头: 85, 爱你: 87,
  爱情: 90, 飞吻: 91, 跳跳: 92, 发抖: 93, 怄火: 94, 转圈: 95, 冷汗: 96,
}

export class FaceLibrary {
  constructor(directory) {
    this.directory = directory
    this.indexPath = join(directory, 'faces.json')
    this.items = []
    this.load()
  }

  load() {
    try {
      if (existsSync(this.indexPath)) {
        const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8'))
        if (Array.isArray(parsed)) this.items = parsed
      }
    } catch {
      this.items = []
    }
    this.reconcile()
  }

  /**
   * Reconcile the index with the directory: drop entries whose file is gone
   * and register image files dropped into the directory manually.
   */
  reconcile() {
    try {
      if (!existsSync(this.directory)) return
      this.items = this.items.filter((item) => typeof item?.file === 'string' && existsSync(item.file))
      const known = new Set(this.items.map((item) => basename(item.file)))
      for (const file of readdirSync(this.directory)) {
        if (!/\.(png|jpe?g|gif|webp)$/i.test(file)) continue
        if (known.has(file)) continue
        const name = file.replace(/\.[^.]+$/, '')
        this.items.push({
          id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
          name,
          file: join(this.directory, file),
        })
      }
      this.save()
    } catch {
      // Directory scan is best-effort; the in-memory list stays usable.
    }
  }

  save() {
    try {
      mkdirSync(this.directory, { recursive: true })
      writeFileSync(this.indexPath, JSON.stringify(this.items, null, 2), 'utf8')
    } catch (error) {
      console.error(`[qq-bridge] face index save failed: ${error.message}`)
    }
  }

  list() {
    const yellow = Object.entries(FACE_IDS).map(([name, id]) => ({ kind: 'face', id: String(id), name }))
    const saved = this.items.map((item) => ({ kind: 'image', id: item.id, name: item.name, file: item.file }))
    return { yellow, saved }
  }

  /** Add a downloaded sticker file into the library. */
  addImage(name, filePath) {
    const id = `f${Date.now().toString(36)}`
    this.items.push({ id, name, file: filePath })
    this.save()
    return { id, name, file: filePath }
  }

  /** Resolve a user-provided name or id to CQ segments (one face or one image). */
  resolve(nameOrId) {
    const key = String(nameOrId).trim()
    if (key === '') return null
    const yellow = Object.entries(FACE_IDS).find(([name, id]) => name === key || String(id) === key)
    if (yellow) return { segments: [{ type: 'face', data: { id: String(yellow[1]) } }], label: `黄脸[${yellow[0]}]` }
    const saved = this.items.find((item) => item.name === key || item.id === key)
    if (saved && existsSync(saved.file)) {
      return { segments: [{ type: 'image', data: { file: saved.file } }], label: `收藏图[${saved.name}]` }
    }
    return null
  }

  /** Expand [face:xxx] and [img:xxx] markers inside reply text into CQ segments. */
  expandMarkers(text) {
    const marker = /\[(face|img):([^\]]+)\]/g
    const segments = []
    let last = 0
    let match
    while ((match = marker.exec(text)) !== null) {
      if (match.index > last) segments.push({ type: 'text', data: { text: text.slice(last, match.index) } })
      const resolved = this.resolve(match[2])
      if (resolved) segments.push(...resolved.segments)
      else segments.push({ type: 'text', data: { text: match[0] } })
      last = match.index + match[0].length
    }
    if (last < text.length) segments.push({ type: 'text', data: { text: text.slice(last) } })
    return segments.length > 0 ? segments : [{ type: 'text', data: { text } }]
  }

  /** Download a remote sticker image into the library and register it. */
  async addRemoteImage(url, name) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`sticker download HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) throw new Error('sticker download empty or too large')
    const ext = guessExt(url)
    mkdirSync(this.directory, { recursive: true })
    const fileName = `img-${Date.now().toString(36)}${ext}`
    const filePath = join(this.directory, fileName)
    writeFileSync(filePath, buffer)
    return this.addImage(name, filePath)
  }
}

function guessExt(url) {
  const clean = url.split('?')[0].toLowerCase()
  if (clean.endsWith('.gif')) return '.gif'
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return '.jpg'
  if (clean.endsWith('.webp')) return '.webp'
  return '.png'
}
