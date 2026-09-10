# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 计划中

- 修复发布流程未上传安装包本体导致应用内更新 404 的问题
- 修复自动重连预算的重复自增，使退避档位与重试次数符合 `MAX_RECONNECT_ATTEMPTS` 设计
- 补齐 `en` 字典中 `nav.*` 与 `status.*` 缺口
- 打包体积优化：前端产物拆分 chunk，避免单文件接近 900 KB
- 关闭会话、取消传输等破坏性操作增加二次确认

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
