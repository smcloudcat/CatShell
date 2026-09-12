import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { logger } from '../utils/logger'
import { createPersistChain } from '../utils/persistChain'
import { useHosts } from './hosts'
import {
  applyFinalize,
  applyProgress,
  applyRegister,
  pendingForHost,
  pruneMissingHosts,
  queueKey,
  sanitizeLoaded,
  type QueuedTransfer,
  type QueueOutcome
} from '../utils/transferQueue'

const STORE_FILE = 'transfer-queue.json'
const ENTRIES_KEY = 'pendingTransfers'
/** 进度落盘节流：断点进度不必逐事件写盘，3 秒批量刷一次足够。 */
const PROGRESS_FLUSH_MS = 3000

interface TransferQueueState {
  ready: boolean
  entries: QueuedTransfer[]
  init: () => Promise<void>
  register: (entry: QueuedTransfer) => void
  updateProgress: (key: string, transferred: number) => void
  finalize: (key: string, outcome: QueueOutcome) => void
  discard: (key: string) => void
  pendingForHost: (hostId: string) => QueuedTransfer[]
}

export const useTransferQueue = create<TransferQueueState>((set, get) => ({
  ready: false,
  entries: [],

  init: async () => {
    if (get().ready) return
    set({ ready: true })

    // 等主机档案初始化完成（最多 5 秒），避免启动竞态把还没加载的主机误判为已删除。
    if (!useHosts.getState().ready) {
      await new Promise<void>((resolve) => {
        const started = Date.now()
        const unsubscribe = useHosts.subscribe((state) => {
          if (state.ready || Date.now() - started > 5000) {
            unsubscribe()
            resolve()
          }
        })
      })
    }

    let saved: unknown = null
    try {
      const store = await load(STORE_FILE)
      saved = await store.get<unknown>(ENTRIES_KEY)
    } catch (err) {
      logger.warn('读取传输队列失败，使用本地回退存储', err)
      const raw = localStorage.getItem(ENTRIES_KEY)
      if (raw) {
        try {
          saved = JSON.parse(raw)
        } catch {
          saved = null
        }
      }
    }
    let entries = sanitizeLoaded(saved)
    // 主机档案已删除的队列项永远无法续传，启动时静默清理。
    // hosts 是 HostProfile[]：必须按 id 提取集合，不能用 Object.keys（那是数组下标，
    // 会把所有合法队列项误判为孤儿并连同持久化一起删掉，审计 H-1）。
    const knownHostIds = new Set(useHosts.getState().hosts.map((host) => host.id))
    const pruned = entries.length
    entries = pruneMissingHosts(entries, knownHostIds)
    if (entries.length !== pruned) {
      logger.info(`传输队列清理：移除 ${pruned - entries.length} 条主机已删除的记录`)
    }
    set({ entries })
    if (entries.length !== pruned) void persistNow(entries)
  },

  register: (entry) => {
    set((state) => ({ entries: applyRegister(state.entries, entry) }))
    void persistNow(get().entries)
  },

  updateProgress: (key, transferred) => {
    set((state) => ({ entries: applyProgress(state.entries, key, transferred) }))
    scheduleProgressFlush()
  },

  finalize: (key, outcome) => {
    set((state) => ({ entries: applyFinalize(state.entries, key, outcome) }))
    void persistNow(get().entries)
  },

  discard: (key) => {
    set((state) => ({ entries: state.entries.filter((item) => item.key !== key) }))
    void persistNow(get().entries)
  },

  pendingForHost: (hostId) => pendingForHost(get().entries, hostId)
}))

// ----------------------------------------------------------------------
// transferId ↔ 队列键的运行时绑定：进度事件只带 transferId，
// 由发起方（启动/续传）负责 bind，终态事件据此 finalize。
// ----------------------------------------------------------------------

const transferKeys = new Map<number, string>()

export function bindTransfer(transferId: number, key: string) {
  transferKeys.set(transferId, key)
}

export function unbindTransfer(transferId: number) {
  transferKeys.delete(transferId)
}

/** 进度/终态事件入口：未绑定的 transferId（如浏览器分块传输）自动忽略。 */
export function onDiskProgress(transferId: number, transferred: number) {
  const key = transferKeys.get(transferId)
  if (key) useTransferQueue.getState().updateProgress(key, transferred)
}

/** 返回该终态是否命中了队列项（命中时调用方无需再处理）。 */
export function onDiskTransferFinished(
  transferId: number,
  outcome: QueueOutcome
): boolean {
  const key = transferKeys.get(transferId)
  if (!key) return false
  useTransferQueue.getState().finalize(key, outcome)
  transferKeys.delete(transferId)
  return true
}

/** 组装队列项并登记，返回队列键。 */
export function enqueueDiskTransfer(params: {
  hostId: string
  direction: 'upload' | 'download'
  fileName: string
  remotePath: string
  localPath: string
  total: number
}): string {
  const key = queueKey(params.hostId, params.direction, params.remotePath, params.localPath)
  useTransferQueue.getState().register({
    ...params,
    key,
    transferred: 0,
    updatedAt: Date.now()
  })
  return key
}

// ----------------------------------------------------------------------
// 持久化：plugin-store 为主，localStorage 兜底（对齐 session-restore 模式）。
// ----------------------------------------------------------------------

let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleProgressFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void persistNow(useTransferQueue.getState().entries)
  }, PROGRESS_FLUSH_MS)
}

// 对 transfer-queue.json 的所有写（登记/进度 flush/终态/丢弃）共用一条
// Promise 链（审计 M-6）：保证最终落盘值必为最后一次状态。
const persistChain = createPersistChain()

async function persistNow(entries: QueuedTransfer[]) {
  return persistChain(async () => {
    try {
      const store = await load(STORE_FILE)
      await store.set(ENTRIES_KEY, entries)
      await store.save()
    } catch (err) {
      logger.warn('保存传输队列失败，使用本地回退存储', err)
      try {
        localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries))
      } catch {
        /* 存储不可用时放弃，仅影响下次续传 */
      }
    }
  })
}
