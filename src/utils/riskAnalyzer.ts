/**
 * 命令风险分析（AI 辅助切片 · 本地规则，6.17）。
 *
 * 纯函数、零依赖：对「即将发送到远端 shell 的命令行」做静态规则匹配，
 * 命中即返回原因清单，由终端守卫弹确认框。刻意保持保守——只报「明确可造成
 * 不可逆破坏」的模式，避免常见命令误报让用户疲劳后习惯性点确认。
 *
 * 注意：这是启发式防线而非沙箱，多行 here-doc、base64 混淆、别名包装等都可能
 * 绕过；它拦截的是「手滑」和「无脑粘贴」，不是恶意软件。
 */

export interface CommandRisk {
  /** 规则 id（用于测试与去重） */
  id: string
  /** 人读原因（中文原文，审计/日志不做国际化） */
  reason: string
}

interface Rule {
  id: string
  reason: string
  pattern: RegExp
}

/**
 * 规则集。匹配在整行（含管道、`&&` 链）上进行。
 * 顺序无关——一次匹配可能命中多条，全部返回。
 */
const RULES: Rule[] = [
  {
    id: 'rm-rf-root',
    // rm 带 -r/-f 组合后目标落在根、家目录、通配符或当前目录
    reason: '递归强制删除根目录 / 家目录 / 通配路径，可能清空系统或个人数据',
    pattern: /\brm\s+(?:-{1,2}[a-zA-Z-]+\s+)*(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)(?:-{1,2}[a-zA-Z-]+\s+)*(?:\/(?:\s|$)|\/\*|~(?:\s|$|\/\s*$)|\*\/?(?:\s|$)|\.(?:\s|$))/
  },
  {
    id: 'no-preserve-root',
    reason: '--no-preserve-root 明确允许删除根目录，绝对不要在真实机器上执行',
    pattern: /--no-preserve-root/
  },
  {
    id: 'fork-bomb',
    reason: '疑似 fork 炸弹，会瞬间耗尽进程表使系统瘫痪',
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/
  },
  {
    id: 'mkfs',
    reason: 'mkfs 会格式化目标文件系统，设备名写错即不可逆',
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/
  },
  {
    id: 'dd-to-device',
    reason: 'dd 直接写块设备，of= 目标写错会覆盖整盘',
    pattern: /\bdd\b[^|;&]*\bof=\/dev\/(?:sd[a-z]|hd[a-z]|nvme\d+(?:n\d+)?(?:p\d+)?|vd[a-z]|mmcblk\d+(?:p\d+)?|xvd[a-z])/
  },
  {
    id: 'redirect-to-device',
    reason: '重定向写入块设备，会从设备头部开始破坏数据',
    pattern: /(?:>|>>)\s*\/dev\/(?:sd[a-z]|hd[a-z]|nvme\d+(?:n\d+)?(?:p\d+)?|vd[a-z]|mmcblk\d+(?:p\d+)?|xvd[a-z])(?:\d+)?(?:\s|$)/
  },
  {
    id: 'wipefs',
    reason: 'wipefs 会擦除设备上的文件系统签名，数据恢复极困难',
    pattern: /\bwipefs\b/
  },
  {
    id: 'blkdiscard',
    reason: 'blkdiscard 对 SSD 发出 discard 即丢弃全部数据块',
    pattern: /\bblkdiscard\b/
  },
  {
    id: 'chmod-777-root',
    reason: '递归 777 权限作用于根 / 家目录，系统安全边界全部打开',
    pattern: /\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)+777\s+(?:\/(?:\s|$)|~(?:\s|$)|\$HOME(?:\s|$))/
  },
  {
    id: 'chown-recursive-root',
    reason: '递归 chown 作用于根目录，系统文件属主会被整体改写',
    pattern: /\bchown\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)+[^\s]+\s+\/(?:\s|$)/
  },
  {
    id: 'find-root-delete',
    reason: 'find 从根目录开始 -delete，匹配即删且不可恢复',
    pattern: /\bfind\s+\/(?:\s|$)[^|;&]*\s-delete\b/
  },
  {
    id: 'mv-to-devnull',
    reason: 'mv 目标是 /dev/null，文件被直接丢弃（与重定向不同，无任何残留）',
    pattern: /\bmv\s+[^|;&]*\s\/dev\/null(?:\s|$)/
  },
  {
    id: 'pipe-to-shell',
    reason: '把网络内容直接管道给 shell 执行，脚本内容未经验证',
    pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh(?:\s|$)/
  },
  {
    id: 'shutdown',
    reason: '关机 / 重启命令，远程会话执行后连接立即中断',
    pattern: /\b(?:shutdown|reboot|halt|poweroff)(?:\s|$)|\binit\s+[06](?:\s|$)/
  },
  {
    id: 'kill-init',
    reason: '对 PID 1（init/systemd）发送致命信号，系统将立即失控',
    pattern: /\bkill\s+-[a-zA-Z]*9[a-zA-Z]*\s+1(?:\s|$)/
  },
  {
    id: 'drop-database',
    reason: 'DROP DATABASE / DROP SCHEMA 会连同数据一起删除整个库',
    pattern: /\bDROP\s+(?:DATABASE|SCHEMA)\b/i
  },
  {
    id: 'truncate-table',
    reason: 'TRUNCATE 会清空整表数据且通常不可回滚',
    pattern: /\bTRUNCATE\s+TABLE\b/i
  },
  {
    id: 'git-force-push-main',
    reason: '强制推送主分支，会抹掉远端他人的提交历史',
    pattern: /\bgit\s+push\b[^|;&]*(?:--force(?:-with-lease)?|-f)\b[^|;&]*\b(?:origin\b[^|;&]*)?\s*(?:main|master)\b/
  },
  {
    id: 'dd-of-raw-diskimage',
    reason: 'dd 写磁盘镜像文件到裸路径，常见于覆盖系统盘',
    pattern: /\bdd\b[^|;&]*\bof=\/(?:boot|etc|usr|var|bin|sbin)\b/
  },
  {
    id: 'chmod-000-etc',
    reason: '递归清空 /etc 权限会让系统下次启动即失败',
    pattern: /\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)+0{3}\s+\/etc\b/
  }
]

/** 分析一行命令，命中规则时返回全部原因（顺序与规则集一致）。 */
export function analyzeCommandRisk(command: string): CommandRisk[] {
  const line = command.trim()
  if (!line) return []
  const hits: CommandRisk[] = []
  for (const rule of RULES) {
    if (rule.pattern.test(line)) {
      hits.push({ id: rule.id, reason: rule.reason })
    }
  }
  return hits
}

/**
 * 从按键数据流里提取「用户输入的可见字符」用于行缓冲。
 * 只保留普通可打印字符与空格；控制序列（光标移动、历史召回、补全）不进入
 * 缓冲——它们会让缓冲与 shell 实际行偏离，此时守卫宁可漏报也不误拦，
 * 弹窗里会显示被分析的原文，用户自己可见地判断。
 */
export function isBufferableKeystroke(data: string): boolean {
  if (data.length !== 1) return false
  const code = data.charCodeAt(0)
  return (code >= 0x20 && code < 0x7f) || code >= 0xa0
}
