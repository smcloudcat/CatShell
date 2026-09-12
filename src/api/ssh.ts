import { invoke, Channel } from '@tauri-apps/api/core'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import type { Event } from '@tauri-apps/api/event'
import {
  ConnectRequest,
  BatchExecItem,
  HostKeyPrompt,
  HostKeyWarning,
  KbiPromptEvent,
  KnownHostsSnapshot,
  NetworkDiagnostic,
  PortForwardInfo,
  ProcessInfo,
  ServerMetrics,
  SessionInfo,
  SessionOutputEvent,
  SessionStatusEvent,
  SftpChunk,
  SftpDiskProgress,
  SftpDiskTransferInfo,
  SftpDiskTransferStart,
  SftpDiskUploadPick,
  SftpEntry,
  SftpSyncPlan,
  SftpSyncPlanEntry,
  SftpSyncProgress,
  CliConnectPayload,
  SftpSyncStartInfo,
  SshConfigEntry
} from '../types/session'
import { GeneratedKeypair, HostConfigDraft, SshKeyEntry } from '../types/host'
import { EVENT_SCHEMA_VERSION, shouldDropEvent } from '../utils/eventSchema'
import { logger } from '../utils/logger'

const BASE64_CHUNK = 0x8000

/**
 * 事件版本守卫（P2-13）。
 *
 * Rust 侧每条事件都带 `v`（schema 版本）。版本不匹配时丢弃该事件并留下诊断日志——
 * 否则字段改名后前端只会静默读到 `undefined`，界面上表现为某个值莫名变空，无从排查。
 */
function versioned<T extends { v?: number }>(name: string, handle: (payload: T) => void) {
  return (event: Event<T>): void => {
    const payload = event.payload
    if (shouldDropEvent(payload)) {
      logger.warn(`忽略协议版本不匹配的事件 ${name}`, {
        received: payload.v,
        expected: EVENT_SCHEMA_VERSION
      })
      return
    }
    handle(payload)
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** 终端输出通道：后端以原始字节推送（ArrayBuffer），免去 base64/JSON 开销 */
export type SshOutputChannel = Channel<ArrayBuffer | number[]>

export async function sshConnect(request: ConnectRequest, onOutput?: SshOutputChannel): Promise<number> {
  if (onOutput) {
    return invoke<number>('ssh_connect', { request, onOutput })
  }
  return invoke<number>('ssh_connect', { request })
}

export async function sshWrite(id: number, data: Uint8Array): Promise<void> {
  await invoke('ssh_write', { id, data: bytesToBase64(data) })
}

export async function sshResize(id: number, cols: number, rows: number): Promise<void> {
  await invoke('ssh_resize', { id, cols, rows })
}

export async function sshDisconnect(id: number): Promise<void> {
  await invoke('ssh_disconnect', { id })
}

export async function sshRemove(id: number): Promise<void> {
  await invoke('ssh_remove', { id })
}

export async function sshList(): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>('ssh_list')
}

export async function sshPing(id: number): Promise<number> {
  return invoke<number>('ssh_ping', { id })
}

export async function kbiRespond(sessionId: number, answers: string[]): Promise<void> {
  await invoke('kbi_respond', { sessionId, answers })
}

export async function traySetActiveCount(count: number): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return
  await invoke('tray_set_active_count', { count })
}

export async function sshMonitor(id: number): Promise<ServerMetrics> {
  return invoke<ServerMetrics>('ssh_monitor', { id })
}

export async function sshProcesses(id: number): Promise<ProcessInfo[]> {
  return invoke<ProcessInfo[]>('ssh_processes', { id })
}

export async function sshKillProcess(id: number, pid: number, signal: 'TERM' | 'KILL'): Promise<void> {
  await invoke('ssh_kill_process', { id, pid, signal })
}

/** 批量在多个会话上执行同一条命令并聚合输出。危险操作，调用方负责确认与审计。 */
export async function sshBatchExec(
  sessionIds: number[],
  command: string,
  timeoutSecs: number
): Promise<BatchExecItem[]> {
  return invoke<BatchExecItem[]>('ssh_batch_exec', { sessionIds, command, timeoutSecs })
}

