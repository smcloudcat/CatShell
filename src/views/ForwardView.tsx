import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { sshForwardList, sshForwardStart, sshForwardStartDynamic, sshForwardStartRemote, sshForwardStop } from '../api/ssh'
import { useSessions } from '../store/sessions'
import { PortForwardInfo } from '../types/session'
import { recordAudit } from '../store/audit'
import { confirmDialog } from '../store/ui'
import { useT } from '../i18n'

interface FormState {
  sessionId: string
  direction: 'local' | 'remote' | 'dynamic'
  bindPort: string
  targetHost: string
  targetPort: string
}

const EMPTY_FORM: FormState = {
  sessionId: '',
  direction: 'local',
  bindPort: '0',
  targetHost: '127.0.0.1',
  targetPort: '80'
}

export function ForwardView() {
  const t = useT()
  const sessions = useSessions((state) => state.sessions)
  const order = useSessions((state) => state.order)
  const [forwards, setForwards] = useState<PortForwardInfo[]>([])
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connectedSessions = useMemo(
    () => order.map((id) => sessions[id]).filter((session) => session?.status === 'connected'),
    [order, sessions]
  )

  useEffect(() => {
    if (!form.sessionId && connectedSessions[0]) {
      setForm((current) => ({ ...current, sessionId: String(connectedSessions[0].id) }))
    }
  }, [connectedSessions, form.sessionId])

  const loadForwards = async () => {
    try {
      setForwards(await sshForwardList())
    } catch (err) {
      setError(typeof err === 'string' ? err : t('无法读取端口转发列表'))
    }
  }

  const statusSignature = order.map((id) => `${id}:${sessions[id]?.status ?? ''}`).join(',')

  useEffect(() => {
    void loadForwards()
  }, [statusSignature])

  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }))

  const startForward = async () => {
    const sessionId = Number(form.sessionId)
    const bindPort = Number(form.bindPort)
    const targetPort = Number(form.targetPort)
    const needsTarget = form.direction !== 'dynamic'
    if (!sessionId || (needsTarget && !form.targetHost.trim()) || !Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535 || (needsTarget && (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535))) {
      setError(t('请填写有效的会话、监听端口和目标地址'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const info = form.direction === 'local'
        ? await sshForwardStart(sessionId, '127.0.0.1', bindPort, form.targetHost.trim(), targetPort)
        : form.direction === 'remote'
          ? await sshForwardStartRemote(sessionId, '127.0.0.1', bindPort, form.targetHost.trim(), targetPort)
          : await sshForwardStartDynamic(sessionId, '127.0.0.1', bindPort)
      setForwards((current) => [...current, info])
      recordAudit('forward.start', `${info.bindHost}:${info.bindPort} -> ${info.targetHost}${info.targetPort ? `:${info.targetPort}` : ''}`, 'success', `${t('启动')}${forwardDirectionLabel(t, info.direction)}${t('转发')}`)
      setForm((current) => ({ ...current, bindPort: '0' }))
    } catch (err) {
      setError(typeof err === 'string' ? err : t('启动端口转发失败'))
    } finally {
      setBusy(false)
    }
  }

  const stopForward = async (forward: PortForwardInfo) => {
    const accepted = await confirmDialog({
      title: t('停止端口转发'),
      message: t('确认停止 ') + forward.bindHost + ':' + forward.bindPort + t(' 的') + forwardDirectionLabel(t, forward.direction) + t('转发？'),
      confirmLabel: t('停止'),
      danger: true
    })
    if (!accepted) return
    setBusy(true)
    setError(null)
    try {
      await sshForwardStop(forward.id)
      setForwards((current) => current.filter((item) => item.id !== forward.id))
      recordAudit('forward.stop', `${forward.bindHost}:${forward.bindPort}`, 'success', `${t('停止')}${forwardDirectionLabel(t, forward.direction)}${t('转发')}`)
    } catch (err) {
      setError(typeof err === 'string' ? err : t('停止端口转发失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="view forward-view">
      <header className="view-header">
        <div>
          <div className="view-title">{t('端口转发')}</div>
          <div className="view-subtitle">{t('管理 SSH 本地、远程和 SOCKS5 动态转发，监听地址限制在回环接口')}</div>
        </div>
        <button className="glass-btn" onClick={() => void loadForwards()} disabled={busy} title={t('刷新转发列表')}><Icon name="refresh" size={15} /></button>
      </header>

      {connectedSessions.length === 0 ? (
        <section className="glass empty-state">
          <div className="empty-icon"><Icon name="link" size={44} /></div>
          <div className="empty-title">{t('没有可用的 SSH 连接')}</div>
           <div className="empty-desc">{t('请先建立 SSH 连接，再创建端口转发。')}</div>
        </section>
      ) : (
        <>
          <section className="glass forward-form">
             <div className="settings-section-title"><Icon name="link" size={15} />{t('新建端口转发')}</div>
             <div className="section-tip">{t('监听端口填 0 时由系统自动分配。动态转发提供无认证 SOCKS5 CONNECT 代理，仅供本机使用。')}</div>
             <div className="forward-grid">
               <label className="field span-2"><span className="field-label">{t('SSH 会话')}</span><select className="glass-input" value={form.sessionId} onChange={(event) => update({ sessionId: event.target.value })}>{connectedSessions.map((session) => <option key={session.id} value={session.id}>{session.name} · {session.host}</option>)}</select></label>
               <label className="field span-2"><span className="field-label">{t('转发方向')}</span><select className="glass-input" value={form.direction} onChange={(event) => update({ direction: event.target.value as FormState['direction'] })}><option value="local">{t('本地转发：本机 → 远端目标')}</option><option value="remote">{t('远程转发：远端 → 本机目标')}</option><option value="dynamic">{t('动态转发：本机 SOCKS5 代理')}</option></select></label>
               <label className="field"><span className="field-label">{form.direction === 'remote' ? t('远程监听端口') : t('本地监听端口')}</span><input className="glass-input" type="number" min={0} max={65535} value={form.bindPort} onChange={(event) => update({ bindPort: event.target.value })} /></label>
               {form.direction !== 'dynamic' && <label className="field"><span className="field-label">{t('目标端口')}</span><input className="glass-input" type="number" min={1} max={65535} value={form.targetPort} onChange={(event) => update({ targetPort: event.target.value })} /></label>}
               {form.direction !== 'dynamic' && <label className="field span-2"><span className="field-label">{t('目标主机')}</span><input className="glass-input" value={form.targetHost} onChange={(event) => update({ targetHost: event.target.value })} placeholder="127.0.0.1" /></label>}
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="forward-form-actions"><button className="glass-btn primary" onClick={() => void startForward()} disabled={busy}><Icon name="plus" size={14} />{busy ? t('处理中…') : t('启动转发')}</button></div>
          </section>

          <section className="glass forward-list-panel">
            <div className="settings-section-title"><Icon name="monitor" size={15} />{t('运行中的转发')}</div>
             {!forwards.length && <div className="snippet-empty">{t('暂无运行中的端口转发。')}</div>}
            <div className="forward-list">
               {forwards.map((forward) => {
                 const session = sessions[forward.sessionId]
                 return <div className="forward-row" key={forward.id}><div className="forward-route"><span className="forward-direction">{forwardDirectionLabel(t, forward.direction)}</span><strong>{forward.bindHost}:{forward.bindPort}</strong><span>→</span><code>{forward.targetHost}{forward.targetPort ? `:${forward.targetPort}` : ''}</code></div><span className="forward-session">{session?.name ?? `${t('会话 ')}${forward.sessionId}`}</span><button className="host-icon-btn danger" onClick={() => void stopForward(forward)} disabled={busy} title={t('停止转发')}><Icon name="x" size={14} /></button></div>
              })}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function forwardDirectionLabel(t: (key: string) => string, direction: PortForwardInfo['direction']): string {
  if (direction === 'local') return t('本地')
  if (direction === 'remote') return t('远程')
  return 'SOCKS5'
}
