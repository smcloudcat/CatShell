import { describe, expect, it } from 'vitest'
import { HostProfile } from '../types/host'
import { MAX_PROXY_HOPS, countProxyHops } from '../types/session'
import {
  CONNECT_FORM_EMPTY,
  ConnectFormState,
  EMPTY_PROXY_PROFILE,
  buildPersistedProxy,
  connectFormFromProfile,
  parseTagsInput,
  shouldLoadSavedCredentials,
  validateForConnect,
  validateForSave,
  validateProxyInput
} from '../views/hosts/connectForm'

function profile(partial: Partial<HostProfile> = {}): HostProfile {
  return {
    id: 'host-1',
    name: 'prod',
    icon: 'server',
    host: '10.0.0.1',
    port: 2222,
    username: 'deploy',
    authMethod: 'password',
    password: null,
    keyPath: null,
    passphrase: null,
    group: '生产',
    tags: ['web', 'linux'],
    description: 'notes',
    keepAliveInterval: 45,
    autoReconnect: false,
    proxy: { enabled: false, host: '', port: 22, username: '', authMethod: 'password', keyPath: null },
    createdAt: 100,
    updatedAt: 200,
    ...partial
  }
}

function form(partial: Partial<ConnectFormState> = {}): ConnectFormState {
  return { ...CONNECT_FORM_EMPTY, host: '10.0.0.1', username: 'root', ...partial }
}

describe('connectFormFromProfile', () => {
  it('returns an empty form when there is no profile', () => {
    expect(connectFormFromProfile(null)).toEqual(CONNECT_FORM_EMPTY)
    expect(connectFormFromProfile(undefined)).toEqual(CONNECT_FORM_EMPTY)
    // 必须返回新对象，否则调用方改表单会污染这个共享常量。
    expect(connectFormFromProfile(null)).not.toBe(CONNECT_FORM_EMPTY)
  })

  it('maps persisted fields and stringifies numbers', () => {
    const state = connectFormFromProfile(profile())
    expect(state.host).toBe('10.0.0.1')
    expect(state.port).toBe('2222')
    expect(state.keepalive).toBe('45')
    expect(state.tags).toBe('web, linux')
    expect(state.autoReconnect).toBe(false)
  })

  it('never carries credentials into the form', () => {
    const state = connectFormFromProfile(profile({ authMethod: 'key', keyPath: 'C:/keys/id_ed25519' }))
    expect(state.password).toBe('')
    expect(state.passphrase).toBe('')
    expect(state.otpSecret).toBe('')
    // 私钥路径不是机密，保留以便用户直接重连。
    expect(state.keyPath).toBe('C:/keys/id_ed25519')
  })

  it('restores the proxy block without its credentials', () => {
    const state = connectFormFromProfile(profile({
      proxy: {
        enabled: true,
        host: 'bastion',
        port: 2200,
        username: 'jump',
        authMethod: 'key',
        keyPath: 'C:/keys/bastion'
      }
    }))
    expect(state.proxyEnabled).toBe(true)
    expect(state.proxyPort).toBe('2200')
    expect(state.proxyAuthMethod).toBe('key')
    expect(state.proxyPassword).toBe('')
    expect(state.proxyPassphrase).toBe('')
  })

  it('rebuilds extra hops from the persisted chain without credentials', () => {
    const state = connectFormFromProfile(profile({
      proxy: {
        enabled: true,
        host: 'bastion',
        port: 2200,
        username: 'jump',
        authMethod: 'password',
        keyPath: null,
        next: {
          enabled: true,
          host: 'relay',
          port: 2221,
          username: 'inner',
          authMethod: 'key',
          keyPath: 'C:/keys/relay',
          next: null
        }
      }
    }))
    expect(state.proxyNextHops).toEqual([
      { host: 'relay', port: '2221', username: 'inner', authMethod: 'key', password: '', keyPath: 'C:/keys/relay', passphrase: '' }
    ])
  })
})

describe('parseTagsInput', () => {
  it('splits on commas, ideographic commas and whitespace', () => {
    expect(parseTagsInput('web, linux，deploy、prod ops')).toEqual(['web', 'linux', 'deploy', 'prod', 'ops'])
  })

  it('deduplicates and drops empty entries', () => {
    expect(parseTagsInput('web,,web, ,linux')).toEqual(['web', 'linux'])
  })

  it('caps a single tag at 24 chars and the list at 10 entries', () => {
    expect(parseTagsInput('x'.repeat(40))).toEqual(['x'.repeat(24)])
    const many = Array.from({ length: 15 }, (_, i) => `t${i}`).join(',')
    expect(parseTagsInput(many)).toHaveLength(10)
  })

  it('returns an empty list for blank input', () => {
    expect(parseTagsInput('')).toEqual([])
    expect(parseTagsInput('   ')).toEqual([])
  })
})

