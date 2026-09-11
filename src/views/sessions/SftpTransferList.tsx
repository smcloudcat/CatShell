import { useEffect } from 'react'
import { Icon } from '../../components/Icon'
import {
  sftpDiskTransferCancel,
  sftpDiskTransferList,
  sftpDiskTransferSetLimit,
  subscribeSftpDiskProgress
} from '../../api/ssh'
import { formatBytes } from '../../utils/format'
import { recordAudit } from '../../store/audit'
import { showToast } from '../../store/ui'
import { beginTransfer, cancelFlags, removeTransfer, updateTransfer, useSftpTransferStore, type TransferProgress } from './sftpTransferStore'
import { onDiskProgress, onDiskTransferFinished } from '../../store/transferQueue'
import { useT } from '../../i18n'

/** 限速档位（KB/s，0 = 不限）。 */
const SPEED_LIMIT_OPTIONS = [0, 256, 1024, 4 * 1024, 16 * 1024, 64 * 1024]

function speedLimitLabel(kbs: number, t: (key: string) => string): string {
  if (kbs === 0) return t('不限速')
  if (kbs >= 1024) return `${Math.round((kbs / 1024) * 10) / 10} MB/s`
  return `${kbs} KB/s`
}

function TransferRow({ transfer, sessionId }: { transfer: TransferProgress; sessionId: number }) {
  const t = useT()
  const percent = transfer.total > 0 ? Math.min(100, Math.round((transfer.transferred / transfer.total) * 100)) : 0
  const requestCancel = () => {
    if (transfer.disk) {
      // 取消失败必须提示（审计 R-7）：否则传输行一直挂着，用户误以为已取消。
      void sftpDiskTransferCancel(transfer.id).catch((err: unknown) => {
        showToast(typeof err === 'string' && err ? err : t('取消传输失败'), 'error')
        recordAudit('sftp.transfer-cancel', transfer.name, 'failure', t('取消磁盘级传输失败'))
      })
      return
    }
    cancelFlags.add(transfer.id)
  }
  const changeLimit = (kbs: number) => {
    updateTransfer(sessionId, transfer.id, transfer.transferred, { speedLimitKBs: kbs })
    if (transfer.disk) {
      void sftpDiskTransferSetLimit(transfer.id, kbs).catch((err: unknown) => {
        showToast(typeof err === 'string' && err ? err : t('设置限速失败'), 'error')
        recordAudit('sftp.transfer-limit', transfer.name, 'failure', t('设置传输限速失败'))
      })
    }
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
      {transfer.disk && (
        <select
          className="glass-input sftp-transfer-limit"
          value={transfer.speedLimitKBs ?? 0}
          title={t('带宽限速')}
          onChange={(e) => changeLimit(Number(e.target.value))}
        >
          {SPEED_LIMIT_OPTIONS.map((kbs) => (
            <option key={kbs} value={kbs}>{speedLimitLabel(kbs, t)}</option>
          ))}
        </select>
      )}
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
        // 终态同步到持久化队列：完成/取消移出，失败保留待续传（断点仍在）。
        onDiskTransferFinished(
          progress.transferId,
          progress.cancelled ? 'cancelled' : progress.error ? 'failed' : 'done'
        )
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
        disk: true,
        speedLimitKBs: progress.speedLimitKBs
      })
      // 断点进度写入持久化队列（内部按 3 秒节流落盘）
      onDiskProgress(progress.transferId, progress.transferred)
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
            disk: true,
            speedLimitKBs: info.speedLimitKBs
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
        <TransferRow key={transfer.id} transfer={transfer} sessionId={sessionId} />
      ))}
    </div>
  )
}
