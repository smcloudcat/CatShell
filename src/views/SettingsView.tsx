import { useState } from 'react'
import { check, Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { useSettings, Language, LANGUAGE_OPTIONS } from '../store/settings'
import { ThemeParams } from './settings/ThemeParams'
import { Appearance } from './settings/Appearance'
import { Icon, IconName } from '../components/Icon'
import { VaultPanel } from './settings/VaultPanel'
import { KnownHostsPanel } from './settings/KnownHostsPanel'
import { SnippetPanel } from './settings/SnippetPanel'
import { AuditPanel } from './settings/AuditPanel'
import { BackupPanel } from './settings/BackupPanel'
import { MonitorThresholdPanel } from './settings/MonitorThresholdPanel'
import { showToast } from '../store/ui'
import { useT } from '../i18n'

type SettingsTab = 'appearance' | 'monitor' | 'snippets' | 'security' | 'backup' | 'update'

const TABS: { id: SettingsTab; labelKey: string; hintKey: string; icon: IconName }[] = [
  { id: 'appearance', labelKey: '外观', hintKey: '主题与质感', icon: 'palette' },
  { id: 'monitor', labelKey: '监控告警', hintKey: '阈值与通知', icon: 'monitor' },
  { id: 'snippets', labelKey: '命令片段', hintKey: '常用命令库', icon: 'terminal' },
  { id: 'security', labelKey: '安全与审计', hintKey: '保险箱与日志', icon: 'key' },
  { id: 'backup', labelKey: '备份与还原', hintKey: '导入导出配置', icon: 'database' },
  { id: 'update', labelKey: '应用更新', hintKey: '语言与自动更新', icon: 'refresh' }
]

export function SettingsView() {
  const t = useT()
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const resetTheme = useSettings((s) => s.resetTheme)
  const saveTheme = useSettings((s) => s.saveTheme)
  const closeToTray = useSettings((s) => s.closeToTray)
  const setCloseToTray = useSettings((s) => s.setCloseToTray)
  const saveCloseToTray = useSettings((s) => s.saveCloseToTray)
  const language = useSettings((s) => s.language)
  const setLanguage = useSettings((s) => s.setLanguage)
  const saveLanguage = useSettings((s) => s.saveLanguage)
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'error'>('idle')
  const [updateInfo, setUpdateInfo] = useState<string | null>(null)
  const [currentUpdate, setCurrentUpdate] = useState<Update | null>(null)

  const checkForUpdate = async () => {
    setUpdateState('checking')
    setUpdateInfo(null)
    try {
      const update = await check()
      if (update) {
        setCurrentUpdate(update)
        setUpdateInfo(update.version ?? '')
        setUpdateState('available')
      } else {
        setCurrentUpdate(null)
        setUpdateState('latest')
      }
    } catch (err) {
      setCurrentUpdate(null)
      setUpdateState('error')
      setUpdateInfo(err instanceof Error ? err.message : t('检查更新失败，请稍后重试或手动下载'))
    }
  }

  const installUpdate = async () => {
    if (!currentUpdate) return
    setUpdateState('downloading')
    try {
      await currentUpdate.downloadAndInstall()
      setUpdateState('idle')
      await relaunch()
    } catch (err) {
      setUpdateState('error')
      setUpdateInfo(err instanceof Error ? err.message : t('下载更新失败'))
    }
  }

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
          <div className="view-title">{t('设置')}</div>
          <div className="view-subtitle">
            {tab === 'appearance' ? t('外观实时调整 · 效果即时预览') : t(TABS.find((item) => item.id === tab)?.hintKey ?? '')}
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
                <span>{t(item.labelKey)}</span>
                <small>{t(item.hintKey)}</small>
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
                      <span className="preview-chip">{t('连接成功')}</span>
                    </div>
                    <div className="preview-stats">
                      <div className="glass preview-stat">
                        <span className="stat-label">CPU</span>
                        <span className="stat-ring" />
                      </div>
                      <div className="glass preview-stat">
                        <span className="stat-label">{t('内存')}</span>
                        <span className="stat-ring" />
                      </div>
                      <div className="glass preview-stat">
                        <span className="stat-label">{t('磁盘')}</span>
                        <span className="stat-ring" />
                      </div>
                    </div>
                  </div>
                </div>
              </section>
              <div className="settings-actions">
                <button className="glass-btn" onClick={resetTheme}>
                  <Icon name="refresh" size={15} />
                  {t('恢复默认')}
                </button>
                <button className="glass-btn primary" onClick={() => saveTheme()}>
                  <Icon name="save" size={15} />
                  {t('保存主题')}
                </button>
              </div>
              <span className="view-footer">{t('点击保存后主题将持久化至本地设置')}</span>
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
            {tab === 'update' && (
              <>
                <div className="panel-row">
                  <div className="panel-copy">
                    <div className="panel-title">{t('界面语言')}</div>
                    <div className="panel-desc">{t('切换后立即生效并持久化；英文翻译逐步补齐，缺失文案回退中文。')}</div>
                  </div>
                  <div className="seg-group">
                    {LANGUAGE_OPTIONS.map((option) => (
                      <button
                        key={option}
                        className={`seg-btn ${language === option ? 'active' : ''}`}
                        onClick={() => {
                          setLanguage(option as Language)
                          void saveLanguage()
                        }}
                      >
                        {option === 'zh-CN' ? t('简体中文') : 'English'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="panel-row">
                  <div className="panel-copy">
                    <div className="panel-title">{t('关闭窗口时最小化到托盘')}</div>
                    <div className="panel-desc">
                      {t('开启后点击关闭按钮仅隐藏窗口，SSH 会话保持在线，可从系统托盘恢复或退出。')}
                    </div>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={closeToTray}
                      onChange={(e) => {
                        setCloseToTray(e.target.checked)
                        void saveCloseToTray()
                      }}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="panel-row">
                  <div className="panel-copy">
                    <div className="panel-title">{t('检查更新')}</div>
                    <div className="panel-desc">
                      {updateState === 'checking' && t('正在检查更新…')}
                      {updateState === 'available' && `${t('发现新版本 v')}${updateInfo}${t('，可下载安装（安装后自动重启）。')}`}
                      {updateState === 'latest' && t('当前已是最新版本。')}
                      {updateState === 'downloading' && t('正在下载并安装更新…')}
                      {updateState === 'error' && (updateInfo ?? t('检查更新失败'))}
                      {updateState === 'idle' && t('通过内置更新通道检查新版本；未配置签名或网络不可用时会提示失败。')}
                    </div>
                  </div>
                  <div className="settings-actions">
                    {updateState === 'available' ? (
                      <button className="glass-btn primary" onClick={() => void installUpdate()}>
                        <Icon name="download" size={15} />
                        {t('下载并安装')}
                      </button>
                    ) : (
                      <button className="glass-btn" onClick={() => void checkForUpdate()} disabled={updateState === 'checking' || updateState === 'downloading'}>
                        <Icon name="refresh" size={15} />
                        {t('检查更新')}
                      </button>
                    )}
                  </div>
                </div>
                {updateState === 'error' && (
                  <button className="glass-btn" onClick={() => showToast(t('可前往 GitHub Releases 页面手动下载最新安装包'))}>
                    <Icon name="info" size={15} />
                    {t('手动下载指引')}
                  </button>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  )
}