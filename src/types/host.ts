export type AuthMethod = 'password' | 'key' | 'keyboard-interactive'

export interface SSHKeyRef {
  id: string
  name: string
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
  createdAt: number
  updatedAt: number
}

export interface HostGroup {
  id: string
  name: string
  expanded: boolean
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
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...partial
})
