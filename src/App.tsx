import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Icon, IconName } from './components/Icon'
import { FeedbackHost } from './components/Feedback'
import { confirmDialog } from './store/ui'
import { useSettings } from './store/settings'
import { useSessions } from './store/sessions'
import { useHosts } from './store/hosts'
import { useVault } from './store/vault'
import { useSnippets } from './store/snippets'
import { useAudit } from './store/audit'
import { HomeView } from './views/HomeView'
import { HostsView } from './views/HostsView'
import { SessionsView } from './views/sessions/SessionsView'
import { SettingsView } from './views/SettingsView'
import { ForwardView } from './views/ForwardView'
import { accentContrastOf, resolveMode, withModeBackgrounds } from './types/theme'
import './styles/glass.css'
import './App.css'

type ViewId = 'home' | 'sessions' | 'hosts' | 'forward' | 'settings'

export type { ViewId }

const NAV_ITEMS: { id: ViewId; icon: IconName; label: string }[] = [
  { id: 'home', icon: 'home', label: '概览' },
  { id: 'sessions', icon: 'terminal', label: '会话' },
  { id: 'hosts', icon: 'server', label: '主机' },
  { id: 'forward', icon: 'link', label: '转发' },
  { id: 'settings', icon: 'settings', label: '设置' }
]

function App() {
  const { theme, init } = useSettings()
  const sidebarCollapsed = useSettings((s) => s.sidebarCollapsed)
  const toggleSidebar = useSettings((s) => s.toggleSidebar)
  const sessionsInit = useSessions((s) => s.init)
  const hostsInit = useHosts((s) => s.init)
  const vaultInit = useVault((s) => s.init)
  const snippetsInit = useSnippets((s) => s.init)
  const auditInit = useAudit((s) => s.init)
  const sessionCount = useSessions((s) => s.order.length)
  const hostKeyPrompt = useSessions((s) => s.hostKeyPrompt)
  const confirmHostKey = useSessions((s) => s.confirmHostKey)
  const hostKeyWarning = useSessions((s) => s.hostKeyWarning)
  const clearHostKeyWarning = () => useSessions.setState({ hostKeyWarning: null })
  const [view, setView] = useState<ViewId>('home')

  useEffect(() => {
    init()
    void sessionsInit()
    void hostsInit()
    void vaultInit()
    void snippetsInit()
    void auditInit()
  }, [init, sessionsInit, hostsInit, vaultInit, snippetsInit, auditInit])

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let disposed = false
    let unlisten: (() => void) | null = null
    const appWindow = getCurrentWindow()
    void appWindow
      .onCloseRequested(async (event) => {
        const { sessions } = useSessions.getState()
        const activeCount = Object.values(sessions).filter(
          (session) => session.status === 'connected' || session.status === 'connecting' || session.status === 'reconnecting'
        ).length
        if (!activeCount) return
        event.preventDefault()
        const accepted = await confirmDialog({
          title: '退出 CatShell',
          message: `当前有 ${activeCount} 个活动 SSH 会话，退出将断开这些连接。确定要退出吗？`,
          confirmLabel: '退出并断开',
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
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              onClick={() => setView(item.id)}
              title={item.label}
            >
              <Icon name={item.icon} size={22} />
              <span className="nav-label">{item.label}</span>
              {item.id === 'sessions' && sessionCount > 0 && (
                <span className="nav-badge">{sessionCount}</span>
              )}
            </button>
          ))}
        </nav>
        <button
          className="glass-btn sidebar-toggle"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        >
          <span className="sidebar-toggle-icon">
            <Icon name="chevron-down" size={16} />
          </span>
          <span className="nav-label">收起侧栏</span>
        </button>
      </aside>
      <main className="main-area">
        {view === 'home' && (
          <HomeView onOpenHosts={() => setView('hosts')} onOpenSessions={() => setView('sessions')} />
        )}
        {view === 'sessions' && <SessionsView />}
        {view === 'hosts' && <HostsView onOpenSessions={() => setView('sessions')} />}
        {view === 'forward' && <ForwardView />}
        {view === 'settings' && <SettingsView />}
      </main>
      {hostKeyPrompt && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal glass host-key-modal">
            <header className="modal-header">
              <div className="modal-title">
                <Icon name="key" size={18} />
                首次连接需要确认主机指纹
              </div>
            </header>
            <div className="modal-body">
              <p className="host-key-warning">
                这是第一次连接此服务器。只有确认指纹与服务器管理员提供的值一致时才继续。
              </p>
              <div className="host-key-target">{hostKeyPrompt.host}:{hostKeyPrompt.port}</div>
              <code className="host-key-fingerprint">{hostKeyPrompt.fingerprint}</code>
            </div>
            <footer className="modal-footer">
              <button className="glass-btn" onClick={() => void confirmHostKey(false)}>拒绝连接</button>
              <button className="glass-btn primary" onClick={() => void confirmHostKey(true)}>
                <Icon name="key" size={15} />
                信任并继续
              </button>
            </footer>
          </div>
        </div>
      )}
      {hostKeyWarning && (
        <div className="modal-overlay" role="alertdialog" aria-modal="true">
          <div className="modal glass host-key-modal">
            <header className="modal-header">
              <div className="modal-title host-key-danger">
                <Icon name="key" size={18} />
                主机指纹发生变化
              </div>
            </header>
            <div className="modal-body">
              <p className="host-key-danger-copy">
                为防止中间人攻击，连接已被阻止。请与服务器管理员核对新指纹，不要直接忽略此警告。
              </p>
              <div className="host-key-target">{hostKeyWarning.host}:{hostKeyWarning.port}</div>
              <code className="host-key-fingerprint">{hostKeyWarning.fingerprint}</code>
            </div>
            <footer className="modal-footer">
              <button className="glass-btn" onClick={clearHostKeyWarning}>关闭</button>
            </footer>
          </div>
        </div>
      )}
      <FeedbackHost />
    </div>
  )
}

export default App
