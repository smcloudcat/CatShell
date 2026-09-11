import { HostProfile } from '../types/host'
import { buildRequestFromProfile, profileHasAuth } from '../utils/sessionRestore'
import { logger } from '../utils/logger'
import { recordAudit } from './audit'
import { useSessions } from './sessions'
import { useVault } from './vault'
import { requestVaultUnlock } from './ui'

export type QuickConnectResult = 'connected' | 'needs-form'

/**
 * 从主机配置一键连接（主机列表快速连接、命令面板共用）。
 *
 * 保险箱锁定时先请求解锁；凭据不足以直连时返回 'needs-form'，
 * 由调用方决定打开连接对话框还是跳转到主机页。
 */
export async function connectHostQuick(host: HostProfile): Promise<QuickConnectResult> {
  const vault = useVault.getState()
  const needsVault =
    host.authMethod === 'password' ||
    host.authMethod === 'keyboard-interactive' ||
    host.authMethod === 'key' ||
    (host.proxy.enabled && (host.proxy.authMethod === 'password' || host.proxy.authMethod === 'key'))
  if (vault.configured && !vault.unlocked && needsVault) {
    if (!(await requestVaultUnlock())) return 'needs-form'
  }
  const unlocked = useVault.getState().unlocked
  const credential = unlocked ? useVault.getState().getCredential(host.id) : null
  const proxyCredential =
    host.proxy.enabled && unlocked ? useVault.getState().getCredential(`proxy:${host.id}`) : null
  if (!profileHasAuth(host, credential)) return 'needs-form'
  const request = buildRequestFromProfile(host, credential, proxyCredential)
  const label = `${host.name} (${host.host}:${host.port})`
  try {
    await useSessions.getState().open(request, host.id)
    recordAudit('session.connect', label, 'success', '快速连接')
    return 'connected'
  } catch (err) {
    recordAudit('session.connect', label, 'failure', '快速连接失败，打开连接对话框')
    logger.warn('快速连接失败', { hostId: host.id, err })
    return 'needs-form'
  }
}
