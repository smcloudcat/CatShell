import { useState } from 'react'
import { useSettings } from '../store/settings'
import { ThemeParams } from './settings/ThemeParams'
import { Appearance } from './settings/Appearance'
import { Icon, IconName } from '../components/Icon'
import { VaultPanel } from './settings/VaultPanel'
import { KnownHostsPanel } from './settings/KnownHostsPanel'
import { SnippetPanel } from './settings/SnippetPanel'
import { AuditPanel } from './settings/AuditPanel'
import { BackupPanel } from './settings/BackupPanel'
import { MonitorThresholdPanel } from './settings/MonitorThresholdPanel'

type SettingsTab = 'appearance' | 'monitor' | 'snippets' | 'security' | 'backup'

const TABS: { id: SettingsTab; label: string; hint: string; icon: IconName }[] = [
  { id: 'appearance', label: '外观', hint: '主题与质感', icon: 'palette' },
  { id: 'monitor', label: '监控告警', hint: '阈值与通知', icon: 'monitor' },
  { id: 'snippets', label: '命令片段', hint: '常用命令库', icon: 'terminal' },
  { id: 'security', label: '安全与审计', hint: '保险箱与日志', icon: 'key' },
  { id: 'backup', label: '备份与还原', hint: '导入导出配置', icon: 'database' }
]

export function SettingsView() {
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const resetTheme = useSettings((s) => s.resetTheme)
  const saveTheme = useSettings((s) => s.saveTheme)
  const [tab, setTab] = useState<SettingsTab>('appearance')

  const previewStyle: React.CSSProperties = (() => {
    if (theme.backgroundType === 'solid') return { background: theme.solidColor }
    if (theme.backgroundType === 'image' && theme.backgroundImage) {
      return {
        backgroundImage: `url("${theme.backgroundImage}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center'
      }
    }
    return {
      backgroundImage: `linear-gradient(${theme.gradient.angle}deg, ${theme.gradient.from}, ${theme.gradient.to})`
    }
  })()

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <div className="view-title">设置</div>
          <div className="view-subtitle">
            {tab === 'appearance' ? '外观实时调整 · 效果即时预览' : TABS.find((t) => t.id === tab)?.hint ?? ''}
          </div>
        </div>
      </header>
      <div className="settings-layout">
        <nav className="glass settings-nav">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.icon} size={16} />
              <span className="settings-nav-text">
                <span>{item.label}</span>
                <small>{item.hint}</small>
              </span>
            </button>
          ))}
        </nav>

        {tab === 'appearance' ? (
          <div className="settings-appearance">
            <section className="glass settings-panel">
              <Appearance />
              <ThemeParams theme={theme} setTheme={setTheme} />
            </section>
            <div className="preview-area">
              <section className="preview-window" style={previewStyle}>
                <div className="preview-layout">
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
                <button className="glass-btn" onClick={resetTheme}>
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
        ) : (
          <section className="glass settings-panel">
            {tab === 'monitor' && <MonitorThresholdPanel />}
            {tab === 'snippets' && <SnippetPanel />}
            {tab === 'security' && (
              <>
                <VaultPanel />
                <KnownHostsPanel />
                <AuditPanel />
              </>
            )}
            {tab === 'backup' && <BackupPanel />}
          </section>
        )}
      </div>
    </div>
  )
}