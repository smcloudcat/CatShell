import { Icon } from '../../components/Icon'
import { SessionInfo } from '../../types/session'
import { useT } from '../../i18n'

interface Props {
  /** 可作为广播目标的会话（仅已连接）。 */
  connectedIds: number[]
  sessions: Record<number, SessionInfo>
  /** 当前已勾选的目标。 */
  targets: number[]
  activeCount: number
  allSelected: boolean
  onToggleTarget: (id: number) => void
  onSelectAll: () => void
  onDisable: () => void
}

/** 广播输入条：显示目标数、勾选目标、全选与关闭。 */
export function BroadcastBar({
  connectedIds,
  sessions,
  targets,
  activeCount,
  allSelected,
  onToggleTarget,
  onSelectAll,
  onDisable
}: Props) {
  const t = useT()
  return (
    <div className="broadcast-bar glass">
      <div className="broadcast-title">
        <Icon name="broadcast" size={15} />
        <span>{t('广播输入已开启')}</span>
        <small>{t('在当前终端键入会实时同步到勾选的会话（')}{activeCount}{t(' 个目标）')}</small>
      </div>
      <div className="broadcast-targets">
        {connectedIds.map((id) => (
          <button
            key={id}
            className={`broadcast-chip ${targets.includes(id) ? 'active' : ''}`}
            onClick={() => onToggleTarget(id)}
            title={sessions[id]?.name}
          >
            {sessions[id]?.name}
          </button>
        ))}
        {!connectedIds.length && <span className="section-tip">{t('没有已连接的会话可作为广播目标。')}</span>}
      </div>
      <div className="broadcast-actions">
        <button className="glass-btn" onClick={onSelectAll} disabled={allSelected}>
          {t('全选')}
        </button>
        <button className="glass-btn" onClick={onDisable}>{t('关闭广播')}</button>
      </div>
    </div>
  )
}
