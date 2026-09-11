import { describe, expect, it } from 'vitest'
import { findProfileByName, normalizeIntent, synthesizeAdhocProfile } from '../utils/launchIntent'
import type { HostProfile } from '../types/host'

function makeHost(overrides: Partial<HostProfile>): HostProfile {
  return {
    id: 'h1',
    name: 'Prod Web',
    icon: 'server',
    host: 'web.example.com',
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
    proxy: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authMethod: 'password',
      keyPath: null,
      next: null
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('normalizeIntent', () => {
  it('规范化 adhoc 意图并补默认值', () => {
    expect(
      normalizeIntent({ kind: 'adhoc', user: ' root ', host: ' web.example.com ', port: 2222 })
    ).toEqual({ kind: 'adhoc', user: 'root', host: 'web.example.com', port: 2222 })
    expect(normalizeIntent({ kind: 'adhoc', user: '', host: 'h', port: 0 })).toEqual({
      kind: 'adhoc',
      user: null,
      host: 'h',
      port: null
    })
  })

  it('profile 意图要求非空名称；形状不符返回 null', () => {
    expect(normalizeIntent({ kind: 'profile', name: ' prod ' })).toEqual({ kind: 'profile', name: 'prod' })
    expect(normalizeIntent({ kind: 'profile', name: '  ' })).toBeNull()
    expect(normalizeIntent({ kind: 'bogus' })).toBeNull()
    expect(normalizeIntent(null)).toBeNull()
    expect(normalizeIntent('adhoc')).toBeNull()
  })
})

describe('findProfileByName', () => {
  const hosts = [makeHost({ id: 'a', name: 'Prod Web' }), makeHost({ id: 'b', name: 'staging' })]

  it('大小写不敏感且忽略首尾空白', () => {
    expect(findProfileByName(hosts, '  prod web  ')?.id).toBe('a')
    expect(findProfileByName(hosts, 'STAGING')?.id).toBe('b')
  })

  it('找不到返回 null，空名直接返回 null', () => {
    expect(findProfileByName(hosts, 'missing')).toBeNull()
    expect(findProfileByName(hosts, '   ')).toBeNull()
  })
})

describe('synthesizeAdhocProfile', () => {
  it('带用户与端口合成档案草稿', () => {
    const profile = synthesizeAdhocProfile({ kind: 'adhoc', user: 'ops', host: 'db.internal', port: 2200 })
    expect(profile.id).toMatch(/^adhoc-/)
    expect(profile.name).toBe('ops@db.internal')
    expect(profile.username).toBe('ops')
    expect(profile.host).toBe('db.internal')
    expect(profile.port).toBe(2200)
    expect(profile.authMethod).toBe('password')
    expect(profile.password).toBeNull()
    expect(profile.proxy.enabled).toBe(false)
  })

  it('缺省端口为 22，缺省用户名为空', () => {
    const profile = synthesizeAdhocProfile({ kind: 'adhoc', user: null, host: 'host.only', port: null })
    expect(profile.port).toBe(22)
    expect(profile.username).toBe('')
    expect(profile.name).toBe('host.only')
  })
})
