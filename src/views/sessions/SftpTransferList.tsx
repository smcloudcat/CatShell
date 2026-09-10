import { useEffect } from 'react'
import { Icon } from '../../components/Icon'
import {
  sftpDiskTransferCancel,
  sftpDiskTransferList,
  subscribeSftpDiskProgress
} from '../../api/ssh'
import { formatBytes } from '../../utils/format'
import { recordAudit } from '../../store/audit'
import { showToast } from '../../store/ui'
import { beginTransfer, cancelFlags, removeTransfer, useSftpTransferStore, type TransferProgress } from './sftpTransferStore'
import { useT } from '../../i18n'

function TransferRow({ transfer }: { transfer: TransferProgress }) {
  const t = useT()
  const percent = transfer.total > 0 ? Math.min(100, Math.round((transfer.transferred / transfer.total) * 100)) : 0
  const requestCancel = () => {
    if (transfer.disk) {
      void sftpDiskTransferCancel(transfer.id).catch(() => undefined)
      return
    }
    cancelFlags.add(transfer.id)
  }
  return (
    <div className="sftp-transfer">
      <Icon name={transfer.kind === 'upload' ? 'upload' : 'save'} size={14} />
      <div className="sftp-transfer-body">
        <div className="sftp-transfer-meta">
          <span className="sftp-transfer-name" title={transfer.name}>{transfer.name}</span>
          <span>{formatBytes(transfer.transferred)} / {formatBytes(transfer.total)} · {percent}%</span>
        </div>
        <div className="metric-bar"><span style={{ width: `${percent}%` }} /></div>
      </div>
      <button className="host-icon-btn danger" onClick={requestCancel} title={t('取消传输')}><Icon name="x" size={13} /></button>
    </div>
  )
}

/** SFTP 传输进度列表：独立订阅磁盘进度事件，避免进度更新重渲染整个面板。 */
const NO_TRANSFERS: TransferProgress[] = []

export function SftpTransferList({ sessionId }: { sessionId: number }) {
  const t = useT()
  // zustand v5 的 selector 必须返回稳定引用：空态复用常量，避免 getSnapshot 每次新数组导致无限重渲染。
  const transfers = useSftpTransferStore((state) => state.bySession[sessionId] ?? NO_TRANSFERS)

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let disposed = false
    let unlisten: (() => void) | null = null
    void subscribeSftpDiskProgress((progress) => {
      if (progress.sessionId !== sessionId) return
      if (progress.done) {
        const directionLabel = progress.direction === 'upload' ? t('上传') : t('下载')
        if (progress.cancelled) {
          showToast(`${t('已取消 ')}${progress.fileName}`)
        } else if (progress.error) {
          recordAudit(`sftp.disk-${progress.direction}`, progress.fileName, 'failure', progress.error)
          showToast(`${t('磁盘')}${directionLabel}${t('失败：')}${progress.error}`, 'error')
        } else {
          recordAudit(`sftp.disk-${progress.direction}`, progress.fileName, 'success', t('磁盘级传输完成'))
          showToast(`${t('磁盘')}${directionLabel}${t('完成：')}${progress.fileName}`)
        }
        window.setTimeout(() => {
          if (!disposed) removeTransfer(sessionId, progress.transferId)
        }, 1200)
        return
      }
      // 后端可能自行续传（前端未登记时补录）
      beginTransfer(sessionId, {
        id: progress.transferId,
        name: progress.fileName,
        kind: progress.direction === 'upload' ? 'upload' : 'download',
        transferred: progress.transferred,
        total: progress.total,
        disk: true
      })
    }).then((dispose) => {
      if (disposed) void dispose()
      else unlisten = dispose
    })
    // 面板重新挂载时恢复仍在进行的磁盘传输行
    void sftpDiskTransferList(sessionId)
      .then((infos) => {
        if (disposed) return
        for (const info of infos) {
          if (info.done || info.cancelled) continue
          beginTransfer(sessionId, {
            id: info.transferId,
            name: info.fileName,
            kind: info.direction === 'upload' ? 'upload' : 'download',
            transferred: info.transferred,
            total: info.total,
            disk: true
          })
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      void unlisten?.()
    }
  }, [sessionId])

  if (!transfers.length) return null
  return (
    <div className="sftp-transfers">
      {transfers.map((transfer) => (
        <TransferRow key={transfer.id} transfer={transfer} />
      ))}
    </div>
  )
}