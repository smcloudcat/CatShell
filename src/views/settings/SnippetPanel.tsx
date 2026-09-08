import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { useSnippets } from '../../store/snippets'
import { CommandSnippet, createCommandSnippet, getSnippetParameters } from '../../types/snippet'

export function SnippetPanel() {
  const snippets = useSnippets((state) => state.snippets)
  const ready = useSnippets((state) => state.ready)
  const init = useSnippets((state) => state.init)
  const upsert = useSnippets((state) => state.upsert)
  const remove = useSnippets((state) => state.remove)
  const [editing, setEditing] = useState<CommandSnippet | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void init()
  }, [init])

  const save = async () => {
    if (!editing) return
    setError(null)
    try {
      await upsert(editing)
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存片段失败')
    }
  }

  return (
    <div className="settings-section snippet-panel">
      <div className="settings-section-title"><Icon name="terminal" size={15} /> 命令片段</div>
      <div className="snippet-heading">
        <span className="section-tip">保存常用只读检查、发布和维护命令，发送前请确认目标会话。</span>
        <button className="glass-btn" onClick={() => { setError(null); setEditing(createCommandSnippet()) }}>
          <Icon name="plus" size={14} /> 新建片段
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
      {!ready && <div className="section-tip">正在读取片段…</div>}
      {ready && snippets.length === 0 && <div className="snippet-empty">还没有保存的命令片段。</div>}
      <div className="snippet-list">
        {snippets.map((snippet) => (
          <div className="snippet-item" key={snippet.id}>
            <div className="snippet-item-info">
              <strong>{snippet.name}</strong>
              <code>{snippet.command}</code>
              {getSnippetParameters(snippet.command).length > 0 && <span className="snippet-parameters">参数: {getSnippetParameters(snippet.command).join(', ')}</span>}
              {snippet.description && <span>{snippet.description}</span>}
            </div>
            <div className="snippet-item-actions">
              <button className="host-icon-btn" onClick={() => setEditing(snippet)} title="编辑"><Icon name="settings" size={14} /></button>
              <button className="host-icon-btn danger" onClick={() => void remove(snippet.id)} title="删除"><Icon name="trash" size={14} /></button>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <div className="snippet-editor">
          <label className="field"><span className="field-label">名称</span><input className="glass-input" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} autoFocus /></label>
           <label className="field"><span className="field-label">命令</span><textarea className="glass-input snippet-command" value={editing.command} onChange={(event) => setEditing({ ...editing, command: event.target.value })} placeholder="例如: systemctl status nginx" /></label>
           <div className="section-tip">使用 {'{{name}}'} 添加参数占位符，例如 {'systemctl status {{service}}'}。发送时会逐个参数转义。</div>
           {getSnippetParameters(editing.command).length > 0 && <div className="snippet-parameter-preview">已识别参数：{getSnippetParameters(editing.command).join('、')}</div>}
          <label className="field"><span className="field-label">说明（可选）</span><input className="glass-input" value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} /></label>
          <div className="snippet-editor-actions"><button className="glass-btn" onClick={() => setEditing(null)}>取消</button><button className="glass-btn primary" onClick={() => void save()}><Icon name="save" size={14} /> 保存片段</button></div>
        </div>
      )}
    </div>
  )
}
