import { useEffect, useRef, useState } from 'react'
import { clamp, readSessionSize } from './sessionViewUtils'

export type ResizeTarget = 'monitor' | 'sftp'

const SIZE_KEYS: Record<ResizeTarget, string> = {
  monitor: 'session-monitor-width',
  sftp: 'session-sftp-height'
}

const SIZE_FALLBACK: Record<ResizeTarget, number> = { monitor: 280, sftp: 340 }
const MONITOR_MIN = 240
const MONITOR_MAX = 560
const SFTP_MIN = 180
/** SFTP 面板最高不超过窗口高度的 62%，避免把终端挤没。 */
const SFTP_MAX_RATIO = 0.62

/** SFTP 面板在当前窗口下的高度上限（审计 P-2：随窗口变化重算，而非只在拖拽时算）。 */
function sftpMaxHeight(): number {
  return Math.max(220, window.innerHeight * SFTP_MAX_RATIO)
}

/**
 * 会话页两个可拖拽面板的尺寸管理。
 *
 * 拖拽过程用 ref 暂存实时值、只在松手时写 localStorage：
 * 拖动中每帧写盘既没必要也会卡手。
 *
 * 尺寸在**读取时**按当前窗口夹紧，并在窗口 resize 时重新夹紧（审计 P-2）：
 * 把大屏上拖出的尺寸带到小窗口时不会挤占终端区域；旧存的越界值就地收敛并写回，
 * 免得每次加载都要重新夹一遍。
 */
export function useSessionPanelResize() {
  const [monitorWidth, setMonitorWidth] = useState(() =>
    readSessionSize(SIZE_KEYS.monitor, SIZE_FALLBACK.monitor, MONITOR_MIN, MONITOR_MAX)
  )
  const [sftpHeight, setSftpHeight] = useState(() =>
    readSessionSize(SIZE_KEYS.sftp, SIZE_FALLBACK.sftp, SFTP_MIN, sftpMaxHeight())
  )
  const widthRef = useRef(monitorWidth)
  const heightRef = useRef(sftpHeight)
  const dragRef = useRef<{ type: ResizeTarget; startX: number; startY: number; startSize: number } | null>(null)

  // 状态是真源：拖拽结束后由 state → ref 同步，供下一次 startResize 取起点。
  useEffect(() => {
    widthRef.current = monitorWidth
  }, [monitorWidth])
  useEffect(() => {
    heightRef.current = sftpHeight
  }, [sftpHeight])

  // 挂载与窗口尺寸变化时按当前窗口重新夹紧；越界的历史值就地写回。
  useEffect(() => {
    const applyBounds = () => {
      const nextMonitor = clamp(widthRef.current, MONITOR_MIN, MONITOR_MAX)
      if (nextMonitor !== widthRef.current) {
        widthRef.current = nextMonitor
        setMonitorWidth(nextMonitor)
        localStorage.setItem(SIZE_KEYS.monitor, String(nextMonitor))
      }
      const nextSftp = clamp(heightRef.current, SFTP_MIN, sftpMaxHeight())
      if (nextSftp !== heightRef.current) {
        heightRef.current = nextSftp
        setSftpHeight(nextSftp)
        localStorage.setItem(SIZE_KEYS.sftp, String(nextSftp))
      }
    }
    applyBounds()
    window.addEventListener('resize', applyBounds)
    return () => window.removeEventListener('resize', applyBounds)
  }, [])

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.type === 'monitor') {
        const next = clamp(drag.startSize - (event.clientX - drag.startX), MONITOR_MIN, MONITOR_MAX)
        widthRef.current = next
        setMonitorWidth(next)
      } else {
        const next = clamp(drag.startSize - (event.clientY - drag.startY), SFTP_MIN, sftpMaxHeight())
        heightRef.current = next
        setSftpHeight(next)
      }
    }
    const stop = () => {
      const drag = dragRef.current
      if (!drag) return
      localStorage.setItem(SIZE_KEYS[drag.type], String(drag.type === 'monitor' ? widthRef.current : heightRef.current))
      dragRef.current = null
      document.body.classList.remove('session-resizing')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.classList.remove('session-resizing')
    }
  }, [])

  const startResize = (type: ResizeTarget, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragRef.current = {
      type,
      startX: event.clientX,
      startY: event.clientY,
      startSize: type === 'monitor' ? widthRef.current : heightRef.current
    }
    document.body.classList.add('session-resizing')
  }

  return { monitorWidth, sftpHeight, startResize }
}
