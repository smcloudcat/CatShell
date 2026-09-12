# CatShell 深度代码审计报告

- 审计日期：2026-09-12
- 审计基线：`b5bb7f941a214f7caac8fe58ab823567537d682a`
- 审计对象：CatShell 当前 `main` 分支（Tauri 2 + React 19 + TypeScript 6 + Rust + russh）
- 审计性质：在上一轮 56 项整改全部闭环后的独立复审；本报告不复述已修复事项
- 总体结论：**高风险**。当前未发现可直接远程利用的代码执行、认证绕过或明文凭据泄露，但确认存在 2 项可导致恢复记录或正式文件丢失的高风险数据完整性问题，以及 8 项中低风险问题。
- **修复状态（2026-09-12 晚）**：正文 10 项正式发现（H-1/H-2/M-1~M-6/L-1/L-2）已全部修复并通过全量验证（Rust 115 + 前端 294 测试、fmt/clippy/tsc/eslint/build/i18n/mojibake 全绿），改动未提交。

## 1. 执行摘要

本轮共确认 **10 项当前源码仍然成立的问题**：

| 等级 | 数量 | 编号 |
|---|---:|---|
| 高 | 2 | H-1、H-2 |
| 中 | 6 | M-1 ～ M-6 |
| 低 | 2 | L-1、L-2 |
| 合计 | 10 | — |

最先应处理的三条链路：

1. **传输恢复队列启动清理**：主机数组被错误地按数组索引构造 ID 集合，重启后会删除全部合法续传记录。
2. **SFTP / 同步覆盖提交**：目标覆盖采用“先删旧目标，再重命名新文件”，第二次重命名失败时正式目标消失。
3. **Windows SSH 信任库路径**：应用管理的是 `~/ssh/known_hosts`，russh 实际校验的是 `~/.ssh/known_hosts`，主机信任管理与连接校验不在同一安全边界。

审计同时确认了一批有效控制：生产 CSP 已收紧、asset protocol 默认空作用域、CI action 固定到提交 SHA、依赖安装禁用生命周期脚本、发布流程强制签名并验证上传资产、SSH 密钥路径删除有目录边界、断点续传包含内容采样指纹、Rust 共享状态使用 Tokio 锁、xterm/WebGL/监听器的正常卸载路径完整。

## 2. 审计范围与方法

### 2.1 覆盖范围

- Rust SSH 会话、认证、Host Key、ProxyJump、多跳、重连、端口转发、批量执行与监控
- SFTP 普通传输、分片传输、磁盘传输、断点续传、目录同步、取消和临时文件提交
- known_hosts、SSH config、密钥生成与删除、录制文件持久化
- Tauri IPC 参数边界、事件协议、capabilities、CSP、asset protocol 与 updater
- React 顶层生命周期、会话视图、xterm/WebGL 资源管理
- Zustand 主机、设置、凭据保险箱、传输队列、会话恢复和命令片段持久化
- GitHub Actions CI / Release、npm 与 Cargo 依赖供应链
- 现有单元测试、集成测试、类型检查、Lint、国际化和乱码检查

### 2.2 判定标准

正式发现必须同时满足：

- 当前基线源码中存在完整触发链；
- 能说明具体失败条件和用户可观察影响；
- 不是上一轮已修复问题的重复描述；
- 不是仅依赖假设的理论可能性。

无法稳定证明的线索放入“待验证项”，依赖公告和发布前置条件单独记录，不计入 10 项源码缺陷。

## 3. 高风险发现

### H-1 [已修复] 传输恢复队列会在启动时误删全部合法记录

- 类型：功能正确性 / 数据持久化
- 位置：`src/store/transferQueue.ts:69-78`
- 严重度：高

**证据**

`useHosts.getState().hosts` 的类型是 `HostProfile[]`，但初始化代码使用：

```ts
const knownHostIds = new Set(Object.keys(useHosts.getState().hosts))
entries = pruneMissingHosts(entries, knownHostIds)
```

`Object.keys(array)` 返回的是 `"0"`、`"1"` 等数组索引，并非 `host.id`。`pruneMissingHosts()` 会按 `item.hostId` 查询集合，因此正常 UUID / 业务 ID 均不匹配。清理结果随后通过 `persistNow(entries)` 写回磁盘。

**触发条件**

1. 至少有一条未完成、可恢复的磁盘传输记录；
2. 应用重启并执行传输队列初始化；
3. 主机 ID 不是恰好等于数组索引字符串。

**影响**

