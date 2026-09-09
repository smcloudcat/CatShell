import { describe, expect, it } from 'vitest'
import { PBKDF2_ITERATIONS, decryptEntries, encryptEntries, validatePassword } from '../utils/vaultCrypto'

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

  it('requires master passwords of at least 8 characters', () => {
    expect(() => validatePassword('short')).toThrow('主密码至少需要 8 个字符')
    expect(() => validatePassword('long-enough')).not.toThrow()
  })
})