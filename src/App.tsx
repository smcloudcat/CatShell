import { useEffect, useState } from 'react'
import { Icon, IconName } from './components/Icon'
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
import { MonitorView } from './views/MonitorView'
import { SftpView } from './views/SftpView'
import { ForwardView } from './views/ForwardView'
import './styles/glass.css'
import './App.css'

type ViewId = 'home' | 'sessions' | 'hosts' | 'sftp' | 'monitor' | 'forward' | 'settings'

export type { ViewId }

const NAV_ITEMS: { id: ViewId; icon: IconName; label: string }[] = [
  { id: 'home', icon: 'home', label: '概览' },
  { id: 'sessions', icon: 'terminal', label: '会话' },
  { id: 'hosts', icon: 'server', label: '主机' },
  { id: 'sftp', icon: 'folder', label: 'SFTP' },
  { id: 'monitor', icon: 'monitor', label: '监控' },
  { id: 'forward', icon: 'link', label: '转发' },
  { id: 'settings', icon: 'settings', label: '设置' }
]

function App() {
  const { theme, init } = useSettings()
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
    const root = document.documentElement.style
    const dark = theme.mode === 'dark'
    root.setProperty('--bg-opacity', String(theme.bgOpacity))
    root.setProperty('--glass-blur', `${theme.blurRadius}px`)
    root.setProperty('--glass-radius', `${theme.borderRadius}px`)
    root.setProperty('--border-opacity', String(theme.borderOpacity))
    root.setProperty('--accent', theme.accentColor)
    root.setProperty('--glass-bg', dark ? '15 23 42' : '255 255 255')
    root.setProperty('--glass-border', dark ? '255 255 255' : '148 163 184')
    root.setProperty('--text-main', dark ? '#e2e8f0' : '#1e293b')
    root.setProperty(
      '--text-muted',
      dark ? 'rgba(226, 232, 240, 0.65)' : 'rgba(30, 41, 59, 0.6)'
    )
    root.setProperty('--hover-bg', dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.35)')
    root.setProperty('--soft-bg', dark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(148, 163, 184, 0.18)')
    root.setProperty(
      '--glass-shadow',
      dark ? '0 8px 32px rgba(0, 0, 0, 0.42)' : '0 8px 32px rgba(2, 6, 23, 0.18)'
    )

    const bg = document.getElementById('app-bg')
    if (!bg) return
    if (theme.backgroundType === 'gradient') {
      bg.classList.remove('has-image')
      bg.style.backgroundImage = `linear-gradient(${theme.gradient.angle}deg, ${theme.gradient.from}, ${theme.gradient.to})`
    } else if (theme.backgroundType === 'solid') {
      bg.classList.remove('has-image')
      bg.style.background = theme.solidColor
    } else {
      bg.classList.add('has-image')
      bg.style.background = 'none'
      if (theme.backgroundImage) {
        bg.style.setProperty('--app-bg-image', `url("${theme.backgroundImage}")`)
      }
    }
  }, [theme])

  return (
    <div className="app-shell">
      <div id="app-bg" />
      <aside className="sidebar glass">
        <div className="sidebar-logo" title="CatShell">
          <Icon name="terminal" size={24} />
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
              {item.id === 'sessions' && sessionCount > 0 && (
                <span className="nav-badge">{sessionCount}</span>
              )}
            </button>
          ))}
        </nav>
      </aside>
      <main className="main-area">
        {view === 'home' && (
          <HomeView onOpenHosts={() => setView('hosts')} onOpenSessions={() => setView('sessions')} />
        )}
        {view === 'sessions' && <SessionsView />}
        {view === 'hosts' && <HostsView onOpenSessions={() => setView('sessions')} />}
        {view === 'monitor' && <MonitorView />}
        {view === 'forward' && <ForwardView />}
        {view === 'sftp' && <SftpView />}
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
    </div>
  )
}

export default App
