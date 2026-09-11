import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { ThemeConfig, DEFAULT_THEME, withModeBackgrounds } from '../types/theme'
import { logger } from '../utils/logger'
import { aiKeyLoad, aiKeySave } from '../api/ai'

const STORE_FILE = 'app-settings.json'
const THEME_KEY = 'theme'
const MONITOR_THRESHOLDS_KEY = 'monitorThresholds'
const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed'
const VAULT_AUTO_LOCK_KEY = 'vaultAutoLockMinutes'
const VAULT_BLUR_LOCK_KEY = 'vaultBlurLock'
const KNOWN_HOSTS_MODE_KEY = 'knownHostsMode'
const TERMINAL_KEY = 'terminal'
const MONITOR_INTERVAL_KEY = 'monitorIntervalSeconds'
const SESSION_PANELS_KEY = 'sessionPanelsCollapsed'
const LAST_VIEW_KEY = 'lastView'
const CLOSE_TO_TRAY_KEY = 'closeToTray'
const LANGUAGE_KEY = 'language'
const AI_KEY = 'ai'

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

export interface AiSettings {
  /** OpenAI 兼容接口基础地址（不含 /chat/completions） */
  endpoint: string
  /** 接口密钥；仅存内存，持久化经系统凭据管理器（审计 S-2），app-settings.json 永远写空串 */
  apiKey: string
  model: string
  /** 终端高危命令确认开关（本地规则，与 AI 接口无关） */
  riskGuard: boolean
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  endpoint: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  riskGuard: true
}

function normalizeAiSettings(value: Partial<AiSettings> | null | undefined): AiSettings {
  return {
    endpoint: typeof value?.endpoint === 'string' && value.endpoint.trim() ? value.endpoint.trim() : DEFAULT_AI_SETTINGS.endpoint,
    apiKey: typeof value?.apiKey === 'string' ? value.apiKey : DEFAULT_AI_SETTINGS.apiKey,
    model: typeof value?.model === 'string' && value.model.trim() ? value.model.trim() : DEFAULT_AI_SETTINGS.model,
    riskGuard: value?.riskGuard !== false
  }
}

export type Language = 'zh-CN' | 'en-US'
export const LANGUAGE_OPTIONS: Language[] = ['zh-CN', 'en-US']
export const DEFAULT_LANGUAGE: Language = 'zh-CN'

export interface SessionPanelState {
  monitorCollapsed: boolean
  sftpCollapsed: boolean
}

export const DEFAULT_SESSION_PANELS: SessionPanelState = {
  monitorCollapsed: false,
  sftpCollapsed: false
}