// ------------------------------------------------------------------
// 录制库（asciicast v2 存储）
// ------------------------------------------------------------------

export interface RecordingMeta {
  name: string
  size: number
  /** Unix 秒。 */
  modifiedAt: number
}

/** 保存一条录制（asciicast v2 文本），返回文件元信息。 */
export function recordingSave(baseName: string, content: string): Promise<RecordingMeta> {
  return invoke<RecordingMeta>('recording_save', { baseName, content })
}

export function recordingList(): Promise<RecordingMeta[]> {
  return invoke<RecordingMeta[]>('recording_list')
}

export function recordingRead(name: string): Promise<string> {
  return invoke<string>('recording_read', { name })
}

export function recordingDelete(name: string): Promise<void> {
  return invoke<void>('recording_delete', { name })
}

/**
 * 只对用户明确选择的本地文件放行 asset 协议读取（自定义背景图）。
 *
 * assetProtocol 的静态 scope 保持为空，webview 因此读不到整块磁盘（审计 S-2）；
 * 授权是运行时状态，选图后与每次启动恢复背景图前都要调用一次。
 */
export function allowAssetFile(path: string): Promise<void> {
  return invoke<void>('allow_asset_file', { path })
}

export async function sshNetworkDiagnostic(id: number, kind: 'ping' | 'trace', target: string): Promise<NetworkDiagnostic> {
  return invoke<NetworkDiagnostic>('ssh_network_diagnostic', { id, kind, target })
}

export async function sshForwardStart(
  sessionId: number,
  bindHost: string,
  bindPort: number,
  targetHost: string,
  targetPort: number
): Promise<PortForwardInfo> {
  return invoke<PortForwardInfo>('ssh_forward_start', {
    id: sessionId,
    bindHost,
    bindPort,
    targetHost,
    targetPort
  })
}

export async function sshForwardList(): Promise<PortForwardInfo[]> {
  return invoke<PortForwardInfo[]>('ssh_forward_list')
}

export async function sshForwardStartRemote(
  sessionId: number,
  bindHost: string,
  bindPort: number,
  targetHost: string,
  targetPort: number
): Promise<PortForwardInfo> {
  return invoke<PortForwardInfo>('ssh_forward_start_remote', {
    id: sessionId,
    bindHost,
    bindPort,
    targetHost,
    targetPort
  })
}

export async function sshForwardStartDynamic(
  sessionId: number,
  bindHost: string,
  bindPort: number
): Promise<PortForwardInfo> {
  return invoke<PortForwardInfo>('ssh_forward_start_dynamic', {
    id: sessionId,
    bindHost,
    bindPort
  })
}

export async function sshForwardStop(forwardId: number): Promise<void> {
  await invoke('ssh_forward_stop', { forwardId })
}

export async function sftpList(id: number, path: string): Promise<SftpEntry[]> {
  return invoke<SftpEntry[]>('sftp_list', { id, path })
}

export async function sftpReadFile(id: number, path: string): Promise<Uint8Array> {
  const data = await invoke<string>('sftp_read_file', { id, path })
  return base64ToBytes(data)
}

export async function sftpWriteFile(id: number, path: string, data: Uint8Array): Promise<void> {
  await invoke('sftp_write_file', { id, path, data: bytesToBase64(data) })
}

export async function sftpRemoveFile(id: number, path: string): Promise<void> {
  await invoke('sftp_remove_file', { id, path })
}

export async function sftpRemoveDir(id: number, path: string): Promise<void> {
  await invoke('sftp_remove_dir', { id, path })
}

export async function sftpMkdir(id: number, path: string): Promise<void> {
  await invoke('sftp_mkdir', { id, path })
}

export async function sftpRename(id: number, fromPath: string, toPath: string): Promise<void> {
  await invoke('sftp_rename', { id, fromPath, toPath })
}

export async function sftpChmod(id: number, path: string, mode: number): Promise<void> {
  await invoke('sftp_chmod', { id, path, mode })
}

export interface SftpChunkStart {
  transferId: number
  total: number
}

