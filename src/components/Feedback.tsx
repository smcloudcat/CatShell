import { Icon, IconName } from '../components/Icon'
import { useUiFeedback, ToastKind } from '../store/ui'

const TOAST_ICONS: Record<ToastKind, IconName> = {
  info: 'terminal',
  success: 'save',
  error: 'x',
  warning: 'monitor'
}

export function FeedbackHost() {
  const confirmRequest = useUiFeedback((state) => state.confirmRequest)
  const resolveConfirm = useUiFeedback((state) => state.resolveConfirm)
  const toasts = useUiFeedback((state) => state.toasts)
  const dismissToast = useUiFeedback((state) => state.dismissToast)

  return (
    <>
      {confirmRequest && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal glass confirm-modal">
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
                {confirmRequest.cancelLabel ?? '取消'}
              </button>
              <button
                className={`glass-btn ${confirmRequest.danger ? 'danger' : 'primary'}`}
                onClick={() => resolveConfirm(true)}
                autoFocus
              >
                {confirmRequest.confirmLabel ?? '确认'}
              </button>
            </footer>
          </div>
        </div>
      )}
      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div className={`toast glass toast-${toast.kind}`} key={toast.id}>
              <Icon name={TOAST_ICONS[toast.kind]} size={15} />
              <span>{toast.message}</span>
              <button className="toast-close" onClick={() => dismissToast(toast.id)} title="关闭">
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}