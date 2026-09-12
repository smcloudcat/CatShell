import { create } from 'zustand'
import { buildAsciicast, RecordingChunk } from '../utils/asciicast'

/**
 * 会话录制器：在前端输出流上采集 stdout，停止时合成 asciicast v2 文本。
 *
 * 只保存内存缓冲与「正在录制」标记；落盘（recording_save）与读取由 Rust 侧
 * 录制库负责。密码输入不会被终端回显（pty echo 关闭），因此采集到的输出
 * 不含口令明文——但屏幕上回显过的内容都会被录下，录制前由 UI 提示风险。
 */

interface RecordingSession {
  /** performance.now() 起点，用于毫秒偏移。 */
  monotonicStart: number
  /** Unix 秒，写进 asciicast header。 */
  startedAt: number
  cols: number
  rows: number
  title: string
  chunks: RecordingChunk[]
  /** 连续 UTF-8 流解码器：多字节字符可能跨块。 */
  decoder: TextDecoder
  /** 已累积文本的字符数，用于封顶（审计 P-6）。 */
  bufferedLength: number
  /** 达到上限后置位：此后只丢弃输出，不再增长缓冲。 */
  truncated: boolean
}

/**
 * 录制缓冲上限（字符数，约 2 MB 量级，与会话输出日志对齐）。
 *
 * 录制缓冲按输出字节无限增长；长时间高频输出的会话（例如 `tail -f`、
 * 反复刷新的构建日志）足以把渲染进程内存撑爆（审计 P-6）。
 */
const MAX_RECORDING_LENGTH = 2 * 1024 * 1024
/** 截断时写进录制内容本身，回放时一眼能看出后段未被记录。 */
const TRUNCATION_NOTICE = '\r\n[CatShell] 录制缓冲已达上限（约 2 MB），后续输出未记录\r\n'

const sessions = new Map<number, RecordingSession>()

interface RecordingStoreState {
  /** 正在录制的会话 id 集合（对象形式便于 zustand 浅比较）。 */
  active: Record<number, true>
}

export const useRecordingStore = create<RecordingStoreState>(() => ({ active: {} }))

export function isRecording(sessionId: number): boolean {
  return sessions.has(sessionId)
}

/** 开始录制。重复调用同一会话会先隐式停止并丢弃旧缓冲。 */
export function startRecording(sessionId: number, meta: { title: string; cols: number; rows: number }): void {
  sessions.delete(sessionId)
  sessions.set(sessionId, {
    monotonicStart: performance.now(),
    startedAt: Math.floor(Date.now() / 1000),
    cols: meta.cols,
    rows: meta.rows,
    title: meta.title,
    chunks: [],
    decoder: new TextDecoder('utf-8'),
    bufferedLength: 0,
    truncated: false
  })
  useRecordingStore.setState((state) => ({ active: { ...state.active, [sessionId]: true } }))
}

/** 结束录制并返回 asciicast v2 文本；未在录制时返回 null。 */
export function stopRecording(sessionId: number): string | null {
  const session = sessions.get(sessionId)
  useRecordingStore.setState((state) => {
    if (!(sessionId in state.active)) return state
    const active = { ...state.active }
    delete active[sessionId]
    return { active }
  })
  if (!session) return null
  sessions.delete(sessionId)
  const text = buildAsciicast({
    width: session.cols,
    height: session.rows,
    startedAt: session.startedAt,
    title: session.title,
    chunks: session.chunks
  })
  return text
}

/** 输出入口：把一段原始终端输出（UTF-8 字节）追加进录制缓冲。 */
export function recordOutput(sessionId: number, bytes: Uint8Array): void {
  const session = sessions.get(sessionId)
  if (!session || bytes.length === 0 || session.truncated) return
  // stream: true 保证跨块的多字节字符不会被打碎
  const text = session.decoder.decode(bytes, { stream: true })
  if (!text) return
  if (session.bufferedLength + text.length > MAX_RECORDING_LENGTH) {
    // 封顶（审计 P-6）：截断点在缓冲区里留一条提示，回放时能看出后段缺失。
    session.chunks.push({
      offsetMs: performance.now() - session.monotonicStart,
      text: TRUNCATION_NOTICE
    })
    session.truncated = true
    return
  }
  session.bufferedLength += text.length
  session.chunks.push({ offsetMs: performance.now() - session.monotonicStart, text })
}

/**
 * 丢弃某会话的录制缓冲与「录制中」标记（审计 P-6）。
 *
 * 关闭标签 / 重连时调用：否则缓冲与 `active[id]` 都会残留，录制指示灯卡在
 * 「录制中」且再也操作不了那个条目。
 */
export function discardRecording(sessionId: number): void {
  sessions.delete(sessionId)
  useRecordingStore.setState((state) => {
    if (!(sessionId in state.active)) return state
    const active = { ...state.active }
    delete active[sessionId]
    return { active }
  })
}

/** 录制时长（毫秒）；未在录制返回 null。 */
export function recordingElapsedMs(sessionId: number): number | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  return performance.now() - session.monotonicStart
}

/** 生成录制文件基名：`{会话名}-{yyyyMMdd-HHmmss}`。 */
export function recordingBaseName(title: string, startedAtMs: number): string {
  const date = new Date(startedAtMs)
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const safeTitle = title.trim().replace(/\s+/g, '-') || 'session'
  return `${safeTitle}-${stamp}`
}