describe('validateForConnect', () => {
  it('accepts a complete password form', () => {
    expect(validateForConnect(form(), 'secret', '')).toEqual({ ok: true })
  })

  it('requires host, username and a valid port', () => {
    expect(validateForConnect(form({ host: '  ' }), 'pw', '')).toEqual({ ok: false, reason: 'host' })
    expect(validateForConnect(form({ username: '' }), 'pw', '')).toEqual({ ok: false, reason: 'username' })
    for (const port of ['', '0', '65536', 'abc', '-1', '22.5']) {
      expect(validateForConnect(form({ port }), 'pw', '')).toEqual({ ok: false, reason: 'port' })
    }
  })

  it('requires a password only for password auth', () => {
    expect(validateForConnect(form({ authMethod: 'password' }), '', '')).toEqual({ ok: false, reason: 'password' })
    // 交互式 2FA 的密码是「服务器要求时填写」，不能强制。
    expect(validateForConnect(form({ authMethod: 'keyboard-interactive' }), '', '')).toEqual({ ok: true })
    // agent 认证不需要任何凭据。
    expect(validateForConnect(form({ authMethod: 'agent' }), '', '')).toEqual({ ok: true })
  })

  it('requires a key path for key auth', () => {
    expect(validateForConnect(form({ authMethod: 'key' }), '', '')).toEqual({ ok: false, reason: 'keyPath' })
    expect(validateForConnect(form({ authMethod: 'key' }), '', '   ')).toEqual({ ok: false, reason: 'keyPath' })
    expect(validateForConnect(form({ authMethod: 'key' }), '', 'C:/keys/id')).toEqual({ ok: true })
  })
})

describe('validateForSave', () => {
  it('does not require a password', () => {
    expect(validateForSave(form(), '')).toEqual({ ok: true })
  })

  it('still enforces host, username, port and key path', () => {
    expect(validateForSave(form({ host: '' }), '')).toEqual({ ok: false, reason: 'host' })
    expect(validateForSave(form({ authMethod: 'key' }), '')).toEqual({ ok: false, reason: 'keyPath' })
  })
})

describe('validateProxyInput', () => {
  const enabled = { proxyEnabled: true, proxyHost: 'bastion', proxyUsername: 'jump' }

  it('is a no-op when the proxy is disabled', () => {
    const result = validateProxyInput(form(), 'pw', 'pp')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.proxy).toBeNull()
  })

  it('carries the supplied credentials into the proxy config', () => {
    const result = validateProxyInput(form(enabled), 'jump-pw', 'jump-pp')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proxy).toMatchObject({
      host: 'bastion',
      port: 22,
      username: 'jump',
      authMethod: 'password',
      password: 'jump-pw',
      passphrase: 'jump-pp'
    })
  })

  it('validates host, username and port', () => {
    expect(validateProxyInput(form({ ...enabled, proxyHost: ' ' }), '', '')).toEqual({ ok: false, reason: 'proxyHost' })
    expect(validateProxyInput(form({ ...enabled, proxyUsername: '' }), '', '')).toEqual({ ok: false, reason: 'proxyUsername' })
    expect(validateProxyInput(form({ ...enabled, proxyPort: '70000' }), '', '')).toEqual({ ok: false, reason: 'proxyPort' })
    expect(validateProxyInput(form({ ...enabled, proxyPort: '0' }), '', '')).toEqual({ ok: false, reason: 'proxyPort' })
  })

  it('requires a key file only when the proxy uses key auth', () => {
    expect(validateProxyInput(form({ ...enabled, proxyAuthMethod: 'key' }), '', '')).toEqual({ ok: false, reason: 'proxyKeyPath' })
    const ok = validateProxyInput(form({ ...enabled, proxyAuthMethod: 'key', proxyKeyPath: 'C:/keys/jump' }), '', '')
    expect(ok.ok).toBe(true)
  })

  it('validates every hop of the chain and assembles next links', () => {
    const hop = (host: string) => ({ host, port: '2222', username: 'u', authMethod: 'password' as const, password: 'pw', keyPath: '', passphrase: '' })
    const chained = form({
      ...enabled,
      proxyNextHops: [hop('relay'), hop('edge')]
    })
    const result = validateProxyInput(chained, 'pw-1', '')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proxy).toMatchObject({ host: 'bastion', password: 'pw-1' })
    expect(result.proxy?.next).toMatchObject({ host: 'relay', password: 'pw' })
    expect(result.proxy?.next?.next).toMatchObject({ host: 'edge' })
    expect(result.proxy?.next?.next?.next).toBeUndefined()
  })

  it('reports the first invalid hop in the chain', () => {
    const badHop = { host: '', port: '22', username: 'u', authMethod: 'password' as const, password: '', keyPath: '', passphrase: '' }
    expect(validateProxyInput(form({ ...enabled, proxyNextHops: [badHop] }), '', '')).toEqual({ ok: false, reason: 'proxyHost' })
    const badPort = { host: 'relay', port: '0', username: 'u', authMethod: 'password' as const, password: '', keyPath: '', passphrase: '' }
    expect(validateProxyInput(form({ ...enabled, proxyNextHops: [badPort] }), '', '')).toEqual({ ok: false, reason: 'proxyPort' })
  })

  it('truncates the chain beyond the hop limit', () => {
    const hop = () => ({ host: 'relay', port: '22', username: 'u', authMethod: 'password' as const, password: '', keyPath: '', passphrase: '' })
    const many = Array.from({ length: MAX_PROXY_HOPS + 2 }, hop)
    const result = validateProxyInput(form({ ...enabled, proxyNextHops: many }), '', '')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 链上有效级数 = 第 1 跳 + 保留的额外跳，不得超过 MAX_PROXY_HOPS。
    expect(countProxyHops(result.proxy)).toBe(MAX_PROXY_HOPS)
  })
})

