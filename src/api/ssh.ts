import { invoke } from '@tauri-apps/api/core'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { ConnectRequest, HostKeyPrompt, HostKeyWarning, KnownHostsSnapshot, NetworkDiagnostic, PortForwardInfo, ProcessInfo, ServerMetrics, SessionInfo, SessionOutputEvent, SessionStatusEvent, SftpChunk, SftpEntry, SftpTransferStart, SshConfigEntry } from '../types/session'

const BASE64_CHUNK = 0x8000

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

export async function sshConnect(request: ConnectRequest): Promise<number> {
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

export async function sshMonitor(id: number): Promise<ServerMetrics> {
  return invoke<ServerMetrics>('ssh_monitor', { id })
}

export async function sshProcesses(id: number): Promise<ProcessInfo[]> {
  return invoke<ProcessInfo[]>('ssh_processes', { id })
}

export async function sshKillProcess(id: number, pid: number, signal: 'TERM' | 'KILL'): Promise<void> {
  await invoke('ssh_kill_process', { id, pid, signal })
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

export async function sftpDownloadBegin(id: number, path: string): Promise<SftpTransferStart> {
  return invoke<SftpTransferStart>('sftp_download_begin', { id, path })
}

export async function sftpDownloadChunk(transferId: number): Promise<SftpChunk> {
  return invoke<SftpChunk>('sftp_download_chunk', { transferId })
}

export async function sftpUploadBegin(id: number, path: string, total: number): Promise<SftpTransferStart> {
  return invoke<SftpTransferStart>('sftp_upload_begin', { id, path, total })
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
}

export async function subscribeSshEvents(handlers: SshEventHandlers): Promise<() => Promise<void>> {
  const unlisteners: UnlistenFn[] = []
  unlisteners.push(await listen<SessionStatusEvent>('session-status', (e) => handlers.onStatus(e.payload)))
  unlisteners.push(
    await listen<SessionOutputEvent>('session-output', (e) => {
      handlers.onOutput(e.payload.id, base64ToBytes(e.payload.data))
    })
  )
  if (handlers.onHostKeyPrompt) {
    unlisteners.push(await listen<HostKeyPrompt>('host-key-prompt', (e) => handlers.onHostKeyPrompt?.(e.payload)))
  }
  if (handlers.onHostKeyWarning) {
    unlisteners.push(await listen<HostKeyWarning>('host-key-warning', (e) => handlers.onHostKeyWarning?.(e.payload)))
  }
  return async () => {
    for (const unlisten of unlisteners) {
      try {
        await unlisten()
      } catch {
        /* already removed */
      }
    }
  }
}
