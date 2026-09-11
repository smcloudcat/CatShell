import { invoke } from '@tauri-apps/api/core'

import type { AiSettings } from '../store/settings'

/** 单条 OpenAI chat 格式消息。 */
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * AI apiKey 存取系统凭据管理器（审计 S-2）。
 * Rust 侧走 keyring（Windows Credential Manager），app-settings.json 不落明文。
 */
export function aiKeySave(key: string): Promise<void> {
  return invoke<void>('ai_key_save', { key })
}

export function aiKeyLoad(): Promise<string | null> {
  return invoke<string | null>('ai_key_load')
}

/**
 * 调用用户配置的 OpenAI 兼容接口。Rust 侧 `ai_complete` 无状态透传：
 * 端点/密钥/模型每次随请求传入，不落盘、不进审计、不进日志。
 */
export async function aiComplete(
  config: Pick<AiSettings, 'endpoint' | 'apiKey' | 'model'>,
  messages: AiChatMessage[]
): Promise<string> {
  return invoke<string>('ai_complete', {
    request: {
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      maxTokens: 1024,
      temperature: 0.2
    }
  })
}

/** 生成命令的 system 提示词。 */
export function commandPrompt(): AiChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a senior Linux/Unix sysadmin assistant inside an SSH client. ' +
        'Convert the user request into ONE safe shell command (or a short && chain). ' +
        'Reply with the command only, no markdown fences, no explanations. ' +
        'Prefer non-destructive forms; if the request is inherently destructive, still answer but keep it minimal.'
    },
    { role: 'user', content: '' }
  ]
}

/** 日志诊断的 system 提示词。 */
export function diagnosticPrompt(): AiChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a senior Linux/Unix sysadmin assistant inside an SSH client. ' +
        'The user will paste command output, error messages or logs. ' +
        'Answer concisely in the language of the log: what went wrong, the most likely cause, and a suggested fix command. ' +
        'Keep it under 200 words.'
    },
    { role: 'user', content: '' }
  ]
}
