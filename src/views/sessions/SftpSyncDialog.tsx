import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { useT } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { recordAudit } from '../../store/audit'
import { showToast } from '../../store/ui'
import {
  pickDirectory,
  sftpSyncCancel,
  sftpSyncPlan,
  sftpSyncStart,
  subscribeSftpSyncProgress
} from '../../api/ssh'
import { SftpSyncPlan, SftpSyncPlanEntry, SftpSyncProgress } from '../../types/session'
import { formatBytes } from '../../utils/format'

/** 差异清单在弹窗里最多直接渲染的行数，超出折叠为「+N 项」。 */
const MAX_VISIBLE_ENTRIES = 100

type SyncDirection = 'upload' | 'download'

interface Props {
  sessionId: number
  remoteDir: string
  onClose: () => void
  /** 同步完成后刷新远端列表。 */
  onFinished: () => void
}

const ACTION_LABEL_KEYS: Record<string, string> = {
  mkdir: '新建目录',
  add: '新增',
  update: '更新',
  skip: '跳过'
}

/**
 * SFTP 目录同步（单向 mirror）弹窗。
 *
 * 三段式流程：选方向与本地目录 → 生成差异计划预览确认 → 执行并展示进度。
 * 执行阶段进度来自 `sftp-sync-progress` 事件；本组件自持订阅与审计。
 */
