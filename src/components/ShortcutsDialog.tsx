import { Modal } from './Modal'
import { useT } from '../i18n'
import { SHORTCUT_GROUPS } from '../utils/shortcuts'

/** 快捷键速查面板（Ctrl+/）。数据见 utils/shortcuts.ts，与实际按键行为需同步维护。 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  return (
    <Modal className="shortcuts-modal" ariaLabel={t('快捷键速查')} onClose={onClose}>
      <header className="modal-header">
        <div className="modal-title">
          <kbd className="kbd-chip">Ctrl</kbd>
          <span className="kbd-plus">+</span>
          <kbd className="kbd-chip">/</kbd>
          {t('快捷键速查')}
        </div>
      </header>
      <div className="modal-body shortcuts-body">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.titleKey}>
            <h3 className="shortcut-group-title">{t(group.titleKey)}</h3>
            <ul className="shortcut-list">
              {group.items.map((item) => (
                <li className="shortcut-row" key={item.keys}>
                  <kbd className="kbd-chip">{item.keys}</kbd>
                  <span className="shortcut-label">{t(item.labelKey)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  )
}
