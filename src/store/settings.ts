import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { ThemeConfig, DEFAULT_THEME, withModeBackgrounds } from '../types/theme'

const STORE_FILE = 'app-settings.json'
const THEME_KEY = 'theme'
const MONITOR_THRESHOLDS_KEY = 'monitorThresholds'
const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed'
const VAULT_AUTO_LOCK_KEY = 'vaultAutoLockMinutes'
const TERMINAL_KEY = 'terminal'
const MONITOR_INTERVAL_KEY = 'monitorIntervalSeconds'

export const VAULT_AUTO_LOCK_OPTIONS = [0, 5, 15, 30]
export const DEFAULT_VAULT_AUTO_LOCK_MINUTES = 15

let initializationPromise: Promise<void> | null = null

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

export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  scrollback: number
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
  fontSize: 13,
  scrollback: 8000
}

export const MONITOR_INTERVAL_OPTIONS = [5, 10, 30, 60]
export const DEFAULT_MONITOR_INTERVAL_SECONDS = 10

function normalizeTerminalSettings(value: Partial<TerminalSettings> | null | undefined): TerminalSettings {
  return {
    fontFamily: typeof value?.fontFamily === 'string' && value.fontFamily.trim() ? value.fontFamily : DEFAULT_TERMINAL_SETTINGS.fontFamily,
    fontSize: Number.isFinite(value?.fontSize) ? Math.min(24, Math.max(8, Math.round(Number(value?.fontSize)))) : DEFAULT_TERMINAL_SETTINGS.fontSize,
    scrollback: Number.isFinite(value?.scrollback) ? Math.min(50000, Math.max(500, Math.round(Number(value?.scrollback)))) : DEFAULT_TERMINAL_SETTINGS.scrollback
  }
}

