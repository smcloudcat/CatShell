import { useEffect, useState } from 'react'
import { useSettings } from '../../store/settings'

/**
 * 解析后的实际外观模式（审计 B-11）。
 *
 * 主题里的 `mode` 可能是 `auto`——此时真实外观由系统偏好决定。`data-mode` 属性
 * 与 CSS 都按解析后的值走，若组件直接读原始 `mode`，`auto` + 浅色系统时就会拿到
 * 与页面背景相反的终端配色（浅底配浅字，几乎不可读）。
 *
 * 抽成共享 hook，供主终端与录制回放共用，避免两处口径漂移。
 */
export function useEffectiveMode(): 'light' | 'dark' {
  const mode = useSettings((state) => state.theme.mode)
  const [systemLight, setSystemLight] = useState(
    () => window.matchMedia('(prefers-color-scheme: light)').matches
  )
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const listener = () => setSystemLight(media.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])
  if (mode === 'auto') return systemLight ? 'light' : 'dark'
  return mode
}
