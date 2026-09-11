import { describe, expect, it } from 'vitest'
import { SHORTCUT_GROUPS } from '../utils/shortcuts'

/** 面板展示的键位与实际按键行为必须同步维护，此组用例守住关键项不丢。 */
const REQUIRED_KEYS = [
  'Ctrl + K',
  'Ctrl + /',
  'Ctrl + T',
  'Ctrl + F',
  'Ctrl + Tab',
  'Ctrl + W',
  'Ctrl + Shift + W',
  'Ctrl + 1…9'
]

describe('SHORTCUT_GROUPS', () => {
  it('每个条目都有键位与说明文案键', () => {
    for (const group of SHORTCUT_GROUPS) {
      expect(group.titleKey.length).toBeGreaterThan(0)
      expect(group.items.length).toBeGreaterThan(0)
      for (const item of group.items) {
        expect(item.keys.length).toBeGreaterThan(0)
        expect(item.labelKey.length).toBeGreaterThan(0)
      }
    }
  })

  it('键位写法统一用「 + 」分隔修饰键', () => {
    for (const group of SHORTCUT_GROUPS) {
      for (const item of group.items) {
        if (item.keys.includes('+')) {
          expect(item.keys).toMatch(/(Ctrl|Shift)( \+ (Ctrl|Shift|[^\s]+))+/)
        }
      }
    }
  })

  it('关键快捷键全部在列', () => {
    const allKeys = new Set(SHORTCUT_GROUPS.flatMap((group) => group.items.map((item) => item.keys)))
    for (const key of REQUIRED_KEYS) {
      expect(allKeys.has(key)).toBe(true)
    }
  })
})
