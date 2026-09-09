import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { getSessionLog, useSessions } from '../../store/sessions'
import { STATUS_TEXT, SessionStatus } from '../../types/session'
import { TerminalPane } from './TerminalPane'
import { SessionSftpPanel } from './SessionSftpPanel'
import { SessionMonitorPanel } from './SessionMonitorPanel'
import { useSnippets } from '../../store/snippets'
import { useSettings } from '../../store/settings'
import { recordAudit } from '../../store/audit'
import { confirmDialog, showToast } from '../../store/ui'
import { CommandSnippet, getSnippetParameters, renderCommandTemplate } from '../../types/snippet'

export function SessionsView() {
  const sessions = useSessions((s) => s.sessions)
  const order = useSessions((s) => s.order)
  const activeId = useSessions((s) => s.activeId)
  const connectedAt = useSessions((s) => s.connectedAt)
  const init = useSessions((s) => s.init)
  const setActive = useSessions((s) => s.setActive)
  const closeTab = useSessions((s) => s.closeTab)
  const disconnect = useSessions((s) => s.disconnect)
  const reconnect = useSessions((s) => s.reconnect)
  const write = useSessions((s) => s.write)
  const snippets = useSnippets((s) => s.snippets)
  const snippetsInit = useSnippets((s) => s.init)
  const broadcastEnabled = useSessions((s) => s.broadcastEnabled)
  const broadcastTargets = useSessions((s) => s.broadcastTargets)
  const setBroadcastEnabled = useSessions((s) => s.setBroadcastEnabled)
  const toggleBroadcastTarget = useSessions((s) => s.toggleBroadcastTarget)
  const renameSession = useSessions((s) => s.renameSession)
  const sessionPanels = useSettings((s) => s.sessionPanels)
  const setSessionPanelCollapsed = useSettings((s) => s.setSessionPanelCollapsed)
  const [snippetId, setSnippetId] = useState('')
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)
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

  useEffect(() => {
    if (!order.some((id) => sessions[id]?.status === 'connected')) return
    const timer = window.setInterval(() => setDurationTick((value) => value + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [order, sessions])

  const sendRenderedSnippet = async (snippet: CommandSnippet, command: string) => {
    if (activeId === null) return
    setSnippetError(null)
    try {
      await write(activeId, new TextEncoder().encode(`${command}\n`))
      recordAudit('snippet.send', snippet.name, 'success', '向当前会话发送命令模板')
      setSnippetId('')
      setSnippetPrompt(null)
    } catch (error) {
      recordAudit('snippet.send', snippet.name, 'failure', '向当前会话发送命令模板失败')
      setSnippetError(error instanceof Error ? error.message : '发送命令模板失败')
    }
  }

  const sendSnippet = async () => {
    if (activeId === null || !snippetId) return
    const snippet = snippets.find((item) => item.id === snippetId)
    if (!snippet) return
    const parameters = getSnippetParameters(snippet.command)
    if (parameters.length > 0) {
      setSnippetError(null)
      setSnippetValues(Object.fromEntries(parameters.map((name) => [name, ''])))
      setSnippetPrompt(snippet)
      return
    }
    await sendRenderedSnippet(snippet, snippet.command)
  }

  const confirmSnippet = async () => {
    if (!snippetPrompt) return
    const parameters = getSnippetParameters(snippetPrompt.command)
    if (parameters.some((name) => !snippetValues[name]?.trim())) {
      setSnippetError('请填写全部模板参数')
      return
    }
    await sendRenderedSnippet(snippetPrompt, renderCommandTemplate(snippetPrompt.command, snippetValues))
  }

  const exportSessionLog = () => {
    if (activeId === null) return
    const info = sessions[activeId]
    const data = getSessionLog(activeId)
    if (!info || !data.length) {
      setSnippetError('当前会话还没有可导出的输出')
      return
    }
    const text = cleanTerminalLog(new TextDecoder().decode(data))
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${safeFileName(info.name || info.host)}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
    anchor.click()
    URL.revokeObjectURL(url)
    recordAudit('session.log-export', `${info.name} (${info.host}:${info.port})`, 'success', '导出当前会话最近 2 MB 输出')
  }

  const sendBulkCommand = async () => {
    const command = bulkCommand.trim()
    if (!command) return
    const targets = order.filter((id) => sessions[id]?.status === 'connected')
    if (!targets.length) {
      setBulkResult('没有已连接的目标会话')
      return
    }
    if (!(await confirmDialog({ title: '批量下发命令', message: `将向 ${targets.length} 台服务器发送此命令，是否继续？`, confirmLabel: '确认发送', danger: true }))) return
    setBulkBusy(true)
    setBulkResult(null)
    let success = 0
    for (const id of targets) {
      try {
        await write(id, new TextEncoder().encode(`${command}\n`))
        success += 1
      } catch {
        // Continue dispatching to the remaining sessions.
      }
    }
    recordAudit('command.bulk-send', `${success}/${targets.length} 个会话`, success === targets.length ? 'success' : 'failure', '批量发送命令')
    setBulkResult(`已发送 ${success}/${targets.length} 个会话`)
    setBulkBusy(false)
  }

  const connectedSessions = order.filter((id) => sessions[id]?.status === 'connected')
  const broadcastActiveCount = broadcastTargets.filter((id) => sessions[id]?.status === 'connected').length
  const allBroadcastSelected = connectedSessions.length > 0 && connectedSessions.every((id) => broadcastTargets.includes(id))

  const commitRename = async () => {
    const id = renamingId
    const name = renamingValue.trim()
    setRenamingId(null)
    if (id === null || !name) return
    try {
      await renameSession(id, name)
      recordAudit('session.rename', name, 'success', '重命名会话标签')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '重命名失败', 'error')
    }
  }

  const startRename = (id: number, currentName: string) => {
    setRenamingId(id)
    setRenamingValue(currentName)
    requestAnimationFrame(() => renameInputRef.current?.select())
  }

  if (order.length === 0) {
    return (
      <div className="view">
        <header className="view-header">
          <div>
            <div className="view-title">会话</div>
            <div className="view-subtitle">多个 SSH 终端标签，密码或私钥认证</div>
          </div>
        </header>
        <section className="glass empty-state">
          <div className="empty-icon">
            <Icon name="terminal" size={44} />
          </div>
          <div className="empty-title">还没有活动会话</div>
          <div className="empty-desc">
            前往「主机」页点击「新建连接」，或在主机列表点击「连接」，
            即可在此处打开终端标签。
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="view sessions-view">
      <div className="session-tabs">
        {order.map((id) => {
          const info = sessions[id]
          if (!info) return null
          const status: string = info.status
          return (
            <div
              key={id}
              className={`session-tab ${activeId === id ? 'active' : ''}`}
              onClick={() => setActive(id)}
              title={`${info.name} · ${info.host}:${info.port}`}
            >
              <span className={`tab-dot tab-dot-${status}`} />
              {renamingId === id ? (
                <input
                  ref={renameInputRef}
                  className="glass-input tab-rename-input"
                  value={renamingValue}
                  onChange={(event) => setRenamingValue(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void commitRename()
                    if (event.key === 'Escape') setRenamingId(null)
                  }}
                  onBlur={() => void commitRename()}
                  autoFocus
                />
              ) : (
                <span
                  className="tab-name"
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                    startRename(id, info.name)
                  }}
                  title="双击重命名"
                >
                  {info.name}
                </span>
              )}
              <span className="tab-status" title={info.reason || undefined}>{statusLabel(info.status, info.reason, info.attempt ?? null)}{status === 'connected' && connectedAt[id] ? ` · ${formatOnlineDuration(Date.now() - connectedAt[id])}` : ''}</span>
              {(status === 'disconnected' || status === 'closed') && (
                <button
                  className="tab-close"
                  title="重新连接"
                  onClick={(e) => {
                    e.stopPropagation()
                    reconnect(id).catch(() => showToast('重连请求失败，请稍后重试', 'error'))
                  }}
                >
                  <Icon name="refresh" size={12} />
                </button>
              )}
              <button
                className="tab-close"
                title="关闭标签并断开"
                onClick={(e) => {
                  e.stopPropagation()
                  if (status === 'connected' || status === 'connecting' || status === 'reconnecting') {
                    void disconnect(id)
                  }
                  void closeTab(id)
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          )
        })}
      </div>
       <div className="session-tool" title="快捷键：Ctrl+1..9 切换标签 · Ctrl+Tab 循环 · Ctrl+W 关闭 · Ctrl+T 新建连接 · Ctrl+F 终端搜索">
        <div className="snippet-toolbar">
        <Icon name="terminal" size={15} />
        <select className="glass-input snippet-select" value={snippetId} onChange={(event) => setSnippetId(event.target.value)}>
          <option value="">选择命令片段</option>
          {snippets.map((snippet) => <option key={snippet.id} value={snippet.id}>{snippet.name}</option>)}
        </select>
        <button className="glass-btn" onClick={() => void sendSnippet()} disabled={!snippetId || activeId === null} title="发送命令片段">
          发送
        </button>
        <button className="glass-btn" onClick={() => setBulkOpen(true)} title="向所有已连接会话发送命令">
          批量下发
        </button>
        <button
          className={`glass-btn ${broadcastEnabled ? 'primary' : ''}`}
          onClick={() => setBroadcastEnabled(!broadcastEnabled)}
          disabled={!connectedSessions.length}
          title="开启后，在当前终端键入的每个字符都会实时同步到勾选的会话"
        >
          <Icon name="broadcast" size={14} />
          广播输入
        </button>
        <button className="glass-btn" onClick={exportSessionLog} disabled={activeId === null} title="导出当前会话最近 2 MB 输出">
          <Icon name="save" size={14} />保存日志
        </button>
        </div>
      </div>
       {snippetError && <div className="form-error">{snippetError}</div>}
       {bulkResult && <div className="form-notice">{bulkResult}</div>}
      {broadcastEnabled && (
        <div className="broadcast-bar glass">
          <div className="broadcast-title">
            <Icon name="broadcast" size={15} />
            <span>广播输入已开启</span>
            <small>在当前终端键入会实时同步到勾选的会话（{broadcastActiveCount} 个目标）</small>
          </div>
          <div className="broadcast-targets">
            {connectedSessions.map((id) => (
              <button
                key={id}
                className={`broadcast-chip ${broadcastTargets.includes(id) ? 'active' : ''}`}
                onClick={() => toggleBroadcastTarget(id)}
                title={sessions[id]?.name}
              >
                {sessions[id]?.name}
              </button>
            ))}
            {!connectedSessions.length && <span className="section-tip">没有已连接的会话可作为广播目标。</span>}
          </div>
          <div className="broadcast-actions">
            <button
              className="glass-btn"
              onClick={() => connectedSessions.forEach((id) => {
                if (!broadcastTargets.includes(id)) toggleBroadcastTarget(id)
              })}
              disabled={allBroadcastSelected}
            >
              全选
            </button>
            <button className="glass-btn" onClick={() => setBroadcastEnabled(false)}>关闭广播</button>
          </div>
        </div>
      )}
      <div className="session-workspace">
        <div className="terminal-stack">
          {order.map((id) => (
            <TerminalPane key={id} id={id} active={activeId === id} />
          ))}
        </div>
        {activeId !== null && (
          sessionPanels.monitorCollapsed ? (
            <aside className="session-panel-rail">
              <button
                className="panel-rail-btn"
                onClick={() => void setSessionPanelCollapsed('monitor', false)}
                title="展开监控面板"
              >
                <Icon name="monitor" size={15} />
                <span>监控</span>
              </button>
            </aside>
          ) : (
            <aside className="session-monitor-panel">
              <SessionMonitorPanel
                key={activeId}
                sessionId={activeId}
                onCollapse={() => void setSessionPanelCollapsed('monitor', true)}
              />
            </aside>
          )
        )}
      </div>
      {activeId !== null && (
        sessionPanels.sftpCollapsed ? (
          <div className="session-sftp-rail">
            <button
              className="panel-rail-btn"
              onClick={() => void setSessionPanelCollapsed('sftp', false)}
              title="展开 SFTP 面板"
            >
              <Icon name="folder" size={15} />
              <span>SFTP 文件</span>
            </button>
          </div>
        ) : (
          <div className="session-sftp-panel">
            <SessionSftpPanel
              key={activeId}
              sessionId={activeId}
              onCollapse={() => void setSessionPanelCollapsed('sftp', true)}
            />
          </div>
        )
      )}
      {bulkOpen && (
        <div className="modal-overlay" onClick={() => !bulkBusy && setBulkOpen(false)}>
          <div className="modal glass" onClick={(event) => event.stopPropagation()}>
            <header className="modal-header"><div className="modal-title"><Icon name="terminal" size={17} />批量下发命令</div><button className="modal-close" onClick={() => setBulkOpen(false)} disabled={bulkBusy}><Icon name="x" size={15} /></button></header>
            <div className="modal-body">
              <p className="section-tip">命令将发送至所有已连接会话，请确认命令不会造成不可逆影响。</p>
              <textarea className="glass-input bulk-command" value={bulkCommand} onChange={(event) => setBulkCommand(event.target.value)} placeholder="例如 uname -a" autoFocus />
            </div>
            <footer className="modal-footer"><button className="glass-btn" onClick={() => setBulkOpen(false)} disabled={bulkBusy}>取消</button><button className="glass-btn primary" onClick={() => void sendBulkCommand()} disabled={bulkBusy || !bulkCommand.trim()}>{bulkBusy ? '发送中…' : '确认发送'}</button></footer>
          </div>
        </div>
      )}
      {snippetPrompt && (
        <div className="modal-overlay" onClick={() => setSnippetPrompt(null)}>
          <div className="modal glass snippet-prompt-modal" onClick={(event) => event.stopPropagation()}>
            <header className="modal-header">
              <div className="modal-title"><Icon name="terminal" size={17} />填写命令参数</div>
              <button className="modal-close" onClick={() => setSnippetPrompt(null)}><Icon name="x" size={15} /></button>
            </header>
            <div className="modal-body">
              <div className="section-tip">模板：{snippetPrompt.name}。参数会作为独立 Shell 参数转义。</div>
              {getSnippetParameters(snippetPrompt.command).map((name) => (
                <label className="field" key={name}>
                  <span className="field-label">{name}</span>
                  <input className="glass-input" value={snippetValues[name] ?? ''} onChange={(event) => setSnippetValues((current) => ({ ...current, [name]: event.target.value }))} autoFocus={name === getSnippetParameters(snippetPrompt.command)[0]} />
                </label>
              ))}
              <div className="snippet-rendered-command"><span>发送预览</span><code>{renderCommandTemplate(snippetPrompt.command, snippetValues)}</code></div>
            </div>
            <footer className="modal-footer"><button className="glass-btn" onClick={() => setSnippetPrompt(null)}>取消</button><button className="glass-btn primary" onClick={() => void confirmSnippet()}>发送命令</button></footer>
          </div>
        </div>
      )}
    </div>
  )
}

function formatOnlineDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}小时${rest}分` : `${hours}小时`
}

function statusLabel(status: string, reason?: string | null, attempt?: number | null): string {
  if (status === 'reconnecting' && attempt && attempt > 0) {
    const interval = attempt === 1 ? 2 : attempt === 2 ? 5 : 10
    return `第 ${attempt} 次重连 · 间隔 ${interval}s`
  }
  const text = STATUS_TEXT[status as SessionStatus]
  if ((status === 'disconnected' || status === 'closed' || status === 'reconnecting') && reason) {
    return reason.length > 22 ? `${reason.slice(0, 22)}…` : reason
  }
  return text ?? status
}

function safeFileName(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'ssh-session'
}

function cleanTerminalLog(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r(?!\n)/g, '\n')
}
