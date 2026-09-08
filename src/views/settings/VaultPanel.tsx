import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { useVault } from '../../store/vault'
import { useSettings, VAULT_AUTO_LOCK_OPTIONS } from '../../store/settings'

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
  const init = useVault((state) => state.init)
  const setup = useVault((state) => state.setup)
  const unlock = useVault((state) => state.unlock)
  const lock = useVault((state) => state.lock)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const vaultAutoLockMinutes = useSettings((state) => state.vaultAutoLockMinutes)
  const setVaultAutoLockMinutes = useSettings((state) => state.setVaultAutoLockMinutes)
  const saveVaultAutoLockMinutes = useSettings((state) => state.saveVaultAutoLockMinutes)

  useEffect(() => {
    void init()
  }, [init])

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

  return (
    <div className="settings-section vault-panel">
      <div className="settings-section-title"><Icon name="key" size={15} /> 凭据保险箱</div>
      <div className="section-tip">
        密码和私钥口令使用 PBKDF2 + AES-GCM 加密保存。主密码不会写入磁盘，忘记主密码无法恢复保险箱内容。
      </div>
      {!ready ? <div className="section-tip">正在读取保险箱状态…</div> : unlocked ? (
        <div className="vault-status-row">
          <span><span className="status-dot" /> 保险箱已解锁</span>
          <button className="glass-btn" onClick={lock}>锁定</button>
        </div>
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
      {error && unlocked && <div className="form-error">{error}</div>}
      {notice && unlocked && <div className="form-notice">{notice}</div>}
    </div>
  )
}
