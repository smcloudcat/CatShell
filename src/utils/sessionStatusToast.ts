import type { SessionStatus } from '../types/session'

export type SessionNoticeKind = 'warning' | 'error' | 'success'

export interface SessionNotice {
  kind: SessionNoticeKind
  /** i18n 中文原文键（项目以中文为 key），可含 {n} 占位表示重连尝试次数 */
  message: string
  /** 页面不可见（最小化 / 托盘）时同时发系统通知，保证用户看得到 */
  systemNotify: boolean
  /** {n} 的插值来源；null 表示文案不含占位 */
  attempt: number | null
}

export interface SessionNoticeOptions {
  /** 该会话是否开启了自动重连：开启时「意外断开」不必报错——随后必然到来的 reconnecting 事件会以警告提示 */
  autoReconnect?: boolean
}

const LIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(['connected', 'connecting', 'reconnecting'])

/**
 * 会话状态转变 → 用户通知判定（纯函数，UI 无关）。
 *
 * 原则：只在用户感知得到、且非其主动触发的转变上出声，
 * 常规流转（发起连接 → connected、用户点断开 → closing → closed）保持安静。
 *
 * - 进入重连：warning（网络已断，后台在重试）
 * - 重连成功：success
 * - 意外断开：error；但开启自动重连时降级为静默，避免与紧随的 warning 双响
 */
export function sessionNoticeFor(
  prev: SessionStatus | undefined,
  next: SessionStatus,
  attempt = 0,
  options: SessionNoticeOptions = {}
): SessionNotice | null {
  if (next === 'reconnecting') {
    // 重连期间每次尝试都会发事件，只在进入重连态时提示一次
    if (prev === 'reconnecting') return null
    return {
      kind: 'warning',
      message:
        attempt > 1 ? '连接已断开，正在自动重连（第 {n} 次尝试）' : '连接已断开，正在自动重连',
      systemNotify: true,
      attempt: attempt > 1 ? attempt : null
    }
  }
  if (next === 'disconnected' || next === 'closed') {
    const wasLive = prev !== undefined && LIVE_STATUSES.has(prev)
    if (!wasLive) return null
    // 自动重连开启时，断开只是重连的前奏，不单独报错
    if (options.autoReconnect && next === 'disconnected') return null
    return { kind: 'error', message: '会话连接已断开', systemNotify: true, attempt: null }
  }
  if (next === 'connected' && prev === 'reconnecting') {
    return { kind: 'success', message: '会话已重新连接', systemNotify: false, attempt: null }
  }
  return null
}

/** 把通知转成展示文案：走 i18n 取翻译，再做 {n} 插值。 */
export function formatSessionNotice(
  notice: SessionNotice,
  t: (key: string) => string
): string {
  const text = t(notice.message)
  return notice.attempt !== null ? text.replace('{n}', String(notice.attempt)) : text
}