export function SftpSyncDialog({ sessionId, remoteDir, onClose, onFinished }: Props) {
  const t = useT()
  const [direction, setDirection] = useState<SyncDirection>('upload')
  const [localDir, setLocalDir] = useState('')
  const [plan, setPlan] = useState<SftpSyncPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<SftpSyncProgress | null>(null)
  const [error, setError] = useState('')
  // 执行期间阻止关闭弹窗；用 ref 让事件回调读到最新状态。
  const runningRef = useRef(false)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void subscribeSftpSyncProgress((payload) => {
      if (disposed || payload.sessionId !== sessionId) return
      setProgress(payload)
      if (payload.finished) {
        runningRef.current = false
        setRunning(false)
        if (payload.cancelled) {
          recordAudit('sftp.sync', payload.direction, 'failure', t('目录同步已取消'))
          showToast(t('目录同步已取消'), 'info')
        } else if (payload.errors.length > 0) {
          recordAudit('sftp.sync', payload.direction, 'failure', `${payload.errors.length} ${t('项失败')}`)
          showToast(`${t('目录同步完成，')} ${payload.errors.length} ${t('项失败')}`, 'warning')
        } else {
          recordAudit('sftp.sync', payload.direction, 'success', `${payload.doneFiles} ${t('个文件已同步')}`)
          showToast(t('目录同步完成'), 'success')
        }
        onFinished()
      }
    }).then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [onFinished, sessionId, t])

  const pickLocal = async () => {
    try {
      const picked = await pickDirectory()
      if (picked) {
        setLocalDir(picked)
        setPlan(null)
      }
    } catch (err) {
      setError(errorText(err, t, t('打开目录选择器失败')))
    }
  }

  const generatePlan = async () => {
    if (!localDir.trim() || planning || runningRef.current) return
    setPlanning(true)
    setError('')
    try {
      const generated = await sftpSyncPlan(sessionId, direction, localDir.trim(), remoteDir)
      setPlan(generated)
    } catch (err) {
      setPlan(null)
      setError(errorText(err, t, t('生成同步计划失败')))
    } finally {
      setPlanning(false)
    }
  }

  const startSync = async () => {
    if (!plan || runningRef.current) return
    runningRef.current = true
    setRunning(true)
    setError('')
    setProgress(null)
    try {
      await sftpSyncStart(sessionId, direction, plan.localDir, plan.remoteDir, plan.entries)
      recordAudit('sftp.sync', direction, 'success', `${plan.transferCount} ${t('个文件，')}${plan.totalBytes} ${t('字节')}`)
    } catch (err) {
      runningRef.current = false
      setRunning(false)
      recordAudit('sftp.sync', direction, 'failure', errorText(err, t, '目录同步启动失败'))
      setError(errorText(err, t, t('目录同步启动失败')))
    }
  }

  const cancelSync = async () => {
    try {
      await sftpSyncCancel(sessionId)
    } catch {
      // 取消失败不弹错——任务很快会自己结束或已在收尾。
    }
  }

  const close = () => {
    if (runningRef.current) return
    onClose()
  }

  const finished = progress?.finished ?? false
  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.doneBytes / progress.totalBytes) * 100))
      : 0
  const visibleEntries: SftpSyncPlanEntry[] = plan ? plan.entries.slice(0, MAX_VISIBLE_ENTRIES) : []

  return (
    <Modal onClose={close} closeOnOverlayClick={!running} closeOnEscape={!running} ariaLabel={t('目录同步')}>
      <header className="modal-header">
        <div className="modal-title">
          <Icon name="refresh" size={17} />
          {t('目录同步（单向）')}
        </div>
        <button className="modal-close" onClick={close} disabled={running} title={t('关闭')}>
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="modal-body">
        {running ? (
          <div className="sftp-sync-running">
            <p>
              {progress?.currentFile
                ? `${t('正在同步')}: ${progress.currentFile}`
                : t('正在扫描传输清单…')}
            </p>
            <div className="sftp-sync-bar">
              <div className="sftp-sync-bar-fill" style={{ width: `${percent}%` }} />
            </div>
            <p className="sftp-sync-stat">
              {progress
                ? `${progress.doneFiles} / ${progress.totalFiles} ${t('个文件')} · ${formatBytes(progress.doneBytes)} / ${formatBytes(progress.totalBytes)}`
                : ''}
            </p>
            {progress && progress.errors.length > 0 && (
              <ul className="sftp-sync-errors">
                {progress.errors.slice(-5).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button className="glass-btn" onClick={() => void cancelSync()} disabled={finished}>
                {t('取消同步')}
              </button>
              <button className="glass-btn primary" onClick={onClose} disabled={!finished}>
                {t('完成')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="sftp-sync-direction">
              <label>
                <input
                  type="radio"
                  name="sftp-sync-direction"
                  checked={direction === 'upload'}
                  onChange={() => {
                    setDirection('upload')
                    setPlan(null)
                  }}
                />
                {t('上传：本地 → 远程')}
              </label>
              <label>
                <input
                  type="radio"
                  name="sftp-sync-direction"
                  checked={direction === 'download'}
                  onChange={() => {
                    setDirection('download')
                    setPlan(null)
                  }}
                />
                {t('下载：远程 → 本地')}
              </label>
            </div>
            <div className="sftp-sync-paths">
              <div className="sftp-sync-path-row">
                <span className="sftp-sync-path-label">{t('本地目录')}</span>
                <code>{localDir || t('尚未选择')}</code>
                <button className="glass-btn" onClick={() => void pickLocal()}>
                  {t('选择目录')}
                </button>
              </div>
              <div className="sftp-sync-path-row">
                <span className="sftp-sync-path-label">{t('远程目录')}</span>
                <code>{remoteDir}</code>
              </div>
            </div>
            <p className="sftp-sync-note">{t('同步只新增和更新文件，绝不删除目标侧多余文件。')}</p>
            {error && <p className="sftp-sync-error">{error}</p>}
            {plan && (
              <div className="sftp-sync-plan">
                <p>
                  {t('新增')} {plan.entries.filter((entry) => entry.action === 'add').length} · {t('更新')}{' '}
                  {plan.entries.filter((entry) => entry.action === 'update').length} · {t('跳过')}{' '}
                  {plan.skipCount} · {formatBytes(plan.totalBytes)}
                </p>
                <ul className="sftp-sync-plan-list">
                  {visibleEntries.map((entry) => (
                    <li key={`${entry.action}:${entry.relativePath}`}>
                      <span className={`sftp-sync-action sftp-sync-action-${entry.action}`}>
                        {t(ACTION_LABEL_KEYS[entry.action] ?? entry.action)}
                      </span>
                      <code>{entry.relativePath}</code>
                    </li>
                  ))}
                </ul>
                {plan.entries.length > MAX_VISIBLE_ENTRIES && (
                  <p className="sftp-sync-more">
                    +{plan.entries.length - MAX_VISIBLE_ENTRIES} {t('项未展示')}
                  </p>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button className="glass-btn" onClick={close}>
                {t('关闭')}
              </button>
              <button className="glass-btn" onClick={() => void generatePlan()} disabled={!localDir.trim() || planning}>
                {planning ? t('扫描中…') : t('生成差异预览')}
              </button>
              <button
                className="glass-btn primary"
                onClick={() => void startSync()}
                disabled={!plan || planning || plan.transferCount === 0}
              >
                {t('开始同步')}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
