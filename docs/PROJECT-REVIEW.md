# CatShell 项目全面分析与改进路线图

> 审计日期：2026-09-10
> 审计范围：`src/`（前端）、`src-tauri/`（Rust 后端）、构建与 CI 配置、文档一致性
> 审计方式：全量源码通读 + 静态检索取证 + 交叉验证（所有结论均带 `文件:行号` 证据）
>
> 注：第二、三节中的行数、覆盖率等数据是**审计时点**（commit `a559a0f`）的快照，用于佐证问题；各问题的当前修复进度以第六节执行记录与第七节路线图为准。

---

## 一、结论速览

### 1.1 总体评价

**这是一个工程底子相当扎实、功能密度远超同类早期项目的 Tauri 应用。** 状态层分层清晰、终端高频输出正确绕开了 React 重渲染、StrictMode 幂等性有保护、危险操作普遍有二次确认、CI 真的在跑 `clippy -D warnings`。问题不在"写得烂"，而在**几处关键路径的正确性缺陷、发布链路的一个致命断点，以及文档严重滞后于代码**。

| 维度 | 评分 | 说明 |
| --- | --- | --- |
| 功能完整度 | ★★★★★ | 覆盖 SSH/SFTP/转发/监控/保险箱/审计/备份，超出 AGENTS.md 记录 |
| 架构设计 | ★★★★☆ | 前后端分层清晰，但存在巨型组件与单文件过载 |
| 代码质量 | ★★★★☆ | 零 `any`、零裸 `println`、类型纪律好；少量超长函数 |
| 安全姿态 | ★★★★☆ | 命令注入防护到位、TOFU 严格；凭证内存管理与 CSP 有欠账 |
| 性能表现 | ★★★☆☆ | 终端实例常驻、PTY 无背压、单 chunk 887 KB |
| 测试覆盖 | ★★☆☆☆ | 仅 3 个前端测试 + 4 个 Rust e2e；SFTP/转发/重连零覆盖 |
| 工程化 | ★★★☆☆ | CI 双 job 完善，但缺漏洞扫描、治理文件、日志系统 |
| 文档一致性 | ★★☆☆☆ | README/AGENTS.md 与代码多处不符，AGENTS.md 甚至未被 git 追踪 |

### 1.2 三个最该先看的问题

1. **【P0】应用内更新在真实发布中必然 404** —— 已逐行核实 `release.yml`：`.exe` / `.msi`（`:62-68`）与 `.sig`（`:69-76`）**只**通过 `actions/upload-artifact` 上传到 Actions artifact（需登录访问且有保留期），Release 通道仅执行了 `gh release upload $tag latest.json`（`:87`）。而 `latest.json` 中声明的下载地址是 `releases/download/$tag/$($exe.Name)`（`:47`）——指向一个从未被创建的 Release 资产。用户点"检查更新"→ 404。这是被 README 和 AGENTS.md 双重宣传的功能，却完全不可用。
2. **【P1】自动重连的实际重试次数只有预期的一半** —— `ssh_manager/mod.rs:902-907` 存在 `attempt += 1` 重复自增，导致"连接建立后掉线"这一最常见场景只重试 1 次就放弃，`MAX_RECONNECT_ATTEMPTS = 3` 形同虚设。
3. **【P1】英文界面下侧边栏导航和会话状态全是中文** —— `en` 字典缺 `nav.*` 与 `status.*`（仅有一个 `status.closed`），回退链直接把中文吐出来了。讽刺的是，**整体英文翻译覆盖率达到 96.8%（581/600）**，唯独最显眼的导航区和状态文案漏了。

---

## 二、项目现状盘点

### 2.1 代码规模

**前端**（`src/`，约 13,015 行）

| 文件 | 行数 | 备注 |
| --- | --- | --- |
| `views/sessions/SessionSftpPanel.tsx` | 784 | 列表 + 5 类弹窗 + 上传下载 + 拖拽 |
| `views/hosts/ConnectDialog.tsx` | 749 | 巨型表单 |
| `i18n/index.ts` | 677 | 字典（`zh` 11 条 + `en` 616 条） |
| `views/HostsView.tsx` | 607 | 列表 + 导入预览 + sshconfig 导入 |
| `views/sessions/SessionsView.tsx` | 541 | 标签 + 工具栏 + 广播 + 批量 + 弹窗 |
| `store/settings.ts` | 473 | 设置持久化 |
| `App.tsx` | 418 | 全局编排 |
| `store/sessions.ts` | 398 | 会话核心 |

**后端**（`src-tauri/`）

| 文件 | 行数 | 备注 |
| --- | --- | --- |
| `ssh_manager/sftp.rs` | 1080 | 最大模块，含 2 个 >150 行函数 |
| `ssh_manager/mod.rs` | 1079 | 会话生命周期、认证、重连、Handler |
| `lib.rs` | 680 | 约 48 个 Tauri command + tray |
| `ssh_manager/forward.rs` | 490 | 端口转发 / SOCKS5 |
| `tests/ssh_e2e.rs` | 424 | 集成测试 |
| `ssh_manager/monitor.rs` | 350 | 监控 / 进程 / 诊断 |
| `ssh_manager/config.rs` | 281 | known_hosts / ssh_config |
| `ssh_manager/types.rs` | 174 | DTO 与常量 |

**构建产物**：`dist/assets/index-*.js` = 909,033 字节（887 KB，单 chunk），CSS = 57 KB。

### 2.2 已有能力矩阵（含文档未记录项）

| 模块 | 已实现 |
| --- | --- |
| SSH 终端 | 多标签、密码/私钥/Agent/交互式 2FA、ProxyJump、分屏、PTY 尺寸同步、心跳保活、指数退避重连 |
| 主机管理 | 保存/搜索/编辑/删除/导入导出、分组折叠、标签筛选、图标选择、`~/.ssh/config` 预览导入 |
| SFTP | 浏览/排序/筛选、上传（拖拽）/下载/删除/新建/重命名/移动/chmod、256 KB 分块流式、磁盘级断点续传（`.catshell-part`）、**远程文件在线编辑** |
| 监控 | CPU/内存/多分区磁盘/网络速率/历史趋势、阈值告警、进程管理 + Kill、Ping/Traceroute、RTT 探测 |
| 网络转发 | 本地 / 远程 / SOCKS5 动态转发，多会话独立管理 |
| 安全 | 加密保险箱（PBKDF2 + AES-GCM）、TOFU 指纹校验、known_hosts 管理页、**审计日志**、**一键备份还原** |
| 界面 | 深/浅/自定义主题、玻璃拟态、背景图、终端外观参数 |
| 平台 | 系统托盘（活动会话角标）、关闭最小化、单实例、窗口状态还原、应用内更新、i18n |

> 注：**审计日志**（`store/audit.ts` + `settings/AuditPanel.tsx`）与**备份还原**（`settings/BackupPanel.tsx`）在 AGENTS.md 的"当前已实现"清单中**完全缺失**。

---

## 三、问题清单

### 3.1 P0 —— 阻断级，建议优先修复

#### P0-1 · 发布产物未上传到 GitHub Release，应用内更新必然失败

**证据**：`.github/workflows/release.yml` 全流程为 `build → 生成 latest.json → upload-artifact（安装包与 .sig）→ gh release upload $tag latest.json --clobber`。

- `latest.json` 中 `platforms."windows-x86_64".url` 指向 `https://github.com/smcloudcat/CatShell/releases/download/$tag/<exe>.exe`
- 但工作流**从未**把 `.exe` / `.msi` 及其 `.sig` 挂到 Release，仅传入了 Actions artifact（外部不可达）

**影响**：`tauri-plugin-updater` 请求的 URL 返回 404，更新功能在真实发布中 100% 不可用。同时 `pub_date`/`signature` 已生成却无对端，`release.yml` 里的"校验签名存在"护栏给人一种"流程已完备"的错觉。

**修复**：

