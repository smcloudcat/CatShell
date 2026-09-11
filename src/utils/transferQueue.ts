/**
 * 传输队列持久化的纯函数层。
 *
 * 只持久化磁盘级传输（有 `.catshell-part` 断点，重启后可续传）；
 * 分块传输是会话内小文件体验，重启后重传成本可忽略，不入队。
 * 绝不落凭据——只记录 hostId 与两侧路径。
 */

export type QueueOutcome = 'done' | 'cancelled' | 'failed'

export interface QueuedTransfer {
  /** 稳定去重键：hostId + 方向 + 两侧路径。 */
  key: string
  hostId: string
  direction: 'upload' | 'download'
  fileName: string
  remotePath: string
  localPath: string
  total: number
  transferred: number
  updatedAt: number
}

/** 稳定去重键：同一主机同一方向同一路径只占一行。 */
export function queueKey(
  hostId: string,
  direction: 'upload' | 'download',
  remotePath: string,
  localPath: string
): string {
  return `${hostId}\u0000${direction}\u0000${remotePath}\u0000${localPath}`
}

/** 登记或覆盖一条队列项（同 key 去重，新项置顶，便于 UI 先看到最近的）。 */
export function applyRegister(entries: QueuedTransfer[], entry: QueuedTransfer): QueuedTransfer[] {
  const rest = entries.filter((item) => item.key !== entry.key)
  return [entry, ...rest]
}

/** 更新断点进度（仅内存态调用方保证节流落盘）。 */
export function applyProgress(
  entries: QueuedTransfer[],
  key: string,
  transferred: number
): QueuedTransfer[] {
  return entries.map((item) =>
    item.key === key
      ? { ...item, transferred, updatedAt: Date.now() }
      : item
  )
}

/** 终态：done / cancelled 移出队列（用户意图或已达成）；failed 保留待续传（断点仍在）。 */
export function applyFinalize(
  entries: QueuedTransfer[],
  key: string,
  outcome: QueueOutcome
): QueuedTransfer[] {
  if (outcome === 'failed') return entries
  return entries.filter((item) => item.key !== key)
}

/** 取某主机下的待续传清单（按更新时间倒序）。 */
export function pendingForHost(entries: QueuedTransfer[], hostId: string): QueuedTransfer[] {
  return entries
    .filter((item) => item.hostId === hostId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 主机档案被删除后其队列项永远无法续传，启动时静默清理。 */
export function pruneMissingHosts(entries: QueuedTransfer[], knownHostIds: Set<string>): QueuedTransfer[] {
  return entries.filter((item) => knownHostIds.has(item.hostId))
}

/** 从持久化存储读取时的形状校验：脏数据逐条丢弃，绝不抛错。 */
export function sanitizeLoaded(raw: unknown): QueuedTransfer[] {
  if (!Array.isArray(raw)) return []
  const entries: QueuedTransfer[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<QueuedTransfer>
    if (
      typeof candidate.key !== 'string' ||
      !candidate.key ||
      typeof candidate.hostId !== 'string' ||
      !candidate.hostId ||
      (candidate.direction !== 'upload' && candidate.direction !== 'download') ||
      typeof candidate.fileName !== 'string' ||
      typeof candidate.remotePath !== 'string' ||
      typeof candidate.localPath !== 'string' ||
      typeof candidate.total !== 'number' ||
      typeof candidate.transferred !== 'number' ||
      typeof candidate.updatedAt !== 'number'
    ) {
      continue
    }
    entries.push({
      key: candidate.key,
      hostId: candidate.hostId,
      direction: candidate.direction,
      fileName: candidate.fileName,
      remotePath: candidate.remotePath,
      localPath: candidate.localPath,
      total: candidate.total,
      transferred: Math.min(candidate.transferred, candidate.total),
      updatedAt: candidate.updatedAt
    })
  }
  return entries
}
