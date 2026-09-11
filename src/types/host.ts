export type AuthMethod = 'password' | 'key' | 'keyboard-interactive' | 'agent'

export interface HostProxyProfile {
  enabled: boolean
  host: string
  port: number
  username: string
  authMethod: 'password' | 'key'
  keyPath: string | null
  /** 下一级跳板（ProxyJump 链）；缺省为 null 表示单级跳板。旧数据无此字段。 */
  next?: HostProxyProfile | null
}

export interface HostProfile {
  id: string
  name: string
  icon: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  password: string | null
  keyPath: string | null
  passphrase: string | null
  group: string | null
  tags: string[]
  description: string
  keepAliveInterval: number
  autoReconnect: boolean
  proxy: HostProxyProfile
  createdAt: number
  updatedAt: number
}

export interface HostGroup {
  id: string
  name: string
  expanded: boolean
}

export const HOST_ICON_OPTIONS = [
  'server',
  'terminal',
  'key',
  'database',
  'monitor',
  'folder',
  'link',
  'home',
  'image',
  'palette'
] as const

export type HostIconName = (typeof HOST_ICON_OPTIONS)[number]

export function normalizeHostIcon(icon: string): HostIconName {
  return (HOST_ICON_OPTIONS as readonly string[]).includes(icon) ? (icon as HostIconName) : 'server'
}

/** `~/.ssh` 目录里的一条密钥（私钥与 `.pub` 成组展示；kind=other 为目录内其它文件）。 */
export interface SshKeyEntry {
  fileName: string
  kind: 'key' | 'other'
  hasPrivate: boolean
  hasPublic: boolean
  keyType: string | null
  fingerprint: string | null
  comment: string | null
  /** 私钥是否带口令（OpenSSH 格式可判断；其它格式为 false）。 */
  encrypted: boolean
  size: number
  modifiedMs: number
  privatePath: string | null
  publicPath: string | null
}

/** 生成密钥对的返回信息。 */
export interface GeneratedKeypair {
  privateKeyPath: string
  publicKeyPath: string
  /** OpenSSH 单行公钥（含类型、base64 与备注），可直接贴到服务端 authorized_keys。 */
  publicKey: string
  keyType: string
  fingerprint: string
}

/** 主机档案写回 `~/.ssh/config` 的草稿（不含任何凭据，私钥只写路径）。 */
export interface HostConfigDraft {
  name: string
  hostname: string
  port: number
  user: string
  identityFile: string | null
}

export const createHostProfile = (partial: Partial<HostProfile>): HostProfile => ({
  id: crypto.randomUUID(),
  name: '',
  icon: 'server',
  host: '',
  port: 22,
  username: '',
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
    keyPath: null
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...partial
})
