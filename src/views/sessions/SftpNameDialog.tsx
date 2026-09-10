import { Icon, IconName } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { SftpEntry } from '../../types/session'
import { useT } from '../../i18n'
import { isValidRemoteName } from './sftpUtils'

export type SftpNameMode = 'mkdir' | 'rename' | 'move'

/** mkdir / rename / move 三种操作共用同一套弹窗状态。 */
export interface SftpNameDialogState {
  mode: SftpNameMode
  /** mkdir 时为 null；rename / move 指向被操作项。 */
  target: SftpEntry | null
  value: string
}

const MODE_ICON: Record<SftpNameMode, IconName> = {
  mkdir: 'plus',
  rename: 'edit',
  move: 'arrow-right'
}

interface Props {
  state: SftpNameDialogState
  /** mkdir 提示语里要显示的当前目录。 */
  currentPath: string
  busy: boolean
  onChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}

/**
 * 新建目录 / 重命名 / 移动到其他目录的三合一弹窗。
 *
 * 三种模式的差异只在标题、提示语、输入含义（名称 vs 目标路径）和确认按钮文案上，
 * 因此合并为一个组件、用 mode 分派，好过三份几乎相同的 JSX。
 */
export function SftpNameDialog({ state, currentPath, busy, onChange, onClose, onSubmit }: Props) {
  const t = useT()
  const name = state.target?.name ?? ''
  const title = state.mode === 'mkdir'
    ? t('新建远程目录')
    : state.mode === 'move'
      ? `${t('移动 ')}${name}`
      : `${t('重命名 ')}${name}`

  // move 的输入是绝对目录路径（必然含 `/`），不能套用「名称不含斜杠」的规则。
  const confirmDisabled = state.mode === 'move'
    ? busy || !state.value.trim()
    : busy || !isValidRemoteName(state.value)

  return (
    <Modal
      onClose={onClose}
      closeOnOverlayClick={!busy}
      closeOnEscape={!busy}
      ariaLabel={title}
    >
      <header className="modal-header">
        <div className="modal-title">
          <Icon name={MODE_ICON[state.mode]} size={17} />
          {title}
        </div>
        <button className="modal-close" onClick={onClose} disabled={busy} title={t('关闭')}>
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="modal-body">
        {state.mode === 'mkdir' && (
          <div className="section-tip">{t('将在当前目录 ')}{currentPath}{t(' 下创建新目录。')}</div>
        )}
        {state.mode === 'move' && (
          <div className="section-tip">{t('输入目标目录的绝对路径，文件将移动到该目录下并保持原文件名。')}</div>
        )}
        <label className="field">
          <span className="field-label">{state.mode === 'move' ? t('目标目录') : t('名称')}</span>
          <input
            className="glass-input"
            value={state.value}
            onChange={(event) => onChange(event.target.value)}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !confirmDisabled) void onSubmit()
            }}
          />
        </label>
      </div>
      <footer className="modal-footer">
        <button className="glass-btn" onClick={onClose} disabled={busy}>{t('取消')}</button>
        <button className="glass-btn primary" onClick={() => void onSubmit()} disabled={confirmDisabled}>
          {busy ? t('处理中…') : state.mode === 'move' ? t('移动') : t('确认')}
        </button>
      </footer>
    </Modal>
  )
}
