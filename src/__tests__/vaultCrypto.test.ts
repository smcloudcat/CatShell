import { describe, expect, it } from 'vitest'
import { ERROR_CODES } from '../types/errors'
import {
  MIN_MASTER_PASSWORD_LENGTH,
  PBKDF2_ITERATIONS,
  VaultCredential,
  decryptEntries,
  encryptEntries,
  validatePassword
} from '../utils/vaultCrypto'

const PASSWORD = 'correct-horse-battery'
const ENTRIES = { web1: { password: 'p@55w0rd', passphrase: 'key phrase' } }

describe('vault crypto', () => {
  it('round-trips entries with a custom iteration count', async () => {
    const record = await encryptEntries(PASSWORD, ENTRIES, 1000)
    expect(record.iterations).toBe(1000)
    expect(record.version).toBe(1)
    await expect(decryptEntries(PASSWORD, record)).resolves.toEqual(ENTRIES)
  })

  it('uses the OWASP-recommended iteration count by default', async () => {
    const record = await encryptEntries(PASSWORD, ENTRIES)
    expect(record.iterations).toBe(PBKDF2_ITERATIONS)
  })

  it('rejects a wrong master password', async () => {
    const record = await encryptEntries(PASSWORD, ENTRIES, 1000)
    await expect(decryptEntries('wrong-password', record)).rejects.toThrow()
  })

  it('rejects tampered ciphertext', async () => {
    const record = await encryptEntries(PASSWORD, ENTRIES, 1000)
    record.data = record.data.slice(0, -4) + 'AAAA='
    await expect(decryptEntries(PASSWORD, record)).rejects.toThrow()
  })

  it('rejects master passwords shorter than the minimum length', () => {
    expect(() => validatePassword('short')).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.VAULT_PASSWORD_TOO_SHORT,
        params: { min: MIN_MASTER_PASSWORD_LENGTH }
      })
    )
    expect(() => validatePassword('long-enough')).not.toThrow()
  })

  it('rejects decrypted payloads that are not a credential map', async () => {
    const record = await encryptEntries(PASSWORD, [] as unknown as Record<string, VaultCredential>, 1000)
    await expect(decryptEntries(PASSWORD, record)).rejects.toThrowError(
      expect.objectContaining({ code: ERROR_CODES.VAULT_DATA_INVALID })
    )
  })
})