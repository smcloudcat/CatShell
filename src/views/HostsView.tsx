import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { ConnectDialog } from './hosts/ConnectDialog'
import { useSessions } from '../store/sessions'
import { useHosts } from '../store/hosts'
import { HostProfile } from '../types/host'
import { recordAudit } from '../store/audit'

interface Props {
  onOpenSessions: () => void
}

export function HostsView({ onOpenSessions }: Props) {
  const [query, setQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingHost, setEditingHost] = useState<HostProfile | null>(null)
  const sessions = useSessions((s) => s.sessions)
  const hosts = useHosts((s) => s.hosts)
  const removeHost = useHosts((s) => s.remove)
  const importProfiles = useHosts((s) => s.importProfiles)

  useEffect(() => {
    void useHosts.getState().init()
  }, [])

  const filteredHosts = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return hosts
    return hosts.filter((host) =>
      [host.name, host.host, host.username, ...host.tags].some((value) => value.toLowerCase().includes(needle))
    )
  }, [hosts, query])

  const openNew = () => {
    setEditingHost(null)
    setDialogOpen(true)
  }

  const openEdit = (host: HostProfile) => {
    setEditingHost(host)
    setDialogOpen(true)
  }

  const exportHosts = () => {
    const safeHosts = hosts.map(({ password: _password, passphrase: _passphrase, ...host }) => host)
    const blob = new Blob([JSON.stringify({ version: 1, hosts: safeHosts }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'catshell-hosts.json'
    anchor.click()
    URL.revokeObjectURL(url)
    recordAudit('host.export', '主机配置', 'success', `导出 ${safeHosts.length} 条配置`)
  }

  const importHosts = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed: unknown = JSON.parse(await file.text())
      const profiles = parsed && typeof parsed === 'object' && 'hosts' in parsed && Array.isArray(parsed.hosts)
        ? parsed.hosts
        : Array.isArray(parsed) ? parsed : []
      if (!profiles.length) {
        recordAudit('host.import', '主机配置文件', 'failure', '文件中没有主机配置')
        window.alert('导入失败，文件中没有主机配置。')
        return
      }
      await importProfiles(profiles)
    } catch {
      recordAudit('host.import', '主机配置文件', 'failure', '文件无效或解析失败')
      window.alert('导入失败，请选择有效的 CatShell 主机配置文件。')
    }
  }

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-title">主机</div>
          <div className="view-subtitle">管理你的服务器连接配置</div>
        </div>
        <div className="hosts-header">
          <div style={{ position: 'relative', flex: 1 }}>
            <div
              style={{
                position: 'absolute',
                left: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-muted)'
              }}
            >
              <Icon name="search" size={15} />
            </div>
            <input
              className="glass-input"
              style={{ paddingLeft: 34 }}
              placeholder="搜索主机 / IP / 标签"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="hosts-actions">
            <label className="glass-btn" title="导入主机配置">
              <Icon name="folder" size={15} />
              导入
              <input className="sr-only" type="file" accept="application/json,.json" onChange={importHosts} />
            </label>
            <button className="glass-btn" onClick={exportHosts} disabled={!hosts.length} title="导出主机配置">
              <Icon name="save" size={15} />
              导出
            </button>
            <button className="glass-btn primary" onClick={openNew}>
              <Icon name="plus" size={15} />
              新建连接
            </button>
          </div>
        </div>
      </header>
      <div className="hosts-list">
        <section className="glass quick-card">
          <div className="quick-title">
            <Icon name="link" size={16} />
            快速开始
          </div>
          <div className="quick-desc">
            点击「新建连接」输入主机地址与认证信息即可打开 SSH 终端。
             主机地址、端口和认证方式会保存到本机；密码与私钥口令只在连接时使用，不会写入磁盘。
          </div>
        </section>
        {filteredHosts.length > 0 && (
          <section className="host-list">
            {filteredHosts.map((host) => (
              <article key={host.id} className="glass host-row">
                <div className="host-icon"><Icon name="server" size={18} /></div>
                <div className="host-info">
                  <div className="host-name">{host.name || `${host.username}@${host.host}`}</div>
                  <div className="host-meta">{host.username}@{host.host}:{host.port} · {host.authMethod === 'key' ? 'SSH 私钥' : host.authMethod === 'keyboard-interactive' ? '交互式 2FA' : '密码认证'}</div>
                </div>
                <div className="host-actions">
                  <button className="host-icon-btn" onClick={() => { setEditingHost(host); setDialogOpen(true) }} title="连接">
                    <Icon name="link" size={15} />
                  </button>
                  <button className="host-icon-btn" onClick={() => openEdit(host)} title="编辑">
                    <Icon name="settings" size={15} />
                  </button>
                  <button
                    className="host-icon-btn danger"
                    onClick={() => {
                      if (window.confirm(`确定删除主机“${host.name || host.host}”吗？`)) void removeHost(host.id)
                    }}
                    title="删除"
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
        {Object.keys(sessions).length > 0 && (
          <section className="glass quick-card">
            <div className="quick-title">
              <Icon name="terminal" size={16} />
              活动会话
            </div>
            <div className="session-list">
              {Object.values(sessions).map((s) => (
                <button key={s.id} className="session-link" onClick={onOpenSessions}>
                  <span className={`tab-dot tab-dot-${s.status}`} />
                  <span className="session-link-name">{s.name}</span>
                  <span className="session-link-meta">
                    {s.host}:{s.port}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        {filteredHosts.length === 0 && <section className="glass empty-state">
          <div className="empty-icon">
            <Icon name="server" size={44} />
          </div>
          <div className="empty-title">{hosts.length ? '没有匹配的主机' : '还没有主机配置'}</div>
          <div className="empty-desc">
             {hosts.length ? '尝试更换搜索关键词。' : '点击右上角「新建连接」创建第一条 SSH 主机配置。'}
          </div>
        </section>}
      </div>
       <ConnectDialog
         open={dialogOpen}
         profile={editingHost}
         onClose={() => { setDialogOpen(false); setEditingHost(null) }}
         onConnected={onOpenSessions}
       />
    </div>
  )
}
