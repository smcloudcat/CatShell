import { Icon } from '../../components/Icon'
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

interface Props {
  /** 已按排序与筛选规则处理过的可见项。 */
  entries: SftpEntry[]
  /** 未筛选的原始数量，用于区分「目录为空」与「没有匹配的文件」。 */
  totalCount: number
  busy: boolean
  actions: SftpEntryActions
}

/** SFTP 目录项表格：表头 + 行列表 + 空状态。 */
export function SftpEntryList({ entries, totalCount, busy, actions }: Props) {
  const t = useT()

  const kindLabel = (entry: SftpEntry): string =>
    entry.kind === 'directory' ? t('目录') : entry.kind === 'symlink' ? t('链接') : t('文件')

  return (
    <>
      <div className="sftp-table-head">
        <span>{t('名称')}</span>
        <span>{t('类型')}</span>
        <span>{t('大小')}</span>
        <span>{t('操作')}</span>
      </div>
      <div className="sftp-entries">
        {entries.map((entry) => (
          <div className="sftp-entry" key={entry.path}>
            <button
              className="sftp-name"
              onClick={() => entry.kind === 'directory' ? actions.open(entry) : actions.download(entry)}
            >
              <Icon name={entry.kind === 'directory' ? 'folder' : 'save'} size={15} />
              <span>{entry.name}</span>
            </button>
            <span title={entryTitle(entry)}>{kindLabel(entry)}</span>
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
        ))}
        {!busy && entries.length === 0 && (
          <div className="sftp-empty">{totalCount ? t('没有匹配的文件') : t('目录为空')}</div>
        )}
        {busy && <div className="sftp-empty">{t('读取中…')}</div>}
      </div>
    </>
  )
}
