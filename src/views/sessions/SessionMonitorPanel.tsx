import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { sshKillProcess, sshMonitor, sshNetworkDiagnostic, sshProcesses } from '../../api/ssh'
import { useSessions } from '../../store/sessions'
import { useSettings, MONITOR_INTERVAL_OPTIONS } from '../../store/settings'
import { showToast, confirmDialog } from '../../store/ui'
import { sendSystemNotification } from '../../utils/notify'
import { NetworkDiagnostic, ProcessInfo, ServerMetrics } from '../../types/session'
import { formatBytes } from '../../utils/format'

function formatMemory(kb: number): string {
  return formatBytes(kb * 1024)
}

function percent(used: number, total: number): number {
  if (!total) return 0
  return Math.min(100, Math.max(0, (used / total) * 100))
}

interface Props {
  sessionId: number
  onCollapse?: () => void
}

const HISTORY_LIMIT = 60

interface RateSample {
  at: number
  rx: number
  tx: number
}

function sparkline(values: number[]): string {
  if (values.length < 2) return ''
  const width = 120
  const height = 28
  const max = Math.max(...values, 1)
  const step = width / (values.length - 1)
  return values
    .map((value, index) => {
      const x = (index * step).toFixed(1)
      const y = (height - (value / max) * (height - 2) - 1).toFixed(1)
      return `${index === 0 ? 'M' : 'L'}${x} ${y}`
    })
    .join(' ')
}

