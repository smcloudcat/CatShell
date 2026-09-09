import { Icon } from '../../components/Icon'
import { MonitorThresholds, useSettings } from '../../store/settings'
import { useT } from '../../i18n'

export function MonitorThresholdPanel() {
  const t = useT()
  const thresholds = useSettings((state) => state.monitorThresholds)
  const setMonitorThresholds = useSettings((state) => state.setMonitorThresholds)
  const saveMonitorThresholds = useSettings((state) => state.saveMonitorThresholds)

  const update = (patch: Partial<MonitorThresholds>) => setMonitorThresholds(patch)

  return (
    <section className="settings-section">
      <div className="settings-section-title"><Icon name="monitor" size={15} /> {t('监控告警')}</div>
      <div className="section-tip">{t('监控页轮询时检查当前服务器。超过阈值只在进入告警状态时通知一次。')}</div>
      <label className="toggle-row">
        <input type="checkbox" checked={thresholds.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
        <span>{t('启用本地阈值告警')}</span>
      </label>
      <div className="threshold-grid">
        <label className="field">
          <span className="field-label">{t('CPU 负载率 (%)')}</span>
          <input className="glass-input" type="number" min={1} max={100} value={thresholds.cpuPercent} disabled={!thresholds.enabled} onChange={(event) => update({ cpuPercent: Number(event.target.value) })} />
        </label>
        <label className="field">
          <span className="field-label">{t('内存使用率 (%)')}</span>
          <input className="glass-input" type="number" min={1} max={100} value={thresholds.memoryPercent} disabled={!thresholds.enabled} onChange={(event) => update({ memoryPercent: Number(event.target.value) })} />
        </label>
        <label className="field">
          <span className="field-label">{t('根分区使用率 (%)')}</span>
          <input className="glass-input" type="number" min={1} max={100} value={thresholds.diskPercent} disabled={!thresholds.enabled} onChange={(event) => update({ diskPercent: Number(event.target.value) })} />
        </label>
      </div>
      <div className="settings-inline-actions">
        <button className="glass-btn" onClick={() => void saveMonitorThresholds()}><Icon name="save" size={14} />{t('保存告警设置')}</button>
      </div>
    </section>
  )
}
