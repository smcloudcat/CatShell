import { useEffect, useMemo, useRef, useState } from 'react'
import {
  sftpChmod,
  sftpDiskDownloadPick,
  sftpDiskUploadPick,
  sftpDiskUploadStartToken,
  sftpList,
  sftpMkdir,
  sftpReadFile,
  sftpRemoveDir,
  sftpRemoveFile,
  sftpRename,
  sftpWriteFile
} from '../../api/ssh'
import { Icon } from '../../components/Icon'
import { beginTransfer } from './sftpTransferStore'
import { SftpTransferList } from './SftpTransferList'
import { useSessions } from '../../store/sessions'
import { SftpEntry } from '../../types/session'
import { shellQuote } from '../../types/snippet'
import { recordAudit } from '../../store/audit'
import { bindTransfer, enqueueDiskTransfer } from '../../store/transferQueue'
import { confirmDialog } from '../../store/ui'
import { useT } from '../../i18n'
import { errorText } from '../../i18n/errors'
import { SftpToolbar } from './SftpToolbar'
import { SftpQueueResume } from './SftpQueueResume'
import { SftpEntryList } from './SftpEntryList'
import type { SftpEntryActions } from './SftpEntryList'
import { SftpDropZone } from './SftpDropZone'
import { SftpEditorModal } from './SftpEditorModal'
import { SftpChmodDialog } from './SftpChmodDialog'
import { SftpNameDialog, SftpNameDialogState } from './SftpNameDialog'
import { SftpSyncDialog } from './SftpSyncDialog'
import { downloadChunkedFile, isCancellation, uploadChunkedFile } from './sftpTransferOps'
import {
  SFTP_CHUNKED_THRESHOLD,
  SftpSortKey,
  formatMode,
  isValidRemoteName,
  joinNames,
  joinRemotePath,
  parentPath,
  parseChmodInput,
  resolveMoveTarget,
  triggerDownload,
  uploadWithRetry,
  visibleEntries
} from './sftpUtils'

interface Props {
  sessionId: number
  onCollapse?: () => void
}

/**
 * SFTP 面板的编排层。
 *
 * 展示层已拆到 `SftpToolbar` / `SftpEntryList` / `SftpDropZone` 与三个弹窗组件，
 * 纯函数在 `sftpUtils`，分块传输循环在 `sftpTransferOps`。
 * 这里只保留：目录状态、与 Tauri command 的交互、审计与用户反馈的编排。
 */
