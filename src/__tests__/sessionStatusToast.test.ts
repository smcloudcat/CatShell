import { describe, expect, it } from 'vitest'
import { formatSessionNotice, sessionNoticeFor } from '../utils/sessionStatusToast'

const identityT = (key: string) => key

describe('sessionNoticeFor', () => {
  it('进入重连态时提示警告并允许系统通知', () => {
    const notice = sessionNoticeFor('connected', 'reconnecting', 1)
    expect(notice).not.toBeNull()
    expect(notice?.kind).toBe('warning')
    expect(notice?.systemNotify).toBe(true)
    expect(notice?.message).not.toContain('{n}')
  })

  it('重连次数大于 1 时文案带 {n} 占位', () => {
    const notice = sessionNoticeFor('connected', 'reconnecting', 3)
    expect(notice?.message).toContain('{n}')
    expect(notice?.attempt).toBe(3)
  })

  it('重连期间的后续尝试事件不再重复提示', () => {
    expect(sessionNoticeFor('reconnecting', 'reconnecting', 2)).toBeNull()
  })

  it('从重连态恢复连接时提示成功且不发系统通知', () => {
    const notice = sessionNoticeFor('reconnecting', 'connected')
    expect(notice?.kind).toBe('success')
    expect(notice?.systemNotify).toBe(false)
  })

  it('未开启自动重连时意外断开提示错误', () => {
    const notice = sessionNoticeFor('connected', 'disconnected')
    expect(notice?.kind).toBe('error')
    expect(notice?.systemNotify).toBe(true)
  })

  it('开启自动重连时断开保持静默，交给随后的重连警告', () => {
    expect(sessionNoticeFor('connected', 'disconnected', 0, { autoReconnect: true })).toBeNull()
  })

  it('用户主动断开（closing → closed）不提示', () => {
    expect(sessionNoticeFor('closing', 'closed')).toBeNull()
    expect(sessionNoticeFor('disconnected', 'closed')).toBeNull()
  })

  it('启动时同步到的历史会话（无前态）不提示', () => {
    expect(sessionNoticeFor(undefined, 'closed')).toBeNull()
    expect(sessionNoticeFor(undefined, 'disconnected')).toBeNull()
  })

  it('常规连接成功（connecting → connected）不提示', () => {
    expect(sessionNoticeFor('connecting', 'connected')).toBeNull()
  })

  it('重连成功后再次掉线仍会提示', () => {
    const notice = sessionNoticeFor('connected', 'reconnecting', 1)
    expect(notice?.kind).toBe('warning')
  })
})

describe('formatSessionNotice', () => {
  it('对 {n} 做次数插值', () => {
    const notice = sessionNoticeFor('connected', 'reconnecting', 4)
    const text = formatSessionNotice(notice!, identityT)
    expect(text).toContain('4')
    expect(text).not.toContain('{n}')
  })

  it('无占位的文案原样通过翻译', () => {
    const notice = sessionNoticeFor('reconnecting', 'connected')
    expect(formatSessionNotice(notice!, identityT)).toBe('会话已重新连接')
  })
})