- 所有合法续传项被当作“主机已删除”而移除；
- 空结果覆盖原持久化记录，恢复信息永久丢失；
- 大文件只能重新传输，断点续传功能在典型主机 ID 下实际失效。

**修复建议**

```ts
const knownHostIds = new Set(useHosts.getState().hosts.map((host) => host.id))
```

同时增加 Store 初始化集成测试，使用真实 `HostProfile[]` 与已保存队列记录启动；现有 `src/__tests__/transferQueue.test.ts:119-132` 只验证纯函数，无法覆盖调用方传错集合的问题。

### H-2 [已修复] SFTP 与目录同步覆盖提交可能删除正式目标

- 类型：数据完整性 / 文件覆盖
- 位置：
  - `src-tauri/src/ssh_manager/sftp.rs:844-851`
  - `src-tauri/src/ssh_manager/sftp.rs:1256-1264`
  - `src-tauri/src/ssh_manager/sync.rs:735-742`
  - `src-tauri/src/ssh_manager/sync.rs:800-805`
- 严重度：高

**证据**

多个传输完成路径都采用相同模式：先尝试把完整半成品重命名为正式目标；失败后删除旧目标，再重试重命名。普通 SFTP 上传和同步还会在第二次重命名失败后删除半成品：

```rust
if sftp.rename(&part_path, remote).await.is_err() {
    let _ = sftp.remove_file(remote).await;
    if let Err(error) = sftp.rename(&part_path, remote).await {
        let _ = sftp.remove_file(&part_path).await;
        return Err(...);
    }
}
```

“半成品内容完整”只能证明新数据可用于替换，不能保证第二次 `rename` 一定成功。权限变化、目标目录状态变化、网络中断、服务端瞬时错误或跨文件系统限制均可能使第二次操作失败。

**触发条件**

1. 正式目标已存在；
2. 服务端或本地文件系统不允许直接覆盖式 rename；
3. 删除旧目标后，第二次 rename 失败。

**影响**

- 旧正式文件已经删除；
- 部分路径又删除了完整半成品；
- 用户看到“保存失败”时，原文件可能已消失，形成不可恢复的数据丢失窗口。

**修复建议**

- 本地文件使用同目录唯一备份名：`target -> backup`，再 `part -> target`；失败时回滚 `backup -> target`；成功后删除备份。
- 远端优先探测并使用服务端支持的原子覆盖 / posix-rename 扩展。
- 不支持原子覆盖时使用唯一备份名执行两阶段提交，失败后明确尝试回滚；任何情况下都不要在新目标未就位前销毁唯一完整副本。
- 抽出共享提交函数，统一普通上传、分片上传、磁盘上传和同步上传/下载的语义。
- 增加失败注入测试，覆盖首次 rename 失败、删除成功、第二次 rename 失败的组合。

## 4. 中风险发现

### M-1 [已修复] Windows 默认 known_hosts 路径与实际连接校验不一致

- 类型：安全边界 / 跨平台正确性
- 位置：
  - `src-tauri/src/ssh_manager/config.rs:7-21`
  - `src-tauri/src/ssh_manager/keys.rs:14-20`
  - russh 0.63.2 `src/keys/known_hosts.rs:51-54`
- 严重度：中

**证据**

应用在 Windows 上把默认路径定义为 `~/ssh/known_hosts`，并从该路径推导密钥浏览与删除目录；同一项目的 SSH config 却使用 `~/.ssh/config`。russh 0.63.2 的默认实现没有 Windows 特判，始终使用 `~/.ssh/known_hosts`。

当连接请求未显式传入 known_hosts 路径时，连接校验调用 russh 默认路径；设置页的列举、删除和密钥管理则操作应用计算出的 Windows 路径。

**影响**

- UI 显示、删除或学习的信任记录可能不是实际连接校验所用记录；
- 用户以为已删除旧指纹，连接仍可能继续信任另一文件中的记录；
- 用户确认的新指纹可能写入一处，而后续连接从另一处读取，造成重复提示或错误信任判断；
- Windows 密钥管理可能浏览错误目录。

**修复建议**

统一使用 `~/.ssh/known_hosts` 和 `~/.ssh`，或保证所有连接、管理和学习路径都显式使用同一个解析结果。增加 Windows 条件测试，并测试“连接校验路径 = 设置页管理路径 = 密钥目录父路径”。

### M-2 [已修复] Host Key 确认提示使用单槽状态，并发请求会互相覆盖

