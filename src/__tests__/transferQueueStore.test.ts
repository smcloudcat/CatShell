import { beforeEach, describe, expect, it, vi } from 'vitest'

// Store 级集成测试（审计 H-1 回归）：必须用真实 HostProfile[] 走完整 init 流程。
// 旧缺陷是把 Object.keys(hosts)（数组下标 "0"/"1"）当成主机 ID 集合，
// 导致所有合法续传记录在启动时被误判为孤儿并连同持久化一起删掉。
// 纯函数测试覆盖不了这个调用方传错集合的问题，必须 mock plugin-store 走 Store。

const { storeGet, storeSet, storeSave } = vi.hoisted(() => ({
  storeGet: vi.fn(),
  storeSet: vi.fn(),
  storeSave: vi.fn()
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn(() => Promise.resolve({ get: storeGet, set: storeSet, save: storeSave }))
}))
import { useHosts } from '../store/hosts'
import { useTransferQueue } from '../store/transferQueue'
import { normalizeHost } from '../utils/hostImport'
import { queueKey, type QueuedTransfer } from '../utils/transferQueue'

function makeHost(id: string) {
  return normalizeHost({
    id,
    name: `host-${id}`,
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authMethod: 'password'
  })
}

function makeEntry(hostId: string, remotePath: string): QueuedTransfer {
  return {
    key: queueKey(hostId, 'upload', remotePath, `C:/tmp/${remotePath}`),
    hostId,
    direction: 'upload',
    fileName: remotePath,
    remotePath,
    localPath: `C:/tmp/${remotePath}`,
    total: 1000,
    transferred: 400,
    updatedAt: 100
  }
}

beforeEach(() => {
  storeGet.mockReset()
  storeSet.mockReset()
  storeSave.mockReset()
  useHosts.setState({ ready: true, hosts: [makeHost('host-a'), makeHost('host-b')] })
  useTransferQueue.setState({ ready: false, entries: [] })
})

describe('useTransferQueue.init（H-1 回归）', () => {
  it('主机档案是 HostProfile[] 时，合法队列项不被误删', async () => {
    const kept = makeEntry('host-a', '/srv/kept.bin')
    storeGet.mockResolvedValue([kept])

    await useTransferQueue.getState().init()

    expect(useTransferQueue.getState().entries.map((item) => item.key)).toEqual([kept.key])
    // 没有清理发生时不应触发覆盖落盘
    expect(storeSet).not.toHaveBeenCalled()
  })

  it('只清理已删除主机的记录，并把清理结果写回', async () => {
    const kept = makeEntry('host-a', '/srv/kept.bin')
    const dropped = makeEntry('host-gone', '/srv/gone.bin')
    storeGet.mockResolvedValue([kept, dropped])

    await useTransferQueue.getState().init()

    expect(useTransferQueue.getState().entries.map((item) => item.key)).toEqual([kept.key])
    await vi.waitFor(() => {
      expect(storeSet).toHaveBeenCalledWith('pendingTransfers', [kept])
      expect(storeSave).toHaveBeenCalled()
    })
  })
})
