import { describe, expect, it } from 'vitest'
import { HostProfile } from '../types/host'
import {
  buildRequestFromProfile,
  planSessionRestore,
  profileHasAuth,
  RestorableTab
} from '../utils/sessionRestore'

let hostSeq = 0

function makeHost(overrides: Partial<HostProfile> = {}): HostProfile {
  hostSeq += 1
  return {
    id: `host-${hostSeq}`,
    name: `host-${hostSeq}`,
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
    proxy: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      authMethod: 'password',
      keyPath: null
    },
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

const tabOf = (host: HostProfile, name?: string): RestorableTab => ({
  hostId: host.id,
  name: name ?? host.name
})

describe('planSessionRestore', () => {
  it('密码主机有凭据时可恢复，请求字段来自主机配置', () => {
    const host = makeHost()
    const plan = planSessionRestore([tabOf(host)], [host], {
      [host.id]: { password: 'secret' }
    })
    expect(plan.skips).toEqual([])
    expect(plan.plans).toHaveLength(1)
    const request = plan.plans[0]!.request
    expect(request.host).toBe('10.0.0.1')
    expect(request.port).toBe(22)
    expect(request.username).toBe('root')
    expect(request.authMethod).toBe('password')
    expect(request.password).toBe('secret')
    expect(request.keepalive).toBe(30)
    expect(request.autoReconnect).toBe(true)
  })

  it('主机配置已被删除时跳过并标记 host-missing', () => {
    const plan = planSessionRestore([{ hostId: 'gone', name: 'x' }], [], {})
    expect(plan.plans).toEqual([])
    expect(plan.skips).toEqual([
      { tab: { hostId: 'gone', name: 'x' }, reason: 'host-missing' }
    ])
  })

  it('密码主机缺凭据时跳过并标记 credential-missing', () => {
    const host = makeHost()
    const plan = planSessionRestore([tabOf(host)], [host], {})
    expect(plan.plans).toEqual([])
    expect(plan.skips[0]?.reason).toBe('credential-missing')
  })

  it('agent 认证无需凭据即可恢复', () => {
    const host = makeHost({ authMethod: 'agent' })
    const plan = planSessionRestore([tabOf(host)], [host], {})
    expect(plan.plans).toHaveLength(1)
    expect(plan.plans[0]!.request.authMethod).toBe('agent')
  })

  it('私钥认证只需 keyPath 存在，口令可选', () => {
    const host = makeHost({ authMethod: 'key', keyPath: 'C:/keys/id_ed25519' })
    const plan = planSessionRestore([tabOf(host)], [host], {})
    expect(plan.plans).toHaveLength(1)
    expect(plan.plans[0]!.request.keyPath).toBe('C:/keys/id_ed25519')
    expect(plan.plans[0]!.request.passphrase).toBeNull()
  })

  it('私钥口令从保险箱凭据带入', () => {
    const host = makeHost({ authMethod: 'key', keyPath: 'C:/keys/id_ed25519' })
    const plan = planSessionRestore([tabOf(host)], [host], {
      [host.id]: { passphrase: 'open-sesame' }
    })
    expect(plan.plans[0]!.request.passphrase).toBe('open-sesame')
  })

  it('启用代理时把代理凭据一并传入请求', () => {
    const host = makeHost({
      proxy: {
        enabled: true,
        host: 'jump.example.com',
        port: 2222,
        username: 'jumper',
        authMethod: 'password',
        keyPath: null
      }
    })
    const plan = planSessionRestore([tabOf(host)], [host], {
      [host.id]: { password: 'secret' },
      [`proxy:${host.id}`]: { password: 'jump-pass' }
    })
    expect(plan.plans).toHaveLength(1)
    expect(plan.plans[0]!.request.proxy).toMatchObject({
      host: 'jump.example.com',
      port: 2222,
      username: 'jumper',
      authMethod: 'password',
      password: 'jump-pass'
    })
  })

  it('多个标签按输入顺序产出计划', () => {
    const ok = makeHost({ authMethod: 'agent' })
    const bad = makeHost({ authMethod: 'password' })
    const plan = planSessionRestore([tabOf(ok), tabOf(bad)], [ok, bad], {})
    expect(plan.plans.map((item) => item.tab.hostId)).toEqual([ok.id])
    expect(plan.skips.map((item) => item.tab.hostId)).toEqual([bad.id])
  })
})

describe('profileHasAuth', () => {
  it('key 认证看 keyPath，agent 认证恒真，其余看密码凭据', () => {
    expect(profileHasAuth(makeHost({ authMethod: 'key', keyPath: 'k' }), null)).toBe(true)
    expect(profileHasAuth(makeHost({ authMethod: 'key', keyPath: null }), null)).toBe(false)
    expect(profileHasAuth(makeHost({ authMethod: 'agent' }), null)).toBe(true)
    expect(profileHasAuth(makeHost({ authMethod: 'password' }), null)).toBe(false)
    expect(profileHasAuth(makeHost({ authMethod: 'password' }), { password: 'p' })).toBe(true)
  })
})

describe('buildRequestFromProfile', () => {
  it('不透传主机配置里的敏感占位字段，密码只来自凭据', () => {
    const host = makeHost({ password: null, passphrase: null })
    const request = buildRequestFromProfile(host, null)
    expect(request.password).toBeNull()
    expect(request.passphrase).toBeNull()
    expect(request.otpSecret).toBeNull()
    expect(request.name).toBe(host.name)
  })
})
