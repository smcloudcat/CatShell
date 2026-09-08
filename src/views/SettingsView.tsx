import { THEME_PRESETS } from '../types/theme'
import { useSettings } from '../store/settings'
import { ThemeParams } from './settings/ThemeParams'
import { Presets } from './settings/Presets'
import { Icon } from '../components/Icon'
import { VaultPanel } from './settings/VaultPanel'
import { SnippetPanel } from './settings/SnippetPanel'
import { AuditPanel } from './settings/AuditPanel'
import { BackupPanel } from './settings/BackupPanel'
import { MonitorThresholdPanel } from './settings/MonitorThresholdPanel'

export function SettingsView() {
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const saveTheme = useSettings((s) => s.saveTheme)

  const previewStyle: React.CSSProperties = {
    '--preview-gradient-angle': `${theme.gradient.angle}deg`,
    '--preview-gradient-from': theme.gradient.from,
    '--preview-gradient-to': theme.gradient.to
  } as React.CSSProperties

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-title">设置</div>
          <div className="view-subtitle">界面主题实时调整 · 效果即时预览</div>
        </div>
      </header>
      <div className="settings-layout">
        <section className="glass settings-panel">
          <Presets />
          <ThemeParams theme={theme} setTheme={setTheme} />
          <VaultPanel />
          <SnippetPanel />
           <AuditPanel />
           <BackupPanel />
           <MonitorThresholdPanel />
        </section>
        <div className="preview-area">
          <section className="preview-window">
            <div
              className="preview-layout"
              style={previewStyle}
            >
              <div className="glass preview-sidebar">
                <Icon name="terminal" size={22} />
                <Icon name="server" size={20} />
                <Icon name="monitor" size={20} />
                <Icon name="settings" size={20} />
              </div>
              <div className="preview-content">
                <div className="glass preview-card">
                  <div className="preview-bar wide" />
                  <div className="preview-bar mid" />
                  <span className="preview-chip">连接成功</span>
                </div>
                <div className="preview-stats">
                  <div className="glass preview-stat">
                    <span className="stat-label">CPU</span>
                    <span className="stat-ring" />
                  </div>
                  <div className="glass preview-stat">
                    <span className="stat-label">内存</span>
                    <span className="stat-ring" />
                  </div>
                  <div className="glass preview-stat">
                    <span className="stat-label">磁盘</span>
                    <span className="stat-ring" />
                  </div>
                </div>
              </div>
            </div>
          </section>
          <div className="settings-actions">
            <button className="glass-btn" onClick={() => applyPresetDefault()}>
              <Icon name="refresh" size={15} />
              恢复默认
            </button>
            <button className="glass-btn primary" onClick={() => saveTheme()}>
              <Icon name="save" size={15} />
              保存主题
            </button>
          </div>
          <span className="view-footer">点击保存后主题将持久化至本地设置</span>
        </div>
      </div>
    </div>
  )
}

function applyPresetDefault() {
  useSettings.getState().applyPreset(THEME_PRESETS[0])
}
