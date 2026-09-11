import { describe, expect, it } from 'vitest'
import {
  buildConnectRequest,
  buildProxyConfig,
  normalizeKeepalive,
  normalizePort
} from '../types/session'

describe('normalizePort', () => {
  it('accepts numeric strings and numbers in range', () => {
    expect(normalizePort('22')).toBe(22)
    expect(normalizePort(65535)).toBe(65535)
    expect(normalizePort('1')).toBe(1)
  })

  it('falls back for empty, non-numeric and out-of-range values', () => {
    expect(normalizePort('')).toBe(22)
    expect(normalizePort(null)).toBe(22)
    expect(normalizePort(undefined)).toBe(22)
    expect(normalizePort('abc')).toBe(22)
    expect(normalizePort(0)).toBe(22)
    expect(normalizePort(-1)).toBe(22)
    expect(normalizePort(65536)).toBe(22)
  })

  it('honours a custom fallback', () => {
    expect(normalizePort('nope', 2222)).toBe(2222)
  })
})

describe('normalizeKeepalive', () => {
  it('keeps positive values and truncates fractions', () => {
    expect(normalizeKeepalive('30')).toBe(30)
    expect(normalizeKeepalive(45.7)).toBe(45)
  })

  it('falls back for non-positive or invalid values', () => {
    expect(normalizeKeepalive('')).toBe(30)
    expect(normalizeKeepalive(0)).toBe(30)
    expect(normalizeKeepalive(-5)).toBe(30)
    expect(normalizeKeepalive(undefined)).toBe(30)
  })

  it('clamps to the range the connection form advertises', () => {
    // 表单的 min/max 只是提示，用户可以手输越界值，归一化必须兜住。
    expect(normalizeKeepalive(1)).toBe(5)
    expect(normalizeKeepalive('3')).toBe(5)
    expect(normalizeKeepalive(5000)).toBe(300)
    expect(normalizeKeepalive('9999')).toBe(300)
    expect(normalizeKeepalive(5)).toBe(5)
    expect(normalizeKeepalive(300)).toBe(300)
  })
})

describe('buildProxyConfig', () => {
  it('returns null when no proxy is configured', () => {
    expect(buildProxyConfig(null)).toBeNull()
    expect(buildProxyConfig(undefined)).toBeNull()
  })

  it('keeps only the credentials matching the chosen auth method', () => {
    const passwordProxy = buildProxyConfig({
      host: ' jump.example.com ',
      port: '2222',
      username: ' ops ',
      authMethod: 'password',
      password: 'pw',
      keyPath: 'C:/keys/id_ed25519',
      passphrase: 'pp'
    })
    expect(passwordProxy).toEqual({
      host: 'jump.example.com',
      port: 2222,
      username: 'ops',
      authMethod: 'password',
      password: 'pw',
      keyPath: null,
      passphrase: null,
      next: null
    })
  })

  it('drops password and keeps key credentials for key auth', () => {
    const keyProxy = buildProxyConfig({
      host: 'jump',
      port: 22,
      username: 'ops',
      authMethod: 'key',
      password: 'leaked',
      keyPath: ' C:/keys/id_ed25519 ',
      passphrase: 'pp'
    })
    expect(keyProxy).toMatchObject({
      password: null,
      keyPath: 'C:/keys/id_ed25519',
      passphrase: 'pp'
    })
  })

  it('never carries a passphrase when no passphrase is supplied', () => {
    const proxy = buildProxyConfig({
      host: 'jump',
      port: 22,
      username: 'ops',
      authMethod: 'key',
      keyPath: 'k',
      passphrase: ''
    })
    expect(proxy?.passphrase).toBeNull()
  })
})

describe('buildConnectRequest', () => {
  it('derives a display name from user@host when none is given', () => {
    const request = buildConnectRequest({
      name: '   ',
      host: ' 10.0.0.1 ',
      port: '22',
      username: ' root ',
      authMethod: 'password',
      password: 'pw'
    })
    expect(request.name).toBe('root@10.0.0.1')
    expect(request.host).toBe('10.0.0.1')
    expect(request.username).toBe('root')
  })

  it('keeps the explicit name when provided', () => {
    const request = buildConnectRequest({
      name: '生产网关',
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'agent'
    })
    expect(request.name).toBe('生产网关')
  })

  it('password auth carries only the password', () => {
    const request = buildConnectRequest({
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'password',
      password: 'pw',
      keyPath: '/should/be/dropped',
      passphrase: 'dropped',
      otpSecret: 'dropped'
    })
    expect(request.password).toBe('pw')
    expect(request.keyPath).toBeNull()
    expect(request.passphrase).toBeNull()
    expect(request.otpSecret).toBeNull()
  })

  it('key auth carries key path and passphrase but never the login password', () => {
    const request = buildConnectRequest({
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'key',
      password: 'must-not-leak',
      keyPath: ' /keys/id_ed25519 ',
      passphrase: 'pp',
      otpSecret: 'dropped'
    })
    expect(request.password).toBeNull()
    expect(request.keyPath).toBe('/keys/id_ed25519')
    expect(request.passphrase).toBe('pp')
    expect(request.otpSecret).toBeNull()
  })

  it('agent auth carries no credentials at all', () => {
    const request = buildConnectRequest({
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'agent',
      password: 'dropped',
      keyPath: 'dropped',
      passphrase: 'dropped',
      otpSecret: 'dropped'
    })
    expect(request.password).toBeNull()
    expect(request.keyPath).toBeNull()
    expect(request.passphrase).toBeNull()
    expect(request.otpSecret).toBeNull()
  })

  it('keyboard-interactive carries password and otp secret only', () => {
    const request = buildConnectRequest({
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'keyboard-interactive',
      password: 'pw',
      keyPath: 'dropped',
      passphrase: 'dropped',
      otpSecret: ' JBSWY3DPEHPK3PXP '
    })
    expect(request.password).toBe('pw')
    expect(request.keyPath).toBeNull()
    expect(request.passphrase).toBeNull()
    expect(request.otpSecret).toBe('JBSWY3DPEHPK3PXP')
  })

  it('treats empty strings as absent credentials', () => {
    const request = buildConnectRequest({
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'key',
      keyPath: 'k',
      passphrase: ''
    })
    expect(request.passphrase).toBeNull()
  })

  it('normalizes port and keepalive with the same rules as host profiles', () => {
    const request = buildConnectRequest({
      host: 'h',
      port: '',
      username: 'u',
      authMethod: 'agent',
      keepalive: ''
    })
    expect(request.port).toBe(22)
    expect(request.keepalive).toBe(30)
    expect(request.autoReconnect).toBe(false)
  })

  it('propagates autoReconnect and the normalized proxy', () => {
    const request = buildConnectRequest({
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'password',
      password: 'pw',
      autoReconnect: true,
      proxy: {
        host: 'jump',
        port: '2222',
        username: 'ops',
        authMethod: 'password',
        password: 'proxy-pw',
        keyPath: 'dropped',
        passphrase: 'dropped'
      }
    })
    expect(request.autoReconnect).toBe(true)
    expect(request.proxy).toEqual({
      host: 'jump',
      port: 2222,
      username: 'ops',
      authMethod: 'password',
      password: 'proxy-pw',
      keyPath: null,
      passphrase: null,
      next: null
    })
  })

  it('omits the proxy entirely when none is supplied', () => {
    const request = buildConnectRequest({
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'agent',
      proxy: null
    })
    expect(request.proxy).toBeNull()
  })
})
