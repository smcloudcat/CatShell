import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { getSessionLog, useSessions } from '../../store/sessions'
import { TerminalPane } from './TerminalPane'
import { SessionSftpPanel } from './SessionSftpPanel'
import { SessionMonitorPanel } from './SessionMonitorPanel'
import { SessionTabBar } from './SessionTabBar'
import { SessionToolbar } from './SessionToolbar'
import { BroadcastBar } from './BroadcastBar'
import { BulkCommandDialog } from './BulkCommandDialog'
import { SnippetParamDialog } from './SnippetParamDialog'
import { useSessionPanelResize } from './usePanelResize'
import { cleanTerminalLog, sessionLogFileName } from './sessionViewUtils'
import { useSnippets } from '../../store/snippets'
import { useSettings } from '../../store/settings'
import { recordAudit } from '../../store/audit'
import { confirmDialog, showToast } from '../../store/ui'
import { CommandSnippet, getSnippetParameters, renderCommandTemplate } from '../../types/snippet'
import { useT } from '../../i18n'
import { errorText } from '../../i18n/errors'

/**
 * 会话工作区。
 *
 * 纯函数在 `sessionViewUtils`，面板尺寸在 `usePanelResize`，
 * 标签栏 / 工具条 / 广播条 / 两个弹窗各自成组件；
 * 这里保留会话编排、片段下发、批量与日志导出等业务逻辑。
 */
