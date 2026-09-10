import { describe, expect, it } from 'vitest'
import { AppError, ERROR_CODES, isAppError } from '../types/errors'
import { ERROR_MESSAGE_KEYS, errorText, interpolateError, translateAppError } from '../i18n/errors'

/** 极简翻译函数，模拟 en 字典；只覆盖断言用到的键。 */
const dict: Record<string, string> = {
  '会话不存在': 'Session not found',
  '单次导入不能超过 {max} 条主机配置': 'Cannot import more than {max} host profiles at once'
}
const t = (key: string): string => dict[key] ?? key

describe('ERROR_CODES / ERROR_MESSAGE_KEYS', () => {
  it('每个错误码都登记了文案，避免新增错误码后界面显示裸码', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(ERROR_MESSAGE_KEYS[code], code).toBeTruthy()
    }
  })

  it('文案表没有多余的错误码', () => {
    const known = new Set<string>(Object.values(ERROR_CODES))
    for (const code of Object.keys(ERROR_MESSAGE_KEYS)) expect(known.has(code)).toBe(true)
  })
})

describe('AppError', () => {
  it('message 即错误码，便于日志检索', () => {
    const error = new AppError(ERROR_CODES.SESSION_NOT_FOUND)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AppError')
    expect(error.message).toBe('SESSION_NOT_FOUND')
    expect(error.code).toBe(ERROR_CODES.SESSION_NOT_FOUND)
  })

  it('携带文案插值参数', () => {
    expect(new AppError(ERROR_CODES.HOST_IMPORT_TOO_MANY, { max: 500 }).params).toEqual({ max: 500 })
  })

  it('isAppError 只认 AppError', () => {
    expect(isAppError(new AppError(ERROR_CODES.VAULT_LOCKED))).toBe(true)
    expect(isAppError(new Error('boom'))).toBe(false)
    expect(isAppError('boom')).toBe(false)
    expect(isAppError(null)).toBe(false)
    expect(isAppError(undefined)).toBe(false)
  })
})

describe('interpolateError', () => {
  it('替换已知占位符', () => {
    expect(interpolateError('最多 {max} 条', { max: 500 })).toBe('最多 500 条')
  })

  it('缺失参数原样保留，便于发现遗漏', () => {
    expect(interpolateError('最多 {max} 条', {})).toBe('最多 {max} 条')
    expect(interpolateError('最多 {max} 条')).toBe('最多 {max} 条')
  })

  it('只认自有属性，不会把原型链上的键当成参数', () => {
    expect(interpolateError('{toString}', {})).toBe('{toString}')
  })
})

describe('translateAppError', () => {
  it('把错误码翻译为当前语言', () => {
    expect(translateAppError(new AppError(ERROR_CODES.SESSION_NOT_FOUND), t)).toBe('Session not found')
  })

  it('先按参数插值再翻译', () => {
    expect(translateAppError(new AppError(ERROR_CODES.HOST_IMPORT_TOO_MANY, { max: 500 }), t)).toBe(
      'Cannot import more than 500 host profiles at once'
    )
  })

  it('非 AppError 返回 null，交由调用方兜底', () => {
    expect(translateAppError(new Error('boom'), t)).toBeNull()
    expect(translateAppError('boom', t)).toBeNull()
    expect(translateAppError(undefined, t)).toBeNull()
  })
})

describe('errorText', () => {
  it('AppError 走错误码映射', () => {
    expect(errorText(new AppError(ERROR_CODES.SESSION_NOT_FOUND), t, '兜底')).toBe('Session not found')
  })

  it('普通 Error 与字符串原样返回（多为后端错误）', () => {
    expect(errorText(new Error('boom'), t, '兜底')).toBe('boom')
    expect(errorText('boom', t, '兜底')).toBe('boom')
  })

  it('无可用信息时回退到兜底文案', () => {
    expect(errorText(undefined, t, '兜底')).toBe('兜底')
    expect(errorText(new Error(''), t, '兜底')).toBe('兜底')
    expect(errorText('', t, '兜底')).toBe('兜底')
  })
})
