export type BackgroundType = 'gradient' | 'solid' | 'image'

export type ColorMode = 'light' | 'dark'

export interface ThemeConfig {
  /** 卡片背景不透明度 0.1~1 */
  bgOpacity: number
  /** 模糊半径 2~20 */
  blurRadius: number
  /** 圆角半径 0~24 */
  borderRadius: number
  /** 边框透明度 0.2~0.4 */
  borderOpacity: number
  backgroundType: BackgroundType
  solidColor: string
  gradient: {
    from: string
    to: string
    angle: number
  }
  backgroundImage: string | null
  accentColor: string
  /** 文字配色：light=深色文字，dark=浅色文字 */
  mode: ColorMode
  /** true 时随背景明暗自动切换 mode */
  modeAuto: boolean
}

export const DEFAULT_THEME: ThemeConfig = {
  bgOpacity: 0.3,
  blurRadius: 6,
  borderRadius: 16,
  borderOpacity: 0.3,
  backgroundType: 'gradient',
  solidColor: '#1e293b',
  gradient: {
    from: '#0f2027',
    to: '#203a43',
    angle: 135
  },
  backgroundImage: null,
  accentColor: '#38bdf8',
  mode: 'dark',
  modeAuto: true
}

export type ThemePreset = {
  id: string
  name: string
  theme: ThemeConfig
}

/** 十六进制颜色相对亮度（0~1），参考 WCAG 亮度公式 */
export function luminanceOf(hex: string): number {
  const h = hex.replace('#', '')
  if (h.length !== 6) return 0.5
  const channels = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

/** 根据背景明暗自动推断文字配色 */
export function autoMode(theme: ThemeConfig): ColorMode {
  if (theme.backgroundType === 'image') return theme.mode
  const colors =
    theme.backgroundType === 'gradient'
      ? [theme.gradient.from, theme.gradient.to]
      : [theme.solidColor]
  const avg = colors.reduce((sum, c) => sum + luminanceOf(c), 0) / colors.length
  return avg > 0.52 ? 'light' : 'dark'
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'deep-space',
    name: '深空',
    theme: {
      bgOpacity: 0.3,
      blurRadius: 6,
      borderRadius: 16,
      borderOpacity: 0.3,
      backgroundType: 'gradient',
      solidColor: '#1e293b',
      gradient: { from: '#0f172a', to: '#1e3a5f', angle: 135 },
      backgroundImage: null,
      accentColor: '#38bdf8',
      mode: 'dark',
      modeAuto: true
    }
  },
  {
    id: 'aurora',
    name: '极光',
    theme: {
      bgOpacity: 0.25,
      blurRadius: 10,
      borderRadius: 16,
      borderOpacity: 0.35,
      backgroundType: 'gradient',
      solidColor: '#0f1b2d',
      gradient: { from: '#052e2b', to: '#1b1e3a', angle: 160 },
      backgroundImage: null,
      accentColor: '#2dd4bf',
      mode: 'dark',
      modeAuto: true
    }
  },
  {
    id: 'light',
    name: '晨曦',
    theme: {
      bgOpacity: 0.35,
      blurRadius: 8,
      borderRadius: 16,
      borderOpacity: 0.3,
      backgroundType: 'gradient',
      solidColor: '#f8fafc',
      gradient: { from: '#e0eafc', to: '#cfdef3', angle: 120 },
      backgroundImage: null,
      accentColor: '#2563eb',
      mode: 'light',
      modeAuto: true
    }
  },
  {
    id: 'midnight',
    name: '午夜',
    theme: {
      bgOpacity: 0.5,
      blurRadius: 4,
      borderRadius: 12,
      borderOpacity: 0.25,
      backgroundType: 'solid',
      solidColor: '#111827',
      gradient: { from: '#111827', to: '#1f2937', angle: 135 },
      backgroundImage: null,
      accentColor: '#a78bfa',
      mode: 'dark',
      modeAuto: true
    }
  }
]