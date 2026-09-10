import { AppError, ERROR_CODES } from '../types/errors'

/** 主密码最短长度，供校验与文案插值共用。 */
export const MIN_MASTER_PASSWORD_LENGTH = 8

export interface VaultCredential {
  // exactOptionalPropertyTypes 下可选属性不接受显式 undefined，而凭据组装处会主动写
  // undefined（表示「该项留空」），故显式并入类型。
  password?: string | undefined
  passphrase?: string | undefined
}

export interface VaultRecord {
  version: 1
  salt: string
  iv: string
  data: string
  iterations: number
}

export const PBKDF2_ITERATIONS = 600000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

export function validatePassword(password: string) {
  if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
    throw new AppError(ERROR_CODES.VAULT_PASSWORD_TOO_SHORT, { min: MIN_MASTER_PASSWORD_LENGTH })
  }
}

export async function deriveKey(password: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function encryptEntriesWithKey(
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

export async function encryptEntries(
  password: string,
  entries: Record<string, VaultCredential>,
  iterations: number = PBKDF2_ITERATIONS
): Promise<VaultRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(password, salt, iterations)
  const record = await encryptEntriesWithKey(key, salt, entries)
  return iterations === PBKDF2_ITERATIONS ? record : { ...record, iterations }
}

export async function decryptEntries(password: string, record: VaultRecord): Promise<Record<string, VaultCredential>> {
  const key = await deriveKey(password, base64ToBytes(record.salt), record.iterations)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(base64ToBytes(record.iv)) },
    key,
    toArrayBuffer(base64ToBytes(record.data))
  )
  const parsed: unknown = JSON.parse(new TextDecoder().decode(decrypted))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(ERROR_CODES.VAULT_DATA_INVALID)
  }
  return parsed as Record<string, VaultCredential>
}