interface SettingsState {
  theme: ThemeConfig
  monitorThresholds: MonitorThresholds
  sidebarCollapsed: boolean
  vaultAutoLockMinutes: number
  terminal: TerminalSettings
  monitorIntervalSeconds: number
  ready: boolean
  setTheme: (patch: Partial<ThemeConfig>) => void
  setAppearanceMode: (mode: ThemeConfig['mode']) => void
  resetTheme: () => void
  saveTheme: () => Promise<void>
  replaceTheme: (theme: ThemeConfig) => void
  setMonitorThresholds: (patch: Partial<MonitorThresholds>) => void
  saveMonitorThresholds: () => Promise<void>
  toggleSidebar: () => void
  setVaultAutoLockMinutes: (minutes: number) => void
  saveVaultAutoLockMinutes: () => Promise<void>
  setTerminal: (patch: Partial<TerminalSettings>) => void
  saveTerminal: () => Promise<void>
  setMonitorIntervalSeconds: (seconds: number) => void
  saveMonitorIntervalSeconds: () => Promise<void>
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
  sidebarCollapsed: false,
  vaultAutoLockMinutes: DEFAULT_VAULT_AUTO_LOCK_MINUTES,
  terminal: { ...DEFAULT_TERMINAL_SETTINGS },
  monitorIntervalSeconds: DEFAULT_MONITOR_INTERVAL_SECONDS,
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
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed
    set({ sidebarCollapsed: next })
    void (async () => {
      try {
        const store = await load(STORE_FILE)
        await store.set(SIDEBAR_COLLAPSED_KEY, next)
        await store.save()
      } catch {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(next))
      }
    })()
  },
  setVaultAutoLockMinutes: (minutes) =>
    set({ vaultAutoLockMinutes: VAULT_AUTO_LOCK_OPTIONS.includes(minutes) ? minutes : DEFAULT_VAULT_AUTO_LOCK_MINUTES }),
  saveVaultAutoLockMinutes: async () => {
    const minutes = get().vaultAutoLockMinutes
    try {
      const store = await load(STORE_FILE)
      await store.set(VAULT_AUTO_LOCK_KEY, minutes)
      await store.save()
    } catch {
      localStorage.setItem(VAULT_AUTO_LOCK_KEY, JSON.stringify(minutes))
    }
  },
  setTerminal: (patch) =>
    set((state) => ({ terminal: normalizeTerminalSettings({ ...state.terminal, ...patch }) })),
  saveTerminal: async () => {
    const terminal = get().terminal
    try {
      const store = await load(STORE_FILE)
      await store.set(TERMINAL_KEY, terminal)
      await store.save()
    } catch {
      localStorage.setItem(TERMINAL_KEY, JSON.stringify(terminal))
    }
  },
  setMonitorIntervalSeconds: (seconds) =>
    set({ monitorIntervalSeconds: MONITOR_INTERVAL_OPTIONS.includes(seconds) ? seconds : DEFAULT_MONITOR_INTERVAL_SECONDS }),
  saveMonitorIntervalSeconds: async () => {
    const seconds = get().monitorIntervalSeconds
    try {
      const store = await load(STORE_FILE)
      await store.set(MONITOR_INTERVAL_KEY, seconds)
      await store.save()
    } catch {
      localStorage.setItem(MONITOR_INTERVAL_KEY, JSON.stringify(seconds))
    }
  },
  init: async () => {
    if (get().ready) return
    if (initializationPromise) return initializationPromise

    // React Strict Mode can invoke the startup effect twice before the first
    // asynchronous initialization completes. Share that initialization promise
    // so settings are read exactly once.
    initializationPromise = (async () => {
      try {
        const store = await load(STORE_FILE)
      const saved = await store.get<ThemeConfig>(THEME_KEY)
      const thresholds = await store.get<Partial<MonitorThresholds>>(MONITOR_THRESHOLDS_KEY)
      const sidebarCollapsed = await store.get<boolean>(SIDEBAR_COLLAPSED_KEY)
      const vaultAutoLockMinutes = await store.get<number>(VAULT_AUTO_LOCK_KEY)
      const savedTerminal = await store.get<Partial<TerminalSettings>>(TERMINAL_KEY)
      const savedInterval = await store.get<number>(MONITOR_INTERVAL_KEY)
      if (saved && !isLegacyTheme(saved)) {
        set({ theme: { ...get().theme, ...saved, gradient: { ...get().theme.gradient, ...saved.gradient } } })
      }
      if (thresholds) {
        set({ monitorThresholds: { ...DEFAULT_MONITOR_THRESHOLDS, ...thresholds } })
      }
      if (typeof sidebarCollapsed === 'boolean') {
        set({ sidebarCollapsed })
      }
      if (typeof vaultAutoLockMinutes === 'number' && VAULT_AUTO_LOCK_OPTIONS.includes(vaultAutoLockMinutes)) {
        set({ vaultAutoLockMinutes })
      }
      if (savedTerminal && typeof savedTerminal === 'object') {
        set({ terminal: normalizeTerminalSettings(savedTerminal) })
      }
      if (typeof savedInterval === 'number' && MONITOR_INTERVAL_OPTIONS.includes(savedInterval)) {
        set({ monitorIntervalSeconds: savedInterval })
      }
    } catch (err) {
      console.warn('读取主题设置失败，使用默认值', err)
      const saved = localStorage.getItem(THEME_KEY)
      const savedThresholds = localStorage.getItem(MONITOR_THRESHOLDS_KEY)
      const savedSidebar = localStorage.getItem(SIDEBAR_COLLAPSED_KEY)
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
      if (savedSidebar) {
        try {
          const parsed: unknown = JSON.parse(savedSidebar)
          if (typeof parsed === 'boolean') set({ sidebarCollapsed: parsed })
        } catch {
          /* ignore corrupt stored sidebar state */
        }
      }
      const savedVaultAutoLock = localStorage.getItem(VAULT_AUTO_LOCK_KEY)
      if (savedVaultAutoLock) {
        try {
          const parsed: unknown = JSON.parse(savedVaultAutoLock)
          if (typeof parsed === 'number' && VAULT_AUTO_LOCK_OPTIONS.includes(parsed)) {
            set({ vaultAutoLockMinutes: parsed })
          }
        } catch {
          /* ignore corrupt stored vault auto lock */
        }
      }
      const savedTerminalRaw = localStorage.getItem(TERMINAL_KEY)
      if (savedTerminalRaw) {
        try {
          const parsed: unknown = JSON.parse(savedTerminalRaw)
          if (parsed && typeof parsed === 'object') {
            set({ terminal: normalizeTerminalSettings(parsed as Partial<TerminalSettings>) })
          }
        } catch {
          /* ignore corrupt stored terminal settings */
        }
      }
      const savedIntervalRaw = localStorage.getItem(MONITOR_INTERVAL_KEY)
      if (savedIntervalRaw) {
        try {
          const parsed: unknown = JSON.parse(savedIntervalRaw)
          if (typeof parsed === 'number' && MONITOR_INTERVAL_OPTIONS.includes(parsed)) {
            set({ monitorIntervalSeconds: parsed })
          }
        } catch {
          /* ignore corrupt stored monitor interval */
        }
      }
    } finally {
      set({ ready: true })
    }
    })()

    try {
      await initializationPromise
    } finally {
      initializationPromise = null
    }
  }
}))