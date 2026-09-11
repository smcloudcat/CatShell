import { describe, expect, it } from 'vitest'
import {
  applyFinalize,
  applyProgress,
  applyRegister,
  pendingForHost,
  pruneMissingHosts,
  queueKey,
  sanitizeLoaded,
  type QueuedTransfer
} from '../utils/transferQueue'

function makeEntry(overrides: Partial<QueuedTransfer> = {}): QueuedTransfer {
  return {
    key: queueKey('host-a', 'upload', '/srv/data.bin', 'C:/tmp/data.bin'),
    hostId: 'host-a',
    direction: 'upload',
    fileName: 'data.bin',
    remotePath: '/srv/data.bin',
    localPath: 'C:/tmp/data.bin',
    total: 1000,
    transferred: 400,
    updatedAt: 100,
    ...overrides
  }
}

describe('queueKey', () => {
  it('同一主机同方向同路径生成稳定键', () => {
    const a = queueKey('h1', 'download', '/a.txt', 'C:/a.txt')
    const b = queueKey('h1', 'download', '/a.txt', 'C:/a.txt')
    expect(a).toBe(b)
  })

  it('不同方向或路径生成不同键', () => {
    const base = queueKey('h1', 'download', '/a.txt', 'C:/a.txt')
    expect(queueKey('h2', 'download', '/a.txt', 'C:/a.txt')).not.toBe(base)
    expect(queueKey('h1', 'upload', '/a.txt', 'C:/a.txt')).not.toBe(base)
    expect(queueKey('h1', 'download', '/b.txt', 'C:/a.txt')).not.toBe(base)
    expect(queueKey('h1', 'download', '/a.txt', 'C:/b.txt')).not.toBe(base)
  })
})

describe('applyRegister', () => {
  it('同键去重并置顶', () => {
    const first = makeEntry({ updatedAt: 100 })
    const second = makeEntry({
      key: queueKey('host-a', 'download', '/x.txt', 'C:/x.txt'),
      direction: 'download',
      fileName: 'x.txt',
      remotePath: '/x.txt',
      localPath: 'C:/x.txt',
      updatedAt: 200
    })
    const again = makeEntry({ updatedAt: 300 })
    let entries = applyRegister([], first)
    entries = applyRegister(entries, second)
    expect(entries.map((item) => item.key)).toEqual([second.key, first.key])
    entries = applyRegister(entries, again)
    expect(entries.map((item) => item.key)).toEqual([first.key, second.key])
    expect(entries[0]?.updatedAt).toBe(300)
  })
})

describe('applyProgress', () => {
  it('只更新目标键的进度与时间戳', () => {
    const a = makeEntry({ updatedAt: 100 })
    const b = makeEntry({
      key: queueKey('host-a', 'download', '/x.txt', 'C:/x.txt'),
      direction: 'download',
      fileName: 'x.txt',
      remotePath: '/x.txt',
      localPath: 'C:/x.txt',
      updatedAt: 100
    })
    const updated = applyProgress([a, b], b.key, 900)
    expect(updated[0]?.updatedAt).toBe(100)
    expect(updated[1]?.transferred).toBe(900)
    expect(updated[1]?.updatedAt).toBeGreaterThan(100)
  })
})

describe('applyFinalize', () => {
  it('done 与 cancelled 移出队列', () => {
    const entry = makeEntry()
    expect(applyFinalize([entry], entry.key, 'done')).toEqual([])
    expect(applyFinalize([entry], entry.key, 'cancelled')).toEqual([])
  })

  it('failed 保留待续传（断点仍在）', () => {
    const entry = makeEntry()
    expect(applyFinalize([entry], entry.key, 'failed')).toEqual([entry])
  })
})

describe('pendingForHost', () => {
  it('按主机过滤并按更新时间倒序', () => {
    const older = makeEntry({ updatedAt: 100 })
    const newer = makeEntry({
      key: queueKey('host-a', 'download', '/x.txt', 'C:/x.txt'),
      direction: 'download',
      fileName: 'x.txt',
      remotePath: '/x.txt',
      localPath: 'C:/x.txt',
      updatedAt: 200
    })
    const otherHost = makeEntry({
      key: queueKey('host-b', 'upload', '/y.txt', 'C:/y.txt'),
      hostId: 'host-b',
      fileName: 'y.txt',
      remotePath: '/y.txt',
      localPath: 'C:/y.txt'
    })
    const pending = pendingForHost([older, otherHost, newer], 'host-a')
    expect(pending.map((item) => item.key)).toEqual([newer.key, older.key])
  })
})

describe('pruneMissingHosts', () => {
  it('移除主机档案已删除的队列项', () => {
    const kept = makeEntry()
    const dropped = makeEntry({
      key: queueKey('host-gone', 'upload', '/y.txt', 'C:/y.txt'),
      hostId: 'host-gone',
      fileName: 'y.txt',
      remotePath: '/y.txt',
      localPath: 'C:/y.txt'
    })
    const pruned = pruneMissingHosts([kept, dropped], new Set(['host-a']))
    expect(pruned).toEqual([kept])
  })
})

describe('sanitizeLoaded', () => {
  it('过滤非法形状，合法条目补全', () => {
    const valid = makeEntry()
    const raw = [
      valid,
      null,
      'junk',
      { key: 'k' },
      { ...valid, direction: 'sideways' },
      { ...valid, transferred: 'many' }
    ]
    const entries = sanitizeLoaded(raw)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.key).toBe(valid.key)
  })

  it('transferred 超出 total 时收敛到 total', () => {
    const entry = sanitizeLoaded([makeEntry({ transferred: 5000, total: 1000 })])[0]
    expect(entry?.transferred).toBe(1000)
  })

  it('非数组输入返回空数组', () => {
    expect(sanitizeLoaded(null)).toEqual([])
    expect(sanitizeLoaded({})).toEqual([])
  })
})
