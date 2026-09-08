import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useSessions } from '../../store/sessions'

interface Props {
  id: number
  active: boolean
}

const TERM_OPTIONS = {
  cursorBlink: true,
  fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
  fontSize: 13,
  lineHeight: 1.25,
  scrollback: 8000,
  convertEol: false,
  allowProposedApi: false,
  theme: {
    background: 'rgba(2, 6, 23, 0.35)',
    foreground: '#dbe4f5',
    cursor: '#38bdf8',
    cursorAccent: '#0f172a',
    selectionBackground: 'rgba(56, 189, 248, 0.3)',
    black: '#0f172a',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#e2e8f0',
    brightBlack: '#64748b',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde047',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#f8fafc'
  }
}

export function TerminalPane({ id, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  const registerTerminal = useSessions((s) => s.registerTerminal)
  const unregisterTerminal = useSessions((s) => s.unregisterTerminal)
  const write = useSessions((s) => s.write)
  const resize = useSessions((s) => s.resize)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal(TERM_OPTIONS)
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    fitRef.current = fit
    term.open(container)
    fit.fit()

    const dataSubscription = term.onData((data) => {
      void write(id, new TextEncoder().encode(data)).catch(() => undefined)
    })
    const resizeSubscription = term.onResize(({ cols, rows }) => {
      resize(id, cols, rows)
    })

    const onWindowResize = () => {
      if (activeRef.current) {
        fit.fit()
        resize(id, term.cols, term.rows)
      }
    }
    window.addEventListener('resize', onWindowResize)

    const observer = new ResizeObserver(() => {
      if (activeRef.current) {
        fit.fit()
        resize(id, term.cols, term.rows)
      }
    })
    observer.observe(container)

    registerTerminal({
      id,
      write: (data: Uint8Array) => term.write(data),
      focus: () => term.focus(),
      fit: () => {
        fit.fit()
        resize(id, term.cols, term.rows)
      }
    })

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      dataSubscription.dispose()
      resizeSubscription.dispose()
      unregisterTerminal(id)
      term.dispose()
      container.replaceChildren()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        resize(id, termRef.current?.cols ?? 80, termRef.current?.rows ?? 24)
        termRef.current?.focus()
      })
    }
  }, [active, id, resize])

  return (
    <div className={`terminal-pane glass ${active ? 'active' : ''}`}>
      <div className="terminal-host" ref={containerRef} />
    </div>
  )
}
