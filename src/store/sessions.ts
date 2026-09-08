import { create } from 'zustand'
import {
  sshConnect,
  sshDisconnect,
  sshList,
  sshRemove,
  sshResize,
  sshConfirmHostKey,
  sshWrite,
  subscribeSshEvents
} from '../api/ssh'
import { ConnectRequest, HostKeyPrompt, HostKeyWarning, SessionInfo, SessionStatusEvent } from '../types/session'
import { recordAudit } from './audit'

export interface TerminalRef {
  id: number
  write: (data: Uint8Array) => void
  focus: () => void
  fit: () => void
}

interface SessionsState {
  ready: boolean
  sessions: Record<number, SessionInfo>
  order: number[]
  activeId: number | null
  terminals: Record<number, TerminalRef>
  hostKeyPrompt: HostKeyPrompt | null
  hostKeyWarning: HostKeyWarning | null
  init: () => Promise<void>
  open: (request: ConnectRequest) => Promise<number>
  write: (id: number, data: Uint8Array) => Promise<void>
  resize: (id: number, cols: number, rows: number) => void
  disconnect: (id: number) => Promise<void>
  closeTab: (id: number) => Promise<void>
  setActive: (id: number | null) => void
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

// React Strict Mode can invoke the startup effect twice before the first
// asynchronous initialization completes. Share that initialization promise
// so SSH events are subscribed exactly once.
let initializationPromise: Promise<void> | null = null

export const useSessions = create<SessionsState>((set, get) => ({
  ready: false,
  sessions: {},
  order: [],
  activeId: null,
  terminals: {},
  hostKeyPrompt: null,
  hostKeyWarning: null,
  init: async () => {
    if (get().ready) return
    if (initializationPromise) return initializationPromise

    initializationPromise = (async () => {
      let list: SessionInfo[] = []
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
      await subscribeSshEvents({
        onStatus: (event) => get().updateStatus(event),
        onOutput: (event) => {
          appendSessionLog(event.id, new Uint8Array(event.data))
          const term = get().terminals[event.id]
          if (term) term.write(new Uint8Array(event.data))
        },
        onHostKeyPrompt: (event) => set({ hostKeyPrompt: event })
        ,onHostKeyWarning: (event) => set({ hostKeyWarning: event })
      })
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
            reason: event.reason
          }
        },
        order: s.order.includes(event.id) ? s.order : [...s.order, event.id]
      }))
      return
    }
    const updated: SessionInfo = { ...info, status: event.status, reason: event.reason }
    set({ sessions: { ...sessions, [event.id]: updated } })
    if (info && (event.status === 'connected' || event.status === 'disconnected' || event.status === 'closed')) {
      recordAudit('session.status', `${info.name} (${info.host}:${info.port})`, event.status === 'connected' ? 'success' : 'info', event.reason ?? event.status)
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
  open: async (request: ConnectRequest) => {
    let id: number
    try {
      id = await sshConnect(request)
    } catch (error) {
      recordAudit('session.connect', `${request.host}:${request.port}`, 'failure', '连接请求失败')
      throw error
    }
    recordAudit('session.connect', `${request.name} (${request.host}:${request.port})`, 'info', '已提交连接请求')
    set((s) => {
      const existing = s.sessions[id]
      const order = s.order.includes(id) ? s.order : [...s.order, id]
      return {
        order,
        activeId: id,
        sessions: {
          ...s.sessions,
          [id]: {
            id,
            name: existing?.name || request.name || `${request.username}@${request.host}`,
            host: existing?.host || request.host,
            port: existing?.port ?? request.port,
            username: existing?.username || request.username,
            status: existing?.status ?? 'connecting',
            reason: existing?.reason ?? undefined
          }
        }
      }
    })
    return id
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
      delete sessions[id]
      const order = s.order.filter((x) => x !== id)
      const terminals = { ...s.terminals }
      delete terminals[id]
      const activeId = s.activeId === id ? order[order.length - 1] ?? null : s.activeId
      return { sessions, order, terminals, activeId }
    })
  },
  setActive: (id) => set({ activeId: id }),
  registerTerminal: (ref) => set((s) => ({ terminals: { ...s.terminals, [ref.id]: ref } })),
  unregisterTerminal: (id) =>
    set((s) => {
      const terminals = { ...s.terminals }
      delete terminals[id]
      return { terminals }
    })
}))

export { getStatus }
