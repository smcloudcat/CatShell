import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import {
  base64ToBytes,
  sftpChmod,
  sftpDiskDownloadPick,
  sftpDiskUploadPick,
  sftpDiskUploadStartToken,
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
import { beginTransfer, cancelFlags, removeTransfer, updateTransfer } from './sftpTransferStore'
import { SftpTransferList } from './SftpTransferList'
import { useSessions } from '../../store/sessions'
import { SftpEntry } from '../../types/session'
import { shellQuote } from '../../types/snippet'
import { formatBytes } from '../../utils/format'
import { recordAudit } from '../../store/audit'
import { confirmDialog } from '../../store/ui'
import { useT } from '../../i18n'

const SFTP_CHUNK_SIZE = 256 * 1024
const SFTP_CHUNKED_THRESHOLD = 16 * 1024 * 1024
const CANCELLED_MESSAGE = '已取消'
const CHMOD_PRESETS = ['644', '600', '755', '700', '777']

function parentPath(path: string): string {
  const normalized = path.replace(/\/+$|^$/, '') || '/'
  if (normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

function permissionText(mode: number): string {
  const bits = mode & 0o777
  const chars = ['r', 'w', 'x']
  let text = ''
  for (let shift = 6; shift >= 0; shift -= 3) {
    const triad = (bits >> shift) & 0o7
    for (let bit = 2; bit >= 0; bit -= 1) {
      text += (triad >> bit) & 1 ? chars[2 - bit] : '-'
    }
  }
  return text
}

function formatMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, '0')
}

function entryTitle(entry: SftpEntry): string {
  const parts: string[] = []
  if (entry.permissions !== null) parts.push(`权限 ${formatMode(entry.permissions)}（${permissionText(entry.permissions)}）`)
  if (entry.owner) parts.push(`属主 ${entry.owner}`)
  if (entry.group) parts.push(`组 ${entry.group}`)
  if (entry.modifiedAt) parts.push(`修改于 ${new Date(entry.modifiedAt * 1000).toLocaleString()}`)
  return parts.join(' · ')
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

type SftpSortKey = 'name' | 'size' | 'modifiedAt'

const SFTP_SORT_LABELS: Record<SftpSortKey, string> = {
  name: '按名称',
  size: '按大小',
  modifiedAt: '按修改时间'
}

export function SessionSftpPanel({ sessionId, onCollapse }: Props) {
  const t = useT()
  const sessions = useSessions((state) => state.sessions)
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<SftpEntry | null>(null)
  const [editorText, setEditorText] = useState('')
  const [editorBusy, setEditorBusy] = useState(false)
  const [nameDialog, setNameDialog] = useState<{ mode: 'mkdir' | 'rename' | 'move'; target: SftpEntry | null; value: string } | null>(null)
  const [nameBusy, setNameBusy] = useState(false)
  const [chmodDialog, setChmodDialog] = useState<{ target: SftpEntry; value: string } | null>(null)
  const [chmodBusy, setChmodBusy] = useState(false)
  const [sortKey, setSortKey] = useState<SftpSortKey>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [showHidden, setShowHidden] = useState(false)
  const [nameFilter, setNameFilter] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)

  const connected = sessions[sessionId]?.status === 'connected'
  const write = useSessions((state) => state.write)
  const terminals = useSessions((state) => state.terminals)

  const openInTerminal = async () => {
    setError(null)
    try {
      await write(sessionId, new TextEncoder().encode(`cd ${shellQuote(path)}\n`))
      terminals[sessionId]?.focus()
      recordAudit('sftp.open-in-terminal', path, 'success', t('在终端中打开此目录'))
    } catch (err) {
      recordAudit('sftp.open-in-terminal', path, 'failure', t('在终端中打开此目录失败'))
      setError(typeof err === 'string' ? err : t('发送 cd 命令失败'))
    }
  }

  const visibleEntries = useMemo(() => {
    const needle = nameFilter.trim().toLowerCase()
    const list = entries.filter((entry) => {
      if (!showHidden && entry.name.startsWith('.')) return false
      if (needle && !entry.name.toLowerCase().includes(needle)) return false
      return true
    })
    const dirFirst = (entry: SftpEntry) => (entry.kind === 'directory' ? 0 : 1)
    return list.sort((a, b) => {
      const dirDelta = dirFirst(a) - dirFirst(b)
      if (dirDelta !== 0) return dirDelta
      let delta: number
      if (sortKey === 'name') delta = a.name.localeCompare(b.name, 'zh-Hans-CN')
      else if (sortKey === 'size') delta = a.size - b.size
      else delta = (a.modifiedAt ?? -1) - (b.modifiedAt ?? -1)
      return sortAsc ? delta : -delta
    })
  }, [entries, sortKey, sortAsc, showHidden, nameFilter])

  const uploadChunked = async (target: string, file: File): Promise<void> => {
    const { transferId } = await sftpUploadBegin(sessionId, target, file.size)
    beginTransfer(sessionId, { id: transferId, name: file.name, kind: 'upload', transferred: 0, total: file.size })
    try {
      let offset = 0
      while (offset < file.size) {
        if (cancelFlags.has(transferId)) throw new Error(CANCELLED_MESSAGE)
        const slice = await file.slice(offset, Math.min(offset + SFTP_CHUNK_SIZE, file.size)).arrayBuffer()
        await sftpUploadChunk(transferId, offset, new Uint8Array(slice))
        offset += slice.byteLength
        updateTransfer(sessionId, transferId, offset)
      }
      await sftpUploadFinish(transferId)
      removeTransfer(sessionId, transferId)
    } catch (err) {
      removeTransfer(sessionId, transferId)
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
    beginTransfer(sessionId, { id: transferId, name: entry.name, kind: 'download', transferred: 0, total })
    const parts: BlobPart[] = []
    let received = 0
    try {
      for (;;) {
        if (cancelFlags.has(transferId)) throw new Error(CANCELLED_MESSAGE)
        const chunk = await sftpDownloadChunk(transferId)
        if (chunk.done) break
        const bytes = base64ToBytes(chunk.data)
        const copy = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(copy).set(bytes)
        parts.push(copy)
        received += bytes.length
        updateTransfer(sessionId, transferId, received)
      }
      const anchor = document.createElement('a')
      anchor.href = URL.createObjectURL(new Blob(parts))
      anchor.download = entry.name
      anchor.click()
      URL.revokeObjectURL(anchor.href)
      recordAudit('sftp.download', entry.path, 'success', t('分块下载文件'))
      setNotice(`${t('已下载 ')}${entry.name}`)
    } finally {
      removeTransfer(sessionId, transferId)
      try {
        await sftpTransferCancel(transferId)
      } catch {
        /* transfer already gone */
      }
    }
  }

  const handleDiskDownload = async (entry: SftpEntry) => {
    if (entry.kind !== 'file') return
    setError(null)
    try {
      const start = await sftpDiskDownloadPick(sessionId, entry.path, true)
      if (!start) return
      beginTransfer(sessionId, {
        id: start.transferId,
        name: entry.name,
        kind: 'download',
        transferred: 0,
        total: start.total,
        disk: true
      })
      recordAudit('sftp.disk-download', entry.path, 'success', start.resumed ? t('磁盘级下载（断点续传）') : t('磁盘级下载开始'))
    } catch (err) {
      recordAudit('sftp.disk-download', entry.path, 'failure', t('磁盘级下载启动失败'))
      setError(typeof err === 'string' ? err : t('磁盘级下载启动失败'))
    }
  }

  const handleDiskUpload = async () => {
    setError(null)
    try {
      const picks = await sftpDiskUploadPick(sessionId, path)
      if (!picks.length) return
      const existing = picks.filter((pick) => entries.some((entry) => entry.name === pick.fileName))
      let targets = picks
      if (existing.length) {
        const accepted = await confirmDialog({
          title: t('替换远端文件'),
          message: t('远端目录 ') + path + t(' 已存在同名文件：') + existing.map((pick) => pick.fileName).join('、') + t('。上传将在传输完成后替换这些文件；同名半成品存在时从断点续传。继续？'),
          confirmLabel: t('继续上传'),
          danger: true
        })
        if (!accepted) {
          targets = picks.filter((pick) => !existing.some((item) => item.token === pick.token))
        }
      }
      let started = 0
      for (const pick of targets) {
        try {
          const start = await sftpDiskUploadStartToken(sessionId, pick.token, true)
          beginTransfer(sessionId, {
            id: start.transferId,
            name: pick.fileName,
            kind: 'upload',
            transferred: 0,
            total: start.total,
            disk: true
          })
          recordAudit('sftp.disk-upload', pick.remotePath, 'success', start.resumed ? t('磁盘级上传（断点续传）') : t('磁盘级上传开始'))
          started += 1
        } catch (err) {
          recordAudit('sftp.disk-upload', pick.remotePath, 'failure', t('磁盘级上传启动失败'))
          setError(typeof err === 'string' ? err : `${t('磁盘级上传启动失败：')}${pick.fileName}`)
        }
      }
      if (started > 0) setNotice(`${t('磁盘级上传已开始 ')}${started}${t(' 个文件')}`)
    } catch (err) {
      setError(typeof err === 'string' ? err : t('磁盘级上传失败'))
    }
  }

  const loadDirectory = async (nextPath?: string) => {
    const target = nextPath ?? path
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setEntries(await sftpList(sessionId, target))
      recordAudit('sftp.list', target, 'success', t('读取远程目录'))
      setPath(target)
    } catch (err) {
      recordAudit('sftp.list', target, 'failure', t('读取远程目录失败'))
      setError(typeof err === 'string' ? err : t('无法读取远程目录'))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (connected) void loadDirectory()
    // Directory loading is intentionally triggered only when the session changes.
  }, [sessionId, connected])

  const uploadFiles = async (files: File[]) => {
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
            title: t('覆盖远程文件'),
            message: t('远程目录 ') + path + t(' 已存在同名文件“') + file.name + t('”，上传将覆盖其内容。'),
            confirmLabel: t('覆盖'),
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
            recordAudit('sftp.upload', target, 'success', t('分块上传文件'))
            uploaded += 1
            continue
          }
          const attempts = await uploadWithRetry(target, new Uint8Array(await file.arrayBuffer()), (filePath, data) => sftpWriteFile(sessionId, filePath, data))
          if (attempts > 1) retried += 1
          recordAudit('sftp.upload', target, 'success', attempts > 1 ? `${t('上传文件，第 ')}${attempts}${t(' 次尝试成功')}` : t('上传文件'))
          uploaded += 1
        } catch (err) {
          if (err instanceof Error && err.message === CANCELLED_MESSAGE) {
            recordAudit('sftp.upload', target, 'failure', t('上传已取消'))
            skipped += 1
          } else {
            recordAudit('sftp.upload', target, 'failure', t('上传文件失败'))
            failed.push(file.name)
          }
        }
      }
      recordAudit('sftp.batch-upload', `${uploaded}/${files.length}`, failed.length ? 'failure' : 'success', `${t('批量上传完成，重试成功 ')}${retried}${t(' 个，失败 ')}${failed.length}${t(' 个，跳过 ')}${skipped}${t(' 个')}`)
      const parts = [`${t('已上传 ')}${uploaded}/${files.length}${t(' 个文件')}`]
      if (skipped) parts.push(`${t('跳过 ')}${skipped}${t(' 个')}`)
      if (failed.length) parts.push(`${t('失败：')}${failed.join('、')}`)
      setNotice(parts.join(t('，')))
      await loadDirectory(path)
    } catch (err) {
      setError(typeof err === 'string' ? err : t('上传失败'))
    } finally {
      setBusy(false)
    }
  }

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    await uploadFiles(files)
  }

  const handleDropUpload = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    if (!connected || busy) return
    const files = Array.from(event.dataTransfer?.files ?? [])
    void uploadFiles(files)
  }

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!connected || busy) return
    event.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }

  const handleDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragOver(false)
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
      setError(t('无法作为 UTF-8 文本打开该文件，请使用下载操作处理二进制文件。'))
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
      recordAudit('sftp.edit', editing.path, 'success', t('编辑并回传远程文件'))
      setNotice(`${t('已保存 ')}${editing.name}`)
      setEditing(null)
      await loadDirectory(path)
    } catch (err) {
      recordAudit('sftp.edit', editing.path, 'failure', t('编辑远程文件失败'))
      setError(typeof err === 'string' ? err : t('保存远程文件失败'))
    } finally {
      setEditorBusy(false)
    }
  }

  const handleDownload = async (entry: SftpEntry) => {
    if (entry.kind !== 'file') return
    if (entry.size > SFTP_CHUNKED_THRESHOLD) {
      if ('__TAURI_INTERNALS__' in window) {
        await handleDiskDownload(entry)
        return
      }
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
      recordAudit('sftp.download', entry.path, 'success', t('下载文件'))
      const downloadBuffer = new ArrayBuffer(data.byteLength)
      new Uint8Array(downloadBuffer).set(data)
      const anchor = document.createElement('a')
      anchor.href = URL.createObjectURL(new Blob([downloadBuffer]))
      anchor.download = entry.name
      anchor.click()
      URL.revokeObjectURL(anchor.href)
      setNotice(`${t('已下载 ')}${entry.name}`)
    } catch (err) {
      recordAudit('sftp.download', entry.path, 'failure', t('下载文件失败'))
      setError(typeof err === 'string' ? err : t('下载失败'))
    } finally {
      setBusy(false)
    }
  }

  const joinRemotePath = (dir: string, name: string): string => {
    const normalized = dir === '/' ? '' : dir.replace(/\/+$/, '')
    return `${normalized}/${name}`
  }

  const submitMoveDialog = async () => {
    if (!nameDialog || nameDialog.mode !== 'move' || !nameDialog.target) return
    const entry = nameDialog.target
    const dir = nameDialog.value.trim()
    if (!dir.startsWith('/') || dir.includes('//')) {
      setError(t('目标目录必须是绝对路径（以 / 开头）'))
      return
    }
    const target = joinRemotePath(dir.replace(/\/+$/, '') || '/', entry.name)
    if (target === entry.path) {
      setError(t('目标目录与当前位置相同'))
      return
    }
    if (entry.kind === 'directory' && (target.startsWith(`${entry.path}/`) || entry.path === dir.replace(/\/+$/, ''))) {
      setError(t('不能把目录移动到其自身或其子目录中'))
      return
    }
    setNameBusy(true)
    setError(null)
    try {
      await sftpRename(sessionId, entry.path, target)
      recordAudit('sftp.move', `${entry.path} -> ${target}`, 'success', t('移动远程文件'))
      setNotice(`${t('已移动到 ')}${dir}`)
      setNameDialog(null)
      await loadDirectory(path)
    } catch (err) {
      recordAudit('sftp.move', entry.path, 'failure', t('移动远程文件失败'))
      setError(typeof err === 'string' ? err : t('移动失败'))
    } finally {
      setNameBusy(false)
    }
  }

  const submitChmodDialog = async () => {
    if (!chmodDialog) return
    const raw = chmodDialog.value.trim()
    if (!/^[0-7]{3,4}$/.test(raw)) {
      setError(t('权限必须是 3~4 位八进制数字，例如 644'))
      return
    }
    setChmodBusy(true)
    setError(null)
    try {
      const mode = parseInt(raw, 8)
      await sftpChmod(sessionId, chmodDialog.target.path, mode)
      recordAudit('sftp.chmod', `${chmodDialog.target.path} -> ${formatMode(mode)}`, 'success', t('修改远程文件权限'))
      setNotice(`${t('已将 ')}${chmodDialog.target.name}${t(' 权限修改为 ')}${raw}`)
      setChmodDialog(null)
      await loadDirectory(path)
    } catch (err) {
      recordAudit('sftp.chmod', chmodDialog.target.path, 'failure', t('修改远程文件权限失败'))
      setError(typeof err === 'string' ? err : t('修改权限失败'))
    } finally {
      setChmodBusy(false)
    }
  }

  const submitNameDialog = async () => {
    if (!nameDialog) return
    if (nameDialog.mode === 'move') {
      await submitMoveDialog()
      return
    }
    const value = nameDialog.value.trim()
    if (!value || value.includes('/')) return
    setNameBusy(true)
    setError(null)
    try {
      if (nameDialog.mode === 'mkdir') {
        const target = path === '/' ? `/${value}` : `${path.replace(/\/$/, '')}/${value}`
        await sftpMkdir(sessionId, target)
        recordAudit('sftp.mkdir', target, 'success', t('创建远程目录'))
        setNotice(`${t('已创建目录 ')}${value}`)
      } else if (nameDialog.target) {
        const parent = nameDialog.target.path.slice(0, nameDialog.target.path.lastIndexOf('/'))
        const target = parent === '' ? `/${value}` : `${parent}/${value}`
        await sftpRename(sessionId, nameDialog.target.path, target)
        recordAudit('sftp.rename', `${nameDialog.target.path} -> ${target}`, 'success', t('重命名远程文件'))
        setNotice(`${t('已重命名为 ')}${value}`)
      }
      setNameDialog(null)
      await loadDirectory(path)
    } catch (err) {
      recordAudit(nameDialog.mode === 'mkdir' ? 'sftp.mkdir' : 'sftp.rename', nameDialog.mode === 'rename' && nameDialog.target ? nameDialog.target.path : path, 'failure', t('远程操作失败'))
      setError(typeof err === 'string' ? err : t('远程操作失败'))
    } finally {
      setNameBusy(false)
    }
  }

  const handleDelete = async (entry: SftpEntry) => {
    if (entry.kind !== 'file' && entry.kind !== 'directory') return
    if (entry.kind === 'directory') {
      const accepted = await confirmDialog({
        title: t('递归删除远程目录'),
        message: t('目录“') + entry.name + t('”及其全部子目录和文件将被删除，该操作不可恢复。确认继续？'),
        confirmLabel: t('全部删除'),
        danger: true
      })
      if (!accepted) return
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        await sftpRemoveDir(sessionId, entry.path)
        recordAudit('sftp.rmdir', entry.path, 'success', t('递归删除远程目录'))
        setNotice(`${t('已删除目录 ')}${entry.name}`)
        await loadDirectory(path)
      } catch (err) {
        recordAudit('sftp.rmdir', entry.path, 'failure', t('递归删除远程目录失败'))
        setError(typeof err === 'string' ? err : t('递归删除目录失败'))
      } finally {
        setBusy(false)
      }
      return
    }
    const accepted = await confirmDialog({
      title: t('删除远程文件'),
      message: t('确认删除远程文件“') + entry.name + t('”？该操作不可恢复。'),
      confirmLabel: t('删除'),
      danger: true
    })
    if (!accepted) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await sftpRemoveFile(sessionId, entry.path)
      recordAudit('sftp.delete', entry.path, 'success', t('删除文件'))
      setNotice(`${t('已删除 ')}${entry.name}`)
      await loadDirectory(path)
    } catch (err) {
      recordAudit('sftp.delete', entry.path, 'failure', t('删除文件失败'))
      setError(typeof err === 'string' ? err : t('删除失败'))
      setBusy(false)
    }
  }

  if (!connected) {
    return (
      <div className="sftp-empty">
        <Icon name="folder" size={44} />
        <p>{t('会话未连接，连接成功后即可在此浏览和传输远程文件。')}</p>
      </div>
    )
  }

  return (
    <div
      className={`sftp-panel-body ${dragOver ? 'drag-over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={handleDropUpload}
    >
      {dragOver && <div className="sftp-drop-hint">{t('松开以上传到 ')}{path}</div>}
      <div className="sftp-toolbar">
        <Icon name="folder" size={15} />
        <span className="sftp-heading">{t('SFTP 文件')}</span>
        {onCollapse && <button className="host-icon-btn" onClick={onCollapse} title={t('折叠面板')}><Icon name="chevron-down" size={14} /></button>}
        <button className="glass-btn" onClick={() => void loadDirectory()} disabled={busy} title={t('刷新目录')}><Icon name="refresh" size={15} /></button>
        <button className="glass-btn" onClick={() => setNameDialog({ mode: 'mkdir', target: null, value: '' })} title={t('新建目录')}><Icon name="plus" size={15} /></button>
        <label className="glass-btn primary">
          <Icon name="upload" size={15} />
          {t('上传文件')}
          <input className="sr-only" type="file" multiple onChange={handleUpload} disabled={busy} />
        </label>
        <button className="glass-btn" onClick={() => void handleDiskUpload()} disabled={busy} title={t('磁盘级上传：本地文件经 Rust 直传远端，支持断点续传')}><Icon name="save" size={15} /></button>
      </div>
      <div className="sftp-pathbar">
        <button className="host-icon-btn" onClick={() => void loadDirectory(parentPath(path))} disabled={path === '/'} title={t('返回上级')}><Icon name="chevron-down" size={15} /></button>
        <code>{path}</code>
        <button className="host-icon-btn" onClick={() => void openInTerminal()} title={t('在终端中打开此目录（发送 cd 命令）')}><Icon name="terminal" size={15} /></button>
      </div>
      <div className="sftp-filterbar">
        <select
          className="glass-input sftp-sort-select"
          value={sortKey}
          onChange={(event) => setSortKey(event.target.value as SftpSortKey)}
          title={t('排序方式')}
        >
          {(Object.keys(SFTP_SORT_LABELS) as SftpSortKey[]).map((key) => (
            <option key={key} value={key}>{t(SFTP_SORT_LABELS[key])}</option>
          ))}
        </select>
        <button
          className="host-icon-btn"
          onClick={() => setSortAsc((current) => !current)}
          title={sortAsc ? t('当前升序，点击切换为降序') : t('当前降序，点击切换为升序')}
        >
          <Icon name={sortAsc ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>
        <button
          className={`host-icon-btn ${showHidden ? 'active' : ''}`}
          onClick={() => setShowHidden((current) => !current)}
          title={showHidden ? t('显示隐藏文件中，点击隐藏') : t('显示以 . 开头的隐藏文件')}
        >
          <Icon name={showHidden ? 'eye' : 'eye-off'} size={14} />
        </button>
        <input
          className="glass-input sftp-filter-input"
          placeholder={t('筛选当前目录')}
          value={nameFilter}
          onChange={(event) => setNameFilter(event.target.value)}
        />
      </div>
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="form-notice">{notice}</div>}
      <div className="sftp-table-head"><span>{t('名称')}</span><span>{t('类型')}</span><span>{t('大小')}</span><span>{t('操作')}</span></div>
      <div className="sftp-entries">
        {visibleEntries.map((entry) => (
          <div className="sftp-entry" key={entry.path}>
            <button className="sftp-name" onClick={() => entry.kind === 'directory' ? void loadDirectory(entry.path) : void handleDownload(entry)}>
              <Icon name={entry.kind === 'directory' ? 'folder' : 'save'} size={15} />
              <span>{entry.name}</span>
            </button>
            <span title={entryTitle(entry)}>{entry.kind === 'directory' ? t('目录') : entry.kind === 'symlink' ? t('链接') : t('文件')}</span>
            <span>{entry.kind === 'file' ? formatBytes(entry.size) : '-'}</span>
            <span className="sftp-actions">
              {entry.kind === 'file' && <button className="host-icon-btn" onClick={() => void handleDownload(entry)} title={t('下载')}><Icon name="save" size={14} /></button>}
              {entry.kind === 'file' && <button className="host-icon-btn" onClick={() => void openEditor(entry)} title={t('编辑文本文件')}><Icon name="settings" size={14} /></button>}
              <button className="host-icon-btn" onClick={() => setNameDialog({ mode: 'rename', target: entry, value: entry.name })} title={t('重命名')}><Icon name="edit" size={14} /></button>
              <button className="host-icon-btn" onClick={() => setNameDialog({ mode: 'move', target: entry, value: path })} title={t('移动到其他目录')}><Icon name="arrow-right" size={14} /></button>
              {(entry.kind === 'file' || entry.kind === 'directory') && entry.permissions !== null && (
                <button className="host-icon-btn" onClick={() => setChmodDialog({ target: entry, value: formatMode(entry.permissions ?? 0o644) })} title={t('修改权限（chmod）')}><Icon name="key" size={14} /></button>
              )}
              <button className="host-icon-btn danger" onClick={() => void handleDelete(entry)} title={entry.kind === 'directory' ? t('递归删除目录') : t('删除')}><Icon name="trash" size={14} /></button>
            </span>
          </div>
        ))}
        {!busy && visibleEntries.length === 0 && <div className="sftp-empty">{entries.length ? t('没有匹配的文件') : t('目录为空')}</div>}
        {busy && <div className="sftp-empty">{t('读取中…')}</div>}
      </div>
      {editing && (
        <div className="modal-overlay" onClick={() => !editorBusy && setEditing(null)}>
          <div className="modal glass sftp-editor-modal" onClick={(event) => event.stopPropagation()}>
            <header className="modal-header"><div className="modal-title"><Icon name="settings" size={17} />{t('编辑 ')}{editing.name}</div><button className="modal-close" onClick={() => setEditing(null)} disabled={editorBusy}><Icon name="x" size={15} /></button></header>
            <div className="modal-body sftp-editor-body"><textarea className="glass-input sftp-editor" value={editorText} onChange={(event) => setEditorText(event.target.value)} spellCheck={false} autoFocus /></div>
            <footer className="modal-footer"><button className="glass-btn" onClick={() => setEditing(null)} disabled={editorBusy}>{t('取消')}</button><button className="glass-btn primary" onClick={() => void saveEditor()} disabled={editorBusy}>{editorBusy ? t('保存中…') : t('保存并回传')}</button></footer>
          </div>
        </div>
      )}
      {nameDialog && (
        <div className="modal-overlay" onClick={() => !nameBusy && setNameDialog(null)}>
          <div className="modal glass" onClick={(event) => event.stopPropagation()}>
            <header className="modal-header">
              <div className="modal-title"><Icon name={nameDialog.mode === 'mkdir' ? 'plus' : nameDialog.mode === 'move' ? 'arrow-right' : 'edit'} size={17} />{nameDialog.mode === 'mkdir' ? t('新建远程目录') : nameDialog.mode === 'move' ? `${t('移动 ')}${nameDialog.target?.name ?? ''}` : `${t('重命名 ')}${nameDialog.target?.name ?? ''}`}</div>
              <button className="modal-close" onClick={() => setNameDialog(null)} disabled={nameBusy}><Icon name="x" size={15} /></button>
            </header>
            <div className="modal-body">
              {nameDialog.mode === 'mkdir' && <div className="section-tip">{t('将在当前目录 ')}{path}{t(' 下创建新目录。')}</div>}
              {nameDialog.mode === 'move' && <div className="section-tip">{t('输入目标目录的绝对路径，文件将移动到该目录下并保持原文件名。')}</div>}
              <label className="field">
                <span className="field-label">{nameDialog.mode === 'move' ? t('目标目录') : t('名称')}</span>
                <input
                  className="glass-input"
                  value={nameDialog.value}
                  onChange={(event) => setNameDialog({ ...nameDialog, value: event.target.value })}
                  autoFocus
                  onKeyDown={(event) => { if (event.key === 'Enter' && !nameBusy) void submitNameDialog() }}
                />
              </label>
            </div>
            <footer className="modal-footer">
              <button className="glass-btn" onClick={() => setNameDialog(null)} disabled={nameBusy}>{t('取消')}</button>
              {nameDialog.mode === 'move' ? (
                <button className="glass-btn primary" onClick={() => void submitNameDialog()} disabled={nameBusy || !nameDialog.value.trim()}>{nameBusy ? t('处理中…') : t('移动')}</button>
              ) : (
                <button className="glass-btn primary" onClick={() => void submitNameDialog()} disabled={nameBusy || !nameDialog.value.trim() || nameDialog.value.trim().includes('/')}>{nameBusy ? t('处理中…') : t('确认')}</button>
              )}
            </footer>
          </div>
        </div>
      )}
      {chmodDialog && (
        <div className="modal-overlay" onClick={() => !chmodBusy && setChmodDialog(null)}>
          <div className="modal glass" onClick={(event) => event.stopPropagation()}>
            <header className="modal-header">
              <div className="modal-title"><Icon name="key" size={17} />{t('修改权限 ')}{chmodDialog.target.name}</div>
              <button className="modal-close" onClick={() => setChmodDialog(null)} disabled={chmodBusy}><Icon name="x" size={15} /></button>
            </header>
            <div className="modal-body">
              <div className="section-tip">
                {t('当前权限：')}{formatMode(chmodDialog.target.permissions ?? 0)}（{permissionText(chmodDialog.target.permissions ?? 0)}）
                {chmodDialog.target.owner && <> · {t('属主 ')}{chmodDialog.target.owner}</>}
                {chmodDialog.target.group && <> / {t('组 ')}{chmodDialog.target.group}</>}
              </div>
              <label className="field">
                <span className="field-label">{t('八进制权限（3~4 位，例如 644）')}</span>
                <input
                  className="glass-input"
                  value={chmodDialog.value}
                  onChange={(event) => setChmodDialog({ ...chmodDialog, value: event.target.value })}
                  autoFocus
                  onKeyDown={(event) => { if (event.key === 'Enter' && !chmodBusy) void submitChmodDialog() }}
                />
              </label>
              <div className="chmod-presets">
                {CHMOD_PRESETS.map((preset) => (
                  <button key={preset} className="glass-btn" onClick={() => setChmodDialog({ ...chmodDialog, value: preset })}>
                    {preset}
                  </button>
                ))}
              </div>
            </div>
            <footer className="modal-footer">
              <button className="glass-btn" onClick={() => setChmodDialog(null)} disabled={chmodBusy}>{t('取消')}</button>
              <button className="glass-btn primary" onClick={() => void submitChmodDialog()} disabled={chmodBusy}>{chmodBusy ? t('处理中…') : t('应用')}</button>
            </footer>
          </div>
        </div>
      )}
      <SftpTransferList sessionId={sessionId} />
    </div>
  )
}