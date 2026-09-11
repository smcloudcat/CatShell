import type { HostProfile } from '../types/host'

/** 启动意图（Rust `CliConnectPayload` 的前端规范化形态）。 */
export type LaunchIntent =
  | { kind: 'adhoc'; user: string | null; host: string; port: number | null }
  | { kind: 'profile'; name: string }

/** 宽松校验并规范化 Rust 侧送来的连接意图；形状不符返回 null。 */
export function normalizeIntent(raw: unknown): LaunchIntent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const payload = raw as Record<string, unknown>
  if (payload.kind === 'profile') {
    if (typeof payload.name !== 'string' || !payload.name.trim()) return null
    return { kind: 'profile', name: payload.name.trim() }
  }
  if (payload.kind === 'adhoc') {
    if (typeof payload.host !== 'string' || !payload.host.trim()) return null
    const user = typeof payload.user === 'string' && payload.user.trim() ? payload.user.trim() : null
    const port =
      typeof payload.port === 'number' && Number.isInteger(payload.port) && payload.port > 0
        ? payload.port
        : null
    return { kind: 'adhoc', user, host: payload.host.trim(), port }
  }
  return null
}

/** 按档案名查找主机（大小写不敏感、忽略首尾空白）；找不到返回 null。 */
export function findProfileByName(hosts: HostProfile[], name: string): HostProfile | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  return hosts.find((host) => host.name.trim().toLowerCase() === wanted) ?? null
}

/** 把临时目标（user@host:port）合成一个未保存的档案草稿，供连接对话框预填。 */
export function synthesizeAdhocProfile(intent: Extract<LaunchIntent, { kind: 'adhoc' }>): HostProfile {
  const now = Date.now()
  const name = intent.user ? `${intent.user}@${intent.host}` : intent.host
  return {
    id: `adhoc-${now}`,
    name,
    icon: 'server',
    host: intent.host,
    port: intent.port ?? 22,
    username: intent.user ?? '',
    authMethod: 'password',
    password: null,
    keyPath: null,
    passphrase: null,
    group: null,
    tags: [],
    description: '',
    keepAliveInterval: 30,
    autoReconnect: true,
    proxy: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authMethod: 'password',
      keyPath: null,
      next: null
    },
    createdAt: now,
    updatedAt: now
  }
}
