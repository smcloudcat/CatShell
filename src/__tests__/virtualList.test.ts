import { describe, expect, it } from 'vitest'
import { computeVirtualWindow } from '../utils/virtualList'

const base = { itemCount: 1000, itemHeight: 40, viewportHeight: 400, scrollTop: 0 }

describe('computeVirtualWindow', () => {
  it('renders a windowed slice with spacers when measured', () => {
    const result = computeVirtualWindow(base)
    expect(result.virtualized).toBe(true)
    // 视口 400 / 行高 40 = 10 行可见，加 1 行修正与上下各 8 行 overscan
    expect(result.start).toBe(0)
    expect(result.end).toBe(19)
    expect(result.paddingTop).toBe(0)
    expect(result.paddingBottom).toBe((1000 - 19) * 40)
    expect(result.totalHeight).toBe(40000)
  })

  it('keeps the spacer heights consistent with the total height', () => {
    const result = computeVirtualWindow({ ...base, scrollTop: 4000 })
    const rendered = (result.end - result.start) * 40
    expect(result.paddingTop + rendered + result.paddingBottom).toBe(result.totalHeight)
    expect(result.paddingTop).toBe(result.start * 40)
  })

  it('scrolls the window forward with scrollTop', () => {
    const top = computeVirtualWindow({ ...base, scrollTop: 0 })
    const middle = computeVirtualWindow({ ...base, scrollTop: 4000 })
    expect(middle.start).toBeGreaterThan(top.start)
    expect(middle.end).toBeGreaterThan(top.end)
  })

  it('never runs past the last item at the bottom of the list', () => {
    const result = computeVirtualWindow({ ...base, scrollTop: 40000 })
    expect(result.end).toBeLessThanOrEqual(1000)
    expect(result.paddingBottom).toBe(0)
    expect(result.start).toBeLessThan(1000)
  })

  it('renders everything before the viewport is measured', () => {
    // 首帧 / 面板隐藏时 clientHeight 为 0：必须全量渲染，否则界面空白
    const result = computeVirtualWindow({ ...base, viewportHeight: 0 })
    expect(result.virtualized).toBe(false)
    expect(result.start).toBe(0)
    expect(result.end).toBe(1000)
    expect(result.paddingTop).toBe(0)
    expect(result.paddingBottom).toBe(0)
  })

  it('falls back to full rendering when the row height is unusable', () => {
    for (const itemHeight of [0, -1, Number.NaN]) {
      const result = computeVirtualWindow({ ...base, itemHeight })
      expect(result.virtualized).toBe(false)
      expect(result.end).toBe(1000)
    }
  })

  it('treats a non-positive or invalid item count as empty', () => {
    for (const itemCount of [0, -5, Number.NaN]) {
      const result = computeVirtualWindow({ ...base, itemCount })
      expect(result.virtualized).toBe(false)
      expect(result.start).toBe(0)
      expect(result.end).toBe(0)
      expect(result.totalHeight).toBe(0)
    }
  })

  it('survives an out-of-range scroll position', () => {
    const result = computeVirtualWindow({ ...base, scrollTop: 10_000_000 })
    expect(result.start).toBeLessThan(1000)
    expect(result.start).toBeGreaterThanOrEqual(0)
    expect(result.paddingBottom).toBeGreaterThanOrEqual(0)
  })

  it('honours a custom overscan, including zero', () => {
    const result = computeVirtualWindow({ ...base, scrollTop: 4000, overscan: 0 })
    expect(result.start).toBe(100)
    expect(result.end).toBe(111)
  })
})
