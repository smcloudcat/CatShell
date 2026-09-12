import { ThemeConfig, normalizeBackgroundImagePath } from '../../types/theme'
import { ColorRow, SegRow, SliderRow } from './ThemeControls'
import { useT } from '../../i18n'
import { allowAssetFile } from '../../api/ssh'
import { showToast } from '../../store/ui'

interface Props {
  theme: ThemeConfig
  setTheme: (patch: Partial<ThemeConfig>) => void
}

export function ThemeParams({ theme, setTheme }: Props) {
  const t = useT()
  return (
    <div className="settings-section">
      <div className="settings-section-title">{t('界面质感')}</div>
      <SliderRow
        label={t('卡片不透明度')}
        value={theme.bgOpacity}
        min={0.1}
        max={1}
        step={0.05}
        onChange={(v) => setTheme({ bgOpacity: v })}
      />
      <SliderRow
        label={t('模糊强度')}
        value={theme.blurRadius}
        min={2}
        max={20}
        unit="px"
        onChange={(v) => setTheme({ blurRadius: v })}
      />
      <SliderRow
        label={t('圆角大小')}
        value={theme.borderRadius}
        min={0}
        max={24}
        unit="px"
        onChange={(v) => setTheme({ borderRadius: v })}
      />
      <SliderRow
        label={t('描边透明度')}
        value={theme.borderOpacity}
        min={0.05}
        max={0.4}
        step={0.01}
        onChange={(v) => setTheme({ borderOpacity: v })}
      />

      <div className="settings-section-title">{t('背景')}</div>
      <SegRow
        label={t('背景类型')}
        value={theme.backgroundType}
        options={[
          { value: 'gradient', label: t('渐变') },
          { value: 'solid', label: t('纯色') },
          { value: 'image', label: t('图片') }
        ]}
        onChange={(v) => setTheme({ backgroundType: v })}
      />
      {theme.backgroundType === 'gradient' && (
        <>
          <ColorRow
            label={t('渐变起色')}
            value={theme.gradient.from}
            onChange={(v) => setTheme({ gradient: { ...theme.gradient, from: v } })}
          />
          <ColorRow
            label={t('渐变止色')}
            value={theme.gradient.to}
            onChange={(v) => setTheme({ gradient: { ...theme.gradient, to: v } })}
          />
          <SliderRow
            label={t('渐变角度')}
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
          label={t('背景颜色')}
          value={theme.solidColor}
          onChange={(v) => setTheme({ solidColor: v })}
        />
      )}
      {theme.backgroundType === 'image' && (
        <div className="section-tip">
          {t('自定义图片：')}
          <button className="seg-btn" onClick={() => void pickImage(setTheme, t)}>
            {t('选择图片…')}
          </button>
          {theme.backgroundImage && (
            <div style={{ marginTop: 8 }}>
              {t('已选择：')}<code>{theme.backgroundImage}</code>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

async function pickImage(setTheme: Props['setTheme'], t: ReturnType<typeof useT>) {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const file = await open({
      multiple: false,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]
    })
    if (typeof file === 'string') {
      // 反斜杠路径过不了 CSS/校验（见 normalizeBackgroundImagePath），存储前统一转正斜杠。
      const imagePath = normalizeBackgroundImagePath(file)
      // assetProtocol scope 为空：这张图需要单独授权，否则预览与主界面都加载不出来（审计 S-2）。
      try {
        await allowAssetFile(imagePath)
      } catch {
        showToast(t('背景图片授权失败，可能无法显示'), 'error')
      }
      setTheme({ backgroundImage: imagePath })
    }
  } catch {
    // 非 Tauri 环境或文件选择器不可用时给出明确反馈，而不是未处理的 Promise（审计 R-9）。
    showToast(t('无法打开文件选择器'), 'error')
  }
}