export async function sftpDownloadBegin(id: number, path: string): Promise<SftpChunkStart> {
  return invoke<SftpChunkStart>('sftp_download_begin', { id, path })
}

export async function sftpDownloadChunk(transferId: number): Promise<SftpChunk> {
  return invoke<SftpChunk>('sftp_download_chunk', { transferId })
}

export async function sftpUploadBegin(id: number, path: string, total: number): Promise<SftpChunkStart> {
  return invoke<SftpChunkStart>('sftp_upload_begin', { id, path, total })
}

export async function sftpUploadChunk(transferId: number, offset: number, data: Uint8Array): Promise<void> {
  await invoke('sftp_upload_chunk', { transferId, offset, data: bytesToBase64(data) })
}

export async function sftpUploadFinish(transferId: number): Promise<void> {
  await invoke('sftp_upload_finish', { transferId })
}

export async function sftpTransferCancel(transferId: number): Promise<void> {
  await invoke('sftp_transfer_cancel', { transferId })
}

/**
 * 磁盘级下载：打开 Rust 侧保存对话框并启动传输，本地路径不出 Rust 边界；
 * 目标存在 `.catshell-part` 半成品时自动断点续传。用户取消对话框返回 null。
 */
export async function sftpDiskDownloadPick(
  id: number,
  remotePath: string,
  resume: boolean,
  speedLimitKBs = 0
): Promise<SftpDiskTransferStart | null> {
  return invoke<SftpDiskTransferStart | null>('sftp_disk_download_pick', {
    id,
    remotePath,
    resume,
    speedLimitKBs
  })
}

/** 磁盘级上传：打开 Rust 侧文件对话框并登记一次性上传令牌（真实本地路径不出 Rust 边界）。 */
export async function sftpDiskUploadPick(id: number, remoteDir: string): Promise<SftpDiskUploadPick[]> {
  return invoke<SftpDiskUploadPick[]>('sftp_disk_upload_pick', { id, remoteDir })
}

/** 凭一次性令牌启动磁盘级上传；远端半成品存在时自动断点续传。 */
export async function sftpDiskUploadStartToken(
  id: number,
  token: number,
  resume: boolean,
  speedLimitKBs = 0
): Promise<SftpDiskTransferStart> {
  return invoke<SftpDiskTransferStart>('sftp_disk_upload_start_token', {
    id,
    token,
    resume,
    speedLimitKBs
  })
}

/** 队列续传（下载）：以持久化队列记录的显式本地路径启动磁盘级下载（恒为断点续传）。 */
export async function sftpDiskDownloadStartPath(
  id: number,
  remotePath: string,
  localPath: string,
  speedLimitKBs = 0
): Promise<SftpDiskTransferStart> {
  return invoke<SftpDiskTransferStart>('sftp_disk_download_start_path', {
    id,
    remotePath,
    localPath,
    speedLimitKBs
  })
}

/** 队列续传（上传）：以持久化队列记录的显式本地路径启动磁盘级上传（恒为断点续传）。 */
export async function sftpDiskUploadStartPath(
  id: number,
  localPath: string,
  remotePath: string,
  speedLimitKBs = 0
): Promise<SftpDiskTransferStart> {
  return invoke<SftpDiskTransferStart>('sftp_disk_upload_start_path', {
    id,
    localPath,
    remotePath,
    speedLimitKBs
  })
}

/** 生成 Ed25519 密钥对（可选口令加密），写入私钥与 `.pub` 公钥文件。 */
export async function keypairGenerate(
  privateKeyPath: string,
  passphrase: string | null,
  comment: string,
  overwrite: boolean
): Promise<GeneratedKeypair> {
  return invoke<GeneratedKeypair>('keypair_generate', {
    privateKeyPath,
    passphrase,
    comment,
    overwrite
  })
}

/** 浏览 `~/.ssh` 目录：密钥成组展示（私钥 + `.pub`，含类型与 SHA256 指纹）。 */
export async function keypairList(): Promise<SshKeyEntry[]> {
  return invoke<SshKeyEntry[]>('keypair_list')
}

