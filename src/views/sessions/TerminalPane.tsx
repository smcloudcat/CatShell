import { useEffect, useRef, useState } from 'react'
import { Terminal, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useSessions } from '../../store/sessions'
import { TerminalSettings, useSettings } from '../../store/settings'

interface Props {
  id: number
  active: boolean
}

const BASE_OPTIONS = {
  cursorBlink: true,
  lineHeight: 1.25,
  convertEol: false,
  allowProposedApi: false
}

const DARK_TERM_THEME: ITheme = {
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

const LIGHT_TERM_THEME: ITheme = {
  background: 'rgba(255, 255, 255, 0.55)',
  foreground: '#1e293b',
  cursor: '#2563eb',
  cursorAccent: '#f8fafc',
  selectionBackground: 'rgba(37, 99, 235, 0.25)',
  black: '#1e293b',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#e2e8f0',
  brightBlack: '#64748b',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#f8fafc'
}

function useEffectiveMode(): 'light' | 'dark' {
  const mode = useSettings((state) => state.theme.mode)
  const [systemLight, setSystemLight] = useState(
    () => window.matchMedia('(prefers-color-scheme: light)').matches
  )
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const listener = () => setSystemLight(media.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])
  if (mode === 'auto') return systemLight ? 'light' : 'dark'
  return mode
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
  const terminal: TerminalSettings = useSettings((s) => s.terminal)
  const effectiveMode = useEffectiveMode()

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      ...BASE_OPTIONS,
      fontFamily: terminal.fontFamily,
      fontSize: terminal.fontSize,
      scrollback: terminal.scrollback,
      theme: effectiveMode === 'light' ? LIGHT_TERM_THEME : DARK_TERM_THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    fitRef.current = fit
    term.open(container)
    fit.fit()

    const dataSubscription = term.onData((data) => {
      const bytes = new TextEncoder().encode(data)
      void write(id, bytes).catch(() => undefined)
      const state = useSessions.getState()
      if (!state.broadcastEnabled) return
      for (const target of state.broadcastTargets) {
        if (target === id) continue
        if (state.sessions[target]?.status !== 'connected') continue
        void state.write(target, bytes).catch(() => undefined)
      }
    })
    const resizeSubscription = term.onResize(({ cols, rows }) => {
      resize(id, cols, rows)
    })

    const onWindowResize = () => {
      if (activeRef.current) {
        fit.fit()
      }
    }
    window.addEventListener('resize', onWindowResize)

    const observer = new ResizeObserver(() => {
      if (activeRef.current) {
        fit.fit()
      }
    })
    observer.observe(container)

    registerTerminal({
      id,
      write: (data: Uint8Array) => term.write(data),
      focus: () => term.focus(),
      fit: () => {
        fit.fit()
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
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = terminal.fontFamily
    term.options.fontSize = terminal.fontSize
    term.options.scrollback = terminal.scrollback
    term.options.theme = effectiveMode === 'light' ? LIGHT_TERM_THEME : DARK_TERM_THEME
    fitRef.current?.fit()
  }, [terminal, effectiveMode])

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        termRef.current?.focus()
      })
    }
  }, [active, id])

  return (
    <div className={`terminal-pane glass ${active ? 'active' : ''}`}>
      <div className="terminal-host" ref={containerRef} />
    </div>
  )
}
