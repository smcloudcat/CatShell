# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 修复

- **应用内更新 404**：发布工作流此前只把更新清单 `latest.json` 上传到 Release，安装包本体留在 Actions 产物里，导致清单中记录的下载地址全部 404。现在安装包与 `.sig` 签名一并上传，并新增校验步骤断言资产确实存在。
- **重连退避跳档**：自动重连的尝试次数重复自增，实际重试次数少于 `MAX_RECONNECT_ATTEMPTS` 设计值。现收敛到单一计入口径，重复自增在结构上已不可能。
- **SFTP 传输泄漏**：被放弃的传输会永久驻留内存。现按空闲时长回收，10 分钟无活动的传输自动释放，并在开始新传输时顺带清理。
- **终端事件风暴**：PTY 输出此前按每个数据块逐个派发事件，高吞吐命令会瞬间打出海量 IPC 消息。现按 16 ms / 64 KB 聚合后派发。
- **关闭会话无确认**：`Ctrl+W` 此前直接断开连接。现 `Ctrl+W` 只关闭标签并弹出确认，`Ctrl+Shift+W` 才断开并关闭。
- **终端全量挂载**：所有标签的终端实例常驻内存，标签越多占用越高（xterm 含 WebGL 与多个 addon）。现只挂载当前标签与分屏，切换时回放会话日志恢复回滚内容。
- **空表单常量被复用**：连接表单的"空表单"常量被 state 直接引用，存在被原地改写污染的风险，改为工厂函数返回新对象。
- **心跳间隔未夹范围**：`keepalive` 有两套归一化口径且都未夹到声明的 `[5, 300]`，现统一到 `types/session`。
- **残留 i18n 缺口**：审计面板的动作名、监控阈值指标名等文案缺少 `en` 条目，英文界面下会回退成中文。已补齐 43 条，并修掉监控告警与传输列表按钮的硬编码中文；零引用的 `STATUS_TEXT` 死代码一并删除。
- **业务错误提示未本地化**：store 与 `src/utils/` 直接抛中文 `Error`，英文界面下错误提示仍是中文。现改为抛携带错误码的 `AppError`（`src/types/errors.ts`），由 UI 层统一经 `errorText()` 按当前语言映射文案；`check-i18n.mjs` 已把错误码文案表纳入覆盖校验。终端字体选项与跳板机校验两处漏翻文案一并补齐。
- **样式表注释乱码**：`src/styles/*.css` 的中文注释曾被按 GBK 重写，出现「閫氱敤瑙嗗浘」式乱码，并夹带 BOM 与丢失的换行。已依历史版本逐行还原（9 个文件 / 31 行），并新增乱码校验防止复发。
- **错误边界文案未本地化**：`ErrorBoundary` 的兜底文案未走 `t()`，英文界面下仍显示中文，现改为 `t('界面发生错误')` / `t('重新加载')`。
- **会话时长不再刷新**：会话页的时长定时器依赖 `order` 与 `sessions` 两个每次刷新都换引用的对象，导致 30 秒定时器被反复重建、永远等不到触发，界面上的在线时长会一直停在初始值。现改为依赖稳定的布尔量，定时器只在「有无已连接会话」发生翻转时才重建。

### 安全

- **凭据内存清除**：`ConnectRequest` / `ProxyConfig` 不再派生 `Debug` 与 `Serialize`，并在析构时用 `zeroize` 覆写密码与私钥口令，避免经由日志或序列化外泄。
- **结构化日志**：引入 `tracing` 落盘日志（按日轮转、保留 7 份，可用 `CATSHELL_LOG` 调整级别）。日志只记录脱敏后的会话摘要，密码与口令一律不入日志。
- **依赖漏洞扫描**：CI 新增 RustSec 与 `npm audit --audit-level=high` 两路扫描。`rsa` 的 Marvin 攻击（RUSTSEC-2023-0071）因上游无修复版本，在 `src-tauri/.cargo/audit.toml` 中显式接受并记录理由。
- **移除死依赖**：删除实际未被引用的 `russh-keys`，其 `legacy-ed25519-pkcs8-parser` feature 本就应挂在 `russh` 上；这同时消除了 HIGH 级 `russh-cryptovec` 漏洞。

### 变更

- 新增公共 `Modal` 组件，统一焦点陷阱、`Esc` 关闭、关闭后焦点归还与嵌套弹窗栈，替代各视图散落的弹窗实现。
- `ConnectRequest` 的构建收敛为 `buildConnectRequest` 单一入口；主机导入的信任边界抽为独立模块。

### 性能

- **前端按视图分包**：首屏 JS 由 915 KB（gzip 256 KB）降至约 296 KB（gzip 96 KB），480 KB 的 xterm 仅在进入会话页时加载。Vite 8 底层为 Rolldown，分包使用 `build.rolldownOptions.output.codeSplitting`（`rollupOptions.manualChunks` 已不适用）。

### 工程

