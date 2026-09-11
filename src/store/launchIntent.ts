import { create } from 'zustand'
import { cliLaunchRequest, subscribeCliConnect } from '../api/ssh'
import { logger } from '../utils/logger'
import { normalizeIntent, type LaunchIntent } from '../utils/launchIntent'

interface LaunchIntentState {
  ready: boolean
  /** 待路由的连接意图（首启动参数或 second-instance 转发）。 */
  pending: LaunchIntent | null
  /** 托盘快捷连接之外的临时目标预填（供主机页连接对话框消费）。 */
  adhocPrefill: Extract<LaunchIntent, { kind: 'adhoc' }> | null
  init: () => void
  setPending: (intent: LaunchIntent) => void
  /** 取走 pending（一次性消费）。 */
  take: () => LaunchIntent | null
  setAdhocPrefill: (intent: Extract<LaunchIntent, { kind: 'adhoc' }> | null) => void
}

export const useLaunchIntent = create<LaunchIntentState>((set, get) => ({
  ready: false,
  pending: null,
  adhocPrefill: null,
  init: () => {
    if (get().ready) return
    set({ ready: true })
    // 首启动参数：Rust 在进程启动时解析一次，前端就绪后取用。
    void cliLaunchRequest()
      .then((payload: unknown) => {
        const intent = normalizeIntent(payload)
        if (intent) set({ pending: intent })
      })
      .catch((err: unknown) => logger.warn('读取启动参数失败', { err }))
    // 之后每次第二实例带参启动都会转发事件。
    void subscribeCliConnect((payload: unknown) => {
      const intent = normalizeIntent(payload)
      if (intent) set({ pending: intent })
    }).catch((err: unknown) => logger.warn('订阅启动意图事件失败', { err }))
  },
  setPending: (intent) => set({ pending: intent }),
  take: () => {
    const intent = get().pending
    if (intent) set({ pending: null })
    return intent
  },
  setAdhocPrefill: (intent) => set({ adhocPrefill: intent })
}))
