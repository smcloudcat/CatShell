import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { recordAudit } from './audit'
import { useSettings } from './settings'
import { AppError, ERROR_CODES } from '../types/errors'
import {
  PBKDF2_ITERATIONS,
  VaultCredential,
  VaultRecord,
  base64ToBytes,
  decryptEntries,
  deriveKey,
  encryptEntries,
  encryptEntriesWithKey,
  validatePassword
} from '../utils/vaultCrypto'

const STORE_FILE = 'credential-vault.json'
const VAULT_KEY = 'vault'
const AUTO_LOCK_CHECK_INTERVAL_MS = 30_000

export type { VaultCredential } from '../utils/vaultCrypto'

interface VaultState {
  ready: boolean
  configured: boolean
  unlocked: boolean
  entries: Record<string, VaultCredential>
  init: () => Promise<void>
  setup: (password: string) => Promise<void>
  unlock: (password: string) => Promise<void>
  lock: () => void
  changeMasterPassword: (oldPassword: string, newPassword: string) => Promise<void>
  saveCredential: (id: string, credential: VaultCredential) => Promise<void>
  getCredential: (id: string) => VaultCredential | null
  removeCredential: (id: string) => Promise<void>
}

let initPromise: Promise<void> | null = null
let vaultRecord: VaultRecord | null = null
let sessionKey: CryptoKey | null = null
let autoLockTimer: number | null = null
let lastVaultActivity = 0

function onBlurLockWindow() {
  if (useSettings.getState().vaultBlurLock) {
    useVault.getState().lock()
  }
}

function touchVaultActivity() {
  lastVaultActivity = Date.now()
}

function stopAutoLockTimer() {
  if (autoLockTimer !== null) {
    window.clearInterval(autoLockTimer)
    autoLockTimer = null
  }
  window.removeEventListener('blur', onBlurLockWindow)
}

function startAutoLockTimer() {
  stopAutoLockTimer()
  lastVaultActivity = Date.now()
  window.addEventListener('blur', onBlurLockWindow)
  autoLockTimer = window.setInterval(() => {
    const minutes = useSettings.getState().vaultAutoLockMinutes
    if (!minutes) return
    if (Date.now() - lastVaultActivity >= minutes * 60_000) {
      useVault.getState().lock()
    }
  }, AUTO_LOCK_CHECK_INTERVAL_MS)
}

async function readRecord(): Promise<VaultRecord | null> {
  try {
    const store = await load(STORE_FILE)
    return (await store.get<VaultRecord>(VAULT_KEY)) ?? null
  } catch {
    const raw = localStorage.getItem(STORE_FILE)
    if (!raw) return null
    try {
      return JSON.parse(raw) as VaultRecord
    } catch {
      return null
    }
  }
}

async function writeRecord(record: VaultRecord) {
  try {
    const store = await load(STORE_FILE)
    await store.set(VAULT_KEY, record)
    await store.save()
  } catch {
    localStorage.setItem(STORE_FILE, JSON.stringify(record))
  }
}

export const useVault = create<VaultState>((set, get) => ({
  ready: false,
  configured: false,
  unlocked: false,
  entries: {},
  init: async () => {
    if (get().ready) return
    if (initPromise) return initPromise
    initPromise = (async () => {
      vaultRecord = await readRecord()
      set({ ready: true, configured: Boolean(vaultRecord) })
    })()
    try {
      await initPromise
    } finally {
      initPromise = null
    }
  },
  setup: async (password) => {
    validatePassword(password)
    const record = await encryptEntries(password, {})
    await writeRecord(record)
    vaultRecord = record
    sessionKey = await deriveKey(password, base64ToBytes(record.salt), record.iterations)
    set({ configured: true, unlocked: true, entries: {} })
    startAutoLockTimer()
    recordAudit('vault.unlock', '凭据保险箱', 'success', '创建并解锁保险箱')
  },
  unlock: async (password) => {
    validatePassword(password)
    if (!vaultRecord) throw new AppError(ERROR_CODES.VAULT_NOT_CONFIGURED)
    let entries: Record<string, VaultCredential>
    try {
      entries = await decryptEntries(password, vaultRecord)
    } catch {
      throw new AppError(ERROR_CODES.VAULT_UNLOCK_FAILED)
    }
    if (vaultRecord.iterations !== PBKDF2_ITERATIONS) {
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const key = await deriveKey(password, salt, PBKDF2_ITERATIONS)
      const upgraded = await encryptEntriesWithKey(key, salt, entries)
      await writeRecord(upgraded)
      vaultRecord = upgraded
      sessionKey = key
      recordAudit('vault.upgrade', '凭据保险箱', 'success', `密钥派生迭代数升级为 ${PBKDF2_ITERATIONS}`)
    } else {
      sessionKey = await deriveKey(password, base64ToBytes(vaultRecord.salt), vaultRecord.iterations)
    }
    set({ unlocked: true, entries })
    startAutoLockTimer()
    recordAudit('vault.unlock', '凭据保险箱', 'success', '解锁保险箱')
  },
  lock: () => {
    stopAutoLockTimer()
    sessionKey = null
    set({ unlocked: false, entries: {} })
    recordAudit('vault.lock', '凭据保险箱', 'success', '锁定保险箱并清理内存凭据')
  },
  changeMasterPassword: async (oldPassword, newPassword) => {
    validatePassword(newPassword)
    if (!vaultRecord) throw new Error('请先设置保险箱主密码')
    touchVaultActivity()
    let entries: Record<string, VaultCredential>
    try {
      entries = await decryptEntries(oldPassword, vaultRecord)
    } catch {
      throw new Error('原主密码不正确')
    }
    const record = await encryptEntries(newPassword, entries)
    await writeRecord(record)
    vaultRecord = record
    sessionKey = await deriveKey(newPassword, base64ToBytes(record.salt), record.iterations)
    set({ unlocked: true, entries })
    recordAudit('vault.change-password', '凭据保险箱', 'success', '使用新盐重新加密保险箱')
  },
  saveCredential: async (id, credential) => {
    if (!get().unlocked || !vaultRecord || !sessionKey) throw new AppError(ERROR_CODES.VAULT_LOCKED)
    touchVaultActivity()
    const entries = { ...get().entries, [id]: credential }
    const record = await encryptEntriesWithKey(sessionKey, base64ToBytes(vaultRecord.salt), entries)
    await writeRecord(record)
    vaultRecord = record
    set({ entries })
  },
  getCredential: (id) => {
    if (get().unlocked) touchVaultActivity()
    return get().entries[id] ?? null
  },
  removeCredential: async (id) => {
    if (!get().unlocked || !vaultRecord || !sessionKey) return
    touchVaultActivity()
    const entries = { ...get().entries }
    delete entries[id]
    const record = await encryptEntriesWithKey(sessionKey, base64ToBytes(vaultRecord.salt), entries)
    await writeRecord(record)
    vaultRecord = record
    set({ entries })
    recordAudit('vault.remove-credential', '凭据保险箱', 'success', '删除主机凭据')
  }
}))
