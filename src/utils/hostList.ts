import { HostProfile } from '../types/host'

/** 主机列表的纯函数层：标签收集、搜索筛选、分组与重复判定。 */

/** 未归组主机在分组视图里的内部键，仅用于 React key 与折叠状态。 */
export const UNGROUPED_KEY = '__ungrouped__'

/** 主机去重/查重的规范键：主机+端口+用户名。导入与 config 解析共用同一规则。 */
export function addressKey(host: string, port: number, username: string): string {
  return `${host}:${port}:${username}`
}

/** 汇总所有主机出现过的标签，去重后按中文拼音序排列。 */
export function collectTags(hosts: HostProfile[]): string[] {
  const seen = new Set<string>()
  for (const host of hosts) for (const tag of host.tags) seen.add(tag)
  return Array.from(seen).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/**
 * 按关键词与标签筛选主机。
 * 关键词覆盖名称、地址、用户名、分组与标签，任一命中即保留。
 */
export function filterHosts(hosts: HostProfile[], query: string, activeTag: string | null): HostProfile[] {
  const needle = query.trim().toLowerCase()
  return hosts.filter((host) => {
    if (activeTag && !host.tags.includes(activeTag)) return false
    if (!needle) return true
    return [host.name, host.host, host.username, host.group ?? '', ...host.tags]
      .some((value) => value.toLowerCase().includes(needle))
  })
}

export interface HostGroupBucket {
  key: string
  label: string
  hosts: HostProfile[]
}

/** 按分组聚合主机，未分组固定排在最后。 */
export function groupHosts(hosts: HostProfile[], ungroupedLabel: string): HostGroupBucket[] {
  const map = new Map<string, HostProfile[]>()
  for (const host of hosts) {
    const key = host.group ?? UNGROUPED_KEY
    const list = map.get(key) ?? []
    list.push(host)
    map.set(key, list)
  }
  const keys = Array.from(map.keys()).sort((a, b) => {
    if (a === UNGROUPED_KEY) return 1
    if (b === UNGROUPED_KEY) return -1
    return a.localeCompare(b, 'zh-Hans-CN')
  })
  return keys.map((key) => ({
    key,
    label: key === UNGROUPED_KEY ? ungroupedLabel : key,
    hosts: map.get(key) ?? []
  }))
}
