# CatShell 🐾

> 服务器远程运维桌面工具 · SSH 终端 / SFTP 传输 / 服务器监控

CatShell 是一款面向 Windows 的桌面 SSH 运维工具，基于 **Tauri 2 + React 19 + Rust** 构建。它把日常服务器运维最常用的能力集成到一个低调、安全的桌面应用里：

- 多标签 SSH2 终端，支持密码 / SSH 私钥认证
- 会话心跳保活、断线自动重连、PTY 尺寸实时同步
- SFTP 目录浏览与文件上传 / 下载 / 在线编辑
- 基于 SSH exec 的轻量服务器监控（CPU / 内存 / 磁盘 / 网络 / 进程 / 网络诊断）
- 本地 / 远程 / 动态(SOCKS5) 端口转发
- 主密码保护的加密凭据保险箱
- 命令片段库与参数化命令模板
- 操作审计日志、配置导入导出与一键备份还原

## 功能特性

| 模块 | 说明 |
| --- | --- |
| SSH 终端 | 多标签页会话、密码 / RSA / ED25519 / ECDSA 私钥认证、PTY 尺寸同步、实时输出、心跳保活、断线自动重连（最多 3 次） |
| 主机管理 | 主机配置保存、搜索、编辑、删除、导入导出、快速连接（分组标签规划中） |
| SFTP | 目录浏览、单文件上传 / 下载 / 删除（单文件上限 64 MB）、批量上传自动重试、远程文本文件在线编辑 |
| 服务器监控 | 基于固定只读命令的免插件采集：开机时长、CPU、内存、磁盘、网络累计流量；阈值告警；进程管理与 Kill；Ping / Traceroute 网络诊断 |
| 网络转发 | 本地端口转发、远程端口转发、SOCKS5 动态转发，多会话独立管理 |
| 凭据保险箱 | 主密码（PBKDF2）加密凭据，明文仅驻留解锁会话内存，重启后必须重新解锁 |
| 命令片段 | 可持久化的命令片段库，支持 `{{参数}}` 模板与 shell 引用，活动会话快速下发 |
| 安全能力 | SSH 主机指纹首次确认 + known_hosts 持久化 + 指纹变化阻断；审计日志留痕；导出/备份自动剔除 `password` / `passphrase` |
| 界面定制 | 深色 / 浅色 / 自定义主题，玻璃拟态样式，背景图与终端外观参数可调 |

## 技术栈

- **前端**：React 19 + TypeScript + Vite + Zustand + xterm.js
- **桌面壳**：Tauri 2（Rust），插件：dialog / opener / store
- **SSH 核心**：`russh` 0.63 与 `russh-sftp`（Rust 实现，无 OpenSSH 依赖）

## 目录结构

```
├─ src/                    # React 前端
│  ├─ api/                 # Tauri command 调用与事件封装
│  ├─ components/          # 通用 UI 组件
│  ├─ store/               # Zustand 状态（主机、会话、设置、保险箱、审计…）
│  ├─ types/               # 共享类型与常量
│  └─ views/               # 页面与页面级组件（主机、会话、SFTP、监控、转发、设置）
├─ src-tauri/              # Rust 后端
│  ├─ src/ssh_manager.rs   # SSH 连接、认证、PTY、读写、重连、转发核心
│  ├─ src/lib.rs           # Tauri 应用状态、command 注册、事件转发
│  ├─ capabilities/        # 权限声明
│  └─ tests/               # Rust 集成测试（含 SSH echo-server 生命周期测试）
├─ open-dev.cmd            # Windows 一键启动开发服务器
└─ index.html
```

## 环境要求

- **操作系统**：Windows 10 / 11（需内置 WebView2 运行时，Win10 通常已预装）
- **Node.js**：18+（建议 20 LTS 或更高）
- **Rust**：stable 工具链（含 `cargo`，建议通过 [rustup](https://rustup.rs/) 安装）
- **MSVC 工具链**：Visual Studio 2022 生成工具（`cl.exe`），或安装 [Build Tools for Visual Studio](https://visualstudio.microsoft.com/zh-hans/downloads/#build-tools-for-visual-studio-2022) 时勾选「使用 C++ 的桌面开发」工作负载
- **cargo 路径**：确认 `cargo` 与 `rustc` 已在 `PATH` 中

> 快速自检：`node -v`、`rustc -V`、`cargo -V` 均能输出版本号即可。

## 安装与开发

### 1. 获取源码

```powershell
git clone https://github.com/smcloudcat/CatShell.git
cd CatShell
```

### 2. 安装前端依赖

```powershell
npm install
```

### 3. 启动开发模式

```powershell
npm run tauri dev
```

首次启动会编译 Rust 依赖，耗时约 5~10 分钟（后续增量编译很快）。编译完成后会自动打开 CatShell 桌面窗口。

> **Windows 快捷启动**：资源管理器中直接双击仓库根目录下的 `open-dev.cmd` 即可，脚本会自动切换到项目目录并保留错误输出。

### 4. 独立运行前端（可选）

仅启动 Vite 前端开发服务器（不含 Tauri API，部分功能不可用）：

```powershell
npm run dev
```

默认地址：http://localhost:1420

## 构建安装包

```powershell
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`：

- `msi/` — MSI 安装包（推荐用于企业分发）
- `nsis/` —— EXE 安装程序

安装包默认为 x64 架构，双击安装后即可从开始菜单启动 **CatShell**。

> 提示：`npm run tauri build` 会先执行 `vite build` 再编译 Rust 发布版，整个过程可能需要 10 分钟以上；如仅验证前端可改用 `npm run build`。

## 测试

```powershell
# 前端类型检查 + 构建
npm run build

# Rust 检查与测试（在 src-tauri 目录执行）
cargo check
cargo test
```

`cargo test` 会启动内存中的 echo SSH 服务器运行集成测试，验证连接、认证、PTY 事件与 known_hosts 指纹校验等核心链路。

## 数据与安全

- **凭据不入库**：连接密码与私钥口令只用于当前连接进程，不会写入主机配置、localStorage 或导出文件
- **凭据保险箱**：以 PBKDF2 派生密钥 + AES-GCM 加密存储；解锁后明文仅在内存中，锁定 / 退出即清除
- **主机指纹校验（TOFU）**：首次连接必须人工确认 SHA-256 指纹并写入 known_hosts；密钥一旦变化立即阻断连接
- **配置导出**：导入导出及备份文件均会剔除 `password` 与 `passphrase` 字段
- **审计留痕**：连接、传输、转发、导出等关键操作记录到本地审计日志，可检索与导出

## 许可证

[GPL-3.0](./LICENSE)

----

问题或建议请提交 [GitHub Issues](https://github.com/smcloudcat/CatShell/issues)。