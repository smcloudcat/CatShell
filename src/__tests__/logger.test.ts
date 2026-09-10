import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../utils/logger'

describe('logger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds the shared prefix and forwards a detail argument when present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const detail = new Error('boom')

    logger.warn('保存主机配置失败，使用本地回退存储', detail)

    expect(warn).toHaveBeenCalledWith('[CatShell] 保存主机配置失败，使用本地回退存储', detail)
  })

  it('omits the detail argument entirely when none is given', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    logger.error('界面渲染发生未捕获错误')

    expect(error).toHaveBeenCalledWith('[CatShell] 界面渲染发生未捕获错误')
  })

  it('routes each level to its matching console method', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    logger.info('已订阅 SSH 事件')
    logger.error('订阅 SSH 事件失败')

    expect(info).toHaveBeenCalledWith('[CatShell] 已订阅 SSH 事件')
    expect(error).toHaveBeenCalledWith('[CatShell] 订阅 SSH 事件失败')
  })
})
