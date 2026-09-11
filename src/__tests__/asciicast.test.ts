import { describe, expect, it } from 'vitest'
import {
  asciicastDuration,
  buildAsciicast,
  parseAsciicast,
  playbackTimeline
} from '../utils/asciicast'

describe('buildAsciicast', () => {
  it('emits a v2 header line followed by output events', () => {
    const text = buildAsciicast({
      width: 120,
      height: 40,
      startedAt: 1_700_000_000,
      title: 'web-01',
      chunks: [
        { offsetMs: 0, text: 'hello ' },
        { offsetMs: 1500, text: 'world\r\n' }
      ]
    })
    const lines = text.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    const header = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(header.version).toBe(2)
    expect(header.width).toBe(120)
    expect(header.height).toBe(40)
    expect(header.timestamp).toBe(1_700_000_000)
    expect(header.title).toBe('web-01')
    expect(lines[1]).toBe('[0.000000, "o", "hello "]')
    expect(lines[2]).toBe('[1.500000, "o", "world\\r\\n"]')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('clamps non-positive sizes and skips empty chunks', () => {
    const text = buildAsciicast({
      width: 0,
      height: -5,
      startedAt: 0,
      chunks: [
        { offsetMs: 0, text: '' },
        { offsetMs: 10, text: 'ok' }
      ]
    })
    const lines = text.trimEnd().split('\n')
    const header = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(header.width).toBe(80)
    expect(header.height).toBe(24)
    expect(lines).toHaveLength(2)
  })
})

describe('parseAsciicast', () => {
  it('round-trips a built file', () => {
    const text = buildAsciicast({
      width: 100,
      height: 30,
      startedAt: 42,
      chunks: [{ offsetMs: 250, text: 'hi' }]
    })
    const doc = parseAsciicast(text)
    expect(doc.warnings).toEqual([])
    expect(doc.header).not.toBeNull()
    expect(doc.header?.width).toBe(100)
    expect(doc.events).toEqual([{ time: 0.25, type: 'o', data: 'hi' }])
  })

  it('collects warnings for broken lines but keeps the rest', () => {
    const content = [
      '{"version":2,"width":80,"height":24,"timestamp":1}',
      'not json at all',
      '[0.5, "o", "ok"]',
      '[bad, "o", "x"]',
      '[]',
      ''
    ].join('\n')
    const doc = parseAsciicast(content)
    expect(doc.events).toEqual([{ time: 0.5, type: 'o', data: 'ok' }])
    expect(doc.warnings.length).toBeGreaterThan(0)
  })

  it('returns a null header for wrong-version files', () => {
    const doc = parseAsciicast('{"version":1}\n[0, "o", "x"]\n')
    expect(doc.header).toBeNull()
    expect(doc.events).toEqual([{ time: 0, type: 'o', data: 'x' }])
  })

  it('tolerates empty content and CRLF line endings', () => {
    const empty = parseAsciicast('')
    expect(empty.header).toBeNull()
    expect(empty.events).toEqual([])

    const crlf = parseAsciicast('{"version":2,"width":80,"height":24,"timestamp":1}\r\n[1, "o", "a"]\r\n')
    expect(crlf.events).toEqual([{ time: 1, type: 'o', data: 'a' }])
  })
})

describe('asciicastDuration', () => {
  it('returns the last event time and zero for empty input', () => {
    expect(asciicastDuration([{ time: 1, type: 'o', data: 'a' }, { time: 3.5, type: 'o', data: 'b' }])).toBe(3.5)
    expect(asciicastDuration([])).toBe(0)
  })
})

describe('playbackTimeline', () => {
  it('keeps only stdout events sorted by time', () => {
    const timeline = playbackTimeline([
      { time: 2, type: 'o', data: 'b' },
      { time: 1, type: 'i', data: 'ignored' },
      { time: 1, type: 'o', data: 'a' }
    ])
    expect(timeline).toEqual([
      { time: 1, type: 'o', data: 'a' },
      { time: 2, type: 'o', data: 'b' }
    ])
  })
})
