import { logger } from './logger'

/**
 * `plugin-store` 不可用时的 localStorage 兜底读写。
 *
 * 兜底本身也会失败：配额耗尽、隐私模式禁用 Storage、序列化循环引用都会让
 * `setItem` 抛异常。若放任其抛出，调用方会在「内存已改但磁盘没落」的半成品状态
 * 下收到拒绝，误判成整次保存失败（审计 R-14）。这里统一吞掉异常并留一条 warn，
 * 让上层按「已尽力持久化」继续走完流程。
 *
 * 约定：`key` 用调用方原有的存储键，`label` 只用于日志定位，不做国际化。
 */
export function writeLocalFallback(key: string, value: unknown, label: string): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    logger.warn(`${label} 的本地回退存储写入失败`, err)
  }
}

/**
 * 严格版兜底写入：成功返回 true，失败返回 false（不抛异常）。
 *
 * 供凭据保险箱等**数据安全边界**使用（审计 M-5）：主存储失败后回退，
 * 回退也失败时调用方必须感知并向上抛错，绝不允许「内存已改、磁盘没落」
 * 的假成功。一般设置的 best-effort 语义请继续用 [`writeLocalFallback`]。
 */
export function tryWriteLocalFallback(key: string, value: unknown, label: string): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (err) {
    logger.warn(`${label} 的本地回退存储写入失败`, err)
    return false
  }
}

/** 读取 localStorage 兜底值并解析 JSON；缺失、损坏或 Storage 不可用时一律返回 null。 */
export function readLocalFallback<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
