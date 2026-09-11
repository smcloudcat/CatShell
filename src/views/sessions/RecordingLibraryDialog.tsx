import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { useT } from '../../i18n'
import { recordingDelete, RecordingMeta, recordingList, recordingRead } from '../../api/ssh'
import { parseAsciicast } from '../../utils/asciicast'
import { RecordingPlayerDialog } from './RecordingPlayerDialog'

interface Props {
  onClose: () => void
}

/** 录制库：列出、回放与删除 asciicast 录制。 */
export function RecordingLibraryDialog({ onClose }: Props) {
  const t = useT()
  const [items, setItems] = useState<RecordingMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<{ fileName: string; content: string } | null>(null)

  const refresh = useCallback(() => {
    recordingList()
      .then((list) => {
        setItems(list)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const openRecording = (meta: RecordingMeta) => {
    recordingRead(meta.name)
      .then((content) => setPlaying({ fileName: meta.name, content }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  const removeRecording = async (meta: RecordingMeta) => {
    try {
      await recordingDelete(meta.name)
      refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const formatSize = (size: number) => {
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatTime = (unixSeconds: number) => {
    const date = new Date(unixSeconds * 1000)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  return (
    <>
      <Modal onClose={onClose} className="recording-library-modal" ariaLabel={t('录制库')}>
        <header className="modal-header">
          <div className="modal-title">
            <Icon name="record" size={17} />
            {t('录制库')}
          </div>
          <button className="modal-close" onClick={onClose} title={t('关闭')}>
            <Icon name="x" size={15} />
          </button>
        </header>
        <div className="recording-library-body">
          {error && <p className="section-tip recording-error">{error}</p>}
          {items === null && <p className="section-tip">{t('加载中…')}</p>}
          {items !== null && items.length === 0 && (
            <p className="section-tip">{t('还没有录制。在会话工具栏点击「录制」开始，停止后自动保存到这里。')}</p>
          )}
          {items !== null && items.length > 0 && (
            <ul className="recording-list">
              {items.map((meta) => (
                <li key={meta.name} className="recording-item">
                  <div className="recording-item-info">
                    <span className="recording-item-name">{meta.name.replace(/\.cast$/, '')}</span>
                    <span className="recording-item-meta">
                      {formatSize(meta.size)} · {formatTime(meta.modifiedAt)}
                    </span>
                  </div>
                  <div className="recording-item-actions">
                    <button className="glass-btn" onClick={() => openRecording(meta)} title={t('回放')}>
                      <Icon name="play" size={13} />
                      {t('回放')}
                    </button>
                    <button
                      className="glass-btn"
                      onClick={() => void removeRecording(meta)}
                      title={t('删除录制')}
                    >
                      <Icon name="trash" size={13} />
                      {t('删除')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
      {playing && (
        <RecordingPlayerDialog
          fileName={playing.fileName.replace(/\.cast$/, '')}
          doc={parseAsciicast(playing.content)}
          onClose={() => setPlaying(null)}
        />
      )}
    </>
  )
}
