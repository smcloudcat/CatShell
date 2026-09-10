/**
 * 长列表窗口化的纯计算部分（P2-19）。
 *
 * 只负责「给定滚动位置与行高，该渲染哪一段」这一件事，不依赖 React。
 * 组件侧的状态订阅见 `src/components/useVirtualWindow.ts`。
 */

export interface VirtualWindowInput {
  /** 总项数。 */
  itemCount: number
  /** 单行固定高度（px）。行高不固定时不要使用窗口化。 */
  itemHeight: number
  /** 滚动容器可视高度（px）。首帧或面板隐藏时为 0。 */
  viewportHeight: number
  /** 滚动容器当前的 scrollTop。 */
  scrollTop: number
  /** 上下各多渲染几行，缓解快速滚动时的空白。默认 8。 */
  overscan?: number
}

export interface VirtualWindow {
  /** 首个需要渲染的项下标（含）。 */
  start: number
  /** 末个需要渲染的项下标（不含）。 */
  end: number
  /** 上方占位高度，撑出已滚过区域。 */
  paddingTop: number
  /** 下方占位高度，撑出未滚动到的区域。 */
  paddingBottom: number
  /** 全部项的总高度。 */
  totalHeight: number
  /** false 表示本次为全量渲染（未窗口化），调用方无需插入占位元素。 */
  virtualized: boolean
}

const DEFAULT_OVERSCAN = 8

function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/** 全量渲染：占位为 0，`start..end` 覆盖全部项。 */
function fullWindow(itemCount: number, itemHeight: number): VirtualWindow {
  const height = Number.isFinite(itemHeight) && itemHeight > 0 ? itemCount * itemHeight : 0
  return {
    start: 0,
    end: itemCount,
    paddingTop: 0,
    paddingBottom: 0,
    totalHeight: height,
    virtualized: false
  }
}

/**
 * 计算当前应渲染的区间。
 *
 * 退化为全量渲染的三种情况都应保守处理——**宁可多渲染几行，也不能因为量不到尺寸而白屏**：
 * 1. 没有数据；
 * 2. 行高非法（≤ 0 / NaN）；
 * 3. 视口高度尚未测量（首帧、面板隐藏、`display: none`）。
 */
export function computeVirtualWindow(input: VirtualWindowInput): VirtualWindow {
  const itemCount = normalizeCount(input.itemCount)
  const { itemHeight } = input
  if (itemCount === 0 || !Number.isFinite(itemHeight) || itemHeight <= 0) {
    return fullWindow(itemCount, itemHeight)
  }
  if (!Number.isFinite(input.viewportHeight) || input.viewportHeight <= 0) {
    return fullWindow(itemCount, itemHeight)
  }

  const rawOverscan = input.overscan ?? DEFAULT_OVERSCAN
  const overscan = Number.isFinite(rawOverscan) && rawOverscan > 0 ? Math.floor(rawOverscan) : 0
  const scrollTop = Number.isFinite(input.scrollTop) && input.scrollTop > 0 ? input.scrollTop : 0

  // 滚动位置可能超出内容（列表被清空又回填），夹到有效范围内保证至少渲染一行。
  const firstVisible = Math.min(Math.floor(scrollTop / itemHeight), itemCount - 1)
  const visibleCount = Math.ceil(input.viewportHeight / itemHeight) + 1
  const start = Math.max(0, firstVisible - overscan)
  const end = Math.max(start, Math.min(firstVisible + visibleCount + overscan, itemCount))

  return {
    start,
    end,
    paddingTop: start * itemHeight,
    paddingBottom: (itemCount - end) * itemHeight,
    totalHeight: itemCount * itemHeight,
    virtualized: true
  }
}
