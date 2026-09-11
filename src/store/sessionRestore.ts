import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { logger } from '../utils/logger'
import { planSessionRestore, ProfileCredential, RestorableTab } from '../utils/sessionRestore'
import { recordAudit } from './audit'
import { useHosts } from './hosts'
import { useSessions } from './sessions'
import { useVault } from './vault'
import { requestVaultUnlock } from './ui'

const STORE_FILE = 'session-restore.json'
const TABS_KEY = 'lastTabs'

interface SessionRestoreState {
  ready: boolean
  /** 上次退出时的会话标签（hostId + 名称），供「恢复上次会话」使用 */
  lastTabs: RestorableTab[]
  restoring: boolean
  init: () => Promise<void>
  /** 一键恢复上次会话；返回实际恢复与各类跳过的数量 */
  restoreLastTabs: () => Promise<{
    restored: number
    skipped: number
    missingHost: number
    missingCredential: number
  }>
  clear: () => Promise<void>
}

export const useSessionRestore = create<SessionRestoreState>((set, get) => ({
  ready: false,
  lastTabs: [],
  restoring: false,
  init: async () => {
    if (get().ready) return
    set({ ready: true })

    let saved: unknown = null
    try {
      const store = await load(STORE_FILE)
      saved = await store.get<unknown>(TABS_KEY)
    } catch (err) {
      logger.warn('读取会话恢复记录失败，使用本地回退存储', err)
      const raw = localStorage.getItem(TABS_KEY)
      if (raw) {
        try {
          saved = JSON.parse(raw)
        } catch {
          saved = null
        }
      }
    }
    if (Array.isArray(saved)) {
      const tabs = saved
        .filter(
          (item): item is RestorableTab =>
            Boolean(item && typeof item === 'object') &&
            typeof (item as RestorableTab).hostId === 'string' &&
            Boolean((item as RestorableTab).hostId)
        )
        .map((item) => ({ hostId: item.hostId, name: String(item.name ?? '') }))
      set({ lastTabs: tabs })
    }

    // 跟踪会话标签变化并持久化轮廓（hostId + 名称，无凭据）。
    // 这里用 subscribe 而不是让 sessions store 反向调用，保持 store 间单向依赖。
    useSessions.subscribe((state, prev) => {
      if (
        state.order === prev.order &&
        state.sessions === prev.sessions &&
        state.hostIds === prev.hostIds
      ) {
        return
      }
      const tabs: RestorableTab[] = []
      for (const id of state.order) {
        const hostId = state.hostIds[id]
        if (!hostId) continue
        tabs.push({ hostId, name: state.sessions[id]?.name ?? '' })
      }
      set({ lastTabs: tabs })
      void persistTabs(tabs)
    })
  },
  restoreLastTabs: async () => {
    const tabs = get().lastTabs
    const empty = { restored: 0, skipped: 0, missingHost: 0, missingCredential: 0 }
    if (!tabs.length || get().restoring) return empty
    set({ restoring: true })
    try {
      // 保险箱锁着时先请求解锁；用户拒绝则只恢复免密（agent / 已存 keyPath）会话
      const vault = useVault.getState()
      if (vault.configured && !vault.unlocked) {
        await requestVaultUnlock()
      }
      const hosts = useHosts.getState().hosts
      const credentials: Record<string, ProfileCredential | null> = {}
      if (useVault.getState().unlocked) {
        const getCredential = useVault.getState().getCredential
        for (const tab of tabs) {
          credentials[tab.hostId] = getCredential(tab.hostId)
          credentials[`proxy:${tab.hostId}`] = getCredential(`proxy:${tab.hostId}`)
        }
      }
      const { plans, skips } = planSessionRestore(tabs, hosts, credentials)
      let restored = 0
      for (const plan of plans) {
        try {
          await useSessions.getState().open(plan.request, plan.tab.hostId)
          restored += 1
        } catch (err) {
          logger.warn('恢复会话失败', { hostId: plan.tab.hostId, err })
        }
      }
      if (plans.length) {
        recordAudit(
          'session.restore',
          '上次会话',
          restored > 0 ? 'success' : 'failure',
          `尝试恢复 ${plans.length} 个，成功 ${restored} 个，凭据缺失跳过 ${skips.filter((s) => s.reason === 'credential-missing').length} 个`
        )
      }
      return {
        restored,
        skipped: skips.length,
        missingHost: skips.filter((s) => s.reason === 'host-missing').length,
        missingCredential: skips.filter((s) => s.reason === 'credential-missing').length
      }
    } finally {
      set({ restoring: false })
    }
  },
  clear: async () => {
    set({ lastTabs: [] })
    await persistTabs([])
  }
}))

async function persistTabs(tabs: RestorableTab[]) {
  try {
    const store = await load(STORE_FILE)
    await store.set(TABS_KEY, tabs)
    await store.save()
  } catch (err) {
    logger.warn('保存会话恢复记录失败，使用本地回退存储', err)
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
    } catch {
      /* 存储不可用时放弃，仅影响下次恢复 */
    }
  }
}
