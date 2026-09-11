import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { useT } from '../i18n'
import { PaletteCommand, filterPaletteCommands } from '../utils/commandPalette'

/**
 * 命令面板（Ctrl+K）。
 * 展示层只接收 props：命令清单与执行回调由 App 编排层构建。
 * 键盘交互：↑↓ 选择、Enter 执行、Escape 关闭（Modal 兜底）。
 */
export function CommandPalette({
  commands,
  onRun,
  onClose
}: {
  commands: PaletteCommand[]
  onRun: (command: PaletteCommand) => void
  onClose: () => void
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLUListElement | null>(null)

  const filtered = useMemo(() => filterPaletteCommands(commands, query), [commands, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    const item = listRef.current?.children[activeIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const run = (command: PaletteCommand | undefined) => {
    if (!command) return
    onRun(command)
    onClose()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (filtered.length ? (index + 1) % filtered.length : 0))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (filtered.length ? (index - 1 + filtered.length) % filtered.length : 0))
      return
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      run(filtered[activeIndex])
    }
  }

  return (
    <Modal className="palette-modal" ariaLabel={t('命令面板')} onClose={onClose}>
      <div className="palette-input-row">
        <Icon name="search" size={16} />
        <input
          className="palette-input"
          autoFocus
          value={query}
          placeholder={t('搜索视图、主机、会话与操作…')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={filtered[activeIndex] ? `palette-option-${activeIndex}` : undefined}
        />
        <kbd className="kbd-chip">Esc</kbd>
      </div>
      <ul className="palette-list" id="palette-list" ref={listRef}>
        {filtered.map((command, index) => (
          <li key={command.id} id={`palette-option-${index}`}>
            <button
              className={`palette-item ${index === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => run(command)}
            >
              <Icon name={command.icon ?? 'arrow-right'} size={15} />
              <span className="palette-item-label">{command.label}</span>
              {command.hint && <span className="palette-item-hint">{command.hint}</span>}
            </button>
          </li>
        ))}
      </ul>
      {filtered.length === 0 && <div className="palette-empty">{t('没有匹配的命令')}</div>}
      <footer className="palette-footer">
        <span>
          <kbd className="kbd-chip">↑</kbd>
          <kbd className="kbd-chip">↓</kbd>
          {t('选择')}
        </span>
        <span>
          <kbd className="kbd-chip">Enter</kbd>
          {t('执行')}
        </span>
      </footer>
    </Modal>
  )
}
