import { describe, expect, it } from 'vitest'
import { getSnippetParameters, renderCommandTemplate, shellQuote } from '../types/snippet'

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

describe('shellQuote', () => {
  it('wraps plain values in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'")
  })

  it('quotes empty values so they stay a single empty argument', () => {
    expect(shellQuote('')).toBe("''")
  })

  it('neutralizes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`)
  })

  it('neutralizes shell metacharacters by keeping them inside quotes', () => {
    expect(shellQuote('; rm -rf /')).toBe("'; rm -rf /'")
    expect(shellQuote('$(whoami)')).toBe("'$(whoami)'")
    expect(shellQuote('`id`')).toBe("'`id`'")
    expect(shellQuote('a && b || c')).toBe("'a && b || c'")
    expect(shellQuote('x > /etc/passwd')).toBe("'x > /etc/passwd'")
  })

  it('survives a classic quote-escape injection attempt', () => {
    // 攻击者试图闭合引号后追加命令；替换后整体仍是一个被引用的字面量。
    const injected = shellQuote("'; reboot #")
    expect(injected).toBe(`''"'"'; reboot #'`)
    // 关键点：结果中不存在未被转义的裸单引号序列
    expect(injected.startsWith(`''"'"'`)).toBe(true)
    expect(injected.endsWith("'")).toBe(true)
  })

  it('preserves newlines and tabs inside the quotes', () => {
    expect(shellQuote('a\nb\tc')).toBe("'a\nb\tc'")
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