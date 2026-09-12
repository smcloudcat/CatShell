import { isSafeBackgroundImage, normalizeBackgroundImagePath, ThemeConfig } from '../types/theme'
import type { MonitorThresholds } from '../store/settings'

/**
 * 设置项的结构校验与修复（审计 S-4）。
 *
 * 备份还原路径原本就有全套校验，而**启动加载路径**直接把磁盘内容展开合并进 store：
 * 被篡改或写坏的 `app-settings.json` 可以注入非有限数值（`NaN` / `Infinity`）与非法颜色，
 * 造成样式异常与阈值逻辑失效（NaN 比较恒假/恒真）。这里把两条路径的口径收敛到同一处：
 *
 * - `normalizeTheme` / `isMonitorThresholds`：**严格**模式，备份导入沿用「一处坏就整体拒绝」；
 * - `sanitizeTheme` / `sanitizeMonitorThresholds`：**宽松**模式，启动加载用「逐字段回落默认」，
 *   避免本地文件里一个坏字段把用户其余合法设置一起丢掉。
 */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function hexOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 背景图字段：非法值回落 fallback；合法值统一转正斜杠（兼容旧版存的 Windows 反斜杠路径）。 */
function backgroundImageOr(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return fallback
  const normalized = normalizeBackgroundImagePath(value)
  return isSafeBackgroundImage(normalized) ? normalized : fallback
}

/** 校验并归一化主题：兼容旧版（modeAuto + 字面量 mode）与新版（auto/light/dark）结构。
 *  旧版 modeAuto 的语义是按背景亮度推导出的字面量 mode，保留该字面量即可还原当时的实际外观。 */
export function normalizeTheme(value: unknown): ThemeConfig | null {
  if (!value || typeof value !== 'object') return null
  const theme = value as Partial<ThemeConfig>
  // 旧备份里可能存着反斜杠的 Windows 路径：先规范化再校验，导入后才可用。
  const backgroundImage =
    typeof theme.backgroundImage === 'string'
      ? normalizeBackgroundImagePath(theme.backgroundImage)
      : theme.backgroundImage ?? null
  if (
    typeof theme.bgOpacity !== 'number' || !Number.isFinite(theme.bgOpacity) ||
    typeof theme.blurRadius !== 'number' || !Number.isFinite(theme.blurRadius) ||
    typeof theme.borderRadius !== 'number' || !Number.isFinite(theme.borderRadius) ||
    typeof theme.borderOpacity !== 'number' || !Number.isFinite(theme.borderOpacity) ||
    (theme.backgroundType !== 'gradient' && theme.backgroundType !== 'solid' && theme.backgroundType !== 'image') ||
    typeof theme.solidColor !== 'string' || !HEX_COLOR.test(theme.solidColor) ||
    !theme.gradient ||
    typeof theme.gradient.from !== 'string' || !HEX_COLOR.test(theme.gradient.from) ||
    typeof theme.gradient.to !== 'string' || !HEX_COLOR.test(theme.gradient.to) ||
    typeof theme.gradient.angle !== 'number' || !Number.isFinite(theme.gradient.angle) ||
    (backgroundImage !== null && (typeof backgroundImage !== 'string' || !isSafeBackgroundImage(backgroundImage))) ||
    typeof theme.accentColor !== 'string' || !HEX_COLOR.test(theme.accentColor) ||
    (theme.mode !== 'auto' && theme.mode !== 'light' && theme.mode !== 'dark')
  ) {
    return null
  }
  return {
    mode: theme.mode,
    accentColor: theme.accentColor,
    backgroundType: theme.backgroundType,
    solidColor: theme.solidColor,
    gradient: {
      from: theme.gradient.from,
      to: theme.gradient.to,
      angle: clamp(theme.gradient.angle, 0, 360)
    },
    backgroundImage,
    bgOpacity: clamp(theme.bgOpacity, 0.1, 1),
    blurRadius: Math.round(clamp(theme.blurRadius, 2, 20)),
    borderRadius: Math.round(clamp(theme.borderRadius, 0, 24)),
    borderOpacity: clamp(theme.borderOpacity, 0.05, 0.4)
  }
}

/** 宽松修复主题：逐字段校验，坏字段回落到 `fallback`（启动加载路径用，审计 S-4）。 */
export function sanitizeTheme(value: unknown, fallback: ThemeConfig): ThemeConfig {
  if (!value || typeof value !== 'object') {
    return { ...fallback, gradient: { ...fallback.gradient } }
  }
  const theme = value as Partial<ThemeConfig>
  const gradient = (
    theme.gradient && typeof theme.gradient === 'object' ? theme.gradient : {}
  ) as Partial<ThemeConfig['gradient']>
  return {
    mode: theme.mode === 'auto' || theme.mode === 'light' || theme.mode === 'dark' ? theme.mode : fallback.mode,
    accentColor: hexOr(theme.accentColor, fallback.accentColor),
    backgroundType:
      theme.backgroundType === 'gradient' || theme.backgroundType === 'solid' || theme.backgroundType === 'image'
        ? theme.backgroundType
        : fallback.backgroundType,
    solidColor: hexOr(theme.solidColor, fallback.solidColor),
    gradient: {
      from: hexOr(gradient.from, fallback.gradient.from),
      to: hexOr(gradient.to, fallback.gradient.to),
      angle: clamp(numberOr(gradient.angle, fallback.gradient.angle), 0, 360)
    },
    backgroundImage: backgroundImageOr(theme.backgroundImage, fallback.backgroundImage),
    bgOpacity: clamp(numberOr(theme.bgOpacity, fallback.bgOpacity), 0.1, 1),
    blurRadius: Math.round(clamp(numberOr(theme.blurRadius, fallback.blurRadius), 2, 20)),
    borderRadius: Math.round(clamp(numberOr(theme.borderRadius, fallback.borderRadius), 0, 24)),
    borderOpacity: clamp(numberOr(theme.borderOpacity, fallback.borderOpacity), 0.05, 0.4)
  }
}

export function isMonitorThresholds(value: unknown): value is MonitorThresholds {
  if (!value || typeof value !== 'object') return false
  const thresholds = value as Partial<MonitorThresholds>
  return typeof thresholds.enabled === 'boolean' &&
    typeof thresholds.cpuPercent === 'number' && thresholds.cpuPercent >= 1 && thresholds.cpuPercent <= 100 &&
    typeof thresholds.memoryPercent === 'number' && thresholds.memoryPercent >= 1 && thresholds.memoryPercent <= 100 &&
    typeof thresholds.diskPercent === 'number' && thresholds.diskPercent >= 1 && thresholds.diskPercent <= 100
}

/** 宽松修复监控阈值：逐字段夹紧到 1~100，非有限数值回落默认（审计 S-4）。 */
export function sanitizeMonitorThresholds(value: unknown, fallback: MonitorThresholds): MonitorThresholds {
  if (!value || typeof value !== 'object') return { ...fallback }
  const thresholds = value as Partial<MonitorThresholds>
  return {
    enabled: typeof thresholds.enabled === 'boolean' ? thresholds.enabled : fallback.enabled,
    cpuPercent: clamp(numberOr(thresholds.cpuPercent, fallback.cpuPercent), 1, 100),
    memoryPercent: clamp(numberOr(thresholds.memoryPercent, fallback.memoryPercent), 1, 100),
    diskPercent: clamp(numberOr(thresholds.diskPercent, fallback.diskPercent), 1, 100)
  }
}