- 类型：并发状态 / 认证交互
- 位置：
  - `src/store/sessions.ts:46-49, 183-185, 215-218, 267-274, 294-299`
  - `src-tauri/src/ssh_manager/mod.rs:183-188, 353-376`
- 严重度：中

**证据**

Rust 后端已为每个并发请求构造包含 `session_id` 的唯一 token，并分别持有 oneshot sender；前端却只保存一个 `hostKeyPrompt: HostKeyPrompt | null`，新事件直接覆盖旧事件。清理逻辑又只按 `host + port` 判断，payload 没有单独暴露 `sessionId`。

KBI 已使用数组队列，说明并发弹窗队列是现有架构可支持的模式。

**触发条件**

两个未知主机，或同一未知主机的两个会话，在前一个提示尚未应答时同时进入 Host Key 确认。

**影响**

- 先到请求从 UI 消失，用户无法应答；
- 后端请求等待至 120 秒超时，连接失败；
- 同目标会话关闭时可能清掉另一个仍有效的提示。

**修复建议**

改为 FIFO 队列或按 token 建表；Host Key payload 显式携带 `sessionId`，状态清理按会话或 token 精确执行。增加双会话并发事件测试与乱序关闭测试。

### M-3 [已修复] 目录同步取消无法中断正在传输的大文件

- 类型：取消语义 / 性能与体验
- 位置：`src-tauri/src/ssh_manager/sync.rs:604-637, 666, 686-805`
- 严重度：中

**证据**

取消标记只在每个同步条目开始前检查。`stream_upload()` 与 `stream_download()` 未接收取消标记，也未在分块读写循环中检查。单个文件开始后，取消只能等该文件完成或当前 I/O 超时。

**影响**

- 大文件可能在用户点击取消后继续占用网络、磁盘和 SSH 通道较长时间；
- 进度 UI 的取消状态与实际后台活动不一致；
- 弱网下最长还受单次 chunk 60 秒超时限制。

**修复建议**

把 `Arc<AtomicBool>` 或 cancellation token 传入流式函数，在每次 chunk 前后检查；取消时关闭远端文件句柄并保留或按策略清理半成品。增加阻塞读写下的取消延迟测试。

### M-4 [已修复] SSH 私钥与公钥不是成对原子提交

- 类型：密钥管理 / 文件一致性
- 位置：`src-tauri/src/ssh_manager/keys.rs:102-145`
- 严重度：中

**证据**

生成流程先把私钥直接写入正式路径，再写 `.pub`。第二次写入失败时没有回滚；覆盖模式下还可能形成“新私钥 + 旧公钥”的不匹配组合。Unix 的 `0600` 权限设置失败也被忽略。

**影响**

- 新建密钥时留下未被 UI 成功确认的孤立私钥；
- 覆盖密钥时私钥与公钥可能不匹配，后续部署错误公钥；
- 权限收紧失败时仍返回成功，Unix 私钥权限可能宽于预期。

**修复建议**

分别写入同目录唯一临时文件，先完成私钥权限设置和两份内容校验，再通过带备份的两阶段提交替换正式文件；任一步失败都回滚原文件。权限设置失败应作为生成失败返回。增加公钥写失败、权限设置失败和覆盖回滚测试。

### M-5 [已修复] 凭据保险箱最终写盘失败仍被当作成功

- 类型：凭据持久化 / 错误传播
- 位置：
  - `src/store/vault.ts:91-99, 196-204, 253-260, 281-290`
  - `src/utils/localFallback.ts:13-18`
- 严重度：中

**证据**

`writeRecord()` 在 plugin-store 失败后调用 `writeLocalFallback()`；后者在 localStorage 也失败时只记录 warning，不抛出错误。调用方随后更新模块级 `vaultRecord`、Zustand 内存状态并记录成功审计。

**触发条件**

plugin-store 写入失败，且 localStorage 因配额、权限、损坏或 WebView 存储异常同时失败。

**影响**

- UI 和审计记录显示凭据已保存、删除或主密码已变更；
- 实际持久化内容仍是旧版本；
- 重启后新凭据消失、已删除凭据重新出现，或新主密码无法解锁旧记录。

**修复建议**

为关键存储提供严格写接口，fallback 失败必须抛错；只有确认至少一处持久化成功后才能更新内存并记录 success。通用设置可以保留 best-effort 策略，但凭据保险箱不能共用吞错语义。增加双存储失败注入测试。

### M-6 [已修复] 多个 Zustand Store 的异步持久化缺少顺序保证

