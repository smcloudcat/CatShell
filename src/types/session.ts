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

/** 事件 payload 的协议版本，由 Rust 侧 `EVENT_SCHEMA_VERSION` 写入（P2-13）。 */
export interface VersionedEvent {
  v: number
}

export interface SessionStatusEvent extends VersionedEvent {
  id: number
  status: SessionStatus
  reason?: string | null
  attempt: number
}

export interface SessionOutputEvent extends VersionedEvent {
  id: number
  data: string
}

export interface HostKeyPrompt extends VersionedEvent {
  token: string
  host: string
  port: number
  fingerprint: string
}

export interface HostKeyWarning extends VersionedEvent {
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

/** 批量命令执行的单台结果（Rust `ssh_manager::BatchExecItem`）。 */
export interface BatchExecItem {
  sessionId: number
  name: string
  ok: boolean
  output: string
  error: string | null
  durationMs: number
  truncated: boolean
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
  permissions: number | null
  owner: string | null
  group: string | null
}

export interface SftpChunk {
  data: string
  done: boolean
  transferred: number
  total: number
}

export interface SftpDiskTransferStart {
  transferId: number
  total: number
  resumed: boolean
}

export interface SftpDiskUploadPick {
  token: number
  fileName: string
  remotePath: string
}

export interface SftpDiskProgress extends VersionedEvent {
  transferId: number
  sessionId: number
  direction: 'upload' | 'download'
  fileName: string
  transferred: number
  total: number
  done: boolean
  cancelled: boolean
  error?: string | null
  /** 当前限速（KB/s，0 表示不限速）。 */
  speedLimitKBs: number
}

export interface SftpDiskTransferInfo {
  transferId: number
  sessionId: number
  direction: 'upload' | 'download'
  fileName: string
  remotePath: string
  localPath: string
  transferred: number
  total: number
  done: boolean
  cancelled: boolean
  error?: string | null
  /** 当前限速（KB/s，0 表示不限速）。 */
  speedLimitKBs: number
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

export type AuthMethod = 'password' | 'key' | 'keyboard-interactive' | 'agent'

export interface ProxyConfig {
  host: string
  port: number
  username: string
  authMethod: 'password' | 'key'
  password?: string | null
  keyPath?: string | null
  passphrase?: string | null
  /** 下一级跳板（ProxyJump 链），缺省为 null 表示单级。 */
  next?: ProxyConfig | null
}

export interface KbiPromptQuestion {
  prompt: string
  echo: boolean
}

export interface KbiPromptEvent extends VersionedEvent {
  sessionId: number
  name: string
  instructions: string
  prompts: KbiPromptQuestion[]
}

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
  proxy?: ProxyConfig | null
}

export const DEFAULT_SSH_PORT = 22
export const DEFAULT_KEEPALIVE_SECONDS = 30
/** 心跳间隔的合法区间，与连接表单的 min/max 保持一致。 */
export const MIN_KEEPALIVE_SECONDS = 5
export const MAX_KEEPALIVE_SECONDS = 300

/** 连接参数归一化输入。宽进严出：接受表单字符串或已解析数值。 */
export interface ConnectRequestInput {
  /** 会话显示名；为空时回退为 `user@host`。 */
  name?: string | null
  host: string
  port: number | string | null | undefined
  username: string
  authMethod: AuthMethod
  password?: string | null
  keyPath?: string | null
  passphrase?: string | null
  otpSecret?: string | null
  keepalive?: number | string | null | undefined
  autoReconnect?: boolean
  proxy?: ProxyConfigInput | null
}

export interface ProxyConfigInput {
  host: string
  port: number | string
  username: string
  authMethod: 'password' | 'key'
  password?: string | null
  keyPath?: string | null
  passphrase?: string | null
  /** 下一级跳板（ProxyJump 链）。链头在前，逐级经隧道到达目标。 */
  next?: ProxyConfigInput | null
}

/** 跳板链最大级数：防止误操作造出无法理解的深链，也圈住每跳的开销。 */
export const MAX_PROXY_HOPS = 4

/** 归一化端口：非数字、非正整数或越界一律回退到 `fallback`（默认 22）。 */
export function normalizePort(
  value: number | string | null | undefined,
  fallback = DEFAULT_SSH_PORT
): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const port = Math.trunc(parsed)
  return port >= 1 && port <= 65535 ? port : fallback
}

