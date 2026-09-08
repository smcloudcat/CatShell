import { useSettings } from '../../store/settings'
import { ColorRow } from './ThemeControls'

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

export function Appearance() {
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const setAppearanceMode = useSettings((s) => s.setAppearanceMode)

  return (
    <div className="settings-section">
      <div className="settings-section-title">外观</div>
      <div className="setting-row">
        <div className="row-label">
          <span>外观模式</span>
        </div>
        <div className="seg-group">
          <button
            className={`seg-btn ${theme.mode === 'auto' ? 'active' : ''}`}
            onClick={() => setAppearanceMode('auto')}
          >
            跟随系统
          </button>
          <button
            className={`seg-btn ${theme.mode === 'light' ? 'active' : ''}`}
            onClick={() => setAppearanceMode('light')}
          >
            浅色
          </button>
          <button
            className={`seg-btn ${theme.mode === 'dark' ? 'active' : ''}`}
            onClick={() => setAppearanceMode('dark')}
          >
            深色
          </button>
        </div>
      </div>
      <div className="setting-row">
        <div className="row-label">
          <span>强调色</span>
        </div>
        <div className="preset-grid">
          {ACCENT_SWATCHES.map((swatch) => (
            <button
              key={swatch.color}
              className={`preset-item ${theme.accentColor.toLowerCase() === swatch.color.toLowerCase() ? 'active' : ''}`}
              onClick={() => setTheme({ accentColor: swatch.color })}
              title={swatch.name}
            >
              <span className="preset-swatch" style={{ background: swatch.color }} />
              <span className="preset-name">{swatch.name}</span>
            </button>
          ))}
        </div>
      </div>
      <ColorRow
        label="自定义强调色"
        value={theme.accentColor}
        onChange={(v) => setTheme({ accentColor: v })}
      />
      <div className="section-tip">
        深浅模式默认跟随系统外观；强调色将应用于按钮、导航与状态高亮。
      </div>
    </div>
  )
}