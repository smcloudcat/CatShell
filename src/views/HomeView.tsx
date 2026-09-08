import { Icon } from '../components/Icon'

interface HomeViewProps {
  onOpenHosts: () => void
  onOpenSessions: () => void
}

export function HomeView({ onOpenHosts, onOpenSessions }: HomeViewProps) {
  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-title">概览</div>
          <div className="view-subtitle">CatShell · 服务器远程运维工具 v0.1.0</div>
        </div>
        <span className="status-dot" title="服务正常" />
      </header>
      <div className="home-grid">
        <section className="glass home-card">
          <div className="card-title">主机管理</div>
          <div className="card-desc">
            管理你的服务器清单：分组、标签、导入导出，支持密码与密钥（RSA /
            ED25519 / ECDSA）认证。
          </div>
          <button className="glass-btn card-action" onClick={onOpenHosts}>
            <Icon name="server" size={16} />
            主机列表
          </button>
        </section>
        <section className="glass home-card">
          <div className="card-title">SSH 终端</div>
          <div className="card-desc">
            多标签页 SSH2 终端，心跳保活与断线自动重连（最多 3 次），
            密码 / 私钥认证，实时双向交互。
          </div>
          <button className="glass-btn primary card-action" onClick={onOpenSessions}>
            <Icon name="terminal" size={16} />
            打开会话
          </button>
        </section>
        <section className="glass home-card">
          <div className="card-title">SFTP 传输</div>
          <div className="card-desc">
            复用已认证 SSH 会话浏览目录、上传、下载和删除远程文件，单文件限制 64 MB。
          </div>
          <span className="card-footer card-desc">已可在侧栏 SFTP 页面使用</span>
        </section>
        <section className="glass home-card">
          <div className="card-title">服务器监控</div>
          <div className="card-desc">
            无插件采集 CPU、内存、磁盘和网络数据，支持进程管理与 Ping/Trace 诊断。
          </div>
          <span className="card-footer card-desc">已可在侧栏监控页面使用</span>
        </section>
      </div>
      <footer className="view-footer">凭据仅存内存 · 传输全程加密 · 操作可审计</footer>
    </div>
  )
}
