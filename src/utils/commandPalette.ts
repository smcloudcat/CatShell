import { IconName } from '../components/Icon'

export interface PaletteCommand {
  /** 稳定 id：view:<viewId> / action:<name> / host:<hostId> / session:<sessionId> */
  id: string
  label: string
  /** 次要说明（主机地址、动作提示等） */
  hint?: string
  icon?: IconName
  /** 额外匹配关键词，不参与展示 */
  keywords?: string
}

/**
 * 命令面板过滤（纯函数）：大小写不敏感的子串匹配，命中 label 或 keywords；
 * 空查询原样返回全部，保持构建时的优先级顺序（视图 → 动作 → 主机 → 会话）。
 */
export function filterPaletteCommands(
  items: PaletteCommand[],
  query: string
): PaletteCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(q) || (item.keywords ?? '').toLowerCase().includes(q)
  )
}
