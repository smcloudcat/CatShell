import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Icon } from '../../components/Icon'
import { getSessionLog, useSessions } from '../../store/sessions'
import { TerminalSettings, useSettings } from '../../store/settings'
import { TerminalLineGuard, type GuardDecision } from '../../utils/lineGuard'
import { TerminalAiPopover } from './TerminalAiPopover'
import { useT } from '../../i18n'
import { DARK_TERM_THEME, LIGHT_TERM_THEME } from './terminalTheme'

interface Props {
  id: number
  active: boolean
  /** 分屏角色：left/right 时在分屏布局中始终可见并接受输入 */
  splitRole?: 'none' | 'left' | 'right'
}

const BASE_OPTIONS = {
  cursorBlink: true,
  lineHeight: 1.25,
  convertEol: false,
  allowProposedApi: false
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

export function TerminalPane({ id, active, splitRole = 'none' }: Props) {
  const t = useT()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const splitRoleRef = useRef(splitRole)
  splitRoleRef.current = splitRole
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
  const [hold, setHold] = useState<GuardDecision | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiSelection, setAiSelection] = useState('')
  const riskGuardEnabled = useSettings((s) => s.ai.riskGuard)
  const riskGuardRef = useRef(riskGuardEnabled)
  riskGuardRef.current = riskGuardEnabled
  const guardRef = useRef<TerminalLineGuard | null>(null)
  const sendRef = useRef<(text: string) => void>(() => undefined)

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

    // 行守卫（6.17 风险提示）：Enter 前分析缓冲行，高危命令扣下待确认。
    const guard = new TerminalLineGuard()
    guardRef.current = guard
    const send = (text: string) => {
      const bytes = new TextEncoder().encode(text)
      void write(id, bytes).catch(() => undefined)
      const state = useSessions.getState()
      if (!state.broadcastEnabled) return
      for (const target of state.broadcastTargets) {
        if (target === id) continue
        if (state.sessions[target]?.status !== 'connected') continue
        void state.write(target, bytes).catch(() => undefined)
      }
    }
    sendRef.current = send
    const dataSubscription = term.onData((data) => {
      if (!riskGuardRef.current) {
        send(data)
        return
      }
      const { passthrough, held } = guard.feed(data)
      if (passthrough) send(passthrough)
      if (held) setHold(held)
    })
    const resizeSubscription = term.onResize(({ cols, rows }) => {
      resize(id, cols, rows)
    })

    const onWindowResize = () => {
      if (activeRef.current || splitRoleRef.current !== 'none') {
        fit.fit()
      }
    }
    window.addEventListener('resize', onWindowResize)

    const observer = new ResizeObserver(() => {
      if (activeRef.current || splitRoleRef.current !== 'none') {
        fit.fit()
      }
    })
    observer.observe(container)

    // 会话在未挂载期间（切到其他标签时）仍会持续输出并累积到会话日志。
    // 取快照与注册必须同步完成：二者之间没有 await，事件回调无法插入，
    // 因此不会出现「重复写入」或「丢帧」。
    const history = getSessionLog(id)

    registerTerminal({
      id,
      write: (data: Uint8Array) => term.write(data),
      focus: () => term.focus(),
      fit: () => {
        fit.fit()
      },
      openSearch: () => openSearchRef.current(),
      getSize: () => ({ cols: term.cols, rows: term.rows })
    })

    if (history.length) {
      term.write(history)
    }

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      guardRef.current = null
      sendRef.current = () => undefined
      setHold(null)
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
    <div
      className={`terminal-pane glass ${active ? 'active' : ''} ${splitRole !== 'none' ? `split-${splitRole}` : ''}`}
    >
      <div className="terminal-host" ref={containerRef} />
      <button
        className="terminal-ai-btn"
        title={t('AI 助手：生成命令 / 诊断日志')}
        onClick={() => {
          setAiSelection(termRef.current?.getSelection() || '')
          setAiOpen((open) => !open)
        }}
      >
        <Icon name="sparkles" size={14} />
      </button>
      {aiOpen && (
        <TerminalAiPopover
          selection={aiSelection}
          onInsertCommand={(command) => sendRef.current(command)}
          onClose={() => setAiOpen(false)}
        />
      )}
      {hold && (
        <div className="terminal-risk glass">
          <div className="terminal-risk-head">
            <Icon name="sparkles" size={14} /> {t('检测到高危命令')}
          </div>
          <code className="terminal-risk-cmd">{hold.line}</code>
          <ul className="terminal-risk-reasons">
            {hold.risks.map((risk) => (
              <li key={risk.id}>{risk.reason}</li>
            ))}
          </ul>
          <div className="terminal-risk-actions">
            <button
              className="glass-btn sftp-queue-btn"
              onClick={() => {
                setHold(null)
                sendRef.current('\r')
              }}
            >
              {t('仍要执行')}
            </button>
            <button
              className="glass-btn sftp-queue-btn"
              onClick={() => {
                setHold(null)
                sendRef.current('\x03')
              }}
            >
              {t('取消（发送 Ctrl+C）')}
            </button>
          </div>
        </div>
      )}
      {searchOpen && (
        <div className="terminal-search glass">
          <input
            ref={searchInputRef}
            className="glass-input terminal-search-input"
            placeholder={t('终端内搜索')}
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
          <button className="host-icon-btn" title={t('上一个 (Shift+Enter)')} onClick={() => runSearch('prev', searchValue)}>
            <Icon name="chevron-up" size={14} />
          </button>
          <button className="host-icon-btn" title={t('下一个 (Enter)')} onClick={() => runSearch('next', searchValue)}>
            <Icon name="chevron-down" size={14} />
          </button>
          <button className="host-icon-btn" title={`${t('关闭')} (Esc)`} onClick={closeSearch}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}