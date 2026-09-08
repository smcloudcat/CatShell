import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { ThemeConfig, ThemePreset, THEME_PRESETS, autoMode } from '../types/theme'

const STORE_FILE = 'app-settings.json'
const THEME_KEY = 'theme'
const ACTIVE_PRESET_KEY = 'activePreset'
const MONITOR_THRESHOLDS_KEY = 'monitorThresholds'

export interface MonitorThresholds {
  enabled: boolean
  cpuPercent: number
  memoryPercent: number
  diskPercent: number
}

export const DEFAULT_MONITOR_THRESHOLDS: MonitorThresholds = {
  enabled: true,
  cpuPercent: 85,
  memoryPercent: 85,
  diskPercent: 90
}

interface SettingsState {
  theme: ThemeConfig
  activePresetId: string | null
  monitorThresholds: MonitorThresholds
  ready: boolean
  setTheme: (patch: Partial<ThemeConfig>) => void
  applyPreset: (preset: ThemePreset) => void
  saveTheme: () => Promise<void>
  replaceTheme: (theme: ThemeConfig) => void
  setMonitorThresholds: (patch: Partial<MonitorThresholds>) => void
  saveMonitorThresholds: () => Promise<void>
  init: () => Promise<void>
}

const AFFECTS_BACKGROUND = ['backgroundType', 'gradient', 'solidColor', 'backgroundImage'] as const

function resolveMode(patch: Partial<ThemeConfig>, prev: ThemeConfig): ThemeConfig {
  const next = { ...prev, ...patch }
  if (patch.modeAuto === false) {
    next.mode = patch.mode ?? autoMode(next)
    return next
  }
  const touchesBg = (AFFECTS_BACKGROUND as readonly string[]).some((k) => k in patch)
  if (touchesBg || patch.modeAuto === true) {
    next.mode = autoMode(next)
  } else if ('mode' in patch) {
    next.mode = patch.mode as ThemeConfig['mode']
  }
  return next
}

export const useSettings = create<SettingsState>((set, get) => ({
  theme: { ...THEME_PRESETS[0].theme },
  activePresetId: THEME_PRESETS[0].id,
  monitorThresholds: { ...DEFAULT_MONITOR_THRESHOLDS },
  ready: false,
  setTheme: (patch) => {
    const next = resolveMode(patch, get().theme)
    set({ theme: next, activePresetId: null })
  },
  applyPreset: (preset) => set({ theme: { ...preset.theme }, activePresetId: preset.id }),
  saveTheme: async () => {
    const { theme, activePresetId } = get()
    try {
      const store = await load(STORE_FILE)
      await store.set(THEME_KEY, theme)
      await store.set(ACTIVE_PRESET_KEY, activePresetId)
      await store.save()
    } catch (err) {
      console.warn('保存主题设置失败（非 Tauri 环境）', err)
      localStorage.setItem(THEME_KEY, JSON.stringify(theme))
    }
  },
  replaceTheme: (theme) => set({ theme: { ...theme, gradient: { ...theme.gradient } }, activePresetId: null }),
  setMonitorThresholds: (patch) =>
    set((state) => ({
      monitorThresholds: {
        ...state.monitorThresholds,
        ...patch,
        cpuPercent: Math.min(100, Math.max(1, patch.cpuPercent ?? state.monitorThresholds.cpuPercent)),
        memoryPercent: Math.min(100, Math.max(1, patch.memoryPercent ?? state.monitorThresholds.memoryPercent)),
        diskPercent: Math.min(100, Math.max(1, patch.diskPercent ?? state.monitorThresholds.diskPercent))
      }
    })),
  saveMonitorThresholds: async () => {
    const thresholds = get().monitorThresholds
    try {
      const store = await load(STORE_FILE)
      await store.set(MONITOR_THRESHOLDS_KEY, thresholds)
      await store.save()
    } catch {
      localStorage.setItem(MONITOR_THRESHOLDS_KEY, JSON.stringify(thresholds))
    }
  },
  init: async () => {
    if (get().ready) return
    try {
      const store = await load(STORE_FILE)
      const saved = await store.get<ThemeConfig>(THEME_KEY)
      const presetId = await store.get<string>(ACTIVE_PRESET_KEY)
      const thresholds = await store.get<Partial<MonitorThresholds>>(MONITOR_THRESHOLDS_KEY)
      if (saved) {
        set({ theme: { ...get().theme, ...saved }, activePresetId: presetId ?? null })
      }
      if (thresholds) {
        set({ monitorThresholds: { ...DEFAULT_MONITOR_THRESHOLDS, ...thresholds } })
      }
    } catch (err) {
      console.warn('读取主题设置失败，使用默认值', err)
      const saved = localStorage.getItem(THEME_KEY)
      const savedThresholds = localStorage.getItem(MONITOR_THRESHOLDS_KEY)
      if (saved) {
        try {
          set({ theme: { ...get().theme, ...JSON.parse(saved) } })
        } catch {
          /* ignore corrupt stored theme */
        }
      }
      if (savedThresholds) {
        try {
          set({ monitorThresholds: { ...DEFAULT_MONITOR_THRESHOLDS, ...JSON.parse(savedThresholds) } })
        } catch {
          /* ignore corrupt stored thresholds */
        }
      }
    } finally {
      set({ ready: true })
    }
  }
}))
