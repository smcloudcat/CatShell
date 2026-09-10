import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { computeVirtualWindow, VirtualWindow } from '../utils/virtualList'

interface Options {
  itemCount: number
  itemHeight: number
  /** 关闭时始终全量渲染：小列表没必要引入占位元素与滚动监听。 */
  enabled: boolean
  overscan?: number
}

interface VirtualWindowState {
  /** 需要挂到滚动容器上的 ref。 */
  containerRef: RefObject<HTMLDivElement | null>
  window: VirtualWindow
}

/**
 * 订阅滚动容器的滚动与尺寸，返回当前应渲染的区间（P2-19）。
 *
 * 只做「测量 + 转发给纯函数」两件事，区间计算全部在 `src/utils/virtualList.ts` 里，
 * 便于单测。容器未挂载或尚未测量出尺寸时返回全量渲染窗口，避免首帧白屏。
 */
export function useVirtualWindow({ itemCount, itemHeight, enabled, overscan }: Options): VirtualWindowState {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewportHeight: 0 })

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const sync = () => {
      setMetrics({ scrollTop: node.scrollTop, viewportHeight: node.clientHeight })
    }
    sync()
    node.addEventListener('scroll', sync, { passive: true })
    // jsdom 等环境没有 ResizeObserver，此时只在挂载与滚动时同步一次。
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    observer?.observe(node)
    return () => {
      node.removeEventListener('scroll', sync)
      observer?.disconnect()
    }
  }, [enabled])

  const window = useMemo(() => {
    if (!enabled) {
      return computeVirtualWindow({ itemCount, itemHeight, viewportHeight: 0, scrollTop: 0 })
    }
    return computeVirtualWindow({
      itemCount,
      itemHeight,
      viewportHeight: metrics.viewportHeight,
      scrollTop: metrics.scrollTop,
      ...(overscan === undefined ? {} : { overscan })
    })
  }, [enabled, itemCount, itemHeight, metrics, overscan])

  return { containerRef, window }
}
