import { Icon } from '../../components/Icon'
import { HOST_ICON_OPTIONS, HostIconName } from '../../types/host'
import { useT } from '../../i18n'

interface Props {
  value: HostIconName
  onChange: (icon: HostIconName) => void
}

/** 主机图标选择器：一排内置图标，点击即选中。 */
export function HostIconPicker({ value, onChange }: Props) {
  const t = useT()
  return (
    <div className="field span-2">
      <span className="field-label">{t('图标')}</span>
      <div className="icon-picker">
        {HOST_ICON_OPTIONS.map((name) => (
          <button
            key={name}
            type="button"
            className={`icon-option ${value === name ? 'active' : ''}`}
            onClick={() => onChange(name)}
            title={name}
          >
            <Icon name={name} size={17} />
          </button>
        ))}
      </div>
    </div>
  )
}
