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

/**
 * 会话页两个可拖拽面板的尺寸管理。
 *
 * 拖拽过程用 ref 暂存实时值、只在松手时写 localStorage：
 * 拖动中每帧写盘既没必要也会卡手。
 */
export function useSessionPanelResize() {
  const [monitorWidth, setMonitorWidth] = useState(() => readSessionSize(SIZE_KEYS.monitor, SIZE_FALLBACK.monitor))
  const [sftpHeight, setSftpHeight] = useState(() => readSessionSize(SIZE_KEYS.sftp, SIZE_FALLBACK.sftp))
  const widthRef = useRef(monitorWidth)
  const heightRef = useRef(sftpHeight)
  const dragRef = useRef<{ type: ResizeTarget; startX: number; startY: number; startSize: number } | null>(null)

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.type === 'monitor') {
        const next = clamp(drag.startSize - (event.clientX - drag.startX), MONITOR_MIN, MONITOR_MAX)
        widthRef.current = next
        setMonitorWidth(next)
      } else {
        const max = Math.max(220, window.innerHeight * SFTP_MAX_RATIO)
        const next = clamp(drag.startSize - (event.clientY - drag.startY), SFTP_MIN, max)
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
