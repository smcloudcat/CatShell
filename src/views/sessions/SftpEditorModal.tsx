import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { SftpEntry } from '../../types/session'
import { useT } from '../../i18n'

interface Props {
  entry: SftpEntry
  value: string
  busy: boolean
  onChange: (value: string) => void
  onClose: () => void
  onSave: () => void
}

/**
 * 远程文本文件的查看/编辑弹窗。
 * 只负责展示与受控输入，读取与回传由 `SessionSftpPanel` 编排。
 */
export function SftpEditorModal({ entry, value, busy, onChange, onClose, onSave }: Props) {
  const t = useT()
  return (
    <Modal
      onClose={onClose}
      className="sftp-editor-modal"
      closeOnOverlayClick={!busy}
      closeOnEscape={!busy}
      ariaLabel={`${t('编辑 ')}${entry.name}`}
    >
      <header className="modal-header">
        <div className="modal-title">
          <Icon name="settings" size={17} />
          {t('编辑 ')}
          {entry.name}
        </div>
        <button className="modal-close" onClick={onClose} disabled={busy} title={t('关闭')}>
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="modal-body sftp-editor-body">
        <textarea
          className="glass-input sftp-editor"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          autoFocus
        />
      </div>
      <footer className="modal-footer">
        <button className="glass-btn" onClick={onClose} disabled={busy}>{t('取消')}</button>
        <button className="glass-btn primary" onClick={onSave} disabled={busy}>
          {busy ? t('保存中…') : t('保存并回传')}
        </button>
      </footer>
    </Modal>
  )
}
