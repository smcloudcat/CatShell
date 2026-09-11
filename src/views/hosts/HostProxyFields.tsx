import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { MAX_PROXY_HOPS } from '../../types/session'
import { ConnectFormState, ProxyFormHop, emptyProxyHop } from './connectForm'

interface Props {
  form: ConnectFormState
  set: (patch: Partial<ConnectFormState>) => void
  onPickKey: (target: string) => void
}

/** 第 1 跳（平铺字段）的 key 目标名。 */
const FIRST_HOP_KEY_TARGET = 'proxyKeyPath'

/**
 * 单级跳板的字段组：目标主机信息 + 认证方式。第 1 跳与后续跳共用，
 * 通过 getter/setter 适配两种存储形态（平铺字段 / 数组元素）。
 */
function HopFields({
  t,
  label,
  hop,
  onChange,
  onPickKey,
  keyTarget
}: {
  t: (key: string) => string
  label: string
  hop: { host: string; port: string; username: string; authMethod: 'password' | 'key'; password: string; keyPath: string; passphrase: string }
  onChange: (patch: Partial<ProxyFormHop>) => void
  onPickKey: (target: string) => void
  keyTarget: string
}) {
  return (
    <>
      <div className="field span-2">
        <span className="field-label">{label}</span>
      </div>
      <label className="field">
        <span className="field-label">{t('跳板机地址')}</span>
        <input
          className="glass-input"
          placeholder={t('例如 bastion.corp')}
          value={hop.host}
          onChange={(e) => onChange({ host: e.target.value })}
        />
      </label>
      <label className="field">
        <span className="field-label">{t('跳板机端口')}</span>
        <input
          className="glass-input"
          type="number"
          min={1}
          max={65535}
          value={hop.port}
          onChange={(e) => onChange({ port: e.target.value })}
        />
      </label>
      <label className="field">
        <span className="field-label">{t('跳板机用户名')}</span>
        <input
          className="glass-input"
          placeholder="root"
          value={hop.username}
          onChange={(e) => onChange({ username: e.target.value })}
        />
      </label>
      <div className="field">
        <span className="field-label">{t('跳板机认证')}</span>
        <div className="seg-group">
          <button
            className={`seg-btn ${hop.authMethod === 'password' ? 'active' : ''}`}
            onClick={() => onChange({ authMethod: 'password' })}
          >
            {t('密码')}
          </button>
          <button
            className={`seg-btn ${hop.authMethod === 'key' ? 'active' : ''}`}
            onClick={() => onChange({ authMethod: 'key' })}
          >
            {t('私钥')}
          </button>
        </div>
      </div>

      {hop.authMethod === 'password' ? (
        <label className="field">
          <span className="field-label">{t('跳板机密码')}</span>
          <input
            className="glass-input"
            type="password"
            value={hop.password}
            onChange={(e) => onChange({ password: e.target.value })}
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
              value={hop.keyPath}
              onDoubleClick={() => onPickKey(keyTarget)}
            />
            <button className="glass-btn" onClick={() => onPickKey(keyTarget)} type="button">
              <Icon name="folder" size={14} />
              {t('选择')}
            </button>
          </div>
        </div>
      )}

      {hop.authMethod === 'key' && (
        <label className="field">
          <span className="field-label">{t('跳板机私钥口令（可选）')}</span>
          <input
            className="glass-input"
            type="password"
            value={hop.passphrase}
            onChange={(e) => onChange({ passphrase: e.target.value })}
          />
        </label>
      )}
    </>
  )
}

/**
 * 跳板机（ProxyJump）字段组：开关 + 跳板链。
 *
 * 第 1 跳沿用平铺的 proxy* 表单字段（兼容旧数据），第 2 跳起编辑
 * `proxyNextHops` 数组，最多 MAX_PROXY_HOPS 级。连接时逐级经
 * direct-tcpip 隧道穿链到达目标。
 */
export function HostProxyFields({ form, set, onPickKey }: Props) {
  const t = useT()

  const updateHop = (index: number, patch: Partial<ProxyFormHop>) => {
    set({
      proxyNextHops: form.proxyNextHops.map((hop, i) => (i === index ? { ...hop, ...patch } : hop))
    })
  }

  const firstHop = {
    host: form.proxyHost,
    port: form.proxyPort,
    username: form.proxyUsername,
    authMethod: form.proxyAuthMethod,
    password: form.proxyPassword,
    keyPath: form.proxyKeyPath,
    passphrase: form.proxyPassphrase
  }
  const setFirst = (patch: Partial<ProxyFormHop>) => {
    const mapped: Partial<ConnectFormState> = {}
    if ('host' in patch) mapped.proxyHost = patch.host
    if ('port' in patch) mapped.proxyPort = patch.port
    if ('username' in patch) mapped.proxyUsername = patch.username
    if ('authMethod' in patch) mapped.proxyAuthMethod = patch.authMethod
    if ('password' in patch) mapped.proxyPassword = patch.password
    if ('keyPath' in patch) mapped.proxyKeyPath = patch.keyPath
    if ('passphrase' in patch) mapped.proxyPassphrase = patch.passphrase
    set(mapped)
  }

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
          <HopFields
            t={t}
            label={t('第 1 跳')}
            hop={firstHop}
            onChange={setFirst}
            onPickKey={onPickKey}
            keyTarget={FIRST_HOP_KEY_TARGET}
          />

          {form.proxyNextHops.map((hop, index) => (
            <HopFields
              key={index}
              t={t}
              label={`${t('跳板')} #${index + 2}`}
              hop={hop}
              onChange={(patch) => updateHop(index, patch)}
              onPickKey={onPickKey}
              keyTarget={`proxyHopKeyPath:${index}`}
            />
          ))}

          <div className="field span-2 proxy-hop-actions">
            <button
              className="glass-btn"
              type="button"
              disabled={form.proxyNextHops.length >= MAX_PROXY_HOPS - 1}
              onClick={() => set({ proxyNextHops: [...form.proxyNextHops, emptyProxyHop()] })}
            >
              <Icon name="plus" size={14} />
              {t('添加下一跳')}
            </button>
            {form.proxyNextHops.length > 0 && (
              <button
                className="glass-btn"
                type="button"
                onClick={() => set({ proxyNextHops: form.proxyNextHops.slice(0, -1) })}
              >
                <Icon name="x" size={14} />
                {t('移除末跳')}
              </button>
            )}
          </div>

          <div className="field span-2">
            <div className="section-tip">
              {t('连接时按顺序逐级穿过跳板链（每级经 direct-tcpip 隧道到下一级），最后到达目标主机；各跳的主机指纹分别确认、凭据各自独立，不写入主机配置。')}
            </div>
          </div>
        </>
      )}
    </>
  )
}
