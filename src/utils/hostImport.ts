import { createHostProfile, HostProfile } from '../types/host'

/**
 * 主机配置导入的信任边界。
 *
 * 导入文件来自外部，其中的字段一律不可信：这里集中完成归一化与合法性校验，
 * 且显式丢弃 `password` / `passphrase`——即使导入 JSON 里带了凭据也不会进入配置。
 * 本模块保持纯函数，不依赖 Tauri，便于单测覆盖。
 */

export const MAX_IMPORT_PROFILES = 1000
const MAX_HOST_GROUP_LENGTH = 48
const MAX_HOST_TAGS = 10
const MAX_HOST_TAG_LENGTH = 24

const DEFAULT_PORT = 22
const DEFAULT_KEEPALIVE = 30

export interface ImportPreviewItem {
  profile: HostProfile
  duplicateOf: HostProfile | null
}

export interface ImportPreview {
  items: ImportPreviewItem[]
  invalidCount: number
}

export function normalizeGroup(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const group = value.trim().slice(0, MAX_HOST_GROUP_LENGTH)
  return group || null
}

export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const tag = item.trim().slice(0, MAX_HOST_TAG_LENGTH)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
    if (tags.length >= MAX_HOST_TAGS) break
  }
  return tags
}

/** 归一化单条导入配置，并强制清空敏感字段。 */
export function normalizeHost(value: Partial<HostProfile>): HostProfile {
  return createHostProfile({
    ...value,
    password: null,
    passphrase: null,
    group: normalizeGroup(value.group),
    tags: normalizeTags(value.tags),
    port: Number(value.port) > 0 ? Number(value.port) : DEFAULT_PORT,
    keepAliveInterval:
      Number(value.keepAliveInterval) > 0 ? Number(value.keepAliveInterval) : DEFAULT_KEEPALIVE,
    autoReconnect: value.autoReconnect !== false
  })
}

/** 主机地址、用户名与端口是否足以建立连接。 */
export function isValidHost(profile: HostProfile): boolean {
  return Boolean(
    profile.host.trim() &&
      profile.username.trim() &&
      Number.isInteger(profile.port) &&
      profile.port >= 1 &&
      profile.port <= 65535
  )
}

/**
 * 解析待导入的主机配置，标记与现有配置的冲突与非法条目。
 *
 * `existing` 由调用方传入，使本函数保持纯净、可单测。
 */
export function buildImportPreview(
  profiles: Partial<HostProfile>[],
  existing: HostProfile[],
  maxCount: number = MAX_IMPORT_PROFILES
): ImportPreview {
  const items: ImportPreviewItem[] = []
  let invalidCount = 0
  for (const profile of profiles) {
    const normalized = normalizeHost(profile)
    if (!isValidHost(normalized)) {
      invalidCount += 1
      continue
    }
    if (items.length >= maxCount) break
    const duplicate = existing.find(
      (host) =>
        host.host === normalized.host &&
        host.port === normalized.port &&
        host.username === normalized.username
    )
    items.push({ profile: normalized, duplicateOf: duplicate ?? null })
  }
  return { items, invalidCount }
}
