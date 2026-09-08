import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { recordAudit } from './audit'
import { useSettings } from './settings'

const STORE_FILE = 'credential-vault.json'
const VAULT_KEY = 'vault'
const PBKDF2_ITERATIONS = 600000
const AUTO_LOCK_CHECK_INTERVAL_MS = 30_000

interface VaultRecord {
  version: 1
  salt: string
  iv: string
  data: string
  iterations: number
}

export interface VaultCredential {
  password?: string
  passphrase?: string
}

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

function touchVaultActivity() {
  lastVaultActivity = Date.now()
}

function stopAutoLockTimer() {
  if (autoLockTimer !== null) {
    window.clearInterval(autoLockTimer)
    autoLockTimer = null
  }
}

function startAutoLockTimer() {
  stopAutoLockTimer()
  lastVaultActivity = Date.now()
  autoLockTimer = window.setInterval(() => {
    const minutes = useSettings.getState().vaultAutoLockMinutes
    if (!minutes) return
    if (Date.now() - lastVaultActivity >= minutes * 60_000) {
      useVault.getState().lock()
    }
  }, AUTO_LOCK_CHECK_INTERVAL_MS)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function validatePassword(password: string) {
  if (password.length < 8) throw new Error('主密码至少需要 8 个字符')
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function encryptEntriesWithKey(
  key: CryptoKey,
  salt: Uint8Array,
  entries: Record<string, VaultCredential>
): Promise<VaultRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(entries))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return {
    version: 1,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
    iterations: PBKDF2_ITERATIONS
  }
}

async function encryptEntries(password: string, entries: Record<string, VaultCredential>): Promise<VaultRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS)
  return encryptEntriesWithKey(key, salt, entries)
}

async function decryptEntries(password: string, record: VaultRecord): Promise<Record<string, VaultCredential>> {
  const key = await deriveKey(password, base64ToBytes(record.salt), record.iterations)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(base64ToBytes(record.iv)) },
    key,
    toArrayBuffer(base64ToBytes(record.data))
  )
  const parsed: unknown = JSON.parse(new TextDecoder().decode(decrypted))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('保险箱数据格式无效')
  return parsed as Record<string, VaultCredential>
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
    if (!vaultRecord) throw new Error('请先设置保险箱主密码')
    let entries: Record<string, VaultCredential>
    try {
      entries = await decryptEntries(password, vaultRecord)
    } catch {
      throw new Error('主密码错误或保险箱数据已损坏')
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
    if (!get().unlocked || !vaultRecord || !sessionKey) throw new Error('请先解锁凭据保险箱')
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
