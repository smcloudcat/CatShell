import { ChangeEvent, useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import {
  base64ToBytes,
  sftpDownloadBegin,
  sftpDownloadChunk,
  sftpList,
  sftpMkdir,
  sftpReadFile,
  sftpRemoveDir,
  sftpRemoveFile,
  sftpRename,
  sftpTransferCancel,
  sftpUploadBegin,
  sftpUploadChunk,
  sftpUploadFinish,
  sftpWriteFile
} from '../../api/ssh'
import { useSessions } from '../../store/sessions'
import { SftpEntry } from '../../types/session'
import { formatBytes } from '../../utils/format'
import { recordAudit } from '../../store/audit'
import { confirmDialog } from '../../store/ui'

const SFTP_CHUNK_SIZE = 256 * 1024
const SFTP_CHUNKED_THRESHOLD = 16 * 1024 * 1024
const CANCELLED_MESSAGE = '已取消'

interface TransferProgress {
  id: number
  name: string
  kind: 'upload' | 'download'
  transferred: number
  total: number
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
  onCollapse?: () => void
}

export function SessionSftpPanel({ sessionId, onCollapse }: Props) {
  const sessions = useSessions((state) => state.sessions)
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<SftpEntry | null>(null)
  const [editorText, setEditorText] = useState('')
  const [editorBusy, setEditorBusy] = useState(false)
  const [transfers, setTransfers] = useState<TransferProgress[]>([])
  const [nameDialog, setNameDialog] = useState<{ mode: 'mkdir' | 'rename'; target: SftpEntry | null; value: string } | null>(null)
  const [nameBusy, setNameBusy] = useState(false)
  const cancelFlags = useRef<Set<number>>(new Set())

  const connected = sessions[sessionId]?.status === 'connected'

  const updateTransfer = (id: number, transferred: number) => {
    setTransfers((current) => current.map((item) => (item.id === id ? { ...item, transferred } : item)))
  }

  const removeTransfer = (id: number) => {
    cancelFlags.current.delete(id)
    setTransfers((current) => current.filter((item) => item.id !== id))
  }

  const requestCancel = (id: number) => {
    cancelFlags.current.add(id)
  }

  const uploadChunked = async (target: string, file: File): Promise<void> => {
    const { transferId } = await sftpUploadBegin(sessionId, target, file.size)
    setTransfers((current) => [
      ...current,
      { id: transferId, name: file.name, kind: 'upload', transferred: 0, total: file.size }
    ])
    try {
      let offset = 0
      while (offset < file.size) {
        if (cancelFlags.current.has(transferId)) throw new Error(CANCELLED_MESSAGE)
        const slice = await file.slice(offset, Math.min(offset + SFTP_CHUNK_SIZE, file.size)).arrayBuffer()
        await sftpUploadChunk(transferId, offset, new Uint8Array(slice))
        offset += slice.byteLength
        updateTransfer(transferId, offset)
      }
      await sftpUploadFinish(transferId)
      removeTransfer(transferId)
    } catch (err) {
      removeTransfer(transferId)
      try {
        await sftpTransferCancel(transferId)
      } catch {
        /* transfer already gone */
      }
      throw err
    }
  }

  const downloadChunked = async (entry: SftpEntry): Promise<void> => {
    const { transferId, total } = await sftpDownloadBegin(sessionId, entry.path)
    setTransfers((current) => [
      ...current,
      { id: transferId, name: entry.name, kind: 'download', transferred: 0, total }
    ])
    const parts: BlobPart[] = []
    let received = 0
    try {
      for (;;) {
        if (cancelFlags.current.has(transferId)) throw new Error(CANCELLED_MESSAGE)
        const chunk = await sftpDownloadChunk(transferId)
        if (chunk.done) break
        const bytes = base64ToBytes(chunk.data)
        const copy = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(copy).set(bytes)
        parts.push(copy)
        received += bytes.length
        updateTransfer(transferId, received)
      }
      const anchor = document.createElement('a')
      anchor.href = URL.createObjectURL(new Blob(parts))
      anchor.download = entry.name
      anchor.click()
      URL.revokeObjectURL(anchor.href)
      recordAudit('sftp.download', entry.path, 'success', '分块下载文件')
      setNotice(`已下载 ${entry.name}`)
    } finally {
      removeTransfer(transferId)
      try {
        await sftpTransferCancel(transferId)
      } catch {
        /* transfer already gone */
      }
    }
  }

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
    let skipped = 0
    const failed: string[] = []
    try {
      let existingNames = new Set<string>()
      try {
        existingNames = new Set((await sftpList(sessionId, path)).map((entry) => entry.name))
      } catch {
        existingNames = new Set()
      }
      for (const file of files) {
        if (existingNames.has(file.name)) {
          const overwrite = await confirmDialog({
            title: '覆盖远程文件',
            message: `远程目录 ${path} 已存在同名文件“${file.name}”，上传将覆盖其内容。`,
            confirmLabel: '覆盖',
            danger: true
          })
          if (!overwrite) {
            skipped += 1
            continue
          }
        }
        const target = path === '/' ? `/${file.name}` : `${path.replace(/\/$/, '')}/${file.name}`
        try {
          if (file.size > SFTP_CHUNKED_THRESHOLD) {
            await uploadChunked(target, file)
            recordAudit('sftp.upload', target, 'success', '分块上传文件')
            uploaded += 1
            continue
          }
          const attempts = await uploadWithRetry(target, new Uint8Array(await file.arrayBuffer()), (filePath, data) => sftpWriteFile(sessionId, filePath, data))
          if (attempts > 1) retried += 1
          recordAudit('sftp.upload', target, 'success', attempts > 1 ? `上传文件，第 ${attempts} 次尝试成功` : '上传文件')
          uploaded += 1
        } catch (err) {
          if (err instanceof Error && err.message === CANCELLED_MESSAGE) {
            recordAudit('sftp.upload', target, 'failure', '上传已取消')
            skipped += 1
          } else {
            recordAudit('sftp.upload', target, 'failure', '上传文件失败')
            failed.push(file.name)
          }
        }
      }
      recordAudit('sftp.batch-upload', `${uploaded}/${files.length} 个文件`, failed.length ? 'failure' : 'success', `批量上传完成，重试成功 ${retried} 个，失败 ${failed.length} 个，跳过 ${skipped} 个`)
      const parts = [`已上传 ${uploaded}/${files.length} 个文件`]
      if (skipped) parts.push(`跳过 ${skipped} 个`)
      if (failed.length) parts.push(`失败：${failed.join('、')}`)
      setNotice(parts.join('，'))
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
    if (entry.size > SFTP_CHUNKED_THRESHOLD) {
      setError(null)
      try {
        await downloadChunked(entry)
      } catch (err) {
        if (!(err instanceof Error && err.message === CANCELLED_MESSAGE)) {
          recordAudit('sftp.download', entry.path, 'failure', '分块下载失败')
          setError(typeof err === 'string' ? err : '下载失败')
        }
      }
      return
    }
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

  const submitNameDialog = async () => {
    if (!nameDialog) return
    const value = nameDialog.value.trim()
    if (!value || value.includes('/')) return
    setNameBusy(true)
    setError(null)
    try {
      if (nameDialog.mode === 'mkdir') {
        const target = path === '/' ? `/${value}` : `${path.replace(/\/$/, '')}/${value}`
        await sftpMkdir(sessionId, target)
        recordAudit('sftp.mkdir', target, 'success', '创建远程目录')
        setNotice(`已创建目录 ${value}`)
      } else if (nameDialog.target) {
        const parent = nameDialog.target.path.slice(0, nameDialog.target.path.lastIndexOf('/'))
        const target = parent === '' ? `/${value}` : `${parent}/${value}`
        await sftpRename(sessionId, nameDialog.target.path, target)
        recordAudit('sftp.rename', `${nameDialog.target.path} -> ${target}`, 'success', '重命名远程文件')
        setNotice(`已重命名为 ${value}`)
      }
      setNameDialog(null)
      await loadDirectory(path)
    } catch (err) {
      recordAudit(nameDialog.mode === 'mkdir' ? 'sftp.mkdir' : 'sftp.rename', nameDialog.mode === 'rename' && nameDialog.target ? nameDialog.target.path : path, 'failure', '远程操作失败')
      setError(typeof err === 'string' ? err : '远程操作失败')
    } finally {
      setNameBusy(false)
    }
  }

  const handleDelete = async (entry: SftpEntry) => {
    if (entry.kind !== 'file' && entry.kind !== 'directory') return
    if (entry.kind === 'directory') {
      const accepted = await confirmDialog({
        title: '递归删除远程目录',
        message: `目录“${entry.name}”及其全部子目录和文件将被删除，该操作不可恢复。确认继续？`,
        confirmLabel: '全部删除',
        danger: true
      })
      if (!accepted) return
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        await sftpRemoveDir(sessionId, entry.path)
        recordAudit('sftp.rmdir', entry.path, 'success', '递归删除远程目录')
        setNotice(`已删除目录 ${entry.name}`)
        await loadDirectory(path)
      } catch (err) {
        recordAudit('sftp.rmdir', entry.path, 'failure', '递归删除远程目录失败')
        setError(typeof err === 'string' ? err : '递归删除目录失败')
      } finally {
        setBusy(false)
      }
      return
    }
    const accepted = await confirmDialog({
      title: '删除远程文件',
      message: `确认删除远程文件“${entry.name}”？该操作不可恢复。`,
      confirmLabel: '删除',
      danger: true
    })
    if (!accepted) return
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
        {onCollapse && <button className="host-icon-btn" onClick={onCollapse} title="折叠面板"><Icon name="chevron-down" size={14} /></button>}
        <button className="glass-btn" onClick={() => void loadDirectory()} disabled={busy} title="刷新目录"><Icon name="refresh" size={15} /></button>
        <button className="glass-btn" onClick={() => setNameDialog({ mode: 'mkdir', target: null, value: '' })} title="新建目录"><Icon name="plus" size={15} /></button>
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
            <span>{entry.kind === 'file' ? formatBytes(entry.size) : '-'}</span>
            <span className="sftp-actions">
              {entry.kind === 'file' && <button className="host-icon-btn" onClick={() => void handleDownload(entry)} title="下载"><Icon name="save" size={14} /></button>}
              {entry.kind === 'file' && <button className="host-icon-btn" onClick={() => void openEditor(entry)} title="编辑文本文件"><Icon name="settings" size={14} /></button>}
              <button className="host-icon-btn" onClick={() => setNameDialog({ mode: 'rename', target: entry, value: entry.name })} title="重命名"><Icon name="edit" size={14} /></button>
              <button className="host-icon-btn danger" onClick={() => void handleDelete(entry)} title={entry.kind === 'directory' ? '递归删除目录' : '删除'}><Icon name="trash" size={14} /></button>
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
      {nameDialog && (
        <div className="modal-overlay" onClick={() => !nameBusy && setNameDialog(null)}>
          <div className="modal glass" onClick={(event) => event.stopPropagation()}>
            <header className="modal-header">
              <div className="modal-title"><Icon name={nameDialog.mode === 'mkdir' ? 'plus' : 'edit'} size={17} />{nameDialog.mode === 'mkdir' ? '新建远程目录' : `重命名 ${nameDialog.target?.name ?? ''}`}</div>
              <button className="modal-close" onClick={() => setNameDialog(null)} disabled={nameBusy}><Icon name="x" size={15} /></button>
            </header>
            <div className="modal-body">
              {nameDialog.mode === 'mkdir' && <div className="section-tip">将在当前目录 {path} 下创建新目录。</div>}
              <label className="field">
                <span className="field-label">名称</span>
                <input className="glass-input" value={nameDialog.value} onChange={(event) => setNameDialog({ ...nameDialog, value: event.target.value })} autoFocus onKeyDown={(event) => { if (event.key === 'Enter' && !nameBusy) void submitNameDialog() }} />
              </label>
            </div>
            <footer className="modal-footer">
              <button className="glass-btn" onClick={() => setNameDialog(null)} disabled={nameBusy}>取消</button>
              <button className="glass-btn primary" onClick={() => void submitNameDialog()} disabled={nameBusy || !nameDialog.value.trim() || nameDialog.value.trim().includes('/')}>{nameBusy ? '处理中…' : '确认'}</button>
            </footer>
          </div>
        </div>
      )}
      {transfers.length > 0 && (
        <div className="sftp-transfers">
          {transfers.map((transfer) => {
            const percent = transfer.total > 0 ? Math.min(100, Math.round((transfer.transferred / transfer.total) * 100)) : 0
            return (
              <div className="sftp-transfer" key={transfer.id}>
                <Icon name={transfer.kind === 'upload' ? 'upload' : 'save'} size={14} />
                <div className="sftp-transfer-body">
                  <div className="sftp-transfer-meta">
                    <span className="sftp-transfer-name" title={transfer.name}>{transfer.name}</span>
                    <span>{formatBytes(transfer.transferred)} / {formatBytes(transfer.total)} · {percent}%</span>
                  </div>
                  <div className="metric-bar"><span style={{ width: `${percent}%` }} /></div>
                </div>
                <button className="host-icon-btn danger" onClick={() => requestCancel(transfer.id)} title="取消传输"><Icon name="x" size={13} /></button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}