function normalizeSessionPanels(value: Partial<SessionPanelState> | null | undefined): SessionPanelState {
  return {
    monitorCollapsed: value?.monitorCollapsed === true,
    sftpCollapsed: value?.sftpCollapsed === true
  }
}

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
  vaultBlurLock: boolean
  knownHostsMode: 'openssh' | 'appdata'
  terminal: TerminalSettings
  monitorIntervalSeconds: number
  sessionPanels: SessionPanelState
  lastView: string | null
  closeToTray: boolean
  language: Language
  ai: AiSettings
  ready: boolean
  setAi: (patch: Partial<AiSettings>) => void
  saveAi: () => Promise<void>
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
  setVaultBlurLock: (enabled: boolean) => void
  saveVaultBlurLock: () => Promise<void>
  setKnownHostsMode: (mode: 'openssh' | 'appdata') => void
  saveKnownHostsMode: () => Promise<void>
  setTerminal: (patch: Partial<TerminalSettings>) => void
  saveTerminal: () => Promise<void>
  setMonitorIntervalSeconds: (seconds: number) => void
  saveMonitorIntervalSeconds: () => Promise<void>
  setSessionPanelCollapsed: (panel: 'monitor' | 'sftp', collapsed: boolean) => Promise<void>
  setLastView: (view: string) => void
  setCloseToTray: (enabled: boolean) => void
  saveCloseToTray: () => Promise<void>
  setLanguage: (language: Language) => void
  saveLanguage: () => Promise<void>
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
  vaultBlurLock: false,
  knownHostsMode: 'openssh',
  terminal: { ...DEFAULT_TERMINAL_SETTINGS },
  monitorIntervalSeconds: DEFAULT_MONITOR_INTERVAL_SECONDS,
  sessionPanels: { ...DEFAULT_SESSION_PANELS },
  lastView: null,
  closeToTray: true,
  language: DEFAULT_LANGUAGE,
  ai: { ...DEFAULT_AI_SETTINGS },
  ready: false,
  setAi: (patch) => set((state) => ({ ai: { ...state.ai, ...patch } })),
  saveAi: async () => {
    const ai = get().ai
    // apiKey 只进系统凭据管理器（审计 S-2），app-settings.json / localStorage 一律写空。
    const persistable = { ...ai, apiKey: '' }
    try {
      const store = await load(STORE_FILE)
      await store.set(AI_KEY, persistable)
      await store.save()
    } catch {
      localStorage.setItem(AI_KEY, JSON.stringify(persistable))
    }
    try {
      await aiKeySave(ai.apiKey)
    } catch (err) {
      logger.warn('保存 AI 密钥到系统凭据管理器失败', err)
    }
  },
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
      logger.warn('保存主题设置失败（非 Tauri 环境）', err)
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
  setVaultBlurLock: (enabled) => set({ vaultBlurLock: enabled }),
  saveVaultBlurLock: async () => {
    const enabled = get().vaultBlurLock
    try {
      const store = await load(STORE_FILE)
      await store.set(VAULT_BLUR_LOCK_KEY, enabled)
      await store.save()
    } catch {
      localStorage.setItem(VAULT_BLUR_LOCK_KEY, JSON.stringify(enabled))
    }
  },
  setKnownHostsMode: (mode) => set({ knownHostsMode: mode === 'appdata' ? 'appdata' : 'openssh' }),
  saveKnownHostsMode: async () => {
    const mode = get().knownHostsMode
    try {
      const store = await load(STORE_FILE)
      await store.set(KNOWN_HOSTS_MODE_KEY, mode)
      await store.save()
    } catch {
      localStorage.setItem(KNOWN_HOSTS_MODE_KEY, JSON.stringify(mode))
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
  setSessionPanelCollapsed: (panel, collapsed) => {
    const current = get().sessionPanels
    const next: SessionPanelState = { ...current, [`${panel}Collapsed`]: collapsed }
    set({ sessionPanels: next })
    return (async () => {
      try {
        const store = await load(STORE_FILE)
        await store.set(SESSION_PANELS_KEY, next)
        await store.save()
      } catch {
        localStorage.setItem(SESSION_PANELS_KEY, JSON.stringify(next))
      }
    })()
  },
  setLastView: (view) => {
    set({ lastView: view })
    void (async () => {
      try {
        const store = await load(STORE_FILE)
        await store.set(LAST_VIEW_KEY, view)
        await store.save()
      } catch {
        localStorage.setItem(LAST_VIEW_KEY, JSON.stringify(view))
      }
    })()
  },
  setCloseToTray: (enabled) => set({ closeToTray: enabled }),
  saveCloseToTray: async () => {
    const enabled = get().closeToTray
    try {
      const store = await load(STORE_FILE)
      await store.set(CLOSE_TO_TRAY_KEY, enabled)
      await store.save()
    } catch {
      localStorage.setItem(CLOSE_TO_TRAY_KEY, JSON.stringify(enabled))
    }
  },
  setLanguage: (language) => set({ language: LANGUAGE_OPTIONS.includes(language) ? language : DEFAULT_LANGUAGE }),
  saveLanguage: async () => {
    const language = get().language
    try {
      const store = await load(STORE_FILE)
      await store.set(LANGUAGE_KEY, language)
      await store.save()
    } catch {
      localStorage.setItem(LANGUAGE_KEY, JSON.stringify(language))
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
      const vaultBlurLock = await store.get<boolean>(VAULT_BLUR_LOCK_KEY)
      const knownHostsMode = await store.get<'openssh' | 'appdata'>(KNOWN_HOSTS_MODE_KEY)
      const savedTerminal = await store.get<Partial<TerminalSettings>>(TERMINAL_KEY)
      const savedInterval = await store.get<number>(MONITOR_INTERVAL_KEY)
      const savedPanels = await store.get<Partial<SessionPanelState>>(SESSION_PANELS_KEY)
      const savedLastView = await store.get<string>(LAST_VIEW_KEY)
      const savedCloseToTray = await store.get<boolean>(CLOSE_TO_TRAY_KEY)
      const savedLanguage = await store.get<Language>(LANGUAGE_KEY)
      const savedAi = await store.get<Partial<AiSettings>>(AI_KEY)
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
      if (typeof vaultBlurLock === 'boolean') {
        set({ vaultBlurLock })
      }
      if (knownHostsMode === 'openssh' || knownHostsMode === 'appdata') {
        set({ knownHostsMode })
      }
      if (savedTerminal && typeof savedTerminal === 'object') {
        set({ terminal: normalizeTerminalSettings(savedTerminal) })
      }
      if (typeof savedInterval === 'number' && MONITOR_INTERVAL_OPTIONS.includes(savedInterval)) {
        set({ monitorIntervalSeconds: savedInterval })
      }
      if (savedAi && typeof savedAi === 'object') {
        set({ ai: normalizeAiSettings(savedAi) })
        // 旧版本曾把 apiKey 明文写进 app-settings.json（审计 S-2）：
        // 迁移到系统凭据管理器后立刻重写持久化，把磁盘上的明文抹掉。
        const legacyKey = get().ai.apiKey
        if (legacyKey) void get().saveAi()
      }
      if (savedPanels && typeof savedPanels === 'object') {
        set({ sessionPanels: normalizeSessionPanels(savedPanels) })
      }
      if (typeof savedLastView === 'string' && savedLastView) {
        set({ lastView: savedLastView })
      }
      if (typeof savedCloseToTray === 'boolean') {
        set({ closeToTray: savedCloseToTray })
      }
      if (savedLanguage === 'zh-CN' || savedLanguage === 'en-US') {
        set({ language: savedLanguage })
      }
    } catch (err) {
      logger.warn('读取主题设置失败，使用默认值', err)
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
          // JSON.parse 返回 any，断言成 Partial 后展开；备份恢复路径另有 isMonitorThresholds 校验
          const parsed = JSON.parse(savedThresholds) as Partial<MonitorThresholds>
          set({ monitorThresholds: { ...DEFAULT_MONITOR_THRESHOLDS, ...parsed } })
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
      const savedVaultBlurLock = localStorage.getItem(VAULT_BLUR_LOCK_KEY)
      if (savedVaultBlurLock === 'true' || savedVaultBlurLock === 'false') {
        set({ vaultBlurLock: savedVaultBlurLock === 'true' })
      }
      const savedKnownHostsMode = localStorage.getItem(KNOWN_HOSTS_MODE_KEY)
      if (savedKnownHostsMode === 'openssh' || savedKnownHostsMode === 'appdata') {
        set({ knownHostsMode: savedKnownHostsMode })
      }
      const savedTerminalRaw = localStorage.getItem(TERMINAL_KEY)
      if (savedTerminalRaw) {
        try {
          const parsed: unknown = JSON.parse(savedTerminalRaw)
          if (parsed && typeof parsed === 'object') {
            set({ terminal: normalizeTerminalSettings(parsed) })
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
      const savedPanelsRaw = localStorage.getItem(SESSION_PANELS_KEY)
      if (savedPanelsRaw) {
        try {
          const parsed: unknown = JSON.parse(savedPanelsRaw)
          if (parsed && typeof parsed === 'object') {
            set({ sessionPanels: normalizeSessionPanels(parsed) })
          }
        } catch {
          /* ignore corrupt stored session panel state */
        }
      }
      const savedLastViewRaw = localStorage.getItem(LAST_VIEW_KEY)
      if (savedLastViewRaw) {
        try {
          const parsed: unknown = JSON.parse(savedLastViewRaw)
          if (typeof parsed === 'string' && parsed) set({ lastView: parsed })
        } catch {
          /* ignore corrupt stored last view */
        }
      }
      const savedCloseToTrayRaw = localStorage.getItem(CLOSE_TO_TRAY_KEY)
      if (savedCloseToTrayRaw === 'true' || savedCloseToTrayRaw === 'false') {
        set({ closeToTray: savedCloseToTrayRaw === 'true' })
      }
      const savedLanguageRaw = localStorage.getItem(LANGUAGE_KEY)
      if (savedLanguageRaw === 'zh-CN' || savedLanguageRaw === 'en-US') {
        set({ language: savedLanguageRaw })
      }
      // AI 设置兜底读回（审计 R-5）：saveAi 在非 Tauri 环境只写 localStorage，
      // 此前 init 没读它，导致浏览器预览模式下 AI 配置每次启动丢失。
      const savedAiRaw = localStorage.getItem(AI_KEY)
      if (savedAiRaw) {
        try {
          const parsed: unknown = JSON.parse(savedAiRaw)
          if (parsed && typeof parsed === 'object') {
            set({ ai: normalizeAiSettings(parsed) })
          }
        } catch {
          /* ignore corrupt stored AI settings */
        }
      }
    } finally {
      // apiKey 从系统凭据管理器回填内存（审计 S-2）：
      // 持久化里永远是空串，真实密钥只在启动时读进内存。非 Tauri 环境忽略失败。
      try {
        const key = await aiKeyLoad()
        if (key && !get().ai.apiKey) set({ ai: { ...get().ai, apiKey: key } })
      } catch {
        /* 非 Tauri 环境或读取失败：内存 apiKey 保持空 */
      }
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