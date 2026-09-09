import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { knownHostsList, knownHostsRemove, knownHostsSetMode } from '../../api/ssh'
import { KnownHostsSnapshot } from '../../types/session'
import { recordAudit } from '../../store/audit'
import { confirmDialog, showToast } from '../../store/ui'
import { useSettings } from '../../store/settings'
import { useT } from '../../i18n'

export function KnownHostsPanel() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<KnownHostsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const knownHostsMode = useSettings((state) => state.knownHostsMode)
  const setKnownHostsMode = useSettings((state) => state.setKnownHostsMode)
  const saveKnownHostsMode = useSettings((state) => state.saveKnownHostsMode)

  const reload = async () => {
    setError(null)
    try {
      setSnapshot(await knownHostsList())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const changeMode = async (mode: 'openssh' | 'appdata') => {
    setError(null)
    try {
      await knownHostsSetMode(mode)
      setKnownHostsMode(mode)
      await saveKnownHostsMode()
      recordAudit('knownhosts.mode', mode, 'success', mode === 'openssh' ? t('切换为 OpenSSH known_hosts 存储') : t('切换为应用数据目录独立存储'))
      await reload()
      showToast(mode === 'openssh' ? t('已切换为 OpenSSH known_hosts 存储，之后的首次连接将重新确认指纹') : t('已切换为应用数据目录独立存储，之后的首次连接将重新确认指纹'), 'info')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      recordAudit('knownhosts.mode', mode, 'failure', message)
      setError(message)
    }
  }

  const removeEntry = async (pattern: string, keyType: string) => {
    const accepted = await confirmDialog({
      title: t('删除主机指纹'),
      message: t('确定删除「') + pattern + t('」的 ') + keyType + t(' 指纹记录吗？下次连接该主机将重新走首次信任确认流程。'),
      confirmLabel: t('删除'),
      danger: true
    })
    if (!accepted) return
    setBusyId(`${pattern}|${keyType}`)
    try {
      const removed = await knownHostsRemove(pattern, keyType)
      if (removed > 0) {
        recordAudit('knownhosts.delete', pattern, 'success', `${t('删除 ')}${keyType}${t(' 指纹条目')}`)
        showToast(t('已删除该主机指纹记录。'), 'success')
      } else {
        showToast(t('没有匹配的 known_hosts 条目。'), 'info')
      }
      await reload()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      recordAudit('knownhosts.delete', pattern, 'failure', message)
      showToast(`${t('删除失败：')}${message}`, 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="settings-section knownhosts-panel">
      <div className="settings-section-title"><Icon name="database" size={15} /> {t('已信任主机指纹')}</div>
      <div className="section-tip">
        {t('首次连接时确认过的主机指纹保存在本机 known_hosts 文件中，连接时严格匹配；指纹变化会被阻断。删除条目即撤销信任。')}
      </div>
      <label className="field">
        <span className="field-label">{t('指纹存储位置')}</span>
        <select
          className="glass-input"
          value={knownHostsMode}
          onChange={(event) => void changeMode(event.target.value as 'openssh' | 'appdata')}
        >
          <option value="openssh">{t('OpenSSH 兼容（~/.ssh/known_hosts）')}</option>
          <option value="appdata">{t('应用数据目录独立存储')}</option>
        </select>
      </label>
      <div className="section-tip">{t('切换存储位置后，新位置的指纹为空，之后的首次连接将重新弹出指纹确认；已建立会话不受影响。')}</div>
      {error && <div className="form-error">{error}</div>}
      {snapshot && (
        <div className="knownhosts-path" title={snapshot.path}>
          <Icon name="folder" size={13} />
          <span>{snapshot.path}</span>
        </div>
      )}
      {snapshot && !snapshot.entries.length && (
        <div className="section-tip">{t('还没有已信任的主机指纹。首次连接未知主机并确认指纹后会出现在这里。')}</div>
      )}
      <div className="knownhosts-list">
        {(snapshot?.entries ?? []).map((entry) => {
          const key = `${entry.pattern}|${entry.keyType}`
          return (
            <div className="knownhosts-row" key={key}>
              <span className="knownhosts-pattern" title={entry.pattern}>{entry.pattern}</span>
              <span className="knownhosts-type">{entry.keyType}</span>
              <span className="knownhosts-fingerprint" title={entry.fingerprint}>{entry.fingerprint}</span>
              <button
                className="host-icon-btn danger"
                title={t('删除该条目')}
                disabled={busyId === key}
                onClick={() => void removeEntry(entry.pattern, entry.keyType)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          )
        })}
      </div>
      {snapshot && snapshot.entries.length > 0 && (
        <div className="section-tip">{t('共 ')}{snapshot.entries.length}{t(' 条记录。修改他人或本应用写入的该文件可能影响 OpenSSH 等客户端。')}</div>
      )}
    </div>
  )
}