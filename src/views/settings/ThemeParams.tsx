import { ThemeConfig } from '../../types/theme'
import { ColorRow, SegRow, SliderRow } from './ThemeControls'

interface Props {
  theme: ThemeConfig
  setTheme: (patch: Partial<ThemeConfig>) => void
}

export function ThemeParams({ theme, setTheme }: Props) {
  return (
    <div className="settings-section">
      <div className="settings-section-title">界面质感</div>
      <SliderRow
        label="卡片不透明度"
        value={theme.bgOpacity}
        min={0.1}
        max={1}
        step={0.05}
        onChange={(v) => setTheme({ bgOpacity: v })}
      />
      <SliderRow
        label="模糊强度"
        value={theme.blurRadius}
        min={2}
        max={20}
        unit="px"
        onChange={(v) => setTheme({ blurRadius: v })}
      />
      <SliderRow
        label="圆角大小"
        value={theme.borderRadius}
        min={0}
        max={24}
        unit="px"
        onChange={(v) => setTheme({ borderRadius: v })}
      />
      <SliderRow
        label="描边透明度"
        value={theme.borderOpacity}
        min={0.05}
        max={0.4}
        step={0.01}
        onChange={(v) => setTheme({ borderOpacity: v })}
      />

      <div className="settings-section-title">背景</div>
      <SegRow
        label="背景类型"
        value={theme.backgroundType}
        options={[
          { value: 'gradient', label: '渐变' },
          { value: 'solid', label: '纯色' },
          { value: 'image', label: '图片' }
        ]}
        onChange={(v) => setTheme({ backgroundType: v })}
      />
      {theme.backgroundType === 'gradient' && (
        <>
          <ColorRow
            label="渐变起色"
            value={theme.gradient.from}
            onChange={(v) => setTheme({ gradient: { ...theme.gradient, from: v } })}
          />
          <ColorRow
            label="渐变止色"
            value={theme.gradient.to}
            onChange={(v) => setTheme({ gradient: { ...theme.gradient, to: v } })}
          />
          <SliderRow
            label="渐变角度"
            value={theme.gradient.angle}
            min={0}
            max={360}
            unit="°"
            onChange={(v) => setTheme({ gradient: { ...theme.gradient, angle: v } })}
          />
        </>
      )}
      {theme.backgroundType === 'solid' && (
        <ColorRow
          label="背景颜色"
          value={theme.solidColor}
          onChange={(v) => setTheme({ solidColor: v })}
        />
      )}
      {theme.backgroundType === 'image' && (
        <div className="section-tip">
          自定义图片：
          <button className="seg-btn" onClick={() => pickImage(setTheme)}>
            选择图片…
          </button>
          {theme.backgroundImage && (
            <div style={{ marginTop: 8 }}>
              已选择：<code>{theme.backgroundImage}</code>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

async function pickImage(setTheme: Props['setTheme']) {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const file = await open({
    multiple: false,
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]
  })
  if (typeof file === 'string') {
    setTheme({ backgroundImage: file })
  }
}