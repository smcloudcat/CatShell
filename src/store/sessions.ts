import { create } from 'zustand'
import { Channel } from '@tauri-apps/api/core'
import {
  kbiRespond,
  sshConnect,
  sshDisconnect,
  sshList,
  sshRemove,
  sshResize,
  sshConfirmHostKey,
  sshWrite,
  subscribeSshEvents,
  type SshOutputChannel
} from '../api/ssh'
import { ConnectRequest, HostKeyPrompt, HostKeyWarning, KbiPromptEvent, SessionInfo, SessionStatusEvent } from '../types/session'
import { AppError, ERROR_CODES } from '../types/errors'
import { logger } from '../utils/logger'
import { formatSessionNotice, sessionNoticeFor } from '../utils/sessionStatusToast'
import { sendSystemNotification } from '../utils/notify'
import { t } from '../i18n'
import { recordAudit } from './audit'
import { showToast } from './ui'
import { recordOutput } from './recording'

export interface TerminalRef {
  id: number
  write: (data: Uint8Array) => void
  focus: () => void
  fit: () => void
  openSearch?: () => void
  /** 当前可视尺寸（列/行），录制等需要真实终端几何的场景使用；缺省回落 80x24。 */
  getSize?: () => { cols: number; rows: number }
}

interface SessionsState {
  ready: boolean
  sessions: Record<number, SessionInfo>
  order: number[]
  activeId: number | null
  splitId: number | null
  terminals: Record<number, TerminalRef>
  requests: Record<number, ConnectRequest>
  /** 会话 → 主机配置 id 的关联，用于「恢复上次会话」定位主机与凭据 */
  hostIds: Record<number, string>
  connectedAt: Record<number, number>
  hostKeyPrompt: HostKeyPrompt | null
  hostKeyWarning: HostKeyWarning | null
  /** 交互式认证弹窗队列：多个会话同时追问时逐个应答，避免覆盖丢失。 */
  kbiPrompts: KbiPromptEvent[]
  broadcastEnabled: boolean
  broadcastTargets: number[]
  init: () => Promise<void>
  open: (request: ConnectRequest, hostId?: string) => Promise<number>
  reconnect: (id: number) => Promise<number>
  write: (id: number, data: Uint8Array) => Promise<void>
  resize: (id: number, cols: number, rows: number) => void
  disconnect: (id: number) => Promise<void>
  closeTab: (id: number) => Promise<void>
  renameSession: (id: number, name: string) => void
  setActive: (id: number | null) => void
  setSplit: (id: number | null) => void
  answerKbi: (answers: string[]) => Promise<void>
  cancelKbi: () => void
  setBroadcastEnabled: (enabled: boolean) => void
  toggleBroadcastTarget: (id: number) => void
  registerTerminal: (ref: TerminalRef) => void
  unregisterTerminal: (id: number) => void
  updateStatus: (event: SessionStatusEvent) => void
  confirmHostKey: (accepted: boolean) => Promise<void>
}

const getStatus = (info: SessionInfo) => info.status
const MAX_SESSION_LOG_BYTES = 2 * 1024 * 1024

interface SessionLogBuffer {
  chunks: Uint8Array[]
  size: number
}

const sessionLogs = new Map<number, SessionLogBuffer>()

function appendSessionLog(id: number, data: Uint8Array) {
  if (!data.length) return
  const buffer = sessionLogs.get(id) ?? { chunks: [], size: 0 }
  const chunk = data.slice()
  buffer.chunks.push(chunk)
  buffer.size += chunk.byteLength
  while (buffer.size > MAX_SESSION_LOG_BYTES && buffer.chunks.length) {
    const overflow = buffer.size - MAX_SESSION_LOG_BYTES
    const first = buffer.chunks[0]
    // 循环条件已保证队列非空，这里只是满足 noUncheckedIndexedAccess 的兜底
    if (first === undefined) break
    if (first.byteLength <= overflow) {
      buffer.chunks.shift()
      buffer.size -= first.byteLength
    } else {
      buffer.chunks[0] = first.slice(overflow)
      buffer.size -= overflow
    }
  }
  sessionLogs.set(id, buffer)
}

