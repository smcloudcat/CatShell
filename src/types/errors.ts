/**
 * 应用级错误码。
 *
 * 业务层（store / 纯函数层）只抛 `AppError`，携带一个稳定的错误码，不负责文案；
 * 面向用户的文案统一在 UI 层经 `src/i18n/errors.ts` 按当前语言翻译。
 * 这样做的两个好处：
 * 1. store 与 `src/utils/` 不依赖 i18n，纯函数层保持可单测；
 * 2. 切换语言后，已捕获的错误再次渲染时文案会跟随语言变化。
 *
 * 新增错误码时必须同步在 `src/i18n/errors.ts` 的 `ERROR_MESSAGE_KEYS` 登记文案，
 * 并在 `src/i18n/index.ts` 的 `en` 字典补齐英文，否则 `npm run i18n:check` 会失败。
 */
export const ERROR_CODES = {
  /** 会话缺少可复用的连接参数，无法从会话页直接重连。 */
  SESSION_MISSING_CONNECTION_PARAMS: 'SESSION_MISSING_CONNECTION_PARAMS',
  /** 目标会话已不存在（可能已关闭）。 */
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  /** 会话名称为空。 */
  SESSION_NAME_EMPTY: 'SESSION_NAME_EMPTY',
  /** 命令片段的名称或命令为空。 */
  SNIPPET_FIELDS_EMPTY: 'SNIPPET_FIELDS_EMPTY',
  /** 主机地址、用户名或端口不合法。 */
  HOST_INVALID: 'HOST_INVALID',
  /** 单次导入的主机配置条数超过上限，参数 `max`。 */
  HOST_IMPORT_TOO_MANY: 'HOST_IMPORT_TOO_MANY',
  /** 尚未设置保险箱主密码。 */
  VAULT_NOT_CONFIGURED: 'VAULT_NOT_CONFIGURED',
  /** 主密码错误或保险箱数据已损坏。 */
  VAULT_UNLOCK_FAILED: 'VAULT_UNLOCK_FAILED',
  /** 更换主密码时，原主密码校验失败。 */
  VAULT_OLD_PASSWORD_WRONG: 'VAULT_OLD_PASSWORD_WRONG',
  /** 保险箱处于锁定状态，无法读写凭据。 */
  VAULT_LOCKED: 'VAULT_LOCKED',
  /** 主密码长度不足，参数 `min`。 */
  VAULT_PASSWORD_TOO_SHORT: 'VAULT_PASSWORD_TOO_SHORT',
  /** 保险箱密文解密后不是预期结构。 */
  VAULT_DATA_INVALID: 'VAULT_DATA_INVALID',
  /** 备份文件的版本号不受支持。 */
  BACKUP_UNSUPPORTED_FORMAT: 'BACKUP_UNSUPPORTED_FORMAT',
  /** 备份文件缺少必要字段。 */
  BACKUP_INCOMPLETE: 'BACKUP_INCOMPLETE',
  /** 备份文件中的监控告警阈值不合法。 */
  BACKUP_INVALID_THRESHOLDS: 'BACKUP_INVALID_THRESHOLDS',
  /** 用户主动取消传输（哨兵错误，调用方据此区分「取消」与「失败」）。 */
  TRANSFER_CANCELLED: 'TRANSFER_CANCELLED'
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** 文案模板插值参数，对应文案里的 `{name}` 占位符。 */
export type ErrorParams = Record<string, string | number>

/**
 * 业务异常：`message` 即错误码，便于日志检索与断点排查；
 * 面向用户的文案由 UI 层通过 `translateAppError` / `errorText` 翻译。
 */
export class AppError extends Error {
  readonly code: ErrorCode
  // exactOptionalPropertyTypes 下可选属性不接受显式 undefined，显式写进类型
  readonly params?: ErrorParams | undefined

  constructor(code: ErrorCode, params?: ErrorParams) {
    super(code)
    this.name = 'AppError'
    this.code = code
    this.params = params
  }
}

/** 类型守卫：用于跨模块边界（如 Tauri invoke 回传值）判断。 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
