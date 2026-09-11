import { describe, expect, it } from 'vitest'
import {
  BATCH_DEFAULT_TIMEOUT_SECS,
  BATCH_MAX_TARGETS,
  batchResultText,
  normalizeBatchCommand,
  normalizeBatchTargets,
  parseBatchTimeout,
  summarizeBatchResults
} from '../utils/batchExec'

describe('parseBatchTimeout', () => {
  it('keeps values inside the sane range', () => {
    expect(parseBatchTimeout('10')).toBe(10)
    expect(parseBatchTimeout(30)).toBe(30)
  })

  it('clamps out-of-range values', () => {
    expect(parseBatchTimeout('0')).toBe(1)
    expect(parseBatchTimeout('-5')).toBe(1)
    expect(parseBatchTimeout('999')).toBe(120)
  })

  it('falls back to the default for garbage input', () => {
    expect(parseBatchTimeout('abc')).toBe(BATCH_DEFAULT_TIMEOUT_SECS)
    expect(parseBatchTimeout(null)).toBe(BATCH_DEFAULT_TIMEOUT_SECS)
    expect(parseBatchTimeout(undefined)).toBe(BATCH_DEFAULT_TIMEOUT_SECS)
  })

  it('truncates fractional numbers', () => {
    expect(parseBatchTimeout(9.9)).toBe(9)
  })
})

describe('normalizeBatchCommand', () => {
  it('trims and passes through normal commands', () => {
    expect(normalizeBatchCommand('  uname -a  ')).toBe('uname -a')
  })

  it('rejects blank and over-long commands', () => {
    expect(normalizeBatchCommand('   ')).toBeNull()
    expect(normalizeBatchCommand('x'.repeat(4097))).toBeNull()
  })
})

describe('normalizeBatchTargets', () => {
  it('dedupes while keeping order', () => {
    expect(normalizeBatchTargets([3, 1, 3, 2, 1])).toEqual([3, 1, 2])
  })

  it('caps the target count', () => {
    const ids = Array.from({ length: 50 }, (_, index) => index + 1)
    expect(normalizeBatchTargets(ids)).toHaveLength(BATCH_MAX_TARGETS)
  })

  it('returns empty for empty input', () => {
    expect(normalizeBatchTargets([])).toEqual([])
  })
})

describe('summarizeBatchResults', () => {
  it('counts successes and failures', () => {
    const summary = summarizeBatchResults([{ ok: true }, { ok: false }, { ok: true }])
    expect(summary).toEqual({ total: 3, okCount: 2, failedCount: 1, allOk: false })
  })

  it('reports allOk only when every item succeeded', () => {
    expect(summarizeBatchResults([{ ok: true }, { ok: true }]).allOk).toBe(true)
    expect(summarizeBatchResults([]).allOk).toBe(false)
  })
})

describe('batchResultText', () => {
  it('prefers output for success and error for failure', () => {
    expect(batchResultText({ ok: true, output: 'hello', error: null })).toBe('hello')
    expect(batchResultText({ ok: false, output: '', error: '超时' })).toBe('超时')
    expect(batchResultText({ ok: false, output: '', error: null })).toBe('')
  })
})
