import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { useT } from '../../i18n'
import { useSettings } from '../../store/settings'
import {
  asciicastDuration,
  AsciicastDoc,
  playbackTimeline
} from '../../utils/asciicast'
import { DARK_TERM_THEME, LIGHT_TERM_THEME } from './terminalTheme'

interface Props {
  fileName: string
  doc: AsciicastDoc
  onClose: () => void
}

const SPEEDS = [1, 2, 4] as const

/**
 * 录制回放：只读 xterm 按时间轴逐事件写入。
 * 支持 播放/暂停、1x/2x/4x 倍速与进度条拖动（拖动即暂停并从该时刻重放）。
 */
export function RecordingPlayerDialog({ fileName, doc, onClose }: Props) {
  const t = useT()
  const themeMode = useSettings((state) => state.theme.mode)
  const fontFamily = useSettings((state) => state.terminal.fontFamily)
  const fontSize = useSettings((state) => state.terminal.fontSize)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const timerRef = useRef<number | null>(null)
  const cursorRef = useRef(0)
  const elapsedRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [finished, setFinished] = useState(false)

  const timeline = playbackTimeline(doc.events)
  const totalSec = asciicastDuration(timeline)
  const header = doc.header
  const rows = header?.height ?? 24

  // 终端实例随弹窗挂载/卸载
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      convertEol: true,
      scrollback: 5000,
      fontFamily,
      fontSize,
      theme: themeMode === 'light' ? LIGHT_TERM_THEME : DARK_TERM_THEME
    })
    term.open(container)
    termRef.current = term
    // 起始画面：不自动播放，等待用户点击
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      term.dispose()
      termRef.current = null
    }
    // 字体/主题等设置项变更时不重建终端，保持与主终端一致的行为由主面板负责
  }, [])

  const clearAndReplay = (upToIndex: number, withDelay: boolean) => {
    const term = termRef.current
    if (!term) return
    term.reset()
    cursorRef.current = 0
    elapsedRef.current = 0
    setElapsedSec(0)
    setFinished(false)
    if (!withDelay) {
      for (let i = 0; i < upToIndex; i += 1) {
        const event = timeline[i]
        if (event) term.write(event.data)
      }
      cursorRef.current = upToIndex
      elapsedRef.current = timeline[upToIndex - 1]?.time ?? 0
      setElapsedSec(elapsedRef.current)
    }
  }

  const stopTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const scheduleNext = () => {
    const term = termRef.current
    if (!term) return
    const event = timeline[cursorRef.current]
    if (!event) {
      setPlaying(false)
      setFinished(true)
      return
    }
    const waitMs = Math.max(0, (event.time - elapsedRef.current) * 1000) / speed
    timerRef.current = window.setTimeout(() => {
      term.write(event.data)
      elapsedRef.current = event.time
      cursorRef.current += 1
      setElapsedSec(event.time)
      scheduleNext()
    }, Math.min(waitMs, 2_000_000))
  }

  const togglePlay = () => {
    if (playing) {
      stopTimer()
      setPlaying(false)
      return
    }
    if (cursorRef.current >= timeline.length) {
      clearAndReplay(0, false)
    }
    setPlaying(true)
    setFinished(false)
    scheduleNext()
  }

  const changeSpeed = (next: (typeof SPEEDS)[number]) => {
    setSpeed(next)
    if (playing) {
      stopTimer()
      scheduleNext()
    }
  }

  const seekTo = (seconds: number) => {
    stopTimer()
    setPlaying(false)
    // 找到第一个时间 >= 目标的事件下标
    let index = 0
    while (index < timeline.length && timeline[index]!.time < seconds) index += 1
    clearAndReplay(index, false)
  }

  const formatClock = (seconds: number) => {
    const total = Math.floor(seconds)
    const mm = String(Math.floor(total / 60)).padStart(2, '0')
    const ss = String(total % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  return (
    <Modal onClose={onClose} className="recording-player-modal" ariaLabel={t('录制回放')}>
      <header className="modal-header">
        <div className="modal-title">
          <Icon name="play" size={17} />
          {t('录制回放')} · {fileName}
        </div>
        <button className="modal-close" onClick={onClose} title={t('关闭')}>
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="recording-player-body">
        <div ref={containerRef} className="recording-terminal" style={{ height: Math.min(rows, 32) * (fontSize + 3) + 12 }} />
        <div className="recording-controls">
          <button className="glass-btn primary" onClick={togglePlay} title={playing ? t('暂停') : t('播放')}>
            <Icon name={playing ? 'pause' : 'play'} size={14} />
            {playing ? t('暂停') : finished ? t('重新播放') : t('播放')}
          </button>
          <div className="recording-speeds" role="group" aria-label={t('回放倍速')}>
            {SPEEDS.map((value) => (
              <button
                key={value}
                className={`glass-btn recording-speed${speed === value ? ' active' : ''}`}
                onClick={() => changeSpeed(value)}
              >
                {value}×
              </button>
            ))}
          </div>
          <input
            className="recording-seek"
            type="range"
            min={0}
            max={Math.max(1, Math.floor(totalSec * 1000))}
            value={Math.floor(elapsedSec * 1000)}
            onChange={(event) => seekTo(Number(event.target.value) / 1000)}
            aria-label={t('回放进度')}
          />
          <span className="recording-clock">
            {formatClock(elapsedSec)} / {formatClock(totalSec)}
          </span>
        </div>
        {doc.warnings.length > 0 && (
          <p className="section-tip">{t('文件有 {n} 行无法解析，已跳过。').replace('{n}', String(doc.warnings.length))}</p>
        )}
      </div>
    </Modal>
  )
}
