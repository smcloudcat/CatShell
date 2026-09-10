import { ChangeEvent } from 'react'
import { Icon } from '../../components/Icon'
import { HostProfile } from '../../types/host'
import { CommandSnippet } from '../../types/snippet'
import { ThemeConfig } from '../../types/theme'
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

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/** CSS url() 值只允许本地路径中出现的安全字符，拒绝引号、逗号、分号等可逃逸字符 */
function isSafeBackgroundImage(value: string): boolean {
  return value.length > 0 && value.length <= 500 && !/["`,;()\n\r\\]/.test(value)
}

/** 校验并归一化主题：兼容旧版（modeAuto + 字面量 mode）与新版（auto/light/dark）结构。
 *  旧版 modeAuto 的语义是按背景亮度推导出的字面量 mode，保留该字面量即可还原当时的实际外观。 */
function normalizeTheme(value: unknown): ThemeConfig | null {
  if (!value || typeof value !== 'object') return null
  const theme = value as Partial<ThemeConfig>
  if (
    typeof theme.bgOpacity !== 'number' || !Number.isFinite(theme.bgOpacity) ||
    typeof theme.blurRadius !== 'number' || !Number.isFinite(theme.blurRadius) ||
    typeof theme.borderRadius !== 'number' || !Number.isFinite(theme.borderRadius) ||
    typeof theme.borderOpacity !== 'number' || !Number.isFinite(theme.borderOpacity) ||
    (theme.backgroundType !== 'gradient' && theme.backgroundType !== 'solid' && theme.backgroundType !== 'image') ||
    typeof theme.solidColor !== 'string' || !HEX_COLOR.test(theme.solidColor) ||
    !theme.gradient ||
    typeof theme.gradient.from !== 'string' || !HEX_COLOR.test(theme.gradient.from) ||
    typeof theme.gradient.to !== 'string' || !HEX_COLOR.test(theme.gradient.to) ||
    typeof theme.gradient.angle !== 'number' || !Number.isFinite(theme.gradient.angle) ||
    (theme.backgroundImage !== null && (typeof theme.backgroundImage !== 'string' || !isSafeBackgroundImage(theme.backgroundImage))) ||
    typeof theme.accentColor !== 'string' || !HEX_COLOR.test(theme.accentColor) ||
    (theme.mode !== 'auto' && theme.mode !== 'light' && theme.mode !== 'dark')
  ) {
    return null
  }
  return {
    mode: theme.mode,
    accentColor: theme.accentColor,
    backgroundType: theme.backgroundType,
    solidColor: theme.solidColor,
    gradient: {
      from: theme.gradient.from,
      to: theme.gradient.to,
      angle: Math.min(360, Math.max(0, theme.gradient.angle))
    },
    backgroundImage: theme.backgroundImage,
    bgOpacity: Math.min(1, Math.max(0.1, theme.bgOpacity)),
    blurRadius: Math.round(Math.min(20, Math.max(2, theme.blurRadius))),
    borderRadius: Math.round(Math.min(24, Math.max(0, theme.borderRadius))),
    borderOpacity: Math.min(0.4, Math.max(0.05, theme.borderOpacity))
  }
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
        <label className="glass-btn"><Icon name="folder" size={14} />{t('还原备份')}<input className="sr-only" type="file" accept="application/json,.json" onChange={importBackup} /></label>
      </div>
    </section>
  )
}
