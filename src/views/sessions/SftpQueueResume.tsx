import { useMemo, useState } from 'react'
import { Icon } from '../../components/Icon'
import { sftpDiskDownloadStartPath, sftpDiskUploadStartPath } from '../../api/ssh'
import { formatBytes } from '../../utils/format'
import { pendingForHost, type QueuedTransfer } from '../../utils/transferQueue'
import { beginTransfer } from './sftpTransferStore'
import { bindTransfer, useTransferQueue } from '../../store/transferQueue'
import { recordAudit } from '../../store/audit'
import { showToast } from '../../store/ui'
import { useT } from '../../i18n'
import { errorText } from '../../i18n/errors'

interface Props {
  sessionId: number
  hostId: string
  /** 上传续传完成后刷新目录列表。 */
  onChanged?: () => void
}

/**
 * 传输队列续传条：本主机存在未完成的磁盘级传输时显示，
 * 支持逐条续传（复用 `.catshell-part` 断点）或忽略。
 */
export function SftpQueueResume({ sessionId, hostId, onChanged }: Props) {
  const t = useT()
  const entries = useTransferQueue((state) => state.entries)
  const discard = useTransferQueue((state) => state.discard)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)

  const pending = useMemo(() => (hostId ? pendingForHost(entries, hostId) : []), [entries, hostId])
  if (!hostId || !pending.length) return null

  const resumeOne = async (entry: QueuedTransfer) => {
    setBusyKey(entry.key)
    try {
      const start = entry.direction === 'download'
        ? await sftpDiskDownloadStartPath(sessionId, entry.remotePath, entry.localPath)
        : await sftpDiskUploadStartPath(sessionId, entry.localPath, entry.remotePath)
      beginTransfer(sessionId, {
        id: start.transferId,
        name: entry.fileName,
        kind: entry.direction,
        transferred: entry.transferred,
        total: start.total,
        disk: true
      })
      bindTransfer(start.transferId, entry.key)
      recordAudit('sftp.queue-resume', entry.remotePath, 'success', t('从传输队列续传'))
      if (entry.direction === 'upload') onChanged?.()
    } catch (err) {
      recordAudit('sftp.queue-resume', entry.remotePath, 'failure', t('队列续传失败'))
      showToast(errorText(err, t, t('队列续传失败')), 'error')
    } finally {
      setBusyKey(null)
    }
  }

  const resumeAll = async () => {
    setBatchBusy(true)
    try {
      for (const entry of pending) {
        await resumeOne(entry)
      }
    } finally {
      setBatchBusy(false)
    }
  }

  return (
    <div className="sftp-queue">
      <div className="sftp-queue-head">
        <Icon name="save" size={14} />
        <span>{t('上次未完成的传输')}{`（${pending.length}）`}</span>
        <button
          className="glass-btn sftp-queue-btn"
          disabled={batchBusy}
          onClick={() => void resumeAll()}
        >
          {t('全部续传')}
        </button>
      </div>
      {pending.map((entry) => {
        const percent = entry.total > 0 ? Math.min(100, Math.round((entry.transferred / entry.total) * 100)) : 0
        return (
          <div className="sftp-queue-row" key={entry.key}>
            <Icon name={entry.direction === 'upload' ? 'upload' : 'save'} size={13} />
            <span className="sftp-queue-name" title={entry.direction === 'upload' ? entry.localPath : entry.remotePath}>
              {entry.fileName}
            </span>
            <span className="sftp-queue-progress">
              {formatBytes(entry.transferred)} / {formatBytes(entry.total)} · {percent}%
            </span>
            <button
              className="glass-btn sftp-queue-btn"
              disabled={busyKey !== null || batchBusy}
              onClick={() => void resumeOne(entry)}
            >
              {t('续传')}
            </button>
            <button
              className="host-icon-btn danger"
              title={t('忽略')}
              disabled={busyKey !== null || batchBusy}
              onClick={() => discard(entry.key)}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
