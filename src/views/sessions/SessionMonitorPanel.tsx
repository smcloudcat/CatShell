import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { sshKillProcess, sshMonitor, sshNetworkDiagnostic, sshProcesses } from '../../api/ssh'
import { useSessions } from '../../store/sessions'
import { useSettings } from '../../store/settings'
import { NetworkDiagnostic, ProcessInfo, ServerMetrics } from '../../types/session'

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1024) return `${Math.max(0, value)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let amount = value
  let unit = -1
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`
}

function formatMemory(kb: number): string {
  return formatBytes(kb * 1024)
}

function percent(used: number, total: number): number {
  if (!total) return 0
  return Math.min(100, Math.max(0, (used / total) * 100))
}

interface Props {
  sessionId: number
}

export function SessionMonitorPanel({ sessionId }: Props) {
  const monitorThresholds = useSettings((state) => state.monitorThresholds)
  const sessions = useSessions((state) => state.sessions)
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null)
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
  const alertState = useRef<Record<string, boolean>>({})

  const connected = sessions[sessionId]?.status === 'connected'

  useEffect(() => {
    if (!connected) {
      setMetrics(null)
      setProcesses([])
      setAlerts([])
      alertState.current = {}
      return
    }
    let cancelled = false
    setAlerts([])
    const refresh = async () => {
      setBusy(true)
      setError(null)
      try {
        const next = await sshMonitor(sessionId)
        if (!cancelled) {
          setMetrics(next)
          const memoryPercent = percent(next.memoryTotalKb - next.memoryAvailableKb, next.memoryTotalKb)
          const diskPercent = percent(next.diskUsedKb, next.diskTotalKb)
          const checks = [
            { key: 'cpu', label: 'CPU 负载', value: Math.min(100, next.cpuCores ? (next.load1m / next.cpuCores) * 100 : 0), threshold: monitorThresholds.cpuPercent },
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
              window.alert(`服务器监控告警\n${next.hostname}\n${check.label} ${check.value.toFixed(0)}% 已超过 ${check.threshold}%`)
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
    const timer = window.setInterval(refresh, 10000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sessionId, connected, refreshKey, monitorThresholds])

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
    if (!window.confirm(`确认终止进程 ${process.pid} (${process.name})？`)) return
    setProcessBusy(true)
    setProcessError(null)
    try {
      await sshKillProcess(sessionId, process.pid)
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
              <span className="monitor-label">CPU 负载</span>
              <strong>{metrics.load1m.toFixed(2)}</strong>
              <span>{metrics.cpuCores} 核 · 1 分钟</span>
            </div>
            <div className="glass monitor-card">
              <span className="monitor-label">内存</span>
              <strong>{memoryUsedPercent.toFixed(0)}%</strong>
              <span>{formatMemory(memoryUsed)} / {formatMemory(metrics.memoryTotalKb)}</span>
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
            </div>
            <div className="glass monitor-panel">
              <div className="monitor-panel-title">网络累计流量</div>
              <div className="network-values"><strong>↓ {formatBytes(metrics.networkRxBytes)}</strong><strong>↑ {formatBytes(metrics.networkTxBytes)}</strong></div>
              <div className="monitor-panel-meta"><span>接收</span><span>发送</span></div>
            </div>
          </section>
          <div className="monitor-updated">最近采集：{new Date(metrics.collectedAt * 1000).toLocaleString()}</div>
          <section className="monitor-panels monitor-extra-panels">
            <div className="glass monitor-panel process-panel">
              <div className="monitor-panel-title">进程管理</div>
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