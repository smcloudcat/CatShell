import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clamp,
  cleanTerminalLog,
  formatOnlineDuration,
  readSessionSize,
  safeFileName,
  sessionLogFileName,
  statusLabel
} from '../views/sessions/sessionViewUtils'

/** 身份翻译函数：直接把 i18n 键当文案返回，便于断言拼接结果。 */
const t = (key: string) => key

describe('formatOnlineDuration', () => {
  it('uses minutes below an hour', () => {
    expect(formatOnlineDuration(0)).toBe('0m')
    expect(formatOnlineDuration(59_000)).toBe('0m')
    expect(formatOnlineDuration(60_000)).toBe('1m')
    expect(formatOnlineDuration(59 * 60_000)).toBe('59m')
  })

  it('uses hours and omits a zero minute remainder', () => {
    expect(formatOnlineDuration(60 * 60_000)).toBe('1h')
    expect(formatOnlineDuration(61 * 60_000)).toBe('1h1m')
    expect(formatOnlineDuration(150 * 60_000)).toBe('2h30m')
  })

  it('never goes negative', () => {
    expect(formatOnlineDuration(-5000)).toBe('0m')
  })
})

describe('statusLabel', () => {
  it('renders the reconnect attempt and backoff interval', () => {
    expect(statusLabel(t, 'reconnecting', null, 1)).toBe('第 1 次重连 · 间隔 2s')
    expect(statusLabel(t, 'reconnecting', null, 2)).toBe('第 2 次重连 · 间隔 5s')
    expect(statusLabel(t, 'reconnecting', null, 3)).toBe('第 3 次重连 · 间隔 10s')
    expect(statusLabel(t, 'reconnecting', null, 9)).toBe('第 9 次重连 · 间隔 10s')
  })

  it('prefers the reason for terminal states, truncating long ones', () => {
    expect(statusLabel(t, 'disconnected', 'connection reset')).toBe('connection reset')
    expect(statusLabel(t, 'closed', 'authentication failed')).toBe('authentication failed')
    const long = 'a'.repeat(40)
    expect(statusLabel(t, 'disconnected', long)).toBe(`${'a'.repeat(22)}…`)
  })

  it('falls back to the i18n key when there is no reason', () => {
    expect(statusLabel(t, 'connected', null, null)).toBe('status.connected')
    expect(statusLabel(t, 'disconnected', null, null)).toBe('status.disconnected')
  })

  it('ignores attempt 0 and negative attempts', () => {
    expect(statusLabel(t, 'reconnecting', null, 0)).toBe('status.reconnecting')
    expect(statusLabel(t, 'reconnecting', null, null)).toBe('status.reconnecting')
  })
})

describe('safeFileName', () => {
  it('replaces characters that are illegal on Windows', () => {
    expect(safeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('strips control characters and truncates to 80 chars', () => {
    expect(safeFileName('a\u0000b\u001fc')).toBe('a_b_c')
    expect(safeFileName('x'.repeat(120))).toHaveLength(80)
  })

  it('falls back when nothing usable remains', () => {
    expect(safeFileName('')).toBe('ssh-session')
    expect(safeFileName('///')).toBe('___')
  })
})

describe('sessionLogFileName', () => {
  it('prefers the session name and falls back to the host', () => {
    expect(sessionLogFileName('prod-api', '10.0.0.1')).toMatch(/^prod-api-.*\.log$/)
    expect(sessionLogFileName('', '10.0.0.1')).toMatch(/^10\.0\.0\.1-.*\.log$/)
  })

  it('contains no characters that a filesystem would reject', () => {
    const name = sessionLogFileName('prod:api/edge', '10.0.0.1')
    expect(name).not.toMatch(/[:/\\|?*<>"]/)
  })
})

describe('cleanTerminalLog', () => {
  it('removes CSI colour sequences', () => {
    expect(cleanTerminalLog('\u001b[31mred\u001b[0m')).toBe('red')
    expect(cleanTerminalLog('\u001b[1;32mok\u001b[0m!')).toBe('ok!')
  })

  it('removes OSC title sequences terminated by BEL or ST', () => {
    expect(cleanTerminalLog('\u001b]0;title\u0007payload')).toBe('payload')
    expect(cleanTerminalLog('\u001b]0;title\u001b\\payload')).toBe('payload')
  })

  it('turns a lone carriage return into a newline but keeps CRLF', () => {
    expect(cleanTerminalLog('progress 10%\rprogress 20%')).toBe('progress 10%\nprogress 20%')
    expect(cleanTerminalLog('a\r\nb')).toBe('a\r\nb')
  })
})

describe('clamp', () => {
  it('bounds the value on both sides', () => {
    expect(clamp(5, 1, 10)).toBe(5)
    expect(clamp(0, 1, 10)).toBe(1)
    expect(clamp(11, 1, 10)).toBe(10)
  })
})

describe('readSessionSize', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const withStorage = (value: string | null) => {
    vi.stubGlobal('localStorage', { getItem: () => value })
  }

  it('returns the stored value when it is a positive finite number within bounds', () => {
    withStorage('420')
    expect(readSessionSize('k', 320, 200, 600)).toBe(420)
  })

  it('falls back for missing, non-numeric, zero and negative values', () => {
    for (const value of [null, 'abc', '0', '-10', '']) {
      withStorage(value)
      expect(readSessionSize('k', 320, 200, 600)).toBe(320)
    }
  })

  it('clamps oversized and undersized stored values to the window bounds', () => {
    withStorage('9000')
    expect(readSessionSize('k', 320, 200, 600)).toBe(600)
    withStorage('10')
    expect(readSessionSize('k', 320, 200, 600)).toBe(200)
  })

  it('clamps the fallback itself into bounds', () => {
    withStorage(null)
    expect(readSessionSize('k', 9000, 200, 600)).toBe(600)
  })
})