export function SessionMonitorPanel({ sessionId, onCollapse }: Props) {
  const monitorThresholds = useSettings((state) => state.monitorThresholds)
  const monitorIntervalSeconds = useSettings((state) => state.monitorIntervalSeconds)
  const setMonitorIntervalSeconds = useSettings((state) => state.setMonitorIntervalSeconds)
  const saveMonitorIntervalSeconds = useSettings((state) => state.saveMonitorIntervalSeconds)
  const sessions = useSessions((state) => state.sessions)
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null)
  const [history, setHistory] = useState<ServerMetrics[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [processBusy, setProcessBusy] = useState(false)
  const [processError, setProcessError] = useState<string | null>(null)
  const [diagnosticKind, setDiagnosticKind] = useState<'ping' | 'trace'>('ping')
  const [diagnosticTarget, setDiagnosticTarget] = useState('')
  const [diagnostic, setDiagnostic] = useState<NetworkDiagnostic | null>(null)
  const [alerts, setAlerts] = useState<string[]>([])
  const [killSignal, setKillSignal] = useState<'TERM' | 'KILL'>('TERM')
  const lastRate = useRef<RateSample | null>(null)
  const alertState = useRef<Record<string, boolean>>({})

  const connected = sessions[sessionId]?.status === 'connected'

  useEffect(() => {
    if (!connected) {
      setMetrics(null)
      setHistory([])
      setProcesses([])
      setAlerts([])
      alertState.current = {}
      return
    }
    let cancelled = false
    setAlerts([])
    lastRate.current = null
    const refresh = async () => {
      setBusy(true)
      setError(null)
      try {
        const next = await sshMonitor(sessionId)
        if (!cancelled) {
          setMetrics(next)
          setHistory((current) => [...current, next].slice(-HISTORY_LIMIT))
          const memoryPercent = percent(next.memoryTotalKb - next.memoryAvailableKb, next.memoryTotalKb)
          const diskPercent = percent(next.diskUsedKb, next.diskTotalKb)
          const cpuPercentValue = next.cpuPercent ?? (next.cpuCores ? Math.min(100, (next.load1m / next.cpuCores) * 100) : 0)
          const checks = [
            { key: 'cpu', label: 'CPU 使用率', value: cpuPercentValue, threshold: monitorThresholds.cpuPercent },
            { key: 'memory', label: '内存使用率', value: memoryPercent, threshold: monitorThresholds.memoryPercent },
            { key: 'disk', label: '根分区使用率', value: diskPercent, threshold: monitorThresholds.diskPercent }
          ]
          const nextAlerts = checks.filter((check) => check.value >= check.threshold).map((check) => `${check.label} ${check.value.toFixed(0)}% 已超过 ${check.threshold}%`)
          setAlerts(nextAlerts)
          const state = alertState.current
          for (const check of checks) {
            const alertKey = `${sessionId}:${check.key}`
            const exceeded = monitorThresholds.enabled && check.value >= check.threshold
            const wasExceeded = state[alertKey] ?? false
            if (exceeded && !wasExceeded) {
              showToast(`${next.hostname}：${check.label} ${check.value.toFixed(0)}% 已超过 ${check.threshold}%`, 'warning')
              void sendSystemNotification('CatShell 监控告警', `${next.hostname}：${check.label} ${check.value.toFixed(0)}% 已超过 ${check.threshold}%`)
            }
            state[alertKey] = exceeded
          }
        }
      } catch (err) {
        if (!cancelled) setError(typeof err === 'string' ? err : '无法采集服务器状态')
      } finally {
        if (!cancelled) setBusy(false)
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, monitorIntervalSeconds * 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sessionId, connected, refreshKey, monitorThresholds, monitorIntervalSeconds])

  useEffect(() => {
    if (!connected) {
      setProcesses([])
      return
    }
    let cancelled = false
    setProcessError(null)
    void sshProcesses(sessionId)
      .then((next) => { if (!cancelled) setProcesses(next) })
      .catch((err) => { if (!cancelled) setProcessError(typeof err === 'string' ? err : '无法读取进程列表') })
    return () => { cancelled = true }
  }, [sessionId, connected, refreshKey])

  const killProcess = async (process: ProcessInfo) => {
    const signalText = killSignal === 'TERM' ? 'SIGTERM（正常终止）' : 'SIGKILL（强制终止）'
    const accepted = await confirmDialog({
      title: '终止远程进程',
      message: `确认向进程 ${process.pid} (${process.name}) 发送 ${signalText} 信号？该操作不可恢复。`,
      confirmLabel: '终止',
      danger: true
    })
    if (!accepted) return
    setProcessBusy(true)
    setProcessError(null)
    try {
      await sshKillProcess(sessionId, process.pid, killSignal)
      setProcesses((current) => current.filter((item) => item.pid !== process.pid))
    } catch (err) {
      setProcessError(typeof err === 'string' ? err : '终止进程失败')
    } finally {
      setProcessBusy(false)
    }
  }

  const runDiagnostic = async () => {
    if (!diagnosticTarget.trim()) return
    setBusy(true)
    setError(null)
    try {
      setDiagnostic(await sshNetworkDiagnostic(sessionId, diagnosticKind, diagnosticTarget))
    } catch (err) {
      setError(typeof err === 'string' ? err : '网络诊断失败')
    } finally {
      setBusy(false)
    }
  }

  const memoryUsed = metrics ? metrics.memoryTotalKb - metrics.memoryAvailableKb : 0
  const diskUsedPercent = metrics ? percent(metrics.diskUsedKb, metrics.diskTotalKb) : 0
  const memoryUsedPercent = metrics ? percent(memoryUsed, metrics.memoryTotalKb) : 0

  const rate = (() => {
    if (!metrics) return null
    const previous = lastRate.current
    if (!previous || metrics.networkRxBytes < previous.rx || metrics.networkTxBytes < previous.tx) {
      return null
    }
    const seconds = metrics.collectedAt - previous.at
    if (seconds <= 0) return null
    return {
      rx: (metrics.networkRxBytes - previous.rx) / seconds,
      tx: (metrics.networkTxBytes - previous.tx) / seconds
    }
  })()
  if (metrics) {
    lastRate.current = { at: metrics.collectedAt, rx: metrics.networkRxBytes, tx: metrics.networkTxBytes }
  }

  const memorySparkline = sparkline(history.map((item) => percent(item.memoryTotalKb - item.memoryAvailableKb, item.memoryTotalKb)))
  const cpuSparkline = sparkline(
    history.map((item) => item.cpuPercent ?? (item.cpuCores ? Math.min(100, (item.load1m / item.cpuCores) * 100) : 0))
  )

  if (!connected) {
    return (
      <div className="sftp-empty">
        <Icon name="monitor" size={44} />
        <p>会话未连接，连接成功后即可通过只读命令采集服务器状态。</p>
      </div>
    )
  }

  return (
    <div className="monitor-panel-body">
      <div className="sftp-toolbar">
        <Icon name="monitor" size={15} />
        <span className="sftp-heading">服务器监控</span>
        {onCollapse && <button className="host-icon-btn" onClick={onCollapse} title="折叠面板"><Icon name="chevron-down" size={14} /></button>}
        <label className="monitor-interval">
          <span>间隔</span>
          <select
            className="glass-input"
            value={monitorIntervalSeconds}
            onChange={(event) => { setMonitorIntervalSeconds(Number(event.target.value)); void saveMonitorIntervalSeconds() }}
          >
            {MONITOR_INTERVAL_OPTIONS.map((seconds) => (
              <option key={seconds} value={seconds}>{seconds}s</option>
            ))}
          </select>
        </label>
        <button className="glass-btn" onClick={() => setRefreshKey((value) => value + 1)} disabled={busy} title="立即刷新">
          <Icon name="refresh" size={15} />
          {busy ? '采集中' : '刷新'}
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
      {metrics && !error && (
        <>
          <section className="monitor-summary">
            <div className="glass monitor-card">
              <span className="monitor-label">主机</span>
              <strong>{metrics.hostname}</strong>
              <span>{metrics.os}</span>
            </div>
            <div className="glass monitor-card">
              <span className="monitor-label">CPU</span>
              <strong>{metrics.cpuPercent != null ? `${metrics.cpuPercent.toFixed(0)}%` : metrics.load1m.toFixed(2)}</strong>
              <span>{metrics.cpuPercent != null ? `${metrics.cpuCores} 核 · 实际使用率` : `${metrics.cpuCores} 核 · load 1 分钟`}</span>
              {cpuSparkline && (
                <svg className="monitor-sparkline" viewBox="0 0 120 28" preserveAspectRatio="none"><path d={cpuSparkline} /></svg>
              )}
            </div>
            <div className="glass monitor-card">
              <span className="monitor-label">内存</span>
              <strong>{memoryUsedPercent.toFixed(0)}%</strong>
              <span>{formatMemory(memoryUsed)} / {formatMemory(metrics.memoryTotalKb)}</span>
              {memorySparkline && (
                <svg className="monitor-sparkline" viewBox="0 0 120 28" preserveAspectRatio="none"><path d={memorySparkline} /></svg>
              )}
            </div>
            <div className="glass monitor-card">
              <span className="monitor-label">根分区</span>
              <strong>{diskUsedPercent.toFixed(0)}%</strong>
              <span>{formatMemory(metrics.diskUsedKb)} / {formatMemory(metrics.diskTotalKb)}</span>
            </div>
          </section>
          {alerts.length > 0 && monitorThresholds.enabled && (
            <section className="monitor-alerts" role="status">
              <Icon name="monitor" size={15} />
              <div>{alerts.map((alert) => <span key={alert}>{alert}</span>)}</div>
            </section>
          )}
          <section className="monitor-panels">
            <div className="glass monitor-panel">
              <div className="monitor-panel-title">内存使用</div>
              <div className="metric-bar"><span style={{ width: `${memoryUsedPercent}%` }} /></div>
              <div className="monitor-panel-meta"><span>已用 {formatMemory(memoryUsed)}</span><span>可用 {formatMemory(metrics.memoryAvailableKb)}</span></div>
            </div>
            <div className="glass monitor-panel">
              <div className="monitor-panel-title">磁盘使用</div>
              <div className="metric-bar"><span style={{ width: `${diskUsedPercent}%` }} /></div>
              <div className="monitor-panel-meta"><span>已用 {formatMemory(metrics.diskUsedKb)}</span><span>可用 {formatMemory(metrics.diskAvailableKb)}</span></div>
              {metrics.partitions && metrics.partitions.length > 1 && (
                <div className="partition-list">
                  {metrics.partitions.map((partition) => {
                    const usedPercent = percent(partition.usedKb, partition.totalKb)
                    return (
                      <div className="partition-row" key={partition.mountPoint} title={`${partition.mountPoint} · 已用 ${formatMemory(partition.usedKb)} / ${formatMemory(partition.totalKb)}`}>
                        <span className="partition-mount">{partition.mountPoint}</span>
                        <div className="metric-bar metric-bar-small"><span style={{ width: `${usedPercent}%` }} /></div>
                        <span className="partition-percent">{usedPercent.toFixed(0)}%</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            <div className="glass monitor-panel">
              <div className="monitor-panel-title">网络流量</div>
              <div className="network-values">
                <strong>↓ {rate ? `${formatBytes(rate.rx)}/s` : '—'}</strong>
                <strong>↑ {rate ? `${formatBytes(rate.tx)}/s` : '—'}</strong>
              </div>
              <div className="monitor-panel-meta"><span>实时速率</span><span>累计 ↓ {formatBytes(metrics.networkRxBytes)} · ↑ {formatBytes(metrics.networkTxBytes)}</span></div>
            </div>
          </section>
          <div className="monitor-updated">最近采集：{new Date(metrics.collectedAt * 1000).toLocaleString()} · 已记录 {history.length} 次采样</div>
          <section className="monitor-panels monitor-extra-panels">
            <div className="glass monitor-panel process-panel">
              <div className="monitor-panel-title">进程管理</div>
              <div className="process-signal">
                <span className="monitor-panel-meta">终止信号</span>
                <div className="seg-group">
                  <button className={`seg-btn ${killSignal === 'TERM' ? 'active' : ''}`} onClick={() => setKillSignal('TERM')}>TERM 正常终止</button>
                  <button className={`seg-btn ${killSignal === 'KILL' ? 'active' : ''}`} onClick={() => setKillSignal('KILL')}>KILL 强制终止</button>
                </div>
              </div>
              <div className="process-list-head"><span>进程</span><span>CPU</span><span>内存</span><span /></div>
              <div className="process-list">
                {processes.map((process) => (
                  <div className="process-row" key={process.pid}>
                    <span title={process.name}>{process.pid} · {process.name}</span>
                    <span>{process.cpuPercent.toFixed(1)}%</span>
                    <span>{process.memoryPercent.toFixed(1)}%</span>
                    <button className="host-icon-btn danger" disabled={processBusy} onClick={() => void killProcess(process)} title="终止进程"><Icon name="trash" size={13} /></button>
                  </div>
                ))}
                {!processes.length && !processError && <span className="monitor-panel-meta">暂无进程数据</span>}
              </div>
              {processError && <div className="form-error">{processError}</div>}
            </div>
            <div className="glass monitor-panel diagnostic-panel">
              <div className="monitor-panel-title">网络诊断</div>
              <div className="diagnostic-form">
                <select className="glass-input" value={diagnosticKind} onChange={(event) => setDiagnosticKind(event.target.value as 'ping' | 'trace')}>
                  <option value="ping">Ping</option>
                  <option value="trace">Trace 路由</option>
                </select>
                <input className="glass-input" value={diagnosticTarget} onChange={(event) => setDiagnosticTarget(event.target.value)} placeholder="域名或 IP 地址" />
                <button className="glass-btn primary" disabled={busy || !diagnosticTarget.trim()} onClick={() => void runDiagnostic()}>执行</button>
              </div>
              {diagnostic && <pre className="diagnostic-output">{diagnostic.output || '远程主机未返回输出'}</pre>}
            </div>
          </section>
        </>
      )}
    </div>
  )
}