export function SessionsView() {
  const t = useT()
  const sessions = useSessions((s) => s.sessions)
  const order = useSessions((s) => s.order)
  const activeId = useSessions((s) => s.activeId)
  const splitId = useSessions((s) => s.splitId)
  const connectedAt = useSessions((s) => s.connectedAt)
  const init = useSessions((s) => s.init)
  const setActive = useSessions((s) => s.setActive)
  const setSplit = useSessions((s) => s.setSplit)
  const closeTab = useSessions((s) => s.closeTab)
  const disconnect = useSessions((s) => s.disconnect)
  const reconnect = useSessions((s) => s.reconnect)
  const write = useSessions((s) => s.write)
  const renameSession = useSessions((s) => s.renameSession)
  const broadcastEnabled = useSessions((s) => s.broadcastEnabled)
  const broadcastTargets = useSessions((s) => s.broadcastTargets)
  const setBroadcastEnabled = useSessions((s) => s.setBroadcastEnabled)
  const toggleBroadcastTarget = useSessions((s) => s.toggleBroadcastTarget)
  const snippets = useSnippets((s) => s.snippets)
  const snippetsInit = useSnippets((s) => s.init)
  const sessionPanels = useSettings((s) => s.sessionPanels)
  const setSessionPanelCollapsed = useSettings((s) => s.setSessionPanelCollapsed)

  const { monitorWidth, sftpHeight, startResize } = useSessionPanelResize()

  const [snippetId, setSnippetId] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkCommand, setBulkCommand] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResult, setBulkResult] = useState<string | null>(null)
  const [snippetPrompt, setSnippetPrompt] = useState<CommandSnippet | null>(null)
  const [snippetValues, setSnippetValues] = useState<Record<string, string>>({})
  const [snippetError, setSnippetError] = useState<string | null>(null)
  const [, setDurationTick] = useState(0)

  useEffect(() => {
    void init()
    void snippetsInit()
  }, [init, snippetsInit])

  // 在线时长按分钟粒度展示，30 秒重渲染一次足够，不必每个标签各起一个定时器。
  // 依赖必须收敛成布尔值：直接依赖 order / sessions 会因每次状态刷新都换引用而反复重建
  // 定时器，导致 30 秒的间隔永远等不到触发。
  const hasConnectedSession = order.some((id) => sessions[id]?.status === 'connected')
  useEffect(() => {
    if (!hasConnectedSession) return
    const timer = window.setInterval(() => setDurationTick((value) => value + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [hasConnectedSession])

  const connectedSessions = order.filter((id) => sessions[id]?.status === 'connected')
  const broadcastActiveCount = broadcastTargets.filter((id) => sessions[id]?.status === 'connected').length
  const allBroadcastSelected = connectedSessions.length > 0 && connectedSessions.every((id) => broadcastTargets.includes(id))

  // 只为可见会话挂载终端实例。xterm 携带 WebGL/Canvas 与多个 addon，
  // 让全部会话常驻会随标签数量线性推高内存与 CPU 占用；
  // 切换标签时由 TerminalPane 回放会话日志恢复滚动内容。
  const visibleTerminalIds = order.filter((id) => id === activeId || (splitId !== null && id === splitId))

  // ----------------------------------------------------------------
  // 标签操作
  // ----------------------------------------------------------------

  const handleSelectTab = (id: number) => setActive(id)

  const handleReconnect = (id: number) => {
    reconnect(id).catch((err: unknown) => showToast(errorText(err, t, '重连请求失败，请稍后重试'), 'error'))
  }

  /** 关闭标签前先断开连接，避免后端会话在标签消失后继续存活。 */
  const handleCloseTab = (id: number) => {
    const status = sessions[id]?.status
    if (status === 'connected' || status === 'connecting' || status === 'reconnecting') {
      void disconnect(id)
    }
    void closeTab(id)
  }

  const handleRename = (id: number, name: string) => {
    // renameSession 是纯内存更新，同步抛错即可，无需 Promise 链
    try {
      renameSession(id, name)
      recordAudit('session.rename', name, 'success', '重命名会话标签')
    } catch (err: unknown) {
      showToast(errorText(err, t, '重命名失败'), 'error')
    }
  }

  const toggleSplit = () => {
    if (splitId !== null) {
      setSplit(null)
      return
    }
    if (activeId === null) return
    const candidate = order.find((id) => id !== activeId)
    if (candidate === undefined) return
    setSplit(candidate)
  }

  // ----------------------------------------------------------------
  // 命令片段
  // ----------------------------------------------------------------

  const sendRenderedSnippet = async (snippet: CommandSnippet, command: string) => {
    if (activeId === null) return
    setSnippetError(null)
    try {
      await write(activeId, new TextEncoder().encode(`${command}\n`))
      recordAudit('snippet.send', snippet.name, 'success', t('向当前会话发送命令模板'))
      setSnippetId('')
      setSnippetPrompt(null)
    } catch (error) {
      recordAudit('snippet.send', snippet.name, 'failure', t('向当前会话发送命令模板失败'))
      setSnippetError(errorText(error, t, '发送命令模板失败'))
    }
  }

  const sendSnippet = async () => {
    if (activeId === null || !snippetId) return
    const snippet = snippets.find((item) => item.id === snippetId)
    if (!snippet) return
    // 含占位符的模板先弹窗收集参数，其余直接下发。
    if (getSnippetParameters(snippet.command).length > 0) {
      setSnippetError(null)
      setSnippetValues(Object.fromEntries(getSnippetParameters(snippet.command).map((name) => [name, ''])))
      setSnippetPrompt(snippet)
      return
    }
    await sendRenderedSnippet(snippet, snippet.command)
  }

  const confirmSnippet = async () => {
    if (!snippetPrompt) return
    const parameters = getSnippetParameters(snippetPrompt.command)
    if (parameters.some((name) => !snippetValues[name]?.trim())) {
      setSnippetError(t('请填写全部模板参数'))
      return
    }
    await sendRenderedSnippet(snippetPrompt, renderCommandTemplate(snippetPrompt.command, snippetValues))
  }

  // ----------------------------------------------------------------
  // 批量下发与日志导出
  // ----------------------------------------------------------------

  const sendBulkCommand = async () => {
    const command = bulkCommand.trim()
    if (!command) return
    const targets = order.filter((id) => sessions[id]?.status === 'connected')
    if (!targets.length) {
      setBulkResult(t('没有已连接的目标会话'))
      return
    }
    if (!(await confirmDialog({
      title: t('批量下发命令'),
      message: t('将向 ') + targets.length + t(' 台服务器发送此命令，是否继续？'),
      confirmLabel: t('确认发送'),
      danger: true
    }))) return
    setBulkBusy(true)
    setBulkResult(null)
    let success = 0
    for (const id of targets) {
      try {
        await write(id, new TextEncoder().encode(`${command}\n`))
        success += 1
      } catch {
        // 单台失败不影响其余目标，继续下发。
      }
    }
    recordAudit('command.bulk-send', `${success}/${targets.length}`, success === targets.length ? 'success' : 'failure', t('批量发送命令'))
    setBulkResult(t('已发送 ') + success + '/' + targets.length + t(' 个会话'))
    setBulkBusy(false)
  }

  const exportSessionLog = () => {
    if (activeId === null) return
    const info = sessions[activeId]
    const data = getSessionLog(activeId)
    if (!info || !data.length) {
      setSnippetError(t('当前会话还没有可导出的输出'))
      return
    }
    const text = cleanTerminalLog(new TextDecoder().decode(data))
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = sessionLogFileName(info.name, info.host)
    anchor.click()
    URL.revokeObjectURL(url)
    recordAudit('session.log-export', `${info.name} (${info.host}:${info.port})`, 'success', '导出当前会话最近 2 MB 输出')
  }

  const selectAllBroadcastTargets = () => {
    connectedSessions.forEach((id) => {
      if (!broadcastTargets.includes(id)) toggleBroadcastTarget(id)
    })
  }

  if (order.length === 0) {
    return (
      <div className="view">
        <header className="view-header">
          <div>
            <div className="view-title">{t('会话')}</div>
            <div className="view-subtitle">{t('多个 SSH 终端标签，密码或私钥认证')}</div>
          </div>
        </header>
        <section className="glass empty-state">
          <div className="empty-icon">
            <Icon name="terminal" size={44} />
          </div>
          <div className="empty-title">{t('还没有活动会话')}</div>
          <div className="empty-desc">
            {t('前往「主机」页点击「新建连接」，或在主机列表点击「连接」，即可在此处打开终端标签。')}
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="view sessions-view">
      <SessionTabBar
        ids={order}
        sessions={sessions}
        activeId={activeId}
        connectedAt={connectedAt}
        onSelect={handleSelectTab}
        onReconnect={handleReconnect}
        onCloseTab={handleCloseTab}
        onRename={handleRename}
      />
      <SessionToolbar
        snippets={snippets}
        snippetId={snippetId}
        broadcastEnabled={broadcastEnabled}
        connectedCount={connectedSessions.length}
        splitActive={splitId !== null}
        tabCount={order.length}
        activeId={activeId}
        onSelectSnippet={setSnippetId}
        onSendSnippet={() => void sendSnippet()}
        onOpenBulk={() => setBulkOpen(true)}
        onToggleBroadcast={() => setBroadcastEnabled(!broadcastEnabled)}
        onToggleSplit={toggleSplit}
        onExportLog={exportSessionLog}
      />
      {snippetError && <div className="form-error">{snippetError}</div>}
      {bulkResult && <div className="form-notice">{bulkResult}</div>}
      {broadcastEnabled && (
        <BroadcastBar
          connectedIds={connectedSessions}
          sessions={sessions}
          targets={broadcastTargets}
          activeCount={broadcastActiveCount}
          allSelected={allBroadcastSelected}
          onToggleTarget={toggleBroadcastTarget}
          onSelectAll={selectAllBroadcastTargets}
          onDisable={() => setBroadcastEnabled(false)}
        />
      )}
      <div className="session-workspace">
        <div className={`terminal-stack ${splitId !== null ? 'split' : ''}`}>
          {visibleTerminalIds.map((id) => (
            <TerminalPane
              key={id}
              id={id}
              active={activeId === id || splitId === id}
              splitRole={splitId === null ? 'none' : id === activeId ? 'left' : id === splitId ? 'right' : 'none'}
            />
          ))}
        </div>
        {splitId !== null && sessions[splitId] && (
          <div className="split-bar glass">
            <span className="split-label" title={sessions[splitId]?.host}>
              <Icon name="columns" size={13} />
              {t('右侧：')}{sessions[splitId]?.name}
            </span>
            <button className="host-icon-btn" onClick={() => setSplit(null)} title={t('退出分屏')}>
              <Icon name="x" size={13} />
            </button>
          </div>
        )}
        {activeId !== null && sessionPanels.monitorCollapsed && (
          <aside className="session-panel-rail">
            <button
              className="panel-rail-btn"
              onClick={() => void setSessionPanelCollapsed('monitor', false)}
              title={t('展开监控面板')}
            >
              <Icon name="monitor" size={15} />
              <span>{t('监控')}</span>
            </button>
          </aside>
        )}
        {activeId !== null && !sessionPanels.monitorCollapsed && (
          <>
            <div
              className="session-resize-handle session-resize-horizontal"
              onPointerDown={(event) => startResize('monitor', event)}
              title={t('拖动调整监控面板宽度')}
            />
            <aside className="session-monitor-panel" style={{ flexBasis: `${monitorWidth}px`, width: `${monitorWidth}px` }}>
              <SessionMonitorPanel
                key={activeId}
                sessionId={activeId}
                onCollapse={() => void setSessionPanelCollapsed('monitor', true)}
              />
            </aside>
          </>
        )}
      </div>
      {activeId !== null && sessionPanels.sftpCollapsed && (
        <div className="session-sftp-rail">
          <button
            className="panel-rail-btn"
            onClick={() => void setSessionPanelCollapsed('sftp', false)}
            title={t('展开 SFTP 面板')}
          >
            <Icon name="folder" size={15} />
            <span>{t('SFTP 文件')}</span>
          </button>
        </div>
      )}
      {activeId !== null && !sessionPanels.sftpCollapsed && (
        <>
          <div
            className="session-resize-handle session-resize-vertical"
            onPointerDown={(event) => startResize('sftp', event)}
            title={t('拖动调整 SFTP 面板高度')}
          />
          <div className="session-sftp-panel" style={{ flexBasis: `${sftpHeight}px`, height: `${sftpHeight}px` }}>
            <SessionSftpPanel
              key={activeId}
              sessionId={activeId}
              onCollapse={() => void setSessionPanelCollapsed('sftp', true)}
            />
          </div>
        </>
      )}
      {bulkOpen && (
        <BulkCommandDialog
          value={bulkCommand}
          busy={bulkBusy}
          onChange={setBulkCommand}
          onClose={() => setBulkOpen(false)}
          onSubmit={() => void sendBulkCommand()}
        />
      )}
      {snippetPrompt && (
        <SnippetParamDialog
          snippet={snippetPrompt}
          values={snippetValues}
          onChange={setSnippetValues}
          onClose={() => setSnippetPrompt(null)}
          onSubmit={() => void confirmSnippet()}
        />
      )}
    </div>
  )
}
