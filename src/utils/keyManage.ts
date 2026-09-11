/**
 * 密钥管理与 SSH config 写回的纯函数层。
 * 与 UI 解耦，方便单测覆盖投影与冲突判定规则。
 */
import { HostProfile, HostConfigDraft } from '../types/host'

/**
 * 主机档案 → config 写回草稿。
 * 只在名称与地址齐备时投影；密钥认证才写 IdentityFile，其余认证方式不落私钥路径。
 * 绝不投影任何凭据（密码 / 口令）。
 */
export function hostToConfigDraft(host: HostProfile): HostConfigDraft | null {
  const name = host.name.trim()
  const hostname = host.host.trim()
  if (!name || !hostname) return null
  if (name.includes(' ')) return null
  return {
    name,
    hostname,
    port: host.port > 0 ? host.port : 22,
    user: host.username.trim(),
    identityFile: host.authMethod === 'key' ? host.keyPath : null
  }
}

/** 批量投影，跳过不可写回的主机。 */
export function hostsToConfigDrafts(hosts: HostProfile[]): HostConfigDraft[] {
  return hosts
    .map(hostToConfigDraft)
    .filter((draft): draft is HostConfigDraft => draft !== null)
}

/**
 * 写回计划：哪些主机会替换已存在的同名 Host 块。
 * `existingNames` 来自 `ssh_config_parse` 的现网解析结果（小写比较，OpenSSH 大小写不敏感）。
 */
export function planConfigWrite(
  hosts: HostProfile[],
  existingNames: string[]
): {
  drafts: HostConfigDraft[]
  skipped: number
  conflicts: string[]
} {
  const existing = new Set(existingNames.map((name) => name.toLowerCase()))
  const drafts: HostConfigDraft[] = []
  let skipped = 0
  for (const host of hosts) {
    const draft = hostToConfigDraft(host)
    if (draft) drafts.push(draft)
    else skipped += 1
  }
  const conflicts = drafts
    .filter((draft) => existing.has(draft.name.toLowerCase()))
    .map((draft) => draft.name)
  return { drafts, skipped, conflicts }
}
