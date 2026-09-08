import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Icon } from '../../components/Icon'
import { useSessions } from '../../store/sessions'
import { AuthMethod, ConnectRequest } from '../../types/session'
import { HostProfile } from '../../types/host'
import { useHosts } from '../../store/hosts'
import { useVault } from '../../store/vault'

interface Props {
  open: boolean
  onClose: () => void
  onConnected?: () => void
  profile?: HostProfile | null
}

interface FormState {
  name: string
  host: string
  port: string
  username: string
  authMethod: AuthMethod
  password: string
  keyPath: string
  passphrase: string
  otpSecret: string
  keepalive: string
  autoReconnect: boolean
  group: string
  tags: string
}

const FORM_EMPTY: FormState = {
  name: '',
  host: '',
  port: '22',
  username: '',
  authMethod: 'password',
  password: '',
  keyPath: '',
  passphrase: '',
  otpSecret: '',
  keepalive: '30',
  autoReconnect: true,
  group: '',
  tags: ''
}

function formFromProfile(profile?: HostProfile | null): FormState {
  if (!profile) return FORM_EMPTY
  return {
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    authMethod: profile.authMethod,
    password: '',
    keyPath: profile.keyPath ?? '',
    passphrase: '',
    otpSecret: '',
    keepalive: String(profile.keepAliveInterval),
    autoReconnect: profile.autoReconnect,
    group: profile.group ?? '',
    tags: profile.tags.join(', ')
  }
}

function parseTagsInput(value: string): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of value.split(/[,，、\s]+/)) {
    const tag = item.trim().slice(0, 24)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
    if (tags.length >= 10) break
  }
  return tags
}

