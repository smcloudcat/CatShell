import {
  base64ToBytes,
  sftpDownloadBegin,
  sftpDownloadChunk,
  sftpTransferCancel,
  sftpUploadBegin,
  sftpUploadChunk,
  sftpUploadFinish
} from '../../api/ssh'
import { SftpEntry } from '../../types/session'
import { beginTransfer, cancelFlags, removeTransfer, updateTransfer } from './sftpTransferStore'
import { CANCELLED_MESSAGE, SFTP_CHUNK_SIZE } from './sftpUtils'

/**
 * 分块传输的执行层。原先这两段循环内联在 `SessionSftpPanel` 里，
 * 既要处理进度上报、取消标记，又要处理失败清理，把组件撑得很大。
 *
 * 约定：取消通过 `cancelFlags` 传递，抛出 `CANCELLED_MESSAGE` 哨兵错误，
 * 由调用方决定是「跳过」还是「报错」。无论成功失败都会清理传输记录。
 */

/** Rust 侧的 `sftp_transfer_cancel` 对已结束的传输返回 Ok，重复调用是安全的。 */
async function discardTransfer(transferId: number): Promise<void> {
  try {
    await sftpTransferCancel(transferId)
  } catch {
    /* 传输已结束或连接已断开，取消失败不需要打扰用户 */
  }
}

/** 分块上传单个文件，进度写入 transfer store，供 SftpTransferList 展示。 */
export async function uploadChunkedFile(sessionId: number, target: string, file: File): Promise<void> {
  const { transferId } = await sftpUploadBegin(sessionId, target, file.size)
  beginTransfer(sessionId, {
    id: transferId,
    name: file.name,
    kind: 'upload',
    transferred: 0,
    total: file.size
  })
  try {
    let offset = 0
    while (offset < file.size) {
      if (cancelFlags.has(transferId)) throw new Error(CANCELLED_MESSAGE)
      const slice = await file.slice(offset, Math.min(offset + SFTP_CHUNK_SIZE, file.size)).arrayBuffer()
      await sftpUploadChunk(transferId, offset, new Uint8Array(slice))
      offset += slice.byteLength
      updateTransfer(sessionId, transferId, offset)
    }
    await sftpUploadFinish(transferId)
  } finally {
    removeTransfer(sessionId, transferId)
    await discardTransfer(transferId)
  }
}

/**
 * 分块下载单个文件，返回组装好的 Blob；由调用方触发落盘。
 * 只用于浏览器（非 Tauri）回退路径，Tauri 下大文件走磁盘级流式传输。
 */
export async function downloadChunkedFile(sessionId: number, entry: SftpEntry): Promise<Blob> {
  const { transferId, total } = await sftpDownloadBegin(sessionId, entry.path)
  beginTransfer(sessionId, {
    id: transferId,
    name: entry.name,
    kind: 'download',
    transferred: 0,
    total
  })
  const parts: BlobPart[] = []
  let received = 0
  try {
    for (;;) {
      if (cancelFlags.has(transferId)) throw new Error(CANCELLED_MESSAGE)
      const chunk = await sftpDownloadChunk(transferId)
      if (chunk.done) break
      const bytes = base64ToBytes(chunk.data)
      // 复制一份独立 Buffer：base64ToBytes 的视图可能在下一轮被复用。
      const copy = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(copy).set(bytes)
      parts.push(copy)
      received += bytes.length
      updateTransfer(sessionId, transferId, received)
    }
    return new Blob(parts)
  } finally {
    removeTransfer(sessionId, transferId)
    await discardTransfer(transferId)
  }
}

/** 判断一个错误是否是用户主动取消产生的哨兵错误。 */
export function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.message === CANCELLED_MESSAGE
}
