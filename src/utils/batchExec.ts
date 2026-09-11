/**
 * 批量命令执行的输入归一化与结果聚合（纯函数，不依赖 React / Tauri）。
 *
 * UI 编排在 `BulkCommandDialog` 与 `SessionsView`；超时夹取的最终裁决在
 * Rust 侧（`ssh_manager::batch`），这里的前端夹取只负责即时反馈。
 */

/** 单次批量执行的目标会话数上限（与 Rust `MAX_BATCH_TARGETS` 对齐）。 */
export const BATCH_MAX_TARGETS = 32
/** 超时夹取区间（秒），与 Rust 常量对齐。 */
export const BATCH_MIN_TIMEOUT_SECS = 1
export const BATCH_MAX_TIMEOUT_SECS = 120
export const BATCH_DEFAULT_TIMEOUT_SECS = 10

/** 把用户输入的超时归一化到合法区间；非法输入回落默认值。 */
export function parseBatchTimeout(raw: string | number | null | undefined): number {
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(value)) return BATCH_DEFAULT_TIMEOUT_SECS
  return Math.min(BATCH_MAX_TIMEOUT_SECS, Math.max(BATCH_MIN_TIMEOUT_SECS, Math.trunc(value)))
}

/** 校验并归一化命令文本：空 / 超长返回 null（与 Rust 上限 4096 对齐）。 */
export function normalizeBatchCommand(raw: string): string | null {
  const command = raw.trim()
  if (!command || command.length > 4096) return null
  return command
}

/** 去重并保持顺序，超过上限截断到合法数量。 */
export function normalizeBatchTargets(ids: number[]): number[] {
  const seen = new Set<number>()
  for (const id of ids) {
    if (!seen.has(id)) seen.add(id)
    if (seen.size >= BATCH_MAX_TARGETS) break
  }
  return [...seen]
}

export interface BatchSummary {
  total: number
  okCount: number
  failedCount: number
  allOk: boolean
}

/** 聚合批量执行结果，供结果区顶栏展示。 */
export function summarizeBatchResults(items: { ok: boolean }[]): BatchSummary {
  const okCount = items.filter((item) => item.ok).length
  return {
    total: items.length,
    okCount,
    failedCount: items.length - okCount,
    allOk: items.length > 0 && okCount === items.length
  }
}

/** 结果行的展示文本：成功给输出，失败给错误。 */
export function batchResultText(item: { ok: boolean; output: string; error: string | null }): string {
  if (!item.ok) return item.error ?? ''
  return item.output
}
