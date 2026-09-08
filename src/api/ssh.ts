import { invoke } from '@tauri-apps/api/core'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { ConnectRequest, HostKeyPrompt, HostKeyWarning, NetworkDiagnostic, PortForwardInfo, ProcessInfo, ServerMetrics, SessionInfo, SessionOutputEvent, SessionStatusEvent, SftpEntry } from '../types/session'

export async function sshConnect(request: ConnectRequest): Promise<number> {
  return invoke<number>('ssh_connect', { request })
}

export async function sshWrite(id: number, data: Uint8Array): Promise<void> {
  await invoke('ssh_write', { id, data: Array.from(data) })
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

export async function sshKillProcess(id: number, pid: number): Promise<void> {
  await invoke('ssh_kill_process', { id, pid })
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
  const data = await invoke<number[]>('sftp_read_file', { id, path })
  return new Uint8Array(data)
}

export async function sftpWriteFile(id: number, path: string, data: Uint8Array): Promise<void> {
  await invoke('sftp_write_file', { id, path, data: Array.from(data) })
}

export async function sftpRemoveFile(id: number, path: string): Promise<void> {
  await invoke('sftp_remove_file', { id, path })
}

export async function sshConfirmHostKey(token: string, accepted: boolean): Promise<void> {
  await invoke('ssh_confirm_host_key', { token, accepted })
}

export interface SshEventHandlers {
  onStatus: (event: SessionStatusEvent) => void
  onOutput: (event: SessionOutputEvent) => void
  onHostKeyPrompt?: (event: HostKeyPrompt) => void
  onHostKeyWarning?: (event: HostKeyWarning) => void
}

export async function subscribeSshEvents(handlers: SshEventHandlers): Promise<() => Promise<void>> {
  const unlisteners: UnlistenFn[] = []
  unlisteners.push(await listen<SessionStatusEvent>('session-status', (e) => handlers.onStatus(e.payload)))
  unlisteners.push(await listen<SessionOutputEvent>('session-output', (e) => handlers.onOutput(e.payload)))
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