export function getSessionLog(id: number): Uint8Array {
  const buffer = sessionLogs.get(id)
  if (!buffer) return new Uint8Array()
  const result = new Uint8Array(buffer.size)
  let offset = 0
  for (const chunk of buffer.chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export function clearSessionLog(id: number) {
  sessionLogs.delete(id)
}

function bytesFromChannel(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(data as number[])
  return new Uint8Array()
}

// React Strict Mode can invoke the startup effect twice before the first
// asynchronous initialization completes. Share that initialization promise
// so SSH events are subscribed exactly once.
let initializationPromise: Promise<void> | null = null

/** 为单个会话建立终端输出 IPC Channel（原始字节）。id 在 invoke 返回后回填。 */
function createOutputChannel(idBox: { id: number }): SshOutputChannel {
  const channel = new Channel<ArrayBuffer | number[]>()
  channel.onmessage = (data) => {
    const bytes = bytesFromChannel(data)
    if (!bytes.length) return
    appendSessionLog(idBox.id, bytes)
    recordOutput(idBox.id, bytes)
    const term = useSessions.getState().terminals[idBox.id]
    if (term) term.write(bytes)
  }
  return channel
}

export const useSessions = create<SessionsState>((set, get) => ({
  ready: false,
  sessions: {},
  order: [],
  activeId: null,
  splitId: null,
  terminals: {},
  requests: {},
  hostIds: {},
  connectedAt: {},
  hostKeyPrompt: null,
  hostKeyWarning: null,
  kbiPrompts: [],
  broadcastEnabled: false,
  broadcastTargets: [],
  init: async () => {
    if (get().ready) return
    if (initializationPromise) return initializationPromise

    initializationPromise = (async () => {
      let list: SessionInfo[]
      try {
        list = await sshList()
      } catch {
        list = []
      }
      const sessions: Record<number, SessionInfo> = {}
      const order: number[] = []
      for (const info of list) {
        sessions[info.id] = info
        order.push(info.id)
      }
      set({ sessions, order, ready: true, activeId: order[0] ?? null })
      try {
        await subscribeSshEvents({
          onStatus: (event) => get().updateStatus(event),
          onOutput: (id, data) => {
            appendSessionLog(id, data)
            recordOutput(id, data)
            const term = get().terminals[id]
            if (term) term.write(data)
          },
          onHostKeyPrompt: (event) => set({ hostKeyPrompt: event })
          ,onHostKeyWarning: (event) => set({ hostKeyWarning: event })
          ,onKbiPrompt: (event) => set((s) => ({ kbiPrompts: [...s.kbiPrompts, event] }))
        })
      } catch (err) {
        // 非 Tauri 环境（npm run dev 浏览器预览）无法订阅 SSH 事件，属于预期降级
        logger.warn('SSH 事件订阅不可用，当前仅浏览器预览模式', err)
      }
    })()

    return initializationPromise
  },
  updateStatus: (event) => {
    const { sessions } = get()
    const info = sessions[event.id]
    if (!info) {
      set((s) => ({
        sessions: {
          ...s.sessions,
          [event.id]: {
            id: event.id,
            name: '',
            host: '',
            port: 22,
            username: '',
            status: event.status,
            reason: event.reason ?? null,
            attempt: event.attempt
          }
        },
        order: s.order.includes(event.id) ? s.order : [...s.order, event.id],
        connectedAt: event.status === 'connected'
          ? { ...s.connectedAt, [event.id]: Date.now() }
          : s.connectedAt
      }))
      return
    }
    const updated: SessionInfo = { ...info, status: event.status, reason: event.reason ?? null, attempt: event.attempt }
    const connectedAt = { ...get().connectedAt }
    if (event.status === 'connected') connectedAt[event.id] = Date.now()
    if (event.status === 'disconnected' || event.status === 'closed') delete connectedAt[event.id]
    set({ sessions: { ...sessions, [event.id]: updated }, connectedAt })
    const prompt = get().hostKeyPrompt
    if (
      (event.status === 'disconnected' || event.status === 'closed') &&
      prompt &&
      prompt.host === info.host &&
      prompt.port === info.port
    ) {
      set({ hostKeyPrompt: null })
    }
    if (info && (event.status === 'connected' || event.status === 'disconnected' || event.status === 'closed')) {
      recordAudit('session.status', `${info.name} (${info.host}:${info.port})`, event.status === 'connected' ? 'success' : 'info', event.reason ?? event.status)
    }
    // 状态转变通知：掉线 / 重连 / 重连成功。判定与文案键选择在纯函数里，便于单测。
    const notice = sessionNoticeFor(info?.status, event.status, event.attempt, {
      autoReconnect: Boolean(get().requests[event.id]?.autoReconnect)
    })
    if (notice) {
      const text = formatSessionNotice(notice, t)
      showToast(text, notice.kind)
      if (notice.systemNotify && typeof document !== 'undefined' && document.hidden) {
        const label = info?.name ? `${info.name}：` : ''
        void sendSystemNotification('CatShell', `${label}${text}`)
      }
    }
  },
  confirmHostKey: async (accepted) => {
    const prompt = get().hostKeyPrompt
    if (!prompt) return
    try {
      await sshConfirmHostKey(prompt.token, accepted)
    } finally {
      set({ hostKeyPrompt: null })
    }
  },
  open: async (request: ConnectRequest, hostId?: string) => {
    const idBox: { id: number } = { id: 0 }
    let id: number
    try {
      id = await sshConnect(request, createOutputChannel(idBox))
    } catch (error) {
      recordAudit('session.connect', `${request.host}:${request.port}`, 'failure', '连接请求失败')
      throw error
    }
    idBox.id = id
    recordAudit('session.connect', `${request.name} (${request.host}:${request.port})`, 'info', '已提交连接请求')
    set((s) => {
      const existing = s.sessions[id]
      const order = s.order.includes(id) ? s.order : [...s.order, id]
      return {
        order,
        activeId: id,
        requests: { ...s.requests, [id]: request },
        hostIds: hostId ? { ...s.hostIds, [id]: hostId } : s.hostIds,
        sessions: {
          ...s.sessions,
          [id]: {
            id,
            name: existing?.name || request.name || `${request.username}@${request.host}`,
            host: existing?.host || request.host,
            port: existing?.port ?? request.port,
            username: existing?.username || request.username,
            status: existing?.status ?? 'connecting',
            reason: existing?.reason ?? null
          }
        }
      }
    })
    return id
  },
  reconnect: async (id) => {
    const request = get().requests[id]
    const info = get().sessions[id]
    if (!request || !info) throw new AppError(ERROR_CODES.SESSION_MISSING_CONNECTION_PARAMS)
    const idBox: { id: number } = { id: 0 }
    const newId = await sshConnect(request, createOutputChannel(idBox))
    idBox.id = newId
    recordAudit('session.connect', `${info.name} (${info.host}:${info.port})`, 'info', '从已断开标签重新连接')
    set((s) => {
      const sessions = { ...s.sessions }
      const requests = { ...s.requests }
      const terminals = { ...s.terminals }
      const hostIds = { ...s.hostIds }
      const connectedAt = { ...s.connectedAt }
      const carriedHostId = hostIds[id]
      delete sessions[id]
      delete requests[id]
      delete terminals[id]
      delete hostIds[id]
      delete connectedAt[id]
      sessions[newId] = {
        id: newId,
        name: info.name,
        host: info.host,
        port: info.port,
        username: info.username,
        status: 'connecting'
      }
      const order = [...new Set(s.order.map((item) => (item === id ? newId : item)))]
      const activeId = s.activeId === id ? newId : s.activeId
      const splitId = s.splitId === id ? newId : s.splitId
      return {
        sessions,
        requests,
        hostIds: carriedHostId ? { ...hostIds, [newId]: carriedHostId } : hostIds,
        order,
        terminals,
        connectedAt,
        activeId,
        splitId
      }
    })
    return newId
  },
  write: async (id: number, data: Uint8Array) => {
    await sshWrite(id, data)
  },
  resize: (id: number, cols: number, rows: number) => {
    void sshResize(id, cols, rows).catch(() => undefined)
  },
  disconnect: async (id: number) => {
    const info = get().sessions[id]
    if (info && getStatus(info) !== 'closed') {
      set((s) => ({
        sessions: { ...s.sessions, [id]: { ...info, status: 'closing' } }
      }))
    }
    await sshDisconnect(id)
    if (info) recordAudit('session.disconnect', `${info.name} (${info.host}:${info.port})`, 'success', '已请求断开')
  },
  closeTab: async (id: number) => {
    await sshRemove(id)
    clearSessionLog(id)
    set((s) => {
      const sessions = { ...s.sessions }
      const requests = { ...s.requests }
      delete sessions[id]
      delete requests[id]
      const order = s.order.filter((x) => x !== id)
      const terminals = { ...s.terminals }
      delete terminals[id]
      const hostIds = { ...s.hostIds }
      delete hostIds[id]
      const connectedAt = { ...s.connectedAt }
      delete connectedAt[id]
      const nextActive = s.activeId === id ? order[order.length - 1] ?? null : s.activeId
      const splitId = s.splitId === id ? null : nextActive === s.splitId ? null : s.splitId
      return { sessions, requests, order, terminals, hostIds, connectedAt, activeId: nextActive, splitId }
    })
  },
  renameSession: (id, name) => {
    const info = get().sessions[id]
    if (!info) throw new AppError(ERROR_CODES.SESSION_NOT_FOUND)
    const trimmed = name.trim().slice(0, 80)
    if (!trimmed) throw new AppError(ERROR_CODES.SESSION_NAME_EMPTY)
    const request = get().requests[id]
    set((s) => ({
      sessions: { ...s.sessions, [id]: { ...info, name: trimmed } },
      requests: request ? { ...s.requests, [id]: { ...request, name: trimmed } } : s.requests
    }))
  },
  setActive: (id) =>
    set((s) => ({
      activeId: id,
      // 激活的标签即分屏会话时退出分屏，保持"分屏两侧必须是不同会话"的不变式
      splitId: id !== null && id === s.splitId ? null : s.splitId
    })),
  setSplit: (id) =>
    set((s) => {
      if (id === null) return { splitId: null }
      // 分屏两侧必须是不同会话；若与活动标签相同则回退为不启用
      if (id === s.activeId) return { splitId: null }
      return { splitId: id }
    }),
  answerKbi: async (answers) => {
    const prompt = get().kbiPrompts[0]
    if (!prompt) return
    try {
      await kbiRespond(prompt.sessionId, answers)
    } finally {
      set((s) => ({ kbiPrompts: s.kbiPrompts.slice(1) }))
    }
  },
  cancelKbi: () => {
    const prompt = get().kbiPrompts[0]
    if (!prompt) return
    set((s) => ({ kbiPrompts: s.kbiPrompts.slice(1) }))
    // 发送空应答让后端立即结束（oneshot 关闭视为取消）
    void kbiRespond(prompt.sessionId, []).catch(() => undefined)
  },
  setBroadcastEnabled: (enabled) => {
    if (!enabled) {
      set({ broadcastEnabled: false, broadcastTargets: [] })
      return
    }
    const connected = get().order.filter((id) => get().sessions[id]?.status === 'connected')
    set({ broadcastEnabled: true, broadcastTargets: connected })
  },
  toggleBroadcastTarget: (id) =>
    set((s) => ({
      broadcastTargets: s.broadcastTargets.includes(id)
        ? s.broadcastTargets.filter((item) => item !== id)
        : [...s.broadcastTargets, id]
    })),
  registerTerminal: (ref) => set((s) => ({ terminals: { ...s.terminals, [ref.id]: ref } })),
  unregisterTerminal: (id) =>
    set((s) => {
      const terminals = { ...s.terminals }
      delete terminals[id]
      return { terminals }
    })
}))

export { getStatus }
