import { Icon } from '../../components/Icon'
import { useSessionRestore } from '../../store/sessionRestore'
import { showToast } from '../../store/ui'
import { useT } from '../../i18n'

/**
 * 会话页空态的「恢复上次会话」入口。
 * 只有存在可恢复记录（上次退出时留着标签）时才渲染；恢复结果逐类反馈。
 */
export function RestoreLastTabsActions() {
  const t = useT()
  const lastTabs = useSessionRestore((s) => s.lastTabs)
  const restoring = useSessionRestore((s) => s.restoring)
  const restore = useSessionRestore((s) => s.restoreLastTabs)
  if (!lastTabs.length) return null

  const handleRestore = () => {
    void restore().then((result) => {
      if (result.restored > 0) {
        showToast(t('已恢复 {n} 个会话').replace('{n}', String(result.restored)), 'success')
      } else if (result.missingHost === 0 && result.missingCredential === 0) {
        showToast(t('会话恢复失败，请从主机页手动连接'), 'error')
      }
      if (result.missingCredential > 0) {
        showToast(
          t('{n} 个会话缺少凭据，请在主机页手动连接').replace('{n}', String(result.missingCredential)),
          'warning'
        )
      }
      if (result.missingHost > 0) {
        showToast(
          t('{n} 个会话对应的主机配置已不存在，已跳过').replace('{n}', String(result.missingHost)),
          'warning'
        )
      }
    })
  }

  return (
    <button className="glass-btn primary" onClick={handleRestore} disabled={restoring}>
      <Icon name="clock" size={16} />
      {restoring ? t('正在恢复会话…') : `${t('恢复上次会话')}（${lastTabs.length}）`}
    </button>
  )
}