/** 归一化心跳间隔（秒）：非正数或非数字回退到 30；真实取值范围由后端 clamp 到 5..300。 */
/**
 * 归一化心跳间隔：非正数或非数字回退到 `fallback`，其余截断为整数并夹到
 * [5, 300]。表单里的 min/max 只是提示，用户仍可手输越界值，因此这里必须兜住。
 */
export function normalizeKeepalive(
  value: number | string | null | undefined,
  fallback = DEFAULT_KEEPALIVE_SECONDS
): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(MAX_KEEPALIVE_SECONDS, Math.max(MIN_KEEPALIVE_SECONDS, Math.trunc(parsed)))
}

/**
 * 跳板链归一化：逐级凭据字段按 authMethod 择一保留，避免把无关凭据带进请求；
 * 超过 MAX_PROXY_HOPS 的尾部直接丢弃。
 */
export function buildProxyConfig(
  input: ProxyConfigInput | null | undefined
): ProxyConfig | null {
  if (!input) return null
  const build = (hop: ProxyConfigInput): ProxyConfig => ({
    host: hop.host.trim(),
    port: normalizePort(hop.port),
    username: hop.username.trim(),
    authMethod: hop.authMethod,
    password: hop.authMethod === 'password' && hop.password ? hop.password : null,
    keyPath: hop.authMethod === 'key' ? (hop.keyPath ?? '').trim() || null : null,
    passphrase: hop.authMethod === 'key' && hop.passphrase ? hop.passphrase : null,
    next: null
  })
  const head = build(input)
  let tail: ProxyConfig = head
  let cursor = input.next ?? null
  while (cursor) {
    const node = build(cursor)
    tail.next = node
    tail = node
    cursor = cursor.next ?? null
  }
  return head
}

/** 数一数链式跳板配置的总级数。 */
export function countProxyHops(proxy: ProxyConfigInput | null | undefined): number {
  let count = 0
  let cursor = proxy ?? null
  while (cursor) {
    count += 1
    cursor = cursor.next ?? null
  }
  return count
}

/** 把链式跳板收集为数组（链头在前），供凭据存取等调用方直接按下标遍历。 */
export function collectProxyHops<T extends { next?: T | null }>(head: T | null | undefined): T[] {
  const hops: T[] = []
  let cursor: T | null | undefined = head
  while (cursor) {
    hops.push(cursor)
    cursor = cursor.next
  }
  return hops
}

/**
 * 唯一的 `ConnectRequest` 构建入口。
 *
 * 连接对话框与主机列表快速连接必须共用本函数：此前两处各自手工拼装请求，
 * 新增认证字段时极易只改一处，出现「编辑连接能连、主机列表一键连却失败」的隐性 bug。
 * 认证方式决定携带哪些凭据的规则集中在此，请勿在调用方重复实现。
 */
export function buildConnectRequest(input: ConnectRequestInput): ConnectRequest {
  const host = input.host.trim()
  const username = input.username.trim()
  const isPasswordLike =
    input.authMethod === 'password' || input.authMethod === 'keyboard-interactive'
  return {
    name: (input.name ?? '').trim() || `${username}@${host}`,
    host,
    port: normalizePort(input.port),
    username,
    authMethod: input.authMethod,
    password: isPasswordLike && input.password ? input.password : null,
    keyPath: input.authMethod === 'key' ? (input.keyPath ?? '').trim() || null : null,
    passphrase: input.authMethod === 'key' && input.passphrase ? input.passphrase : null,
    otpSecret:
      input.authMethod === 'keyboard-interactive'
        ? (input.otpSecret ?? '').trim() || null
        : null,
    keepalive: normalizeKeepalive(input.keepalive),
    autoReconnect: input.autoReconnect ?? false,
    proxy: buildProxyConfig(input.proxy)
  }
}
