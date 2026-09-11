import { useT } from '../../i18n'
import { BatchExecItem } from '../../types/session'
import { batchResultText, summarizeBatchResults } from '../../utils/batchExec'
import { SessionDialog } from './SessionDialog'

export type BulkCommandMode = 'send' | 'exec'

interface Props {
  mode: BulkCommandMode
  value: string
  timeout: string
  busy: boolean
  /** exec 模式的聚合结果；null 表示尚未执行。 */
  results: BatchExecItem[] | null
  onModeChange: (mode: BulkCommandMode) => void
  onChange: (value: string) => void
  onTimeoutChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}

/**
 * 批量命令弹窗，两种模式：
 * - send：把命令写入所有已连接会话的终端（交互式，原有行为）；
 * - exec：在专用通道执行并聚合每台输出，不写入终端。
 *
 * 危险操作：确认按钮附风险提示，二次确认与审计由编排层负责。
 */
export function BulkCommandDialog({
  mode,
  value,
  timeout,
  busy,
  results,
  onModeChange,
  onChange,
  onTimeoutChange,
  onClose,
  onSubmit
}: Props) {
  const t = useT()
  const summary = results ? summarizeBatchResults(results) : null
  // exec 模式一旦已有结果，提交按钮转为「已执行」语义禁用，重新执行请关掉重开。
  const submitDisabled = busy || !value.trim() || (mode === 'exec' && results !== null)

  return (
    <SessionDialog
      title={t('批量下发命令')}
      icon="terminal"
      ariaLabel={t('批量下发命令')}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="glass-btn" onClick={onClose} disabled={busy}>{t('取消')}</button>
          <button className="glass-btn primary" onClick={onSubmit} disabled={submitDisabled}>
            {busy
              ? t('发送中…')
              : mode === 'exec'
                ? t('执行并收集输出')
                : t('确认发送')}
          </button>
        </>
      }
    >
      <div className="bulk-mode-row" role="tablist" aria-label={t('执行方式')}>
        <button
          role="tab"
          aria-selected={mode === 'send'}
          className={`glass-btn bulk-mode-btn${mode === 'send' ? ' active' : ''}`}
          onClick={() => onModeChange('send')}
          disabled={busy}
        >
          {t('写入终端')}
        </button>
        <button
          role="tab"
          aria-selected={mode === 'exec'}
          className={`glass-btn bulk-mode-btn${mode === 'exec' ? ' active' : ''}`}
          onClick={() => onModeChange('exec')}
          disabled={busy}
        >
          {t('执行并聚合输出')}
        </button>
      </div>

      {mode === 'exec' && (
        <label className="bulk-timeout-row">
          <span>{t('超时（秒）')}</span>
          <input
            className="glass-input bulk-timeout"
            value={timeout}
            onChange={(event) => onTimeoutChange(event.target.value)}
            inputMode="numeric"
            disabled={busy}
          />
        </label>
      )}

      <textarea
        className="glass-input bulk-command"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('例如 uname -a')}
        autoFocus
      />

      {mode === 'send' && (
        <p className="section-tip">{t('命令将发送至所有已连接会话，请确认命令不会造成不可逆影响。')}</p>
      )}
      {mode === 'exec' && (
        <p className="section-tip">
          {t('命令将在每台已连接服务器的独立通道执行并收集输出，不会写入终端；目标过多或输出过长时会被限制。')}
        </p>
      )}

      {mode === 'exec' && summary && results && (
        <section className="bulk-results" aria-live="polite">
          <header className="bulk-results-head">
            <span className={summary.allOk ? 'bulk-ok' : 'bulk-mixed'}>
              {summary.allOk
                ? t('全部成功')
                : `${t('成功')} ${summary.okCount} / ${summary.total}${summary.failedCount > 0 ? ` · ${t('失败')} ${summary.failedCount}` : ''}`}
            </span>
          </header>
          <ul className="bulk-results-list">
            {results.map((item) => (
              <li key={item.sessionId} className="bulk-result-item">
                <div className="bulk-result-head">
                  <span className={`bulk-status ${item.ok ? 'ok' : 'fail'}`}>
                    {item.ok ? t('成功') : t('失败')}
                  </span>
                  <span className="bulk-result-name">{item.name || `#${item.sessionId}`}</span>
                  <span className="bulk-result-duration">{item.durationMs} ms</span>
                  {item.truncated && <span className="bulk-truncated">{t('输出过长已截断')}</span>}
                </div>
                <pre className="bulk-result-output">{batchResultText(item) || '—'}</pre>
              </li>
            ))}
          </ul>
        </section>
      )}
    </SessionDialog>
  )
}
