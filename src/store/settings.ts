import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { ThemeConfig, DEFAULT_THEME, withModeBackgrounds } from '../types/theme'

const STORE_FILE = 'app-settings.json'
const THEME_KEY = 'theme'
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
  monitorThresholds: MonitorThresholds
  ready: boolean
  setTheme: (patch: Partial<ThemeConfig>) => void
  setAppearanceMode: (mode: ThemeConfig['mode']) => void
  resetTheme: () => void
  saveTheme: () => Promise<void>
  replaceTheme: (theme: ThemeConfig) => void
  setMonitorThresholds: (patch: Partial<MonitorThresholds>) => void
  saveMonitorThresholds: () => Promise<void>
  init: () => Promise<void>
}

/** 旧版主题字段（四预设时代），检测到时整体迁移为新默认主题 */
function isLegacyTheme(saved: unknown): boolean {
  if (!saved || typeof saved !== 'object') return true
  const record = saved as Record<string, unknown>
  return !('mode' in record) || 'modeAuto' in record || typeof record.mode !== 'string'
}

export const useSettings = create<SettingsState>((set, get) => ({
  theme: { ...DEFAULT_THEME, gradient: { ...DEFAULT_THEME.gradient } },
  monitorThresholds: { ...DEFAULT_MONITOR_THRESHOLDS },
  ready: false,
  setTheme: (patch) => set((state) => ({ theme: { ...state.theme, ...patch } })),
  setAppearanceMode: (mode) =>
    set((state) => ({ theme: withModeBackgrounds({ ...state.theme, mode }, mode) })),
  resetTheme: () => set({ theme: { ...DEFAULT_THEME, gradient: { ...DEFAULT_THEME.gradient } } }),
  saveTheme: async () => {
    const { theme } = get()
    try {
      const store = await load(STORE_FILE)
      await store.set(THEME_KEY, theme)
      await store.save()
    } catch (err) {
      console.warn('保存主题设置失败（非 Tauri 环境）', err)
      localStorage.setItem(THEME_KEY, JSON.stringify(theme))
    }
  },
  replaceTheme: (theme) => set({ theme: { ...theme, gradient: { ...theme.gradient } } }),
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
      const thresholds = await store.get<Partial<MonitorThresholds>>(MONITOR_THRESHOLDS_KEY)
      if (saved && !isLegacyTheme(saved)) {
        set({ theme: { ...get().theme, ...saved, gradient: { ...get().theme.gradient, ...saved.gradient } } })
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
          const parsed: unknown = JSON.parse(saved)
          if (!isLegacyTheme(parsed)) {
            const legacy = parsed as ThemeConfig
            set({
              theme: {
                ...get().theme,
                ...legacy,
                gradient: { ...get().theme.gradient, ...(legacy.gradient ?? {}) }
              }
            })
          }
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