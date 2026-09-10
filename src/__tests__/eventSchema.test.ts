/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EVENT_SCHEMA_VERSION, isSupportedEventVersion, shouldDropEvent } from '../utils/eventSchema'

/** Rust 侧事件版本常量的唯一事实来源。 */
const RUST_SOURCE = fileURLToPath(new URL('../../src-tauri/src/ssh_manager/mod.rs', import.meta.url))

describe('event schema version', () => {
  it('matches the Rust EVENT_SCHEMA_VERSION', () => {
    const source = readFileSync(RUST_SOURCE, 'utf8')
    const match = /pub const EVENT_SCHEMA_VERSION: u32 = (\d+);/.exec(source)
    expect(match, 'Rust 侧缺少 EVENT_SCHEMA_VERSION 常量').not.toBeNull()
    expect(Number(match?.[1])).toBe(EVENT_SCHEMA_VERSION)
  })

  it('accepts payloads carrying the current version', () => {
    expect(isSupportedEventVersion({ v: EVENT_SCHEMA_VERSION })).toBe(true)
    expect(shouldDropEvent({ v: EVENT_SCHEMA_VERSION })).toBe(false)
  })

  it('drops payloads from another protocol version', () => {
    expect(shouldDropEvent({ v: EVENT_SCHEMA_VERSION + 1 })).toBe(true)
    expect(shouldDropEvent({ v: EVENT_SCHEMA_VERSION - 1 })).toBe(true)
  })

  it('drops payloads without a version rather than trusting them', () => {
    // 字段改名后旧 payload 只是少了一个 v，若不丢弃就会静默读到 undefined
    expect(shouldDropEvent({})).toBe(true)
    expect(isSupportedEventVersion({})).toBe(false)
  })
})
