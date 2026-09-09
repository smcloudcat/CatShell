import { useSettings } from '../store/settings'
import type { Language } from '../store/settings'

/**
 * 轻量 i18n：zh-CN 为默认与键名来源，en-US 渐进补齐；
 * 缺失键回退 zh-CN，再回退键名本身。新增文案时以 t(key) 形式接入。
 */
const zh: Record<string, string> = {
  'nav.home': '概览',
  'nav.sessions': '会话',
  'nav.hosts': '主机',
  'nav.forward': '转发',
  'nav.settings': '设置',
  'status.connected': '已连接',
  'status.connecting': '连接中',
  'status.reconnecting': '重连中',
  'status.disconnected': '已断开',
  'status.closing': '正在关闭',
  'status.closed': '已关闭',
  'settings.tab.appearance': '外观',
  'settings.tab.monitor': '监控告警',
  'settings.tab.snippets': '命令片段',
  'settings.tab.security': '安全与审计',
  'settings.tab.backup': '备份与还原',
  'settings.tab.update': '应用更新',
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.save': '保存',
  'common.delete': '删除'
}

const en: Record<string, string> = {
  'nav.home': 'Overview',
  'nav.sessions': 'Sessions',
  'nav.hosts': 'Hosts',
  'nav.forward': 'Forwards',
  'nav.settings': 'Settings',
  'status.connected': 'Connected',
  'status.connecting': 'Connecting',
  'status.reconnecting': 'Reconnecting',
  'status.disconnected': 'Disconnected',
  'status.closing': 'Closing',
  'status.closed': 'Closed',
  'settings.tab.appearance': 'Appearance',
  'settings.tab.monitor': 'Alerts',
  'settings.tab.snippets': 'Snippets',
  'settings.tab.security': 'Security & Audit',
  'settings.tab.backup': 'Backup & Restore',
  'settings.tab.update': 'Updates',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.save': 'Save',
  'common.delete': 'Delete'
}

const dictionaries: Record<Language, Record<string, string>> = {
  'zh-CN': zh,
  'en-US': en
}

export function t(key: string): string {
  const language = useSettings.getState().language
  return dictionaries[language]?.[key] ?? zh[key] ?? key
}

/** 响应语言设置的 t()，供组件内使用 */
export function useT(): (key: string) => string {
  return t
}

export function hasTranslation(key: string): boolean {
  return key in zh
}