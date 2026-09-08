import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../components/Icon'
import { useAudit } from '../../store/audit'
import { AuditEntry } from '../../types/audit'

const ACTION_LABELS: Record<string, string> = {
  'session.connect': '连接',
  'session.status': '会话状态',
  'session.disconnect': '断开连接',
  'session.log-export': '导出会话日志',
  'host.create': '创建主机',
  'host.update': '更新主机',
  'host.delete': '删除主机',
  'host.import': '导入主机',
  'host.export': '导出主机',
  'sftp.list': '读取目录',
  'sftp.upload': '上传文件',
  'sftp.batch-upload': '批量上传',
  'sftp.download': '下载文件',
  'sftp.delete': '删除文件',
  'sftp.edit': '编辑文件',
  'snippet.send': '发送片段',
  'command.bulk-send': '批量下发',
  'config.export': '导出配置',
  'config.import': '还原配置',
  'forward.start': '启动转发',
  'forward.stop': '停止转发',
  'vault.unlock': '解锁保险箱',
  'vault.lock': '锁定保险箱'
}

function exportEntries(entries: AuditEntry[]) {
  const blob = new Blob([JSON.stringify({ version: 1, entries }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'catshell-audit-log.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

export function AuditPanel() {
  const ready = useAudit((state) => state.ready)
  const entries = useAudit((state) => state.entries)
  const init = useAudit((state) => state.init)
  const clear = useAudit((state) => state.clear)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void init()
  }, [init])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return [...entries].reverse().filter((entry) => {
      if (!needle) return true
      return [entry.action, entry.target, entry.detail, ACTION_LABELS[entry.action] ?? ''].some((value) => value.toLowerCase().includes(needle))
    })
  }, [entries, query])

  return (
    <div className="settings-section audit-panel">
      <div className="settings-section-title"><Icon name="monitor" size={15} /> 操作审计</div>
      <div className="snippet-heading">
        <span className="section-tip">日志仅保存在本机，最多保留 5000 条，不记录密码、私钥口令或完整命令内容。</span>
        <div className="audit-actions">
          <button className="glass-btn" onClick={() => exportEntries(filtered)} disabled={!filtered.length}><Icon name="save" size={14} /> 导出</button>
          <button className="glass-btn" onClick={() => { if (window.confirm('确认清空全部审计日志？')) void clear() }} disabled={!entries.length}>清空</button>
        </div>
      </div>
      <input className="glass-input" placeholder="搜索动作、目标或结果" value={query} onChange={(event) => setQuery(event.target.value)} />
      {!ready && <div className="section-tip">正在读取审计日志…</div>}
      {ready && !filtered.length && <div className="snippet-empty">没有匹配的审计记录。</div>}
      <div className="audit-list">
        {filtered.map((entry) => (
          <div className="audit-item" key={entry.id}>
            <span className={`audit-result audit-result-${entry.result}`} />
            <time>{new Date(entry.timestamp).toLocaleString()}</time>
            <strong>{ACTION_LABELS[entry.action] ?? entry.action}</strong>
            <span className="audit-target">{entry.target}</span>
            <span className="audit-detail">{entry.detail}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
