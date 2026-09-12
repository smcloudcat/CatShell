import { SessionStatus } from '../../types/session'

/** 会话视图的纯工具与本地偏好读写，从 `SessionsView` 抽离以便单测。 */

/** 在线时长：小于 1 小时显示 `Xm`，否则 `Xh` / `XhYm`。 */
export function formatOnlineDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h${rest}m` : `${hours}h`
}

/**
 * 标签上的状态文案。
 *
 * 重连中要显示「第 N 次重连 · 间隔 Xs」，后端的 reason 通常带上具体错误
 * 但可能非常长，因此截断到 22 字符避免把标签撑开。
 */
export function statusLabel(
  t: (key: string) => string,
  status: SessionStatus,
  reason?: string | null,
  attempt?: number | null
): string {
  if (status === 'reconnecting' && attempt && attempt > 0) {
    const interval = attempt === 1 ? 2 : attempt === 2 ? 5 : 10
    return `${t('第 ')}${attempt}${t(' 次重连 · 间隔 ')}${interval}s`
  }
  if ((status === 'disconnected' || status === 'closed' || status === 'reconnecting') && reason) {
    return reason.length > 22 ? `${reason.slice(0, 22)}…` : reason
  }
  return t(`status.${status}`) ?? status
}

/** 去掉文件名里的非法字符，避免导出日志时被系统拒绝。 */
export function safeFileName(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'ssh-session'
}

/** 导出会话日志时的文件名：主机名 + ISO 时间戳。 */
export function sessionLogFileName(name: string, host: string): string {
  return `${safeFileName(name || host)}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
}

/**
 * 清除终端输出里的 ANSI 转义序列（OSC 与 CSI），并把孤立的 `\r` 转成换行。
 * 日志导出面向人类阅读，保留控制字符只会让文本编辑器错乱。
 */
export function cleanTerminalLog(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r(?!\n)/g, '\n')
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 读取面板尺寸偏好；非法或缺失时回退到默认值，并**按当前窗口夹紧**（审计 P-2）。
 *
 * 早期只校验 `> 0`：在大屏拖出的大尺寸存盘后，换到小窗口/分屏时会直接沿用过大的
 * 历史值，把终端区域挤没。这里读取即收敛到 [min, max]。
 */
export function readSessionSize(key: string, fallback: number, min: number, max: number): number {
  const stored = Number(localStorage.getItem(key))
  const base = Number.isFinite(stored) && stored > 0 ? stored : fallback
  return clamp(base, min, max)
}
