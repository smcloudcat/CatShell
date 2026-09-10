import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

/**
 * Tauri CLI 在 `tauri dev` / `tauri build` 时注入的平台标识。
 * 为空说明是普通 `vite build`（例如 CI 里的前端产物校验）。
 */
const platform = process.env.TAURI_ENV_PLATFORM;
/** 调试构建：保留可读产物，不压缩、带 sourcemap。 */
const isDebugBuild = Boolean(process.env.TAURI_ENV_DEBUG);

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // 允许 TAURI_ENV_* 前缀的变量出现在 import.meta.env 中
  envPrefix: ["VITE_", "TAURI_ENV_"],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // 各平台 WebView 的下限：Windows 走 WebView2（Chromium），其余是 WKWebView / WebKitGTK。
    // 未指定平台时返回 undefined，交给 Vite 自己的基线，避免 CI 的纯前端构建被过度降级。
    target: platform === "windows" ? "chrome105" : platform ? "safari13" : undefined,
    // 发布产物不带 sourcemap（体积敏感），调试构建才生成以便定位问题。
    sourcemap: isDebugBuild,
    minify: !isDebugBuild,
    // 手动分包：把体积大且很少变动的第三方拆出去，业务代码改动不再迫使
    // 浏览器重下整包。Vite 8 底层是 Rolldown，用 codeSplitting.groups 而非
    // Rollup 时代的 output.manualChunks。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // React 运行时只在升级 React 时变化，长期缓存收益最大。
            { test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, name: "react" },
            // xterm 及其 addon 体积可观且仅会话页使用，单独成块便于并行加载。
            { test: /node_modules[\\/]@xterm[\\/]/, name: "xterm" },
            // 只匹配 @tauri-apps/api。plugin-* 里有按需加载的模块（如 plugin-dialog），
            // 一并归组会把它重新变回静态依赖，反而破坏懒加载。
            { test: /node_modules[\\/]@tauri-apps[\\/]api[\\/]/, name: "tauri-api" },
          ],
        },
      },
    },
    // 分包后单块都不大，阈值略高于默认值以容纳 xterm。
    chunkSizeWarningLimit: 600,
  },
}));
