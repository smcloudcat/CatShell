import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { SftpEntry } from '../../types/session'
import { useT } from '../../i18n'
import { CHMOD_PRESETS, formatMode, permissionText } from './sftpUtils'

interface Props {
  target: SftpEntry
  value: string
  busy: boolean
  onChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}

/**
 * chmod 弹窗。展示当前权限的八进制与 rwx 形式，并提供常用预设，
 * 避免用户手算出错。输入校验由调用方通过 `parseChmodInput` 完成。
 */
export function SftpChmodDialog({ target, value, busy, onChange, onClose, onSubmit }: Props) {
  const t = useT()
  const current = target.permissions ?? 0
  return (
    <Modal
      onClose={onClose}
      closeOnOverlayClick={!busy}
      closeOnEscape={!busy}
      ariaLabel={`${t('修改权限 ')}${target.name}`}
    >
      <header className="modal-header">
        <div className="modal-title">
          <Icon name="key" size={17} />
          {t('修改权限 ')}
          {target.name}
        </div>
        <button className="modal-close" onClick={onClose} disabled={busy} title={t('关闭')}>
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="modal-body">
        <div className="section-tip">
          {t('当前权限：')}{formatMode(current)}（{permissionText(current)}）
          {target.owner && <> · {t('属主 ')}{target.owner}</>}
          {target.group && <> / {t('组 ')}{target.group}</>}
        </div>
        <label className="field">
          <span className="field-label">{t('八进制权限（3~4 位，例如 644）')}</span>
          <input
            className="glass-input"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) void onSubmit()
            }}
          />
        </label>
        <div className="chmod-presets">
          {CHMOD_PRESETS.map((preset) => (
            <button key={preset} className="glass-btn" onClick={() => onChange(preset)}>
              {preset}
            </button>
          ))}
        </div>
      </div>
      <footer className="modal-footer">
        <button className="glass-btn" onClick={onClose} disabled={busy}>{t('取消')}</button>
        <button className="glass-btn primary" onClick={() => void onSubmit()} disabled={busy}>
          {busy ? t('处理中…') : t('应用')}
        </button>
      </footer>
    </Modal>
  )
}
