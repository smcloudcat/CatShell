import { describe, expect, it } from 'vitest'
import { PaletteCommand, filterPaletteCommands } from '../utils/commandPalette'

const commands: PaletteCommand[] = [
  { id: 'view:hosts', label: '主机', icon: 'server', keywords: 'view hosts' },
  { id: 'host:abc', label: '生产网关', hint: '10.0.0.1:22', keywords: 'host connect ssh gateway' },
  { id: 'session:3', label: 'root@backup', hint: '切换到该标签', keywords: 'session tab switch' }
]

describe('filterPaletteCommands', () => {
  it('空查询原样返回全部并保持顺序', () => {
    expect(filterPaletteCommands(commands, '')).toEqual(commands)
    expect(filterPaletteCommands(commands, '   ')).toEqual(commands)
  })

  it('按 label 子串匹配且大小写不敏感', () => {
    expect(filterPaletteCommands(commands, '生产')).toEqual([commands[1]])
    expect(filterPaletteCommands(commands, 'ROOT')).toEqual([commands[2]])
  })

  it('keywords 命中但 label 不含时也返回', () => {
    expect(filterPaletteCommands(commands, 'gateway')).toEqual([commands[1]])
    expect(filterPaletteCommands(commands, 'switch')).toEqual([commands[2]])
  })

  it('无命中返回空数组', () => {
    expect(filterPaletteCommands(commands, '不存在的命令')).toEqual([])
  })

  it('查询两侧空白不影响匹配', () => {
    expect(filterPaletteCommands(commands, ' 主机 ')).toEqual([commands[0]])
  })
})
