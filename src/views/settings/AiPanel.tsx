import { useState } from 'react'

import { Icon } from '../../components/Icon'
import { useSettings, type AiSettings } from '../../store/settings'
import { useT } from '../../i18n'

/** 设置 → AI 助手：OpenAI 兼容接口配置 + 终端风险守卫开关。 */
export function AiPanel() {
  const t = useT()
  const ai: AiSettings = useSettings((s) => s.ai)
  const setAi = useSettings((s) => s.setAi)
  const saveAi = useSettings((s) => s.saveAi)
  const [saved, setSaved] = useState(false)

  const update = (patch: Partial<AiSettings>) => {
    setAi(patch)
    setSaved(false)
  }

  const save = async () => {
    await saveAi()
    setSaved(true)
  }

  return (
    <div className="settings-section glass aipanel">
      <h3>
        <Icon name="sparkles" size={15} /> {t('AI 助手')}
      </h3>
      <p className="settings-hint">
        {t('配置任意 OpenAI 兼容接口（终端页「AI」按钮的命令生成与日志诊断走此配置）。密钥只保存在本机配置文件，随请求直连你填写的接口；CatShell 不内置任何模型服务。')}
      </p>
      <label className="settings-row">
        <span>{t('接口地址')}</span>
        <input
          className="glass-input"
          value={ai.endpoint}
          placeholder="https://api.openai.com/v1"
          onChange={(event) => update({ endpoint: event.target.value })}
        />
      </label>
      <label className="settings-row">
        <span>{t('API 密钥')}</span>
        <input
          className="glass-input"
          type="password"
          value={ai.apiKey}
          placeholder={t('sk-…（留空则请求不带认证头）')}
          onChange={(event) => update({ apiKey: event.target.value })}
        />
      </label>
      <label className="settings-row">
        <span>{t('模型')}</span>
        <input
          className="glass-input"
          value={ai.model}
          placeholder="gpt-4o-mini"
          onChange={(event) => update({ model: event.target.value })}
        />
      </label>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={ai.riskGuard}
          onChange={(event) => {
            update({ riskGuard: event.target.checked })
            void saveAi()
          }}
        />
        <span>{t('终端高危命令执行前弹窗确认（本地规则，无需接口）')}</span>
      </label>
      <div className="aipanel-actions">
        <button className="glass-btn" onClick={() => void save()}>
          <Icon name="save" size={14} /> {t('保存 AI 配置')}
        </button>
        {saved && <span className="aipanel-saved">{t('已保存')}</span>}
      </div>
    </div>
  )
}
