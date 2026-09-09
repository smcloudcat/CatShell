import { create } from 'zustand'

export interface TransferProgress {
  id: number
  name: string
  kind: 'upload' | 'download'
  transferred: number
  total: number
  disk?: boolean
}

interface TransferStoreState {
  bySession: Record<number, TransferProgress[]>
}

export const useSftpTransferStore = create<TransferStoreState>(() => ({ bySession: {} }))

function setSessionTransfers(sessionId: number, updater: (list: TransferProgress[]) => TransferProgress[]) {
  useSftpTransferStore.setState((state) => ({
    bySession: { ...state.bySession, [sessionId]: updater(state.bySession[sessionId] ?? []) }
  }))
}

/** 登记或覆盖一条传输进度行。 */
export function beginTransfer(sessionId: number, progress: TransferProgress) {
  setSessionTransfers(sessionId, (list) => [...list.filter((item) => item.id !== progress.id), progress])
}

export function updateTransfer(sessionId: number, id: number, transferred: number) {
  setSessionTransfers(sessionId, (list) =>
    list.map((item) => (item.id === id ? { ...item, transferred } : item))
  )
}

export function removeTransfer(sessionId: number, id: number) {
  cancelFlags.delete(id)
  setSessionTransfers(sessionId, (list) => list.filter((item) => item.id !== id))
}

/** 分块传输的取消标记（取消按钮置位，传输循环检查）。 */
export const cancelFlags = new Set<number>()