import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Icon, IconName } from './components/Icon'
import { Modal } from './components/Modal'
import { FeedbackHost } from './components/Feedback'
import { confirmDialog, showToast } from './store/ui'
import { useSettings } from './store/settings'
import { useSessions } from './store/sessions'
import { useHosts } from './store/hosts'
import { useSessionRestore } from './store/sessionRestore'
import { connectHostQuick } from './store/hostConnect'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { CommandPalette } from './components/CommandPalette'
import { PaletteCommand } from './utils/commandPalette'
import { HostProfile } from './types/host'
import { useVault } from './store/vault'
import { useSnippets } from './store/snippets'
import { useAudit } from './store/audit'
import { knownHostsSetMode, traySetActiveCount } from './api/ssh'
import { useT } from './i18n'
import { accentContrastOf, resolveMode, withModeBackgrounds } from './types/theme'
import './styles/glass.css'
import './App.css'

// 视图按需加载：每个视图单独成 chunk，首屏只下载当前视图用到的代码。
// 会话页带着 xterm（约 480 KB）、设置页带着更新与进程插件，
// 懒加载后这些都要等真正打开对应页面时才取。
const HomeView = lazy(() => import('./views/HomeView').then((m) => ({ default: m.HomeView })))
const SessionsView = lazy(() =>
  import('./views/sessions/SessionsView').then((m) => ({ default: m.SessionsView }))
)
const HostsView = lazy(() => import('./views/HostsView').then((m) => ({ default: m.HostsView })))
const ForwardView = lazy(() => import('./views/ForwardView').then((m) => ({ default: m.ForwardView })))
const SettingsView = lazy(() =>
  import('./views/SettingsView').then((m) => ({ default: m.SettingsView }))
)

type ViewId = 'home' | 'sessions' | 'hosts' | 'forward' | 'settings'

export type { ViewId }

const NAV_ITEMS: { id: ViewId; icon: IconName; labelKey: string; fallback: string }[] = [
  { id: 'home', icon: 'home', labelKey: 'nav.home', fallback: '概览' },
  { id: 'sessions', icon: 'terminal', labelKey: 'nav.sessions', fallback: '会话' },
  { id: 'hosts', icon: 'server', labelKey: 'nav.hosts', fallback: '主机' },
  { id: 'forward', icon: 'link', labelKey: 'nav.forward', fallback: '转发' },
  { id: 'settings', icon: 'settings', labelKey: 'nav.settings', fallback: '设置' }
]

const LAST_VIEW_IDS: ViewId[] = ['home', 'sessions', 'hosts', 'forward', 'settings']