export function ConnectDialog({ open: visible, onClose, onConnected, profile }: Props) {
  const [form, setForm] = useState<FormState>(() => formFromProfile(profile))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const openSession = useSessions((s) => s.open)
  const upsertHost = useHosts((s) => s.upsert)
  const vaultUnlocked = useVault((s) => s.unlocked)
  const vaultConfigured = useVault((s) => s.configured)
  const getCredential = useVault((s) => s.getCredential)
  const saveCredential = useVault((s) => s.saveCredential)

  useEffect(() => {
    if (!visible) return
    const next = formFromProfile(profile)
    if (profile && vaultUnlocked) {
      const credential = getCredential(profile.id)
      if (credential) {
        next.password = credential.password ?? ''
        next.passphrase = credential.passphrase ?? ''
      }
    }
    setForm(next)
  }, [getCredential, profile, vaultUnlocked, visible])

  if (!visible) return null

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }))

  const pickKey = async () => {
    try {
      const file = await open({
        multiple: false,
        title: '选择 SSH 私钥',
        filters: [
          { name: '私钥文件', extensions: ['pem', 'key', 'ppk', 'ed25519'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (typeof file === 'string') {
        set({ keyPath: file })
      }
    } catch {
      setError('无法打开文件选择器')
    }
  }

  const submit = async () => {
    setError(null)
    const host = form.host.trim()
    const port = Number(form.port)
    if (!host) {
      setError('请输入主机地址')
      return
    }
    if (!form.username.trim()) {
      setError('请输入用户名')
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('端口必须是 1 到 65535 之间的整数')
      return
    }
    if (form.authMethod === 'password' && !form.password) {
      setError('请输入登录密码')
      return
    }
    if (form.authMethod === 'keyboard-interactive' && !form.otpSecret.trim()) {
      setError('请输入一次性验证码')
      return
    }
    if (form.authMethod === 'key' && !form.keyPath.trim()) {
      setError('请选择私钥文件')
      return
    }
    const request: ConnectRequest = {
      name: form.name.trim() || `${form.username.trim()}@${host}`,
      host,
      port: Number.isFinite(port) && port > 0 ? port : 22,
      username: form.username.trim(),
      authMethod: form.authMethod,
      password: form.authMethod === 'password' || form.authMethod === 'keyboard-interactive' ? form.password : null,
      keyPath: form.authMethod === 'key' ? form.keyPath.trim() : null,
      passphrase: form.authMethod === 'key' && form.passphrase ? form.passphrase : null,
      otpSecret: form.authMethod === 'keyboard-interactive' ? form.otpSecret.trim() : null,
      keepalive: Number(form.keepalive) || 30,
      autoReconnect: form.autoReconnect
    }
    const hostId = profile?.id ?? crypto.randomUUID()
    setBusy(true)
    try {
      const id = await openSession(request)
      if (id > 0) {
        const now = Date.now()
        await upsertHost({
          id: hostId,
          name: request.name,
          icon: profile?.icon ?? 'server',
          host: request.host,
          port: request.port,
          username: request.username,
          authMethod: request.authMethod,
           password: null,
           keyPath: request.keyPath ?? null,
           passphrase: null,
          group: form.group.trim() ? form.group.trim().slice(0, 48) : (profile?.group ?? null),
          tags: parseTagsInput(form.tags),
          description: profile?.description ?? '',
          keepAliveInterval: request.keepalive,
          autoReconnect: request.autoReconnect,
          createdAt: profile?.createdAt ?? now,
          updatedAt: now
        })
       if (vaultUnlocked && (request.password || request.passphrase)) {
          await saveCredential(hostId, {
            password: request.password ?? undefined,
            passphrase: request.passphrase ?? undefined
          })
        }
        setForm(FORM_EMPTY)
        onClose()
        onConnected?.()
      }
    } catch (err) {
      setError(typeof err === 'string' ? err : '连接失败')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setError(null)
    const host = form.host.trim()
    const port = Number(form.port)
    if (!host) {
      setError('请输入主机地址')
      return
    }
    if (!form.username.trim()) {
      setError('请输入用户名')
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('端口必须是 1 到 65535 之间的整数')
      return
    }
    if (form.authMethod === 'key' && !form.keyPath.trim()) {
      setError('请选择私钥文件')
      return
    }

    const now = Date.now()
    const hostId = profile?.id ?? crypto.randomUUID()
    setBusy(true)
    try {
      await upsertHost({
        id: hostId,
        name: form.name.trim() || `${form.username.trim()}@${host}`,
        icon: profile?.icon ?? 'server',
        host,
        port,
        username: form.username.trim(),
        authMethod: form.authMethod,
        password: null,
        keyPath: form.authMethod === 'key' ? form.keyPath.trim() : null,
        passphrase: null,
        group: form.group.trim() ? form.group.trim().slice(0, 48) : null,
        tags: parseTagsInput(form.tags),
        description: profile?.description ?? '',
        keepAliveInterval: Math.min(300, Math.max(5, Number(form.keepalive) || 30)),
        autoReconnect: form.autoReconnect,
        createdAt: profile?.createdAt ?? now,
        updatedAt: now
        })
      if (vaultUnlocked && (form.password || form.passphrase)) {
        await saveCredential(hostId, {
          password: form.password || undefined,
          passphrase: form.passphrase || undefined
        })
      }
      setForm(FORM_EMPTY)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title">
            <Icon name="link" size={18} />
            {profile ? '编辑并连接' : '新建连接'}
          </div>
          <button className="modal-close" onClick={onClose} title="关闭">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="modal-body">
          <div className="form-grid">
            <label className="field span-2">
              <span className="field-label">名称（可选）</span>
              <input
                className="glass-input"
                placeholder="例如 production-api"
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">主机地址</span>
              <input
                className="glass-input"
                placeholder="192.168.1.20"
                value={form.host}
                onChange={(e) => set({ host: e.target.value })}
                autoFocus
              />
            </label>
            <label className="field">
              <span className="field-label">端口</span>
              <input
                className="glass-input"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => set({ port: e.target.value })}
              />
            </label>
            <label className="field span-2">
              <span className="field-label">用户名</span>
              <input
                className="glass-input"
                placeholder="root"
                value={form.username}
                onChange={(e) => set({ username: e.target.value })}
              />
            </label>
            <div className="field span-2">
              <span className="field-label">认证方式</span>
              <div className="seg-group">
                <button
                  className={`seg-btn ${form.authMethod === 'password' ? 'active' : ''}`}
                  onClick={() => set({ authMethod: 'password' })}
                >
                  密码
                </button>
                <button
                  className={`seg-btn ${form.authMethod === 'key' ? 'active' : ''}`}
                  onClick={() => set({ authMethod: 'key' })}
                >
                  SSH 私钥
                </button>
                <button
                  className={`seg-btn ${form.authMethod === 'keyboard-interactive' ? 'active' : ''}`}
                  onClick={() => set({ authMethod: 'keyboard-interactive' })}
                >
                  交互式 2FA
                </button>
              </div>
            </div>
            {form.authMethod === 'password' ? (
              <label className="field span-2">
                <span className="field-label">登录密码</span>
                <input
                  className="glass-input"
                  type="password"
                  value={form.password}
                  onChange={(e) => set({ password: e.target.value })}
                />
              </label>
            ) : form.authMethod === 'keyboard-interactive' ? (
              <>
                <label className="field span-2">
                  <span className="field-label">登录密码（服务器要求时填写）</span>
                  <input
                    className="glass-input"
                    type="password"
                    autoComplete="current-password"
                    value={form.password}
                    onChange={(e) => set({ password: e.target.value })}
                  />
                </label>
                <label className="field span-2">
                  <span className="field-label">一次性验证码</span>
                  <input
                    className="glass-input"
                    type="password"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="输入服务器提示的验证码"
                    value={form.otpSecret}
                    onChange={(e) => set({ otpSecret: e.target.value })}
                  />
                </label>
              </>
            ) : (
              <>
                <div className="field span-2">
                  <span className="field-label">私钥文件</span>
                  <div className="key-picker">
                    <input
                      className="glass-input"
                      readOnly
                      placeholder="未选择私钥"
                      value={form.keyPath}
                      onDoubleClick={pickKey}
                    />
                    <button className="glass-btn" onClick={pickKey} type="button">
                      <Icon name="folder" size={14} />
                      选择
                    </button>
                  </div>
                </div>
                <label className="field span-2">
                  <span className="field-label">私钥口令（可选）</span>
                  <input
                    className="glass-input"
                    type="password"
                    placeholder="无口令可留空"
                    value={form.passphrase}
                    onChange={(e) => set({ passphrase: e.target.value })}
                  />
                </label>
              </>
            )}
            <label className="field">
              <span className="field-label">心跳间隔（秒）</span>
              <input
                className="glass-input"
                type="number"
                min={5}
                max={300}
                value={form.keepalive}
                onChange={(e) => set({ keepalive: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">分组（可选）</span>
              <input
                className="glass-input"
                placeholder="例如 生产环境"
                value={form.group}
                onChange={(e) => set({ group: e.target.value })}
              />
            </label>
            <label className="field span-2">
              <span className="field-label">标签（可选，逗号分隔）</span>
              <input
                className="glass-input"
                placeholder="例如 web, linux, 部署目标"
                value={form.tags}
                onChange={(e) => set({ tags: e.target.value })}
              />
            </label>
            <label className="field checkbox-field">
              <span className="field-label">断线自动重连</span>
              <input
                type="checkbox"
                checked={form.autoReconnect}
                onChange={(e) => set({ autoReconnect: e.target.checked })}
              />
            </label>
          </div>
          {((form.authMethod === 'password' && form.password) ||
            (form.authMethod === 'key' && form.passphrase)) &&
            (vaultConfigured ? (
              vaultUnlocked ? (
                <div className="section-tip">连接成功后将自动加密保存当前凭据，下次可直接从主机列表一键连接。</div>
              ) : (
                <div className="section-tip">凭据保险箱当前已锁定，请在「设置 → 凭据保险箱」解锁后才能自动保存凭据。</div>
              )
            ) : (
              <div className="section-tip">密码与私钥口令不会写入主机配置文件。如需自动保存并在下次连接时复用，请在「设置 → 凭据保险箱」设置主密码。</div>
            ))}
          {error && <div className="form-error">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button className="glass-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="glass-btn" onClick={save} disabled={busy}>
            <Icon name="save" size={15} />
            保存配置
          </button>
          <button className="glass-btn primary" onClick={submit} disabled={busy}>
            <Icon name="link" size={15} />
            {busy ? '连接中…' : '连接'}
          </button>
        </footer>
      </div>
    </div>
  )
}