- 巨型视图组件拆分：`SessionSftpPanel`（795→557）、`ConnectDialog`（758→406）、`SessionsView`（548→383）、`HostsView`（604→352），统一为编排层 + 纯函数层 + 展示层。
- 前端测试由 63 例增至 158 例，新增连接请求构建、主机导入、SFTP 工具、会话视图、主机列表、连接表单、错误码映射、日志出口等纯函数覆盖。
- Rust 测试由 30 例增至 36 例：共享测试基建把内存 SSH 服务器扩展到 SFTP 子系统与 direct-tcpip 转发，新增 SFTP 全链路、本地转发、主机指纹变更拒绝等用例。
- 新增 `rustfmt.toml`、`clippy.toml`、`.editorconfig`，统一格式与行尾约束。
- 前端日志统一走 `src/utils/logger.ts`（`[CatShell]` 前缀，`debug` 仅开发构建输出），6 处散落的 `console.*` 全部收编；日志属诊断信息，不做国际化。
- 类型与 Lint 收紧：`tsconfig` 开启 `noUncheckedIndexedAccess` / `noImplicitOverride` / `exactOptionalPropertyTypes`（40 处类型修正），ESLint 启用 `recommendedTypeChecked` + `projectService`（17 处修正）；`npm run build` 改为 `tsc -b && vite build`，此前游离在类型检查外的 `vite.config.ts` 一并纳入。
- Cargo 依赖版本策略显式分层：Tauri 生态（`tauri` / `tauri-build` / `tauri-plugin-*`）统一声明主版本 `"2"`，底层行为依赖（`tokio` / `bytes` / `russh` / `russh-sftp`）精确到小版本，实际锁定仍由 `Cargo.lock` 兜底。
- 新增 i18n 覆盖率校验（`npm run i18n:check`）并接入 CI，新增文案漏补 `en` 条目时直接失败；另提供 `npm run i18n:audit`，用于审计常量表等间接引用的缺口。
- 新增乱码校验（`npm run mojibake:check`）并接入 CI：利用「UTF-8 字节被按 GBK 解读」这一过程的可逆性自动识别源码注释乱码，无需额外依赖。
- CI 的 clippy 改用 `--all-targets`，让 `tests/` 下的集成测试代码也纳入 Lint。
- 新增 `src-tauri/.cargo/config.toml` 关闭增量编译（`incremental = false`）：rustc 1.98.1 在本 crate 的 `staticlib + cdylib + rlib` 组合上会稳定触发 `rmeta` 编码 ICE（`no entry found for key`），表现为 `cargo run` / `cargo test` 随机崩溃。改用全量重编译换取构建稳定。

详细评估与优先级见 [`docs/PROJECT-REVIEW.md`](./docs/PROJECT-REVIEW.md)。

## [0.1.0]

首个公开版本。

### 新增

#### 终端会话

- 多标签 SSH 终端，PTY 尺寸同步与原生字节 IPC 实时输出（含事件回退通道）
- 终端分屏，支持同一布局内左右双会话对照
- 终端内搜索（Ctrl+F）、WebGL 渲染（Canvas 回退）、链接点击打开
- 键盘快捷键：Ctrl+1..9 切换标签、Ctrl+Tab 循环、Ctrl+W 关闭、Ctrl+T 新建
- 会话标签显示在线时长；多会话广播输入，键入实时同步到勾选会话
- 命令片段库，支持 `{{参数}}` 模板与 shell 引用，设置页管理与活动会话快速下发

#### 认证与安全

- 密码、SSH 私钥、SSH Agent（Pageant / OpenSSH 命名管道 / `SSH_AUTH_SOCK`）认证
- 交互式 keyboard-interactive 认证，含 2FA 弹窗应答与预填 OTP 自动应答
- 跳板机 ProxyJump，direct-tcpip 隧道串联，跳板机与目标指纹分别确认
- SSH 主机指纹首次确认（TOFU）、known_hosts 持久化、指纹变化阻断与已信任指纹管理页
- known_hosts 存储策略可选：OpenSSH 兼容路径或应用数据目录独立存储
- 主密码保护的加密凭据保险箱（PBKDF2 + AES-GCM），闲置与失焦自动锁定
- 操作审计日志，关键操作留痕，支持检索与导出

#### 传输与网络

- SFTP 目录浏览（排序 / 筛选 / 隐藏文件开关）、上传（含拖拽）、下载、删除、新建目录、重命名、跨目录移动
- chmod 权限修改，权限与属主 tooltip 提示
- 超过 16 MB 的文件走 256 KB 分块流式传输，支持进度与取消
- 磁盘级流式下载 / 上传，`.catshell-part` 半成品支持断点续传，进度节流事件与进行中传输查询
- 远程文本文件在线编辑
- 本地端口转发、远程端口转发、SOCKS5 动态转发，按会话独立管理

#### 监控与诊断

- 基于 SSH exec 的免插件服务器监控：主机信息、CPU、内存、多分区磁盘、网络速率与历史趋势
- 阈值告警配置
- 进程列表与 Kill（TERM / KILL）
- Ping / Traceroute 网络诊断
- RTT 探测（`ssh_ping` 通过 exec `:` 计时）

#### 平台与体验

- 深色 / 浅色 / 自定义主题，玻璃拟态样式，背景图与终端外观参数可调
- 主机分组折叠、标签筛选、内置图标选择、`~/.ssh/config` 预览导入
- 主机配置导入（JSON 预览确认）与导出，配置一键备份还原
- 系统托盘，活动会话数 >0 时绿色标记；关闭窗口最小化到托盘（可关闭）
- 单实例防多开、窗口状态还原
- 应用内更新（检查 / 下载 / 安装与重启）
- i18n 框架（zh-CN / en-US）与语言切换、lastView 启动恢复
- 会话心跳保活与断线自动重连（指数退避）

### 工程

- ESLint + vitest 前端测试（snippet / theme / vaultCrypto）
- Rust SSH 生命周期集成测试（内存 echo SSH 服务器）
- GitHub Actions CI：前端 lint / test / build 与后端 fmt / clippy / check / test
- tag 触发的发布工作流，注入签名 secrets 并生成更新清单

[Unreleased]: https://github.com/smcloudcat/CatShell/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/smcloudcat/CatShell/releases/tag/v0.1.0
