import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { showToast } from '../../store/ui'

const BLOG_URL = 'https://lwcat.cn'
const CONTACT_EMAIL = 'yuncat@email.lwcat.cn'

/** 设置 → 关于：版本信息、作者主页/邮箱与使用协议。 */
export function AboutPanel() {
  const t = useT()
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null))
  }, [])

  /**
   * 打开外链 / 写邮件。失败不能静默吞掉（审计 P-5）：系统未注册 `mailto:`、
   * opener 权限被拒或外部浏览器不可用时，用户点了「毫无反应」根本无从排查。
   */
  const open = (url: string) => {
    openUrl(url).catch((err: unknown) => {
      showToast(errorText(err, t, '打开链接失败'), 'error')
    })
  }

  return (
    <div className="settings-section about-panel">
      <div className="about-brand">
        <div className="sidebar-logo">
          <Icon name="terminal" size={21} />
        </div>
        <div>
          <div className="about-name">CatShell</div>
          <div className="about-version">{version ? `v${version}` : t('桌面 SSH 运维工具')}</div>
        </div>
      </div>

      <div className="settings-section-title">{t('联系与主页')}</div>
      <div className="panel-row">
        <div className="panel-copy">
          <div className="panel-title">{t('作者博客')}</div>
          <div className="panel-desc">{BLOG_URL}</div>
        </div>
        <button className="glass-btn" onClick={() => open(BLOG_URL)}>
          <Icon name="arrow-right" size={14} />
          {t('打开')}
        </button>
      </div>
      <div className="panel-row">
        <div className="panel-copy">
          <div className="panel-title">{t('联系邮箱')}</div>
          <div className="panel-desc">{CONTACT_EMAIL}</div>
        </div>
        <button className="glass-btn" onClick={() => open(`mailto:${CONTACT_EMAIL}`)}>
          <Icon name="arrow-right" size={14} />
          {t('写邮件')}
        </button>
      </div>

      <div className="settings-section-title">{t('使用协议')}</div>
      <div className="about-terms">
        <p>{t('1. CatShell 是一款本地 SSH 运维工具，按「现状」提供，不附带任何明示或暗示的担保。')}</p>
        <p>{t('2. 主机信息与凭据仅保存在本机设备；请自行妥善保管密码、私钥与自动锁定设置。')}</p>
        <p>{t('3. 不得利用本软件从事任何违反法律法规或侵害他人权益的行为；对远端服务器执行的任何操作由使用者自行承担后果。')}</p>
        <p>{t('4. 继续使用本软件即表示已阅读并同意以上条款。')}</p>
      </div>
    </div>
  )
}
