/**
 * 快捷键速查数据：面板渲染与完整性单测共用。
 * 新增或修改 App.tsx / TerminalPane 的快捷键时同步维护这里——
 * shortcuts.test.ts 会校验每个条目的键位写法与文案键，防止面板与实际行为脱节。
 */
export interface ShortcutEntry {
  /** 按键展示（Ctrl + X 写法，加号两侧空格） */
  keys: string
  /** 说明文案的 i18n 中文原文键 */
  labelKey: string
}

export interface ShortcutGroup {
  /** 分组标题的 i18n 中文原文键 */
  titleKey: string
  items: ShortcutEntry[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    titleKey: '全局',
    items: [
      { keys: 'Ctrl + K', labelKey: '打开命令面板' },
      { keys: 'Ctrl + /', labelKey: '打开快捷键速查' },
      { keys: 'Ctrl + T', labelKey: '新建会话（前往主机页）' },
      { keys: 'Ctrl + F', labelKey: '在当前终端中搜索' },
      { keys: 'Ctrl + Tab', labelKey: '下一个标签' },
      { keys: 'Ctrl + Shift + Tab', labelKey: '上一个标签' },
      { keys: 'Ctrl + 1…9', labelKey: '切换到第 N 个标签' },
      { keys: 'Ctrl + W', labelKey: '关闭标签（活动连接需确认）' },
      { keys: 'Ctrl + Shift + W', labelKey: '断开并关闭标签' }
    ]
  },
  {
    titleKey: '终端搜索',
    items: [
      { keys: 'Enter', labelKey: '跳到下一个匹配' },
      { keys: 'Shift + Enter', labelKey: '跳到上一个匹配' },
      { keys: 'Escape', labelKey: '关闭搜索框' }
    ]
  }
]
