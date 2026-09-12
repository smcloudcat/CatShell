import { create } from 'zustand'
import { load } from '@tauri-apps/plugin-store'
import { recordAudit } from './audit'
import { useSettings } from './settings'
import { AppError, ERROR_CODES } from '../types/errors'
import { readLocalFallback, tryWriteLocalFallback } from '../utils/localFallback'
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
/** 锁定态下删除凭据的待办列表键（审计 B-15）。只存主机 id，不含任何凭据内容。 */
const PENDING_REMOVALS_KEY = 'catshell.vault.pendingRemovals'

/** 凭据删除的结果：`removed` 已立即删除；`queued` 保险箱锁定，已排队待解锁后清理。 */
export type CredentialRemovalResult = 'removed' | 'queued'

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
  removeCredential: (id: string) => Promise<CredentialRemovalResult>
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
    return readLocalFallback<VaultRecord>(STORE_FILE)
  }
}

async function writeRecord(record: VaultRecord) {
  try {
    const store = await load(STORE_FILE)
    await store.set(VAULT_KEY, record)
    await store.save()
  } catch {
    // 主存储失败时回退 localStorage；回退也失败必须抛错（审计 M-5）：
    // 凭据保险箱绝不产生「内存已改、磁盘没落」的假成功。
    if (!tryWriteLocalFallback(STORE_FILE, record, '凭据保险箱')) {
      throw new AppError(ERROR_CODES.VAULT_WRITE_FAILED)
    }
  }
}

/**
 * 读取锁定期间排队的凭据删除（审计 B-15）。
 *
 * 保险箱锁定时内存里既没有 `entries` 也没有会话密钥，删除只能静默跳过；而调用方
 * （`hosts.remove`）此时已经把主机记录删掉，入口随之消失，凭据就永久残留在保险箱里
 * 且再也没有任何 UI 能清理它。这里把待删主机 id 明文落盘（只是 id，不含凭据内容），
 * 由下次解锁回放，保证「删主机」在凭据侧最终一致。
 */
function readPendingRemovals(): string[] {
  try {
    const raw = localStorage.getItem(PENDING_REMOVALS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** 返回是否成功落盘（审计 L-2）：失败时调用方必须感知，不能假装已排队。 */
function writePendingRemovals(ids: string[]): boolean {
  try {
    if (ids.length === 0) localStorage.removeItem(PENDING_REMOVALS_KEY)
    else localStorage.setItem(PENDING_REMOVALS_KEY, JSON.stringify(ids))
    return true
  } catch {
    return false
  }
}

function enqueuePendingRemoval(id: string): boolean {
  const pending = readPendingRemovals()
  if (pending.includes(id)) return true
  return writePendingRemovals([...pending, id])
}

function clearPendingRemoval(id: string) {
  const pending = readPendingRemovals()
  if (pending.includes(id)) writePendingRemovals(pending.filter((item) => item !== id))
}

/**
 * 解锁后回放排队中的凭据删除。落盘失败时保留待办，留待下次解锁重试，
 * 避免出现「主机已删、凭据永远留下」的窗口。
 */
async function flushPendingRemovals(
  entries: Record<string, VaultCredential>
): Promise<Record<string, VaultCredential>> {
  const pending = readPendingRemovals()
  if (pending.length === 0) return entries
  const next = { ...entries }
  let changed = false
  for (const id of pending) {
    if (id in next) {
      delete next[id]
      changed = true
    }
  }
  if (!changed || !vaultRecord || !sessionKey) {
    // 没有实际可删的条目（id 本就不存在）：待办直接作废。
    writePendingRemovals([])
    return next
  }
  try {
    const record = await encryptEntriesWithKey(sessionKey, base64ToBytes(vaultRecord.salt), next)
    await writeRecord(record)
    vaultRecord = record
    writePendingRemovals([])
    recordAudit(
      'vault.remove-credential',
      '凭据保险箱',
      'success',
      `解锁后清理 ${pending.length} 条锁定期间待删除的凭据`
    )
    return next
  } catch {
    return entries
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
    set({ unlocked: true, entries: await flushPendingRemovals(entries) })
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
    if (!vaultRecord) throw new AppError(ERROR_CODES.VAULT_NOT_CONFIGURED)
    touchVaultActivity()
    let entries: Record<string, VaultCredential>
    try {
      entries = await decryptEntries(oldPassword, vaultRecord)
    } catch {
      throw new AppError(ERROR_CODES.VAULT_OLD_PASSWORD_WRONG)
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
    // 该主机曾排队待删，现在又写入了新凭据：撤销排队，否则下次解锁会把新凭据删掉。
    clearPendingRemoval(id)
  },
  getCredential: (id) => {
    if (get().unlocked) touchVaultActivity()
    return get().entries[id] ?? null
  },
  removeCredential: async (id) => {
    if (!get().unlocked || !vaultRecord || !sessionKey) {
      // 锁定态：排队，等下次解锁回放（审计 B-15）。此处不能静默返回——
      // 主机记录已经被删掉，静默跳过等于把凭据永久锁死在保险箱里。
      // 排队落盘失败时明确报错（审计 L-2）：假装 queued 会让凭据永远留在保险箱。
      if (!enqueuePendingRemoval(id)) {
        recordAudit(
          'vault.remove-credential',
          '凭据保险箱',
          'failure',
          '保险箱锁定且本地存储不可用，凭据删除排队失败'
        )
        throw new AppError(ERROR_CODES.VAULT_WRITE_FAILED)
      }
      recordAudit(
        'vault.remove-credential',
        '凭据保险箱',
        'success',
        '保险箱锁定，凭据删除已排队，将在下次解锁时清理'
      )
      return 'queued'
    }
    touchVaultActivity()
    const entries = { ...get().entries }
    delete entries[id]
    const record = await encryptEntriesWithKey(sessionKey, base64ToBytes(vaultRecord.salt), entries)
    await writeRecord(record)
    vaultRecord = record
    set({ entries })
    clearPendingRemoval(id)
    recordAudit('vault.remove-credential', '凭据保险箱', 'success', '删除主机凭据')
    return 'removed'
  }
}))