function App() {
  const { theme, init } = useSettings()
  const sidebarCollapsed = useSettings((s) => s.sidebarCollapsed)
  const toggleSidebar = useSettings((s) => s.toggleSidebar)
  const settingsReady = useSettings((s) => s.ready)
  const lastView = useSettings((s) => s.lastView)
  const knownHostsMode = useSettings((s) => s.knownHostsMode)
  const sessionsInit = useSessions((s) => s.init)
  const hostsInit = useHosts((s) => s.init)
  const vaultInit = useVault((s) => s.init)
  const snippetsInit = useSnippets((s) => s.init)
  const auditInit = useAudit((s) => s.init)
  const sessionCount = useSessions((s) => s.order.length)
  const connectedCount = useSessions((s) =>
    s.order.filter((id) => {
      const status = s.sessions[id]?.status
      return status === 'connected' || status === 'connecting' || status === 'reconnecting'
    }).length
  )
  const hostKeyPrompt = useSessions((s) => s.hostKeyPrompt)
  const confirmHostKey = useSessions((s) => s.confirmHostKey)
  const hostKeyWarning = useSessions((s) => s.hostKeyWarning)
  const clearHostKeyWarning = () => useSessions.setState({ hostKeyWarning: null })
  const kbiPrompt = useSessions((s) => s.kbiPrompts[0] ?? null)
  const kbiQueueLength = useSessions((s) => s.kbiPrompts.length)
  const answerKbi = useSessions((s) => s.answerKbi)
  const cancelKbi = useSessions((s) => s.cancelKbi)
  const translate = useT()
  const t = translate
  const [view, setView] = useState<ViewId>('home')
  const [kbiValues, setKbiValues] = useState<string[]>([])
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const hostProfiles = useHosts((s) => s.hosts)

  // 新一轮弹窗到达时清空上一轮的应答，避免陈旧凭据被静默重提
  useEffect(() => {
    setKbiValues([])
  }, [kbiPrompt])

  useEffect(() => {
    void init()
    void sessionsInit()
    void hostsInit()
    void vaultInit()
    void snippetsInit()
    void auditInit()
    void useSessionRestore.getState().init()
  }, [init, sessionsInit, hostsInit, vaultInit, snippetsInit, auditInit])

  // 设置读取完成后再恢复上次视图；恢复完成前不持久化，避免默认视图覆盖记录
  const restoredRef = useRef(false)
  useEffect(() => {
    if (!settingsReady) return
    if (LAST_VIEW_IDS.includes(lastView as ViewId)) setView(lastView as ViewId)
    if (knownHostsMode === 'appdata' && '__TAURI_INTERNALS__' in window) {
      void knownHostsSetMode('appdata').catch(() => undefined)
    }
    restoredRef.current = true
  }, [settingsReady])

  useEffect(() => {
    if (!restoredRef.current) return
    void useSettings.getState().setLastView(view)
  }, [view])

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    void traySetActiveCount(connectedCount).catch(() => undefined)
  }, [connectedCount])

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let disposed = false
    let unlisten: (() => void) | null = null
    const appWindow = getCurrentWindow()
    void appWindow
      .onCloseRequested(async (event) => {
        if (useSettings.getState().closeToTray) {
          event.preventDefault()
          await appWindow.hide()
          return
        }
        const { sessions } = useSessions.getState()
        const activeCount = Object.values(sessions).filter(
          (session) => session.status === 'connected' || session.status === 'connecting' || session.status === 'reconnecting'
        ).length
        if (!activeCount) return
        event.preventDefault()
        const accepted = await confirmDialog({
          title: t('退出 CatShell'),
          message: t('当前有 ') + activeCount + t(' 个活动 SSH 会话，退出将断开这些连接。确定要退出吗？'),
          confirmLabel: t('退出并断开'),
          danger: true
        })
        if (accepted) await appWindow.destroy()
      })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return
      const target = event.target as HTMLElement | null
      const targetClass = typeof target?.className === 'string' ? target.className : ''
      const inXtermTextarea = targetClass.includes('xterm-helper-textarea')
      const editable =
        !inXtermTextarea &&
        Boolean(
          target &&
            (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        )
      const state = useSessions.getState()
      const key = event.key.toLowerCase()

      // Ctrl+K 命令面板与 Ctrl+/ 速查面板：任何焦点下都可用，再按一次关闭
      if (key === 'k' && !event.shiftKey) {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (key === '/') {
        event.preventDefault()
        setShortcutsOpen((open) => !open)
        return
      }

      // 终端内搜索：Ctrl+F / Ctrl+Shift+F（终端聚焦时由 TerminalPane 拦截，此处覆盖焦点在外的场景）
      if (key === 'f') {
        if (view !== 'sessions' || state.activeId === null || editable) return
        event.preventDefault()
        state.terminals[state.activeId]?.openSearch?.()
        return
      }
      // Ctrl+Shift+Tab 与 Ctrl+Tab 都循环切换标签
      if (key === 'tab') {
        if (!state.order.length) return
        event.preventDefault()
        const index = state.order.indexOf(state.activeId ?? -1)
        const total = state.order.length
        const next = event.shiftKey
          ? state.order[(index - 1 + total) % total]
          : state.order[(index + 1) % total]
        if (next === undefined) return
        state.setActive(next)
        if (view !== 'sessions') setView('sessions')
        return
      }
      if (/^[1-9]$/.test(key)) {
        const id = state.order[Number(key) - 1]
        if (id === undefined) return
        event.preventDefault()
        state.setActive(id)
        if (view !== 'sessions') setView('sessions')
        return
      }
      // Ctrl+W / Ctrl+Shift+W 关闭当前会话标签。
      // 活动连接属于破坏性操作：Ctrl+W 先确认，Ctrl+Shift+W 视为明确意图直接执行。
      if (key === 'w') {
        if (editable || view !== 'sessions' || state.activeId === null) return
        event.preventDefault()
        const id = state.activeId
        const info = state.sessions[id]
        const live =
          info !== undefined &&
          (info.status === 'connected' ||
            info.status === 'connecting' ||
            info.status === 'reconnecting')
        void (async () => {
          if (live && !event.shiftKey) {
            const accepted = await confirmDialog({
              title: t('关闭会话'),
              message: `${t('会话')}「${info.name}」${t('仍在连接中，关闭标签会立即断开该连接。')}`,
              confirmLabel: t('断开并关闭'),
              cancelLabel: t('取消'),
              danger: true
            })
            if (!accepted) return
          }
          if (live) {
            void state.disconnect(id)
          }
          void state.closeTab(id)
        })()
        return
      }
      if (event.shiftKey) return
      if (key === 't') {
        if (editable) return
        event.preventDefault()
        setView('hosts')
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [view])

  const sessionOrder = useSessions((s) => s.order)
  const sessionInfos = useSessions((s) => s.sessions)

  // 命令面板清单：视图 → 快捷动作 → 主机 → 已开会话。过滤逻辑见 utils/commandPalette.ts。
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const items: PaletteCommand[] = NAV_ITEMS.map((item) => ({
      id: `view:${item.id}`,
      label: translate(item.labelKey) || item.fallback,
      icon: item.icon,
      keywords: `view ${item.id}`
    }))
    items.push({ id: 'action:new-session', label: t('新建会话'), icon: 'plus', keywords: 'connect ssh new' })
    items.push({ id: 'action:shortcuts', label: t('快捷键速查'), icon: 'keyboard', keywords: 'shortcut keys help' })
    for (const host of hostProfiles) {
      items.push({
        id: `host:${host.id}`,
        label: host.name || `${host.username}@${host.host}`,
        hint: `${host.host}:${host.port}`,
        icon: 'server',
        keywords: 'host connect ssh'
      })
    }
    for (const id of sessionOrder) {
      const info = sessionInfos[id]
      if (!info) continue
      items.push({
        id: `session:${id}`,
        label: info.name || `${info.username}@${info.host}`,
        hint: t('切换到该标签'),
        icon: 'terminal',
        keywords: 'session tab switch'
      })
    }
    return items
  }, [hostProfiles, sessionInfos, sessionOrder, t, translate])

  const runPaletteCommand = (command: PaletteCommand) => {
    if (command.id.startsWith('view:')) {
      setView(command.id.slice(5) as ViewId)
      return
    }
    if (command.id === 'action:new-session') {
      setView('hosts')
      return
    }
    if (command.id === 'action:shortcuts') {
      setShortcutsOpen(true)
      return
    }
    if (command.id.startsWith('host:')) {
      const hostId = command.id.slice(5)
      const host: HostProfile | undefined = useHosts
        .getState()
        .hosts.find((item) => item.id === hostId)
      if (!host) return
      void connectHostQuick(host).then((result) => {
        if (result === 'connected') {
          setView('sessions')
          return
        }
        setView('hosts')
        showToast(t('该主机需要补充凭据，请在主机页连接'), 'warning')
      })
      return
    }
    if (command.id.startsWith('session:')) {
      const id = Number(command.id.slice(8))
      if (!Number.isInteger(id)) return
      useSessions.getState().setActive(id)
      setView('sessions')
    }
  }

  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--bg-opacity', String(theme.bgOpacity))
    root.setProperty('--glass-blur', `${theme.blurRadius}px`)
    root.setProperty('--glass-radius', `${theme.borderRadius}px`)
    root.setProperty('--border-opacity', String(theme.borderOpacity))
    root.setProperty('--accent', theme.accentColor)
    root.setProperty('--accent-contrast', accentContrastOf(theme.accentColor))

    const applyMode = () => {
      const effective = resolveMode(theme.mode)
      document.documentElement.dataset.mode = effective
      return effective
    }
    const resolved = applyMode()

    let media: MediaQueryList | null = null
    let listener: (() => void) | null = null
    if (theme.mode === 'auto') {
      media = window.matchMedia('(prefers-color-scheme: light)')
      listener = () => {
        const effective = resolveMode(theme.mode)
        document.documentElement.dataset.mode = effective
        paintBackground(effective)
      }
      media.addEventListener('change', listener)
    }

    const paintBackground = (effective: 'light' | 'dark') => {
      const bgTheme = withModeBackgrounds(theme, effective)
      const bg = document.getElementById('app-bg')
      if (!bg) return
      if (bgTheme.backgroundType === 'gradient') {
        bg.classList.remove('has-image')
        bg.style.backgroundImage = `linear-gradient(${bgTheme.gradient.angle}deg, ${bgTheme.gradient.from}, ${bgTheme.gradient.to})`
      } else if (bgTheme.backgroundType === 'solid') {
        bg.classList.remove('has-image')
        bg.style.background = bgTheme.solidColor
      } else {
        bg.classList.add('has-image')
        bg.style.background = 'none'
        if (bgTheme.backgroundImage) {
          bg.style.setProperty('--app-bg-image', `url("${bgTheme.backgroundImage}")`)
        }
      }
    }
    paintBackground(resolved)

    return () => {
      if (media && listener) media.removeEventListener('change', listener)
    }
  }, [theme])

  return (
    <div className="app-shell">
      <div id="app-bg" />
      <aside className={`sidebar glass ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-brand" title="CatShell">
          <div className="sidebar-logo">
            <Icon name="terminal" size={21} />
          </div>
          <div className="sidebar-brand-copy">
            <strong>CatShell</strong>
            <span>SSH OPS</span>
          </div>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => {
            const label = translate(item.labelKey) || item.fallback
            return (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? 'active' : ''}`}
                onClick={() => setView(item.id)}
                title={label}
              >
                <Icon name={item.icon} size={22} />
                <span className="nav-label">{label}</span>
                {item.id === 'sessions' && sessionCount > 0 && (
                  <span className="nav-badge">{sessionCount}</span>
                )}
              </button>
            )
          })}
        </nav>
        <button
          className="glass-btn sidebar-toggle"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? t('展开侧栏') : t('收起侧栏')}
        >
          <span className="sidebar-toggle-icon">
            <Icon name="chevron-down" size={16} />
          </span>
          <span className="nav-label">{sidebarCollapsed ? t('展开侧栏') : t('收起侧栏')}</span>
        </button>
      </aside>
      <main className="main-area">
        {/* fallback 只在首次进入某视图、chunk 尚未就绪时短暂出现；
            放在 main 内部，切换时侧边栏与背景不会跟着闪。 */}
        <Suspense fallback={<div className="view-loading">{t('加载界面中…')}</div>}>
          {view === 'home' && (
            <HomeView onOpenHosts={() => setView('hosts')} onOpenSessions={() => setView('sessions')} />
          )}
          {view === 'sessions' && <SessionsView />}
          {view === 'hosts' && <HostsView onOpenSessions={() => setView('sessions')} />}
          {view === 'forward' && <ForwardView />}
          {view === 'settings' && <SettingsView />}
        </Suspense>
      </main>
      {hostKeyPrompt && (
        <Modal
          className="host-key-modal"
          ariaLabel={t('首次连接需要确认主机指纹')}
          closeOnOverlayClick={false}
          /* Escape 视为拒绝：指纹未确认时绝不默认放行 */
          onClose={() => void confirmHostKey(false)}
        >
            <header className="modal-header">
            <div className="modal-title">
              <Icon name="key" size={18} />
              {t('首次连接需要确认主机指纹')}
            </div>
          </header>
          <div className="modal-body">
            <p className="host-key-warning">
              {t('这是第一次连接此服务器。只有确认指纹与服务器管理员提供的值一致时才继续。')}
            </p>
            <div className="host-key-target">{hostKeyPrompt.host}:{hostKeyPrompt.port}</div>
            <code className="host-key-fingerprint">{hostKeyPrompt.fingerprint}</code>
          </div>
          <footer className="modal-footer">
            <button className="glass-btn" onClick={() => void confirmHostKey(false)}>{t('拒绝连接')}</button>
            <button className="glass-btn primary" onClick={() => void confirmHostKey(true)}>
              <Icon name="key" size={15} />
              {t('信任并继续')}
            </button>
          </footer>
        </Modal>
      )}
      {hostKeyWarning && (
        <Modal
          role="alertdialog"
          className="host-key-modal"
          ariaLabel={t('主机指纹发生变化')}
          closeOnOverlayClick={false}
          onClose={clearHostKeyWarning}
        >
            <header className="modal-header">
            <div className="modal-title host-key-danger">
              <Icon name="key" size={18} />
              {t('主机指纹发生变化')}
            </div>
          </header>
          <div className="modal-body">
            <p className="host-key-danger-copy">
              {t('为防止中间人攻击，连接已被阻止。请与服务器管理员核对新指纹，不要直接忽略此警告。')}
            </p>
            <div className="host-key-target">{hostKeyWarning.host}:{hostKeyWarning.port}</div>
            <code className="host-key-fingerprint">{hostKeyWarning.fingerprint}</code>
          </div>
          <footer className="modal-footer">
            <button className="glass-btn" onClick={clearHostKeyWarning}>{t('关闭')}</button>
          </footer>
        </Modal>
      )}
      {kbiPrompt && (
        <Modal
          className="host-key-modal"
          ariaLabel={kbiPrompt.name || t('服务器要求交互式验证')}
          closeOnOverlayClick={false}
          onClose={() => {
            setKbiValues([])
            cancelKbi()
          }}
        >
            <header className="modal-header">
              <div className="modal-title">
                <Icon name="key" size={18} />
                {kbiPrompt.name || t('服务器要求交互式验证')}
                {kbiQueueLength > 1 && <span className="nav-badge">{kbiQueueLength - 1}</span>}
              </div>
            </header>
            <div className="modal-body">
              {kbiPrompt.instructions && <p className="section-tip">{kbiPrompt.instructions}</p>}
              {kbiPrompt.prompts.map((question, index) => (
                <label className="field span-2" key={`${kbiPrompt.sessionId}-${index}`}>
                  <span className="field-label">{question.prompt || t('提示 ') + (index + 1)}</span>
                  <input
                    className="glass-input"
                    type={question.echo ? 'text' : 'password'}
                    autoComplete={question.echo ? 'off' : 'one-time-code'}
                    value={kbiValues[index] ?? ''}
                    onChange={(e) =>
                      setKbiValues((values) => {
                        const next = [...values]
                        next[index] = e.target.value
                        return next
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        void answerKbi(kbiPrompt.prompts.map((_, i) => kbiValues[i] ?? ''))
                        setKbiValues([])
                      }
                    }}
                    autoFocus
                  />
                </label>
              ))}
            </div>
            <footer className="modal-footer">
              <button className="glass-btn" onClick={() => { setKbiValues([]); cancelKbi() }}>{t('取消')}</button>
              <button
                className="glass-btn primary"
                onClick={() => {
                  void answerKbi(kbiPrompt.prompts.map((_, i) => kbiValues[i] ?? ''))
                  setKbiValues([])
                }}
              >
                <Icon name="key" size={15} />
                {t('提交')}
              </button>
            </footer>
        </Modal>
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          onRun={runPaletteCommand}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      <FeedbackHost />
    </div>
  )
}

export default App
