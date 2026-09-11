import { AuthMethod, MAX_PROXY_HOPS, ProxyConfigInput, normalizePort } from '../../types/session'
import { HostIconName, HostProfile, HostProxyProfile, normalizeHostIcon } from '../../types/host'

/**
 * 连接对话框的表单模型。
 *
 * 抽成独立模块有两个目的：
 * 1. 让「主机配置 → 表单」与「表单 → 连接请求」两条转换路径都能被单测覆盖；
 * 2. 密码 / 私钥口令等敏感字段的取舍规则集中在一处，避免在保存与连接两条
 *    分支里各写一份而逐渐漂移。
 */

/** 第 2 跳及以后的编辑形态：第 1 跳沿用平铺的 proxy* 字段，兼容旧数据与旧 UI。 */
export interface ProxyFormHop {
  host: string
  port: string
  username: string
  authMethod: 'password' | 'key'
  password: string
  keyPath: string
  passphrase: string
}

export function emptyProxyHop(): ProxyFormHop {
  return { host: '', port: '22', username: '', authMethod: 'password', password: '', keyPath: '', passphrase: '' }
}

export interface ConnectFormState {
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
  /** 第 2 跳及以后（ProxyJump 链）。第 1 跳字段平铺在外层。 */
  proxyNextHops: ProxyFormHop[]
}

export const CONNECT_FORM_EMPTY: ConnectFormState = {
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
  proxyPassphrase: '',
  proxyNextHops: []
}

/** 返回一份全新的空表单。共享常量只读，避免任何调用方原地改写污染其他人。 */
export function emptyConnectForm(): ConnectFormState {
  return { ...CONNECT_FORM_EMPTY }
}

/**
 * 由已保存的主机构建表单初始值。
 * 密码与口令一律留空：它们只存在于保险箱，编辑表单不应把明文带进内存。
 */
export function connectFormFromProfile(profile?: HostProfile | null): ConnectFormState {
  if (!profile) return emptyConnectForm()
  // 第 2 跳及以后从持久化链重建为编辑数组；密码 / 口令不回填（只在保险箱里）。
  const nextHops: ProxyFormHop[] = []
  let cursor = profile.proxy.next ?? null
  while (cursor && nextHops.length < MAX_PROXY_HOPS - 1) {
    nextHops.push({
      host: cursor.host,
      port: String(cursor.port),
      username: cursor.username,
      authMethod: cursor.authMethod,
      password: '',
      keyPath: cursor.keyPath ?? '',
      passphrase: ''
    })
    cursor = cursor.next ?? null
  }
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
    proxyPassphrase: '',
    proxyNextHops: nextHops
  }
}

