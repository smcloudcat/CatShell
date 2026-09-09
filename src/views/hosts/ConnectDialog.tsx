import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Icon } from '../../components/Icon'
import { useSessions } from '../../store/sessions'
import { AuthMethod, ConnectRequest } from '../../types/session'
import { HostProfile, HOST_ICON_OPTIONS, normalizeHostIcon, HostProxyProfile } from '../../types/host'
import { HostIconName } from '../../types/host'
import { useHosts } from '../../store/hosts'
import { useVault } from '../../store/vault'
import { useT } from '../../i18n'

interface Props {
  open: boolean
  onClose: () => void
  onConnected?: () => void
  profile?: HostProfile | null
}

interface FormState {
  name: string
  icon: HostIconName
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
  proxyEnabled: boolean
  proxyHost: string
  proxyPort: string
  proxyUsername: string
  proxyAuthMethod: 'password' | 'key'
  proxyPassword: string
  proxyKeyPath: string
  proxyPassphrase: string
}

const FORM_EMPTY: FormState = {
  name: '',
  icon: 'server',
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
  tags: '',
  proxyEnabled: false,
  proxyHost: '',
  proxyPort: '22',
  proxyUsername: '',
  proxyAuthMethod: 'password',
  proxyPassword: '',
  proxyKeyPath: '',
  proxyPassphrase: ''
}

