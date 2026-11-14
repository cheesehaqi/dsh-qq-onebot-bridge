/**
 * 群文件搜索的纯逻辑：解析 `/文件 找 关键词` 与 `/取 文件夹/文件名`，
 * 把根目录/子文件夹的文件压平成可搜索列表。网络请求仍在 bridge。
 */

/** `找 关键词` / `搜索 关键词`；不是搜索返回 null。 */
export function parseFileSearch(query) {
  const matched = /^(?:找|搜索)\s+(.+)$/.exec(String(query ?? '').trim())
  if (!matched) return null
  const keyword = matched[1].trim()
  return keyword === '' ? null : { keyword }
}

export function parseGroupFilePath(raw) {
  const parts = String(raw ?? '').trim().split(/[\\/]+/).filter(Boolean)
  if (parts.length <= 1) return { folder: '', name: parts[0] ?? '' }
  return { folder: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] }
}

/**
 * @param {{ rootFiles?: Array<object>, folders?: Array<{name:string, files:Array<object>}>, keyword?: string, limit?: number }} input
 * @returns {Array<{folder:string,name:string,size:number,file:object}>}
 */
export function matchGroupFiles({ rootFiles = [], folders = [], keyword = '', limit = 20 } = {}) {
  const needle = String(keyword ?? '').toLowerCase()
  if (needle === '') return []
  const max = Math.max(1, Math.min(50, Math.floor(Number(limit)) || 20))
  const rows = []
  for (const file of rootFiles) {
    const name = String(file?.file_name ?? file?.name ?? '')
    if (name.toLowerCase().includes(needle)) rows.push({ folder: '', name, size: Number(file?.file_size ?? 0) || 0, file })
  }
  for (const folder of folders) {
    const folderName = String(folder?.name ?? '')
    for (const file of (folder?.files ?? [])) {
      const name = String(file?.file_name ?? file?.name ?? '')
      if (name.toLowerCase().includes(needle)) rows.push({ folder: folderName, name, size: Number(file?.file_size ?? 0) || 0, file })
    }
  }
  return rows.slice(0, max)
}