```powershell
gh release upload $tag `
  src-tauri/target/release/bundle/nsis/*.exe `
  src-tauri/target/release/bundle/nsis/*.exe.sig `
  src-tauri/target/release/bundle/msi/*.msi `
  src-tauri/target/release/bundle/msi/*.msi.sig `
  latest.json --clobber
```

或将 `actions/upload-artifact` 改为 `softprops/action-gh-release` 直接挂载到 Release。

---

### 3.2 P1 —— 重要，建议纳入下个发布

#### P1-1 · 自动重连次数双重自增，重试能力减半

**证据**：`src-tauri/src/ssh_manager/mod.rs:899-907`

```rust
if session.manual_closed.load(Ordering::SeqCst) || !creds.auto_reconnect {
    break 'outer Some(reason);
}
attempt += 1;                          // ①
if attempt >= MAX_RECONNECT_ATTEMPTS {  // MAX = 3
    break 'outer Some(reason);
}
attempt += 1;                          // ② 重复自增
tokio::time::sleep(reconnect_delay(attempt)).await;
```

对比 `mod.rs:848-857` 的"连接失败"分支——那里只自增一次。

**实际后果推演**：会话连接成功后再掉线（最常见的网络抖动场景）→ `attempt` 0→1，检查通过 → 1→2，sleep → 重连失败走 Err 分支 → `2 >= 3` 不成立 → `attempt` 2→3，sleep → 再失败 → `3 >= 3` → `break`。**实际只重试了 2 次**，且退避档位被跳过。而首次连接失败反而能完整重试 3 次，两条路径行为不一致。

**修复**：删除第二个 `attempt += 1;`，并补一条覆盖"连接成功后掉线"的重连单元测试。

#### P1-2 · 内存型 SFTP 传输无 GC，通道可能永久滞留

**证据**：`ssh_manager/sftp.rs:495-528`（`ssh_download_begin`）、`sftp.rs:570-599`（`sftp_upload_begin`）将含已打开的 SFTP 通道与 `File` 的 `SftpTransfer` 插入 `sftp_transfers` 表；清理仅发生在 `download_chunk` 走完、`upload_finish` 或 `transfer_cancel`。

**影响**：前端若在 `begin` 后既不拉取 chunk 也不取消（网络中断、页面重载、逻辑分支遗漏），该 `Arc<SftpTransfer>` 与底层 SSH 通道**永久滞留至进程退出**。长时运行的运维工具（数天不关）会持续累积。

**修复**：为 `SftpTransfer` 增加"最后活跃时间"原子戳，对 `sftp_transfers` 启动周期清理任务（如 60s 无进展则关闭并移除）；或给 `download_chunk` / `upload_chunk` 设空闲超时。

#### P1-3 · PTY 输出无节流聚合，存在事件风暴风险

**证据**：`ssh_manager/mod.rs:785-809` 的 `shell_loop` 对每条 `ChannelMsg::Data` / `ExtendedData` 直接 `dispatch_output` → 立即 `send_bytes` / base64 emit（`mod.rs:163-182`）。

**影响**：`cat` 大文件、`tail -f`、`dd`、编译日志等场景下，极短时间内产生海量 IPC 事件；Rust→前端通道无背压信号回传，WebView 主线程被序列化/反序列化压垮，表现为界面卡顿甚至假死。

**修复**：在 `dispatch_output` 引入"时间窗口 + 体积阈值"聚合（如 ≤16 ms 或 ≤64 KB 合并 emit）。项目里已有现成范式可参考——`sftp.rs:177-190` 的 `emit_disk_progress` 用原子戳做了 300 ms 节流，设计良好。

#### P1-4 · 凭证在内存中常驻且不清零

**证据**：`ssh_manager/types.rs:26-28,54-64`，`ConnectRequest` 同时 `derive(Debug, Serialize)`，`password` / `passphrase` / `otp_secret` 均为明文 `String`，随 `ActiveSession` 存活于整个会话期；`otp_secret` 更是长期驻留。

**影响**：进程内存被 dump 时可提取明文凭证；`Debug` 派生意味着一次不慎的 `{:?}` 日志就会泄漏。

**修复**：
- 拆出独立 `Credentials` 结构，**不** `derive(Debug)`、不 `derive(Serialize)`
- 引入 `zeroize`，`passphrase` / `otp_secret` 使用后尽快清零（或直接用 `SecretString`）
- 核查 `russh_keys` 返回的 `KeyPair` 在 drop 时是否清零

#### P1-5 · Rust 端零日志，线上问题无法追查

**证据**：`Cargo.toml:20-37` 无 `log` / `tracing` / `env_logger`；全仓 grep `log::|tracing|env_logger` 无命中（`main.rs:2` 的 `windows_subsystem = "windows"` 在 release 下无控制台）。

**影响**：release 构建下连接失败、SFTP 中断、更新报错全部静默，用户报障时后端无法自证。对安全运维工具这是重大可观测性缺口。

**修复**：引入 `tracing` + `tracing-subscriber`，debug 输出到 stdout、release 写入应用数据目录日志文件，日志级别可在设置页配置。**必须严格过滤敏感字段**（永不记录 password / passphrase / otp / 私钥内容）。

#### P1-6 · 英文界面下导航栏与会话状态显示中文

**证据**：
- `i18n/index.ts:22-23`，`en` 字典仅有 `'status.closed': 'Closed'`，**缺** `nav.home` / `nav.sessions` / `nav.hosts` / `nav.forward` / `nav.settings` 以及 `status.connected` / `status.connecting` / `status.reconnecting` / `status.disconnected` / `status.closing`
- `i18n/index.ts:668-671` 回退链为 `en[key] ?? zh[key] ?? key`，`zh['nav.home'] = '概览'` → 返回中文
- `App.tsx:270` `const label = translate(item.labelKey) || item.fallback`，`fallback` 又是硬编码中文
- `SessionsView.tsx` 用 `` t(`status.${status}`) `` 渲染状态点

**影响**：切成 en-US 后，侧边栏 5 项和所有会话状态文案仍是中文。整体覆盖率其实是 **96.8%（581/600 已翻译）**，偏偏最显眼的位置漏了。

**修复**：补齐 `en` 字典的 `nav.*` 与 `status.*`；增加构建期/测试期脚本扫描源码中全部 `t('...')` 调用并与 `en` 字典比对，缺失即 CI 失败。

#### P1-7 · `ConnectRequest` 构建存在两份源真相

**证据**：
- `views/hosts/ConnectDialog.tsx:256-269`（`submit` 内手工拼装）
- `views/HostsView.tsx:130-143`（`reconnect` 内重复一遍）

两者都手动拼 `password` / `keyPath` / `passphrase` / `otpSecret` / `proxy`，且 `ConnectDialog` 另有 `buildProxy()`（`:163`）与 `buildPersistedProxy()`。

**影响**：新增认证方式或代理字段时必须同步改两处，极易出现"编辑连接能连、主机列表一键连却失败"的隐性 bug，且无测试兜底。

**修复**：抽出纯函数 `buildConnectRequest(profile, form, credentials): ConnectRequest` 放入 `types/session.ts` 或 `store/sessions.ts`，两处共用，并补单测锁死一致性。

#### P1-8 · `Ctrl+W` 直接断开并关闭活动会话，无任何确认

**证据**：`App.tsx:190-199`

```ts
if (key === 'w') {
  if (editable || view !== 'sessions' || state.activeId === null) return
  event.preventDefault()
  const id = state.activeId
  const info = state.sessions[id]
  if (info && (info.status === 'connected' || ...)) {
    void state.disconnect(id)   // 立即断开
  }
  void state.closeTab(id)
}
```

**影响**：运维场景中误触代价高——正在跑的长任务被切断且无法恢复。

**修复**：区分"关闭标签"与"断开连接"。建议裸 `Ctrl+W` 仅关闭标签（连接后台保活），`Ctrl+Shift+W` 才断开；或至少弹出确认框。

#### P1-9 · 所有终端实例常驻内存

**证据**：`views/sessions/SessionsView.tsx:392-399` 对 `order` 中**每个** id 都渲染 `<TerminalPane>`，仅用 `active` class 切换显隐。

**影响**：开 30 个会话 = 30 个 xterm 实例 + 30 个 `ResizeObserver` + 30 个 `window resize` 监听常驻。xterm 携带 canvas/WebGL 与多个 addon，空闲会话也持续消耗内存与 CPU。

**修复**：只挂载 `active` 与 `split` 两个 `TerminalPane`（用 `key` 保活实例），或至少对 `status === 'closed' / 'disconnected'` 的会话卸载终端组件，仅保留标签元信息。

#### P1-10 · 模态框普遍无焦点陷阱、无 Escape 关闭

**证据**：`ConnectDialog`、`SessionsView.tsx:463-473`（批量下发）、`:475-495`（片段参数）、`SessionSftpPanel` 的 mkdir / rename / move / chmod / editor 等弹窗**仅靠遮罩点击关闭**。仅 `Feedback.tsx:105`（确认框）与 `App.tsx:392`（hostKey 弹窗）做了 `autoFocus`，但都没有 Esc 监听与焦点边界约束。

**影响**：键盘用户 Tab 可穿透到遮罩后的背景元素；Esc 关不掉弹窗。对无鼠标场景（纯键盘运维流）体验差。

**修复**：抽公共 `<Modal>` 组件（`styles/modals.css` 已有样式基础），统一实现：打开时聚焦首个可聚焦元素、监听 Escape 关闭、`focusin` 时把焦点锁在容器内、关闭后焦点归还触发按钮、`aria-labelledby` 指向标题。

#### P1-11 · 巨型组件承担过多职责

**证据**：`SessionSftpPanel.tsx` 784 行、`ConnectDialog.tsx` 749 行、`SessionsView.tsx` 541 行、`HostsView.tsx` 607 行。

**影响**：违反单一职责，新增 SFTP 操作或连接字段需在大文件中穿插修改，回归风险高、评审困难。

**修复**：
- `SessionSftpPanel` 拆出 `SftpNameDialog` / `SftpChmodDialog` / `SftpEditorModal` / `SftpDropZone`（已有 `SftpTransferList` 拆分先例）
- `ConnectDialog` 的表单状态与请求构建抽到 store 或纯函数（见 P1-7）
- `SessionsView` 把标签栏、广播条、批量弹窗、片段参数弹窗各自抽组件

**已完成**（2026-09-10）。四个文件全部拆到 400 行以内，新增的纯函数层同时补上了单元测试：

| 原文件 | 拆前 | 拆后 | 新增模块 |
| --- | --- | --- | --- |
| `SessionSftpPanel.tsx` | 795 | 557 | `sftpUtils`（路径/权限/排序/校验）、`sftpTransferOps`（分块上传下载）、`SftpToolbar`、`SftpEntryList`、`SftpDropZone`、三个弹窗组件 |
| `ConnectDialog.tsx` | 758 | 406 | `connectForm`（表单模型 + 两条校验路径 + 持久化投影）、`HostAuthFields`、`HostProxyFields`、`HostIconPicker` |
| `SessionsView.tsx` | 548 | 383 | `sessionViewUtils`、`usePanelResize`、`SessionTabBar`、`SessionToolbar`、`BroadcastBar`、`SessionDialog` + 两个弹窗 |
| `HostsView.tsx` | 604 | 352 | `hostList`（标签/筛选/分组）、`HostRow`、`HostImportPreviewModal`、`SshConfigImportModal` |

顺带修掉一处隐患：`connectForm` 的空表单常量被 `setForm` 直接复用，已改为 `emptyConnectForm()` 工厂返回新对象，避免未来原地改写污染共享常量。`normalizeKeepalive` 原先未夹到表单声明的 `[5, 300]`，现已在 `types/session` 统一兜住，两条提交路径不再各写一份。

#### P1-12 · 测试覆盖严重不足

**前端**：仅 3 个测试文件（`snippet.test.ts` / `theme.test.ts` / `vaultCrypto.test.ts`），覆盖纯函数。

**后端**：`tests/ssh_e2e.rs` 4 个用例（生命周期、raw 通道、错误凭证不重连 ×2）+ `config.rs` / `monitor.rs` / `forward.rs` 少量单测。

**明显缺口**：
- SFTP 全链路（list / read / write / remove / mkdir / rename / chmod / 分块 / 磁盘续传）—— **零覆盖**
- 端口转发（本地 / 远程 / SOCKS5）端到端 —— 仅 SOCKS5 解析单测
- **自动重连**（正好能抓到 P1-1 的 bug）—— 零覆盖
- **指纹变更应被拒绝**（MITM 路径 `mod.rs:256-263`）—— 零覆盖
- 并发场景（多会话 / 并发传输 / 并发取消）—— 零覆盖
- 边界校验（`validate_sftp_path` 空字节、非法 pid/signal、非法诊断类型）—— 零覆盖
- Agent 认证与 KBI 自动应答 —— 零覆盖

**优先补**：`hosts.ts` 的 `normalizeHost` / `isValidHost` / `previewHostImport`（导入信任边界）、`types/snippet.ts` 的 `shellQuote`（命令注入转义，安全相关）、重连逻辑、指纹变更拒绝。

**已补齐（2026-09-10）**：

| 缺口 | 补法 | 落地 |
|---|---|---|
| 前端纯函数层 | 新增 6 个 vitest 文件 | `connectRequest` / `connectForm` / `hostImport` / `hostList` / `sftpUtils` / `sessionViewUtils`，合计 141 例（后续补齐错误码映射等用例后为 155 例） |
| SFTP 全链路 | 新增 `tests/sftp_e2e.rs` | list / read / write / 覆盖写 / mkdir / rename / chmod / remove，并验证状态跨 SFTP 会话保持 |
| 端口转发端到端 | 新增 `tests/forward_e2e.rs` | 本地转发的流量确实穿过 SSH 到达目标服务；非回环绑定被拒绝 |
| 指纹变更拒绝 | `tests/ssh_e2e.rs` 新增用例 | 篡改 known_hosts 后连接必须阻断，且**不得**重新弹确认框 |
| 边界校验 | `tests/sftp_e2e.rs` | 空白 / 含 NUL / 超长远程路径在发起连接之前就被拒 |

测试基建抽到 `tests/common/mod.rs`：一个支持 shell 回显、sftp 子系统与 direct-tcpip 的本地 SSH 服务器，外加连接级共享的内存 SFTP 文件系统。

**仍缺口**：远程转发与 SOCKS5 的端到端链路、并发场景（多会话 / 并发传输 / 并发取消）、Agent 认证与 KBI 自动应答。

#### P1-13 · AGENTS.md 未被 git 追踪，且多处与代码不符

**证据**：`.gitignore:20` 含 `AGENTS.md`，`git ls-files AGENTS.md` 返回空 → 该文件未纳入版本控制。

**矛盾点**：AGENTS.md 自身定位是"仓库级 agent 指引"（文件头写 `File: G:\github\ssh\AGENTS.md`），协作者与 AI agent 克隆后根本拿不到。

**修复**：移除 `.gitignore` 中该行并提交；若确为本地私用，应在 README 注明。同时修正下文第六节的文档差异清单。

#### P1-14 · 缺少治理与供应链文件

**证据**：仓库根目录无 `SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`rustfmt.toml`、`clippy.toml`、`deny.toml`、`.editorconfig`。CI（`ci.yml`）无 `cargo audit` / `npm audit`。

**影响**：作为处理密钥与凭据的安全工具，无漏洞通报渠道、无依赖漏洞自动拦截、无版本变更记录（版本号需手工同步 `package.json` / `Cargo.toml` / `tauri.conf.json` 三处，当前均为 0.1.0）。

**修复**：补齐上述文件；CI 增加 `rustsec/audit-check` 与 `npm audit --audit-level=high`。

---

### 3.3 P2 / P3 问题汇总

| 编号 | 问题 | 证据 | 级别 |
| --- | --- | --- | --- |
| P2-1 | 锁风格混用：`known_hosts_path` 用 `std::sync::RwLock`，其余用 `tokio::sync::Mutex`，且在异步上下文中 `expect`。**已修复**：改用 `tokio::sync::RwLock`，读写接口转 async，`tokio` 的守卫不返回 `Result`，`expect` 路径从类型上消失 | `mod.rs:70,92,931,939` | P2 |
| P2-2 | 长持 `session.conn` 锁跨 await 执行远程命令（监控最长 8s、ping 10s），串行化同会话其他操作。**已修复**：新增 `open_session_channel`，连接锁只覆盖通道协商；通道建立后即可脱离 `Handle` 独立收发（`exec` 取 `&self`、`split` 消费自身），监控/SFTP 子系统/进程列表/网络诊断全部改为锁外执行 | `monitor.rs:180-196`、`sftp.rs:454-469` | P2 |
| P2-3 | `panic = "abort"`（`Cargo.toml:45`）下多处 `.expect()` 会终止整个应用；spawn 的任务无 `catch_unwind` 隔离。**已修复**：`SftpDiskTransfer::error_guard` 改 `unwrap_or_else(\|p\| p.into_inner())` 容忍锁中毒并补守护测试。仅保留 `lib.rs` 启动处的 `expect`（进程引导点，此前无任何可回收状态，失败也不存在"降级继续运行"的语义） | `mod.rs:931,939`、`sftp.rs:153,167,172`、`mod.rs:1022`、`sftp.rs:754,910` | P2 |
| P2-4 | `known_hosts` 切到 openssh 模式会直接改写用户真实 `~/.ssh/known_hosts`，副作用超出预期且无 UI 提示。**已修复**：切回 OpenSSH 模式前弹确认框，明确说明该文件与 `ssh` / `scp` / `git` 共享；取消时同步回弹下拉框 | `lib.rs:534-536` | P2 |
| P2-5 | 磁盘传输与会话生命周期脱节：`disconnect`/`remove` 不取消进行中的 `SftpDiskTransfer`。**已修复**：新增 `cancel_transfers_for_session`，两类传输（流式 + 磁盘）一并置取消位 | `mod.rs:1061-1078` | P2 |
| P2-6 | 转发每连接的子任务未跟踪，`stop_forward` 只 abort listener，在飞连接不受影响。**已修复**：新增 `forward_children` 登记子任务句柄，停止转发与 listener 自行退出时都一并 abort | `forward.rs:139-164,341-342` | P2 |
| P2-7 | 无 `Drop` 兜底清理，依赖 Arc 归零隐式关闭。**已修复**：`ActiveSession` 实现 `Drop`，最后一处释放时兜底置位 `manual_closed`（收束仍在跑的重连循环）并留诊断日志 | `ActiveSession` / `SftpTransfer` / `SftpDiskTransfer` | P2 |
| P2-8 | 断点续传未校验远端文件是否变更，仅比对 part 长度，远端文件被替换会续到错误偏移。**已修复**：新增 `ResumeStamp`（长度 + mtime）随半成品落盘，续传前必须完全一致，否则从 0 重传；`resume_offset` 纯函数 4 例单测覆盖指纹不符/缺失/长度越界 | `sftp.rs:855-863,702-708` | P2 |
| P2-9 | 并发同名上传共用 `{target}.catshell-part`，互相覆盖，rename 可能把半成品当成品。**已修复**：基准半成品路径已被占用时改用带传输号的一次性路径并禁用续传（`part_path_for`），保证「单条可续传、并发互不干扰」 | `sftp.rs:865-878` | P2 |
| P2-10 | CSP 含 `script-src 'unsafe-inline'`，对处理凭证的桌面应用放宽了 XSS 防护。**已修复**：生产 `csp` 收紧为 `script-src 'self'`——`index.html` 的内联主题脚本移为同源文件 `public/theme-boot.js`（构建产物已确认无内联脚本）；`style-src` 保留 `'unsafe-inline'`（xterm 动态注入样式 + React 内联 style），开发期另设 `devCsp` 保留 Vite / React Refresh 所需的内联脚本与 ws 连接 | `tauri.conf.json:24` | P2 |
| P2-11 | 错误类型未统一，全项目用 `Result<_, String>`，无 `thiserror`，难以分类与国际化。**未处理**：Tauri command 边界必须返回 `Serialize` 错误，全量换 `thiserror` 需同时改约百处签名与前端契约，收益与风险不匹配，留待单独排期 | 全局 | P2 |
| P2-12 | 前端无统一 Logger，6 处散落 `console.*`。**已修复**：新增 `src/utils/logger.ts` 统一出口（`[CatShell]` 前缀，`debug` 仅开发构建输出），6 处全部收编并补 3 例守护测试 | `src/utils/logger.ts` | P2 |
| P2-13 | 事件 payload 无版本号 / 无 schema 校验，前端字段改名即静默失效。**已修复**：所有事件 payload 加 `v`（Rust `EVENT_SCHEMA_VERSION`）；前端 `versioned()` 守卫丢弃版本不符的事件并告警；vitest 直接读取 Rust 源码交叉校验两侧常量 | `mod.rs:159,170,278,407` | P2 |
| P2-14 | `vite.config.ts` 无任何 `build` 配置：无分包、无 sourcemap、无显式 target | `vite.config.ts:1-32` | P2 |
| P2-15 | `tsconfig.json` 缺 `noUncheckedIndexedAccess`、`noImplicitOverride`、`exactOptionalPropertyTypes`。**已修复**：三项全部开启，共修正 40 处——数组索引与 `Record` 取值加显式守卫、class 组件补 `override`、可选属性在类型上显式并入 `| undefined` | `tsconfig.json:18-21` | P2 |
| P2-16 | `build` 脚本为 `tsc && vite build`（非 `tsc -b`），`tsconfig.node.json` 游离于类型检查外。**已修复**：改为 `tsc -b && vite build`，`vite.config.ts` 首次纳入检查（顺带发现一条过期的 `@ts-expect-error`），`tsconfig.node.json` 的构建产物落在 `node_modules/.tmp` | `package.json:8`、`tsconfig.json:23` | P2 |
| P2-17 | ESLint 仅用 `recommended`，未启用 `recommendedTypeChecked` / `strict`。**已修复**：启用 `recommendedTypeChecked` + `parserOptions.projectService`，17 处全部修正 | `eslint.config.js:7-34` | P2 |
| P2-18 | Cargo 插件版本策略混用：部分 `"2"`、部分精确小版本，与前端版本可能漂移。**已修复**：Tauri 生态统一声明 `"2"`，底层行为依赖（`tokio` / `bytes` / `russh`）保持精确小版本并注释说明理由 | `Cargo.toml:21-47` | P2 |
| P2-19 | 长列表未虚拟化：主机列表、SFTP 大目录全量渲染，行组件未 `memo`。**部分修复**：SFTP 大目录（> 120 行）改为按可视区间渲染（`computeVirtualWindow` 纯函数 9 例单测 + `useVirtualWindow`），行组件 `memo` 化并把 `actions` 用 ref 转发成恒定引用，`SessionSftpPanel` 的 `entryActions` 因此可稳定；主机列表行高可变（标签会换行），窗口化需真机测量，本轮只做 `memo` + 回调 `useCallback` 稳定化 | `HostsView.tsx:345,351`、`SessionSftpPanel.tsx:679-699` | P2 |
| P2-20 | 定时器依赖不稳定值被反复重建。**已修复**：改为依赖稳定的布尔量，仅在「有无已连接会话」翻转时重建；此前依赖每次刷新都换引用的 `order` / `sessions`，30 秒定时器被反复重建、实际从不触发 | `SessionsView.tsx:104-108` | P2 |
| P2-21 | 错误展示入口不统一：`.form-error` 内联与 Toast 混用。**部分缓解**：错误文案的取值入口已统一为 `AppError` 错误码 + `errorText()`，内联/Toast 的展示形式仍按场景选择 | 多个 view | P2 |
| P2-22 | `ErrorBoundary` 的兜底文案 "界面发生错误" / "重新加载" 未走 `t()`。**已修复**：改用非 hook 的 `t()` 并补 `en` 条目。原条目并提的 `ConnectDialog` "SSH Agent" 字面量已随组件拆分消失 | `ErrorBoundary.tsx:38,42` | P2 |
| P2-23 | i18n 以中文为 key，漏翻静默回退无感知。**已缓解**：`npm run i18n:check`（含错误码文案表）接入 CI，`npm run i18n:audit` 复查常量表等间接引用 | `i18n/index.ts:668-671` | P2 |
| P3-1 | 并发 host-key 确认令牌为 `host:port:fingerprint`，同 host:port 并发连接会覆盖 oneshot | `mod.rs:281-285` | P3 |
| P3-2 | 重连退避无 jitter，多会话同时掉线会雷群重连；且重连成功即重置计数，可无限重连 | `types.rs:151-157`、`mod.rs:860` | P3 |
| P3-3 | 取消传输时故意保留的 `.catshell-part` 无清理入口，长期残留 | `sftp.rs` | P3 |
| P3-4 | 下载完成先 `remove_file(local_path)` 再 `rename`，若 local 为符号链接仅删链接 | `sftp.rs:789-796` | P3 |
| P3-5 | `ssh_connect` 的 `port == 0` 未显式拒绝，交给底层超时 | `mod.rs` | P3 |
| P3-6 | Agent 认证逐个尝试所有身份，硬件密钥可能触发多次触摸 | `mod.rs:576-631` | P3 |

---

## 四、可升级方向

### 4.1 架构与代码组织

| 方向 | 现状 | 目标 |
| --- | --- | --- |
| Rust 模块拆分 | `sftp.rs` 1080 行、`mod.rs` 1079 行、`lib.rs` 680 行含约 48 个 command | `lib.rs` 按 command 域拆 `commands/` 子模块；`sftp_disk_*_start`（158/165 行）拆为 `prepare_*` + `run_disk_transfer`；`open_shell`（143 行）拆 `connect_direct` / `connect_via_proxy` |
| 前端组件粒度 | 4 个 >500 行组件 | 按职责拆子组件；表单构建逻辑下沉为纯函数 |
| 类型同步机制 | 前后端类型靠人工同步（AGENTS.md:103 明确要求同步） | 引入 `tauri-specta` 或 `ts-rs` 自动生成 TS 类型，从根上消除漂移 |
| 目录归属 | `views/sessions/sftpTransferStore.ts` 是 store 却放在 views 下 | 归并到 `src/store/` |
| 错误类型 | 全局 `Result<_, String>` | 引入 `thiserror` 定义统一错误枚举，支持分类、i18n 与可观测性 |

### 4.2 性能

| 方向 | 预期收益 |
| --- | --- |
| PTY 输出聚合（16 ms / 64 KB 窗口） | 大输出场景下 IPC 事件量下降 1~2 个数量级，消除界面假死 |
| 终端实例按需挂载 | 30 会话内存占用显著下降，空闲会话不再占用 CPU |
| 前端分包 + `React.lazy` 路由级懒加载 | 首屏 JS 从 887 KB 显著下降（xterm 及其 addon 单独拆 chunk） |
| SFTP / 主机长列表虚拟化 | 数千条目目录滚动流畅 |
| 传输带宽节流（令牌桶） | 避免 SFTP 占满链路影响其他业务 |
| 短临界区改造：监控 / SFTP 走独立多路复用通道 | 同会话内操作可并发，不再互相阻塞 |

### 4.3 安全纵深

| 方向 | 说明 |
| --- | --- |
| 凭证 `zeroize` + 去 `Debug`/`Serialize` | 关闭内存 dump 与调试日志两条泄漏路径 |
| CSP 去 `unsafe-inline` | 改用 nonce / hash，收紧 XSS 面 |
| capability 收紧 | 评估 `core:window:allow-destroy` 是否必要（误调用会关主窗） |
| known_hosts 隔离默认值 | 默认 appdata 独立存储，切 openssh 模式时明确 UI 警示 |
| 任务级 panic 隔离 | spawned 任务包 `catch_unwind`，避免单传输失败拖垮整个应用 |
| 敏感字段过滤的日志系统 | 补上可观测性，同时保证绝不记录 password / passphrase / otp |

### 4.4 工程化

| 方向 | 动作 |
| --- | --- |
| CI 补强 | `cargo audit` + `npm audit`；`cargo llvm-cov` 或 Linux 矩阵跑 tarpaulin |
| 规范固化 | `rustfmt.toml`、`clippy.toml`（对 `ssh_manager/` 评估 `unwrap_used`）、`.editorconfig` |
| 治理文件 | `SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`（Keep a Changelog） |
| 版本管理 | CI 自动生成 release notes，替换 `release.yml` 里硬编码的 "CatShell $tag" |
| 开发者体验 | devcontainer / Dockerfile 一行拉起一致环境；README 补 MSVC 常见坑与 updater 签名配置步骤 |

---

## 五、可新增功能（按提升用户体验的优先级排序）

### A. 会话与终端体验

| 功能 | 价值 | 依赖/成本 |
| --- | --- | --- |
| **会话恢复** | 应用重启后按 `ssh_list` 自动重建标签页，或提供"恢复上次会话"入口。当前 `closeToTray` 只在最小化时保活，完全退出即丢 | 低（`ssh_list` 已存在，`sessions.ts:152`） |
| **Ctrl+R 命令历史反向搜索** | 运维高频操作，xterm 自身不提供，需接 shell 历史或前端记录 | 中 |
| **命令面板（Ctrl+K）** | 快速跳转主机/会话/设置、执行片段、开关面板 | 中 |
| **快捷键速查面板（Ctrl+/）** | 当前快捷键只作为 `title` 提示，无可发现性 | 低 |
| **标签拖拽排序 / 拖出独立窗口** | 按业务分组管理会话 | 中 |
| **分屏扩展为 2×2 四宫格** | 当前仅左右两屏（`SessionsView.tsx:195-204`） | 中 |
| **会话掉线/重连 Toast 通知** | 当前仅监控阈值有告警 Toast，会话状态变化无提示 | 低 |
| **终端配色方案（Solaris / Dracula / Nord 等预设）** | 一键切换，比手工调参数更易用 | 低 |
| **终端字号快捷缩放（Ctrl +/-）** | 当前需进设置页 | 低 |

### B. 运维效率

| 功能 | 价值 | 依赖/成本 |
| --- | --- | --- |
| **多跳 ProxyJump 链** | ~~当前仅支持单级 `proxy`~~ **已修复（6.10）**：`ProxyConfig` 链式 `next`，逐级 direct-tcpip 隧道，上限 4 级；`ProxyCommand` 形式仍不支持 | 中 |
| **批量/并行命令执行** | 跨多会话同时下发并聚合结果（已有"广播输入"基础，可扩展为"批量执行 + 结果对比"） | 中 |
| **会话录制与回放** | 落盘 asciinema 格式，`shell_loop` 已有完整字节流，加可选 recorder 即可 | 中，价值高 |
| **SFTP 路径栏可编辑 / 面包屑跳转** | 当前只能逐级进入（`SessionSftpPanel.tsx:640`），无法直接输入绝对路径 | 低 |
| **SFTP 本地↔远程双向同步（rsync 风格）** | 基于现有 SFTP + 校验和做差异同步 | 高 |
| **全局统一搜索** | 跨主机名 / IP / 标签 / 会话名 / 片段 | 低 |
| **主机分组批量操作** | 整组连接、整组执行命令 | 中 |
| **本地 Shell / Telnet / 串口会话** | 运维场景常见需求 | 中 |

### C. 安全与合规

| 功能 | 价值 | 依赖/成本 |
| --- | --- | --- |
| **密钥管理 UI** | 生成密钥对、管理 `~/.ssh/` 目录、查看公钥指纹 | 中 |
| **SSH config 写回** | 当前 `ssh_config_parse` 只读（`lib.rs:552-561`），应支持把连接配置写回（注意原子写：先 `.tmp` 再 rename） | 中 |
| **私钥口令保险箱联动** | 连接时自动从保险箱取口令，免手输 | 低 |
| **审计日志增强** | 记录"谁在何时连了哪台机器、执行了什么"，支持导出合规报表 | 中 |
| **敏感操作二次确认可配置** | 让用户自定义哪些操作需要确认 | 低 |
| **硬件密钥（FIDO2/U2F）支持** | 通过 agent 转发实现 | 高 |

### D. 传输与网络

| 功能 | 价值 | 依赖/成本 |
| --- | --- | --- |
| **传输队列持久化** | 分块上传取消即丢失（`SessionSftpPanel.tsx:342`），磁盘级才有续传；统一两者体验 | 中 |
| **`.catshell-part` 清理入口** | 清理残留半成品文件 | 低 |
| **带宽限速** | 令牌桶实现，避免占满生产链路 | 中 |
| **RDP / VNC 标签页** | 远程桌面集成（长期） | 高 |
| **Mosh 支持** | UDP 保活，网络切换不断线，对移动运维价值高 | 高 |

### E. 平台与集成

| 功能 | 价值 |
| --- | --- |
| **深色/浅色跟随系统** | 当前需手动切换 |
| **系统托盘快捷连接菜单** | 右键托盘直接连常用主机 |
| **命令行启动参数**（`catshell ssh user@host`） | 从终端或其他工具直接唤起连接 |
| **AI 辅助** | 自然语言生成命令、错误日志诊断、命令风险提示（如识别 `rm -rf /`） |
| **插件/脚本扩展机制** | 允许用户自定义命令片段自动化流程 |

---

## 六、文档一致性修正清单

> **执行状态（2026-09-10）**：本节全部 11 项已落地，详见 6.3 执行记录。

### 6.1 待修正条目

| 文档位置 | 实际代码情况 | 差异类型 | 修正建议 | 级别 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `AGENTS.md:5` 项目名 "SSH Ops" | `productName` / 包名 / README 均为 **CatShell** | 名称错误 | 改为 CatShell | P2 | ✅ |
| `AGENTS.md:100` 称 SSH 核心在 `src-tauri/src/ssh_manager.rs` 单文件 | 已拆为 `ssh_manager/` 目录（7 个文件），且与 `AGENTS.md:46` 自相矛盾 | 路径/结构过时 | 改为目录描述 | **P1** | ✅ |
| `README.md:47` 同样写 `ssh_manager.rs` 单文件 | 同上 | 结构过时 | 改为目录 + `mod.rs` 说明 | **P1** | ✅ |
| `README.md:34` 插件清单写 "dialog / opener / store" | 实际 8 个插件注册（`lib.rs:577-591`） | 清单缺失 | 补全插件列表 | **P1** | ✅ |
| `README.md:39-53` 目录树 | 缺 `src/i18n/`、`src/utils/`、`src/styles/`、`src/__tests__/`、`src-tauri/tests/`、`build.rs` | 结构缺失 | 补全目录树 | P2 | ✅ |
| `AGENTS.md:7-29` "当前已实现"清单 | 缺**审计日志**、**备份还原**（代码有 `AuditPanel` / `BackupPanel`）、**SFTP 在线编辑**、**RTT 探测**、**端口转发**、**阈值告警**、**进程 Kill** | 功能漏写 | 补入清单 | P2 | ✅ |
| `README.md:58` "Node.js 18+（建议 20 LTS）" | CI 用 `node-version: 22`，依赖 `@types/node 26` / `vite 8` / `eslint 10` | 版本说明过时 | 改 "Node 20+（建议 22）" | P2 | ✅ |
| `README.md:70` vs `tauri.conf.json:44` | clone 地址 `CatShell` vs endpoint `catshell` | 大小写不一致 | 统一 | P2 | ✅ 已核实 |
| `AGENTS.md:56` 硬编码 `G:\github\ssh` | 维护者本机路径 | 不宜固化 | 改相对/占位描述 | P2 | ✅ |
| `README.md:100-113` 构建章节 | 未说明需配置 `TAURI_SIGNING_PRIVATE_KEY` / `PASSWORD` 与真实 pubkey | 发布说明缺失 | 补充签名配置步骤 | P2 | ✅ |
| 全仓库 | 无 `CHANGELOG.md` / `CONTRIBUTING.md` / `SECURITY.md` | 治理文件缺失 | 新增（安全工具尤需 SECURITY.md） | **P1** | ✅ |

**关于 `README.md:70` 大小写**：经核实，`git remote -v` 返回 `https://github.com/smcloudcat/CatShell.git`，仓库名本身确为 `CatShell`；`tauri.conf.json` 中 `catshell` 出现在 **updater endpoint**，而 GitHub 路由大小写不敏感，故此处无需改动。已在 README 中补充更新端点说明。

### 6.2 正面确认

- `package.json:4`、`Cargo.toml:3`、`tauri.conf.json:4` 版本号均为 `0.1.0`，**三处一致** ✓
- `Cargo.toml:41-46` release profile 优化到位（`codegen-units = 1`、`lto = true`、`opt-level = 3`、`panic = "abort"`、`strip = true`）✓
- `ci.yml:38-44` 确实执行 `cargo fmt --check` → `cargo clippy --all-targets -- -D warnings` → `cargo check` → `cargo test`，与 AGENTS.md 要求一致 ✓（`--all-targets` 为收尾补入，使 `tests/` 也纳入 Lint）
- `tauri.conf.json:32-38` 图标（png/icns/ico）与 `identifier` 完整 ✓
- `lib.rs` 实际注册 **42 个 command** 与 **8 个插件**，`generate_handler!` 与文档描述已对齐 ✓

### 6.3 执行记录（2026-09-10）

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `AGENTS.md` | 重写 | 项目名改 CatShell；`ssh_manager.rs` → `ssh_manager/` 目录；"当前已实现"补入审计日志、备份还原、SFTP 在线编辑、RTT、端口转发、阈值告警、进程 Kill；移除硬编码 `G:\github\ssh`；目录结构补全 `src/i18n/`、`src/utils/`、`src/styles/`、`src/__tests__/`、`src-tauri/tests/`、`build.rs`；补入 command/插件数量、known_hosts Windows 路径约定、转发回环约束、破坏性操作确认要求、重连预算约束；手动验证清单新增断点续传 / 重连 / 转发 / 窄窗口场景 |
| `README.md` | 修订 | 技术栈补全 8 插件与版本号；目录树补全；Node 18+ → 20+（建议 22）；构建章节新增「应用内更新与签名配置」小节 |
| `SECURITY.md` | 新建 | 支持版本、私有漏洞报告通道、安全设计边界（7 条硬约束）、用户侧建议、已知限制 |
| `CONTRIBUTING.md` | 新建 | 环境准备、开发流程、验证清单、代码约定、提交信息规范、安全红线 |
| `CHANGELOG.md` | 新建 | Keep a Changelog 格式；`0.1.0` 完整功能回填 + `Unreleased` 计划项 |
| `.gitignore` | 修订 | **保留 `AGENTS.md` 忽略项**（项目方决定：该文件是本地 agent 配置，不纳入版本控制） |
| `src/i18n/index.ts` | 修订 | **代码修复**：补全 `en` 字典缺失的 `nav.*`（5 条）与 `status.*`（5 条）。**注**：此处所称「100%」是按字面量 `t()` 统计的；后续核查发现审计动作名等经常量表间接引用的键仍有缺口，已在 P1-6 收尾时补齐 43 条并加入 CI 校验（`npm run i18n:check`），避免再次高估 |

**验证**：`npx tsc --noEmit` 通过；`npm test` 19/19 通过。（此为首次文档修正轮的记录；测试规模随后续补齐已增至 10 个文件 155 例。）

### 6.4 后续补充（同日）

首轮修正后又做了一轮数字校准与收尾：

| 项 | 处理 |
| --- | --- |
| 文档数字/命令复核 | 修正 `README.md` 的测试文件数（9 → 10）；第八节与 AGENTS.md 的 clippy 命令补 `--all-targets`；开发命令与验证顺序补 `i18n:check` 与 `mojibake:check` |
| `P2-22` | `ErrorBoundary` 两处兜底文案接入 `t()` 并补 `en` 条目 |
| **新发现：`src/styles/` 注释乱码** | 中文注释曾被按 GBK 重写，出现「閫氱敤瑙嗗浘」式乱码，并夹带 BOM 与合并掉的换行。已用「乱码字符按 GBK 编码 → 结果按 UTF-8 解码」的可逆关系还原文 9 个文件共 31 行；分区标题与拆分前的 `App.css` 逐一比对确认，另清掉 `glass.css` 的 BOM |
| **防复发** | 新增 `scripts/check-mojibake.mjs`（零依赖，用 `TextDecoder('gbk')` 反建编码表），接入 `npm run mojibake:check` 与 CI，同时拦截私用区字符 |

`PROJECT-REVIEW.md` 这类「审计快照 + 执行记录」双层文档的维护约定：**第二、三节的取证数据保留原貌**（改动会破坏可复现性），**操作指引与执行记录必须与现状一致**；数字类断言一律先用命令实测再落笔。

### 6.5 技术债推进（同日，P2 前两批）

文档校准完成后转入第二、三节的 P2 技术债清理，已完成 6 项：

| 项 | 处理 |
| --- | --- |
| `P2-12` | 新增 `src/utils/logger.ts` 统一日志出口，6 处散落 `console.*` 收编；`debug` 仅开发构建输出，日志按约定不做国际化 |
| `P2-16` | `build` 改 `tsc -b && vite build`；`vite.config.ts` 首次进入类型检查，立刻暴露一条过期的 `@ts-expect-error`（`@types/node` 早已安装）；`tsconfig.node.json` 作为被引用的 composite 项目不能 `noEmit`（TS6310），产物改落 `node_modules/.tmp` |
| `P2-18` | Cargo 版本策略显式分层并注释理由，Tauri 生态 `"2"`、底层行为依赖精确小版本 |
| `P2-20` | 修掉时长定时器因依赖不稳定对象而永不触发的问题（详见「修复」条目） |
| `P2-15` | 开启 `noUncheckedIndexedAccess` / `noImplicitOverride` / `exactOptionalPropertyTypes`，40 处类型修正 |
| `P2-17` | ESLint 启用 `recommendedTypeChecked` + `projectService`，17 处修正（`UnlistenFn` 实为同步签名，顺带去掉了多余的 `await` 并收窄订阅函数的返回类型） |

**验证**：`tsc` ✓ · `eslint .`（含 type-checked）✓ · `i18n:check` ✓ · `mojibake:check` ✓ · 前端 **158 例**（11 文件）· `build` ✓。

**同期修复的构建故障**：`npm run tauri dev` 编译 `catshell_lib` 时 rustc 1.98.1 ICE（`rustc_metadata/rmeta/encoder.rs:2474 -- no entry found for key`）。根因是「多 crate-type（`staticlib` + `cdylib` + `rlib`）叠加 `-C incremental`」，同源的另一种表现是 `cargo test` 报 `os error 5` 拒绝访问；与业务代码无关。处置：清掉 12G 陈旧增量缓存（内含改名前的 `ssh_ops_lib-*` 化石条目），并新增 `src-tauri/.cargo/config.toml` 设 `[build] incremental = false` 根治。

**仍待处理**：P2-11（错误类型统一，见该行说明）。P2-19 的主机列表窗口化需在真机窗口内按可变行高实测；P2-10 的 CSP 收紧已在构建产物层确认 `index.html` 不再含内联脚本，但仍建议在真机 `npm run tauri dev` / 安装包各跑一次确认无白屏。

### 6.6 技术债推进（同日，P2 收尾批）

第三批清掉 Rust 正确性与生命周期 11 项中的 10 项，外加 P2-13 / P2-19 / P2-10：

| 项 | 处理 |
| --- | --- |
| `P2-1` | `known_hosts_path` 换 `tokio::sync::RwLock`，`set_/effective_known_hosts_path` 转 async（4 处调用点同步改造） |
| `P2-2` | 新增 `open_session_channel`：锁只覆盖通道协商。已确认 russh 0.63 的 `client::Handle` 不可克隆且 `channel_open_session` 需要 `&mut self`，但 `Channel::exec` 取 `&self`、`split(self)` 消费自身——通道一旦建立即可脱离 `Handle` 收发，这正是把锁范围收缩到协商一步的依据 |
| `P2-3` | 锁中毒不再 panic，补「中毒后仍能记录错误」的守护测试 |
| `P2-4` | 切回 OpenSSH 存储前弹确认；受控 `select` 取消后需一次重渲染才回弹，用 `bumpSelectTick` 显式触发 |
| `P2-5` `P2-6` `P2-7` | 生命周期收口：会话取消名下全部传输、转发登记并 abort 在飞子任务、`ActiveSession` 加 `Drop` 兜底 |
| `P2-8` | 续传指纹（长度 + mtime）落本地 `{part}.meta`；下载跟随远端源文件、上传跟随本地源文件。**方向修正**：上传的半成品在远端而源文件在本地，指纹必须落在本地源文件旁，否则会写到远端路径同名的工作目录相对路径 |
| `P2-9` | 半成品路径占用检测 + 一次性后缀；`transfer_id` 因此提前到打开文件之前分配 |
| `P2-13` | 事件 `v` 字段 + 前端守卫；Rust 与前端两份常量由 vitest 直接读 Rust 源码交叉校验，防止各改一份 |
| `P2-19` | SFTP 大目录窗口化 + 行 `memo` + `actions` 引用稳定化。SFTP 行高固定 52px（`min-height: 42px` + 上下 5px padding，且名称 `nowrap`），窗口化时显式给 `height + box-sizing: border-box` 以精确预测总高 |
| `P2-10` | 内联主题脚本外移为 `public/theme-boot.js`（经典脚本，执行时机不变），生产 `script-src 'self'`；新增 `devCsp` 供 Vite HMR 与 React Refresh |

**顺带修掉一条既有 lint 失败**：`SessionMonitorPanel` 把 Promise 返回函数直接交给 `window.setInterval`，触发 `@typescript-eslint/no-misused-promises`。已用 HEAD 版本内容经 `eslint --stdin` 复现确认是既有问题（非本轮引入），同一轮修掉，`npm run lint` 现为全绿。

**验证**：`cargo fmt --check` ✓ · `cargo clippy --all-targets -- -D warnings` ✓ · `cargo test` **42 例**（32 单测 + 10 集成）✓ · `tsc -b` ✓ · `eslint .` ✓ · `i18n:check` ✓ · `mojibake:check`（101 文件）✓ · 前端 **171 例**（13 文件）✓ · `build` ✓。

### 6.7 体验功能批（同日，路线图阶段二收尾）

阶段二最后一行「新增」落地，共 4 项：

| 功能 | 处理 |
| --- | --- |
| 会话掉线 / 重连 Toast | `utils/sessionStatusToast.ts` 纯函数判定状态转变（12 例单测）：进入重连 → warning、重连成功 → success、意外断开 → error；用户主动断开（closing → closed）与常规连接成功保持安静。开启自动重连的会话断开时不再报错，避免与随后的重连警告双响。页面不可见时联动系统通知。文案走 i18n，`{n}` 占位做重连次数插值 |
| 快捷键速查面板 | `Ctrl+/` 打开（再按关闭）。数据在 `utils/shortcuts.ts` 与实际按键行为同步维护，`shortcuts.test.ts` 守护关键键位不丢（Ctrl+K///T/F/Tab/W/1…9 等） |
| 命令面板 | `Ctrl+K` 打开：视图跳转、新建会话、快捷键速查、主机直连、会话标签切换。过滤为大小写不敏感子串匹配（label + keywords，纯函数 5 例单测）；↑↓ 选择、Enter 执行、Escape 关闭，aria-combobox 标注 |
| 会话恢复 | 标签轮廓（hostId + 名称，**绝不落凭据**）经 `session-restore.json` 持久化；`useSessions.subscribe` 在 store 层单向跟踪变化，避免循环依赖。会话页空态提供「恢复上次会话（N）」入口：保险箱锁定时先请求解锁，`planSessionRestore` 纯函数（10 例单测）判定可恢复性——主机配置被删 / 凭据缺失的会话跳过并分类提示，不在恢复路径弹密码框 |

**顺手收敛**：主机快速连接抽成 `store/hostConnect.ts` 的 `connectHostQuick`，主机列表与命令面板共用同一条「解锁保险箱 → 取凭据 → `buildRequestFromProfile` → 直连」链路；`HostsView.reconnect` 由 26 行缩到 10 行。`open()` 增加 `hostId` 参数（`hostIds` 关联会话与主机配置），这是会话恢复定位凭据的依据。新增图标 clock / command / keyboard。

**验证**：`tsc -b` ✓ · `eslint .` ✓ · `i18n:check` ✓ · `i18n:audit`（仅审计 detail 类提示，属约定内不翻译项）✓ · `mojibake:check`（114 文件）✓ · 前端 **201 例**（17 文件，新增 sessionStatusToast / shortcuts / commandPalette / sessionRestore 四组）✓ · `build` ✓。

**待真机确认**：命令面板与快捷键面板的焦点陷阱在玻璃主题下的观感；会话恢复在保险箱未配置时的引导是否顺畅；掉线 Toast 与既有重连状态标签的信息是否重复。

### 6.8 批量命令执行聚合（同日，阶段三第一项）

路线图阶段三「多跳 ProxyJump、批量命令执行聚合」拆分：聚合部分落地，ProxyJump（链式多跳）另行排期。

**Rust**（`ssh_manager/batch.rs` + `lib.rs`）：
- 新命令 `ssh_batch_exec(sessionIds, command, timeoutSecs)`：在每个目标会话的专用通道上执行同一条命令（通道协商沿用 P2-2 的锁外模式，不阻塞终端输入），`tokio::spawn` 并发推进、逐台聚合输出与耗时。
- 防护：命令 trim 非空且 ≤4096 字节；目标去重保持顺序、上限 32；超时夹取 `[1,120]` 秒；单台输出截断 64KB 并标记 `truncated`；单台失败（含任务 panic）归一为该条 `error`，不影响其余目标。
- `exec_command` 增加 `timeout` 参数（监控类调用点统一走 `EXEC_COMMAND_TIMEOUT` 常量）。

**前端**（`utils/batchExec.ts` + `BulkCommandDialog` 升级）：
- 批量命令弹窗新增模式切换：「写入终端」（原交互式行为保留）与「执行并聚合输出」（专用通道执行、逐台展示状态/耗时/输出/截断标记）。
- 纯函数 `normalizeBatchCommand` / `normalizeBatchTargets` / `parseBatchTimeout` / `summarizeBatchResults`（12 例单测），上限与夹取区间与 Rust 常量对齐。
- 审计 `command.batch-exec`（target 为 `成功/总数`，detail 记命令原文）；执行前 confirmDialog 二次确认。

**测试**：集成测试服务器新增 `exec_request` handler（回显命令行并正常退出），新增 `batch_exec_e2e.rs` 2 例（多会话聚合 + 失败隔离、入参校验）。

**验证**：`cargo fmt` ✓ · `cargo clippy --all-targets -- -D warnings` ✓ · `cargo test` **44 例**（32 单测 + 12 集成）✓ · `tsc -b` ✓ · `eslint .` ✓ · `i18n:check` ✓ · `mojibake:check`（116 文件）✓ · 前端 **213 例**（18 文件）✓ · `build` ✓。

**回归项**：多个已连接会话（含一台故意断开的）执行批量命令，确认失败台仅标失败、其余正常出输出；输出超过 64KB 的命令确认截断提示。

### 6.9 会话录制与回放（同日，阶段三第二项）

会话工具栏新增录制开关（录制中脉冲指示）与「录制库」入口：开启后采集当前会话输出，停止时合成 asciicast v2（asciinema）文件落盘；录制库支持浏览、回放与删除。

**架构：前端采集 + Rust 落盘**（输出天然汇聚在 `store/sessions.ts`，不在 Rust 输出路径插桩）：
- `store/recording.ts`：按会话维护录制缓冲，`TextDecoder('utf-8', {stream: true})` 保证跨块多字节字符不碎，记录毫秒偏移与文本；停止时交给 `buildAsciicast` 合成 JSONL。
- `utils/asciicast.ts` 纯函数：`buildAsciicast` / `parseAsciicast`（坏行归 warnings、version≠2 时 header 置 null）/ `asciicastDuration` / `playbackTimeline`，8 例单测。
- `recording_store.rs` + `lib.rs` 四命令（`recording_save / list / read / delete`，读写走 `spawn_blocking`）：文件名清洗（保留字母数字 / CJK / `_ - .`，截断 80 字符）、读取与删除侧防路径穿越校验、单文件 64MB 上限、同名覆盖、mtime 倒序列表。

**回放**（`RecordingPlayerDialog`）：只读 xterm 按时间轴逐事件写入，播放 / 暂停、1×/2×/4× 倍速、进度条拖动（拖动即暂停并从该时刻全量重放）、时钟显示；配色复用主终端主题，观感一致。

**其它**：终端主题常量从 `TerminalPane` 抽到 `views/sessions/terminalTheme.ts` 供录制回放共享；审计 `session.record-start / record-stop`；录制相关文案补齐 `en` 字典。

**验证**：`cargo fmt` ✓ · `cargo clippy --all-targets -- -D warnings` ✓ · `cargo test` **48 例**（36 单测 + 12 集成，`recording_store` 新增 4 例）✓ · `tsc -b` ✓ · `eslint .` ✓ · `i18n:check` ✓ · `mojibake:check`（154 文件）✓ · 前端 **221 例**（19 文件，新增 asciicast 组）✓ · `build` ✓。

**回归项**：连接会话 → 开启录制 → 执行几条命令 → 停止并在录制库回放（倍速、拖动进度、CJK 文件名）；亮暗主题下回放观感；录制中直接断开会话的行为。

### 6.10 多跳 ProxyJump（同日，阶段三第三项）

跳板机从单级升级为链式（`ProxyJump a,b,c` 等价能力）：连接时按顺序逐级「连上跳板 → 认证 → 在其上开直达下一目标的 direct-tcpip 隧道」，最后一跳的隧道终点才是目标服务器；每一跳独立做主机指纹确认、凭据各自独立。

**Rust**（`ssh_manager/types.rs` + `mod.rs`）：
- `ProxyConfig` 增加 `next: Option<Box<ProxyConfig>>` 链式字段（serde 缺省 `None`，旧主机数据零迁移）；`collect_chain()` 按连接顺序收集整条链。
- 连接逻辑迭代化：首跳走 TCP 直连，后续跳经由前一级隧道 `connect_stream`，返回 `Vec<Handle>`（`proxy_conn` 改为 `Mutex<Vec<_>>`）持有整条链的会话句柄，任何一级被 drop 都会掐断链路。错误信息带跳板序号与地址，便于定位断在哪一级。
- `Drop` 对链递归零化每级口令；`redacted_summary` 不变（仍只描述链头）。

**前端**（`types/session.ts` + `views/hosts/*`）：
- `ProxyConfigInput` / `HostProxyProfile` 增加 `next`；`buildProxyConfig` 递归归一化整条链，`MAX_PROXY_HOPS = 4` 封顶、超限截尾；`collectProxyHops` 泛型收集。
- 连接表单：第 1 跳沿用平铺字段（兼容旧 UI/数据），第 2 跳起编辑 `proxyNextHops` 数组，「添加下一跳 / 移除末跳」按钮；逐跳校验，错误定位到字段。主机档案持久化整条链（不含凭据）。
- 凭据保险箱：第 1 跳沿用 `proxy:<hostId>`，第 2 跳起 `proxy:<hostId>:<index>`，连接与保存两条路径同规则。

**测试**：`jump_e2e.rs` 3 例（两级链 / 单级回归 / 三级链），测试服务器增加 direct-tcpip 隧道计数器，用「每跳各开出一条隧道、目标零隧道」证明流量真穿链而非直连；Rust 单测新增 `collect_chain` 顺序与 camelCase 链式反序列化 2 例；前端 `connectForm` 组补链式校验 / 持久化 / 重建用例。

**验证**：`cargo fmt` ✓ · `cargo clippy --all-targets -- -D warnings` ✓ · `cargo test` **53 例**（38 单测 + 15 集成）✓ · `tsc -b` ✓ · `eslint .` ✓ · `i18n:check` ✓ · `mojibake:check` ✓ · 前端 **226 例**（19 文件）✓ · `build` ✓。

**回归项**：单级跳板老配置直连主机一键重连；两级 / 三级跳板链连接（每跳指纹逐个确认）；中间某跳密码输错时的报错信息；跳板链主机的「编辑并连接」回填与凭据解锁。

### 6.11 磁盘级传输带宽限速（同日，阶段三第四项切片）

磁盘级 SFTP 传输（大文件直传）增加带宽限速：开始传输与运行中均可限制速率，传输列表行内下拉随时切换（不限速 / 256 KB/s / 1 / 4 / 16 / 64 MB/s），无需重建传输。

**实现**（`ssh_manager/sftp.rs` + `lib.rs` + 前端 `SftpTransferList`）：
- `SftpDiskTransfer` 增加 `speed_limit_bps: AtomicU64`；`pace_transfer` 以「本次传输会话内已传字节 / 限速」自校准等待（分片 ≤100 ms，每片醒来检查取消标记，取消响应性不受影响）。按会话字节而非总量计速，断点续传的起始偏移不会被「预付」，恢复后立即按当前限速推进。
- `sftp_disk_download_pick` / `sftp_disk_upload_start_token` 增加 `speedLimitKBs` 参数（缺省 0 = 不限）；新命令 `sftp_disk_transfer_set_limit` 运行中动态调整；限速值上限 1 GB/s（`normalize_speed_limit_kbs` 截断）。
- 进度事件与 `sftp_disk_transfer_list` 携带 `speedLimitKBs`，前端传输行显示当前限速并可直接改档。

**测试**：Rust 新增 4 例（限速归一化、不限速立即返回、超速节流、低速不等待）。

**验证**：`cargo fmt` ✓ · `cargo clippy --all-targets -- -D warnings` ✓ · `cargo test` **57 例**（42 单测 + 15 集成）✓ · `tsc -b` ✓ · `eslint .` ✓ · `i18n:check` ✓ · `mojibake:check` ✓ · 前端 226 例 ✓ · `build` ✓。

**回归项**：大文件下载选 256 KB/s 后速率贴近上限；传输中途切到「不限速」立即提速；限速生效时取消传输仍即时响应；限速传输中途断开后的断点续传。

---

### 6.12 SFTP 目录同步（同日，阶段三第五项切片）

SFTP 面板新增「目录同步（单向）」：把本地目录与远程目录按差异清单对齐（上传：本地 → 远程，或下载：远程 → 本地）。三段式流程——选方向与本地目录 → 扫描两侧目录树生成差异预览（新增 / 更新 / 跳过与总字节）→ 确认后后台逐文件执行。

**实现**（`ssh_manager/sync.rs` 新模块 + `lib.rs` 4 命令 + 前端 `SftpSyncDialog`）：
- 差异规则（不取哈希）：目标缺失 → 新增；大小不同 → 更新；大小相同且源 mtime 更新 → 更新；其余跳过。目录条目按字典序天然先于子内容，父目录先建。
- 执行单文件粒度串行，256 KB 分块流式读写，单文件失败进入逐文件错误清单（末 20 条随进度事件上报），失败隔离不影响其余；按会话登记取消句柄，同会话同时只允许一个同步任务；进度事件 `sftp-sync-progress`（schema 版本校验）节流 300 ms。
- 前端回传的相对路径经 `validate_relative_path` 严格校验（拒绝绝对路径、反斜杠、`..` 上跳、空段），入口路径不可被污染。
- 第一版**刻意不做镜像删除**：「删除目标侧多余文件」属高危操作，弹窗内明示「只新增和更新，绝不删除」，待单独评审再立项。
- 测试服务器内存文件系统补齐 `mtime` 保真（写入 / 截断时记录真实时间），否则 mtime 比较规则无法端到端验证。
- 审计 `sftp.sync`（方向 + 文件数 / 失败数）；SFTP 工具栏新增同步入口。

**测试**：Rust 新增 6 例——单测（相对路径校验、远程路径拼接、差异动作全表、类型冲突隔离）+ `sync_e2e.rs` 2 例（上传整树含子目录、下载种子文件，含重复同步全跳过断言）。

**回归项**：上传含子目录的本地树后远端内容与结构一致；内容未变时重复同步零传输；下载方向落地文件内容一致；同步中途取消后已传文件保留、无半成品残留（同步写目标路径，不走 `.catshell-part`）；错误路径（目录不可读、类型冲突）在错误清单可见且任务正常收尾。

### 6.13 传输队列持久化（同日，阶段三第六项切片）

应用重启后，未完成的磁盘级 SFTP 传输不再「消失」：队列持久化到 `transfer-queue.json`，重新连接同一主机后可在 SFTP 面板顶部续传条里逐条或一键续传，复用 `.catshell-part` 断点。

**实现**（`lib.rs` 2 命令 + `store/transferQueue.ts` + `SftpQueueResume`）：
- 只持久化**磁盘级**传输（有断点可续）；分块传输是会话内小文件体验，重启后重传成本可忽略，不入队。记录项仅含 hostId、方向、两侧路径与进度——**绝不落凭据**。
- `SftpDiskTransferStart` 回传 `local_path`：令牌/对话框流程中本地路径本就留在 Rust 侧，这里仅为构建队列而披露；上传令牌的一次性安全边界不变。
- 新命令 `sftp_disk_download_start_path` / `sftp_disk_upload_start_path`：不经对话框、以队列记录的显式路径启动传输，恒为断点续传模式，路径过 `validate_local_path` + 存在性校验。
- 纯函数层 `utils/transferQueue.ts`：队列键（hostId+方向+两侧路径）去重、进度更新、终态分流（完成/取消移出队列，**失败保留**——断点仍在）、按主机过滤、脏数据形状校验、主机档案已删的孤儿条目启动时静默清理（等 hosts 初始化最多 5 秒防竞态误删）。
- 持久化走 plugin-store + localStorage 兜底（对齐 session-restore 模式）；进度 3 秒节流批量落盘，登记/终态立即写。
- transferId ↔ 队列键在运行时绑定（模块级 Map），进度/终态事件据此入队，未绑定的传输自动忽略。

**测试**：前端新增 11 例（队列键、登记去重置顶、进度更新、终态分流、主机过滤排序、孤儿清理、形状校验与 transferred 收敛）。Rust 侧为薄命令包装，复用既有校验与续传测试。

### 6.14 SSH 密钥管理 UI + config 写回（同日，阶段三第七项切片）

设置 → 安全页新增「SSH 密钥管理」面板（`KeypairPanel`）：生成密钥对、浏览 `~/.ssh`、复制公钥、删除密钥对，并把主机档案写回 `~/.ssh/config`。

**实现**（`ssh_manager/keys.rs` + `config.rs` 写回 + lib.rs 5 命令 `keypair_generate/list/delete/public_key`、`ssh_config_write`）：
- **密钥生成**：复用 russh 0.63 内置的 `russh::keys::ssh_key`（钉死 `ssh-key =0.7.0-rc.11`），零新增重量级依赖；Ed25519 默认、RSA 4096 可选；口令可选加密（`rand::rng()` 作随机源）。生成走 `spawn_blocking`，私钥落盘权限 0600。
- **列举**：扫 `~/.ssh` 全文件，区分「私钥（标注算法 / 加密状态 / 指纹）/ 公钥 / 其它文件（如 config、known_hosts）」，同组私钥+公钥归并展示。
- **删除防护**：仅允许删除位于 `~/.ssh` 内**且内容能被识别为私钥**的文件（config / known_hosts 一律拒绝），`.pub` 一并删除。
- **SSH config 写回**：把勾选的主机档案 upsert 为 Host 块（地址、端口、用户名、私钥路径，**不含密码**）；已存在的同名 Host 块原位替换，其余内容保持原样；写入前备份 `config.catshell-bak`，经 `.catshell-tmp` 临时文件原子替换。前端展示「将替换 / 将追加」计划预览再确认。
- 路径来源尊重用户选择（保存对话框 / 手输），Rust 侧限定 `~/.ssh` 边界；审计记录 `keys.*` / `ssh.config-write`。

**回归项**：Ed25519 + 口令生成后可用口令解密、指纹可复算；删除拒绝 config 与 `~/.ssh` 外路径；config 写回保留无关块与 Match 块、重复写回幂等、备份文件生成。

### 6.15 类型自动生成：ts-rs 绑定管道（同日，阶段三第八项切片）

Rust DTO 与前端 `src/types/*.ts` 手写类型长期靠人肉同步，漂移只能靠运行时炸出来。本切片引入 [ts-rs](https://github.com/Aleph-Alpha/ts-rs) 生成管道，建立**机器维护的对照源**。

**实现**（依赖 `ts-rs 10.1`，仅 derive 编译期，运行时零开销）：
- 跨 IPC 的 **24 个 DTO** 全部 `#[derive(TS)]` + `#[ts(export)]`：`types.rs` 9 个、`sftp.rs` 6 个、`sync.rs` 4 个、`batch.rs` / `config.rs` / `keys.rs` / `recording_store.rs` 各 1–2 个。
- 导出目录经 `src-tauri/.cargo/config.toml` 的 `TS_RS_EXPORT_DIR` 注入，落到 `src/types/bindings/`（带 README 说明用途与边界）；`cargo test export_bindings` 一键再生成。
- **64 位整数一律 `#[ts(type = "number")]`**：ts-rs 默认把 `u64` / `i64` 映射为 `bigint`，但 Tauri IPC 走 JSON，前端实际拿到 `number`——已全局修正并在守卫测试里防回归。
- **三层防漂移**：
  1. `npm run bindings:check`（cargo test 导出 + `git diff --exit-code`），Rust DTO 改动未同步时直接红；
  2. CI 的 Rust job 在 `cargo test` 后同样跑 diff 守卫；
  3. 前端 `bindings.test.ts` 3 例：关键绑定文件存在且含导出、绑定中不得出现 `bigint`、文件仍带生成头（防手改）。
- **刻意不导出**：`ConnectRequest` / `ProxyConfig`（递归 + 明文凭据，安全约定不实现 Serialize；前端 `host.ts` 已有稳定镜像）；内部状态类型（`SyncJob` / `SftpDiskTransfer` 等，不过 IPC）；事件 payload（`mod.rs` 内以 `json!` 内联构造，未结构化，属后续工作）。

**边界说明**：手写 TS 类型仍是应用公共 API——它们含窄化联合（`status: SessionStatus`、`direction: 'local' | 'remote' | 'dynamic'`），Rust 侧是 `String`，ts-rs 无法表达。绑定作对照源使用：改 Rust DTO 后 `bindings:check` 的 diff 即为前端同步要求。前端直接消费绑定（去掉手写镜像）属后续演进。

**测试**：前端 +3（守卫测试），Rust +24（ts-rs 导出用例）；其余验证全绿。

### 6.16 命令行启动参数 + 托盘快捷连接（同日，阶段三第九项切片）

**命令行启动参数**（`ssh_manager` 之外的应用级 `launch.rs`，lib.rs 2 命令 `cli_launch_request`、`tray_set_quick_connects`，命令数 58→60）：
- `catshell user@host[:port]`：解析为临时目标，前端打开连接对话框预填（凭据用户自填，Rust 不经手）；
- `catshell <档案名>`（或 `--profile <名>` / `--connect <名>`）：按档案名直连——大小写不敏感匹配，命中即走 `connectHostQuick` 共用链路（保险箱锁定/凭据不足时回退主机页表单），未命中提示后打开主机页；
- 解析是纯函数（6 单测覆盖 user@host / host:port / 非法端口段 / flag 缺值等），规则：含 `@` 即临时目标、`--profile` 优先、其余 `-` 开关（Tauri 内部 flag）忽略；
- **送达路径**：首启动存入 `CliState` 由前端 `cli_launch_request` 取用；第二实例经 `single_instance` 回调解析后以 `cli-connect` 事件（带协议版本 `v`）转发主窗口。

**托盘快捷连接**：右键托盘菜单新增「快捷连接」子菜单——前端在主机档案变化时把清单（最多 15 条、按最近更新排序）经 `tray_set_quick_connects` 推给 Rust 重建菜单；点击菜单项 Rust 发 `tray-quick-connect` 事件（payload 含档案 id），前端按 id 直连，与命令面板同一条链路。空清单显示禁用占位项。

**边界**：连接动作完全在前端完成（凭据只在保险箱/内存）；临时目标不落盘、不进审计凭据字段；`--profile` 不存在时明确提示而不是静默失败。

**测试**：Rust +6（launch 解析），前端 +6（意图规范化 / 档案名匹配 / 临时目标合成）；验证全绿（Rust 101 / 前端 255 / fmt / clippy -D warnings / tsc / eslint / i18n / mojibake / build）。

---

## 七、建议路线图

### 阶段一 · 止血（v0.2）
> 目标：让已宣传的功能真正可用，堵住正确性与安全缺口

- [x] **P0-1** 修复 `release.yml`，上传安装包与 `.sig` 到 Release
- [x] **P1-1** 修复重连双重自增 bug + 补重连测试
- [x] **P1-6** 补齐 `en` 字典 `nav.*` / `status.*` + CI 覆盖校验脚本（脚本位于 `scripts/check-i18n.mjs`，已接入 CI；收尾时另补 43 条间接引用的缺口，并提供 `scripts/audit-untranslated.mjs` 复查常量表等间接引用）
- [x] **P1-8** `Ctrl+W` 改为仅关标签，`Ctrl+Shift+W` 才断开
- [x] **P1-4** 凭证 `zeroize` + 去 `Debug`/`Serialize`
- [x] **P1-5** 引入 `tracing`（严格过滤敏感字段）
- [x] **P1-13** 取消 `AGENTS.md` 的 gitignore 并提交 —— **改判**：经项目方确认，`AGENTS.md` 属本地 agent 配置，继续留在 `.gitignore`，不提交
- [x] **P1-14** 补 `SECURITY.md` / `CHANGELOG.md` / `rustfmt.toml` + CI 漏洞扫描
- [x] **文档** 修正第六节 P1 级文档差异

### 阶段二 · 体验跃升（v0.3）
> 目标：用户能明确感知到的流畅度与易用性提升

- [x] **P1-3** PTY 输出聚合，消除事件风暴
- [x] **P1-9** 终端实例按需挂载
- [x] **P1-2** SFTP 传输 GC / 空闲超时
- [x] **P1-7** 抽取 `buildConnectRequest` 纯函数 + 单测
- [x] **P1-10 / P1-11** 公共 `<Modal>` 组件 + 巨型组件拆分
- [x] **P2-14** 前端分包 + 按视图懒加载（首屏 JS 从 915 KB / gzip 256 KB 降到约 296 KB / gzip 96 KB）
- [x] **新增**：会话恢复（空态一键恢复上次标签）、快捷键速查面板（`Ctrl+/`）、命令面板（`Ctrl+K`）、会话掉线 / 重连 Toast（详见 6.7）
- [x] **P1-12** 补齐 SFTP / 转发 / 指纹变更测试（前端纯函数层 141 例，收尾补齐错误码映射后共 155 例；新增 SFTP 全链路 3 例、端口转发 2 例、指纹变更拒绝 1 例。远程转发、SOCKS5 端到端与并发场景仍待补）

### 阶段三 · 能力扩展（v0.4+）
> 目标：从"好用的 SSH 客户端"走向"运维工作台"

- [x] 多跳 ProxyJump（详见 6.10：`ProxyConfig` 链式 `next` 字段，逐级 direct-tcpip 隧道，每跳独立指纹确认与凭据；表单支持增删跳，上限 4 级）
- [x] 批量命令执行聚合（详见 6.8：`ssh_batch_exec` 专用通道执行 + 逐台输出聚合，原有「写入终端」模式保留）
- [x] 会话录制与回放（详见 6.9：前端采集输出 + Rust 落盘 asciicast v2，录制库支持倍速回放与进度拖动）
- [x] 磁盘级传输带宽限速（详见 6.11：自校准 pace，开始时或运行中随时调档，取消响应不受限速影响）
- [x] SFTP 目录同步（单向 mirror，详见 6.12：差异预览确认 + 逐文件失败隔离执行；不做镜像删除）
- [x] 传输队列持久化（详见 6.13：磁盘级传输断点进度落盘，重启后按主机续传；分块传输保持会话内体验）
- [x] 密钥管理 UI、SSH config 写回（详见 6.14：russh 内置 ssh_key 生成、~/.ssh 边界删除防护、Host 块原子写回 + 备份）
- [x] 类型自动生成（`ts-rs`，详见 6.15：24 个 IPC DTO 生成绑定 + bindings:check / CI / vitest 三层防漂移；事件 payload 结构化与前端直连绑定属后续）
- [x] 命令行启动参数、托盘快捷连接（详见 6.16：`catshell user@host[:port]` / 档案名直连 + 托盘子菜单 15 条直连）
- [ ] AI 辅助（命令生成、日志诊断、风险提示）

---

## 八、复现与验证方式

```powershell
# 前端：类型检查 + lint + i18n 校验 + 乱码校验 + 测试 + 构建
npx tsc --noEmit
npm run lint
npm run i18n:check
npm run mojibake:check
npm run test
npm run build

# 后端（在 src-tauri 目录）
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo check
cargo test

# 桌面端手动验证（涉及 invoke / Store / 插件 / Rust command 的改动必须走这条）
npm run tauri dev
```

**重点回归项**：
1. 英文界面下检查侧边栏导航与会话状态文案（验证 P1-6）
2. 连接建立后手动断网，观察重连次数与退避节奏（验证 P1-1）
3. 会话中执行 `cat /var/log/syslog` 或大文件输出，观察界面是否卡顿（验证 P1-3）
4. 开 20+ 会话后观察内存占用（验证 P1-9）
5. 会话页按 `Ctrl+W`，确认是否直接断连（验证 P1-8）
6. 断点续传过程中替换远端文件，观察是否续到错误偏移（验证 P2-8：现应在指纹不符时从 0 重传）
7. 进入含数千项的 SFTP 目录，滚动到底部确认行高与滚动条长度正常（验证 P2-19 窗口化）
8. 生产构建（`npm run tauri build` 或 `tauri dev --release` 的 dist 产物）启动后确认不白屏，且首帧主题仍按系统外观生效（验证 P2-10）
9. 停止一条已建立连接的本地端口转发，确认在飞连接被立即断开（验证 P2-6）
10. 断开会话的网络（或重启远端 sshd），观察是否出现「正在自动重连」Toast、重连成功后出现成功提示；窗口最小化到托盘时重复一次，确认收到系统通知（验证会话状态通知）
11. 打开若干会话后完全退出应用再启动，在会话页空态点「恢复上次会话」，观察标签重建、保险箱解锁引导与凭据缺失会话的跳过提示（验证会话恢复）
12. `Ctrl+K` 打开命令面板搜索主机 / 会话 / 视图并执行，`Ctrl+/` 打开快捷键速查；两者再按一次应关闭（验证命令面板与快捷键速查）

---

*本报告基于 commit `a559a0f`（main）的只读审计生成，未修改任何源码文件。*
