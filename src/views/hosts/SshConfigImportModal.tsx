import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { HostProfile } from '../../types/host'
import { SshConfigEntry } from '../../types/session'
import { sshConfigParse } from '../../api/ssh'
import { useHosts } from '../../store/hosts'
import { recordAudit } from '../../store/audit'
import { showToast } from '../../store/ui'
import { addressKey } from '../../utils/hostList'
import { useT } from '../../i18n'

interface Props {
  onClose: () => void
  importProfiles: (profiles: Partial<HostProfile>[]) => Promise<void>
}

/**
 * 从 `~/.ssh/config` 导入主机。
 *
 * 已存在的「主机+端口+用户名」条目标记为重复但不阻止勾选：
 * 本次导入是新增语义，覆盖与否由用户在列表里自行取舍。
 */
export function SshConfigImportModal({ onClose, importProfiles }: Props) {
  const t = useT()
  const hosts = useHosts((s) => s.hosts)
  const [entries, setEntries] = useState<SshConfigEntry[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const parsed = await sshConfigParse()
        if (cancelled) return
        setEntries(parsed)
        setSelected(new Set(parsed.map((entry) => entry.host)))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const existingKeys = useMemo(
    () => new Set(hosts.map((host) => addressKey(host.host, host.port, host.username))),
    [hosts]
  )

  const duplicateKey = (entry: SshConfigEntry): string =>
    addressKey(entry.hostname ?? entry.host, entry.port ?? 22, entry.user ?? '')

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const confirmImport = async () => {
    if (!entries) return
    const chosen = entries.filter((entry) => selected.has(entry.host))
    if (!chosen.length) {
      setError(t('请至少选择一条主机配置'))
      return
    }
    setBusy(true)
    try {
      await importProfiles(
        chosen.map((entry) => ({
          name: entry.host,
          host: entry.hostname ?? entry.host,
          port: entry.port ?? 22,
          username: entry.user ?? '',
          // 有 IdentityFile 说明是密钥登录，否则按密码处理并要求用户补齐凭据。
          authMethod: entry.identityFile ? 'key' : 'password',
          keyPath: entry.identityFile ?? null,
          password: null,
          passphrase: null,
          group: null,
          tags: [],
          description: t('导入自 ~/.ssh/config')
        }))
      )
      recordAudit('host.import', '~/.ssh/config', 'success', `import ${chosen.length} OpenSSH entries`)
      showToast(t('已从 ~/.ssh/config 导入 ') + chosen.length + t(' 条主机配置。'), 'success')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('导入失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} className="sshconfig-modal">
      <header className="modal-header">
        <div className="modal-title"><Icon name="database" size={17} />{t('导入 ~/.ssh/config')}</div>
        <button className="modal-close" onClick={onClose} disabled={busy}><Icon name="x" size={15} /></button>
      </header>
      <div className="modal-body">
        {error ? (
          <div className="form-error">{error}</div>
        ) : !entries ? (
          <div className="section-tip">{t('正在读取并解析 ~/.ssh/config…')}</div>
        ) : !entries.length ? (
          <div className="section-tip">{t('配置文件中没有可导入的主机条目（通配符与 Match 块会被跳过）。')}</div>
        ) : (
          <>
            <p className="section-tip">
              {t('共 ')}{entries.length}{t(' 条。已存在的同 主机+端口+用户名 配置不会被覆盖。认证方式按 IdentityFile 推断；导入后请补齐凭据。')}
            </p>
            <div className="sshconfig-list">
              {entries.map((entry) => {
                const address = entry.hostname ?? entry.host
                const duplicate = existingKeys.has(duplicateKey(entry))
                return (
                  <label className="sshconfig-row" key={entry.host}>
                    <input
                      type="checkbox"
                      checked={selected.has(entry.host)}
                      onChange={() => toggle(entry.host)}
                    />
                    <span className="sshconfig-name">{entry.host}</span>
                    <span className="sshconfig-meta">
                      {entry.user ? `${entry.user}@` : ''}{address}:{entry.port ?? 22}
                      {entry.identityFile ? ` · ${entry.identityFile}` : ''}
                    </span>
                    {duplicate && <span className="sshconfig-dup">{t('已存在')}</span>}
                  </label>
                )
              })}
            </div>
          </>
        )}
      </div>
      <footer className="modal-footer">
        <button className="glass-btn" onClick={onClose} disabled={busy}>{t('取消')}</button>
        <button
          className="glass-btn primary"
          onClick={() => void confirmImport()}
          disabled={busy || !entries || !selected.size}
        >
          {busy ? t('导入中…') : t('导入所选（') + selected.size + t('）')}
        </button>
      </footer>
    </Modal>
  )
}
