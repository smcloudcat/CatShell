import { memo } from 'react'
import { Icon } from '../../components/Icon'
import { HostProfile, normalizeHostIcon } from '../../types/host'
import { confirmDialog } from '../../store/ui'
import { useT } from '../../i18n'

interface Props {
  host: HostProfile
  /** 当前生效的标签筛选，用于高亮该行内的标签按钮。 */
  activeTag: string | null
  onToggleTag: (tag: string) => void
  onConnect: (host: HostProfile) => void
  onEdit: (host: HostProfile) => void
  onDelete: (host: HostProfile) => void
}

/**
 * 主机列表中的一行：图标、名称、连接信息、标签与操作按钮。
 *
 * `memo` 生效的前提是父组件传入的回调引用稳定（`HostsView` 已用 `useCallback` 保证），
 * 否则列表里任意一行的状态变化都会让整表重渲染（P2-19）。
 */
export const HostRow = memo(function HostRow({ host, activeTag, onToggleTag, onConnect, onEdit, onDelete }: Props) {
  const t = useT()
  const displayName = host.name || `${host.username}@${host.host}`
  const authLabel = host.authMethod === 'key'
    ? t('SSH 私钥')
    : host.authMethod === 'keyboard-interactive'
      ? t('交互式 2FA')
      : t('密码认证')

  const handleDelete = async () => {
    const accepted = await confirmDialog({
      title: t('删除主机'),
      message: t('确定删除主机“') + displayName + t('”吗？已解锁保险箱中的对应凭据会一并清除。'),
      confirmLabel: t('删除'),
      danger: true
    })
    if (accepted) onDelete(host)
  }

  return (
    <article className="glass host-row">
      <div className="host-icon"><Icon name={normalizeHostIcon(host.icon)} size={18} /></div>
      <div className="host-info">
        <div className="host-name">{displayName}</div>
        <div className="host-meta">{host.username}@{host.host}:{host.port} · {authLabel}</div>
        {host.tags.length > 0 && (
          <div className="host-tags">
            {host.tags.map((tag) => (
              <button
                key={tag}
                className={`host-tag ${activeTag === tag ? 'active' : ''}`}
                title={t('筛选标签「') + tag + t('」')}
                onClick={() => onToggleTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="host-actions">
        <button className="host-icon-btn" onClick={() => onConnect(host)} title={t('连接')}>
          <Icon name="link" size={15} />
        </button>
        <button className="host-icon-btn" onClick={() => onEdit(host)} title={t('编辑')}>
          <Icon name="edit" size={15} />
        </button>
        <button className="host-icon-btn danger" onClick={() => void handleDelete()} title={t('删除')}>
          <Icon name="trash" size={15} />
        </button>
      </div>
    </article>
  )
})
