import { useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { SessionInfo } from '../../types/session'
import { useT } from '../../i18n'
import { formatOnlineDuration, statusLabel } from './sessionViewUtils'

interface Props {
  ids: number[]
  sessions: Record<number, SessionInfo>
  activeId: number | null
  connectedAt: Record<number, number>
  onSelect: (id: number) => void
  onReconnect: (id: number) => void
  onCloseTab: (id: number) => void
  onRename: (id: number, name: string) => void
}

/** 会话标签栏：状态点、双击重命名、重连与关闭。 */
export function SessionTabBar({
  ids,
  sessions,
  activeId,
  connectedAt,
  onSelect,
  onReconnect,
  onCloseTab,
  onRename
}: Props) {
  const t = useT()
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  const startRename = (id: number, currentName: string) => {
    setRenamingId(id)
    setRenamingValue(currentName)
    // 输入框要等 React 挂载后才能选中，因此放到下一帧。
    requestAnimationFrame(() => renameInputRef.current?.select())
  }

  const commitRename = () => {
    const id = renamingId
    const name = renamingValue.trim()
    setRenamingId(null)
    if (id === null || !name) return
    onRename(id, name)
  }

  return (
    <div className="session-tabs">
      {ids.map((id) => {
        const info = sessions[id]
        if (!info) return null
        const status = info.status
        const online = status === 'connected' && connectedAt[id]
          ? ` · ${formatOnlineDuration(Date.now() - connectedAt[id])}`
          : ''
        return (
          <div
            key={id}
            className={`session-tab ${activeId === id ? 'active' : ''}`}
            onClick={() => onSelect(id)}
            title={`${info.name} · ${info.host}:${info.port}`}
          >
            <span className={`tab-dot tab-dot-${status}`} />
            {renamingId === id ? (
              <input
                ref={renameInputRef}
                className="glass-input tab-rename-input"
                value={renamingValue}
                onChange={(event) => setRenamingValue(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitRename()
                  if (event.key === 'Escape') setRenamingId(null)
                }}
                onBlur={commitRename}
                autoFocus
              />
            ) : (
              <span
                className="tab-name"
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  startRename(id, info.name)
                }}
                title={t('双击重命名')}
              >
                {info.name}
              </span>
            )}
            <span className="tab-status" title={info.reason || undefined}>
              {statusLabel(t, status, info.reason, info.attempt ?? null)}{online}
            </span>
            {(status === 'disconnected' || status === 'closed') && (
              <button
                className="tab-close"
                title={t('重新连接')}
                onClick={(event) => {
                  event.stopPropagation()
                  onReconnect(id)
                }}
              >
                <Icon name="refresh" size={12} />
              </button>
            )}
            <button
              className="tab-close"
              title={t('关闭标签并断开')}
              onClick={(event) => {
                event.stopPropagation()
                onCloseTab(id)
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
