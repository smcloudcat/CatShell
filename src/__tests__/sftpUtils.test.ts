import { describe, expect, it, vi } from 'vitest'
import { SftpEntry } from '../types/session'
import {
  CANCELLED_MESSAGE,
  entryTitle,
  formatMode,
  isValidRemoteName,
  joinRemotePath,
  parentPath,
  parseChmodInput,
  permissionText,
  resolveMoveTarget,
  uploadWithRetry,
  visibleEntries
} from '../views/sessions/sftpUtils'

function entry(partial: Partial<SftpEntry> & { name: string }): SftpEntry {
  return {
    path: `/${partial.name}`,
    kind: 'file',
    size: 0,
    modifiedAt: null,
    permissions: null,
    owner: null,
    group: null,
    ...partial
  }
}

describe('parentPath', () => {
  it('walks up one level and stops at root', () => {
    expect(parentPath('/var/log/syslog')).toBe('/var/log')
    expect(parentPath('/var')).toBe('/')
    expect(parentPath('/')).toBe('/')
  })

  it('tolerates trailing slashes, empty and relative input', () => {
    expect(parentPath('/var/log/')).toBe('/var')
    expect(parentPath('')).toBe('/')
    expect(parentPath('var')).toBe('/')
  })
})

describe('formatMode / permissionText', () => {
  it('renders octal modes with a 3-digit minimum', () => {
    expect(formatMode(0o644)).toBe('644')
    expect(formatMode(0o755)).toBe('755')
    expect(formatMode(0o7)).toBe('007')
    expect(formatMode(0o4755)).toBe('4755')
  })

  it('renders rwx triads and dashes', () => {
    expect(permissionText(0o644)).toBe('rw-r--r--')
    expect(permissionText(0o755)).toBe('rwxr-xr-x')
    expect(permissionText(0o777)).toBe('rwxrwxrwx')
    expect(permissionText(0o000)).toBe('---------')
  })
})

describe('entryTitle', () => {
  it('is empty when no metadata is available', () => {
    expect(entryTitle(entry({ name: 'a.txt' }))).toBe('')
  })

  it('joins permissions, owner, group and mtime', () => {
    const title = entryTitle(entry({
      name: 'a.txt',
      permissions: 0o644,
      owner: 'root',
      group: 'www',
      modifiedAt: 0
    }))
    expect(title).toContain('权限 644（rw-r--r--）')
    expect(title).toContain('属主 root')
    expect(title).toContain('组 www')
    // modifiedAt 为 0 视为「未知」，不渲染时间。
    expect(title).not.toContain('修改于')
  })
})

describe('joinRemotePath', () => {
  it('never produces duplicate slashes', () => {
    expect(joinRemotePath('/', 'a.txt')).toBe('/a.txt')
    expect(joinRemotePath('/var', 'a.txt')).toBe('/var/a.txt')
    expect(joinRemotePath('/var/', 'a.txt')).toBe('/var/a.txt')
    expect(joinRemotePath('/var//', 'a.txt')).toBe('/var/a.txt')
  })
})

