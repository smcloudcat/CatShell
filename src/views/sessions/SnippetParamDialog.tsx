import { useT } from '../../i18n'
import {
  CommandSnippet,
  getSnippetParameters,
  renderCommandTemplate
} from '../../types/snippet'
import { SessionDialog } from './SessionDialog'

interface Props {
  snippet: CommandSnippet
  values: Record<string, string>
  onChange: (values: Record<string, string>) => void
  onClose: () => void
  onSubmit: () => void
}

/**
 * 带占位符的命令片段参数填写弹窗。
 * 底部实时渲染最终命令，让用户在发送前确认转义结果。
 */
export function SnippetParamDialog({ snippet, values, onChange, onClose, onSubmit }: Props) {
  const t = useT()
  const parameters = getSnippetParameters(snippet.command)

  return (
    <SessionDialog
      title={t('填写命令参数')}
      icon="terminal"
      ariaLabel={t('填写命令参数')}
      className="snippet-prompt-modal"
      onClose={onClose}
      footer={
        <>
          <button className="glass-btn" onClick={onClose}>{t('取消')}</button>
          <button className="glass-btn primary" onClick={onSubmit}>{t('发送命令')}</button>
        </>
      }
    >
      <div className="section-tip">{t('模板：')}{snippet.name}{t('。参数会作为独立 Shell 参数转义。')}</div>
      {parameters.map((name, index) => (
        <label className="field" key={name}>
          <span className="field-label">{name}</span>
          <input
            className="glass-input"
            value={values[name] ?? ''}
            onChange={(event) => onChange({ ...values, [name]: event.target.value })}
            autoFocus={index === 0}
          />
        </label>
      ))}
      <div className="snippet-rendered-command">
        <span>{t('发送预览')}</span>
        <code>{renderCommandTemplate(snippet.command, values)}</code>
      </div>
    </SessionDialog>
  )
}