/** 标签输入解析：逗号/顿号/空白分隔，去重、截断到 24 字符、最多 10 个。 */
export function parseTagsInput(value: string): string[] {
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

/** 校验失败的原因码，由调用方映射到 i18n 文案。 */
export type ConnectFormError =
  | 'host'
  | 'username'
  | 'port'
  | 'password'
  | 'keyPath'
  | 'proxyHost'
  | 'proxyUsername'
  | 'proxyPort'
  | 'proxyKeyPath'
  | 'proxyInvalid'

export type ConnectValidation =
  | { ok: true }
  | { ok: false; reason: ConnectFormError }

/** 目标主机的公共必填项：地址、用户名、端口。 */
function validateTargetBasics(form: ConnectFormState): ConnectValidation {
  if (!form.host.trim()) return { ok: false, reason: 'host' }
  if (!form.username.trim()) return { ok: false, reason: 'username' }
  const port = Number(form.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'port' }
  return { ok: true }
}

/**
 * 连接前的校验：比保存多一条「密码认证必须有密码」。
 * `password` 由调用方传入而不是直接读表单，因为刚从保险箱取回的凭据
 * 只写进了局部变量，尚未回写 state。
 */
export function validateForConnect(form: ConnectFormState, password: string, keyPath: string): ConnectValidation {
  const basics = validateTargetBasics(form)
  if (!basics.ok) return basics
  if (form.authMethod === 'password' && !password) return { ok: false, reason: 'password' }
  if (form.authMethod === 'key' && !keyPath.trim()) return { ok: false, reason: 'keyPath' }
  return { ok: true }
}

/** 保存配置的校验：不要求密码（凭据属于保险箱，不写进主机配置）。 */
export function validateForSave(form: ConnectFormState, keyPath: string): ConnectValidation {
  const basics = validateTargetBasics(form)
  if (!basics.ok) return basics
  if (form.authMethod === 'key' && !keyPath.trim()) return { ok: false, reason: 'keyPath' }
  return { ok: true }
}

/** 单跳（编辑形态）校验：只判断必填与范围。`hopKeyPath` 错误统一归到 proxyKeyPath。 */
function validateHop(hop: ProxyFormHop): ConnectValidation {
  if (!hop.host.trim()) return { ok: false, reason: 'proxyHost' }
  if (!hop.username.trim()) return { ok: false, reason: 'proxyUsername' }
  const port = Number(hop.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'proxyPort' }
  if (hop.authMethod === 'key' && !hop.keyPath.trim()) return { ok: false, reason: 'proxyKeyPath' }
  return { ok: true }
}

/**
 * 跳板链校验与组装：第 1 跳（平铺字段，凭据可能来自保险箱回填）+
 * `form.proxyNextHops`（第 2 跳起，凭据随表单），逐跳校验后串成链。
 * 组装出的链挂到 `buildConnectRequest` 做最终归一化。
 */
export function validateProxyInput(
  form: ConnectFormState,
  password: string,
  passphrase: string
): { ok: true; proxy: ProxyConfigInput | null } | { ok: false; reason: ConnectFormError } {
  if (!form.proxyEnabled) return { ok: true, proxy: null }
  const first: ProxyFormHop = {
    host: form.proxyHost,
    port: form.proxyPort,
    username: form.proxyUsername,
    authMethod: form.proxyAuthMethod,
    password,
    keyPath: form.proxyKeyPath,
    passphrase
  }
  const firstResult = validateHop(first)
  if (!firstResult.ok) return firstResult
  for (const hop of form.proxyNextHops) {
    const result = validateHop(hop)
    if (!result.ok) return result
  }
  const chain: ProxyConfigInput = {
    host: first.host,
    port: Number(first.port),
    username: first.username,
    authMethod: first.authMethod,
    password: first.password,
    keyPath: first.keyPath,
    passphrase: first.passphrase
  }
  // 串链：逐跳挂 next，超出 MAX_PROXY_HOPS 的尾部在此截断。
  let tail: ProxyConfigInput = chain
  for (const hop of form.proxyNextHops.slice(0, MAX_PROXY_HOPS - 1)) {
    const node: ProxyConfigInput = {
      host: hop.host,
      port: Number(hop.port),
      username: hop.username,
      authMethod: hop.authMethod,
      password: hop.password,
      keyPath: hop.keyPath,
      passphrase: hop.passphrase
    }
    tail.next = node
    tail = node
  }
  return { ok: true, proxy: chain }
}

/** 跳板链的持久化形态：逐级只保留非敏感字段。 */
export function buildPersistedProxy(
  proxy: ProxyConfigInput | null | undefined,
  fallback: HostProxyProfile
): HostProxyProfile {
  if (!proxy) return fallback
  const persist = (hop: ProxyConfigInput): HostProxyProfile => ({
    enabled: true,
    host: hop.host,
    port: normalizePort(hop.port),
    username: hop.username,
    authMethod: hop.authMethod,
    keyPath: hop.keyPath ?? null,
    next: hop.next ? persist(hop.next) : null
  })
  return persist(proxy)
}

/** 未启用跳板机时写入主机配置的占位值。 */
export const EMPTY_PROXY_PROFILE: HostProxyProfile = {
  enabled: false,
  host: '',
  port: 22,
  username: '',
  authMethod: 'password',
  keyPath: null
}

/**
 * 连接前是否需要先解锁保险箱取出已保存的凭据。
 *
 * 只有「引用了已保存配置」且「当前需要凭据但表单里没有」时才需要解锁，
 * 否则会打扰只想改个分组名的用户。
 */
export function shouldLoadSavedCredentials(
  form: ConnectFormState,
  options: { hasProfile: boolean; vaultConfigured: boolean; vaultUnlocked: boolean }
): boolean {
  if (!options.hasProfile || !options.vaultConfigured || options.vaultUnlocked) return false
  return (
    (form.authMethod === 'password' && !form.password) ||
    form.authMethod === 'key' ||
    (form.proxyEnabled && (form.proxyAuthMethod === 'password' || form.proxyAuthMethod === 'key'))
  )
}
