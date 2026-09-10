import { SftpEntry } from '../../types/session'

/**
 * SFTP 面板的纯函数层：路径拼接、权限格式化、排序筛选与输入校验。
 *
 * 这些逻辑原先内联在 `SessionSftpPanel` 的组件体里，既难测试也容易在
 * 多处校验里写出不一致的规则。抽出来后组件只负责编排副作用。
 */

/** 分块传输的单次载荷大小，与 Rust 侧 `sftp_read_chunk` 的上限保持一致。 */
export const SFTP_CHUNK_SIZE = 256 * 1024

/** 超过此大小走 begin/chunk/finish 协议，避免一次性把整个文件读进内存。 */
export const SFTP_CHUNKED_THRESHOLD = 16 * 1024 * 1024

export const CHMOD_PRESETS = ['644', '600', '755', '700', '777']

export type SftpSortKey = 'name' | 'size' | 'modifiedAt'

export const SFTP_SORT_LABELS: Record<SftpSortKey, string> = {
  name: '按名称',
  size: '按大小',
  modifiedAt: '按修改时间'
}

/** 去掉尾部斜杠后的规范路径；根目录仍返回 `/`。 */
function normalizeDir(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

export function parentPath(path: string): string {
  const normalized = normalizeDir(path)
  if (normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

export function permissionText(mode: number): string {
  const bits = mode & 0o777
  const chars = ['r', 'w', 'x']
  let text = ''
  for (let shift = 6; shift >= 0; shift -= 3) {
    const triad = (bits >> shift) & 0o7
    for (let bit = 2; bit >= 0; bit -= 1) {
      text += (triad >> bit) & 1 ? chars[2 - bit] : '-'
    }
  }
  return text
}

export function formatMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, '0')
}

export function entryTitle(entry: SftpEntry): string {
  const parts: string[] = []
  if (entry.permissions !== null) parts.push(`权限 ${formatMode(entry.permissions)}（${permissionText(entry.permissions)}）`)
  if (entry.owner) parts.push(`属主 ${entry.owner}`)
  if (entry.group) parts.push(`组 ${entry.group}`)
  if (entry.modifiedAt) parts.push(`修改于 ${new Date(entry.modifiedAt * 1000).toLocaleString()}`)
  return parts.join(' · ')
}

/** 把目录与文件名拼成绝对远端路径，避免出现重复斜杠。 */
export function joinRemotePath(dir: string, name: string): string {
  const normalized = dir === '/' ? '' : dir.replace(/\/+$/, '')
  return `${normalized}/${name}`
}

/** 目标目录合法性的判定结果，便于调用方映射到各自的错误文案。 */
export type MoveValidation =
  | { ok: true; target: string }
  | { ok: false; reason: 'invalid' | 'same' | 'descendant' }

/**
 * 校验「移动到其他目录」的目标目录并算出最终路径。
 *
 * 单独抽出来是因为这里有三条互斥规则（绝对路径、不能原地移动、不能移进自身子树），
 * 写在提交函数里既不好测也容易漏掉分支。
 */
export function resolveMoveTarget(entry: SftpEntry, dirInput: string): MoveValidation {
  const dir = dirInput.trim()
  if (!dir.startsWith('/') || dir.includes('//')) return { ok: false, reason: 'invalid' }
  const normalized = normalizeDir(dir)
  const target = joinRemotePath(normalized, entry.name)
  if (target === entry.path) return { ok: false, reason: 'same' }
  if (entry.kind === 'directory' && target.startsWith(`${entry.path}/`)) {
    return { ok: false, reason: 'descendant' }
  }
  return { ok: true, target }
}

/** mkdir / rename 的名称校验：非空且不含路径分隔符。 */
export function isValidRemoteName(value: string): boolean {
  const name = value.trim()
  return Boolean(name) && !name.includes('/')
}

/** 解析八进制权限输入，非法时返回 null（而不是 NaN 或静默取 0）。 */
export function parseChmodInput(value: string): number | null {
  const raw = value.trim()
  if (!/^[0-7]{3,4}$/.test(raw)) return null
  return parseInt(raw, 8)
}

export interface SftpFilterOptions {
  nameFilter: string
  showHidden: boolean
  sortKey: SftpSortKey
  sortAsc: boolean
}

/**
 * 过滤 + 排序目录项。目录始终排在文件前面，方向键只影响同类内部的顺序。
 * 返回新数组，不修改入参。
 */
export function visibleEntries(entries: SftpEntry[], options: SftpFilterOptions): SftpEntry[] {
  const needle = options.nameFilter.trim().toLowerCase()
  const list = entries.filter((entry) => {
    if (!options.showHidden && entry.name.startsWith('.')) return false
    if (needle && !entry.name.toLowerCase().includes(needle)) return false
    return true
  })
  const dirFirst = (entry: SftpEntry) => (entry.kind === 'directory' ? 0 : 1)
  return list.sort((a, b) => {
    const dirDelta = dirFirst(a) - dirFirst(b)
    if (dirDelta !== 0) return dirDelta
    let delta: number
    if (options.sortKey === 'name') delta = a.name.localeCompare(b.name, 'zh-Hans-CN')
    else if (options.sortKey === 'size') delta = a.size - b.size
    else delta = (a.modifiedAt ?? -1) - (b.modifiedAt ?? -1)
    return options.sortAsc ? delta : -delta
  })
}

/**
 * 上传失败重试：小文件一次性写入可能撞上瞬时网络抖动，
 * 三次之内指数退避（0.5s / 1s）后仍然失败才向上抛。
 */
export async function uploadWithRetry(
  target: string,
  data: Uint8Array,
  writeFile: (path: string, data: Uint8Array) => Promise<void>
): Promise<number> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await writeFile(target, data)
      return attempt
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
  throw lastError
}

/** 拼接 { '替换远端文件'？} 之类的确认文案时使用：把文件名列表渲染成顿号连接。 */
export function joinNames(names: string[]): string {
  return names.join('、')
}

/** 触发浏览器下载并释放 object URL，避免长期持有 Blob。 */
export function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}
