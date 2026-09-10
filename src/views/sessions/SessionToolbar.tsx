import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { CommandSnippet } from '../../types/snippet'

interface Props {
  snippets: CommandSnippet[]
  snippetId: string
  broadcastEnabled: boolean
  connectedCount: number
  splitActive: boolean
  tabCount: number
  activeId: number | null
  onSelectSnippet: (id: string) => void
  onSendSnippet: () => void
  onOpenBulk: () => void
  onToggleBroadcast: () => void
  onToggleSplit: () => void
  onExportLog: () => void
}

/** 会话页工具条：片段下发、批量下发、广播、分屏、导出日志。 */
export function SessionToolbar({
  snippets,
  snippetId,
  broadcastEnabled,
  connectedCount,
  splitActive,
  tabCount,
  activeId,
  onSelectSnippet,
  onSendSnippet,
  onOpenBulk,
  onToggleBroadcast,
  onToggleSplit,
  onExportLog
}: Props) {
  const t = useT()
  return (
    <div
      className="session-tool"
      title={t('快捷键：Ctrl+1..9 切换标签 · Ctrl+Tab 循环 · Ctrl+W 关闭 · Ctrl+Shift+W 断开并关闭 · Ctrl+T 新建连接 · Ctrl+F 终端搜索')}
    >
      <div className="snippet-toolbar">
        <Icon name="terminal" size={15} />
        <select
          className="glass-input snippet-select"
          value={snippetId}
          onChange={(event) => onSelectSnippet(event.target.value)}
        >
          <option value="">{t('选择命令片段')}</option>
          {snippets.map((snippet) => (
            <option key={snippet.id} value={snippet.id}>{snippet.name}</option>
          ))}
        </select>
        <button
          className="glass-btn"
          onClick={onSendSnippet}
          disabled={!snippetId || activeId === null}
          title={t('发送命令片段')}
        >
          {t('发送')}
        </button>
        <button className="glass-btn" onClick={onOpenBulk} title={t('向所有已连接会话发送命令')}>
          {t('批量下发')}
        </button>
        <button
          className={`glass-btn ${broadcastEnabled ? 'primary' : ''}`}
          onClick={onToggleBroadcast}
          disabled={!connectedCount}
          title={t('开启后，在当前终端键入的每个字符都会实时同步到勾选的会话')}
        >
          <Icon name="broadcast" size={14} />
          {t('广播输入')}
        </button>
        <button
          className={`glass-btn ${splitActive ? 'primary' : ''}`}
          onClick={onToggleSplit}
          disabled={tabCount < 2}
          title={splitActive ? t('退出分屏，恢复单终端布局') : t('将另一个会话的终端与当前终端左右并排显示')}
        >
          <Icon name="columns" size={14} />
          {t('分屏')}
        </button>
        <button className="glass-btn" onClick={onExportLog} disabled={activeId === null} title={t('导出当前会话最近 2 MB 输出')}>
          <Icon name="save" size={14} />
          {t('保存日志')}
        </button>
      </div>
    </div>
  )
}
