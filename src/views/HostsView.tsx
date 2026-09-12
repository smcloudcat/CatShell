import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { ConnectDialog } from './hosts/ConnectDialog'
import { HostRow } from './hosts/HostRow'
import { HostImportPreviewModal } from './hosts/HostImportPreviewModal'
import { SshConfigImportModal } from './hosts/SshConfigImportModal'
import { useSessions } from '../store/sessions'
import { connectHostQuick } from '../store/hostConnect'
import { useLaunchIntent } from '../store/launchIntent'
import { synthesizeAdhocProfile } from '../utils/launchIntent'
import { useHosts } from '../store/hosts'
import { HostProfile } from '../types/host'
import { recordAudit } from '../store/audit'
import { ImportPreview, previewHostImport } from '../store/hosts'
import { showToast } from '../store/ui'
import { collectTags, filterHosts, groupHosts } from '../utils/hostList'
import { useT } from '../i18n'
import { errorText } from '../i18n/errors'

interface Props {
  onOpenSessions: () => void
}

/**
 * 主机列表页。
 *
 * 行渲染、导入预览、SSH config 导入与列表分组/筛选各自独立成组件或纯函数，
 * 这里保留导入导出、快速连接与弹窗开关等编排逻辑。
 */
export function HostsView({ onOpenSessions }: Props) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingHost, setEditingHost] = useState<HostProfile | null>(null)
  const [sshConfigOpen, setSshConfigOpen] = useState(false)
  const [pendingImport, setPendingImport] = useState<ImportPreview | null>(null)

  const sessions = useSessions((s) => s.sessions)
  const sessionOrder = useSessions((s) => s.order)
  const hosts = useHosts((s) => s.hosts)
  const removeHost = useHosts((s) => s.remove)
  const importProfiles = useHosts((s) => s.importProfiles)

  useEffect(() => {
    void useHosts.getState().init()
  }, [])

  const allTags = useMemo(() => collectTags(hosts), [hosts])
  const filteredHosts = useMemo(() => filterHosts(hosts, query, activeTag), [hosts, query, activeTag])
  const groups = useMemo(() => groupHosts(filteredHosts, t('未分组')), [filteredHosts, t])
  const hasGroups = useMemo(() => hosts.some((host) => host.group), [hosts])

  // 回调一律用 useCallback 固定引用：传给 HostRow 的 props 稳定，行组件的 memo 才有效，
  // 否则每次列表刷新都会整表重渲染（P2-19）。
  const toggleTag = useCallback(
    (tag: string) => setActiveTag((current) => (current === tag ? null : tag)),
    []
  )

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

  const openEdit = useCallback((host: HostProfile) => {
    setEditingHost(host)
    setDialogOpen(true)
  }, [])

  // 命令行 `catshell user@host[:port]` 临时目标：打开连接对话框预填（6.16）。
  const adhocPrefill = useLaunchIntent((s) => s.adhocPrefill)
  useEffect(() => {
    if (!adhocPrefill) return
    useLaunchIntent.getState().setAdhocPrefill(null)
    openEdit(synthesizeAdhocProfile(adhocPrefill))
  }, [adhocPrefill, openEdit])

  /**
   * 从列表一键连接。
   * 缺少可用凭据（或保险箱锁定）时不硬连，直接把连接对话框打开让用户补齐。
   * 与命令面板共用 `connectHostQuick`，保持同一条直连链路。
   */
  const reconnect = useCallback(
    async (host: HostProfile) => {
      const result = await connectHostQuick(host)
      if (result === 'needs-form') {
        openEdit(host)
        return
      }
      onOpenSessions()
    },
    [openEdit, onOpenSessions]
  )

  const handleDelete = useCallback(
    async (host: HostProfile) => {
      const credential = await removeHost(host.id)
      // 保险箱锁定时凭据删不掉、只能排队，必须明确告知，否则用户会以为已经清理干净（审计 B-15）。
      if (credential === 'queued') {
        showToast(t('保险箱已锁定，凭据将在下次解锁时自动清理'), 'warning')
      }
      recordAudit('host.delete', `${host.name || host.host}`, 'success', '删除主机配置')
    },
    [removeHost, t]
  )

  // 行组件的回调签名要求返回 void；这里包一层显式 `void`，既满足 lint，也保持引用稳定。
  const connectRow = useCallback((host: HostProfile) => { void reconnect(host) }, [reconnect])
  const deleteRow = useCallback((host: HostProfile) => { void handleDelete(host) }, [handleDelete])

  const exportHosts = () => {
    // 导出前显式剔除敏感字段，且只信任白名单以外的字段被丢弃这件事由类型保证。
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
      recordAudit('host.import', 'hosts-file', 'failure', t('文件超过 5 MB 大小限制'))
      showToast(t('导入失败，文件超过 5 MB 大小限制。'), 'error')
      return
    }
    try {
      const parsed: unknown = JSON.parse(await file.text())
      // JSON.parse 的产物不可信，这里的断言只给下游一个形状；真正的校验由
      // buildImportPreview 内部的 normalizeHost / isValidHost 完成。
      const profiles = (
        parsed && typeof parsed === 'object' && 'hosts' in parsed && Array.isArray(parsed.hosts)
          ? parsed.hosts
          : Array.isArray(parsed) ? parsed : []
      ) as Partial<HostProfile>[]
      if (!profiles.length) {
        recordAudit('host.import', 'hosts-file', 'failure', t('文件中没有主机配置'))
        showToast(t('导入失败，文件中没有主机配置。'), 'error')
        return
      }
      const preview = previewHostImport(profiles)
      if (!preview.items.length) {
        recordAudit('host.import', 'hosts-file', 'failure', t('文件中没有有效的主机配置'))
        showToast(t('导入失败，文件中没有有效的主机配置（缺少主机地址、用户名或端口无效）。'), 'error')
        return
      }
      setPendingImport(preview)
    } catch (err) {
      recordAudit('host.import', 'hosts-file', 'failure', t('文件无效或解析失败'))
      showToast(t('导入失败：') + errorText(err, t, '请选择有效的 CatShell 主机配置文件。'), 'error')
    }
  }

  const confirmImport = async (preview: ImportPreview) => {
    setPendingImport(null)
    try {
      await importProfiles(preview.items.map((item) => item.profile))
      const overwritten = preview.items.filter((item) => item.duplicateOf).length
      const parts = [t('已导入 ') + preview.items.length + t(' 条主机配置')]
      if (overwritten) parts.push(t('更新已有 ') + overwritten + t(' 条'))
      if (preview.invalidCount) parts.push(t('跳过无效 ') + preview.invalidCount + t(' 条'))
      showToast(parts.join(t('，')), 'success')
    } catch (err) {
      recordAudit('host.import', 'hosts-file', 'failure', t('导入失败'))
      showToast(errorText(err, t, '导入失败'), 'error')
    }
  }

  const renderHostRow = useCallback(
    (host: HostProfile) => (
      <HostRow
        key={host.id}
        host={host}
        activeTag={activeTag}
        onToggleTag={toggleTag}
        onConnect={connectRow}
        onEdit={openEdit}
        onDelete={deleteRow}
      />
    ),
    [activeTag, connectRow, deleteRow, openEdit, toggleTag]
  )

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-title">{t('主机')}</div>
          <div className="view-subtitle">{hosts.length} {t('台已保存主机 · 管理服务器连接配置')}</div>
        </div>
        <div className="hosts-header">
          <div className="search-field">
            <div className="search-field-icon">
              <Icon name="search" size={15} />
            </div>
            <input
              className="glass-input"
              placeholder={t('搜索主机 / IP / 标签')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="hosts-actions">
            <button className="glass-btn" onClick={() => setSshConfigOpen(true)} title={t('从 ~/.ssh/config 导入主机')}>
              <Icon name="database" size={15} />
              {t('导入 SSH config')}
            </button>
            <label className="glass-btn" title={t('导入主机配置')}>
              <Icon name="folder" size={15} />
              {t('导入')}
              <input
                className="sr-only"
                type="file"
                accept="application/json,.json"
                onChange={(event) => void importHosts(event)}
              />
            </label>
            <button className="glass-btn" onClick={exportHosts} disabled={!hosts.length} title={t('导出主机配置')}>
              <Icon name="save" size={15} />
              {t('导出')}
            </button>
            <button className="glass-btn primary" onClick={openNew}>
              <Icon name="plus" size={15} />
              {t('新建连接')}
            </button>
          </div>
        </div>
      </header>
      <div className="hosts-list">
        <section className="glass quick-card">
          <div className="quick-title">
            <Icon name="link" size={16} />
            {t('快速开始')}
          </div>
          <div className="quick-desc">
            {t('点击「新建连接」输入主机地址与认证信息即可打开 SSH 终端。')}
            {t('主机地址、端口和认证方式会保存到本机；密码与私钥口令只在连接时使用，不会写入磁盘。')}
          </div>
        </section>
        {allTags.length > 0 && (
          <div className="host-tag-filter">
            <button className={`host-tag ${activeTag === null ? 'active' : ''}`} onClick={() => setActiveTag(null)}>
              {t('全部')}
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                className={`host-tag ${activeTag === tag ? 'active' : ''}`}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
        {hasGroups && groups.map((group) => {
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
        })}
        {!hasGroups && filteredHosts.length > 0 && (
          <section className="host-list">{filteredHosts.map(renderHostRow)}</section>
        )}
        {sessionOrder.length > 0 && (
          <section className="glass quick-card">
            <div className="quick-title">
              <Icon name="terminal" size={16} />
              {t('活动会话')}
            </div>
            <div className="session-list">
              {sessionOrder.map((id) => {
                const session = sessions[id]
                if (!session) return null
                return (
                  <button key={session.id} className="session-link" onClick={onOpenSessions}>
                    <span className={`tab-dot tab-dot-${session.status}`} />
                    <span className="session-link-name">{session.name}</span>
                    <span className="session-link-meta">{session.host}:{session.port}</span>
                  </button>
                )
              })}
            </div>
          </section>
        )}
        {filteredHosts.length === 0 && (
          <section className="glass empty-state">
            <div className="empty-icon">
              <Icon name="server" size={44} />
            </div>
            <div className="empty-title">{hosts.length ? t('没有匹配的主机') : t('还没有主机配置')}</div>
            <div className="empty-desc">
              {hosts.length ? t('尝试更换搜索关键词或标签筛选。') : t('点击右上角「新建连接」创建第一条 SSH 主机配置。')}
            </div>
          </section>
        )}
      </div>
      <ConnectDialog
        open={dialogOpen}
        profile={editingHost}
        onClose={() => { setDialogOpen(false); setEditingHost(null) }}
        onConnected={onOpenSessions}
      />
      {sshConfigOpen && (
        <SshConfigImportModal onClose={() => setSshConfigOpen(false)} importProfiles={importProfiles} />
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