function formFromProfile(profile?: HostProfile | null): FormState {
  if (!profile) return FORM_EMPTY
  return {
    name: profile.name,
    icon: normalizeHostIcon(profile.icon),
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
    tags: profile.tags.join(', '),
    proxyEnabled: profile.proxy.enabled,
    proxyHost: profile.proxy.host,
    proxyPort: String(profile.proxy.port),
    proxyUsername: profile.proxy.username,
    proxyAuthMethod: profile.proxy.authMethod,
    proxyPassword: '',
    proxyKeyPath: profile.proxy.keyPath ?? '',
    proxyPassphrase: ''
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
  const t = useT()
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
      const proxyCredential = getCredential(`proxy:${profile.id}`)
      if (proxyCredential) {
        next.proxyPassword = proxyCredential.password ?? ''
        next.proxyPassphrase = proxyCredential.passphrase ?? ''
      }
    }
    setForm(next)
  }, [getCredential, profile, vaultUnlocked, visible])

  if (!visible) return null

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }))

  const pickKey = async (target: 'keyPath' | 'proxyKeyPath' = 'keyPath') => {
    try {
      const file = await open({
        multiple: false,
        title: t('选择 SSH 私钥'),
        filters: [
          { name: t('私钥文件'), extensions: ['pem', 'key', 'ppk', 'ed25519'] },
          { name: t('所有文件'), extensions: ['*'] }
        ]
      })
      if (typeof file === 'string') {
        set({ [target]: file } as Partial<FormState>)
      }
    } catch {
      setError(t('无法打开文件选择器'))
    }
  }

  const buildProxy = ():
    | { ok: true; proxy: ConnectRequest['proxy'] }
    | { ok: false; error: string } => {
    if (!form.proxyEnabled) return { ok: true, proxy: null }
    const proxyHost = form.proxyHost.trim()
    const proxyPort = Number(form.proxyPort)
    const proxyUsername = form.proxyUsername.trim()
    if (!proxyHost) return { ok: false, error: t('请输入跳板机地址') }
    if (!proxyUsername) return { ok: false, error: t('请输入跳板机用户名') }
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      return { ok: false, error: t('跳板机端口必须是 1 到 65535 之间的整数') }
    }
    if (form.proxyAuthMethod === 'key' && !form.proxyKeyPath.trim()) {
      return { ok: false, error: t('跳板机认证选择了私钥，请选择私钥文件') }
    }
    return {
      ok: true,
      proxy: {
        host: proxyHost,
        port: proxyPort,
        username: proxyUsername,
        authMethod: form.proxyAuthMethod,
        password: form.proxyAuthMethod === 'password' && form.proxyPassword ? form.proxyPassword : null,
        keyPath: form.proxyAuthMethod === 'key' ? form.proxyKeyPath.trim() : null,
        passphrase: form.proxyAuthMethod === 'key' && form.proxyPassphrase ? form.proxyPassphrase : null
      }
    }
  }

  /** 主机配置只持久化跳板机非敏感字段；payload 与 buildProxy 同源，连接与保存两条路径不再分叉。 */
  const buildPersistedProxy = (proxy: ConnectRequest['proxy'], fallback: HostProxyProfile): HostProxyProfile => {
    if (!proxy) return fallback
    return {
      enabled: true,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      authMethod: proxy.authMethod,
      keyPath: proxy.keyPath ?? null
    }
  }

  const submit = async () => {
    setError(null)
    const host = form.host.trim()
    const port = Number(form.port)
    if (!host) {
      setError(t('请输入主机地址'))
      return
    }
    if (!form.username.trim()) {
      setError(t('请输入用户名'))
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError(t('端口必须是 1 到 65535 之间的整数'))
      return
    }
    if (form.authMethod === 'password' && !form.password) {
      setError(t('请输入登录密码'))
      return
    }
    if (form.authMethod === 'key' && !form.keyPath.trim()) {
      setError(t('请选择私钥文件'))
      return
    }
    const proxy = buildProxy()
    if (!proxy.ok) {
      setError(proxy.error)
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
      autoReconnect: form.autoReconnect,
      proxy: proxy.proxy
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
          icon: form.icon,
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
          proxy: buildPersistedProxy(proxy.proxy, {
            enabled: false,
            host: '',
            port: 22,
            username: '',
            authMethod: 'password',
            keyPath: null
          }),
          createdAt: profile?.createdAt ?? now,
          updatedAt: now
        })
       if (vaultUnlocked && (request.password || request.passphrase)) {
          await saveCredential(hostId, {
            password: request.password ?? undefined,
            passphrase: request.passphrase ?? undefined
          })
        }
        if (vaultUnlocked && proxy.proxy && (proxy.proxy.password || proxy.proxy.passphrase)) {
          await saveCredential(`proxy:${hostId}`, {
            password: proxy.proxy.password ?? undefined,
            passphrase: proxy.proxy.passphrase ?? undefined
          })
        }
        setForm(FORM_EMPTY)
        onClose()
        onConnected?.()
      }
    } catch (err) {
      setError(typeof err === 'string' ? err : t('连接失败'))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setError(null)
    const host = form.host.trim()
    const port = Number(form.port)
    if (!host) {
      setError(t('请输入主机地址'))
      return
    }
    if (!form.username.trim()) {
      setError(t('请输入用户名'))
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError(t('端口必须是 1 到 65535 之间的整数'))
      return
    }
    if (form.authMethod === 'key' && !form.keyPath.trim()) {
      setError(t('请选择私钥文件'))
      return
    }
    const proxy = buildProxy()
    if (!proxy.ok) {
      setError(proxy.error)
      return
    }

    const now = Date.now()
    const hostId = profile?.id ?? crypto.randomUUID()
    setBusy(true)
    try {
      await upsertHost({
        id: hostId,
        name: form.name.trim() || `${form.username.trim()}@${host}`,
        icon: form.icon,
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
        proxy: buildPersistedProxy(proxy.proxy, {
          enabled: false,
          host: '',
          port: 22,
          username: '',
          authMethod: 'password',
          keyPath: null
        }),
        createdAt: profile?.createdAt ?? now,
        updatedAt: now
        })
      if (vaultUnlocked && (form.password || form.passphrase)) {
        await saveCredential(hostId, {
          password: form.password || undefined,
          passphrase: form.passphrase || undefined
        })
      }
      if (vaultUnlocked && proxy.proxy && (proxy.proxy.password || proxy.proxy.passphrase)) {
        await saveCredential(`proxy:${hostId}`, {
          password: proxy.proxy.password ?? undefined,
          passphrase: proxy.proxy.passphrase ?? undefined
        })
      }
      setForm(FORM_EMPTY)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('保存失败'))
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
            {profile ? t('编辑并连接') : t('新建连接')}
          </div>
          <button className="modal-close" onClick={onClose} title={t('关闭')}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="modal-body">
          <div className="form-grid">
            <label className="field span-2">
              <span className="field-label">{t('名称（可选）')}</span>
              <input
                className="glass-input"
                placeholder={t('例如 production-api')}
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <div className="field span-2">
              <span className="field-label">{t('图标')}</span>
              <div className="icon-picker">
                {HOST_ICON_OPTIONS.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={`icon-option ${form.icon === name ? 'active' : ''}`}
                    onClick={() => set({ icon: name })}
                    title={name}
                  >
                    <Icon name={name} size={17} />
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span className="field-label">{t('主机地址')}</span>
              <input
                className="glass-input"
                placeholder="192.168.1.20"
                value={form.host}
                onChange={(e) => set({ host: e.target.value })}
                autoFocus
              />
            </label>
            <label className="field">
              <span className="field-label">{t('端口')}</span>
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
              <span className="field-label">{t('用户名')}</span>
              <input
                className="glass-input"
                placeholder="root"
                value={form.username}
                onChange={(e) => set({ username: e.target.value })}
              />
            </label>
            <div className="field span-2">
              <span className="field-label">{t('认证方式')}</span>
              <div className="seg-group">
                <button
                  className={`seg-btn ${form.authMethod === 'password' ? 'active' : ''}`}
                  onClick={() => set({ authMethod: 'password' })}
                >
                  {t('密码')}
                </button>
                <button
                  className={`seg-btn ${form.authMethod === 'key' ? 'active' : ''}`}
                  onClick={() => set({ authMethod: 'key' })}
                >
                  {t('SSH 私钥')}
                </button>
                <button
                  className={`seg-btn ${form.authMethod === 'agent' ? 'active' : ''}`}
                  onClick={() => set({ authMethod: 'agent' })}
                >
                  SSH Agent
                </button>
                <button
                  className={`seg-btn ${form.authMethod === 'keyboard-interactive' ? 'active' : ''}`}
                  onClick={() => set({ authMethod: 'keyboard-interactive' })}
                >
                  {t('交互式 2FA')}
                </button>
              </div>
            </div>
            {form.authMethod === 'password' ? (
              <label className="field span-2">
                <span className="field-label">{t('登录密码')}</span>
                <input
                  className="glass-input"
                  type="password"
                  value={form.password}
                  onChange={(e) => set({ password: e.target.value })}
                />
              </label>
            ) : form.authMethod === 'agent' ? (
              <div className="field span-2">
                <span className="field-label">SSH Agent</span>
                <div className="section-tip">
                  {t('Windows 优先尝试 Pageant，其次 OpenSSH agent 命名管道（\\\\.\\pipe\\openssh-ssh-agent）；其他平台读取 SSH_AUTH_SOCK。连接时将逐个尝试 Agent 中的密钥，无需输入口令。')}
                </div>
              </div>
            ) : form.authMethod === 'keyboard-interactive' ? (
              <>
                <label className="field span-2">
                  <span className="field-label">{t('登录密码（服务器要求时填写）')}</span>
                  <input
                    className="glass-input"
                    type="password"
                    autoComplete="current-password"
                    value={form.password}
                    onChange={(e) => set({ password: e.target.value })}
                  />
                </label>
                <label className="field span-2">
                  <span className="field-label">{t('一次性验证码（留空则连接时弹出交互输入）')}</span>
                  <input
                    className="glass-input"
                    type="password"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder={t('预填后连接时自动应答；留空则逐个提示输入')}
                    value={form.otpSecret}
                    onChange={(e) => set({ otpSecret: e.target.value })}
                  />
                </label>
              </>
            ) : (
              <>
                <div className="field span-2">
                  <span className="field-label">{t('私钥文件')}</span>
                  <div className="key-picker">
                    <input
                      className="glass-input"
                      readOnly
                      placeholder={t('未选择私钥')}
                      value={form.keyPath}
                      onDoubleClick={() => void pickKey('keyPath')}
                    />
                    <button className="glass-btn" onClick={() => void pickKey('keyPath')} type="button">
                      <Icon name="folder" size={14} />
                      {t('选择')}
                    </button>
                  </div>
                </div>
                <label className="field span-2">
                  <span className="field-label">{t('私钥口令（可选）')}</span>
                  <input
                    className="glass-input"
                    type="password"
                    placeholder={t('无口令可留空')}
                    value={form.passphrase}
                    onChange={(e) => set({ passphrase: e.target.value })}
                  />
                </label>
              </>
            )}
            <label className="field">
              <span className="field-label">{t('心跳间隔（秒）')}</span>
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
              <span className="field-label">{t('分组（可选）')}</span>
              <input
                className="glass-input"
                placeholder={t('例如 生产环境')}
                value={form.group}
                onChange={(e) => set({ group: e.target.value })}
              />
            </label>
            <label className="field span-2">
              <span className="field-label">{t('标签（可选，逗号分隔）')}</span>
              <input
                className="glass-input"
                placeholder={t('例如 web, linux, 部署目标')}
                value={form.tags}
                onChange={(e) => set({ tags: e.target.value })}
              />
            </label>
            <label className="field checkbox-field">
              <span className="field-label">{t('跳板机（ProxyJump）')}</span>
              <input
                type="checkbox"
                checked={form.proxyEnabled}
                onChange={(e) => set({ proxyEnabled: e.target.checked })}
              />
            </label>
            {form.proxyEnabled && (
              <>
                <label className="field">
                  <span className="field-label">{t('跳板机地址')}</span>
                  <input
                    className="glass-input"
                    placeholder={t('例如 bastion.corp')}
                    value={form.proxyHost}
                    onChange={(e) => set({ proxyHost: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">{t('跳板机端口')}</span>
                  <input
                    className="glass-input"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.proxyPort}
                    onChange={(e) => set({ proxyPort: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">{t('跳板机用户名')}</span>
                  <input
                    className="glass-input"
                    placeholder="root"
                    value={form.proxyUsername}
                    onChange={(e) => set({ proxyUsername: e.target.value })}
                  />
                </label>
                <div className="field">
                  <span className="field-label">{t('跳板机认证')}</span>
                  <div className="seg-group">
                    <button
                      className={`seg-btn ${form.proxyAuthMethod === 'password' ? 'active' : ''}`}
                      onClick={() => set({ proxyAuthMethod: 'password' })}
                    >
                      {t('密码')}
                    </button>
                    <button
                      className={`seg-btn ${form.proxyAuthMethod === 'key' ? 'active' : ''}`}
                      onClick={() => set({ proxyAuthMethod: 'key' })}
                    >
                      {t('私钥')}
                    </button>
                  </div>
                </div>
                {form.proxyAuthMethod === 'password' ? (
                  <label className="field">
                    <span className="field-label">{t('跳板机密码')}</span>
                    <input
                      className="glass-input"
                      type="password"
                      value={form.proxyPassword}
                      onChange={(e) => set({ proxyPassword: e.target.value })}
                    />
                  </label>
                ) : (
                  <div className="field">
                    <span className="field-label">{t('跳板机私钥')}</span>
                    <div className="key-picker">
                      <input
                        className="glass-input"
                        readOnly
                        placeholder={t('未选择私钥')}
                        value={form.proxyKeyPath}
                        onDoubleClick={() => void pickKey('proxyKeyPath')}
                      />
                      <button className="glass-btn" onClick={() => void pickKey('proxyKeyPath')} type="button">
                        <Icon name="folder" size={14} />
                        {t('选择')}
                      </button>
                    </div>
                  </div>
                )}
                {form.proxyAuthMethod === 'key' && (
                  <label className="field">
                    <span className="field-label">{t('跳板机私钥口令（可选）')}</span>
                    <input
                      className="glass-input"
                      type="password"
                      value={form.proxyPassphrase}
                      onChange={(e) => set({ proxyPassphrase: e.target.value })}
                    />
                  </label>
                )}
                <div className="field span-2">
                  <div className="section-tip">
                    {t('连接时先登录跳板机，再经其 direct-tcpip 隧道连接目标主机；目标与跳板机的主机指纹分别确认。跳板机凭据与登录密码同等对待，不写入主机配置。')}
                  </div>
                </div>
              </>
            )}
            <label className="field checkbox-field">
              <span className="field-label">{t('断线自动重连')}</span>
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
                <div className="section-tip">{t('连接成功后将自动加密保存当前凭据，下次可直接从主机列表一键连接。')}</div>
              ) : (
                <div className="section-tip">{t('凭据保险箱当前已锁定，请在「设置 → 凭据保险箱」解锁后才能自动保存凭据。')}</div>
              )
            ) : (
              <div className="section-tip">{t('密码与私钥口令不会写入主机配置文件。如需自动保存并在下次连接时复用，请在「设置 → 凭据保险箱」设置主密码。')}</div>
            ))}
          {error && <div className="form-error">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button className="glass-btn" onClick={onClose} disabled={busy}>
            {t('取消')}
          </button>
          <button className="glass-btn" onClick={save} disabled={busy}>
            <Icon name="save" size={15} />
            {t('保存配置')}
          </button>
          <button className="glass-btn primary" onClick={submit} disabled={busy}>
            <Icon name="link" size={15} />
            {busy ? t('连接中…') : t('连接')}
          </button>
        </footer>
      </div>
    </div>
  )
}