- 类型：并发一致性 / 状态持久化
- 位置：
  - `src/store/hosts.ts:33-41, 81-117`
  - `src/store/snippets.ts:21-28, 70-92`
  - `src/store/sessionRestore.ts:70-75, 125-127, 156-162`
  - `src/store/transferQueue.ts:78-98, 163-176`
- 对照实现：`src/store/settings.ts:35-55`
- 严重度：中

**证据**

这些 Store 先更新内存，再并行启动对同一存储文件的 `load -> set -> save`。快速连续操作或多个入口并发时，较早快照可能较晚完成并覆盖较新快照。`sessionRestore` 与传输队列还存在 fire-and-forget 写入。

`settings.ts` 已通过模块级 Promise 链保证调用顺序，证明项目已有可复用的正确模式。

**影响**

- 快速新增/编辑/删除主机或命令片段后，重启可能恢复旧快照；
- 会话标签恢复列表可能回退；
- 传输进度、完成或丢弃状态可能被旧写覆盖；
- hosts/snippets 的 fallback 最终失败同样不会传递给调用方。

**修复建议**

按存储文件建立串行写链，写入时使用不可变快照；高频进度保留节流，但 flush 必须进入同一链。应用退出前等待关键写链完成。增加可控延迟测试，强制第一次写晚于第二次完成并验证最终磁盘内容仍为最新状态。

## 5. 低风险发现

### L-1 [已修复] SSH 事件订阅部分成功后失败，不会回滚已注册监听器

- 类型：资源生命周期 / 初始化恢复
- 位置：`src/api/ssh.ts:506-556`、`src/store/sessions.ts:199-222`
- 严重度：低

**证据与影响**

`subscribeSshEvents()` 依次 await 多个 `listen()`，只有全部成功后才返回统一清理函数。如果中途某次监听失败，之前成功注册的监听器没有回滚。调用方捕获错误后仍结束初始化；后续重试可能形成重复监听，或应用停留在部分事件可用状态。

**修复建议**

用 `try/catch` 包住注册过程，失败时逆序执行已收集的 unlistener 后再抛出；初始化失败不要永久标记 ready，应允许显式重试。增加第 N 个 listen 失败的参数化测试。

### L-2 [已修复] 锁定态凭据删除排队失败仍返回 `queued`

- 类型：错误报告 / 凭据生命周期
- 位置：`src/store/vault.ts:120-136, 269-279`
- 严重度：低

**证据与影响**

`writePendingRemovals()` 吞掉 localStorage 异常且无返回值，`enqueuePendingRemoval()` 无法判断是否写入成功；调用方仍记录 success 并返回 `queued`。主机随后已删除时，凭据可能永久留在保险箱中且 UI 认为已安排清理。

**修复建议**

让待办写入返回结果或抛错；只有成功持久化后才能返回 `queued`。失败时阻止主机删除或向用户明确报告凭据未排队，并提供解锁后立即删除的恢复入口。

## 6. 已接受的依赖风险

### RUSTSEC-2023-0071：RSA Marvin Attack

- 依赖：`rsa 0.10.0-rc.18`
- 引入链：`russh 0.63 -> ssh-key 0.7.0-rc -> rsa`
- CVSS：5.9
- 状态：上游无修复版本；项目在 `src-tauri/.cargo/audit.toml` 中显式接受并说明触发条件
- 本轮处理：**不计入新发现**，继续跟踪上游。一旦存在修复版本，应升级依赖并移除 ignore。

## 7. 发布前置条件

### updater 公钥仍为占位符

`src-tauri/tauri.conf.json:47` 仍为：

```json
"pubkey": "REPLACE_WITH_TAURI_SIGNING_PUBLIC_KEY"
```

Release workflow 已在构建前强制检查并拒绝占位符，因此它不是当前可利用漏洞，也不会静默产出未签名更新。但任何正式 tag 发布前都必须提交真实公钥，并配置 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets。

## 8. 待验证项

以下线索尚不足以列为正式缺陷，建议在修复 10 项正式问题后专项验证：

1. **Release tag 与配置版本缺少一致性检查**：workflow 由 `v*` tag 触发，但 `latest.json.version` 取自 `tauri.conf.json`；错误打 tag 可能造成 Release 名称与 updater 版本不一致。建议增加 `vX.Y.Z == config.version` 前置校验。
2. **背景图片 asset 授权存在时序窗口**：`src/App.tsx:478-479` 未等待 `allowAssetFile()` 成功就设置 URL。需在冷启动和慢磁盘环境观察是否稳定出现首次加载失败。
3. **固定临时文件名的并发冲突**：SSH config 的 `.catshell-tmp` 和录制保存的同名临时文件理论上会在同目标并发写时竞争；正常 UI 是否允许同目标并发尚未证实。
4. **同步进度信任 IPC 回传 size**：完成字节数使用 `entry.size` 而非流函数真实返回值，恶意或陈旧计划可使进度失真；当前不会改变实际传输内容，暂不定为安全缺陷。

