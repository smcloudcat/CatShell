import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIGHT_THEME,
  DEFAULT_THEME,
  accentContrastOf,
  luminanceOf,
  resolveMode,
  withModeBackgrounds
} from '../types/theme'

describe('luminanceOf', () => {
  it('returns 0 for black and 1 for white', () => {
    expect(luminanceOf('#000000')).toBe(0)
    expect(luminanceOf('#ffffff')).toBe(1)
  })

  it('returns 0.5 for malformed hex input', () => {
    expect(luminanceOf('#fff')).toBe(0.5)
    expect(luminanceOf('nope')).toBe(0.5)
  })
})

describe('accentContrastOf', () => {
  it('chooses dark text on bright accents and light text on dark accents', () => {
    expect(accentContrastOf('#ffffff')).toBe('#0b0f19')
    expect(accentContrastOf('#000000')).toBe('#ffffff')
  })
})

describe('resolveMode', () => {
  it('resolves explicit modes directly', () => {
    expect(resolveMode('light')).toBe('light')
    expect(resolveMode('dark')).toBe('dark')
  })

  it('falls back to dark when the system preference is unavailable', () => {
    expect(resolveMode('auto')).toBe('dark')
  })
})

describe('withModeBackgrounds', () => {
  it('switches stock backgrounds when the mode changes', () => {
    const dark = { ...DEFAULT_THEME, mode: 'dark' as const }
    const switched = withModeBackgrounds(dark, 'light')
    expect(switched.gradient).toEqual(DEFAULT_LIGHT_THEME.gradient)
    expect(switched.solidColor).toBe(DEFAULT_LIGHT_THEME.solidColor)
    expect(switched.backgroundType).toBe('gradient')
    expect(switched.backgroundImage).toBeNull()
  })

  it('keeps custom backgrounds untouched', () => {
    const custom = {
      ...DEFAULT_THEME,
      backgroundType: 'image' as const,
      backgroundImage: 'file:///wallpaper.png'
    }
    expect(withModeBackgrounds(custom, 'light')).toEqual(custom)
  })

  it('does nothing in auto mode', () => {
    const theme = { ...DEFAULT_THEME, mode: 'auto' as const }
    expect(withModeBackgrounds(theme, 'auto')).toEqual(theme)
  })
})