import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { AuditAction, AuditEntry } from '../types/audit'

const STORE_FILE = 'audit-log.json'
const AUDIT_KEY = 'entries'
const MAX_ENTRIES = 5000

interface AuditState {
  ready: boolean
  entries: AuditEntry[]
  init: () => Promise<void>
  record: (action: AuditAction, target: string, result: AuditEntry['result'], detail: string) => Promise<void>
  clear: () => Promise<void>
}

let initPromise: Promise<void> | null = null
let persistTimer: number | null = null
const PERSIST_DEBOUNCE_MS = 1000

async function persist(entries: AuditEntry[]) {
  try {
    const store = await load(STORE_FILE)
    await store.set(AUDIT_KEY, entries)
    await store.save()
  } catch {
    try {
      localStorage.setItem(AUDIT_KEY, JSON.stringify(entries))
    } catch {
      // Audit logging must never block the primary operation.
    }
  }
}

function schedulePersist() {
  if (persistTimer !== null) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    persistTimer = null
    void persist(useAudit.getState().entries)
  }, PERSIST_DEBOUNCE_MS)
}

function cancelPersist() {
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer)
    persistTimer = null
  }
}

export const useAudit = create<AuditState>((set, get) => ({
  ready: false,
  entries: [],
  init: async () => {
    if (get().ready) return
    if (initPromise) return initPromise
    initPromise = (async () => {
      let stored: unknown = null
      try {
        const store = await load(STORE_FILE)
        stored = await store.get<unknown>(AUDIT_KEY)
      } catch {
        const raw = localStorage.getItem(AUDIT_KEY)
        if (raw) {
          try {
            stored = JSON.parse(raw)
          } catch {
            stored = null
          }
        }
      }
      const entries = Array.isArray(stored)
        ? stored.filter((entry): entry is AuditEntry => Boolean(entry && typeof entry === 'object')).slice(-MAX_ENTRIES)
        : []
      set({ ready: true, entries })
    })()
    try {
      await initPromise
    } finally {
      initPromise = null
    }
  },
  record: async (action, target, result, detail) => {
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      action,
      target: target.slice(0, 240),
      result,
      detail: detail.slice(0, 1000)
    }
    set((state) => ({ entries: [...state.entries, entry].slice(-MAX_ENTRIES) }))
    schedulePersist()
  },
  clear: async () => {
    cancelPersist()
    set({ entries: [] })
    await persist([])
  }
}))

export function recordAudit(action: AuditAction, target: string, result: AuditEntry['result'], detail: string) {
  void useAudit.getState().record(action, target, result, detail)
}
