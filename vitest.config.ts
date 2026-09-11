import { defineConfig } from 'vitest/config'

/**
 * 池选型说明（2026-09-10 深夜）：
 * 本机环境（WorkBuddy 注入的 NODE_OPTIONS 预载 shim + safe-bin PATH 层）下，
 * vitest 默认的 forks 池与 threads 池启动 worker 即失败
 * （所有套件在 describe 处报 "Cannot read properties of undefined (reading 'config')"）。
 * vmThreads 池不受影响，全部用例可正常运行，故固定为 vmThreads。
 * 纯 TS 单测（无组件渲染、无原生模块），vm 上下文的隔离与内存开销可以接受。
 * 若日后环境恢复，可改回默认池验证后删除本覆盖。
 */
export default defineConfig({
  test: {
    pool: 'vmThreads'
  }
})
