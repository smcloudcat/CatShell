# 贡献指南

感谢你对 CatShell 感兴趣。本文档说明本地开发、验证与提交的约定。

参与开发前建议先读 [`AGENTS.md`](./AGENTS.md)——它记录了模块边界、实现约定和安全红线，也请留意 [`SECURITY.md`](./SECURITY.md) 中不可放宽的安全约束。

## 环境准备

- **操作系统**：Windows 10 / 11
- **Node.js**：20+（建议 22，与 CI 一致）
- **Rust**：stable 工具链（含 `cargo`、`rustfmt`、`clippy`）
- **MSVC 工具链**：Visual Studio 2022 生成工具，勾选「使用 C++ 的桌面开发」工作负载

```powershell
git clone https://github.com/smcloudcat/CatShell.git
cd CatShell
npm install
npm run tauri dev
```

首次编译 Rust 依赖约需 5~10 分钟。也可直接双击 `open-dev.cmd`，脚本会自动切换目录并保留错误输出。

## 开发流程

1. 从 `main` 切出功能分支，命名建议 `feat/<简短描述>` 或 `fix/<简短描述>`。
2. 修改前先阅读相关文件与现有实现，保持改动范围聚焦，不做无关重构。
3. 完成功能或修复后，按下方清单自测。
4. 提交前检查 `git diff`，确认没有混入构建产物、日志或凭据。
5. 提 PR 并在描述中说明：改了什么、为什么改、如何验证。

## 验证清单

前端与后端都改动时，按顺序执行：

```powershell
# 仓库根目录
npx tsc --noEmit
npm run lint
npm run i18n:check
npm test
npm run build

# src-tauri 目录
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`--all-targets` 会把集成测试代码一并纳入 Lint，请保留该参数——只写 `cargo clippy -- -D warnings` 时 `tests/` 下的代码不在检查范围内。

`npm run i18n:check` 校验代码里的每个 `t('…')` 键都有对应的 `en` 条目，CI 会执行同一步。若新增了文案却忘了补 `en`，这一步会直接失败并列出缺失的键。常量表等**间接引用**的键不在其覆盖范围内，可用 `npm run i18n:audit` 人工复查。

涉及 `invoke`、文件选择器、Tauri Store、插件或 Rust command 的改动，**必须**用 `npm run tauri dev` 或 `open-dev.cmd` 在真实 Tauri 窗口内验证；`npm run dev` 只跑 Vite，无法验证任何 Tauri API。

改动终端、SFTP、转发、指纹校验等核心链路时，请同时参考 `AGENTS.md` 的「手动验证」章节执行对应场景。

## 代码约定

### 前端

- 使用 React 函数组件与 Zustand store 的现有模式。
- 展示与交互编排放在视图层，跨页面状态放 `src/store/`，Tauri 调用集中放 `src/api/`。
- 共享类型放 `src/types/`，不要在多处重复声明同一协议。
- 复用 `Icon` 组件与 CSS 变量，不要手写重复 SVG。
- 异步操作必须有失败处理，并向用户给出可理解的提示。
- 新增文案走 `t('中文原文')`，并补齐 `src/i18n/index.ts` 的 `en` 条目，不要把中文硬编码进 JSX。

### 后端

- SSH 核心逻辑放进 `src-tauri/src/ssh_manager/` 下对应的子模块，新增能力不要回退成单文件。
- 修改 command 的参数、返回值或事件名时，同步更新 `src/api/ssh.ts`、前端类型与相关测试。
- 事件订阅与 xterm 订阅必须保存并在卸载时 `dispose`；Strict Mode 下初始化逻辑必须幂等。
- 锁的使用注意运行时上下文，不要随意把 `std::sync::Mutex` 换成可能造成阻塞或死锁的实现。

### 文档

- 改动对外行为时同步更新 `README.md`；影响模块边界或开发约定的改动同步更新 `AGENTS.md`。
- 用户可见的变更记入 `CHANGELOG.md` 的 `Unreleased` 段落。
- 触碰安全边界的改动（凭据处理、指纹校验、日志内容、转发绑定、依赖审计接受项）同步更新 `SECURITY.md`。

## 提交信息

推荐使用 `type: 简述` 形式，type 取 `feat` / `fix` / `refactor` / `perf` / `docs` / `test` / `chore`。

示例：

```
feat: add SFTP remote file inline editing
fix: correct reconnect attempt increment to avoid skipping backoff steps
docs: align README plugin list with actual registrations
```

## 安全红线

以下改动不会被接受，详见 [`SECURITY.md`](./SECURITY.md)：

- 把密码、私钥口令或凭据写入 Store、localStorage、日志、导出文件或测试
- 让承载凭据的请求对象重新派生 `Debug` / `Serialize`，或移除其析构时的内存清除
- 在日志中写入未脱敏的密码、口令或私钥内容
- 放宽或移除主机指纹校验，为指纹变化提供绕过路径
- 把端口转发绑定到 `0.0.0.0` 等非回环地址
- 把未经校验的用户输入拼接进远程 shell 命令
- 无理由地放宽依赖漏洞扫描的接受项
- 为调试方便放宽 Tauri capability

## 行为准则

- 讨论聚焦技术与事实，就事论事。
- 不提交他人的私有信息、真实服务器地址或凭据。
- 评审意见默认视为对代码的意见，而非对人的评价。
