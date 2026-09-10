import { DragEvent, ReactNode, useRef, useState } from 'react'
import { useT } from '../../i18n'

interface Props {
  /** 未连接或正在忙碌时禁用拖放，避免把文件丢进一个不会响应的面板。 */
  enabled: boolean
  /** 落点目录，仅用于拖拽提示文案。 */
  path: string
  onFiles: (files: File[]) => void
  children: ReactNode
}

/**
 * 包裹整个 SFTP 面板的拖放上传区。
 *
 * 用 depth 计数而不是布尔值来判断拖拽是否离开：拖动经过子元素时浏览器会
 * 连续触发 dragenter / dragleave，只靠布尔值会让高亮状态疯狂闪烁。
 */
export function SftpDropZone({ enabled, path, onFiles, children }: Props) {
  const t = useT()
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)

  const reset = () => {
    dragDepth.current = 0
    setDragOver(false)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    reset()
    if (!enabled) return
    onFiles(Array.from(event.dataTransfer?.files ?? []))
  }

  return (
    <div
      className={`sftp-panel-body ${dragOver ? 'drag-over' : ''}`}
      onDragEnter={(event) => {
        if (!enabled) return
        event.preventDefault()
        dragDepth.current += 1
        setDragOver(true)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }}
      onDrop={handleDrop}
    >
      {dragOver && <div className="sftp-drop-hint">{t('松开以上传到 ')}{path}</div>}
      {children}
    </div>
  )
}
