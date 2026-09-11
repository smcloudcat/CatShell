import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { useSessions } from '../../store/sessions'
import { ConnectRequest, buildConnectRequest, buildProxyConfig, normalizeKeepalive } from '../../types/session'
import { HostProfile } from '../../types/host'
import { useHosts } from '../../store/hosts'
import { useVault } from '../../store/vault'
import { requestVaultUnlock } from '../../store/ui'
import { useT } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { HostAuthFields } from './HostAuthFields'
import { HostProxyFields } from './HostProxyFields'
import { HostIconPicker } from './HostIconPicker'
import {
  emptyConnectForm,
  ConnectFormError,
  ConnectFormState,
  EMPTY_PROXY_PROFILE,
  buildPersistedProxy,
  connectFormFromProfile,
  parseTagsInput,
  shouldLoadSavedCredentials,
  validateForConnect,
  validateForSave,
  validateProxyInput
} from './connectForm'

interface Props {
  open: boolean
  onClose: () => void
  onConnected?: () => void
  profile?: HostProfile | null
}

/** 校验原因码 → i18n 键。集中在一处，两条提交路径共用同一套文案。 */
const ERROR_TEXT: Record<ConnectFormError, string> = {
  host: '请输入主机地址',
  username: '请输入用户名',
  port: '端口必须是 1 到 65535 之间的整数',
  password: '请输入登录密码',
  keyPath: '请选择私钥文件',
  proxyHost: '请输入跳板机地址',
  proxyUsername: '请输入跳板机用户名',
  proxyPort: '跳板机端口必须是 1 到 65535 之间的整数',
  proxyKeyPath: '跳板机认证选择了私钥，请选择私钥文件',
  proxyInvalid: '跳板机配置无效'
}

