import type { ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { useT } from '../../i18n'

interface Props {
  title: string
  icon: 'terminal' | 'link' | 'settings'
  ariaLabel: string
  busy?: boolean
  /** 额外的弹窗样式类，例如片段参数弹窗需要更宽的排版。 */
  className?: string
  /** 弹窗主体，即各表单字段。 */
  children: ReactNode
  /** 底部按钮组，由调用方决定文案与禁用条件。 */
  footer: ReactNode
  onClose: () => void
}

/**
 * 会话页弹窗的统一外壳（标题栏 + 关闭按钮 + 主体 + 底栏）。
 *
 * 批量下发与片段参数两个弹窗除了正文和按钮外完全一致，
 * 抽成壳之后各自只保留业务字段，也顺带统一了 busy 时的关闭行为。
 */
export function SessionDialog({
  title,
  icon,
  ariaLabel,
  busy = false,
  className,
  children,
  footer,
  onClose
}: Props) {
  const t = useT()
  return (
    <Modal
      onClose={onClose}
      className={className}
      closeOnOverlayClick={!busy}
      closeOnEscape={!busy}
      ariaLabel={ariaLabel}
    >
      <header className="modal-header">
        <div className="modal-title">
          <Icon name={icon} size={17} />
          {title}
        </div>
        <button className="modal-close" onClick={onClose} disabled={busy} title={t('关闭')}>
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="modal-body">{children}</div>
      <footer className="modal-footer">{footer}</footer>
    </Modal>
  )
}
