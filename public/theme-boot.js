/*
 * 首帧主题引导脚本。
 *
 * 原先以内联 <script> 形式写在 index.html 里，但生产 CSP 已收紧到 `script-src 'self'`，
 * 内联脚本会被拦截（P2-10）。改为独立文件由页面以同源脚本加载，执行时机不变：
 * 经典脚本在解析到该标签时立即执行，仍在延迟加载的模块脚本之前，
 * 因此浅色系统用户不会看到深色令牌闪烁。
 */
document.documentElement.dataset.mode = window.matchMedia('(prefers-color-scheme: light)').matches
  ? 'light'
  : 'dark'
