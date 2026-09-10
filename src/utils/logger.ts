/**
 * 统一的前端日志出口。
 *
 * 此前 `console.warn` / `console.error` 散落在各 store 与组件里，既没有统一前缀，
 * 也没有级别控制，开发期的调试噪音在生产构建里同样照单输出。这里收口成单一入口：
 * 统一加 `[CatShell]` 前缀便于在控制台过滤，`debug` 只在开发构建下输出。
 *
 * 注意：日志属诊断信息，按项目约定不做国际化（与 `recordAudit` 的 target/detail 同理）。
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const PREFIX = '[CatShell]'

function emit(level: LogLevel, message: string, detail?: unknown): void {
  if (level === 'debug' && !import.meta.env.DEV) return
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  if (detail === undefined) sink(`${PREFIX} ${message}`)
  else sink(`${PREFIX} ${message}`, detail)
}

export const logger = {
  debug: (message: string, detail?: unknown) => emit('debug', message, detail),
  info: (message: string, detail?: unknown) => emit('info', message, detail),
  warn: (message: string, detail?: unknown) => emit('warn', message, detail),
  error: (message: string, detail?: unknown) => emit('error', message, detail)
}
