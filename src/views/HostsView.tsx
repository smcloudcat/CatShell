import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { ConnectDialog } from './hosts/ConnectDialog'
import { useSessions } from '../store/sessions'
import { useHosts } from '../store/hosts'
import { useVault } from '../store/vault'
import { HostProfile, normalizeHostIcon } from '../types/host'
import { ConnectRequest, SshConfigEntry } from '../types/session'
import { sshConfigParse } from '../api/ssh'
import { recordAudit } from '../store/audit'
import { ImportPreview, previewHostImport } from '../store/hosts'
import { confirmDialog, showToast } from '../store/ui'

interface Props {
  onOpenSessions: () => void
}

const UNGROUPED = '__ungrouped__'

export function HostsView({ onOpenSessions }: Props) {
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingHost, setEditingHost] = useState<HostProfile | null>(null)
  const [sshConfigOpen, setSshConfigOpen] = useState(false)
  const sessions = useSessions((s) => s.sessions)
  const sessionOrder = useSessions((s) => s.order)
  const hosts = useHosts((s) => s.hosts)
  const removeHost = useHosts((s) => s.remove)
  const importProfiles = useHosts((s) => s.importProfiles)
  const [pendingImport, setPendingImport] = useState<ImportPreview | null>(null)
  const openSession = useSessions((s) => s.open)
  const vaultUnlocked = useVault((s) => s.unlocked)
  const getCredential = useVault((s) => s.getCredential)

  useEffect(() => {
    void useHosts.getState().init()
  }, [])

  const allTags = useMemo(() => {
    const seen = new Set<string>()
    for (const host of hosts) for (const tag of host.tags) seen.add(tag)
    return Array.from(seen).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }, [hosts])

  const filteredHosts = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return hosts.filter((host) => {
      if (activeTag && !host.tags.includes(activeTag)) return false
      if (!needle) return true
      return [host.name, host.host, host.username, host.group ?? '', ...host.tags]
        .some((value) => value.toLowerCase().includes(needle))
    })
  }, [hosts, query, activeTag])

  const groups = useMemo(() => {
    const map = new Map<string, HostProfile[]>()
    for (const host of filteredHosts) {
      const key = host.group ?? UNGROUPED
      const list = map.get(key) ?? []
      list.push(host)
      map.set(key, list)
    }
    const keys = Array.from(map.keys()).sort((a, b) => {
      if (a === UNGROUPED) return 1
      if (b === UNGROUPED) return -1
      return a.localeCompare(b, 'zh-Hans-CN')
    })
    return keys.map((key) => ({ key, label: key === UNGROUPED ? '未分组' : key, hosts: map.get(key) ?? [] }))
  }, [filteredHosts])

  const hasGroups = useMemo(() => hosts.some((host) => host.group), [hosts])

  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const openNew = () => {
    setEditingHost(null)
    setDialogOpen(true)
  }

  const openEdit = (host: HostProfile) => {
    setEditingHost(host)
    setDialogOpen(true)
  }

  const reconnect = async (host: HostProfile) => {
    const credential = vaultUnlocked ? getCredential(host.id) : null
    const proxyCredential = host.proxy.enabled && vaultUnlocked ? getCredential(`proxy:${host.id}`) : null
    const hasAuth =
      host.authMethod === 'key'
        ? Boolean(host.keyPath)
        : host.authMethod === 'agent'
          ? true
          : host.authMethod === 'password'
            ? Boolean(credential?.password)
            : Boolean(credential?.password)
    if (!hasAuth) {
      setEditingHost(host)
      setDialogOpen(true)
      return
    }
    const proxy = host.proxy.enabled
      ? {
          host: host.proxy.host,
          port: host.proxy.port,
          username: host.proxy.username,
          authMethod: host.proxy.authMethod,
          password: host.proxy.authMethod === 'password' ? (proxyCredential?.password ?? null) : null,
          keyPath: host.proxy.authMethod === 'key' ? host.proxy.keyPath ?? null : null,
          passphrase: host.proxy.authMethod === 'key' ? (proxyCredential?.passphrase ?? null) : null
        }
      : null
    const request: ConnectRequest = {
      name: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      authMethod: host.authMethod,
      password: host.authMethod === 'password' ? (credential?.password ?? null) : null,
      keyPath: host.authMethod === 'key' ? host.keyPath ?? null : null,
      passphrase: host.authMethod === 'key' ? (credential?.passphrase ?? null) : null,
      otpSecret: null,
      keepalive: host.keepAliveInterval,
      autoReconnect: host.autoReconnect,
      proxy
    }
    try {
      await openSession(request)
      recordAudit('session.connect', `${host.name} (${host.host}:${host.port})`, 'success', '从主机列表快速连接')
      onOpenSessions()
    } catch {
      recordAudit('session.connect', `${host.name} (${host.host}:${host.port})`, 'failure', '快速连接失败，打开连接对话框')
      setEditingHost(host)
      setDialogOpen(true)
    }
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
    if (file.size > 5 * 1024 * 1024) {
      recordAudit('host.import', '主机配置文件', 'failure', '文件超过 5 MB 大小限制')
      showToast('导入失败，文件超过 5 MB 大小限制。', 'error')
      return
    }
    try {
      const parsed: unknown = JSON.parse(await file.text())
      const profiles = parsed && typeof parsed === 'object' && 'hosts' in parsed && Array.isArray(parsed.hosts)
        ? parsed.hosts
        : Array.isArray(parsed) ? parsed : []
      if (!profiles.length) {
        recordAudit('host.import', '主机配置文件', 'failure', '文件中没有主机配置')
        showToast('导入失败，文件中没有主机配置。', 'error')
        return
      }
      const preview = previewHostImport(profiles)
      if (!preview.items.length) {
        recordAudit('host.import', '主机配置文件', 'failure', '文件中没有有效的主机配置')
        showToast('导入失败，文件中没有有效的主机配置（缺少主机地址、用户名或端口无效）。', 'error')
        return
      }
      setPendingImport(preview)
    } catch (err) {
      recordAudit('host.import', '主机配置文件', 'failure', '文件无效或解析失败')
      showToast(err instanceof Error ? `导入失败：${err.message}` : '导入失败，请选择有效的 CatShell 主机配置文件。', 'error')
    }
  }

  const confirmImport = async (preview: ImportPreview) => {
    setPendingImport(null)
    try {
      await importProfiles(preview.items.map((item) => item.profile))
      const overwritten = preview.items.filter((item) => item.duplicateOf).length
      const parts = [`已导入 ${preview.items.length} 条主机配置`]
      if (overwritten) parts.push(`更新已有 ${overwritten} 条`)
      if (preview.invalidCount) parts.push(`跳过无效 ${preview.invalidCount} 条`)
      showToast(parts.join('，'), 'success')
    } catch (err) {
      recordAudit('host.import', '主机配置文件', 'failure', '导入失败')
      showToast(err instanceof Error ? `导入失败：${err.message}` : '导入失败', 'error')
    }
  }

  const renderHostRow = (host: HostProfile) => (
    <article key={host.id} className="glass host-row">
      <div className="host-icon"><Icon name={normalizeHostIcon(host.icon)} size={18} /></div>
      <div className="host-info">
        <div className="host-name">{host.name || `${host.username}@${host.host}`}</div>
        <div className="host-meta">{host.username}@{host.host}:{host.port} · {host.authMethod === 'key' ? 'SSH 私钥' : host.authMethod === 'keyboard-interactive' ? '交互式 2FA' : '密码认证'}</div>
        {host.tags.length > 0 && (
          <div className="host-tags">
            {host.tags.map((tag) => (
              <button
                key={tag}
                className={`host-tag ${activeTag === tag ? 'active' : ''}`}
                title={`筛选标签「${tag}」`}
                onClick={() => setActiveTag((current) => (current === tag ? null : tag))}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="host-actions">
        <button className="host-icon-btn" onClick={() => void reconnect(host)} title="连接">
          <Icon name="link" size={15} />
        </button>
        <button className="host-icon-btn" onClick={() => openEdit(host)} title="编辑">
          <Icon name="edit" size={15} />
        </button>
        <button
          className="host-icon-btn danger"
          onClick={() => {
            void confirmDialog({
              title: '删除主机',
              message: `确定删除主机“${host.name || host.host}”吗？已解锁保险箱中的对应凭据会一并清除。`,
              confirmLabel: '删除',
              danger: true
            }).then((accepted) => {
              if (accepted) void removeHost(host.id)
            })
          }}
          title="删除"
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
    </article>
  )

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-title">主机</div>
          <div className="view-subtitle">{hosts.length} 台已保存主机 · 管理服务器连接配置</div>
        </div>
          <div className="hosts-header">
          <div className="search-field">
            <div className="search-field-icon">
              <Icon name="search" size={15} />
            </div>
            <input
              className="glass-input"
              placeholder="搜索主机 / IP / 标签"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="hosts-actions">
            <button className="glass-btn" onClick={() => setSshConfigOpen(true)} title="从 ~/.ssh/config 导入主机">
              <Icon name="database" size={15} />
              导入 SSH config
            </button>
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
        {allTags.length > 0 && (
          <div className="host-tag-filter">
            <button
              className={`host-tag ${activeTag === null ? 'active' : ''}`}
              onClick={() => setActiveTag(null)}
            >
              全部
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                className={`host-tag ${activeTag === tag ? 'active' : ''}`}
                onClick={() => setActiveTag((current) => (current === tag ? null : tag))}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
        {hasGroups ? (
          groups.map((group) => {
            const collapsed = collapsedGroups.has(group.key)
            return (
              <section className="host-group" key={group.key}>
                <button
                  className={`host-group-header ${collapsed ? 'collapsed' : ''}`}
                  onClick={() => toggleGroup(group.key)}
                >
                  <Icon name="chevron-down" size={14} />
                  <span className="host-group-name">{group.label}</span>
                  <span className="host-group-count">{group.hosts.length}</span>
                </button>
                {!collapsed && <div className="host-list">{group.hosts.map(renderHostRow)}</div>}
              </section>
            )
          })
        ) : filteredHosts.length > 0 ? (
          <section className="host-list">
            {filteredHosts.map(renderHostRow)}
          </section>
        ) : null}
        {sessionOrder.length > 0 && (
          <section className="glass quick-card">
            <div className="quick-title">
              <Icon name="terminal" size={16} />
              活动会话
            </div>
            <div className="session-list">
              {sessionOrder.map((id) => {
                const s = sessions[id]
                if (!s) return null
                return (
                  <button key={s.id} className="session-link" onClick={onOpenSessions}>
                    <span className={`tab-dot tab-dot-${s.status}`} />
                    <span className="session-link-name">{s.name}</span>
                    <span className="session-link-meta">
                      {s.host}:{s.port}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        )}
        {filteredHosts.length === 0 && <section className="glass empty-state">
          <div className="empty-icon">
            <Icon name="server" size={44} />
          </div>
          <div className="empty-title">{hosts.length ? '没有匹配的主机' : '还没有主机配置'}</div>
          <div className="empty-desc">
             {hosts.length ? '尝试更换搜索关键词或标签筛选。' : '点击右上角「新建连接」创建第一条 SSH 主机配置。'}
          </div>
        </section>}
      </div>
       <ConnectDialog
         open={dialogOpen}
         profile={editingHost}
         onClose={() => { setDialogOpen(false); setEditingHost(null) }}
         onConnected={onOpenSessions}
       />
        {sshConfigOpen && (
          <SshConfigImportModal
            onClose={() => setSshConfigOpen(false)}
            importProfiles={importProfiles}
          />
        )}
        {pendingImport && (
          <HostImportPreviewModal
            preview={pendingImport}
            onClose={() => setPendingImport(null)}
            onConfirm={() => void confirmImport(pendingImport)}
          />
        )}
      </div>
  )
}

function HostImportPreviewModal({
  preview,
  onClose,
  onConfirm
}: {
  preview: ImportPreview
  onClose: () => void
  onConfirm: () => void
}) {
  const [busy, setBusy] = useState(false)
  const fresh = preview.items.filter((item) => !item.duplicateOf).length
  const overwritten = preview.items.length - fresh

  const confirm = async () => {
    setBusy(true)
    try {
      onConfirm()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal glass sshconfig-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title"><Icon name="database" size={17} />导入主机配置预览</div>
          <button className="modal-close" onClick={onClose} disabled={busy}><Icon name="x" size={15} /></button>
        </header>
        <div className="modal-body">
          <p className="section-tip">
            共 {preview.items.length} 条有效配置：新增 {fresh} 条，更新已有 {overwritten} 条。
            {preview.invalidCount > 0 && ` ${preview.invalidCount} 条无效配置（缺少地址/用户名或端口无效）将被跳过。`}
            已存在的同 主机+端口+用户名 配置会被覆盖更新，凭据不随导入写入。
          </p>
          <div className="sshconfig-list">
            {preview.items.map((item) => (
              <div className="sshconfig-row" key={item.profile.id + (item.duplicateOf?.id ?? '')}>
                <span className="sshconfig-name">{item.profile.name || `${item.profile.username}@${item.profile.host}`}</span>
                <span className="sshconfig-meta">
                  {item.profile.username}@{item.profile.host}:{item.profile.port}
                  {item.profile.group ? ` · 分组 ${item.profile.group}` : ''}
                  {item.profile.tags.length ? ` · ${item.profile.tags.join('、')}` : ''}
                </span>
                {item.duplicateOf ? <span className="sshconfig-dup">更新</span> : <span className="sshconfig-new">新增</span>}
              </div>
            ))}
          </div>
        </div>
        <footer className="modal-footer">
          <button className="glass-btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="glass-btn primary" onClick={() => void confirm()} disabled={busy}>
            {busy ? '导入中…' : `确认导入（${preview.items.length}）`}
          </button>
        </footer>
      </div>
    </div>
  )
}

function SshConfigImportModal({
  onClose,
  importProfiles
}: {
  onClose: () => void
  importProfiles: (profiles: Partial<HostProfile>[]) => Promise<void>
}) {
  const hosts = useHosts((s) => s.hosts)
  const [entries, setEntries] = useState<SshConfigEntry[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const parsed = await sshConfigParse()
        if (cancelled) return
        setEntries(parsed)
        setSelected(new Set(parsed.map((entry) => entry.host)))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const duplicateKey = (entry: SshConfigEntry): string => {
    const host = entry.hostname ?? entry.host
    const port = entry.port ?? 22
    const username = entry.user ?? ''
    return `${host}:${port}:${username}`
  }

  const existingKeys = useMemo(() => new Set(hosts.map((host) => `${host.host}:${host.port}:${host.username}`)), [hosts])

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const confirmImport = async () => {
    if (!entries) return
    const chosen = entries.filter((entry) => selected.has(entry.host))
    if (!chosen.length) {
      setError('请至少选择一条主机配置')
      return
    }
    setBusy(true)
    try {
      await importProfiles(
        chosen.map((entry) => ({
          name: entry.host,
          host: entry.hostname ?? entry.host,
          port: entry.port ?? 22,
          username: entry.user ?? '',
          authMethod: entry.identityFile ? 'key' : 'password',
          keyPath: entry.identityFile ?? null,
          password: null,
          passphrase: null,
          group: null,
          tags: [],
          description: '导入自 ~/.ssh/config'
        }))
      )
      recordAudit('host.import', '~/.ssh/config', 'success', `导入 ${chosen.length} 条 OpenSSH 配置`)
      showToast(`已从 ~/.ssh/config 导入 ${chosen.length} 条主机配置。`, 'success')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal glass sshconfig-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title"><Icon name="database" size={17} />导入 ~/.ssh/config</div>
          <button className="modal-close" onClick={onClose} disabled={busy}><Icon name="x" size={15} /></button>
        </header>
        <div className="modal-body">
          {error ? (
            <div className="form-error">{error}</div>
          ) : !entries ? (
            <div className="section-tip">正在读取并解析 ~/.ssh/config…</div>
          ) : !entries.length ? (
            <div className="section-tip">配置文件中没有可导入的主机条目（通配符与 Match 块会被跳过）。</div>
          ) : (
            <>
              <p className="section-tip">
                共 {entries.length} 条。已存在的同 主机+端口+用户名 配置不会被覆盖。认证方式按 IdentityFile 推断；导入后请补齐凭据。
              </p>
              <div className="sshconfig-list">
                {entries.map((entry) => {
                  const address = entry.hostname ?? entry.host
                  const duplicate = existingKeys.has(duplicateKey(entry))
                  return (
                    <label className="sshconfig-row" key={entry.host}>
                      <input
                        type="checkbox"
                        checked={selected.has(entry.host)}
                        onChange={() => toggle(entry.host)}
                      />
                      <span className="sshconfig-name">{entry.host}</span>
                      <span className="sshconfig-meta">
                        {entry.user ? `${entry.user}@` : ''}{address}:{entry.port ?? 22}
                        {entry.identityFile ? ` · ${entry.identityFile}` : ''}
                      </span>
                      {duplicate && <span className="sshconfig-dup">已存在</span>}
                    </label>
                  )
                })}
              </div>
            </>
          )}
        </div>
        <footer className="modal-footer">
          <button className="glass-btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="glass-btn primary" onClick={() => void confirmImport()} disabled={busy || !entries || !selected.size}>
            {busy ? '导入中…' : `导入所选（${selected.size}）`}
          </button>
        </footer>
      </div>
    </div>
  )
}