describe('buildPersistedProxy', () => {
  it('drops credentials and keeps only non-sensitive fields', () => {
    const persisted = buildPersistedProxy({
      host: ' bastion ',
      port: '2200',
      username: 'jump',
      authMethod: 'password',
      password: 'super-secret',
      passphrase: 'super-secret-2'
    }, EMPTY_PROXY_PROFILE)

    expect(persisted).toEqual({
      enabled: true,
      host: ' bastion ',
      port: 2200,
      username: 'jump',
      authMethod: 'password',
      keyPath: null,
      next: null
    })
    expect(JSON.stringify(persisted)).not.toContain('super-secret')
  })

  it('persists the whole chain without credentials', () => {
    const persisted = buildPersistedProxy({
      host: 'bastion',
      port: 2200,
      username: 'jump',
      authMethod: 'password',
      password: 'secret-1',
      next: {
        host: 'relay',
        port: '2221',
        username: 'inner',
        authMethod: 'key',
        keyPath: 'C:/keys/relay',
        passphrase: 'secret-2'
      }
    }, EMPTY_PROXY_PROFILE)

    expect(persisted.next).toEqual({
      enabled: true,
      host: 'relay',
      port: 2221,
      username: 'inner',
      authMethod: 'key',
      keyPath: 'C:/keys/relay',
      next: null
    })
    const serialized = JSON.stringify(persisted)
    expect(serialized).not.toContain('secret-1')
    expect(serialized).not.toContain('secret-2')
  })

  it('falls back when no proxy is configured', () => {
    expect(buildPersistedProxy(null, EMPTY_PROXY_PROFILE)).toBe(EMPTY_PROXY_PROFILE)
    expect(buildPersistedProxy(undefined, EMPTY_PROXY_PROFILE).enabled).toBe(false)
  })
})

describe('shouldLoadSavedCredentials', () => {
  const configured = { hasProfile: true, vaultConfigured: true, vaultUnlocked: false }

  it('skips unlocking when there is no profile or no vault', () => {
    expect(shouldLoadSavedCredentials(form({ authMethod: 'key' }), { ...configured, hasProfile: false })).toBe(false)
    expect(shouldLoadSavedCredentials(form({ authMethod: 'key' }), { ...configured, vaultConfigured: false })).toBe(false)
  })

  it('skips unlocking when the vault is already open', () => {
    expect(shouldLoadSavedCredentials(form({ authMethod: 'key' }), { ...configured, vaultUnlocked: true })).toBe(false)
  })

  it('unlocks for key auth, which always needs a stored passphrase', () => {
    expect(shouldLoadSavedCredentials(form({ authMethod: 'key' }), configured)).toBe(true)
  })

  it('unlocks for password auth only when the field is still empty', () => {
    expect(shouldLoadSavedCredentials(form({ authMethod: 'password' }), configured)).toBe(true)
    expect(shouldLoadSavedCredentials(form({ authMethod: 'password', password: 'typed' }), configured)).toBe(false)
    // 交互式 2FA 与 agent 的凭据由服务器或 Agent 提供，无需取用保险箱。
    expect(shouldLoadSavedCredentials(form({ authMethod: 'agent' }), configured)).toBe(false)
    expect(shouldLoadSavedCredentials(form({ authMethod: 'keyboard-interactive' }), configured)).toBe(false)
  })

  it('unlocks when an enabled proxy needs credentials', () => {
    expect(shouldLoadSavedCredentials(
      form({ authMethod: 'agent', proxyEnabled: true, proxyAuthMethod: 'key' }),
      configured
    )).toBe(true)
  })
})
