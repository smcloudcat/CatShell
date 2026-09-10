import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { HostProfile } from '../types/host'
import { AppError, ERROR_CODES } from '../types/errors'
import {
  buildImportPreview,
  ImportPreview,
  isValidHost,
  MAX_IMPORT_PROFILES,
  normalizeHost
} from '../utils/hostImport'
import { recordAudit } from './audit'
import { useVault } from './vault'

const STORE_FILE = 'hosts.json'
const HOSTS_KEY = 'hosts'

interface HostsState {
  ready: boolean
  hosts: HostProfile[]
  init: () => Promise<void>
  upsert: (profile: HostProfile) => Promise<void>
  remove: (id: string) => Promise<void>
  importProfiles: (profiles: Partial<HostProfile>[]) => Promise<void>
}

export type { ImportPreview, ImportPreviewItem } from '../utils/hostImport'

let initializationPromise: Promise<void> | null = null

async function persist(hosts: HostProfile[]) {
  try {
    const store = await load(STORE_FILE)
    await store.set(HOSTS_KEY, hosts)
    await store.save()
  } catch (err) {
    console.warn('保存主机配置失败，使用本地回退存储', err)
    localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts))
  }
}

/** 解析待导入的主机配置并标记与现有配置的冲突，导入前供预览弹窗使用 */
export function previewHostImport(
  profiles: Partial<HostProfile>[],
  maxCount: number = MAX_IMPORT_PROFILES
): ImportPreview {
  return buildImportPreview(profiles, useHosts.getState().hosts, maxCount)
}

export const useHosts = create<HostsState>((set, get) => ({
  ready: false,
  hosts: [],
  init: async () => {
    if (get().ready) return
    if (initializationPromise) return initializationPromise

    initializationPromise = (async () => {
      let saved: unknown = null
      try {
        const store = await load(STORE_FILE)
        saved = await store.get<unknown>(HOSTS_KEY)
      } catch (err) {
        console.warn('读取主机配置失败，使用本地回退存储', err)
        const raw = localStorage.getItem(HOSTS_KEY)
        if (raw) {
          try {
            saved = JSON.parse(raw)
          } catch {
            saved = null
          }
        }
      }

      const hosts = Array.isArray(saved)
        ? saved.filter((item): item is Partial<HostProfile> => Boolean(item && typeof item === 'object')).map(normalizeHost)
        : []
      set({ hosts, ready: true })
    })()

    try {
      await initializationPromise
    } finally {
      initializationPromise = null
    }
  },
  upsert: async (profile) => {
    const next = normalizeHost(profile)
    if (!isValidHost(next)) throw new Error('主机地址、用户名或端口无效')
    const existed = get().hosts.some((item) => item.id === next.id)
    const hosts = existed
      ? get().hosts.map((item) => (item.id === next.id ? next : item))
      : [next, ...get().hosts]
    set({ hosts })
    await persist(hosts)
    recordAudit(existed ? 'host.update' : 'host.create', `${next.name} (${next.host}:${next.port})`, 'success', '保存主机配置')
  },
  remove: async (id) => {
    const removed = get().hosts.find((item) => item.id === id)
    const hosts = get().hosts.filter((item) => item.id !== id)
    set({ hosts })
    await persist(hosts)
    await useVault.getState().removeCredential(id)
    recordAudit('host.delete', removed ? `${removed.name} (${removed.host}:${removed.port})` : id, 'success', '删除主机配置')
  },
  importProfiles: async (profiles) => {
    if (profiles.length > MAX_IMPORT_PROFILES) {
      throw new AppError(ERROR_CODES.HOST_IMPORT_TOO_MANY, { max: MAX_IMPORT_PROFILES })
    }
    const existing = new Map(get().hosts.map((host) => [host.id, host]))
    for (const profile of profiles) {
      const normalized = normalizeHost(profile)
      if (!isValidHost(normalized)) continue
      const duplicate = get().hosts.find(
        (host) => host.host === normalized.host && host.port === normalized.port && host.username === normalized.username
      )
      existing.set(duplicate?.id ?? normalized.id, { ...normalized, id: duplicate?.id ?? normalized.id })
    }
    const hosts = Array.from(existing.values())
    set({ hosts })
    await persist(hosts)
    recordAudit('host.import', '主机配置文件', 'success', `导入 ${profiles.length} 条配置`)
  }
}))
