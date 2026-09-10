import { create } from 'zustand'

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export interface VaultUnlockRequest {
  resolve: (unlocked: boolean) => void
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (accepted: boolean) => void
}

export type ToastKind = 'info' | 'success' | 'error' | 'warning'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface UiState {
  confirmRequest: ConfirmRequest | null
  vaultUnlockRequest: VaultUnlockRequest | null
  toasts: ToastItem[]
  confirm: (options: ConfirmOptions) => Promise<boolean>
  resolveConfirm: (accepted: boolean) => void
  requestVaultUnlock: () => Promise<boolean>
  resolveVaultUnlock: (unlocked: boolean) => void
  toast: (message: string, kind?: ToastKind) => void
  dismissToast: (id: number) => void
}

let nextId = 1

const TOAST_DURATION_MS: Record<ToastKind, number> = {
  info: 4000,
  success: 4000,
  error: 6000,
  warning: 6000
}

export const useUiFeedback = create<UiState>((set, get) => ({
  confirmRequest: null,
  vaultUnlockRequest: null,
  toasts: [],
  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      const pending = get().confirmRequest
      if (pending) pending.resolve(false)
      set({ confirmRequest: { ...options, resolve } })
    }),
  resolveConfirm: (accepted) => {
    const request = get().confirmRequest
    if (!request) return
    set({ confirmRequest: null })
    request.resolve(accepted)
  },
  requestVaultUnlock: () =>
    new Promise<boolean>((resolve) => {
      const pending = get().vaultUnlockRequest
      if (pending) pending.resolve(false)
      set({ vaultUnlockRequest: { resolve } })
    }),
  resolveVaultUnlock: (unlocked) => {
    const request = get().vaultUnlockRequest
    if (!request) return
    set({ vaultUnlockRequest: null })
    request.resolve(unlocked)
  },
  toast: (message, kind = 'info') => {
    const id = nextId
    nextId += 1
    set((state) => ({ toasts: [...state.toasts, { id, kind, message }] }))
    window.setTimeout(() => get().dismissToast(id), TOAST_DURATION_MS[kind])
  },
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
}))

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return useUiFeedback.getState().confirm(options)
}

export function requestVaultUnlock(): Promise<boolean> {
  return useUiFeedback.getState().requestVaultUnlock()
}

export function showToast(message: string, kind: ToastKind = 'info') {
  useUiFeedback.getState().toast(message, kind)
}
