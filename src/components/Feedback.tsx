import { useEffect, useState } from 'react'
import { Icon, IconName } from '../components/Icon'
import { Modal } from '../components/Modal'
import { useUiFeedback, ToastKind } from '../store/ui'
import { useVault } from '../store/vault'
import { useT } from '../i18n'
import { errorText } from '../i18n/errors'

const TOAST_ICONS: Record<ToastKind, IconName> = {
  info: 'terminal',
  success: 'save',
  error: 'x',
  warning: 'monitor'
}

export function FeedbackHost() {
  const t = useT()
  const confirmRequest = useUiFeedback((state) => state.confirmRequest)
  const resolveConfirm = useUiFeedback((state) => state.resolveConfirm)
  const vaultUnlockRequest = useUiFeedback((state) => state.vaultUnlockRequest)
  const resolveVaultUnlock = useUiFeedback((state) => state.resolveVaultUnlock)
  const toasts = useUiFeedback((state) => state.toasts)
  const dismissToast = useUiFeedback((state) => state.dismissToast)
  const unlock = useVault((state) => state.unlock)
  const [vaultPassword, setVaultPassword] = useState('')
  const [vaultError, setVaultError] = useState<string | null>(null)
  const [vaultBusy, setVaultBusy] = useState(false)

  useEffect(() => {
    if (!vaultUnlockRequest) return
    setVaultPassword('')
    setVaultError(null)
    setVaultBusy(false)
  }, [vaultUnlockRequest])

  const submitVaultUnlock = async () => {
    if (!vaultPassword) {
      setVaultError(t('请输入主密码'))
      return
    }
    setVaultBusy(true)
    setVaultError(null)
    try {
      await unlock(vaultPassword)
      setVaultPassword('')
      resolveVaultUnlock(true)
    } catch (error) {
      setVaultError(errorText(error, t, '保险箱操作失败'))
    } finally {
      setVaultBusy(false)
    }
  }

  return (
    <>
      {vaultUnlockRequest && (
        <Modal
          className="vault-unlock-modal"
          ariaLabel={t('解锁凭据保险箱')}
          closeOnOverlayClick={false}
          onClose={() => resolveVaultUnlock(false)}
        >
            <header className="modal-header">
              <div className="modal-title"><Icon name="key" size={17} />{t('解锁凭据保险箱')}</div>
            </header>
            <div className="modal-body">
              <p className="section-tip">{t('连接需要读取保险箱中的凭据，请输入主密码继续。')}</p>
              <label className="field">
                <span className="field-label">{t('主密码')}</span>
                <input
                  className="glass-input"
                  type="password"
                  value={vaultPassword}
                  onChange={(event) => setVaultPassword(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter' && !vaultBusy) void submitVaultUnlock() }}
                  autoFocus
                  autoComplete="current-password"
                />
              </label>
              {vaultError && <div className="form-error">{vaultError}</div>}
            </div>
            <footer className="modal-footer">
              <button className="glass-btn" onClick={() => resolveVaultUnlock(false)} disabled={vaultBusy}>{t('取消')}</button>
              <button className="glass-btn primary" onClick={() => void submitVaultUnlock()} disabled={vaultBusy || !vaultPassword}>
                <Icon name="key" size={15} />
                {vaultBusy ? t('处理中…') : t('解锁保险箱')}
              </button>
            </footer>
        </Modal>
      )}
      {confirmRequest && (
        <Modal
          className="confirm-modal"
          role={confirmRequest.danger ? 'alertdialog' : 'dialog'}
          ariaLabel={confirmRequest.title}
          closeOnOverlayClick={false}
          onClose={() => resolveConfirm(false)}
        >
            <header className="modal-header">
              <div className={`modal-title ${confirmRequest.danger ? 'host-key-danger' : ''}`}>
                <Icon name={confirmRequest.danger ? 'x' : 'settings'} size={17} />
                {confirmRequest.title}
              </div>
            </header>
            <div className="modal-body">
              <p className="section-tip">{confirmRequest.message}</p>
            </div>
            <footer className="modal-footer">
              <button className="glass-btn" onClick={() => resolveConfirm(false)}>
                {confirmRequest.cancelLabel ?? t('取消')}
              </button>
              <button
                className={`glass-btn ${confirmRequest.danger ? 'danger' : 'primary'}`}
                onClick={() => resolveConfirm(true)}
                /* 危险操作不默认聚焦确认键：焦点落在「取消」上，避免回车误确认 */
                autoFocus={!confirmRequest.danger}
              >
                {confirmRequest.confirmLabel ?? t('确认')}
              </button>
            </footer>
        </Modal>
      )}
      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div className={`toast glass toast-${toast.kind}`} key={toast.id}>
              <Icon name={TOAST_ICONS[toast.kind]} size={15} />
              <span>{toast.message}</span>
              <button className="toast-close" onClick={() => dismissToast(toast.id)} title={t('关闭')}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