export function ConnectDialog({ open: visible, onClose, onConnected, profile }: Props) {
  const t = useT()
  const [form, setForm] = useState<ConnectFormState>(() => connectFormFromProfile(profile))
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
    const next = connectFormFromProfile(profile)
    // 保险箱已解锁时把已保存的凭据预填进表单，用户不必重复输入。
    if (profile && useVault.getState().unlocked) {
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
  }, [getCredential, profile, visible])

  if (!visible) return null

  const set = (patch: Partial<ConnectFormState>) => setForm((f) => ({ ...f, ...patch }))

  const pickKey = async (target: 'keyPath' | 'proxyKeyPath' = 'keyPath') => {
    try {
      // 按需加载：文件选择器只在点「浏览」时用得到，静态引入会把整个插件
      // 拖进首屏包，也会让设置页的同类动态引入失效。
      const { open } = await import('@tauri-apps/plugin-dialog')
      const file = await open({
        multiple: false,
        title: t('选择 SSH 私钥'),
        filters: [
          { name: t('私钥文件'), extensions: ['pem', 'key', 'ppk', 'ed25519'] },
          { name: t('所有文件'), extensions: ['*'] }
        ]
      })
      if (typeof file === 'string') set({ [target]: file })
    } catch {
      setError(t('无法打开文件选择器'))
    }
  }

  /**
   * 把正在编辑的配置写入主机列表。
   * 只持久化非敏感字段；`request` 里的密码 / 口令走保险箱，两条路径共用同一份
   * 归一化结果，避免保存与连接对同一份表单给出不同解释。
   */
  const persistHost = async (hostId: string, request: ConnectRequest, now: number) => {
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
      proxy: buildPersistedProxy(request.proxy, EMPTY_PROXY_PROFILE),
      createdAt: profile?.createdAt ?? now,
      updatedAt: now
    })
  }

  const submit = async () => {
    setError(null)
    let password = form.password
    let passphrase = form.passphrase
    let proxyPassword = form.proxyPassword
    let proxyPassphrase = form.proxyPassphrase

    const needUnlock = shouldLoadSavedCredentials(form, {
      hasProfile: Boolean(profile),
      vaultConfigured,
      vaultUnlocked: useVault.getState().unlocked
    })
    if (needUnlock && profile) {
      if (!(await requestVaultUnlock())) return
      const credential = getCredential(profile.id)
      const proxyCredential = getCredential(`proxy:${profile.id}`)
      password ||= credential?.password ?? ''
      passphrase ||= credential?.passphrase ?? ''
      proxyPassword ||= proxyCredential?.password ?? ''
      proxyPassphrase ||= proxyCredential?.passphrase ?? ''
      setForm((current) => ({ ...current, password, passphrase, proxyPassword, proxyPassphrase }))
    }

    const validation = validateForConnect(form, password, form.keyPath)
    if (!validation.ok) {
      setError(t(ERROR_TEXT[validation.reason]))
      return
    }
    const proxy = validateProxyInput(form, proxyPassword, proxyPassphrase)
    if (!proxy.ok) {
      setError(t(ERROR_TEXT[proxy.reason]))
      return
    }

    const request = buildConnectRequest({
      name: form.name,
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username,
      authMethod: form.authMethod,
      password,
      keyPath: form.keyPath,
      passphrase,
      otpSecret: form.otpSecret,
      keepalive: form.keepalive,
      autoReconnect: form.autoReconnect,
      proxy: proxy.proxy
    })
    // 请求里带了凭据但保险箱还锁着 —— 现在解锁，否则本次连接无法自动保存凭据。
    if (
      vaultConfigured &&
      !useVault.getState().unlocked &&
      (request.password || request.passphrase || request.proxy?.password || request.proxy?.passphrase)
    ) {
      if (!(await requestVaultUnlock())) return
    }

    const hostId = profile?.id ?? crypto.randomUUID()
    setBusy(true)
    try {
      const id = await openSession(request, hostId)
      if (id <= 0) return
      await persistHost(hostId, request, Date.now())
      if (useVault.getState().unlocked && (request.password || request.passphrase)) {
        await saveCredential(hostId, {
          password: request.password ?? undefined,
          passphrase: request.passphrase ?? undefined
        })
      }
      if (useVault.getState().unlocked && request.proxy && (request.proxy.password || request.proxy.passphrase)) {
        await saveCredential(`proxy:${hostId}`, {
          password: request.proxy.password ?? undefined,
          passphrase: request.proxy.passphrase ?? undefined
        })
      }
      setForm(emptyConnectForm())
      onClose()
      onConnected?.()
    } catch (err) {
      setError(errorText(err, t, '连接失败'))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setError(null)
    const validation = validateForSave(form, form.keyPath)
    if (!validation.ok) {
      setError(t(ERROR_TEXT[validation.reason]))
      return
    }
    const proxy = validateProxyInput(form, form.proxyPassword, form.proxyPassphrase)
    if (!proxy.ok) {
      setError(t(ERROR_TEXT[proxy.reason]))
      return
    }
    const proxyConfig = buildProxyConfig(proxy.proxy)
    if (
      vaultConfigured &&
      !useVault.getState().unlocked &&
      (form.password || form.passphrase || proxyConfig?.password || proxyConfig?.passphrase)
    ) {
      if (!(await requestVaultUnlock())) return
    }

    const host = form.host.trim()
    const hostId = profile?.id ?? crypto.randomUUID()
    const now = Date.now()
    setBusy(true)
    try {
      await upsertHost({
        id: hostId,
        name: form.name.trim() || `${form.username.trim()}@${host}`,
        icon: form.icon,
        host,
        port: Number(form.port),
        username: form.username.trim(),
        authMethod: form.authMethod,
        password: null,
        keyPath: form.authMethod === 'key' ? form.keyPath.trim() : null,
        passphrase: null,
        group: form.group.trim() ? form.group.trim().slice(0, 48) : null,
        tags: parseTagsInput(form.tags),
        description: profile?.description ?? '',
        keepAliveInterval: normalizeKeepalive(form.keepalive),
        autoReconnect: form.autoReconnect,
        proxy: buildPersistedProxy(proxyConfig, EMPTY_PROXY_PROFILE),
        createdAt: profile?.createdAt ?? now,
        updatedAt: now
      })
      if (useVault.getState().unlocked && (form.password || form.passphrase)) {
        await saveCredential(hostId, {
          password: form.password || undefined,
          passphrase: form.passphrase || undefined
        })
      }
      if (useVault.getState().unlocked && proxy.proxy && (proxy.proxy.password || proxy.proxy.passphrase)) {
        await saveCredential(`proxy:${hostId}`, {
          password: proxy.proxy.password ?? undefined,
          passphrase: proxy.proxy.passphrase ?? undefined
        })
      }
      setForm(emptyConnectForm())
      onClose()
    } catch (err) {
      setError(errorText(err, t, '保存失败'))
    } finally {
      setBusy(false)
    }
  }

  const credentialHint = (): string => {
    if (vaultConfigured) {
      return vaultUnlocked
        ? t('连接成功后将自动加密保存当前凭据，下次可直接从主机列表一键连接。')
        : t('凭据保险箱当前已锁定，请在「设置 → 凭据保险箱」解锁后才能自动保存凭据。')
    }
    return t('密码与私钥口令不会写入主机配置文件。如需自动保存并在下次连接时复用，请在「设置 → 凭据保险箱」设置主密码。')
  }

  return (
    <Modal onClose={onClose} ariaLabel={profile ? t('编辑并连接') : t('新建连接')}>
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
          <HostIconPicker value={form.icon} onChange={(icon) => set({ icon })} />
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

          <HostAuthFields form={form} set={set} onPickKey={(target) => void pickKey(target)} />

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

          <HostProxyFields form={form} set={set} onPickKey={(target) => void pickKey(target)} />

          <label className="field checkbox-field">
            <span className="field-label">{t('断线自动重连')}</span>
            <input
              type="checkbox"
              checked={form.autoReconnect}
              onChange={(e) => set({ autoReconnect: e.target.checked })}
            />
          </label>
        </div>

        {((form.authMethod === 'password' && form.password) || (form.authMethod === 'key' && form.passphrase)) && (
          <div className="section-tip">{credentialHint()}</div>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
      <footer className="modal-footer">
        <button className="glass-btn" onClick={onClose} disabled={busy}>{t('取消')}</button>
        <button className="glass-btn" onClick={() => void save()} disabled={busy}>
          <Icon name="save" size={15} />
          {t('保存配置')}
        </button>
        <button className="glass-btn primary" onClick={() => void submit()} disabled={busy}>
          <Icon name="link" size={15} />
          {busy ? t('连接中…') : t('连接')}
        </button>
      </footer>
    </Modal>
  )
}