## 9. 已验证的安全与健壮性控制

- Tauri 生产 CSP：`default-src 'self'`、`script-src 'self'`、`object-src 'none'`，未允许任意远程脚本。
- asset protocol 默认 `scope: []`，背景文件按路径动态授权。
- capability 未开放 shell 执行；updater 与 process restart 权限范围清晰。
- CI / Release action 均固定到完整 commit SHA。
- `npm ci --ignore-scripts` 阻断依赖生命周期脚本。
- Release 构建前检查签名私钥和 updater 公钥，上传后回读资产并验证 `latest.json` 指向的安装包存在。
- 断点续传指纹包含文件长度、mtime、首尾各 64 KiB 内容采样哈希。
- SFTP 磁盘下载已有本地备份回滚路径；本报告 H-2 指向的是尚未统一采用该策略的其他提交路径。
- SSH config / known_hosts 输入有结构化解析与路径约束，密钥删除限制在解析后的 SSH 目录且验证私钥内容。
- Rust 核心共享状态使用 `tokio::sync` 锁，未发现新增的跨 await `std::sync` 锁或可触发 `panic=abort` 的生产 `expect`。
- `TerminalPane` 正常卸载会断开 ResizeObserver、窗口监听、xterm subscriptions、WebGL addon 和 terminal 实例，未发现新的稳定资源泄漏。

## 10. 验证结果

在审计基线执行：

| 检查 | 结果 |
|---|---|
| `cargo fmt --check` | 通过 |
| `cargo clippy --all-targets -- -D warnings` | 通过 |
| Rust 单元与集成测试 | 通过，共 115 项 |
| ESLint | 通过 |
| TypeScript project build | 通过 |
| Vite production build | 通过 |
| Vitest | 通过，26 个测试文件、292 项测试 |
| i18n check | 通过；23 处动态键、135 个未被字面量直接引用条目为提示项 |
| mojibake check | 通过，扫描 172 个文件 |
| `npm audit --audit-level=high --registry=https://registry.npmjs.org` | 0 个漏洞 |
| `cargo audit` | 除已显式接受的 RUSTSEC-2023-0071 外，无新增阻断项；另有 7 条 allowed warnings |

全绿验证说明当前代码满足既有自动化约束，但本报告中的主要问题属于集成时序、失败注入和数据提交语义，现有测试未覆盖这些触发组合。

## 11. 建议修复批次

### 批次 1：阻断数据丢失

- H-1 修复传输队列主机 ID 提取并补启动集成测试。
- H-2 建立统一的覆盖提交 / 备份回滚机制并覆盖全部 SFTP、同步路径。

### 批次 2：SSH 信任与密钥一致性

- M-1 统一 Windows SSH 目录和 known_hosts 路径。
- M-2 Host Key 提示改为按 token / session 管理的队列。
- M-4 密钥对改为临时文件、权限校验和两阶段提交。

### 批次 3：持久化一致性

- M-5 关键保险箱写盘失败必须向上抛出。
- M-6 为各存储文件建立共享串行写链。
- L-2 让锁定态删除排队具备可验证的持久化结果。

### 批次 4：生命周期与体验

- M-3 把取消 token 下沉到同步分块循环。
- L-1 为事件订阅增加失败回滚与可重试初始化。
- 处理 Release 版本一致性等待验证项。

## 12. 验收标准

本轮问题修复后至少应满足：

- 重启后合法续传记录保留，已删除主机的记录才被清理；
- 所有覆盖路径在任意 rename / remove 失败点都能保留旧正式文件或至少一份完整新文件；
- Windows 上连接校验、信任管理、学习和密钥浏览使用同一 `~/.ssh` 根目录；
- 两个并发未知主机会话都能独立收到并完成 Host Key 应答；
- 大文件同步取消可在一个 chunk 周期内停止；
- 密钥对、保险箱和 Store 写盘失败不再产生“内存成功、磁盘失败”的假成功；
- 事件订阅中途失败后监听器数量回到初始化前状态；
- 全量 Rust / 前端验证继续通过，新增测试覆盖上述失败注入与乱序完成场景。
