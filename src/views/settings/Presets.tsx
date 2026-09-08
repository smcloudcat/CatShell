import { THEME_PRESETS } from '../../types/theme'
import { useSettings } from '../../store/settings'

export function Presets() {
  const activePresetId = useSettings((s) => s.activePresetId)
  const applyPreset = useSettings((s) => s.applyPreset)

  const swatchBg = (p: (typeof THEME_PRESETS)[number]['theme']): string => {
    if (p.backgroundType === 'gradient') {
      return `linear-gradient(${p.gradient.angle}deg, ${p.gradient.from}, ${p.gradient.to})`
    }
    return p.solidColor
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title">主题预设</div>
      <div className="preset-grid">
        {THEME_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className={`preset-item ${activePresetId === preset.id ? 'active' : ''}`}
            onClick={() => applyPreset(preset)}
            title={preset.name}
          >
            <span
              className="preset-swatch"
              style={{ background: swatchBg(preset.theme) }}
            />
            <span className="preset-name">{preset.name}</span>
          </button>
        ))}
      </div>
      <div className="section-tip">调整任一参数将脱离当前预设，可随时重新应用。</div>
    </div>
  )
}