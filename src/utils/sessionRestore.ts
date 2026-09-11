import { ConnectRequest, buildConnectRequest } from '../types/session'
import type { HostProfile } from '../types/host'

/** 一条可恢复的会话标签：只记主机配置 id 与展示名，绝不落凭据。 */
export interface RestorableTab {
  hostId: string
  name: string
}

export type RestoreSkipReason = 'host-missing' | 'credential-missing'

export interface RestorePlanItem {
  tab: RestorableTab
  request: ConnectRequest
}

export interface RestoreSkip {
  tab: RestorableTab
  reason: RestoreSkipReason
}

export interface RestorePlan {
  plans: RestorePlanItem[]
  skips: RestoreSkip[]
}

/** 保险箱凭据与测试桩的共同形状；属性允许 undefined 以兼容 VaultCredential（exactOptionalPropertyTypes）。 */
export interface ProfileCredential {
  password?: string | null | undefined
  passphrase?: string | null | undefined
}

/**
 * 从主机配置 + 保险箱凭据构建连接请求。
 * 连接对话框、主机列表快速连接与会话恢复三条路径共用 buildConnectRequest，
 * 避免各自拼装导致字段漂移。
 */
export function buildRequestFromProfile(
  host: HostProfile,
  credential: ProfileCredential | null,
  proxyCredential: ProfileCredential | null = null
): ConnectRequest {
  return buildConnectRequest({
    name: host.name,
    host: host.host,
    port: host.port,
    username: host.username,
    authMethod: host.authMethod,
    password: credential?.password ?? null,
    keyPath: host.keyPath ?? null,
    passphrase: credential?.passphrase ?? null,
    otpSecret: null,
    keepalive: host.keepAliveInterval,
    autoReconnect: host.autoReconnect,
    proxy: host.proxy.enabled
      ? {
          host: host.proxy.host,
          port: host.proxy.port,
          username: host.proxy.username,
          authMethod: host.proxy.authMethod,
          password: proxyCredential?.password ?? null,
          keyPath: host.proxy.keyPath ?? null,
          passphrase: proxyCredential?.passphrase ?? null
        }
      : null
  })
}

/** 与主机列表快速连接一致的「凭据是否足够直连」判定。 */
export function profileHasAuth(host: HostProfile, credential: ProfileCredential | null): boolean {
  if (host.authMethod === 'key') return Boolean(host.keyPath)
  if (host.authMethod === 'agent') return true
  return Boolean(credential?.password)
}

/**
 * 制定会话恢复计划（纯函数）。
 *
 * 只恢复能完整构建连接请求的标签；缺主机配置或缺凭据的会话跳过并说明原因。
 * 刻意不在恢复路径里弹密码框——静默恢复应当零交互，需要凭据的会话
 * 由用户从主机页显式连接，入口提示「有几个会话需要手动连接」即可。
 */
export function planSessionRestore(
  tabs: RestorableTab[],
  hosts: HostProfile[],
  credentials: Record<string, ProfileCredential | null | undefined>
): RestorePlan {
  const byId = new Map(hosts.map((host) => [host.id, host]))
  const plans: RestorePlanItem[] = []
  const skips: RestoreSkip[] = []
  for (const tab of tabs) {
    const host = byId.get(tab.hostId)
    if (!host) {
      skips.push({ tab, reason: 'host-missing' })
      continue
    }
    const credential = credentials[tab.hostId] ?? null
    if (!profileHasAuth(host, credential)) {
      skips.push({ tab, reason: 'credential-missing' })
      continue
    }
    const proxyCredential = host.proxy.enabled
      ? credentials[`proxy:${tab.hostId}`] ?? null
      : null
    plans.push({ tab, request: buildRequestFromProfile(host, credential, proxyCredential) })
  }
  return { plans, skips }
}
