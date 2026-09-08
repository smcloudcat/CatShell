export type SessionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'closing'
  | 'closed'

export interface SessionInfo {
  id: number
  name: string
  host: string
  port: number
  username: string
  status: SessionStatus
  reason?: string | null
  attempt?: number | null
}

export interface SessionStatusEvent {
  id: number
  status: SessionStatus
  reason?: string | null
  attempt: number
}

export interface SessionOutputEvent {
  id: number
  data: string
}

export interface HostKeyPrompt {
  token: string
  host: string
  port: number
  fingerprint: string
}

export interface HostKeyWarning {
  host: string
  port: number
  fingerprint: string
  reason: string
}

export interface PartitionMetric {
  mountPoint: string
  totalKb: number
  usedKb: number
  availableKb: number
}

export interface ServerMetrics {
  sessionId: number
  hostname: string
  os: string
  cpuCores: number
  load1m: number
  cpuPercent?: number | null
  partitions?: PartitionMetric[]
  memoryTotalKb: number
  memoryAvailableKb: number
  diskTotalKb: number
  diskUsedKb: number
  diskAvailableKb: number
  networkRxBytes: number
  networkTxBytes: number
  collectedAt: number
}

export interface ProcessInfo {
  pid: number
  name: string
  cpuPercent: number
  memoryPercent: number
}

export interface NetworkDiagnostic {
  sessionId: number
  kind: 'ping' | 'trace'
  target: string
  output: string
  collectedAt: number
}

export interface PortForwardInfo {
  id: number
  sessionId: number
  direction: 'local' | 'remote' | 'dynamic'
  bindHost: string
  bindPort: number
  targetHost: string
  targetPort: number
}

export interface SftpEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink'
  size: number
  modifiedAt: number | null
}

export interface SftpTransferStart {
  transferId: number
  total: number
}

export interface SftpChunk {
  data: string
  done: boolean
  transferred: number
  total: number
}

export interface KnownHostEntry {
  pattern: string
  keyType: string
  fingerprint: string
}

export interface KnownHostsSnapshot {
  path: string
  entries: KnownHostEntry[]
}

export interface SshConfigEntry {
  host: string
  hostname: string | null
  port: number | null
  user: string | null
  identityFile: string | null
}

export type { AuthMethod } from './host'
import type { AuthMethod } from './host'

export interface ConnectRequest {
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  password?: string | null
  keyPath?: string | null
  passphrase?: string | null
  otpSecret?: string | null
  keepalive: number
  autoReconnect: boolean
}

export const STATUS_TEXT: Record<SessionStatus, string> = {
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  disconnected: '已断开',
  closing: '正在关闭',
  closed: '已关闭'
}
