import { Icon } from '../components/Icon'
import { useHosts } from '../store/hosts'
import { useSessions } from '../store/sessions'
import { useVault } from '../store/vault'
import { useT } from '../i18n'

interface HomeViewProps {
  onOpenHosts: () => void
  onOpenSessions: () => void
}

export function HomeView({ onOpenHosts, onOpenSessions }: HomeViewProps) {
  const t = useT()
  const hostCount = useHosts((state) => state.hosts.length)
  const sessions = useSessions((state) => state.sessions)
  const sessionCount = useSessions((state) => state.order.length)
  const vaultUnlocked = useVault((state) => state.unlocked)
  const connectedCount = Object.values(sessions).filter((session) => session.status === 'connected').length

  return (
    <div className="view home-view">
      <header className="view-header">
        <div>
          <div className="view-title">{t('概览')}</div>
          <div className="view-subtitle">{t('集中管理主机、终端与服务器状态')}</div>
        </div>
        <div className="system-status"><span className="status-dot" />{t('本地服务正常')}</div>
      </header>
      <section className="home-summary glass">
        <div className="home-summary-intro">
          <span className="summary-kicker">WORKSPACE</span>
          <h1>{t('欢迎使用 CatShell')}</h1>
          <p>{t('一个清晰、可靠的 SSH 运维工作台。快速进入主机，或继续当前终端会话。')}</p>
          <div className="summary-actions">
            <button className="glass-btn primary" onClick={onOpenSessions}>
              <Icon name="terminal" size={16} />
              {t('打开终端')}
            </button>
            <button className="glass-btn" onClick={onOpenHosts}>
              <Icon name="server" size={16} />
              {t('管理主机')}
            </button>
          </div>
        </div>
        <div className="home-stats" aria-label={t('工作区状态')}>
          <div className="home-stat"><strong>{hostCount}</strong><span>{t('已保存主机')}</span></div>
          <div className="home-stat"><strong>{connectedCount}</strong><span>{t('在线连接')}</span></div>
          <div className="home-stat"><strong>{sessionCount}</strong><span>{t('活动会话')}</span></div>
          <div className="home-stat"><strong>{vaultUnlocked ? t('已解锁') : t('已锁定')}</strong><span>{t('凭据保险箱')}</span></div>
        </div>
      </section>
      <div className="section-heading">
        <div>
          <strong>{t('运维工具')}</strong>
          <span>{t('常用能力集中在一个工作区')}</span>
        </div>
      </div>
      <div className="home-grid">
        <section className="glass home-card">
          <div className="card-heading"><span className="card-icon"><Icon name="server" size={19} /></span><div><div className="card-title">{t('主机管理')}</div><span className="card-eyebrow">CONNECTIONS</span></div></div>
          <div className="card-desc">
            {t('管理你的服务器清单：分组、标签、导入导出，支持密码与密钥（RSA / ED25519 / ECDSA）认证。')}
          </div>
          <button className="glass-btn card-action" onClick={onOpenHosts}>
            <Icon name="server" size={16} />
            {t('主机列表')}
          </button>
        </section>
        <section className="glass home-card">
          <div className="card-heading"><span className="card-icon"><Icon name="terminal" size={19} /></span><div><div className="card-title">{t('SSH 终端')}</div><span className="card-eyebrow">TERMINAL</span></div></div>
          <div className="card-desc">
            {t('多标签页 SSH2 终端，心跳保活与断线自动重连，密码 / 私钥认证，实时双向交互。')}
          </div>
          <button className="glass-btn primary card-action" onClick={onOpenSessions}>
            <Icon name="terminal" size={16} />
            {t('打开会话')}
          </button>
        </section>
        <section className="glass home-card">
          <div className="card-heading"><span className="card-icon"><Icon name="folder" size={19} /></span><div><div className="card-title">{t('SFTP 传输')}</div><span className="card-eyebrow">FILES</span></div></div>
          <div className="card-desc">
            {t('复用已认证 SSH 会话浏览目录、上传、下载和删除远程文件，大文件走磁盘级流式传输。')}
          </div>
          <span className="card-footer card-desc">{t('位于会话页底部，随连接自动启用')}</span>
        </section>
        <section className="glass home-card">
          <div className="card-heading"><span className="card-icon"><Icon name="monitor" size={19} /></span><div><div className="card-title">{t('服务器监控')}</div><span className="card-eyebrow">METRICS</span></div></div>
          <div className="card-desc">
            {t('无插件采集 CPU、内存、磁盘和网络数据，支持进程管理与 Ping/Trace 诊断。')}
          </div>
          <span className="card-footer card-desc">{t('位于会话页右侧，随连接自动启用')}</span>
        </section>
      </div>
      <footer className="view-footer">{t('凭据仅存内存 · 传输全程加密 · 操作可审计')}</footer>
    </div>
  )
}
