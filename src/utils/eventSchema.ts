/**
 * 事件 payload 的 schema 版本校验（P2-13）。
 *
 * Rust 侧 `src-tauri/src/ssh_manager/mod.rs` 的 `EVENT_SCHEMA_VERSION` 是唯一事实来源，
 * 本文件的常量必须与其保持一致——`src/__tests__/eventSchema.test.ts` 会直接读取 Rust
 * 源码做交叉校验，防止两边各改一份后静默漂移。
 *
 * 为什么要校验：payload 字段一旦改名，旧前端只会读到 `undefined`，既不报错也不提示，
 * 表现为「界面上某个字段莫名其妙空了」。带版本号后可以显式丢弃并留下诊断日志。
 */

/** 与 `ssh_manager::EVENT_SCHEMA_VERSION` 对齐。 */
export const EVENT_SCHEMA_VERSION = 1

/** 带版本号的事件 payload。 */
export interface VersionedEventPayload {
  v?: number
}

/** payload 是否为当前前端支持的协议版本。 */
export function isSupportedEventVersion(payload: VersionedEventPayload): boolean {
  return payload.v === EVENT_SCHEMA_VERSION
}

/**
 * 是否需要丢弃该事件。
 *
 * 缺失版本号（`undefined`）同样视为不兼容：宁可少一次更新，也不要让界面读到
 * 语义已经变了的字段。
 */
export function shouldDropEvent(payload: VersionedEventPayload): boolean {
  return !isSupportedEventVersion(payload)
}
