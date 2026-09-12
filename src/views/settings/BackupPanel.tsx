import { ChangeEvent } from 'react'
import { Icon } from '../../components/Icon'
import { HostProfile } from '../../types/host'
import { CommandSnippet } from '../../types/snippet'
import { ThemeConfig } from '../../types/theme'
import { isMonitorThresholds, normalizeTheme } from '../../utils/settingsSchema'
import { AppError, ERROR_CODES } from '../../types/errors'
import { useHosts } from '../../store/hosts'
import { useSnippets } from '../../store/snippets'
import { DEFAULT_MONITOR_THRESHOLDS, MonitorThresholds, useSettings } from '../../store/settings'
import { recordAudit } from '../../store/audit'
import { showToast } from '../../store/ui'
import { useT } from '../../i18n'
import { errorText } from '../../i18n/errors'

interface BackupFile {
  version: 1
  exportedAt: number
  hosts: Partial<HostProfile>[]
  snippets: Partial<CommandSnippet>[]
  theme: ThemeConfig
  monitorThresholds: MonitorThresholds
}

// 主题与阈值的校验/归一化统一收敛在 utils/settingsSchema（审计 S-4），
// 备份导入沿用其中的**严格**版 normalizeTheme / isMonitorThresholds。
export function BackupPanel() {
  const t = useT()
  const hosts = useHosts((state) => state.hosts)
  const importProfiles = useHosts((state) => state.importProfiles)
  const snippets = useSnippets((state) => state.snippets)
  const importSnippets = useSnippets((state) => state.importSnippets)
  const theme = useSettings((state) => state.theme)
  const replaceTheme = useSettings((state) => state.replaceTheme)
  const saveTheme = useSettings((state) => state.saveTheme)
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
      if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1) {
        throw new AppError(ERROR_CODES.BACKUP_UNSUPPORTED_FORMAT)
      }
      const backup = parsed as Partial<BackupFile>
      const restoredTheme = normalizeTheme(backup.theme)
      if (!Array.isArray(backup.hosts) || !Array.isArray(backup.snippets) || !restoredTheme) {
        throw new AppError(ERROR_CODES.BACKUP_INCOMPLETE)
      }
      if (backup.monitorThresholds !== undefined && !isMonitorThresholds(backup.monitorThresholds)) {
        throw new AppError(ERROR_CODES.BACKUP_INVALID_THRESHOLDS)
      }
      await importProfiles(backup.hosts)
      await importSnippets(backup.snippets)
      replaceTheme(restoredTheme)
      await saveTheme()
      setMonitorThresholds(backup.monitorThresholds ?? DEFAULT_MONITOR_THRESHOLDS)
      await saveMonitorThresholds()
      recordAudit('config.import', 'local-config', 'success', `restore ${backup.hosts.length} hosts, ${backup.snippets.length} snippets`)
      showToast(t('配置还原完成，主题设置已持久化。'), 'success')
    } catch (err) {
      recordAudit('config.import', 'local-config', 'failure', t('备份文件无效'))
      showToast(t('还原失败：') + errorText(err, t, '请选择有效的 CatShell 备份文件。'), 'error')
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-title"><Icon name="save" size={15} />{t('配置备份')}</div>
      <div className="section-tip">{t('导出主机、命令片段、主题和监控告警设置。密码与私钥口令永远不会写入备份文件。')}</div>
      <div className="backup-actions">
        <button className="glass-btn" onClick={exportBackup} disabled={!hosts.length && !snippets.length}><Icon name="save" size={14} />{t('导出备份')}</button>
        <label className="glass-btn"><Icon name="folder" size={14} />{t('还原备份')}<input className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void importBackup(event)} /></label>
      </div>
    </section>
  )
}
