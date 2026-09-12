import { memo } from 'react'
import { Icon } from '../../components/Icon'
import { useVirtualWindow } from '../../components/useVirtualWindow'
import { SftpEntry } from '../../types/session'
import { formatBytes } from '../../utils/format'
import { useT } from '../../i18n'
import { entryTitle } from './sftpUtils'

/** 目录项行上可触发的操作，全部由父组件编排副作用。 */
export interface SftpEntryActions {
  open: (entry: SftpEntry) => void
  download: (entry: SftpEntry) => void
  edit: (entry: SftpEntry) => void
  rename: (entry: SftpEntry) => void
  move: (entry: SftpEntry) => void
  chmod: (entry: SftpEntry) => void
  remove: (entry: SftpEntry) => void
}

/**
 * 行高（px），必须与 `.sftp-entry` 的实际占位一致。
 *
 * 全局 `box-sizing: border-box`（glass.css）下 `min-height: 42px` 已经把 padding
 * 与 border 都算进去了，所以实际行高就是 42，而不是「42 + 上下各 5px」（审计 P-1）。
 *
 * 窗口化要求行高固定：虚拟化时给行加显式高度，渲染结果与 `min-height` 一致
 * （内容同样被约束在 42px 内），但总高度可精确预测，不会累积滚动偏移。
 */
const ROW_HEIGHT = 42
/** 低于该行数时保持全量渲染：短列表不值得引入占位元素与滚动监听。 */
const VIRTUALIZE_MIN_ROWS = 120

interface RowProps {
  entry: SftpEntry
  actions: SftpEntryActions
  /** 窗口化时锁定行高；全量渲染时保持原有的 min-height 行为。 */
  fixedHeight: boolean
}

/** 单行目录项。`memo` 生效的前提是 `actions` 引用稳定（由父组件保证）。 */
const SftpEntryRow = memo(function SftpEntryRow({ entry, actions, fixedHeight }: RowProps) {
  const t = useT()
  const kindLabel = entry.kind === 'directory' ? t('目录') : entry.kind === 'symlink' ? t('链接') : t('文件')

  return (
    <div
      className="sftp-entry"
      style={fixedHeight ? { height: ROW_HEIGHT, boxSizing: 'border-box' } : undefined}
    >
      <button
        className="sftp-name"
        onClick={() => entry.kind === 'directory' ? actions.open(entry) : actions.download(entry)}
      >
        <Icon name={entry.kind === 'directory' ? 'folder' : 'save'} size={15} />
        <span>{entry.name}</span>
      </button>
      <span title={entryTitle(entry)}>{kindLabel}</span>
      <span>{entry.kind === 'file' ? formatBytes(entry.size) : '-'}</span>
      <span className="sftp-actions">
        {entry.kind === 'file' && (
          <button className="host-icon-btn" onClick={() => actions.download(entry)} title={t('下载')}>
            <Icon name="save" size={14} />
          </button>
        )}
        {entry.kind === 'file' && (
          <button className="host-icon-btn" onClick={() => actions.edit(entry)} title={t('编辑文本文件')}>
            <Icon name="settings" size={14} />
          </button>
        )}
        <button className="host-icon-btn" onClick={() => actions.rename(entry)} title={t('重命名')}>
          <Icon name="edit" size={14} />
        </button>
        <button className="host-icon-btn" onClick={() => actions.move(entry)} title={t('移动到其他目录')}>
          <Icon name="arrow-right" size={14} />
        </button>
        {(entry.kind === 'file' || entry.kind === 'directory') && entry.permissions !== null && (
          <button
            className="host-icon-btn"
            onClick={() => actions.chmod(entry)}
            title={t('修改权限（chmod）')}
          >
            <Icon name="key" size={14} />
          </button>
        )}
        <button
          className="host-icon-btn danger"
          onClick={() => actions.remove(entry)}
          title={entry.kind === 'directory' ? t('递归删除目录') : t('删除')}
        >
          <Icon name="trash" size={14} />
        </button>
      </span>
    </div>
  )
})

interface Props {
  /** 已按排序与筛选规则处理过的可见项。 */
  entries: SftpEntry[]
  /** 未筛选的原始数量，用于区分「目录为空」与「没有匹配的文件」。 */
  totalCount: number
  busy: boolean
  actions: SftpEntryActions
}

/**
 * SFTP 目录项表格：表头 + 行列表 + 空状态。
 *
 * 大目录（数千项）此前会一次性铺满 DOM，首次渲染与每次滚动都掉帧（P2-19）。
 * 超过阈值后改为按可视区间渲染，用上下占位元素撑出滚动条长度。
 */
export function SftpEntryList({ entries, totalCount, busy, actions }: Props) {
  const t = useT()
  const virtualize = entries.length > VIRTUALIZE_MIN_ROWS
  const { containerRef, window } = useVirtualWindow({
    itemCount: entries.length,
    itemHeight: ROW_HEIGHT,
    enabled: virtualize
  })

  const visible = entries.slice(window.start, window.end)

  return (
    <>
      <div className="sftp-table-head">
        <span>{t('名称')}</span>
        <span>{t('类型')}</span>
        <span>{t('大小')}</span>
        <span>{t('操作')}</span>
      </div>
      <div className="sftp-entries" ref={containerRef}>
        {window.virtualized && window.paddingTop > 0 && (
          <div style={{ height: window.paddingTop }} aria-hidden="true" />
        )}
        {visible.map((entry) => (
          <SftpEntryRow
            key={entry.path}
            entry={entry}
            actions={actions}
            fixedHeight={window.virtualized}
          />
        ))}
        {window.virtualized && window.paddingBottom > 0 && (
          <div style={{ height: window.paddingBottom }} aria-hidden="true" />
        )}
        {!busy && entries.length === 0 && (
          <div className="sftp-empty">{totalCount ? t('没有匹配的文件') : t('目录为空')}</div>
        )}
        {busy && <div className="sftp-empty">{t('读取中…')}</div>}
      </div>
    </>
  )
}
