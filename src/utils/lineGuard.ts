/**
 * 终端行守卫（AI 辅助切片 · 风险提示，6.17）。
 *
 * 在 xterm 的 onData（按键级）与 SSH 通道之间插入一层行缓冲：
 * - 可打印字符进入缓冲并正常放行（shell 那边照常回显）；
 * - Enter（\r）时先分析缓冲的整行命令，命中风险规则则**扣下 \r**，
 *   等用户在确认框里选择：确认执行（补发 \r）或取消（补发 \x03 即 Ctrl+C）；
 * - Ctrl+U 清行、Ctrl+C 清缓冲、退格同步弹出；粘贴的整块数据若含换行
 *   则对每个完整行分别分析，任一行命中就扣下整块。
 *
 * 已知盲区（设计上接受）：方向键历史召回、Tab 补全的结果不经过 onData，
 * 缓冲会与 shell 行偏离；此时宁可漏报也不误拦，且弹窗展示被分析的原文，
 * 用户永远看得到「守卫在担心什么」。
 */

import { analyzeCommandRisk, isBufferableKeystroke, type CommandRisk } from './riskAnalyzer'

export interface GuardDecision {
  /** 命中的风险（空数组 = 直接放行） */
  risks: CommandRisk[]
  /** 被 analysis 的原文（弹窗展示用） */
  line: string
}

export class TerminalLineGuard {
  private buffer = ''

  /** 按键数据进入守卫。返回本层应放行的字节；扣下时通过 resolve 交还。 */
  feed(data: string): { passthrough: string; held: GuardDecision | null } {
    // 1) 粘贴块 / 多字符数据：含 \r 就整块分析
    if (data.includes('\r') || data.includes('\n')) {
      const segments = data.split(/\r\n|\r|\n/)
      const lines = segments.map((seg) => this.buffer + seg).map((line) => line.trim()).filter(Boolean)
      // 粘贴通常最后一行才是要执行的命令；全部检查，命中任何一条都拦
      for (const line of lines) {
        const risks = analyzeCommandRisk(line)
        if (risks.length) {
          this.buffer = ''
          return { passthrough: '', held: { risks, line } }
        }
      }
      this.buffer = ''
      return { passthrough: data, held: null }
    }

    // 2) Enter：分析当前行
    if (data === '\r') {
      const line = this.buffer.trim()
      this.buffer = ''
      if (line) {
        const risks = analyzeCommandRisk(line)
        if (risks.length) {
          return { passthrough: '', held: { risks, line } }
        }
      }
      return { passthrough: data, held: null }
    }

    // 3) 控制键
    if (data === '\x7f' || data === '\b') {
      // 退格：弹出一个字符（xterm 已把光标回退，shell 行也变了）
      this.buffer = this.buffer.slice(0, -1)
      return { passthrough: data, held: null }
    }
    if (data === '\x15') {
      // Ctrl+U 清行
      this.buffer = ''
      return { passthrough: data, held: null }
    }
    if (data === '\x03') {
      // Ctrl+C 中断当前行
      this.buffer = ''
      return { passthrough: data, held: null }
    }
    if (data === '\x04') {
      // Ctrl+D（EOF）：shell 收到空行才退出，放行并清缓冲
      this.buffer = ''
      return { passthrough: data, held: null }
    }

    // 4) 可打印字符入缓冲；其它控制序列（方向键、Tab 等）不入缓冲
    if (isBufferableKeystroke(data)) {
      if (this.buffer.length < 4096) this.buffer += data
    }
    return { passthrough: data, held: null }
  }

  /** 用户确认执行：补发被扣下的按键并清缓冲。 */
  confirm(): string {
    this.buffer = ''
    return '\r'
  }

  /** 用户取消：补发 Ctrl+C 取消 shell 当前输入行。 */
  cancel(): string {
    this.buffer = ''
    return '\x03'
  }

  reset(): void {
    this.buffer = ''
  }
}
