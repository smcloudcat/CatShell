import { describe, expect, it } from 'vitest'

import { TerminalLineGuard } from '../utils/lineGuard'

describe('TerminalLineGuard', () => {
  it('普通命令的 Enter 直接放行', () => {
    const guard = new TerminalLineGuard()
    guard.feed('l')
    guard.feed('s')
    const result = guard.feed('\r')
    expect(result.held).toBeNull()
    expect(result.passthrough).toBe('\r')
    expect(guard.feed('n')).toEqual({ passthrough: 'n', held: null })
  })

  it('高危命令扣下 Enter，确认后补发', () => {
    const guard = new TerminalLineGuard()
    for (const ch of 'rm -rf /') guard.feed(ch)
    const result = guard.feed('\r')
    expect(result.passthrough).toBe('')
    expect(result.held?.risks.map((r) => r.id)).toContain('rm-rf-root')
    expect(result.held?.line).toBe('rm -rf /')
    expect(guard.confirm()).toBe('\r')
    // 确认后缓冲清空
    expect(guard.feed('a')).toEqual({ passthrough: 'a', held: null })
  })

  it('取消后补发 Ctrl+C 且不执行', () => {
    const guard = new TerminalLineGuard()
    for (const ch of 'reboot') guard.feed(ch)
    const result = guard.feed('\r')
    expect(result.held).not.toBeNull()
    expect(guard.cancel()).toBe('\x03')
  })

  it('退格与 Ctrl+U 同步维护缓冲', () => {
    const guard = new TerminalLineGuard()
    for (const ch of 'rm -rf /tmp') guard.feed(ch)
    // 退格删掉 "tmp"，只剩 "rm -rf /" 变成高危
    for (let i = 0; i < 3; i += 1) guard.feed('\x7f')
    const result = guard.feed('\r')
    expect(result.held?.line).toBe('rm -rf /')
  })

  it('Ctrl+C 清缓冲后同命令不再拦', () => {
    const guard = new TerminalLineGuard()
    for (const ch of 'mkfs.ext4 /dev/sdb') guard.feed(ch)
    guard.feed('\x03')
    const result = guard.feed('\r')
    expect(result.held).toBeNull()
  })

  it('粘贴块含高危行时整块扣下', () => {
    const guard = new TerminalLineGuard()
    const result = guard.feed('echo ok\nrm -rf /\n')
    expect(result.passthrough).toBe('')
    expect(result.held?.line).toBe('rm -rf /')
    // \n 也算提交：feed 收到含 \r 才分析；这里用 \r 版本再验一次
    const guard2 = new TerminalLineGuard()
    const result2 = guard2.feed('echo ok\rmkfs.ext4 /dev/sdb\r')
    expect(result2.held?.risks.map((r) => r.id)).toContain('mkfs')
  })

  it('粘贴普通命令整块放行', () => {
    const guard = new TerminalLineGuard()
    const result = guard.feed('echo hello\rworld\r')
    expect(result.held).toBeNull()
    expect(result.passthrough).toBe('echo hello\rworld\r')
  })

  it('方向键控制序列不入缓冲（宁可漏报）', () => {
    const guard = new TerminalLineGuard()
    for (const ch of 'rm -rf /tmp/x') guard.feed(ch)
    // 用户按左方向键后回车——缓冲仍认为旧行，但控制序列本身不影响缓冲
    guard.feed('\x1b[D')
    const result = guard.feed('\r')
    // rm -rf /tmp/x 不命中规则，直接放行
    expect(result.held).toBeNull()
  })

  it('多行长命令缓冲上限保护', () => {
    const guard = new TerminalLineGuard()
    for (let i = 0; i < 5000; i += 1) guard.feed('a')
    const result = guard.feed('\r')
    expect(result.held).toBeNull()
  })
})
