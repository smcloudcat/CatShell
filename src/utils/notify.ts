import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'

export async function sendSystemNotification(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted()
    if (!granted) {
      const permission = await requestPermission()
      granted = permission === 'granted'
    }
    if (granted) {
      sendNotification({ title, body })
    }
  } catch {
    // 非 Tauri 环境或系统通知不可用时静默降级，页面内 Toast 已覆盖该场景
  }
}