import type { Translator } from './index'
import { isAppError, type ErrorCode } from '../types/errors'

/**
 * 错误码 → 用户可见文案。
 *
 * 表里的值以中文原文作为 i18n 键（与本项目其它文案一致），
 * `scripts/check-i18n.mjs` 会把本表的值当作键一并扫描，确保 `en` 字典同步补齐。
 *
 * 支持 `{name}` 占位符，由 `translateAppError` 用 `AppError.params` 插值，
 * 例如 `HOST_IMPORT_TOO_MANY` 会带上 `{ max: 500 }`。
 */
export const ERROR_MESSAGE_KEYS: Record<ErrorCode, string> = {
  SESSION_MISSING_CONNECTION_PARAMS: '该会话缺少可复用的连接参数，请从主机页重新连接',
  SESSION_NOT_FOUND: '会话不存在',
  SESSION_NAME_EMPTY: '名称不能为空',
  SNIPPET_FIELDS_EMPTY: '片段名称和命令不能为空',
  HOST_INVALID: '主机地址、用户名或端口无效',
  HOST_IMPORT_TOO_MANY: '单次导入不能超过 {max} 条主机配置',
  VAULT_NOT_CONFIGURED: '请先设置保险箱主密码',
  VAULT_UNLOCK_FAILED: '主密码错误或保险箱数据已损坏',
  VAULT_OLD_PASSWORD_WRONG: '原主密码不正确',
  VAULT_LOCKED: '请先解锁凭据保险箱',
  VAULT_PASSWORD_TOO_SHORT: '主密码至少需要 {min} 个字符',
  VAULT_DATA_INVALID: '保险箱数据格式无效',
  BACKUP_UNSUPPORTED_FORMAT: '格式不支持',
  BACKUP_INCOMPLETE: '内容不完整',
  BACKUP_INVALID_THRESHOLDS: '告警设置无效',
  TRANSFER_CANCELLED: '已取消'
}

/** 用 `params` 填充文案模板里的 `{name}` 占位符；缺失的参数原样保留，便于发现遗漏。 */
export function interpolateError(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder
  )
}

/**
 * 密钥生成时「目标已存在」的稳定哨兵码。
 *
 * Rust 侧以 `CODE: 文案` 的形式回传（`ssh_manager::keys::KEYPAIR_EXISTS_CODE`），
 * 前端据此决定是否弹出「覆盖」确认——用文案匹配会误伤
 * 「目标路径是一个已存在的目录」这类覆盖也解决不了的错误（R-10）。
 */
export const KEYPAIR_EXISTS_CODE = 'KEYPAIR_EXISTS'

const BACKEND_ERROR_CODES: readonly string[] = [KEYPAIR_EXISTS_CODE]

/** 剥离后端哨兵码前缀，返回可展示的文案；无前缀时原样返回。 */
export function stripErrorCode(message: string): string {
  for (const code of BACKEND_ERROR_CODES) {
    if (message.startsWith(code)) return message.slice(code.length).replace(/^[:\s]+/, '')
  }
  return message
}

/**
 * 把 `AppError` 翻译为当前语言文案；非 `AppError` 或错误码未登记时返回 `null`，
 * 交由调用方走兜底逻辑。
 */
export function translateAppError(error: unknown, t: Translator): string | null {
  if (!isAppError(error)) return null
  const key = ERROR_MESSAGE_KEYS[error.code]
  if (!key) return null
  return interpolateError(t(key), error.params)
}

/**
 * 统一取「可展示的错误文案」：
 * - `AppError` → 按当前语言翻译（唯一的本地化路径）；
 * - 其它 `Error` / 非空字符串 → 原样返回（多为 Tauri 后端回传的原始错误）；
 * - 其余 → 返回 `fallbackKey` 的翻译。
 */
export function errorText(error: unknown, t: Translator, fallbackKey: string): string {
  const translated = translateAppError(error, t)
  if (translated) return translated
  if (typeof error === 'string' && error) return stripErrorCode(error)
  if (error instanceof Error && error.message) return stripErrorCode(error.message)
  return t(fallbackKey)
}
