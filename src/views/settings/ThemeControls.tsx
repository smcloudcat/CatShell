interface SliderRowProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
}

export function SliderRow({ label, value, min, max, step = 1, unit = '', onChange }: SliderRowProps) {
  return (
    <div className="setting-row">
      <div className="row-label">
        <span>{label}</span>
        <span className="setting-value">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

interface ColorRowProps {
  label: string
  value: string
  onChange: (v: string) => void
}

export function ColorRow({ label, value, onChange }: ColorRowProps) {
  return (
    <div className="setting-row">
      <div className="row-label">
        <span>{label}</span>
      </div>
      <div className="color-input">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        <code>{value}</code>
      </div>
    </div>
  )
}

interface SegRowProps<T extends string> {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}

export function SegRow<T extends string>({ label, value, options, onChange }: SegRowProps<T>) {
  return (
    <div className="setting-row">
      <div className="row-label">
        <span>{label}</span>
      </div>
      <div className="seg-group">
        {options.map((opt) => (
          <button
            key={opt.value}
            className={`seg-btn ${value === opt.value ? 'active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}