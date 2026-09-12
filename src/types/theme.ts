export type BackgroundType = 'gradient' | 'solid' | 'image'

/** auto = 跟随系统外观 */
export type AppearanceMode = 'auto' | 'light' | 'dark'

export interface GradientConfig {
  from: string
  to: string
  angle: number
}

export interface ThemeConfig {
  /** 外观模式：跟随系统 / 浅色 / 深色 */
  mode: AppearanceMode
  /** 强调色 */
  accentColor: string
  /** 卡片背景不透明度 0.1~1 */
  bgOpacity: number
  /** 模糊半径 2~20 */
  blurRadius: number
  /** 圆角半径 0~24 */
  borderRadius: number
  /** 边框透明度 0.05~0.4 */
  borderOpacity: number
  backgroundType: BackgroundType
  solidColor: string
  gradient: GradientConfig
  backgroundImage: string | null
}

export const DARK_BACKGROUND = {
  backgroundType: 'gradient' as BackgroundType,
  solidColor: '#0b0f19',
  gradient: { from: '#05070d', to: '#131c31', angle: 160 },
  backgroundImage: null
}

export const LIGHT_BACKGROUND = {
  backgroundType: 'gradient' as BackgroundType,
  solidColor: '#eef1f7',
  gradient: { from: '#f7f9fc', to: '#e2e9f4', angle: 160 },
  backgroundImage: null
}

export const DEFAULT_THEME: ThemeConfig = {
  mode: 'auto',
  accentColor: '#6d7cff',
  bgOpacity: 0.58,
  blurRadius: 14,
  borderRadius: 14,
  borderOpacity: 0.12,
  ...DARK_BACKGROUND
}

export const DEFAULT_LIGHT_THEME: ThemeConfig = {
  ...DEFAULT_THEME,
  bgOpacity: 0.72,
  borderOpacity: 0.16,
  ...LIGHT_BACKGROUND
}

/** 十六进制颜色相对亮度（0~1），参考 WCAG 亮度公式 */
export function luminanceOf(hex: string): number {
  const h = hex.replace('#', '')
  if (h.length !== 6) return 0.5
  const channels = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  // map 固定产出 3 个通道，?? 0 只为满足 noUncheckedIndexedAccess
  const [r, g, b] = channels
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}

/** 根据强调色亮度推导其上的文字颜色 */
export function accentContrastOf(hex: string): string {
  return luminanceOf(hex) > 0.55 ? '#0b0f19' : '#ffffff'
}

export function systemPrefersLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
}

/** 解析生效的外观模式 */
export function resolveMode(mode: AppearanceMode): 'light' | 'dark' {
  if (mode === 'auto') return systemPrefersLight() ? 'light' : 'dark'
  return mode
}

function sameGradient(a: GradientConfig, b: GradientConfig): boolean {
  return a.from === b.from && a.to === b.to && a.angle === b.angle
}

function sameBackground(
  a: Pick<ThemeConfig, 'backgroundType' | 'solidColor' | 'gradient' | 'backgroundImage'>,
  b: Pick<ThemeConfig, 'backgroundType' | 'solidColor' | 'gradient' | 'backgroundImage'>
): boolean {
  return (
    a.backgroundType === b.backgroundType &&
    a.solidColor === b.solidColor &&
    a.backgroundImage === b.backgroundImage &&
    sameGradient(a.gradient, b.gradient)
  )
}

/** 背景仍是内置默认（未自定义）时，切换外观模式顺带换用对应底色 */
export function withModeBackgrounds(theme: ThemeConfig, mode: AppearanceMode): ThemeConfig {
  if (mode === 'auto') return theme
  const stock = mode === 'light' ? DEFAULT_LIGHT_THEME : DEFAULT_THEME
  const otherStock = mode === 'light' ? DEFAULT_THEME : DEFAULT_LIGHT_THEME
  const isStock = sameBackground(theme, stock) || sameBackground(theme, otherStock)
  if (!isStock) return theme
  return {
    ...theme,
    backgroundType: stock.backgroundType,
    solidColor: stock.solidColor,
    gradient: { ...stock.gradient },
    backgroundImage: stock.backgroundImage
  }
}

/** CSS url() 值只允许本地路径中出现的安全字符，拒绝引号、逗号、分号等可逃逸字符。 */
export function isSafeBackgroundImage(value: string): boolean {
  return value.length > 0 && value.length <= 500 && !/["`,;()\n\r\\]/.test(value)
}

/**
 * 把用户选择的本地路径规范化为「正斜杠」形式（C:\a\b.png → C:/a/b.png）。
 *
 * Windows 选择对话框返回反斜杠路径：既过不了 isSafeBackgroundImage（反斜杠在
 * CSS url() 里是转义前缀，可能伪造引号/换行），裸放进 url() 也无法加载。
 * 正斜杠路径在 Windows 文件 API 与 Tauri asset 协议下同样有效，配合
 * convertFileSrc 生成 asset:// 地址后即可被 CSP 的 img-src asset: 放行。
 */
export function normalizeBackgroundImagePath(value: string): string {
  return value.trim().replace(/\\/g, '/')
}