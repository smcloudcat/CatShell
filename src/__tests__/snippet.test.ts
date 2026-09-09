import { describe, expect, it } from 'vitest'
import { getSnippetParameters, renderCommandTemplate } from '../types/snippet'

describe('getSnippetParameters', () => {
  it('extracts unique parameter names in first-seen order', () => {
    expect(getSnippetParameters('docker logs {{ name }} --tail {{ lines }} | grep {{ name }}')).toEqual([
      'name',
      'lines'
    ])
  })

  it('returns empty for plain commands without placeholders', () => {
    expect(getSnippetParameters('uptime && free -m')).toEqual([])
  })

  it('ignores placeholders that do not start with a letter', () => {
    expect(getSnippetParameters('echo {{1bad}} {{ ok }}')).toEqual(['ok'])
  })
})

describe('renderCommandTemplate', () => {
  it('single-quotes values and escapes embedded quotes', () => {
    expect(
      renderCommandTemplate('grep {{ q }} /var/log/syslog', { q: "it'; reboot #" })
    ).toBe("grep 'it'\"'\"'; reboot #' /var/log/syslog")
  })

  it('replaces missing values with an empty quoted string', () => {
    expect(renderCommandTemplate('echo {{ missing }}', {})).toBe("echo ''")
  })

  it('keeps placeholders that never match the parameter syntax', () => {
    expect(renderCommandTemplate('echo {{1bad}} {{ ok }}', { ok: 'x' })).toBe("echo {{1bad}} 'x'")
  })
})