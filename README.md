# CatShell 🐾

> 服务器远程运维桌面工具 · SSH 终端 / SFTP 传输 / 服务器监控

CatShell 是一款面向 Windows 的桌面 SSH 运维工具，基于 **Tauri 2 + React 19 + Rust** 构建。它把日常服务器运维最常用的能力集成到一个低调、安全的桌面应用里：

- 多标签 SSH2 终端，支持密码 / SSH 私钥 / SSH Agent / 交互式 2FA 认证与跳板机 ProxyJump
- 会话心跳保活、断线自动重连、PTY 尺寸实时同步、终端分屏
- SFTP 目录浏览与文件上传 / 下载 / 在线编辑，大文件分块流式与磁盘级断点续传
- 基于 SSH exec 的轻量服务器监控（CPU / 内存 / 磁盘 / 网络 / 进程 / 网络诊断）
- 本地 / 远程 / 动态(SOCKS5) 端口转发
- 主密码保护的加密凭据保险箱
- 命令片段库与参数化命令模板
- 操作审计日志、配置导入导出与一键备份还原
- 系统托盘（活动会话角标、关闭最小化到托盘）、应用内更新与 i18n（zh/en）

## 功能特性

| 模块 | 说明 |
| --- | --- |
| SSH 终端 | 多标签页会话、密码 / RSA / ED25519 / ECDSA 私钥 / SSH Agent / 交互式 2FA 认证、跳板机 ProxyJump、分屏对照、PTY 尺寸同步、实时输出、心跳保活、断线自动重连（指数退避） |
| 主机管理 | 主机配置保存、搜索、编辑、删除、导入导出、快速连接、分组折叠与标签筛选、内置图标选择、`~/.ssh/config` 预览导入 |
| SFTP | 目录浏览（排序/筛选/隐藏文件）、上传（含拖拽）/ 下载 / 删除、新建目录、重命名、跨目录移动、chmod 权限修改；超 16 MB 走 256 KB 分块流式（进度/取消），磁盘级流式传输支持断点续传；远程文本文件在线编辑 |
| 服务器监控 | 基于固定只读命令的免插件采集：开机时长、CPU、内存、磁盘、网络累计流量；阈值告警；进程管理与 Kill；Ping / Traceroute 网络诊断 |
| 网络转发 | 本地端口转发、远程端口转发、SOCKS5 动态转发，多会话独立管理 |
| 凭据保险箱 | 主密码（PBKDF2）加密凭据，明文仅驻留解锁会话内存，重启后必须重新解锁 |
| 命令片段 | 可持久化的命令片段库，支持 `{{参数}}` 模板与 shell 引用，活动会话快速下发 |
| 安全能力 | SSH 主机指纹首次确认 + known_hosts 持久化 + 指纹变化阻断；审计日志留痕；导出/备份自动剔除 `password` / `passphrase` |
| 界面定制 | 深色 / 浅色 / 自定义主题，玻璃拟态样式，背景图与终端外观参数可调 |

## 技术栈

- **前端**：React 19 + TypeScript + Vite 8 + Zustand 5 + xterm.js 6（fit / search / web-links / webgl）
- **桌面壳**：Tauri 2（Rust），插件共 8 个：dialog / opener / store / notification / process / updater（跨平台）+ single-instance / window-state（桌面专用）
- **SSH 核心**：`russh` 0.63 与 `russh-sftp` 2.4（Rust 实现，无 OpenSSH 依赖）

## 目录结构

```
├─ src/                       # React 前端
│  ├─ api/                    # Tauri command 调用与事件封装
│  ├─ components/             # 通用 UI 组件（Icon / Feedback / Modal / ErrorBoundary）
│  ├─ i18n/                   # 轻量 i18n（zh-CN 键名来源 + en-US 渐进补齐）
│  ├─ store/                  # Zustand 状态（主机、会话、设置、保险箱、片段、审计、UI）
│  ├─ styles/                 # 按视图拆分的样式（base / glass / sessions / sftp / …）
│  ├─ types/                  # 共享类型与常量
│  ├─ utils/                  # 纯函数工具（格式化、通知、保险箱加解密、主机导入与列表）
│  ├─ views/                  # 页面与页面级组件；子目录 hosts/ sessions/ settings/ 存放各自的对话框与面板
│  └─ __tests__/              # vitest 单元测试（连接请求、主机导入、SFTP 工具、会话视图等 9 个文件）
├─ src-tauri/                 # Rust 后端
│  ├─ src/ssh_manager/        # SSH 核心目录模块
│  │  ├─ mod.rs               # 会话生命周期、认证、重连、指纹确认、ProxyJump
│  │  ├─ types.rs             # DTO 与常量
│  │  ├─ config.rs            # known_hosts 与 ~/.ssh/config
│  │  ├─ monitor.rs           # 监控 / 进程 / 网络诊断 / RTT
│  │  ├─ sftp.rs              # SFTP、分块流式与磁盘级断点续传
│  │  └─ forward.rs           # 端口转发与 SOCKS5
│  ├─ src/logging.rs          # tracing 落盘日志（按日轮转）
│  ├─ src/lib.rs              # Tauri 应用状态、command 注册、事件转发、插件注册
│  ├─ build.rs                # Tauri 构建脚本
│  ├─ capabilities/           # 权限声明
│  ├─ .cargo/audit.toml       # cargo audit 的已知接受项与理由
│  └─ tests/                  # Rust 集成测试（common/ 基建 + ssh / sftp / forward 三个 e2e）
├─ docs/                      # 项目审查报告与优先级路线图
├─ scripts/                   # 仓库脚本（i18n 覆盖率校验与审计）
├─ .github/workflows/         # CI（lint / test / i18n / build / clippy / audit）与 tag 发布工作流
├─ open-dev.cmd               # Windows 一键启动开发服务器
├─ open-dev.ps1               # PowerShell 启动入口
└─ index.html
```