export function SessionSftpPanel({ sessionId, onCollapse }: Props) {
  const t = useT()
  const sessions = useSessions((state) => state.sessions)
  const write = useSessions((state) => state.write)
  const terminals = useSessions((state) => state.terminals)

  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [editor, setEditor] = useState<{ entry: SftpEntry; text: string } | null>(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const [nameDialog, setNameDialog] = useState<SftpNameDialogState | null>(null)
  const [nameBusy, setNameBusy] = useState(false)
  const [chmodDialog, setChmodDialog] = useState<{ target: SftpEntry; value: string } | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const [chmodBusy, setChmodBusy] = useState(false)

  const [sortKey, setSortKey] = useState<SftpSortKey>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [showHidden, setShowHidden] = useState(false)
  const [nameFilter, setNameFilter] = useState('')

  const connected = sessions[sessionId]?.status === 'connected'
  const hostId = useSessions((state) => state.hostIds[sessionId]) ?? ''
  const shown = useMemo(
    () => visibleEntries(entries, { nameFilter, showHidden, sortKey, sortAsc }),
    [entries, nameFilter, showHidden, sortKey, sortAsc]
  )

  /** 把 command 抛出的错误转成可展示文案；AppError 走错误码映射，其余原样。 */
  const asMessage = (err: unknown, fallback: string): string => errorText(err, t, fallback)

  const loadSeqRef = useRef(0)
  const disposedRef = useRef(false)
  useEffect(() => {
    // React StrictMode（dev）会执行 mount → cleanup → mount 序列：cleanup 把
    // disposedRef 置 true 后不会自动复位，重挂载阶段必须显式复位。否则 dev 模式下
    // 目录响应全部被当「已卸载」丢弃，busy 永不解除，面板永远停在加载中。
    disposedRef.current = false
    // 组件以 key={activeId} 重挂载，卸载后丢弃 in-flight 响应。
    return () => {
      disposedRef.current = true
    }
  }, [])

  const loadDirectory = async (nextPath?: string) => {
    const target = nextPath ?? path
    // 目录列表竞态保护（审计 B-1）：快速连续切换目录时只采纳最新请求的响应，
    // 防止先发出、后返回的旧响应把 entries 和 path 一起覆盖回旧目录。
    const seq = ++loadSeqRef.current
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const list = await sftpList(sessionId, target)
      if (disposedRef.current || seq !== loadSeqRef.current) return
      setEntries(list)
      recordAudit('sftp.list', target, 'success', t('读取远程目录'))
      setPath(target)
    } catch (err) {
      if (disposedRef.current || seq !== loadSeqRef.current) return
      recordAudit('sftp.list', target, 'failure', t('读取远程目录失败'))
      setError(asMessage(err, t('无法读取远程目录')))
    } finally {
      if (!disposedRef.current && seq === loadSeqRef.current) setBusy(false)
    }
  }

  useEffect(() => {
    if (connected) void loadDirectory()
    // 仅在会话或连接状态变化时重新拉取目录；路径切换由显式调用 loadDirectory 驱动。
  }, [sessionId, connected])

  // 同步完成回调走 ref 转发并保持引用稳定（审计 P-7b）：
  // 内联箭头函数会让 SftpSyncDialog 在父组件每次渲染时退订/重订 sftp-sync-progress 事件。
  const syncFinishedRef = useRef<() => void>(() => {})
  syncFinishedRef.current = () => void loadDirectory()
  const handleSyncFinished = useMemo(() => () => syncFinishedRef.current(), [])

  const openInTerminal = async () => {
    setError(null)
    try {
      await write(sessionId, new TextEncoder().encode(`cd ${shellQuote(path)}\n`))
      terminals[sessionId]?.focus()
      recordAudit('sftp.open-in-terminal', path, 'success', t('在终端中打开此目录'))
    } catch (err) {
      recordAudit('sftp.open-in-terminal', path, 'failure', t('在终端中打开此目录失败'))
      setError(asMessage(err, t('发送 cd 命令失败')))
    }
  }

  // ------------------------------------------------------------------
  // 上传
  // ------------------------------------------------------------------

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
      // 目录列表可能已经过期，重新拉一份用来判断同名覆盖。拉取失败必须中止：
      // 退化为「当作空目录」会让同名文件跳过覆盖确认直接覆盖远端文件（审计 B-5）。
      let existingNames: Set<string>
      try {
        existingNames = new Set((await sftpList(sessionId, path)).map((entry) => entry.name))
      } catch (err) {
        recordAudit('sftp.batch-upload', path, 'failure', t('同名检查目录列表拉取失败，已中止上传'))
        setError(asMessage(err, t('无法确认远端同名文件（目录列表拉取失败），已中止上传以防误覆盖')))
        return
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
        const target = joinRemotePath(path, file.name)
        try {
          if (file.size > SFTP_CHUNKED_THRESHOLD) {
            await uploadChunkedFile(sessionId, target, file)
            recordAudit('sftp.upload', target, 'success', t('分块上传文件'))
            uploaded += 1
            continue
          }
          const attempts = await uploadWithRetry(
            target,
            new Uint8Array(await file.arrayBuffer()),
            (filePath, data) => sftpWriteFile(sessionId, filePath, data)
          )
          if (attempts > 1) retried += 1
          recordAudit('sftp.upload', target, 'success', attempts > 1 ? `${t('上传文件，第 ')}${attempts}${t(' 次尝试成功')}` : t('上传文件'))
          uploaded += 1
        } catch (err) {
          if (isCancellation(err)) {
            recordAudit('sftp.upload', target, 'failure', t('上传已取消'))
            skipped += 1
          } else {
            recordAudit('sftp.upload', target, 'failure', t('上传文件失败'))
            failed.push(file.name)
          }
        }
      }
      recordAudit(
        'sftp.batch-upload',
        `${uploaded}/${files.length}`,
        failed.length ? 'failure' : 'success',
        `${t('批量上传完成，重试成功 ')}${retried}${t(' 个，失败 ')}${failed.length}${t(' 个，跳过 ')}${skipped}${t(' 个')}`
      )
      const parts = [`${t('已上传 ')}${uploaded}/${files.length}${t(' 个文件')}`]
      if (skipped) parts.push(`${t('跳过 ')}${skipped}${t(' 个')}`)
      if (failed.length) parts.push(`${t('失败：')}${joinNames(failed)}`)
      setNotice(parts.join(t('，')))
      await loadDirectory(path)
    } catch (err) {
      setError(asMessage(err, t('上传失败')))
    } finally {
      setBusy(false)
    }
  }

  /** 磁盘级上传：本地文件由 Rust 直接推远端，支持断点续传。 */
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
          message: t('远端目录 ') + path + t(' 已存在同名文件：') + joinNames(existing.map((pick) => pick.fileName)) + t('。上传将在传输完成后替换这些文件；同名半成品存在时从断点续传。继续？'),
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
          if (hostId) {
            bindTransfer(start.transferId, enqueueDiskTransfer({
              hostId,
              direction: 'upload',
              fileName: pick.fileName,
              remotePath: pick.remotePath,
              localPath: start.localPath,
              total: start.total
            }))
          }
          recordAudit('sftp.disk-upload', pick.remotePath, 'success', start.resumed ? t('磁盘级上传（断点续传）') : t('磁盘级上传开始'))
          started += 1
        } catch (err) {
          recordAudit('sftp.disk-upload', pick.remotePath, 'failure', t('磁盘级上传启动失败'))
          setError(asMessage(err, `${t('磁盘级上传启动失败：')}${pick.fileName}`))
        }
      }
      if (started > 0) setNotice(`${t('磁盘级上传已开始 ')}${started}${t(' 个文件')}`)
    } catch (err) {
      setError(asMessage(err, t('磁盘级上传失败')))
    }
  }

  // ------------------------------------------------------------------
  // 下载
  // ------------------------------------------------------------------

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
      if (hostId) {
        bindTransfer(start.transferId, enqueueDiskTransfer({
          hostId,
          direction: 'download',
          fileName: entry.name,
          remotePath: entry.path,
          localPath: start.localPath,
          total: start.total
        }))
      }
      recordAudit('sftp.disk-download', entry.path, 'success', start.resumed ? t('磁盘级下载（断点续传）') : t('磁盘级下载开始'))
    } catch (err) {
      recordAudit('sftp.disk-download', entry.path, 'failure', t('磁盘级下载启动失败'))
      setError(asMessage(err, t('磁盘级下载启动失败')))
    }
  }

  const handleDownload = async (entry: SftpEntry) => {
    if (entry.kind !== 'file') return
    if (entry.size > SFTP_CHUNKED_THRESHOLD) {
      // 桌面端优先走磁盘直传（可断点续传、不进内存）；浏览器回退到分块 + Blob。
      if ('__TAURI_INTERNALS__' in window) {
        await handleDiskDownload(entry)
        return
      }
      setError(null)
      try {
        const blob = await downloadChunkedFile(sessionId, entry)
        triggerDownload(blob, entry.name)
        recordAudit('sftp.download', entry.path, 'success', t('分块下载文件'))
        setNotice(`${t('已下载 ')}${entry.name}`)
      } catch (err) {
        if (!isCancellation(err)) {
          recordAudit('sftp.download', entry.path, 'failure', t('分块下载失败'))
          setError(asMessage(err, t('下载失败')))
        }
      }
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const data = await sftpReadFile(sessionId, entry.path)
      const buffer = new ArrayBuffer(data.byteLength)
      new Uint8Array(buffer).set(data)
      triggerDownload(new Blob([buffer]), entry.name)
      recordAudit('sftp.download', entry.path, 'success', t('下载文件'))
      setNotice(`${t('已下载 ')}${entry.name}`)
    } catch (err) {
      recordAudit('sftp.download', entry.path, 'failure', t('下载文件失败'))
      setError(asMessage(err, t('下载失败')))
    } finally {
      setBusy(false)
    }
  }

  // ------------------------------------------------------------------
  // 编辑
  // ------------------------------------------------------------------

  const openEditor = async (entry: SftpEntry) => {
    if (entry.kind !== 'file') return
    setBusy(true)
    setError(null)
    let data: Uint8Array
    try {
      // 读取与解码分开捕获（审计 R-6）：网络/权限失败不应误报成「非 UTF-8 文件」。
      data = await sftpReadFile(sessionId, entry.path)
    } catch (err) {
      recordAudit('sftp.read', entry.path, 'failure', t('读取远程文件'))
      setError(asMessage(err, t('读取远程文件失败')))
      setBusy(false)
      return
    }
    try {
      setEditor({ entry, text: new TextDecoder('utf-8', { fatal: true }).decode(data) })
    } catch {
      setError(t('无法作为 UTF-8 文本打开该文件，请使用下载操作处理二进制文件。'))
    } finally {
      setBusy(false)
    }
  }

  const saveEditor = async () => {
    if (!editor) return
    setEditorBusy(true)
    setError(null)
    try {
      await sftpWriteFile(sessionId, editor.entry.path, new TextEncoder().encode(editor.text))
      recordAudit('sftp.edit', editor.entry.path, 'success', t('编辑并回传远程文件'))
      setNotice(`${t('已保存 ')}${editor.entry.name}`)
      setEditor(null)
      await loadDirectory(path)
    } catch (err) {
      recordAudit('sftp.edit', editor.entry.path, 'failure', t('编辑远程文件失败'))
      setError(asMessage(err, t('保存远程文件失败')))
    } finally {
      setEditorBusy(false)
    }
  }

  // ------------------------------------------------------------------
  // 目录项操作
  // ------------------------------------------------------------------

  const submitMove = async (state: SftpNameDialogState) => {
    const entry = state.target
    if (!entry) return
    const verdict = resolveMoveTarget(entry, state.value)
    if (!verdict.ok) {
      setError(
        verdict.reason === 'invalid'
          ? t('目标目录必须是绝对路径（以 / 开头）')
          : verdict.reason === 'same'
            ? t('目标目录与当前位置相同')
            : t('不能把目录移动到其自身或其子目录中')
      )
      return
    }
    setNameBusy(true)
    setError(null)
    try {
      await sftpRename(sessionId, entry.path, verdict.target)
      recordAudit('sftp.move', `${entry.path} -> ${verdict.target}`, 'success', t('移动远程文件'))
      setNotice(`${t('已移动到 ')}${state.value.trim()}`)
      setNameDialog(null)
      await loadDirectory(path)
    } catch (err) {
      recordAudit('sftp.move', entry.path, 'failure', t('移动远程文件失败'))
      setError(asMessage(err, t('移动失败')))
    } finally {
      setNameBusy(false)
    }
  }

  const submitNameDialog = async () => {
    const state = nameDialog
    if (!state) return
    if (state.mode === 'move') {
      await submitMove(state)
      return
    }
    if (!isValidRemoteName(state.value)) return
    const name = state.value.trim()
    setNameBusy(true)
    setError(null)
    try {
      if (state.mode === 'mkdir') {
        const target = joinRemotePath(path, name)
        await sftpMkdir(sessionId, target)
        recordAudit('sftp.mkdir', target, 'success', t('创建远程目录'))
        setNotice(`${t('已创建目录 ')}${name}`)
      } else if (state.target) {
        const target = joinRemotePath(parentPath(state.target.path), name)
        await sftpRename(sessionId, state.target.path, target)
        recordAudit('sftp.rename', `${state.target.path} -> ${target}`, 'success', t('重命名远程文件'))
        setNotice(`${t('已重命名为 ')}${name}`)
      }
      setNameDialog(null)
      await loadDirectory(path)
    } catch (err) {
      recordAudit(
        state.mode === 'mkdir' ? 'sftp.mkdir' : 'sftp.rename',
        state.mode === 'rename' && state.target ? state.target.path : path,
        'failure',
        t('远程操作失败')
      )
      setError(asMessage(err, t('远程操作失败')))
    } finally {
      setNameBusy(false)
    }
  }

  const submitChmodDialog = async () => {
    const dialog = chmodDialog
    if (!dialog) return
    const mode = parseChmodInput(dialog.value)
    if (mode === null) {
      setError(t('权限必须是 3~4 位八进制数字，例如 644'))
      return
    }
    setChmodBusy(true)
    setError(null)
    try {
      await sftpChmod(sessionId, dialog.target.path, mode)
      recordAudit('sftp.chmod', `${dialog.target.path} -> ${formatMode(mode)}`, 'success', t('修改远程文件权限'))
      setNotice(`${t('已将 ')}${dialog.target.name}${t(' 权限修改为 ')}${dialog.value.trim()}`)
      setChmodDialog(null)
      await loadDirectory(path)
    } catch (err) {
      recordAudit('sftp.chmod', dialog.target.path, 'failure', t('修改远程文件权限失败'))
      setError(asMessage(err, t('修改权限失败')))
    } finally {
      setChmodBusy(false)
    }
  }

  const handleDelete = async (entry: SftpEntry) => {
    if (entry.kind !== 'file' && entry.kind !== 'directory') return
    const isDir = entry.kind === 'directory'
    const accepted = await confirmDialog({
      title: isDir ? t('递归删除远程目录') : t('删除远程文件'),
      message: isDir
        ? t('目录“') + entry.name + t('”及其全部子目录和文件将被删除，该操作不可恢复。确认继续？')
        : t('确认删除远程文件“') + entry.name + t('”？该操作不可恢复。'),
      confirmLabel: isDir ? t('全部删除') : t('删除'),
      danger: true
    })
    if (!accepted) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (isDir) {
        await sftpRemoveDir(sessionId, entry.path)
        recordAudit('sftp.rmdir', entry.path, 'success', t('递归删除远程目录'))
        setNotice(`${t('已删除目录 ')}${entry.name}`)
      } else {
        await sftpRemoveFile(sessionId, entry.path)
        recordAudit('sftp.delete', entry.path, 'success', t('删除文件'))
        setNotice(`${t('已删除 ')}${entry.name}`)
      }
      await loadDirectory(path)
    } catch (err) {
      if (isDir) {
        recordAudit('sftp.rmdir', entry.path, 'failure', t('递归删除远程目录失败'))
        setError(asMessage(err, t('递归删除目录失败')))
      } else {
        recordAudit('sftp.delete', entry.path, 'failure', t('删除文件失败'))
        setError(asMessage(err, t('删除失败')))
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * 行操作集合：交给 ref 转发到每次渲染新建的实现，使传给 `SftpEntryList` 的对象
   * 保持恒定引用。否则行组件的 `memo` 每次渲染都会被新引用击穿（P2-19）。
   * 必须在提前 return 之前调用，遵守 Hooks 规则。
   */
  const entryActionsRef = useRef<SftpEntryActions | null>(null)
  const entryActions = useMemo<SftpEntryActions>(
    () => ({
      open: (entry) => entryActionsRef.current?.open(entry),
      download: (entry) => entryActionsRef.current?.download(entry),
      edit: (entry) => entryActionsRef.current?.edit(entry),
      rename: (entry) => entryActionsRef.current?.rename(entry),
      move: (entry) => entryActionsRef.current?.move(entry),
      chmod: (entry) => entryActionsRef.current?.chmod(entry),
      remove: (entry) => entryActionsRef.current?.remove(entry)
    }),
    []
  )
  entryActionsRef.current = {
    open: (entry) => void loadDirectory(entry.path),
    download: (entry) => void handleDownload(entry),
    edit: (entry) => void openEditor(entry),
    rename: (entry) => setNameDialog({ mode: 'rename', target: entry, value: entry.name }),
    move: (entry) => setNameDialog({ mode: 'move', target: entry, value: path }),
    chmod: (entry) => setChmodDialog({ target: entry, value: formatMode(entry.permissions ?? 0o644) }),
    remove: (entry) => void handleDelete(entry)
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
    <SftpDropZone enabled={connected && !busy} path={path} onFiles={(files) => void uploadFiles(files)}>
      <SftpToolbar
        state={{ path, busy, sortKey, sortAsc, showHidden, nameFilter }}
        actions={{
          collapse: onCollapse,
          refresh: () => void loadDirectory(),
          createDirectory: () => setNameDialog({ mode: 'mkdir', target: null, value: '' }),
          upload: (files) => void uploadFiles(files),
          diskUpload: () => void handleDiskUpload(),
          openSync: () => setSyncOpen(true),
          goParent: () => void loadDirectory(parentPath(path)),
          openInTerminal: () => void openInTerminal(),
          changeSortKey: setSortKey,
          toggleSortDirection: () => setSortAsc((current) => !current),
          toggleHidden: () => setShowHidden((current) => !current),
          changeFilter: setNameFilter
        }}
      />
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="form-notice">{notice}</div>}
      <SftpQueueResume sessionId={sessionId} hostId={hostId} onChanged={() => void loadDirectory(path)} />
      <SftpEntryList entries={shown} totalCount={entries.length} busy={busy} actions={entryActions} />
      {editor && (
        <SftpEditorModal
          entry={editor.entry}
          value={editor.text}
          busy={editorBusy}
          onChange={(text) => setEditor({ ...editor, text })}
          onClose={() => setEditor(null)}
          onSave={() => void saveEditor()}
        />
      )}
      {nameDialog && (
        <SftpNameDialog
          state={nameDialog}
          currentPath={path}
          busy={nameBusy}
          onChange={(value) => setNameDialog({ ...nameDialog, value })}
          onClose={() => setNameDialog(null)}
          onSubmit={() => void submitNameDialog()}
        />
      )}
      {chmodDialog && (
        <SftpChmodDialog
          target={chmodDialog.target}
          value={chmodDialog.value}
          busy={chmodBusy}
          onChange={(value) => setChmodDialog({ ...chmodDialog, value })}
          onClose={() => setChmodDialog(null)}
          onSubmit={() => void submitChmodDialog()}
        />
      )}
      <SftpTransferList sessionId={sessionId} />
      {syncOpen && (
        <SftpSyncDialog
          sessionId={sessionId}
          remoteDir={path}
          onClose={() => setSyncOpen(false)}
          onFinished={handleSyncFinished}
        />
      )}
    </SftpDropZone>
  )
}
