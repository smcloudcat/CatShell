import { describe, expect, it } from 'vitest'
import {
  buildImportPreview,
  isValidHost,
  normalizeGroup,
  normalizeHost,
  normalizeTags
} from '../utils/hostImport'
import { createHostProfile, HostProfile } from '../types/host'

const existingHost = (partial: Partial<HostProfile> = {}): HostProfile =>
  createHostProfile({ name: '已有主机', host: '10.0.0.9', port: 22, username: 'root', ...partial })

describe('normalizeGroup', () => {
  it('trims and returns null for blank or non-string input', () => {
    expect(normalizeGroup('  生产  ')).toBe('生产')
    expect(normalizeGroup('   ')).toBeNull()
    expect(normalizeGroup(undefined)).toBeNull()
    expect(normalizeGroup(42)).toBeNull()
  })

  it('caps group length at 48 characters', () => {
    expect(normalizeGroup('x'.repeat(80))).toHaveLength(48)
  })
})

describe('normalizeTags', () => {
  it('drops non-strings, blanks and duplicates while preserving order', () => {
    expect(normalizeTags(['web', ' web ', '', 7, null, 'db'])).toEqual(['web', 'db'])
  })

  it('returns empty for non-array input', () => {
    expect(normalizeTags('web')).toEqual([])
    expect(normalizeTags(undefined)).toEqual([])
  })

  it('caps tag count and tag length', () => {
    expect(normalizeTags(Array.from({ length: 40 }, (_, i) => `t${i}`))).toHaveLength(10)
    expect(normalizeTags(['y'.repeat(60)])[0]).toHaveLength(24)
  })
})

describe('normalizeHost trust boundary', () => {
  it('strips credentials that arrive from an imported file', () => {
    const host = normalizeHost({
      host: '10.0.0.1',
      username: 'root',
      password: 'should-not-survive',
      passphrase: 'should-not-survive'
    })
    expect(host.password).toBeNull()
    expect(host.passphrase).toBeNull()
  })

  it('falls back to sane defaults for missing or invalid numeric fields', () => {
    const host = normalizeHost({ host: 'h', username: 'u' })
    expect(host.port).toBe(22)
    expect(host.keepAliveInterval).toBe(30)
  })

  it('keeps a valid port and keepalive', () => {
    const host = normalizeHost({ host: 'h', username: 'u', port: 2222, keepAliveInterval: 45 })
    expect(host.port).toBe(2222)
    expect(host.keepAliveInterval).toBe(45)
  })

  it('falls back to the default port for non-positive or unparsable ports', () => {
    expect(normalizeHost({ host: 'h', username: 'u', port: 0 }).port).toBe(22)
    expect(normalizeHost({ host: 'h', username: 'u', port: -22 }).port).toBe(22)
  })

  it('treats only an explicit false as autoReconnect disabled', () => {
    expect(normalizeHost({ host: 'h', username: 'u' }).autoReconnect).toBe(true)
    expect(normalizeHost({ host: 'h', username: 'u', autoReconnect: false }).autoReconnect).toBe(false)
  })
})

describe('isValidHost', () => {
  it('accepts a complete profile', () => {
    expect(isValidHost(existingHost())).toBe(true)
  })

  it('rejects blank host or username', () => {
    expect(isValidHost(existingHost({ host: '   ' }))).toBe(false)
    expect(isValidHost(existingHost({ username: '' }))).toBe(false)
  })

  it('rejects out-of-range ports', () => {
    expect(isValidHost(existingHost({ port: 0 }))).toBe(false)
    expect(isValidHost(existingHost({ port: 65536 }))).toBe(false)
    expect(isValidHost(existingHost({ port: 22.5 }))).toBe(false)
  })
})

describe('buildImportPreview', () => {
  it('normalizes valid rows and counts invalid ones', () => {
    const preview = buildImportPreview(
      [
        { name: '好主机', host: '10.0.0.1', username: 'root', port: 22 },
        { name: '缺地址', host: '', username: 'root' },
        { name: '缺用户', host: '10.0.0.2', username: '  ' }
      ],
      []
    )
    expect(preview.items).toHaveLength(1)
    expect(preview.items[0]!.profile.name).toBe('好主机')
    expect(preview.invalidCount).toBe(2)
  })

  it('strips credentials from every imported row', () => {
    const preview = buildImportPreview(
      [{ name: 'x', host: 'h', username: 'u', password: 'leak', passphrase: 'leak' }],
      []
    )
    expect(preview.items[0]!.profile.password).toBeNull()
    expect(preview.items[0]!.profile.passphrase).toBeNull()
  })

  it('flags rows that collide with an existing host on host+port+username', () => {
    const existing = [existingHost({ host: '10.0.0.9', port: 22, username: 'root' })]
    const preview = buildImportPreview(
      [
        { name: '重复', host: '10.0.0.9', port: 22, username: 'root' },
        { name: '仅端口不同', host: '10.0.0.9', port: 2222, username: 'root' },
        { name: '仅用户不同', host: '10.0.0.9', port: 22, username: 'admin' }
      ],
      existing
    )
    expect(preview.items[0]!.duplicateOf).not.toBeNull()
    expect(preview.items[1]!.duplicateOf).toBeNull()
    expect(preview.items[2]!.duplicateOf).toBeNull()
  })

  it('stops after maxCount valid rows', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      name: `h${i}`,
      host: `10.0.0.${i}`,
      username: 'root',
      port: 22
    }))
    expect(buildImportPreview(rows, [], 5).items).toHaveLength(5)
  })

  it('does not count rows past the cap as invalid', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      name: `h${i}`,
      host: `10.0.0.${i}`,
      username: 'root',
      port: 22
    }))
    expect(buildImportPreview(rows, [], 5).invalidCount).toBe(0)
  })

  it('returns an empty preview for empty input', () => {
    expect(buildImportPreview([], [])).toEqual({ items: [], invalidCount: 0 })
  })
})
