/**
 * 跨 Store 共享的持久化基础设施。
 *
 * `createPersistChain`（审计 M-6）：对同一存储文件的所有异步写共用一条 Promise 链，
 * 保证「最后一次调用的值 = 最终落盘值」——并行写 `load→set→save` 时，较早快照
 * 可能较晚完成并覆盖较新快照（hosts / snippets / sessionRestore / transferQueue
 * 都翻过车，settings.ts 的模块级写链是正确原型，这里抽成通用工具）。
 *
 * 链上任务自行处理异常：一次失败不会短路后续写入（前一个任务 reject 时，
 * 后续任务仍然按序执行）。
 */
export type PersistChain = <T>(task: () => Promise<T>) => Promise<T>

export function createPersistChain(): PersistChain {
  let chain: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = chain.then(task, task)
    chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
