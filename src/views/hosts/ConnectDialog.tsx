import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { useSessions } from '../../store/sessions'
import { ConnectRequest, buildConnectRequest, buildProxyConfig, collectProxyHops, normalizeKeepalive } from '../../types/session'
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
      // 第 2 跳及以后的凭据：key 为 `proxy:<hostId>:<hopIndex>`（hopIndex 从 0 起）。
      next.proxyNextHops = next.proxyNextHops.map((hop, index) => {
        const saved = getCredential(`proxy:${profile.id}:${index}`)
        if (!saved) return hop
        return { ...hop, password: saved.password ?? '', passphrase: saved.passphrase ?? '' }
      })
    }
    setForm(next)
  }, [getCredential, profile, visible])

  if (!visible) return null

  const set = (patch: Partial<ConnectFormState>) => setForm((f) => ({ ...f, ...patch }))

  const pickKey = async (target: string = 'keyPath') => {
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
      if (typeof file === 'string') {
        // 第 2 跳及以后的目标形如 `proxyHopKeyPath:<index>`：必须写回
        // proxyNextHops[index].keyPath，直接 set 只会写进一个没人读的死字段（审计 X-1）。
        const hopMatch = /^proxyHopKeyPath:(\d+)$/.exec(target)
        if (hopMatch) {
          const hopIndex = Number(hopMatch[1])
          setForm((current) => ({
            ...current,
            proxyNextHops: current.proxyNextHops.map((hop, index) =>
              index === hopIndex ? { ...hop, keyPath: file } : hop
            )
          }))
        } else {
          set({ [target]: file })
        }
      }
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
    // 跳板凭据要能直接参与本次校验与组链（审计 X-2）：旧实现只经 setForm 写进 state，
    // 而 React 的 state 更新是异步的，紧随其后的 validateForConnect / validateProxyInput /
    // buildConnectRequest 读到的仍是闭包里的旧 form（各跳密码为空），多跳认证必然失败，
    // 只有取消弹窗重连一次才正常。这里改为用局部快照传递。
    let hops = form.proxyNextHops

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
      hops = form.proxyNextHops.map((hop, index) => {
        const saved = getCredential(`proxy:${profile.id}:${index}`)
        return saved ? { ...hop, password: hop.password || saved.password || '', passphrase: hop.passphrase || saved.passphrase || '' } : hop
      })
      setForm((current) => ({ ...current, password, passphrase, proxyPassword, proxyPassphrase, proxyNextHops: hops }))
    }

    // 校验与组链统一用「已解析凭据」的快照，不再依赖异步 state。
    const resolved = { ...form, proxyNextHops: hops }

    const validation = validateForConnect(resolved, password, resolved.keyPath)
    if (!validation.ok) {
      setError(t(ERROR_TEXT[validation.reason]))
      return
    }
    const proxy = validateProxyInput(resolved, proxyPassword, proxyPassphrase)
    if (!proxy.ok) {
      setError(t(ERROR_TEXT[proxy.reason]))
      return
    }

    const request = buildConnectRequest({
      name: resolved.name,
      host: resolved.host.trim(),
      port: Number(resolved.port),
      username: resolved.username,
      authMethod: resolved.authMethod,
      password,
      keyPath: resolved.keyPath,
      passphrase,
      otpSecret: resolved.otpSecret,
      keepalive: resolved.keepalive,
      autoReconnect: resolved.autoReconnect,
      proxy: proxy.proxy
    })
    // 请求里带了凭据但保险箱还锁着 —— 现在解锁，否则本次连接无法自动保存凭据。
    const chainNeedsVault = (node: typeof request.proxy): boolean =>
      Boolean(node && (node.password || node.passphrase)) || chainNeedsVault(node?.next ?? null)
    if (vaultConfigured && !useVault.getState().unlocked && (request.password || request.passphrase || chainNeedsVault(request.proxy))) {
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
      if (useVault.getState().unlocked && request.proxy) {
        // 第 1 跳走固定 key，第 2 跳起按链上位置追加 `:<index>`。
        const hops = collectProxyHops(request.proxy)
        for (let index = 0; index < hops.length; index += 1) {
          const hop = hops[index]
          if (!hop) continue
          if (!hop.password && !hop.passphrase) continue
          const key = index === 0 ? `proxy:${hostId}` : `proxy:${hostId}:${index - 1}`
          await saveCredential(key, {
            password: hop.password ?? undefined,
            passphrase: hop.passphrase ?? undefined
          })
        }
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
      if (useVault.getState().unlocked && proxy.proxy) {
        // 与连接路径同规则：第 1 跳固定 key，第 2 跳起 `:<index>`。
        const hops = collectProxyHops(proxy.proxy)
        for (let index = 0; index < hops.length; index += 1) {
          const hop = hops[index]
          if (!hop) continue
          if (!hop.password && !hop.passphrase) continue
          const key = index === 0 ? `proxy:${hostId}` : `proxy:${hostId}:${index - 1}`
          await saveCredential(key, {
            password: hop.password ?? undefined,
            passphrase: hop.passphrase ?? undefined
          })
        }
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
