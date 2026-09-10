import { useSettings } from '../../store/settings'
import { ColorRow } from './ThemeControls'
import { useT } from '../../i18n'

const ACCENT_SWATCHES = [
  { name: '靛蓝', color: '#6d7cff' },
  { name: '天蓝', color: '#38bdf8' },
  { name: '青碧', color: '#2dd4bf' },
  { name: '翡翠', color: '#34d399' },
  { name: '琥珀', color: '#f59e0b' },
  { name: '玫红', color: '#f472b6' },
  { name: '紫藤', color: '#a78bfa' },
  { name: '石板', color: '#94a3b8' }
]

const TERMINAL_FONT_OPTIONS = [
  { labelKey: 'Consolas（默认）', value: 'Consolas, "Cascadia Mono", "Courier New", monospace' },
  { labelKey: 'Cascadia Mono', value: '"Cascadia Mono", Consolas, "Courier New", monospace' },
  { labelKey: 'Courier New', value: '"Courier New", Consolas, monospace' },
  { labelKey: '系统等宽字体', value: 'ui-monospace, Consolas, "Cascadia Mono", monospace' }
]

export function Appearance() {
  const t = useT()
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const setAppearanceMode = useSettings((s) => s.setAppearanceMode)
  const terminal = useSettings((s) => s.terminal)
  const setTerminal = useSettings((s) => s.setTerminal)
  const saveTerminal = useSettings((s) => s.saveTerminal)

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t('外观')}</div>
      <div className="setting-row">
        <div className="row-label">
          <span>{t('外观模式')}</span>
        </div>
        <div className="seg-group">
          <button
            className={`seg-btn ${theme.mode === 'auto' ? 'active' : ''}`}
            onClick={() => setAppearanceMode('auto')}
          >
            {t('跟随系统')}
          </button>
          <button
            className={`seg-btn ${theme.mode === 'light' ? 'active' : ''}`}
            onClick={() => setAppearanceMode('light')}
          >
            {t('浅色')}
          </button>
          <button
            className={`seg-btn ${theme.mode === 'dark' ? 'active' : ''}`}
            onClick={() => setAppearanceMode('dark')}
          >
            {t('深色')}
          </button>
        </div>
      </div>
      <div className="setting-row">
        <div className="row-label">
          <span>{t('强调色')}</span>
        </div>
        <div className="preset-grid">
          {ACCENT_SWATCHES.map((swatch) => (
            <button
              key={swatch.color}
              className={`preset-item ${theme.accentColor.toLowerCase() === swatch.color.toLowerCase() ? 'active' : ''}`}
              onClick={() => setTheme({ accentColor: swatch.color })}
              title={t(swatch.name)}
            >
              <span className="preset-swatch" style={{ background: swatch.color }} />
              <span className="preset-name">{t(swatch.name)}</span>
            </button>
          ))}
        </div>
      </div>
      <ColorRow
        label={t('自定义强调色')}
        value={theme.accentColor}
        onChange={(v) => setTheme({ accentColor: v })}
      />
      <div className="section-tip">
        {t('深浅模式默认跟随系统外观；强调色将应用于按钮、导航与状态高亮。')}
      </div>
      <div className="setting-row">
        <div className="row-label">
          <span>{t('终端字体')}</span>
        </div>
        <select
          className="glass-input"
          value={terminal.fontFamily}
          onChange={(event) => { setTerminal({ fontFamily: event.target.value }); void saveTerminal() }}
        >
          {TERMINAL_FONT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-row">
        <div className="row-label">
          <span>{t('终端字号')}</span>
        </div>
        <div className="seg-group">
          {[12, 13, 14, 16, 18].map((size) => (
            <button
              key={size}
              className={`seg-btn ${terminal.fontSize === size ? 'active' : ''}`}
              onClick={() => { setTerminal({ fontSize: size }); void saveTerminal() }}
            >
              {size}px
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div className="row-label">
          <span>{t('回滚行数')}</span>
        </div>
        <div className="seg-group">
          {[1000, 5000, 8000, 20000].map((lines) => (
            <button
              key={lines}
              className={`seg-btn ${terminal.scrollback === lines ? 'active' : ''}`}
              onClick={() => { setTerminal({ scrollback: lines }); void saveTerminal() }}
            >
              {lines.toLocaleString()}
            </button>
          ))}
        </div>
      </div>
      <div className="section-tip">
        {t('终端外观立即应用于所有已打开会话；终端配色随深浅模式自动切换。')}
      </div>
    </div>
  )
}