## 环境要求

- **操作系统**：Windows 10 / 11（需内置 WebView2 运行时，Win10 通常已预装）
- **Node.js**：20+（建议 22；CI 与发布流程均使用 Node 22）
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
- `*.sig` — 对应的更新签名文件（仅当配置了签名密钥时生成）

安装包默认为 x64 架构，双击安装后即可从开始菜单启动 **CatShell**。

> 提示：`npm run tauri build` 会先执行 `vite build` 再编译 Rust 发布版，整个过程可能需要 10 分钟以上；如仅验证前端可改用 `npm run build`。

### 应用内更新与签名配置

`src-tauri/tauri.conf.json` 已开启 `bundle.createUpdaterArtifacts`，因此**发布构建必须配置签名密钥**，否则无法生成 `.sig`，应用内的更新检查会失效：

```powershell
# 生成一对签名密钥（公钥内容填入 tauri.conf.json 的 plugins.updater.pubkey）
npm run tauri signer generate -- -w "$HOME\.tauri\catshell.key"

# 发布构建前设置环境变量（CI 中通过 repository secrets 注入）
$env:TAURI_SIGNING_PRIVATE_KEY = "<私钥内容或私钥文件内容>"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<私钥口令，未设置口令时可为空>"
npm run tauri build
```

仓库中 `tauri.conf.json` 的 `pubkey` 目前是占位符 `REPLACE_WITH_TAURI_SIGNING_PUBLIC_KEY`，正式发布前必须替换为真实公钥，并在仓库 secrets 中配置 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（参见 `.github/workflows/release.yml`）。

更新端点指向 GitHub Releases 的 `latest.json`。发布时**必须把安装包本体的 URL 加入 Release 资产**，因为 `latest.json` 中记录的下载地址就是这些资产地址；只上传 `latest.json` 会导致所有客户端更新时返回 404。

## 测试

```powershell
# 前端：类型检查、Lint、i18n 校验、单元测试与构建
npx tsc --noEmit
npm run lint
npm run i18n:check
npm test
npm run build

# Rust：格式、Lint 与测试（在 src-tauri 目录执行）
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

前端的 `npm test` 覆盖纯函数层：连接请求构建、主机导入的信任边界、SFTP 目录与传输工具、会话视图与主机列表等。

`npm run i18n:check` 校验代码中的文案键是否都有 `en` 条目（CI 同步骤），`npm run i18n:audit` 用于复查常量表等间接引用的缺口。

Rust 集成测试基于 `src-tauri/tests/common/` 的内存 SSH 服务器，覆盖连接与认证、PTY 事件、known_hosts 指纹校验与**指纹变更拒绝**、SFTP 全链路（增删改查与跨会话状态保持）以及 direct-tcpip 本地转发。

## 数据与安全

- **凭据不入库**：连接密码与私钥口令只用于当前连接进程，不会写入主机配置、localStorage 或导出文件
- **凭据内存清除**：凭据对象析构时用 `zeroize` 覆写，且不派生 `Debug` / `Serialize`，避免经由日志或序列化外泄
- **凭据保险箱**：以 PBKDF2 派生密钥 + AES-GCM 加密存储；解锁后明文仅在内存中，锁定 / 退出即清除
- **主机指纹校验（TOFU）**：首次连接必须人工确认 SHA-256 指纹并写入 known_hosts；密钥一旦变化立即阻断连接
- **配置导出**：导入导出及备份文件均会剔除 `password` 与 `passphrase` 字段
- **日志脱敏**：运行日志只记录脱敏后的会话摘要，不写入密码与口令
- **审计留痕**：连接、传输、转发、导出等关键操作记录到本地审计日志，可检索与导出
- **依赖审计**：CI 对前端与 Rust 依赖分别执行漏洞扫描；已知接受项在 `src-tauri/.cargo/audit.toml` 中记录理由

## 许可证

[GPL-3.0](./LICENSE)

----

问题或建议请提交 [GitHub Issues](https://github.com/smcloudcat/CatShell/issues)。