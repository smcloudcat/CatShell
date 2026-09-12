import { ChangeEvent } from 'react'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { SFTP_SORT_LABELS, SftpSortKey } from './sftpUtils'

/** 工具栏区（工具条 + 路径栏 + 过滤栏）的状态，组件内只读。 */
export interface SftpToolbarState {
  path: string
  busy: boolean
  sortKey: SftpSortKey
  sortAsc: boolean
  showHidden: boolean
  nameFilter: string
}

/** 工具栏区的回调集合，聚合传参避免十几个平铺 props。 */
export interface SftpToolbarActions {
  refresh: () => void
  createDirectory: () => void
  upload: (files: File[]) => void
  diskUpload: () => void
  openSync: () => void
  goParent: () => void
  openInTerminal: () => void
  changeSortKey: (key: SftpSortKey) => void
  toggleSortDirection: () => void
  toggleHidden: () => void
  changeFilter: (value: string) => void
  collapse?: (() => void) | undefined
}

interface Props {
  state: SftpToolbarState
  actions: SftpToolbarActions
}

/** SFTP 面板顶部两栏：操作按钮、路径与筛选（合并行）。 */
export function SftpToolbar({ state, actions }: Props) {
  const t = useT()
  const { path, busy, sortKey, sortAsc, showHidden, nameFilter } = state

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    // 先清空 value，否则连续选择同一个文件不会再触发 change。
    event.target.value = ''
    actions.upload(files)
  }

  return (
    <>
      <div className="sftp-toolbar">
        <Icon name="folder" size={15} />
        <span className="sftp-heading">{t('SFTP 文件')}</span>
        {actions.collapse && (
          <button className="host-icon-btn" onClick={actions.collapse} title={t('折叠面板')}>
            <Icon name="chevron-down" size={14} />
          </button>
        )}
        <button className="glass-btn" onClick={actions.refresh} disabled={busy} title={t('刷新目录')}>
          <Icon name="refresh" size={15} />
        </button>
        <button className="glass-btn" onClick={actions.createDirectory} title={t('新建目录')}>
          <Icon name="plus" size={15} />
        </button>
        <label className="glass-btn primary">
          <Icon name="upload" size={15} />
          {t('上传文件')}
          <input className="sr-only" type="file" multiple onChange={handleUpload} disabled={busy} />
        </label>
        <button
          className="glass-btn"
          onClick={actions.diskUpload}
          disabled={busy}
          title={t('磁盘级上传：本地文件经 Rust 直传远端，支持断点续传')}
        >
          <Icon name="save" size={15} />
        </button>
        <button
          className="glass-btn"
          onClick={actions.openSync}
          disabled={busy}
          title={t('目录同步（单向）：按差异清单把本地目录与远程目录对齐')}
        >
          <Icon name="sync" size={15} />
        </button>
      </div>
      {/* 路径 + 筛选合并为一行（宽面板单行紧凑，窄面板自动换行） */}
      <div className="sftp-pathbar">
        <button
          className="host-icon-btn"
          onClick={actions.goParent}
          disabled={path === '/'}
          title={t('返回上级')}
        >
          <Icon name="chevron-down" size={15} />
        </button>
        <code title={path}>{path}</code>
        <button
          className="host-icon-btn"
          onClick={actions.openInTerminal}
          title={t('在终端中打开此目录（发送 cd 命令）')}
        >
          <Icon name="terminal" size={15} />
        </button>
        <select
          className="glass-input sftp-sort-select"
          value={sortKey}
          onChange={(event) => actions.changeSortKey(event.target.value as SftpSortKey)}
          title={t('排序方式')}
        >
          {(Object.keys(SFTP_SORT_LABELS) as SftpSortKey[]).map((key) => (
            <option key={key} value={key}>{t(SFTP_SORT_LABELS[key])}</option>
          ))}
        </select>
        <button
          className="host-icon-btn"
          onClick={actions.toggleSortDirection}
          title={sortAsc ? t('当前升序，点击切换为降序') : t('当前降序，点击切换为升序')}
        >
          <Icon name={sortAsc ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>
        <button
          className={`host-icon-btn ${showHidden ? 'active' : ''}`}
          onClick={actions.toggleHidden}
          title={showHidden ? t('显示隐藏文件中，点击隐藏') : t('显示以 . 开头的隐藏文件')}
        >
          <Icon name={showHidden ? 'eye' : 'eye-off'} size={14} />
        </button>
        <input
          className="glass-input sftp-filter-input"
          placeholder={t('筛选当前目录')}
          value={nameFilter}
          onChange={(event) => actions.changeFilter(event.target.value)}
        />
      </div>
    </>
  )
}
