import { Icon } from '../../components/Icon'
import { AuthMethod } from '../../types/session'
import { useT } from '../../i18n'
import { ConnectFormState } from './connectForm'

interface AuthOption {
  value: AuthMethod
  /** i18n 键；`SSH Agent` 是专有名词，保持原样不翻译。 */
  label: string
  translate: boolean
}

const AUTH_OPTIONS: AuthOption[] = [
  { value: 'password', label: '密码', translate: true },
  { value: 'key', label: 'SSH 私钥', translate: true },
  { value: 'agent', label: 'SSH Agent', translate: false },
  { value: 'keyboard-interactive', label: '交互式 2FA', translate: true }
]

interface Props {
  form: ConnectFormState
  set: (patch: Partial<ConnectFormState>) => void
  onPickKey: (target: 'keyPath' | 'proxyKeyPath') => void
}

/**
 * 认证方式选择器与随之变化的凭据字段。
 *
 * 四种认证方式对应的输入差异较大（无输入 / 密码 / 私钥+口令 / 密码+OTP），
 * 集中在一个组件里用条件渲染表达，比在连接对话框主渲染里堆三段 JSX 清晰得多。
 */
export function HostAuthFields({ form, set, onPickKey }: Props) {
  const t = useT()

  return (
    <>
      <div className="field span-2">
        <span className="field-label">{t('认证方式')}</span>
        <div className="seg-group">
          {AUTH_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={`seg-btn ${form.authMethod === option.value ? 'active' : ''}`}
              onClick={() => set({ authMethod: option.value })}
            >
              {option.translate ? t(option.label) : option.label}
            </button>
          ))}
        </div>
      </div>

      {form.authMethod === 'password' && (
        <label className="field span-2">
          <span className="field-label">{t('登录密码')}</span>
          <input
            className="glass-input"
            type="password"
            value={form.password}
            onChange={(e) => set({ password: e.target.value })}
          />
        </label>
      )}

      {form.authMethod === 'agent' && (
        <div className="field span-2">
          <span className="field-label">SSH Agent</span>
          <div className="section-tip">
            {t('Windows 优先尝试 Pageant，其次 OpenSSH agent 命名管道（\\\\.\\pipe\\openssh-ssh-agent）；其他平台读取 SSH_AUTH_SOCK。连接时将逐个尝试 Agent 中的密钥，无需输入口令。')}
          </div>
        </div>
      )}

      {form.authMethod === 'keyboard-interactive' && (
        <>
          <label className="field span-2">
            <span className="field-label">{t('登录密码（服务器要求时填写）')}</span>
            <input
              className="glass-input"
              type="password"
              autoComplete="current-password"
              value={form.password}
              onChange={(e) => set({ password: e.target.value })}
            />
          </label>
          <label className="field span-2">
            <span className="field-label">{t('一次性验证码（留空则连接时弹出交互输入）')}</span>
            <input
              className="glass-input"
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={t('预填后连接时自动应答；留空则逐个提示输入')}
              value={form.otpSecret}
              onChange={(e) => set({ otpSecret: e.target.value })}
            />
          </label>
        </>
      )}

      {form.authMethod === 'key' && (
        <>
          <div className="field span-2">
            <span className="field-label">{t('私钥文件')}</span>
            <div className="key-picker">
              <input
                className="glass-input"
                readOnly
                placeholder={t('未选择私钥')}
                value={form.keyPath}
                onDoubleClick={() => onPickKey('keyPath')}
              />
              <button className="glass-btn" onClick={() => onPickKey('keyPath')} type="button">
                <Icon name="folder" size={14} />
                {t('选择')}
              </button>
            </div>
          </div>
          <label className="field span-2">
            <span className="field-label">{t('私钥口令（可选）')}</span>
            <input
              className="glass-input"
              type="password"
              placeholder={t('无口令可留空')}
              value={form.passphrase}
              onChange={(e) => set({ passphrase: e.target.value })}
            />
          </label>
        </>
      )}
    </>
  )
}
