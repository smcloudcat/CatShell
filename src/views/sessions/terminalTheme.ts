import type { ITheme } from '@xterm/xterm'

/** 终端配色（暗色）。由 TerminalPane 与录制回放共享，保证观感一致。 */
export const DARK_TERM_THEME: ITheme = {
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

/** 终端配色（浅色）。 */
export const LIGHT_TERM_THEME: ITheme = {
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
