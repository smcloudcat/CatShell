import { useT } from '../../i18n'
import { SessionDialog } from './SessionDialog'

interface Props {
  value: string
  busy: boolean
  onChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}

/** 向所有已连接会话下发同一条命令。危险操作，确认按钮为 primary 并附风险提示。 */
export function BulkCommandDialog({ value, busy, onChange, onClose, onSubmit }: Props) {
  const t = useT()
  return (
    <SessionDialog
      title={t('批量下发命令')}
      icon="terminal"
      ariaLabel={t('批量下发命令')}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="glass-btn" onClick={onClose} disabled={busy}>{t('取消')}</button>
          <button className="glass-btn primary" onClick={onSubmit} disabled={busy || !value.trim()}>
            {busy ? t('发送中…') : t('确认发送')}
          </button>
        </>
      }
    >
      <p className="section-tip">{t('命令将发送至所有已连接会话，请确认命令不会造成不可逆影响。')}</p>
      <textarea
        className="glass-input bulk-command"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('例如 uname -a')}
        autoFocus
      />
    </SessionDialog>
  )
}