describe('resolveMoveTarget', () => {
  const file = entry({ name: 'a.txt', path: '/tmp/a.txt' })

  it('accepts an absolute target directory and keeps the file name', () => {
    expect(resolveMoveTarget(file, '/var/log')).toEqual({ ok: true, target: '/var/log/a.txt' })
    expect(resolveMoveTarget(file, '/var/log/')).toEqual({ ok: true, target: '/var/log/a.txt' })
    expect(resolveMoveTarget(file, '/')).toEqual({ ok: true, target: '/a.txt' })
  })

  it('rejects relative paths and doubled slashes', () => {
    expect(resolveMoveTarget(file, 'var/log')).toEqual({ ok: false, reason: 'invalid' })
    expect(resolveMoveTarget(file, '/var//log')).toEqual({ ok: false, reason: 'invalid' })
    expect(resolveMoveTarget(file, '  ')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects moving into the current directory', () => {
    expect(resolveMoveTarget(file, '/tmp')).toEqual({ ok: false, reason: 'same' })
  })

  it('rejects moving a directory into itself or its subtree', () => {
    const dir = entry({ name: 'src', path: '/project/src', kind: 'directory' })
    expect(resolveMoveTarget(dir, '/project/src')).toEqual({ ok: false, reason: 'descendant' })
    expect(resolveMoveTarget(dir, '/project/src/nested')).toEqual({ ok: false, reason: 'descendant' })
    // 兄弟目录不受影响。
    expect(resolveMoveTarget(dir, '/project/dist')).toEqual({ ok: true, target: '/project/dist/src' })
  })
})

describe('isValidRemoteName', () => {
  it('requires a non-empty name without slashes', () => {
    expect(isValidRemoteName('backup')).toBe(true)
    expect(isValidRemoteName('  backup  ')).toBe(true)
    expect(isValidRemoteName('')).toBe(false)
    expect(isValidRemoteName('   ')).toBe(false)
    expect(isValidRemoteName('a/b')).toBe(false)
    expect(isValidRemoteName('/abs')).toBe(false)
  })
})

describe('parseChmodInput', () => {
  it('parses 3 and 4 digit octal input', () => {
    expect(parseChmodInput('644')).toBe(0o644)
    expect(parseChmodInput('0755')).toBe(0o755)
    expect(parseChmodInput(' 777 ')).toBe(0o777)
  })

  it('rejects malformed or out-of-range input instead of returning NaN', () => {
    expect(parseChmodInput('')).toBeNull()
    expect(parseChmodInput('64')).toBeNull()
    expect(parseChmodInput('888')).toBeNull()
    expect(parseChmodInput('rwx')).toBeNull()
    expect(parseChmodInput('77777')).toBeNull()
  })
})

describe('visibleEntries', () => {
  const entries: SftpEntry[] = [
    entry({ name: 'readme.md', size: 300, modifiedAt: 30 }),
    entry({ name: '.env', size: 10, modifiedAt: 10 }),
    entry({ name: 'zeta', kind: 'directory', size: 0, modifiedAt: 50 }),
    entry({ name: 'alpha', kind: 'directory', size: 0, modifiedAt: 20 }),
    entry({ name: 'app.log', size: 100, modifiedAt: 40 })
  ]

  const base = { nameFilter: '', sortKey: 'name' as const, sortAsc: true, showHidden: true }

  it('hides dotfiles unless asked', () => {
    expect(visibleEntries(entries, base).map((e) => e.name)).toContain('.env')
    const hidden = visibleEntries(entries, { ...base, showHidden: false })
    expect(hidden.map((e) => e.name)).not.toContain('.env')
  })

  it('always lists directories before files', () => {
    const names = visibleEntries(entries, base).map((e) => e.name)
    expect(names.slice(0, 2)).toEqual(['alpha', 'zeta'])
  })

  it('filters by case-insensitive substring', () => {
    const names = visibleEntries(entries, { ...base, nameFilter: 'LOG' }).map((e) => e.name)
    expect(names).toEqual(['app.log'])
  })

  it('sorts by size and mtime with reversible direction', () => {
    const bySize = visibleEntries(entries, { ...base, sortKey: 'size' }).map((e) => e.size)
    expect(bySize).toEqual([0, 0, 10, 100, 300])
    // 目录恒排在文件前，降序只反转同类内部的顺序。
    const desc = visibleEntries(entries, { ...base, sortKey: 'size', sortAsc: false })
    expect(desc.map((e) => e.kind)).toEqual(['directory', 'directory', 'file', 'file', 'file'])
    expect(desc.map((e) => e.size)).toEqual([0, 0, 300, 100, 10])

    // 目录（alpha=20, zeta=50）先排，文件（.env=10, readme=30, app.log=40）按时间后随。
    const byTime = visibleEntries(entries, { ...base, sortKey: 'modifiedAt' })
    expect(byTime.map((e) => e.modifiedAt)).toEqual([20, 50, 10, 30, 40])
  })

  it('treats a missing mtime as oldest', () => {
    const list = [entry({ name: 'a', modifiedAt: null }), entry({ name: 'b', modifiedAt: 5 })]
    const sorted = visibleEntries(list, { ...base, sortKey: 'modifiedAt' }).map((e) => e.name)
    expect(sorted).toEqual(['a', 'b'])
  })

  it('does not mutate the input array', () => {
    const original = entries.map((e) => e.name)
    visibleEntries(entries, { ...base, sortKey: 'size' })
    expect(entries.map((e) => e.name)).toEqual(original)
  })
})

describe('uploadWithRetry', () => {
  it('returns the attempt number on first success', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    await expect(uploadWithRetry('/a.txt', new Uint8Array([1]), write)).resolves.toBe(1)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('retries transient failures and reports the successful attempt', async () => {
    vi.useFakeTimers()
    try {
      const write = vi.fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce(undefined)
      const promise = uploadWithRetry('/a.txt', new Uint8Array([1]), write)
      await vi.runAllTimersAsync()
      await expect(promise).resolves.toBe(2)
      expect(write).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after three attempts and rethrows the last error', async () => {
    vi.useFakeTimers()
    try {
      const write = vi.fn().mockRejectedValue(new Error('boom'))
      const promise = uploadWithRetry('/a.txt', new Uint8Array([1]), write)
      const assertion = expect(promise).rejects.toThrow('boom')
      await vi.runAllTimersAsync()
      await assertion
      expect(write).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CANCELLED_MESSAGE', () => {
  it('is the sentinel callers compare against', () => {
    expect(CANCELLED_MESSAGE).toBe('已取消')
  })
})
