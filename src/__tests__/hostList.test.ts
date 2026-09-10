import { describe, expect, it } from 'vitest'
import { HostProfile } from '../types/host'
import { UNGROUPED_KEY, addressKey, collectTags, filterHosts, groupHosts } from '../utils/hostList'

function host(partial: Partial<HostProfile> & { id: string }): HostProfile {
  return {
    name: '',
    icon: 'server',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authMethod: 'password',
    password: null,
    keyPath: null,
    passphrase: null,
    group: null,
    tags: [],
    description: '',
    keepAliveInterval: 30,
    autoReconnect: true,
    proxy: { enabled: false, host: '', port: 22, username: '', authMethod: 'password', keyPath: null },
    createdAt: 0,
    updatedAt: 0,
    ...partial
  }
}

describe('addressKey', () => {
  it('joins host, port and username into a stable key', () => {
    expect(addressKey('10.0.0.1', 22, 'root')).toBe('10.0.0.1:22:root')
    // 同一台机器的不同用户必须是不同的键，否则导入会误判为重复。
    expect(addressKey('10.0.0.1', 22, 'deploy')).not.toBe(addressKey('10.0.0.1', 22, 'root'))
  })
})

describe('collectTags', () => {
  it('deduplicates and sorts tags', () => {
    const tags = collectTags([
      host({ id: '1', tags: ['web', 'linux'] }),
      host({ id: '2', tags: ['linux', 'deploy'] })
    ])
    expect(tags).toEqual(['deploy', 'linux', 'web'])
  })

  it('returns an empty list when there are no tags', () => {
    expect(collectTags([host({ id: '1' })])).toEqual([])
    expect(collectTags([])).toEqual([])
  })
})

describe('filterHosts', () => {
  const hosts = [
    host({ id: '1', name: 'prod-api', host: '10.0.0.1', username: 'deploy', group: '生产环境', tags: ['web'] }),
    host({ id: '2', name: 'staging-db', host: '10.0.0.2', username: 'root', group: null, tags: ['db'] }),
    host({ id: '3', name: '', host: '192.168.1.5', username: 'ops' })
  ]

  it('returns everything when there is no query or tag', () => {
    expect(filterHosts(hosts, '', null)).toHaveLength(3)
    expect(filterHosts(hosts, '   ', null)).toHaveLength(3)
  })

  it('matches name, address, username, group and tags case-insensitively', () => {
    expect(filterHosts(hosts, 'PROD', null).map((h) => h.id)).toEqual(['1'])
    expect(filterHosts(hosts, '192.168', null).map((h) => h.id)).toEqual(['3'])
    expect(filterHosts(hosts, 'ops', null).map((h) => h.id)).toEqual(['3'])
    expect(filterHosts(hosts, 'db', null).map((h) => h.id)).toEqual(['2'])
  })

  it('narrows by tag and combines with the query', () => {
    expect(filterHosts(hosts, '', 'web').map((h) => h.id)).toEqual(['1'])
    expect(filterHosts(hosts, 'prod', 'db')).toEqual([])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterHosts(hosts, 'nonexistent', null)).toEqual([])
  })
})

describe('groupHosts', () => {
  it('sorts groups by name and puts ungrouped last', () => {
    const buckets = groupHosts([
      host({ id: '1', group: '生产环境' }),
      host({ id: '2', group: null }),
      host({ id: '3', group: '测试环境' }),
      host({ id: '4', group: null })
    ], '未分组')

    expect(buckets.map((b) => b.key)).toEqual(['测试环境', '生产环境', UNGROUPED_KEY])
    expect(buckets[2]!.label).toBe('未分组')
    expect(buckets[2]!.hosts.map((h) => h.id)).toEqual(['2', '4'])
  })

  it('keeps the original order inside a group', () => {
    const buckets = groupHosts([
      host({ id: 'a', group: 'g' }),
      host({ id: 'b', group: 'g' }),
      host({ id: 'c', group: 'g' })
    ], '未分组')
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.hosts.map((h) => h.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns no buckets for an empty list', () => {
    expect(groupHosts([], '未分组')).toEqual([])
  })
})
