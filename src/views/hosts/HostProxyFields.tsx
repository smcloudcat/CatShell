import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { ConnectFormState } from './connectForm'

interface Props {
  form: ConnectFormState
  set: (patch: Partial<ConnectFormState>) => void
  onPickKey: (target: 'keyPath' | 'proxyKeyPath') => void
}

/**
 * 跳板机（ProxyJump）字段组。
 *
 * 主体是「开关 + 目标主机信息 + 认证方式」三块，与目标主机字段结构相似但
 * 语义不同（跳板机不支持 Agent / 键盘交互），因此单独成组件而不是复用。
 */
export function HostProxyFields({ form, set, onPickKey }: Props) {
  const t = useT()

  return (
    <>
      <label className="field checkbox-field">
        <span className="field-label">{t('跳板机（ProxyJump）')}</span>
        <input
          type="checkbox"
          checked={form.proxyEnabled}
          onChange={(e) => set({ proxyEnabled: e.target.checked })}
        />
      </label>

      {form.proxyEnabled && (
        <>
          <label className="field">
            <span className="field-label">{t('跳板机地址')}</span>
            <input
              className="glass-input"
              placeholder={t('例如 bastion.corp')}
              value={form.proxyHost}
              onChange={(e) => set({ proxyHost: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('跳板机端口')}</span>
            <input
              className="glass-input"
              type="number"
              min={1}
              max={65535}
              value={form.proxyPort}
              onChange={(e) => set({ proxyPort: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('跳板机用户名')}</span>
            <input
              className="glass-input"
              placeholder="root"
              value={form.proxyUsername}
              onChange={(e) => set({ proxyUsername: e.target.value })}
            />
          </label>
          <div className="field">
            <span className="field-label">{t('跳板机认证')}</span>
            <div className="seg-group">
              <button
                className={`seg-btn ${form.proxyAuthMethod === 'password' ? 'active' : ''}`}
                onClick={() => set({ proxyAuthMethod: 'password' })}
              >
                {t('密码')}
              </button>
              <button
                className={`seg-btn ${form.proxyAuthMethod === 'key' ? 'active' : ''}`}
                onClick={() => set({ proxyAuthMethod: 'key' })}
              >
                {t('私钥')}
              </button>
            </div>
          </div>

          {form.proxyAuthMethod === 'password' ? (
            <label className="field">
              <span className="field-label">{t('跳板机密码')}</span>
              <input
                className="glass-input"
                type="password"
                value={form.proxyPassword}
                onChange={(e) => set({ proxyPassword: e.target.value })}
              />
            </label>
          ) : (
            <div className="field">
              <span className="field-label">{t('跳板机私钥')}</span>
              <div className="key-picker">
                <input
                  className="glass-input"
                  readOnly
                  placeholder={t('未选择私钥')}
                  value={form.proxyKeyPath}
                  onDoubleClick={() => onPickKey('proxyKeyPath')}
                />
                <button className="glass-btn" onClick={() => onPickKey('proxyKeyPath')} type="button">
                  <Icon name="folder" size={14} />
                  {t('选择')}
                </button>
              </div>
            </div>
          )}

          {form.proxyAuthMethod === 'key' && (
            <label className="field">
              <span className="field-label">{t('跳板机私钥口令（可选）')}</span>
              <input
                className="glass-input"
                type="password"
                value={form.proxyPassphrase}
                onChange={(e) => set({ proxyPassphrase: e.target.value })}
              />
            </label>
          )}

          <div className="field span-2">
            <div className="section-tip">
              {t('连接时先登录跳板机，再经其 direct-tcpip 隧道连接目标主机；目标与跳板机的主机指纹分别确认。跳板机凭据与登录密码同等对待，不写入主机配置。')}
            </div>
          </div>
        </>
      )}
    </>
  )
}