/** 删除密钥对（私钥 + `.pub`）。仅允许 `~/.ssh` 内可识别的私钥文件。 */
export async function keypairDelete(privatePath: string): Promise<number> {
  return invoke<number>('keypair_delete', { privatePath })
}

/** 读取公钥单行内容（传私钥路径自动找同名 `.pub`），用于复制到剪贴板。 */
export async function keypairPublicKey(privatePath: string): Promise<string> {
  return invoke<string>('keypair_public_key', { privatePath })
}

/** 把主机档案写回 `~/.ssh/config`，返回 (替换块数, 写入块数)。 */
export async function sshConfigWrite(
  drafts: HostConfigDraft[]
): Promise<[number, number]> {
  return invoke<[number, number]>('ssh_config_write', { drafts })
}

/** 打开目录选择对话框（目录同步的本地侧入口），取消返回 null。 */
export async function pickDirectory(): Promise<string | null> {
  return invoke<string | null>('pick_directory')
}

/** 生成目录同步计划：扫描两侧目录树，产出差异动作清单供预览确认。 */
export async function sftpSyncPlan(
  id: number,
  direction: 'upload' | 'download',
  localDir: string,
  remoteDir: string
): Promise<SftpSyncPlan> {
  return invoke<SftpSyncPlan>('sftp_sync_plan', { id, direction, localDir, remoteDir })
}

/** 启动目录同步执行（后台逐文件串行，进度经 sftp-sync-progress 事件推送）。 */
export async function sftpSyncStart(
  id: number,
  direction: 'upload' | 'download',
  localDir: string,
  remoteDir: string,
  entries: SftpSyncPlanEntry[]
): Promise<SftpSyncStartInfo> {
  return invoke<SftpSyncStartInfo>('sftp_sync_start', { id, direction, localDir, remoteDir, entries })
}

/** 取消会话进行中的目录同步任务。 */
export async function sftpSyncCancel(id: number): Promise<boolean> {
  return invoke<boolean>('sftp_sync_cancel', { id })
}

/** 订阅目录同步进度事件。返回取消订阅函数。 */
export async function subscribeSftpSyncProgress(
  handler: (progress: SftpSyncProgress) => void
): Promise<() => void> {
  const unlisten = await listen<SftpSyncProgress>(
    'sftp-sync-progress',
    versioned<SftpSyncProgress>('sftp-sync-progress', handler)
  )
  return () => {
    try {
      unlisten()
    } catch {
      // 忽略重复取消订阅
    }
  }
}

export async function sftpDiskTransferCancel(transferId: number): Promise<void> {
  await invoke('sftp_disk_transfer_cancel', { transferId })
}

/** 运行中动态调整磁盘传输的带宽限速（KB/s，0 = 不限）。 */
export async function sftpDiskTransferSetLimit(transferId: number, speedLimitKBs: number): Promise<void> {
  await invoke('sftp_disk_transfer_set_limit', { transferId, speedLimitKBs })
}

export async function sftpDiskTransferList(sessionId: number): Promise<SftpDiskTransferInfo[]> {
  return invoke<SftpDiskTransferInfo[]>('sftp_disk_transfer_list', { id: sessionId })
}

/** 磁盘级传输进度事件（Rust 侧 300ms 节流推送）。 */
export async function subscribeSftpDiskProgress(
  handler: (progress: SftpDiskProgress) => void
): Promise<() => void> {
  const unlisten = await listen<SftpDiskProgress>(
    'sftp-disk-progress',
    versioned<SftpDiskProgress>('sftp-disk-progress', handler)
  )
  // UnlistenFn 是同步签名，取消订阅无需 await
  return () => {
    try {
      unlisten()
    } catch {
      /* already removed */
    }
  }
}

export async function sshConfirmHostKey(token: string, accepted: boolean): Promise<void> {
  await invoke('ssh_confirm_host_key', { token, accepted })
}

export async function knownHostsList(): Promise<KnownHostsSnapshot> {
  return invoke<KnownHostsSnapshot>('known_hosts_list')
}

