import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { useVault, VaultCredential } from '../../store/vault'
import { useSettings, VAULT_AUTO_LOCK_OPTIONS } from '../../store/settings'
import { useHosts } from '../../store/hosts'
import { confirmDialog } from '../../store/ui'

const AUTO_LOCK_LABELS: Record<number, string> = {
  0: '关闭',
  5: '5 分钟',
  15: '15 分钟',
  30: '30 分钟'
}

export function VaultPanel() {
  const ready = useVault((state) => state.ready)
  const configured = useVault((state) => state.configured)
  const unlocked = useVault((state) => state.unlocked)
  const entries = useVault((state) => state.entries)
  const init = useVault((state) => state.init)
  const setup = useVault((state) => state.setup)
  const unlock = useVault((state) => state.unlock)
  const lock = useVault((state) => state.lock)
  const changeMasterPassword = useVault((state) => state.changeMasterPassword)
  const removeCredential = useVault((state) => state.removeCredential)
  const hosts = useHosts((state) => state.hosts)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newConfirm, setNewConfirm] = useState('')
  const [changeError, setChangeError] = useState<string | null>(null)
  const [changeNotice, setChangeNotice] = useState<string | null>(null)
  const [changeBusy, setChangeBusy] = useState(false)
  const vaultAutoLockMinutes = useSettings((state) => state.vaultAutoLockMinutes)
  const setVaultAutoLockMinutes = useSettings((state) => state.setVaultAutoLockMinutes)
  const saveVaultAutoLockMinutes = useSettings((state) => state.saveVaultAutoLockMinutes)
  const vaultBlurLock = useSettings((state) => state.vaultBlurLock)
  const setVaultBlurLock = useSettings((state) => state.setVaultBlurLock)
  const saveVaultBlurLock = useSettings((state) => state.saveVaultBlurLock)

  useEffect(() => {
    void init()
  }, [init])

  const hostName = (id: string): string => {
    const host = hosts.find((item) => item.id === id)
    if (host) return host.name || `${host.username}@${host.host}`
    return id.slice(0, 8)
  }

  const submit = async () => {
    setError(null)
    setNotice(null)
    if (!password) {
      setError('请输入主密码')
      return
    }
    if (!configured && password !== confirm) {
      setError('两次输入的主密码不一致')
      return
    }
    setBusy(true)
    try {
      if (configured) {
        await unlock(password)
        setNotice('凭据保险箱已解锁')
      } else {
        await setup(password)
        setNotice('凭据保险箱已创建并解锁')
      }
      setPassword('')
      setConfirm('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保险箱操作失败')
    } finally {
      setBusy(false)
    }
  }

  const submitChangePassword = async () => {
    setChangeError(null)
    setChangeNotice(null)
    if (!oldPassword || !newPassword) {
      setChangeError('请填写原主密码与新主密码')
      return
    }
    if (newPassword !== newConfirm) {
      setChangeError('两次输入的新主密码不一致')
      return
    }
    if (newPassword === oldPassword) {
      setChangeError('新主密码不能与原主密码相同')
      return
    }
    setChangeBusy(true)
    try {
      await changeMasterPassword(oldPassword, newPassword)
      setChangeNotice('主密码已更换，保险箱已使用新盐重新加密')
      setOldPassword('')
      setNewPassword('')
      setNewConfirm('')
    } catch (err) {
      setChangeError(err instanceof Error ? err.message : '修改主密码失败')
    } finally {
      setChangeBusy(false)
    }
  }

  const deleteCredential = async (id: string) => {
    const accepted = await confirmDialog({
      title: '删除保险箱凭据',
      message: `确定删除「${hostName(id)}」保存的凭据吗？该主机下次连接时需要重新输入凭据。`,
      confirmLabel: '删除',
      danger: true
    })
    if (!accepted) return
    try {
      await removeCredential(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除凭据失败')
    }
  }

  const credentialIds = Object.keys(entries)

  return (
    <div className="settings-section vault-panel">
      <div className="settings-section-title"><Icon name="key" size={15} /> 凭据保险箱</div>
      <div className="section-tip">
        密码和私钥口令使用 PBKDF2 + AES-GCM 加密保存。主密码不会写入磁盘，忘记主密码无法恢复保险箱内容。
      </div>
      {!ready ? <div className="section-tip">正在读取保险箱状态…</div> : unlocked ? (
        <>
          <div className="vault-status-row">
            <span><span className="status-dot" /> 保险箱已解锁</span>
            <button className="glass-btn" onClick={lock}>锁定</button>
          </div>
          <div className="vault-credentials">
            <div className="vault-credentials-title">已保存凭据（{credentialIds.length}）</div>
            {!credentialIds.length ? (
              <div className="section-tip">还没有保存任何凭据。连接主机时勾选自动保存即可写入保险箱。</div>
            ) : (
              <div className="vault-cred-list">
                {credentialIds.map((id) => {
                  const credential: VaultCredential = entries[id]
                  return (
                    <div className="vault-cred-row" key={id}>
                      <span className="vault-cred-name" title={id}>{hostName(id)}</span>
                      <span className="vault-cred-kinds">
                        {credential.password ? <span className="vault-cred-kind">密码</span> : null}
                        {credential.passphrase ? <span className="vault-cred-kind">私钥口令</span> : null}
                        {!credential.password && !credential.passphrase ? <span className="vault-cred-kind">空凭据</span> : null}
                      </span>
                      <button
                        className="host-icon-btn danger"
                        title="删除凭据"
                        onClick={() => void deleteCredential(id)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="section-tip">凭据内容不可查看，只能整体删除。删除对应主机会自动清理其凭据。</div>
          </div>
          <div className="vault-change-password">
            <div className="vault-credentials-title">修改主密码</div>
            <label className="field">
              <span className="field-label">原主密码</span>
              <input className="glass-input" type="password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} autoComplete="current-password" />
            </label>
            <div className="vault-change-grid">
              <label className="field">
                <span className="field-label">新主密码</span>
                <input className="glass-input" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 8 个字符" autoComplete="new-password" />
              </label>
              <label className="field">
                <span className="field-label">确认新主密码</span>
                <input className="glass-input" type="password" value={newConfirm} onChange={(event) => setNewConfirm(event.target.value)} autoComplete="new-password" />
              </label>
            </div>
            {changeError && <div className="form-error">{changeError}</div>}
            {changeNotice && <div className="form-notice">{changeNotice}</div>}
            <button className="glass-btn" onClick={() => void submitChangePassword()} disabled={changeBusy}>
              <Icon name="refresh" size={15} />
              {changeBusy ? '重新加密中…' : '更换主密码'}
            </button>
            <div className="section-tip">更换主密码会用新盐重新加密全部凭据，已有凭据内容保持不变。</div>
          </div>
        </>
      ) : (
        <>
          <label className="field">
            <span className="field-label">{configured ? '主密码' : '设置主密码'}</span>
            <input className="glass-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 个字符" />
          </label>
          {!configured && (
            <label className="field">
              <span className="field-label">确认主密码</span>
              <input className="glass-input" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            </label>
          )}
          {error && <div className="form-error">{error}</div>}
          {notice && <div className="form-notice">{notice}</div>}
          <button className="glass-btn primary" onClick={() => void submit()} disabled={busy}>
            <Icon name="key" size={15} />
            {busy ? '处理中…' : configured ? '解锁保险箱' : '创建保险箱'}
          </button>
        </>
      )}
      <label className="field vault-auto-lock">
        <span className="field-label">闲置自动锁定</span>
        <select
          className="glass-input"
          value={String(vaultAutoLockMinutes)}
          onChange={(event) => {
            setVaultAutoLockMinutes(Number(event.target.value))
            void saveVaultAutoLockMinutes()
          }}
        >
          {VAULT_AUTO_LOCK_OPTIONS.map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {AUTO_LOCK_LABELS[minutes] ?? `${minutes} 分钟`}
            </option>
          ))}
        </select>
      </label>
      <div className="section-tip">保险箱解锁后，若在设定时长内没有任何凭据操作，将自动锁定并清除内存中的明文凭据。</div>
      <label className="field checkbox-field">
        <span className="field-label">窗口失焦时自动锁定</span>
        <input
          type="checkbox"
          checked={vaultBlurLock}
          onChange={(event) => {
            setVaultBlurLock(event.target.checked)
            void saveVaultBlurLock()
          }}
        />
      </label>
      <div className="section-tip">开启后，只要应用窗口失去焦点（切换到其他窗口），保险箱立即锁定并清除内存凭据。关闭的窗口（如文件选择器）不会触发锁定。</div>
      {error && unlocked && <div className="form-error">{error}</div>}
      {notice && unlocked && <div className="form-notice">{notice}</div>}
    </div>
  )
}