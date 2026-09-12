import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../components/Icon'
import {
  keypairDelete,
  keypairGenerate,
  keypairList,
  keypairPublicKey,
  sshConfigParse,
  sshConfigWrite
} from '../../api/ssh'
import { SshKeyEntry } from '../../types/host'
import { planConfigWrite } from '../../utils/keyManage'
import { useHosts } from '../../store/hosts'
import { recordAudit } from '../../store/audit'
import { confirmDialog, showToast } from '../../store/ui'
import { useT } from '../../i18n'
import { errorText, KEYPAIR_EXISTS_CODE } from '../../i18n/errors'

/** 生成成功后保留的提示（含指纹），切换页签或重新生成时消失。 */
const GENERATED_TIP_TTL_MS = 12000

/**
 * 密钥管理面板：生成 Ed25519 密钥对、浏览 `~/.ssh` 目录、
 * 复制公钥 / 删除密钥对，以及把主机档案写回 `~/.ssh/config`。
 */
export function KeypairPanel() {
  const t = useT()
  const hosts = useHosts((state) => state.hosts)

  const [keys, setKeys] = useState<SshKeyEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  // 生成表单
  const [comment, setComment] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [savePath, setSavePath] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generatedTip, setGeneratedTip] = useState<string | null>(null)

  // config 写回
  const [configNames, setConfigNames] = useState<string[]>([])
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(new Set())
  const [writing, setWriting] = useState(false)

  const reload = async () => {
    setError(null)
    try {
      setKeys(await keypairList())
    } catch (err) {
      setError(errorText(err, t, '扫描 ~/.ssh 目录失败'))
    }
  }

  /** 解析现有 ~/.ssh/config 的 Host 名单，用于同名替换提示；config 不存在视为空。 */
  const reloadConfigNames = async () => {
    try {
      const entries = await sshConfigParse()
      setConfigNames(entries.map((entry) => entry.host))
    } catch {
      setConfigNames([])
    }
  }

  useEffect(() => {
    void reload()
    void reloadConfigNames()
  }, [])

  useEffect(() => {
    if (!generatedTip) return
    const timer = window.setTimeout(() => setGeneratedTip(null), GENERATED_TIP_TTL_MS)
    return () => window.clearTimeout(timer)
  }, [generatedTip])

  const pickSavePath = async () => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const file = await save({
        title: t('选择私钥保存位置'),
        defaultPath: 'id_ed25519'
      })
      if (typeof file === 'string') setSavePath(file)
    } catch {
      setError(t('无法打开保存对话框'))
    }
  }

  const generate = async (overwrite: boolean) => {
    if (!savePath.trim()) {
      setError(t('请先选择私钥保存位置'))
      return
    }
    setGenerating(true)
    setError(null)
    try {
      const generated = await keypairGenerate(
        savePath.trim(),
        passphrase || null,
        comment.trim(),
        overwrite
      )
      setGeneratedTip(
        `${generated.keyType} · ${generated.fingerprint}`
      )
      recordAudit('keys.generate', generated.privateKeyPath, 'success', generated.fingerprint)
      showToast(t('密钥对已生成'), 'success')
      setPassphrase('')
      await reload()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 只认后端哨兵码：文案匹配会误伤「目标路径是一个已存在的目录」等覆盖无法解决的错误。
      if (!overwrite && message.startsWith(KEYPAIR_EXISTS_CODE)) {
        // 目标已存在：二次确认后带 overwrite 重试。
        const accepted = await confirmDialog({
          title: t('覆盖已有密钥'),
          message: t('目标位置已存在同名密钥文件，覆盖后原文件无法恢复。确认覆盖？'),
          confirmLabel: t('覆盖'),
          danger: true
        })
        setGenerating(false)
        if (accepted) {
          await generate(true)
        }
        return
      }
      recordAudit('keys.generate', savePath, 'failure', errorText(err, t, '生成密钥失败'))
      setError(errorText(err, t, '生成密钥失败'))
    } finally {
      setGenerating(false)
    }
  }

  const copyPublicKey = async (entry: SshKeyEntry) => {
    const source = entry.privatePath ?? entry.publicPath
    if (!source) return
    setBusyKey(entry.fileName)
    try {
      const content = await keypairPublicKey(source)
      await navigator.clipboard.writeText(content)
      recordAudit('keys.copy-public', entry.fileName, 'success', t('复制公钥到剪贴板'))
      showToast(t('公钥已复制到剪贴板'), 'success')
    } catch (err) {
      showToast(t('复制失败：') + errorText(err, t, '读取公钥失败'), 'error')
    } finally {
      setBusyKey(null)
    }
  }

  const removeKey = async (entry: SshKeyEntry) => {
    if (!entry.privatePath) return
    const accepted = await confirmDialog({
      title: t('删除密钥对'),
      message:
        t('确定删除「') +
        entry.fileName +
        t('」的密钥文件吗？私钥与 .pub 公钥会一并删除，该操作不可恢复。若服务器已配置此公钥，删除后可能无法再登录。'),
      confirmLabel: t('删除'),
      danger: true
    })
    if (!accepted) return
    setBusyKey(entry.fileName)
    try {
      await keypairDelete(entry.privatePath)
      recordAudit('keys.delete', entry.fileName, 'success', t('删除密钥对'))
      showToast(t('已删除密钥文件'), 'success')
      await reload()
    } catch (err) {
      recordAudit('keys.delete', entry.fileName, 'failure', err instanceof Error ? err.message : String(err))
      showToast(t('删除失败：') + errorText(err, t, '删除密钥失败'), 'error')
    } finally {
      setBusyKey(null)
    }
  }

  // ------------------------------------------------------------------
  // SSH config 写回
  // ------------------------------------------------------------------

  const writePlan = useMemo(
    () => planConfigWrite(Object.values(hosts).filter((host) => selectedHostIds.has(host.id)), configNames),
    [hosts, selectedHostIds, configNames]
  )

  const toggleHost = (id: string) => {
    setSelectedHostIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const writeBack = async () => {
    const plan = writePlan
    if (!plan.drafts.length) return
    const conflictNote = plan.conflicts.length
      ? t('以下同名 Host 块将被替换：') + plan.conflicts.join('、') + t('。原配置已自动备份。')
      : t('将以追加方式写入，现有配置保留并自动备份。')
    const accepted = await confirmDialog({
      title: t('写回 ~/.ssh/config'),
      message:
        t('即将写入 ') +
        plan.drafts.length +
        t(' 个主机块（只含地址、端口、用户名与私钥路径，不含密码）。') +
        conflictNote,
      confirmLabel: t('写回'),
      danger: plan.conflicts.length > 0
    })
    if (!accepted) return
    setWriting(true)
    setError(null)
    try {
      const [replaced, written] = await sshConfigWrite(plan.drafts)
      recordAudit(
        'ssh.config-write',
        '~/.ssh/config',
        'success',
        `${t('写入 ')}${written}${t(' 个块，替换 ')}${replaced}${t(' 个')}`
      )
      showToast(`${t('已写回 ~/.ssh/config（写入 ')}${written}${t('，替换 ')}${replaced}）`, 'success')
      setSelectedHostIds(new Set())
      await reloadConfigNames()
    } catch (err) {
      recordAudit('ssh.config-write', '~/.ssh/config', 'failure', err instanceof Error ? err.message : String(err))
      setError(errorText(err, t, '写回 ~/.ssh/config 失败'))
    } finally {
      setWriting(false)
    }
  }

  return (
    <div className="settings-section keypanel">
      <div className="settings-section-title"><Icon name="key" size={15} /> {t('SSH 密钥管理')}</div>
      <div className="section-tip">
        {t('生成并管理 ~/.ssh 目录中的密钥对；生成后把公钥追加到服务器的 authorized_keys 即可使用密钥登录。')}
      </div>
      {error && <div className="form-error">{error}</div>}
      {generatedTip && (
        <div className="form-notice">{t('已生成：')}{generatedTip}</div>
      )}

      <div className="keypanel-generate">
        <label className="field">
          <span className="field-label">{t('备注（公钥注释）')}</span>
          <input
            className="glass-input"
            value={comment}
            placeholder="user@host"
            onChange={(event) => setComment(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">{t('私钥口令（可选）')}</span>
          <input
            className="glass-input"
            type="password"
            value={passphrase}
            placeholder={t('留白则不加密')}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">{t('保存位置')}</span>
          <div className="keypanel-path-row">
            <input
              className="glass-input"
              value={savePath}
              readOnly
              placeholder={t('点击「选择」指定私钥路径')}
            />
            <button className="glass-btn" onClick={() => void pickSavePath()}>
              {t('选择')}
            </button>
            <button
              className="glass-btn primary"
              disabled={generating}
              onClick={() => void generate(false)}
            >
              {t('生成密钥对')}
            </button>
          </div>
        </label>
      </div>

      <div className="knownhosts-list">
        {(keys ?? []).map((entry) => (
          <div className="knownhosts-row keypanel-row" key={entry.fileName}>
            <span className="knownhosts-pattern" title={entry.privatePath ?? entry.publicPath ?? ''}>
              {entry.fileName}
              {entry.encrypted && <span className="keypanel-badge">{t('已加密')}</span>}
              {entry.kind === 'key' && !entry.hasPrivate && (
                <span className="keypanel-badge">{t('仅公钥')}</span>
              )}
            </span>
            <span className="knownhosts-type">
              {entry.kind === 'key' ? entry.keyType ?? '—' : t('其它文件')}
            </span>
            <span className="knownhosts-fingerprint" title={entry.comment ?? ''}>
              {entry.comment ? `${entry.comment} · ` : ''}
              {entry.fingerprint ?? '—'}
            </span>
            {entry.kind === 'key' ? (
              <div className="keypanel-actions">
                <button
                  className="host-icon-btn"
                  title={t('复制公钥')}
                  disabled={busyKey === entry.fileName || !entry.hasPublic}
                  onClick={() => void copyPublicKey(entry)}
                >
                  <Icon name="copy" size={14} />
                </button>
                <button
                  className="host-icon-btn danger"
                  title={t('删除密钥对')}
                  disabled={busyKey === entry.fileName || !entry.hasPrivate}
                  onClick={() => void removeKey(entry)}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
      {keys && !keys.length && (
        <div className="section-tip">{t('~/.ssh 目录为空或不存在。')}</div>
      )}

      <div className="settings-section-title keypanel-subtitle">
        <Icon name="save" size={14} /> {t('写回 ~/.ssh/config')}
      </div>
      <div className="section-tip">
        {t('把选中的主机档案写为 OpenSSH Host 块（地址、端口、用户名、私钥路径），可直接被 ssh / scp / git 使用；不含任何密码。')}
      </div>
      <div className="keypanel-hosts">
        {Object.values(hosts).map((host) => (
          <label className="keypanel-host" key={host.id}>
            <input
              type="checkbox"
              checked={selectedHostIds.has(host.id)}
              onChange={() => toggleHost(host.id)}
            />
            <span title={`${host.username}@${host.host}:${host.port}`}>{host.name}</span>
          </label>
        ))}
        {!Object.values(hosts).length && (
          <div className="section-tip">{t('还没有主机档案。')}</div>
        )}
      </div>
      <button
        className="glass-btn"
        disabled={writing || !selectedHostIds.size || !writePlan.drafts.length}
        onClick={() => void writeBack()}
      >
        {t('写回 ~/.ssh/config')}
      </button>
      {!!writePlan.conflicts.length && (
        <div className="section-tip">
          {t('将替换同名 Host 块：')}{writePlan.conflicts.join('、')}
        </div>
      )}
    </div>
  )
}
