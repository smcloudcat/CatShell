export type AuditAction =
  | 'session.connect'
  | 'session.status'
  | 'session.disconnect'
  | 'session.log-export'
  | 'host.create'
  | 'host.update'
  | 'host.delete'
  | 'host.import'
  | 'host.export'
  | 'sftp.list'
  | 'sftp.upload'
  | 'sftp.batch-upload'
  | 'sftp.download'
  | 'sftp.delete'
  | 'sftp.edit'
  | 'sftp.mkdir'
  | 'sftp.rename'
  | 'snippet.send'
  | 'command.bulk-send'
  | 'config.export'
  | 'config.import'
  | 'forward.start'
  | 'forward.stop'
  | 'vault.unlock'
  | 'vault.lock'
  | 'vault.upgrade'
  | 'vault.remove-credential'
  | 'vault.change-password'
  | 'knownhosts.delete'

export interface AuditEntry {
  id: string
  timestamp: number
  action: AuditAction
  target: string
  result: 'success' | 'failure' | 'info'
  detail: string
}
