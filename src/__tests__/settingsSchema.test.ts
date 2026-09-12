import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME } from '../types/theme'
import {
  isMonitorThresholds,
  normalizeTheme,
  sanitizeMonitorThresholds,
  sanitizeTheme
} from '../utils/settingsSchema'
import { DEFAULT_MONITOR_THRESHOLDS } from '../store/settings'

const validTheme = () => ({ ...DEFAULT_THEME, gradient: { ...DEFAULT_THEME.gradient } })

describe('normalizeTheme (严格：备份导入)', () => {
  it('接受合法主题并归一化字段', () => {
    const result = normalizeTheme(validTheme())
    expect(result).not.toBeNull()
    expect(result?.mode).toBe(DEFAULT_THEME.mode)
    expect(result?.gradient).toEqual(DEFAULT_THEME.gradient)
  })

  it('夹紧越界数值并四舍五入整数项', () => {
    const result = normalizeTheme({
      ...validTheme(),
      bgOpacity: 5,
      blurRadius: 100,
      borderRadius: -3,
      borderOpacity: 0,
      gradient: { ...DEFAULT_THEME.gradient, angle: 720 }
    })
    expect(result?.bgOpacity).toBe(1)
    expect(result?.blurRadius).toBe(20)
    expect(result?.borderRadius).toBe(0)
    expect(result?.borderOpacity).toBe(0.05)
    expect(result?.gradient.angle).toBe(360)
  })

  it('对非有限数值整体拒绝（NaN / Infinity）', () => {
    expect(normalizeTheme({ ...validTheme(), bgOpacity: Number.NaN })).toBeNull()
    expect(normalizeTheme({ ...validTheme(), blurRadius: Number.POSITIVE_INFINITY })).toBeNull()
    expect(normalizeTheme({ ...validTheme(), gradient: { ...DEFAULT_THEME.gradient, angle: Number.NaN } })).toBeNull()
  })

  it('对非法颜色与非法枚举整体拒绝', () => {
    expect(normalizeTheme({ ...validTheme(), accentColor: 'red' })).toBeNull()
    expect(normalizeTheme({ ...validTheme(), solidColor: '#fff' })).toBeNull()
    expect(normalizeTheme({ ...validTheme(), mode: 'solar' })).toBeNull()
    expect(normalizeTheme({ ...validTheme(), backgroundType: 'video' })).toBeNull()
  })

  it('非对象输入整体拒绝', () => {
    for (const value of [null, undefined, 42, 'theme', []]) {
      expect(normalizeTheme(value)).toBeNull()
    }
  })

  it('规范化旧备份里的反斜杠背景图路径', () => {
    const result = normalizeTheme({ ...validTheme(), backgroundImage: 'C:\\pics\\wall.png' })
    expect(result?.backgroundImage).toBe('C:/pics/wall.png')
  })
})

describe('sanitizeTheme (宽松：启动加载)', () => {
  it('逐字段回落默认，坏字段不影响好字段', () => {
    const result = sanitizeTheme({ ...validTheme(), bgOpacity: Number.NaN, accentColor: 'nope' }, validTheme())
    expect(result.bgOpacity).toBe(DEFAULT_THEME.bgOpacity)
    expect(result.accentColor).toBe(DEFAULT_THEME.accentColor)
    expect(result.mode).toBe(DEFAULT_THEME.mode)
  })

  it('夹紧越界但有限的数值', () => {
    const result = sanitizeTheme({ ...validTheme(), bgOpacity: 9, blurRadius: -5 }, validTheme())
    expect(result.bgOpacity).toBe(1)
    expect(result.blurRadius).toBe(2)
  })

  it('非对象输入返回默认值的深拷贝（gradient 独立）', () => {
    const result = sanitizeTheme(null, validTheme())
    expect(result).toEqual(validTheme())
    expect(result.gradient).not.toBe(DEFAULT_THEME.gradient)
  })

  it('缺失字段用默认值补齐', () => {
    const result = sanitizeTheme({ mode: 'dark' }, validTheme())
    expect(result.mode).toBe('dark')
    expect(result.bgOpacity).toBe(DEFAULT_THEME.bgOpacity)
    expect(result.gradient).toEqual(DEFAULT_THEME.gradient)
  })

  it('非法背景图回落默认，合法反斜杠路径被规范化', () => {
    expect(sanitizeTheme({ ...validTheme(), backgroundImage: 'bad"path' }, validTheme()).backgroundImage)
      .toBe(DEFAULT_THEME.backgroundImage)
    expect(sanitizeTheme({ ...validTheme(), backgroundImage: 'C:\\a\\b.png' }, validTheme()).backgroundImage)
      .toBe('C:/a/b.png')
  })
})

describe('isMonitorThresholds (严格：备份导入)', () => {
  it('接受边界内的合法阈值', () => {
    expect(isMonitorThresholds({ ...DEFAULT_MONITOR_THRESHOLDS })).toBe(true)
    expect(isMonitorThresholds({ enabled: true, cpuPercent: 1, memoryPercent: 100, diskPercent: 50 })).toBe(true)
  })

  it('拒绝越界、非数值、非布尔与缺字段', () => {
    expect(isMonitorThresholds({ enabled: true, cpuPercent: 0, memoryPercent: 50, diskPercent: 50 })).toBe(false)
    expect(isMonitorThresholds({ enabled: true, cpuPercent: 101, memoryPercent: 50, diskPercent: 50 })).toBe(false)
    expect(isMonitorThresholds({ enabled: 'yes', cpuPercent: 50, memoryPercent: 50, diskPercent: 50 })).toBe(false)
    expect(isMonitorThresholds({ enabled: true, cpuPercent: 50 })).toBe(false)
    expect(isMonitorThresholds(null)).toBe(false)
  })
})

describe('sanitizeMonitorThresholds (宽松：启动加载)', () => {
  it('NaN / Infinity 回落到默认', () => {
    const result = sanitizeMonitorThresholds(
      { enabled: true, cpuPercent: Number.NaN, memoryPercent: Number.POSITIVE_INFINITY, diskPercent: 50 },
      DEFAULT_MONITOR_THRESHOLDS
    )
    expect(result.cpuPercent).toBe(DEFAULT_MONITOR_THRESHOLDS.cpuPercent)
    expect(result.memoryPercent).toBe(DEFAULT_MONITOR_THRESHOLDS.memoryPercent)
    expect(result.diskPercent).toBe(50)
  })

  it('越界值被夹紧到 1~100', () => {
    const result = sanitizeMonitorThresholds(
      { enabled: true, cpuPercent: 0, memoryPercent: 150, diskPercent: -20 },
      DEFAULT_MONITOR_THRESHOLDS
    )
    expect(result.cpuPercent).toBe(1)
    expect(result.memoryPercent).toBe(100)
    expect(result.diskPercent).toBe(1)
  })

  it('非对象输入返回默认值拷贝', () => {
    const result = sanitizeMonitorThresholds('nope', DEFAULT_MONITOR_THRESHOLDS)
    expect(result).toEqual(DEFAULT_MONITOR_THRESHOLDS)
    expect(result).not.toBe(DEFAULT_MONITOR_THRESHOLDS)
  })
})
