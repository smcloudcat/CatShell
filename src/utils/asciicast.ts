/**
 * asciicast v2（asciinema）纯函数：构造、解析与时间轴。
 *
 * 格式：JSONL，首行 header（version=2），后续每行 `[秒, 类型, 数据]`。
 * 录制只产出 `o`（stdout）事件；解析容忍坏行并归入 warnings。
 * 参见 https://docs.asciinema.org/manual/asciicast/v2/
 */

export interface AsciicastHeader {
  version: 2
  width: number
  height: number
  /** Unix 秒，文件创建时刻。 */
  timestamp: number
  title?: string
  env?: Record<string, string>
}

export interface AsciicastEvent {
  /** 相对文件头的秒数。 */
  time: number
  type: 'o' | 'i' | 'm' | 'r' | 'x'
  data: string
}

export interface AsciicastDoc {
  header: AsciicastHeader | null
  events: AsciicastEvent[]
  /** 无法解析的行（1 起始行号）。 */
  warnings: string[]
}

/** 录制中的一个输出片段（相对录制起点的毫秒偏移）。 */
export interface RecordingChunk {
  offsetMs: number
  text: string
}

/** 秒的序列化：asciicast 惯例保留小数，6 位足够微秒精度。 */
function formatSeconds(seconds: number): string {
  return seconds.toFixed(6)
}

/** 构造完整的 asciicast v2 文本（JSONL，LF 结尾）。 */
export function buildAsciicast(options: {
  width: number
  height: number
  /** Unix 秒。 */
  startedAt: number
  title?: string
  chunks: RecordingChunk[]
}): string {
  // 非正数或 NaN（含负数被 trunc 保留真值的情况）一律回落默认尺寸
  const width = Math.trunc(options.width)
  const height = Math.trunc(options.height)
  const header: AsciicastHeader = {
    version: 2,
    width: width > 0 ? width : 80,
    height: height > 0 ? height : 24,
    timestamp: Math.trunc(options.startedAt) || 0,
    ...(options.title ? { title: options.title } : {})
  }
  const lines: string[] = [JSON.stringify(header)]
  for (const chunk of options.chunks) {
    if (!chunk.text) continue
    const seconds = Math.max(0, chunk.offsetMs) / 1000
    lines.push(`[${formatSeconds(seconds)}, "o", ${JSON.stringify(chunk.text)}]`)
  }
  return lines.join('\n') + '\n'
}

/**
 * 解析 asciicast 文本。宽容处理：跳过空行与坏行（记入 warnings）；
 * header 缺失或 version 不是 2 时 header 返回 null，事件仍尽力解析。
 */
export function parseAsciicast(content: string): AsciicastDoc {
  const warnings: string[] = []
  const events: AsciicastEvent[] = []
  let header: AsciicastHeader | null = null

  const lines = content.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (!line.trim()) return
    if (index === 0) {
      try {
        const parsed = JSON.parse(line) as Partial<AsciicastHeader>
        if (parsed && parsed.version === 2) {
          header = {
            version: 2,
            width: Number(parsed.width) || 80,
            height: Number(parsed.height) || 24,
            timestamp: Number(parsed.timestamp) || 0,
            ...(parsed.title ? { title: String(parsed.title) } : {})
          }
          return
        }
        warnings.push(`第 1 行：version 不是 2`)
      } catch {
        warnings.push('第 1 行：header 不是合法 JSON')
      }
      return
    }
    try {
      const parsed = JSON.parse(line) as [number, string, string]
      if (!Array.isArray(parsed) || parsed.length < 3) {
        warnings.push(`第 ${index + 1} 行：事件不是三元组`)
        return
      }
      const [time, type, data] = parsed
      const seconds = Number(time)
      if (!Number.isFinite(seconds) || seconds < 0 || typeof data !== 'string') {
        warnings.push(`第 ${index + 1} 行：时间或数据非法`)
        return
      }
      if (type === 'o' || type === 'i' || type === 'm' || type === 'r' || type === 'x') {
        events.push({ time: seconds, type, data })
      } else {
        warnings.push(`第 ${index + 1} 行：未知事件类型 ${String(type)}`)
      }
    } catch {
      warnings.push(`第 ${index + 1} 行：不是合法 JSON`)
    }
  })

  return { header, events, warnings }
}

/** 事件序列的总时长（秒）；空序列为 0。 */
export function asciicastDuration(events: AsciicastEvent[]): number {
  let last = 0
  for (const event of events) {
    if (event.time > last) last = event.time
  }
  return last
}

/** 回放时间轴：把事件按时间排序并仅保留会改变画面的输出事件。 */
export function playbackTimeline(events: AsciicastEvent[]): AsciicastEvent[] {
  return events
    .filter((event) => event.type === 'o')
    .sort((a, b) => a.time - b.time)
}
