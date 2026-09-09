import { useEffect, useRef, useState } from 'react'
import { Terminal, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Icon } from '../../components/Icon'
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
  const searchRef = useRef<SearchAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const openSearchRef = useRef<() => void>(() => undefined)

  const registerTerminal = useSessions((s) => s.registerTerminal)
  const unregisterTerminal = useSessions((s) => s.unregisterTerminal)
  const write = useSessions((s) => s.write)
  const resize = useSessions((s) => s.resize)
  const terminal: TerminalSettings = useSettings((s) => s.terminal)
  const effectiveMode = useEffectiveMode()
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const openSearch = () => {
    setSearchValue(termRef.current?.getSelection() || '')
    setSearchOpen(true)
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }
  openSearchRef.current = openSearch

  const closeSearch = () => {
    setSearchOpen(false)
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }

  const runSearch = (direction: 'next' | 'prev', value: string) => {
    const addon = searchRef.current
    const term = termRef.current
    if (!addon || !term) return
    if (!value) {
      addon.clearDecorations()
      return
    }
    const options = {
      caseSensitive: false,
      wholeWord: false,
      decorations: { matchOverviewRuler: 'rgba(56, 189, 248, 0.45)', activeMatchColorOverviewRuler: 'rgba(56, 189, 248, 0.8)' }
    }
    if (direction === 'next') addon.findNext(value, options)
    else addon.findPrevious(value, options)
  }

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
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void openUrl(uri).catch(() => undefined)
      })
    )
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => {
      webgl.dispose()
    })
    try {
      term.loadAddon(webgl)
    } catch {
      // WebGL 不可用时保持 Canvas 渲染回退
    }
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    webglRef.current = webgl
    term.open(container)
    fit.fit()

    // 应用级快捷键（Ctrl+W/T/Tab/1..9）不透传给远端 shell，交由全局处理器处理
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (!event.ctrlKey || event.altKey || event.metaKey) return true
      const key = event.key.toLowerCase()
      if (key === 'f') {
        event.preventDefault()
        event.stopPropagation()
        openSearchRef.current()
        return false
      }
      if (key === 'w' || key === 't' || key === 'tab' || /^[1-9]$/.test(key)) return false
      return true
    })

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
      },
      openSearch: () => openSearchRef.current()
    })

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      dataSubscription.dispose()
      resizeSubscription.dispose()
      webglRef.current?.dispose()
      unregisterTerminal(id)
      term.dispose()
      container.replaceChildren()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      webglRef.current = null
    }
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
      {searchOpen && (
        <div className="terminal-search glass">
          <input
            ref={searchInputRef}
            className="glass-input terminal-search-input"
            placeholder="终端内搜索"
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                runSearch(event.shiftKey ? 'prev' : 'next', searchValue)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                closeSearch()
              }
            }}
          />
          <button className="host-icon-btn" title="上一个 (Shift+Enter)" onClick={() => runSearch('prev', searchValue)}>
            <Icon name="chevron-up" size={14} />
          </button>
          <button className="host-icon-btn" title="下一个 (Enter)" onClick={() => runSearch('next', searchValue)}>
            <Icon name="chevron-down" size={14} />
          </button>
          <button className="host-icon-btn" title="关闭 (Esc)" onClick={closeSearch}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}