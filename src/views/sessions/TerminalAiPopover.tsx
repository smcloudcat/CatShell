import { useEffect, useRef, useState } from 'react'

import { Icon } from '../../components/Icon'
import { aiComplete, commandPrompt, diagnosticPrompt } from '../../api/ai'
import { recordAudit } from '../../store/audit'
import { useSettings } from '../../store/settings'
import { useT } from '../../i18n'

interface Props {
  /** 终端当前选中文本（诊断 tab 的预填原料） */
  selection: string
  /** 把命令文本「打字」进终端（进入 shell 输入行，仍需用户手动回车） */
  onInsertCommand: (command: string) => void
  onClose: () => void
}

type AiTab = 'generate' | 'diagnose'

/** 终端 AI 助手弹窗：自然语言生成命令 / 日志诊断（6.17）。 */
export function TerminalAiPopover({ selection, onInsertCommand, onClose }: Props) {
  const t = useT()
  const ai = useSettings((s) => s.ai)
  const [tab, setTab] = useState<AiTab>('generate')
  const [request, setRequest] = useState('')
  const [logText, setLogText] = useState(selection)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  const run = async () => {
    const content = (tab === 'generate' ? request : logText).trim()
    if (!content || busy) return
    if (!ai.endpoint.trim() || !ai.model.trim()) {
      setError(t('请先在 设置 → AI 助手 填写接口地址与模型'))
      return
    }
    setBusy(true)
    setError(null)
    setResult('')
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const base = tab === 'generate' ? commandPrompt() : diagnosticPrompt()
    const messages = base.map((message, index) =>
      index === base.length - 1 ? { ...message, content } : message
    )
    try {
      const answer = await aiComplete(ai, messages)
      // 防竞态：只采纳最后一次请求的结果
      if (requestIdRef.current !== requestId) return
      setResult(answer.trim())
      // 审计只记类型与模型，不含 prompt / 日志内容（隐私）
      recordAudit('ai.complete', ai.model, 'success', tab === 'generate' ? '生成命令' : '诊断日志')
    } catch (err) {
      if (requestIdRef.current !== requestId) return
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      if (requestIdRef.current === requestId) setBusy(false)
    }
  }

  const insert = () => {
    if (!result) return
    // 只取首个命令行（AI 可能带解释），去掉反引号/代码围栏
    const command = result
      .replace(/```[a-z]*\n?/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'))
    if (command) onInsertCommand(command)
    onClose()
  }

  return (
    <div className="terminal-ai glass">
      <div className="terminal-ai-head">
        <div className="terminal-ai-tabs">
          <button
            className={tab === 'generate' ? 'active' : ''}
            onClick={() => {
              setTab('generate')
              setResult('')
              setError(null)
            }}
          >
            <Icon name="sparkles" size={13} /> {t('生成命令')}
          </button>
          <button
            className={tab === 'diagnose' ? 'active' : ''}
            onClick={() => {
              setTab('diagnose')
              setResult('')
              setError(null)
              setLogText((current) => current || selection)
            }}
          >
            <Icon name="terminal" size={13} /> {t('诊断日志')}
          </button>
        </div>
        <button className="host-icon-btn" title={t('关闭')} onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>

      {tab === 'generate' ? (
        <textarea
          ref={inputRef}
          className="glass-input terminal-ai-input"
          rows={2}
          placeholder={t('用自然语言描述要做什么，例如：找出 /var/log 下 7 天内改过的前 10 个大文件')}
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void run()
            }
          }}
        />
      ) : (
        <textarea
          ref={inputRef}
          className="glass-input terminal-ai-input"
          rows={4}
          placeholder={t('粘贴报错或日志（终端里选中文本会自动带进来）')}
          value={logText}
          onChange={(event) => setLogText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.ctrlKey) {
              event.preventDefault()
              void run()
            }
          }}
        />
      )}

      <div className="terminal-ai-actions">
        <button className="glass-btn" disabled={busy || !(tab === 'generate' ? request : logText).trim()} onClick={() => void run()}>
          <Icon name="play" size={13} /> {busy ? t('思考中…') : t('发送给 AI')}
        </button>
        {tab === 'generate' && result && (
          <button className="glass-btn" onClick={insert}>
            <Icon name="terminal" size={13} /> {t('填入终端')}
          </button>
        )}
      </div>

      {error && <div className="form-error terminal-ai-error">{error}</div>}
      {result && (
        <pre className="terminal-ai-result">{result}</pre>
      )}
      <div className="terminal-ai-foot">
        {t('AI 输出仅供参考，执行前请自行确认；高危命令会被本地守卫拦截确认。')}
      </div>
    </div>
  )
}
