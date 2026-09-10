import { useEffect, useId, useRef } from 'react'

/**
 * 通用弹窗容器。
 *
 * 统一处理此前各弹窗各自缺失的键盘与无障碍行为：
 * - 打开时把焦点移入弹窗，关闭后归还给触发它的元素
 * - Escape 关闭
 * - Tab / Shift+Tab 焦点锁定在弹窗内，不会穿透到遮罩后的界面
 * - `role="dialog"` + `aria-modal`，标题通过 `aria-labelledby` 关联
 *
 * 只负责容器与行为，内部结构（header / body / footer）仍由调用方提供，
 * 因此可平滑替换现有 `.modal-overlay` + `.modal` 写法。
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/**
 * 当前打开的弹窗栈。弹窗可以叠加（例如在连接对话框之上再弹出保险箱解锁），
 * 此时只有栈顶弹窗接管 Escape 与焦点锁定，否则两层会互相把焦点抢回去。
 */
const modalStack: HTMLElement[] = []

function isTopmost(container: HTMLElement): boolean {
  return modalStack[modalStack.length - 1] === container
}

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement
  )
}

export interface ModalProps {
  onClose: () => void
  children: React.ReactNode
  /** 追加到 `.modal` 的类名，用于宽度等差异化样式 */
  className?: string
  /** 弹窗用途，确认类弹窗可传 `alertdialog` */
  role?: 'dialog' | 'alertdialog'
  /** 是否允许 Escape 关闭，默认允许 */
  closeOnEscape?: boolean
  /** 是否允许点击遮罩关闭，默认允许 */
  closeOnOverlayClick?: boolean
  /** 关联标题元素 id；传入后由调用方在标题上设置同名 id */
  labelledBy?: string
  /** 无可见标题时的无障碍名称 */
  ariaLabel?: string
}

export function Modal({
  onClose,
  children,
  className,
  role = 'dialog',
  closeOnEscape = true,
  closeOnOverlayClick = true,
  labelledBy,
  ariaLabel
}: ModalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fallbackId = useId()
  const titleId = labelledBy ?? fallbackId
  // 用 ref 保存最新回调，避免每次渲染都重建监听器而打断焦点
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const previous = document.activeElement as HTMLElement | null
    modalStack.push(container)

    // 若调用方用了 autoFocus，React 已在提交阶段把焦点放进弹窗，此时必须尊重它，
    // 否则会被下面的「聚焦首个可聚焦元素」（通常是右上角关闭按钮）覆盖掉。
    const current = document.activeElement
    const alreadyInside = current instanceof Node && container.contains(current)
    if (!alreadyInside) {
      // 优先聚焦首个可聚焦元素；没有则聚焦容器本身，保证键盘事件有落点
      const initial = focusableWithin(container)[0]
      if (initial) {
        initial.focus()
      } else {
        container.focus()
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost(container)) return
      if (event.key === 'Escape' && closeOnEscape) {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusables = focusableWithin(container)
      if (focusables.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      const inside = active instanceof Node && container.contains(active)
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault()
          last.focus()
        }
      } else if (!inside || active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    // 兜底：鼠标点击或程序化聚焦把焦点移出弹窗时拉回来
    const onFocusIn = (event: FocusEvent) => {
      if (!isTopmost(container)) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (container.contains(target)) return
      const focusables = focusableWithin(container)
      const next = focusables[0] ?? container
      next.focus()
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      const index = modalStack.lastIndexOf(container)
      if (index >= 0) modalStack.splice(index, 1)
      // 关闭后把焦点交还触发按钮，键盘用户不会丢失位置。
      // 若上层还有弹窗在栈中，则交给它接管焦点（上一层会在自己的清理逻辑里恢复）。
      if (modalStack.length === 0 && previous && document.contains(previous)) {
        previous.focus()
      }
    }
  }, [closeOnEscape])

  return (
    <div
      className="modal-overlay"
      onClick={() => {
        if (closeOnOverlayClick) onCloseRef.current()
      }}
    >
      <div
        ref={containerRef}
        className={`modal glass ${className ?? ''}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-label={ariaLabel}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
