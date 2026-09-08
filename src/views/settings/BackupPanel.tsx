import { ChangeEvent } from 'react'
import { Icon } from '../../components/Icon'
import { HostProfile } from '../../types/host'
import { CommandSnippet } from '../../types/snippet'
import { ThemeConfig } from '../../types/theme'
import { useHosts } from '../../store/hosts'
import { useSnippets } from '../../store/snippets'
import { DEFAULT_MONITOR_THRESHOLDS, MonitorThresholds, useSettings } from '../../store/settings'
import { recordAudit } from '../../store/audit'

interface BackupFile {
  version: 1
  exportedAt: number
  hosts: Partial<HostProfile>[]
  snippets: Partial<CommandSnippet>[]
  theme: ThemeConfig
  monitorThresholds: MonitorThresholds
}

function isThemeConfig(value: unknown): value is ThemeConfig {
  if (!value || typeof value !== 'object') return false
  const theme = value as Partial<ThemeConfig>
  return (
    typeof theme.bgOpacity === 'number' &&
    typeof theme.blurRadius === 'number' &&
    typeof theme.borderRadius === 'number' &&
    typeof theme.borderOpacity === 'number' &&
    (theme.backgroundType === 'gradient' || theme.backgroundType === 'solid' || theme.backgroundType === 'image') &&
    typeof theme.solidColor === 'string' &&
    typeof theme.gradient === 'object' &&
    theme.gradient !== null &&
    typeof theme.gradient.from === 'string' &&
    typeof theme.gradient.to === 'string' &&
    typeof theme.gradient.angle === 'number' &&
    (theme.backgroundImage === null || typeof theme.backgroundImage === 'string') &&
    typeof theme.accentColor === 'string' &&
    (theme.mode === 'light' || theme.mode === 'dark') &&
    typeof theme.modeAuto === 'boolean'
  )
}

function isMonitorThresholds(value: unknown): value is MonitorThresholds {
  if (!value || typeof value !== 'object') return false
  const thresholds = value as Partial<MonitorThresholds>
  return typeof thresholds.enabled === 'boolean' &&
    typeof thresholds.cpuPercent === 'number' && thresholds.cpuPercent >= 1 && thresholds.cpuPercent <= 100 &&
    typeof thresholds.memoryPercent === 'number' && thresholds.memoryPercent >= 1 && thresholds.memoryPercent <= 100 &&
    typeof thresholds.diskPercent === 'number' && thresholds.diskPercent >= 1 && thresholds.diskPercent <= 100
}

export function BackupPanel() {
  const hosts = useHosts((state) => state.hosts)
  const importProfiles = useHosts((state) => state.importProfiles)
  const snippets = useSnippets((state) => state.snippets)
  const importSnippets = useSnippets((state) => state.importSnippets)
  const theme = useSettings((state) => state.theme)
  const replaceTheme = useSettings((state) => state.replaceTheme)
  const monitorThresholds = useSettings((state) => state.monitorThresholds)
  const setMonitorThresholds = useSettings((state) => state.setMonitorThresholds)
  const saveMonitorThresholds = useSettings((state) => state.saveMonitorThresholds)

  const exportBackup = () => {
    const safeHosts = hosts.map(({ password: _password, passphrase: _passphrase, ...host }) => host)
    const payload: BackupFile = { version: 1, exportedAt: Date.now(), hosts: safeHosts, snippets, theme, monitorThresholds }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'catshell-backup.json'
    anchor.click()
    URL.revokeObjectURL(url)
    recordAudit('config.export', '本地配置', 'success', `导出 ${hosts.length} 条主机和 ${snippets.length} 个片段`)
  }

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1) throw new Error('格式不支持')
      const backup = parsed as Partial<BackupFile>
      if (!Array.isArray(backup.hosts) || !Array.isArray(backup.snippets) || !isThemeConfig(backup.theme)) throw new Error('内容不完整')
      if (backup.monitorThresholds !== undefined && !isMonitorThresholds(backup.monitorThresholds)) throw new Error('告警设置无效')
      await importProfiles(backup.hosts)
      await importSnippets(backup.snippets)
      replaceTheme(backup.theme)
      setMonitorThresholds(backup.monitorThresholds ?? DEFAULT_MONITOR_THRESHOLDS)
      await saveMonitorThresholds()
      recordAudit('config.import', '本地配置', 'success', `还原 ${backup.hosts.length} 条主机和 ${backup.snippets.length} 个片段`)
      window.alert('配置还原完成。点击“保存主题”后主题设置将持久化。')
    } catch {
      recordAudit('config.import', '本地配置', 'failure', '备份文件无效')
      window.alert('还原失败，请选择有效的 CatShell 备份文件。')
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-title"><Icon name="save" size={15} />配置备份</div>
      <div className="section-tip">导出主机、命令片段、主题和监控告警设置。密码与私钥口令永远不会写入备份文件。</div>
      <div className="backup-actions">
        <button className="glass-btn" onClick={exportBackup} disabled={!hosts.length && !snippets.length}><Icon name="save" size={14} />导出备份</button>
        <label className="glass-btn"><Icon name="folder" size={14} />还原备份<input className="sr-only" type="file" accept="application/json,.json" onChange={importBackup} /></label>
      </div>
    </section>
  )
}
