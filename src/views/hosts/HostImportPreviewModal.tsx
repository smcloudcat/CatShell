import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { ImportPreview } from '../../store/hosts'
import { useT } from '../../i18n'

interface Props {
  preview: ImportPreview
  onClose: () => void
  onConfirm: () => void
}

/**
 * 导入 JSON 配置的预览确认弹窗。
 * 导入是信任边界：先把「新增 / 更新 / 跳过」的数量和明细摆出来，用户确认后才落库。
 */
export function HostImportPreviewModal({ preview, onClose, onConfirm }: Props) {
  const t = useT()
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
    <Modal onClose={onClose} className="sshconfig-modal">
      <header className="modal-header">
        <div className="modal-title"><Icon name="database" size={17} />{t('导入主机配置预览')}</div>
        <button className="modal-close" onClick={onClose} disabled={busy}><Icon name="x" size={15} /></button>
      </header>
      <div className="modal-body">
        <p className="section-tip">
          {t('共 ')}{preview.items.length}{t(' 条有效配置：新增 ')}{fresh}{t(' 条，更新已有 ')}{overwritten}{t(' 条。')}
          {preview.invalidCount > 0 && ` ${preview.invalidCount} ${t('条无效配置（缺少地址/用户名或端口无效）将被跳过。')}`}
          {t('已存在的同 主机+端口+用户名 配置会被覆盖更新，凭据不随导入写入。')}
        </p>
        <div className="sshconfig-list">
          {preview.items.map((item) => (
            <div className="sshconfig-row" key={item.profile.id + (item.duplicateOf?.id ?? '')}>
              <span className="sshconfig-name">{item.profile.name || `${item.profile.username}@${item.profile.host}`}</span>
              <span className="sshconfig-meta">
                {item.profile.username}@{item.profile.host}:{item.profile.port}
                {item.profile.group ? ` · ${t('分组 ')}${item.profile.group}` : ''}
                {item.profile.tags.length ? ` · ${item.profile.tags.join('、')}` : ''}
              </span>
              {item.duplicateOf ? <span className="sshconfig-dup">{t('更新')}</span> : <span className="sshconfig-new">{t('新增')}</span>}
            </div>
          ))}
        </div>
      </div>
      <footer className="modal-footer">
        <button className="glass-btn" onClick={onClose} disabled={busy}>{t('取消')}</button>
        <button className="glass-btn primary" onClick={() => void confirm()} disabled={busy}>
          {busy ? t('导入中…') : t('确认导入（') + preview.items.length + t('）')}
        </button>
      </footer>
    </Modal>
  )
}
