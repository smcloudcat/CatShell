import { ChangeEvent, useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { sftpList, sftpReadFile, sftpRemoveFile, sftpWriteFile } from '../../api/ssh'
import { useSessions } from '../../store/sessions'
import { SftpEntry } from '../../types/session'
import { recordAudit } from '../../store/audit'

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function parentPath(path: string): string {
  const normalized = path.replace(/\/+$|^$/, '') || '/'
  if (normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

async function uploadWithRetry(target: string, data: Uint8Array, writeFile: (path: string, data: Uint8Array) => Promise<void>): Promise<number> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await writeFile(target, data)
      return attempt
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, attempt * 500))
    }
  }
  throw lastError
}

interface Props {
  sessionId: number
}

export function SessionSftpPanel({ sessionId }: Props) {
  const sessions = useSessions((state) => state.sessions)
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<SftpEntry | null>(null)
  const [editorText, setEditorText] = useState('')
  const [editorBusy, setEditorBusy] = useState(false)

  const connected = sessions[sessionId]?.status === 'connected'

  const loadDirectory = async (nextPath?: string) => {
    const target = nextPath ?? path
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setEntries(await sftpList(sessionId, target))
      recordAudit('sftp.list', target, 'success', '读取远程目录')
      setPath(target)
    } catch (err) {
      recordAudit('sftp.list', target, 'failure', '读取远程目录失败')
      setError(typeof err === 'string' ? err : '无法读取远程目录')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (connected) void loadDirectory()
    // Directory loading is intentionally triggered only when the session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, connected])

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length) return
    setBusy(true)
    setError(null)
    setNotice(null)
    let uploaded = 0
    let retried = 0
    const failed: string[] = []
    try {
      for (const file of files) {
        const target = path === '/' ? `/${file.name}` : `${path.replace(/\/$/, '')}/${file.name}`
        try {
          const attempts = await uploadWithRetry(target, new Uint8Array(await file.arrayBuffer()), (filePath, data) => sftpWriteFile(sessionId, filePath, data))
          if (attempts > 1) retried += 1
          recordAudit('sftp.upload', target, 'success', attempts > 1 ? `上传文件，第 ${attempts} 次尝试成功` : '上传文件')
          uploaded += 1
        } catch {
          recordAudit('sftp.upload', target, 'failure', '上传文件失败')
          failed.push(file.name)
        }
      }
      recordAudit('sftp.batch-upload', `${uploaded}/${files.length} 个文件`, failed.length ? 'failure' : 'success', `批量上传完成，重试成功 ${retried} 个，失败 ${failed.length} 个`)
      setNotice(failed.length ? `已上传 ${uploaded}/${files.length} 个文件，失败：${failed.join('、')}` : `已上传 ${uploaded} 个文件`)
      await loadDirectory(path)
    } catch (err) {
      setError(typeof err === 'string' ? err : '上传失败')
    } finally {
      setBusy(false)
    }
  }

  const openEditor = async (entry: SftpEntry) => {
    if (entry.kind !== 'file') return
    setBusy(true)
    setError(null)
    try {
      const data = await sftpReadFile(sessionId, entry.path)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
      setEditorText(text)
      setEditing(entry)
    } catch {
      setError('无法作为 UTF-8 文本打开该文件，请使用下载操作处理二进制文件。')
    } finally {
      setBusy(false)
    }
  }

  const saveEditor = async () => {
    if (!editing) return
    setEditorBusy(true)
    setError(null)
    try {
      await sftpWriteFile(sessionId, editing.path, new TextEncoder().encode(editorText))
      recordAudit('sftp.edit', editing.path, 'success', '编辑并回传远程文件')
      setNotice(`已保存 ${editing.name}`)
      setEditing(null)
      await loadDirectory(path)
    } catch (err) {
      recordAudit('sftp.edit', editing.path, 'failure', '编辑远程文件失败')
      setError(typeof err === 'string' ? err : '保存远程文件失败')
    } finally {
      setEditorBusy(false)
    }
  }

  const handleDownload = async (entry: SftpEntry) => {
    if (entry.kind !== 'file') return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const data = await sftpReadFile(sessionId, entry.path)
      recordAudit('sftp.download', entry.path, 'success', '下载文件')
      const downloadBuffer = new ArrayBuffer(data.byteLength)
      new Uint8Array(downloadBuffer).set(data)
      const anchor = document.createElement('a')
      anchor.href = URL.createObjectURL(new Blob([downloadBuffer]))
      anchor.download = entry.name
      anchor.click()
      URL.revokeObjectURL(anchor.href)
      setNotice(`已下载 ${entry.name}`)
    } catch (err) {
      recordAudit('sftp.download', entry.path, 'failure', '下载文件失败')
      setError(typeof err === 'string' ? err : '下载失败')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (entry: SftpEntry) => {
    if (entry.kind !== 'file') return
    if (!window.confirm(`确认删除远程文件“${entry.name}”？`)) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await sftpRemoveFile(sessionId, entry.path)
      recordAudit('sftp.delete', entry.path, 'success', '删除文件')
      setNotice(`已删除 ${entry.name}`)
      await loadDirectory(path)
    } catch (err) {
      recordAudit('sftp.delete', entry.path, 'failure', '删除文件失败')
      setError(typeof err === 'string' ? err : '删除失败')
      setBusy(false)
    }
  }

  if (!connected) {
    return (
      <div className="sftp-empty">
        <Icon name="folder" size={44} />
        <p>会话未连接，连接成功后即可在此浏览和传输远程文件。</p>
      </div>
    )
  }

  return (
    <div className="sftp-panel-body">
      <div className="sftp-toolbar">
        <Icon name="folder" size={15} />
        <span className="sftp-heading">SFTP 文件</span>
        <button className="glass-btn" onClick={() => void loadDirectory()} disabled={busy} title="刷新目录"><Icon name="refresh" size={15} /></button>
        <label className="glass-btn primary">
          <Icon name="upload" size={15} />
          上传文件
          <input className="sr-only" type="file" multiple onChange={handleUpload} disabled={busy} />
        </label>
      </div>
      <div className="sftp-pathbar">
        <button className="host-icon-btn" onClick={() => void loadDirectory(parentPath(path))} disabled={path === '/'} title="返回上级"><Icon name="chevron-down" size={15} /></button>
        <code>{path}</code>
      </div>
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="form-notice">{notice}</div>}
      <div className="sftp-table-head"><span>名称</span><span>类型</span><span>大小</span><span>操作</span></div>
      <div className="sftp-entries">
        {entries.map((entry) => (
          <div className="sftp-entry" key={entry.path}>
            <button className="sftp-name" onClick={() => entry.kind === 'directory' ? void loadDirectory(entry.path) : void handleDownload(entry)}>
              <Icon name={entry.kind === 'directory' ? 'folder' : 'save'} size={15} />
              <span>{entry.name}</span>
            </button>
            <span>{entry.kind === 'directory' ? '目录' : entry.kind === 'symlink' ? '链接' : '文件'}</span>
            <span>{entry.kind === 'file' ? formatSize(entry.size) : '-'}</span>
            <span className="sftp-actions">
              {entry.kind === 'file' && <button className="host-icon-btn" onClick={() => void handleDownload(entry)} title="下载"><Icon name="save" size={14} /></button>}
              {entry.kind === 'file' && <button className="host-icon-btn" onClick={() => void openEditor(entry)} title="编辑文本文件"><Icon name="settings" size={14} /></button>}
              {entry.kind === 'file' && <button className="host-icon-btn danger" onClick={() => void handleDelete(entry)} title="删除"><Icon name="trash" size={14} /></button>}
            </span>
          </div>
        ))}
        {!busy && entries.length === 0 && <div className="sftp-empty">目录为空</div>}
        {busy && <div className="sftp-empty">读取中…</div>}
      </div>
      {editing && (
        <div className="modal-overlay" onClick={() => !editorBusy && setEditing(null)}>
          <div className="modal glass sftp-editor-modal" onClick={(event) => event.stopPropagation()}>
            <header className="modal-header"><div className="modal-title"><Icon name="settings" size={17} />编辑 {editing.name}</div><button className="modal-close" onClick={() => setEditing(null)} disabled={editorBusy}><Icon name="x" size={15} /></button></header>
            <div className="modal-body sftp-editor-body"><textarea className="glass-input sftp-editor" value={editorText} onChange={(event) => setEditorText(event.target.value)} spellCheck={false} autoFocus /></div>
            <footer className="modal-footer"><button className="glass-btn" onClick={() => setEditing(null)} disabled={editorBusy}>取消</button><button className="glass-btn primary" onClick={() => void saveEditor()} disabled={editorBusy}>{editorBusy ? '保存中…' : '保存并回传'}</button></footer>
          </div>
        </div>
      )}
    </div>
  )
}