export async function knownHostsRemove(pattern: string, keyType: string): Promise<number> {
  return invoke<number>('known_hosts_remove', { pattern, keyType })
}

export async function sshConfigParse(): Promise<SshConfigEntry[]> {
  return invoke<SshConfigEntry[]>('ssh_config_parse')
}

export async function knownHostsSetMode(mode: 'openssh' | 'appdata'): Promise<void> {
  await invoke('known_hosts_set_mode', { mode })
}

export interface SshEventHandlers {
  onStatus: (event: SessionStatusEvent) => void
  onOutput: (id: number, data: Uint8Array) => void
  onHostKeyPrompt?: (event: HostKeyPrompt) => void
  onHostKeyWarning?: (event: HostKeyWarning) => void
  onKbiPrompt?: (event: KbiPromptEvent) => void
}

export async function subscribeSshEvents(handlers: SshEventHandlers): Promise<() => void> {
  const unlisteners: UnlistenFn[] = []
  unlisteners.push(
    await listen<SessionStatusEvent>(
      'session-status',
      versioned<SessionStatusEvent>('session-status', handlers.onStatus)
    )
  )
  unlisteners.push(
    await listen<SessionOutputEvent>(
      'session-output',
      versioned<SessionOutputEvent>('session-output', (payload) => {
        handlers.onOutput(payload.id, base64ToBytes(payload.data))
      })
    )
  )
  if (handlers.onHostKeyPrompt) {
    const onHostKeyPrompt = handlers.onHostKeyPrompt
    unlisteners.push(
      await listen<HostKeyPrompt>(
        'host-key-prompt',
        versioned<HostKeyPrompt>('host-key-prompt', (payload) => onHostKeyPrompt(payload))
      )
    )
  }
  if (handlers.onHostKeyWarning) {
    const onHostKeyWarning = handlers.onHostKeyWarning
    unlisteners.push(
      await listen<HostKeyWarning>(
        'host-key-warning',
        versioned<HostKeyWarning>('host-key-warning', (payload) => onHostKeyWarning(payload))
      )
    )
  }
  if (handlers.onKbiPrompt) {
    const onKbiPrompt = handlers.onKbiPrompt
    unlisteners.push(
      await listen<KbiPromptEvent>(
        'kbi-prompt',
        versioned<KbiPromptEvent>('kbi-prompt', (payload) => onKbiPrompt(payload))
      )
    )
  }
  return () => {
    for (const unlisten of unlisteners) {
      try {
        unlisten()
      } catch {
        /* already removed */
      }
    }
  }
}
/** 取首启动的命令行连接意图（`catshell user@host` / `catshell 档案名`）；无则 null。 */
export async function cliLaunchRequest(): Promise<CliConnectPayload | null> {
  return invoke<CliConnectPayload | null>('cli_launch_request')
}

/** 订阅第二实例带参启动转发的连接意图事件。返回取消订阅函数。 */
export async function subscribeCliConnect(
  handler: (payload: CliConnectPayload) => void
): Promise<() => void> {
  const unlisten = await listen<CliConnectPayload>(
    'cli-connect',
    versioned<CliConnectPayload & { v?: number }>('cli-connect', handler)
  )
  return () => {
    try {
      unlisten()
    } catch {
      /* 窗口已销毁时忽略 */
    }
  }
}

/** 订阅托盘「快捷连接」菜单点击（payload 为档案 id）。返回取消订阅函数。 */
export async function subscribeTrayQuickConnect(
  handler: (hostId: string) => void
): Promise<() => void> {
  const unlisten = await listen<{ hostId: string }>(
    'tray-quick-connect',
    versioned<{ hostId: string; v?: number }>('tray-quick-connect', (payload) => handler(payload.hostId))
  )
  return () => {
    try {
      unlisten()
    } catch {
      /* 窗口已销毁时忽略 */
    }
  }
}

/** 推送托盘「快捷连接」清单（主机档案变化时调用），Rust 据此重建托盘菜单。 */
export async function traySetQuickConnects(items: { id: string; name: string }[]): Promise<void> {
  await invoke('tray_set_quick_connects', { items })
}
