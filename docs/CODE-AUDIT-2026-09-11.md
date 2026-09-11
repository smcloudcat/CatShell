# CatShell 深度代码审计报告

- **审计日期**：2026-09-11
- **基线**：提交 `47a9fb7`（阶段三全部功能入库后）
- **审计范围**：`src-tauri/src/` 全部 14 个 Rust 文件、`src/` 前端全量（不含 `src/types/bindings` 生成物）、`tauri.conf.json` CSP、CI 工作流
- **方法**：逐文件人工审读 + 模式化扫描（panic 路径 / 锁跨 await / 资源清理 / 错误吞掉 / 注入面 / 虚拟化覆盖），高优发现均经二次源码核验
- **严重度定义**：P0 可被利用的安全漏洞；P1 数据丢失/功能性缺陷/明显资源风险；P2 特定条件触发的缺陷；P3 卫生问题与一致性缺口

## 修复进度（2026-09-11 同日修复）

除下述两项外全部修复完毕，验证全绿（前端 lint / i18n / mojibake / bindings / 274 测试 / build；Rust fmt / clippy / 101 测试）：

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| S-1 ✅ | 已修复 | `sftp_read_file` 先 `metadata` 校验 size 再读；e2e 断言同步放宽新旧两种文案 |
| S-2 ✅ | 已修复 | apiKey 迁入系统凭据管理器（keyring 3 + windows-native），新增 `ai_key_save` / `ai_key_load`（命令 61→63）；持久化文件与 localStorage 一律写空串，启动时回填内存；旧版明文自动迁移并重写抹除 |
| S-3 ✅ | 已修复 | `ai_complete` 拒绝非 https 端点 |
| S-4 ✅ | 已修复 | `isSafeBackgroundImage` 移至 `types/theme.ts` 导出，主加载路径复用校验 |
| S-5 ✅ | 已修复 | `sftp_list` 补 `validate_sftp_path` |
| B-1 ✅ | 已修复 | `loadDirectory` 请求序号 + 卸载守卫 |
| B-2 ✅ | 已修复 | `sftp_sync_start` 开通道失败回滚 `sync_jobs` 占坑条目 |
| B-3 ✅ | 已修复 | 上传收尾仅确认目标存在才删旧重试；删旧失败/重试失败均有明确报错与半成品提示 |
| B-4 ✅ | 已修复 | `cancel_transfers_for_session` 扩展取消 sync job；`run_session` 收尾补调 |
| B-5 ✅ | 已修复 | 上传前查重失败改为中止上传（不再退化空目录） |
| B-6 ✅ | 已修复 | 回放倍速改 `speedRef`，播放中切换即时生效 |
| B-7 ✅ | 已修复 | 关闭标签 / Ctrl+W 路径补 catch + toast |
| B-8 ✅ | 已修复 | 本地目录扫描移入 `spawn_blocking`（`scan_local_dir_blocking`） |
| B-9 ✅ | 已修复 | `sum_transfer_bytes` 用 `checked_add` 防溢出（plan 与 start 两处） |
| P-1 ✅ | 已修复 | `playbackTimeline` 接 `useMemo` |
| P-2 ✅ | 已修复 | seek 分批写入（2000 条/批）+ 代次守卫 + 60ms 合并节流 |
| P-3 ✅ | 已修复 | 进程列表接入 `useVirtualWindow`（>50 行启用） |
| P-4 ✅ | 已修复 | `reconnect` 清理旧会话日志缓冲 |
| P-5 ✅ | 已修复 | 输出 Channel id 回填前缓冲、回填后 flush，banner/MOTD 不再丢失 |
| P-6 ⏭ | 暂缓 | P3：零散小文件阻塞 IO 与现有 spawn_blocking 口径不一致；单次量小，择机统一 |
| P-7 ✅ | 已修复 | `visibleEntries` useMemo；`onFinished` 引用稳定化；`lastRate` 写入移入 effect |
| R-1 ✅ | 已修复 | ProxyJump `expect` 改 `ok_or_else` 正常错误路径 |
| R-2 ⏭ | 暂缓 | P3 且泄漏有界（连接数×存活时长）：修复需改 handler 结构与 forward.rs 取消机制，投入产出比低，择机处理 |
| R-3 ✅ | 已修复 | 终端输出 IPC 丢弃计数 + 周期性 warn（`dropped_outputs`） |
| R-4 ✅ | 已修复 | `validate_relative_path` 加括号，空段一律拒绝 |
| R-5 ✅ | 已修复 | AI 设置 localStorage 兜底补读回 |
| R-6 ✅ | 已修复 | 编辑器读取与解码分开捕获 |
| R-7 ✅ | 已修复 | 取消/限速失败 toast、批量下发失败明细、三处 `connectHostQuick` catch、快捷键 effect 补 `t` 依赖 |

## 结论摘要

| 严重度 | 数量 | 代表问题 |
| --- | --- | --- |
| P0 | 0 | — |
| P1 | 4 | `sftp_read_file` 先读后检内存上限；AI apiKey 明文落盘；SFTP 目录加载竞态；sync_jobs 条目泄漏 |
| P2 | 9 | 上传收尾删旧重试数据丢失；会话关闭不取消同步任务；回放倍速闭包失效等 |
| P3 | 16 | 校验口径不一致、阻塞 IO、卸载后 setState 等 |

整体评价：**代码质量高于同类项目平均水位**。凭据加密体系（PBKDF2 600k + AES-GCM）、主机导入信任边界（强制清空凭据）、命令注入防护（monitor.rs 字符集白名单 + `--` 防选项注入）、CSP（生产 `script-src 'self'`）、Tauri 事件订阅清理模式均规范；XSS 面干净（无 dangerouslySetInnerHTML，远端字节只写 xterm）。主要短板集中在：**SFTP 链路的边界条件、录制回放组件的闭包陈旧、async 上下文中的同步阻塞 IO、以及若干 `void promise` 吞错路径**。

---

## 一、安全（Security）

### S-1【P1】`sftp_read_file` 先全量读入内存、后校验 64 MB 上限（内存炸弹）
- **位置**：`src-tauri/src/ssh_manager/sftp.rs:540-552`（上限检查配合 `lib.rs:241-248`）
- **问题**：`sftp.read(path)` 先把远端文件**完整读进内存**，之后才 `data.len() > MAX_SFTP_FILE_SIZE` 判超限。64 MB 上限形同虚设：误点 10 GB 文件（或远端被入侵后伪造巨型文件）时，russh_sftp 持续分配直到 OOM；随后 `lib.rs:247` 还要做 base64 编码，峰值内存约为文件体积的 2.3 倍。
- **修复**：读之前先 `sftp.metadata(&path)` 校验 `size`（参照 `recording_store.rs:122-126` 的正确做法：先 metadata 后读）。

### S-2【P1】AI 接口密钥明文持久化
- **位置**：`src/store/settings.ts:55-63`（字段定义，注释自认「明文存本机」）、`177-186`（`saveAi` 落盘 Tauri store + localStorage 兜底）
- **问题**：SSH 凭据有完整加密保险箱体系（PBKDF2 600k + AES-GCM），AI `apiKey` 却明文写 `app-settings.json` 与 localStorage。任何能读用户配置目录的进程/备份/同步盘都能拿到密钥。属「双标设计」，代码注释写明有意为之，仍应列为审计项。
- **修复**：接入系统 keyring（Rust 侧 `keyring` crate），或把 apiKey 纳入保险箱；至少在导出/备份时显式排除。

### S-3【P2】`ai_complete` 端点无 scheme 校验，密钥可能经明文 HTTP 外发
- **位置**：`src-tauri/src/lib.rs:693-727`
- **问题**：endpoint 仅 trim 后拼 `/chat/completions`，不校验必须是 `https://`。用户误填 `http://` 地址时，Bearer 密钥明文上网。密钥本身不进日志/审计（已核实，错误串不含 key），但传输面无守卫。
- **修复**：校验 endpoint 必须以 `https://` 开头（或对 http 显式弹警告确认）。

### S-4【P2】背景图 CSS 注入校验只在备份导入路径生效，主加载路径不校验
- **位置**：`src/App.tsx:441-443`（拼 `url("...")`）；对照 `src/views/settings/BackupPanel.tsx:27-29`（`isSafeBackgroundImage` 已存在）
- **问题**：备份还原路径严格校验 `backgroundImage` 不含 `"`、`(`、`;` 等逃逸字符，但应用启动时从 app-settings.json 读入的值**未经校验**直接拼进 CSS 自定义属性。本地文件被篡改的威胁模型下属低危，但校验器已有却未复用，属防御纵深一致性缺口。
- **修复**：`settings.init` 加载主题时调用 `isSafeBackgroundImage`，不通过则回落默认。

### S-5【P3】`sftp_list` 漏做 `validate_sftp_path` 校验，口径不一致
- **位置**：`src-tauri/src/ssh_manager/sftp.rs:493-498`
- **问题**：其余 SFTP 方法（read/write/remove/mkdir/rename/chmod）都先过 `validate_sftp_path`（拒 `\0`、超长路径），唯独 list 只做 trim+空串兜底。风险低（远端会报错），但属校验口径不一致。
- **修复**：补一行校验即可。

---

## 二、Bug（正确性缺陷）

### B-1【P1】SFTP 目录浏览竞态：旧目录响应乱序覆盖新目录
- **位置**：`src/views/sessions/SessionSftpPanel.tsx:95-115`
- **问题**：`loadDirectory` 无请求序号/cancelled 保护，`setEntries` 与 `setPath` 采用「最后到达」的响应。高延迟链路上连续快速进入目录时，慢的旧响应后到会把列表**和路径**一起覆盖回旧目录；后续上传/新建都作用于错误路径，审计记录随之错乱。行操作按钮不受 `busy` 约束，该场景用户可稳定触发。
- **修复**：引入单调递增 requestId，仅响应 id 与最新一致时写状态。

### B-2【P1】`sync_jobs` 条目泄漏：开通道失败后该会话同步功能永久不可用
- **位置**：`src-tauri/src/ssh_manager/sync.rs:468-495`
- **问题**：`sftp_sync_start` 先 `insert(id, job)` 占坑（475 行），再 `open_sftp_channel(id).await?`（478 行）。`?` 提前返回时 job 条目**永不移除**（`run_sync_job` 未 spawn，收尾 remove 不会执行；cancel 只置位）。此后该会话再发起同步恒被「该会话已有同步任务在进行」拒绝，直到重启应用。
- **修复**：开通道失败时回滚 `sync_jobs.remove(&id)`；或先开通道成功再 insert。

### B-3【P2】磁盘上传收尾：先删远端旧目标再重试 rename，二次失败即数据丢失
- **位置**：`src-tauri/src/ssh_manager/sftp.rs:1227-1240`
- **问题**：上传完成 rename（`.catshell-part` → 目标名）失败时（典型：目标已存在且 SFTP 不允许覆盖），代码**无条件** `remove_file(旧目标)` 后重试 rename。若重试再失败（网络抖动/权限），结果=旧文件已删、新文件停在半成品名下，用户数据净损失。
- **修复**：仅当 rename 错误明确为「目标已存在」才删旧重试；重试失败时把半成品 rename 回原位，并在错误信息中说明旧文件已删除。

### B-4【P2】会话关闭的三条路径都不取消目录同步任务
- **位置**：`src-tauri/src/ssh_manager/mod.rs:1270-1280`（disconnect）、`1282-1289`（remove）、`1072-1076`（run_session 自然收尾）
- **问题**：disconnect/remove 只调 `stop_forwards_for_session` + `cancel_transfers_for_session`（后者只处理两类 SFTP 流式传输），不调 `sftp_sync_cancel`；run_session 收尾更是连 cancel_transfers 也不调。会话断开后 sync job 拿着已死的 SftpSession 把剩余条目逐个跑失败（上限 20 000 次），持续向已离开的会话 emit 进度事件。
- **修复**：`cancel_transfers_for_session` 扩为同时取消 sync_jobs；run_session 收尾补调。

### B-5【P2】上传前查重失败时静默跳过「覆盖确认」，可能未经同意覆盖远端文件
- **位置**：`src/views/sessions/SessionSftpPanel.tsx:143-149`（配合 151-175 覆盖确认逻辑）
- **问题**：上传前重新 `sftpList` 拉远端目录做同名检测，`catch { existingNames = new Set() }` 把失败吞掉按「空目录」处理，随后所有同名文件**不再弹确认**直接覆盖。一次网络抖动就可能静默覆盖远端文件。
- **修复**：列表拉取失败应中止本次上传并提示，而非当作空目录。

### B-6【P2】录制回放：播放中切换倍速不生效（闭包捕获旧 speed）
- **位置**：`src/views/sessions/RecordingPlayerDialog.tsx:106`、`130-136`
- **问题**：`changeSpeed` 里 `setSpeed(next)` 后立即调用的 `scheduleNext()` 来自旧渲染闭包，后续 setTimeout 递归也复用同一旧闭包——整个播放循环永远用旧 `speed` 计算 `waitMs`，播放中切 2×/4× 无效，必须暂停再播放。
- **修复**：`speed` 存入 ref（`speedRef.current`），`waitMs` 读 ref。

### B-7【P2】关闭标签 / Ctrl+W 的 disconnect/closeTab Promise 被静默丢弃
- **位置**：`src/views/sessions/SessionsView.tsx:112-118`；`src/App.tsx:297-312`
- **问题**：`closeTab` 内 `await sshRemove(id)`（store/sessions.ts:359）失败时整体 reject，调用方 `void closeTab(id)` 无人接住：unhandled rejection 且无 UI 提示，标签看似正常关闭但后端会话可能仍存活。
- **修复**：补 `.catch()` + toast。

### B-8【P2】`scan_local_dir` 在 async 上下文做同步阻塞的递归目录扫描
- **位置**：`src-tauri/src/ssh_manager/sync.rs:197-261`（调用点 375/393，外层是 Tauri async command）
- **问题**：`std::fs::read_dir` 递归遍历（上限 20 000 条），网络盘/慢盘上可阻塞 tokio worker 数秒到数分钟，期间同 worker 的所有 command（含终端输出 flush、心跳）停摆。
- **修复**：改 `tokio::fs::read_dir` 或 `spawn_blocking`。

### B-9【P2】同步计划 `total_bytes` 求和未防溢出，`entry.size` 完全信任前端
- **位置**：`src-tauri/src/ssh_manager/sync.rs:407-411`、`462-466`、`623`
- **问题**：`SyncPlanEntry.size` 从 IPC 反序列化的 u64 无上限校验；异常输入传 20 000 条 `u64::MAX` 时 `.sum()` debug 构建 panic（溢出）、release 静默回绕导致进度错乱。
- **修复**：`checked_add` 或单条 size 设上限（如 1 PB）。

---

## 三、性能（Performance）

### P-1【P2】录制回放 `playbackTimeline` 未 memo，每事件全量 filter+sort
- **位置**：`src/views/sessions/RecordingPlayerDialog.tsx:41-42`；`src/utils/asciicast.ts:138-142`
- **问题**：回放中每个事件 `setElapsedSec` 触发重渲染，都重执行一次对全部事件的 filter+sort（O(n log n)）。一小时高频录制可有数万事件，长录制回放明显卡顿。
- **修复**：`useMemo(() => playbackTimeline(doc.events), [doc])`。

### P-2【P2】回放 seek 对长录制同步全量重写，可阻塞 UI 数秒
- **位置**：`src/views/sessions/RecordingPlayerDialog.tsx:79-87`、`138-145`
- **问题**：拖动进度条到中后段同步 for 循环写入数万条事件，onChange 连续触发时叠加阻塞主线程。
- **修复**：分帧写入（`requestAnimationFrame`/`setTimeout` 分批）或加大节流。

### P-3【P3】监控面板进程列表未虚拟化
- **位置**：`src/views/sessions/SessionMonitorPanel.tsx:341-351`
- **问题**：繁忙服务器数百进程、每行含按钮/图标，全量平铺且随 `refreshKey` 整表重建。项目已有 `useVirtualWindow`（SFTP 列表已接入），此处未复用。

### P-4【P3】会话重连不清理旧会话输出日志缓冲（每次重连泄漏最多 2 MB）
- **位置**：`src/store/sessions.ts:298-341`（对比 `closeTab:360` 有清理）
- **问题**：`reconnect` 删旧 id 的各种映射但漏掉 `clearSessionLog(id)`，频繁重连场景内存持续累积到应用退出。
- **修复**：reconnect 内对旧 id 调 `clearSessionLog`。

### P-5【P3】SSH 输出 Channel 的 id 回填竞态：连接初期输出记到 id=0
- **位置**：`src/store/sessions.ts:132-143`、`263-272`
- **问题**：`Channel.onmessage` 可能在 `sshConnect` resolve 前投递，此窗口内字节 `appendSessionLog(0, ...)`——丢失会话开头 banner/MOTD，Map 里留 id=0 死数据。
- **修复**：id 回填前先在闭包内缓冲，回填后 flush。

### P-6【P3】异步命令中的小文件阻塞 IO（口径不一致）
- **位置**：`lib.rs:907-910`（`recording_list` 未走 spawn_blocking，同文件 save/read/delete 都走了）、`lib.rs:929-936`（`ssh_config_parse`）、`sftp.rs:963/939/313-324/1056-1059`（metadata/create_dir_all/指纹读写/rename）
- **问题**：单个操作量小，但与 keys/recording 已有的 spawn_blocking 口径不一致；Windows 跨卷 rename 可能明显阻塞。

### P-7【P3】零散渲染开销
- `SessionSftpPanel.tsx:90`：`visibleEntries` 每渲染重算（数千条目时 filter+`localeCompare` 排序），未 `useMemo`。
- `SftpSyncDialog.tsx:85` + `SessionSftpPanel.tsx:603`：`onFinished` 内联箭头函数导致事件订阅反复退订/重订。
- `SessionMonitorPanel.tsx:186-201`：render 期间写 `lastRate.current`，StrictMode 双渲染丢一次速率样本。

---

## 四、健壮性（低危但值得修）

### R-1【P3】ProxyJump 隧道收尾 `expect` 依赖跨函数隐式不变式
- **位置**：`src-tauri/src/ssh_manager/mod.rs:829-831`
- **问题**：`.expect("跳板链非空时必然留有最后一跳开出的隧道通道")` 当前成立，但属跨函数隐式不变式；将来 `collect_chain` 过滤空跳板即 panic（panic=abort 崩整个应用），且崩前 sessions 条目未清理。建议改 `ok_or_else` 走正常错误路径。

### R-2【P3】服务端主动打开的 forwarded-tcpip 转发 task 无句柄管理
- **位置**：`src-tauri/src/ssh_manager/mod.rs:393-406`
- **问题**：spawn 的双向拷贝 task 未登记、无取消机制。停止远程转发只撤销服务端监听，在飞连接无法 abort（泄漏有界：连接数 × 存活时长）。

### R-3【P3】终端输出 IPC 发送失败被静默吞掉
- **位置**：`src-tauri/src/ssh_manager/mod.rs:229-236`
- **问题**：`let _ = raw.send_bytes(data)`——前端 Channel 关闭/拥塞时输出整块丢弃，表现为「命令执行了但屏幕没输出」。建议计数并周期性 warn。

### R-4【P3】`validate_relative_path` 运算符优先级导致尾随空段放行
- **位置**：`src-tauri/src/ssh_manager/sync.rs:174-177`
- **问题**：`segment == ".." || segment.is_empty() && path.contains("//")` 实际解析为 `.. || (empty && has("//"))`，`"a/"` 被放行（join 后恰好无害，但与意图不符、测试未覆盖）。建议加括号并补用例。

### R-5【P3】`saveAi` 的 localStorage 兜底「只写不读」
- **位置**：`src/store/settings.ts:184` 对比 init 的 catch 回退块 `406-511`
- **问题**：非 Tauri 环境下保存的 AI 配置读不回来，与其他 12 个设置项的兜底行为不一致。

### R-6【P3】远程编辑器打开失败时统一误报「非 UTF-8 文件」
- **位置**：`src/views/sessions/SessionSftpPanel.tsx:347-348`
- **问题**：网络/权限失败与解码失败共用同一 catch 与文案，误导排查方向。

### R-7【P3】零散错误吞掉（无 UI 反馈）
- `SftpTransferList.tsx:30/38`：取消传输/调限速失败 `.catch(() => undefined)`。
- `SessionsView.tsx:233-235`：批量下发 send 模式单台失败无明细。
- `App.tsx:122-130/144-151/382-389`：`connectHostQuick().then()` 无 `.catch`；`RestoreLastTabsActions.tsx:18-36` 同。
- `App.tsx:229-325`：全局快捷键 effect 依赖 `[view]`，切语言后确认弹窗文案陈旧。

---

## 五、已核查、确认无问题的方面

- **加密**：vaultCrypto 实现正确——PBKDF2-SHA256 600k 迭代 + AES-GCM 256 + 随机 16 字节盐 + 每次加密随机 12 字节 IV（无 IV 重用）；解密对明文做结构校验。
- **XSS**：全库无 `dangerouslySetInnerHTML`/`innerHTML`/`document.write`；远端字节只写入 xterm 实例（安全用法）；AI 输出纯文本渲染；导出日志有 ANSI 清洗。
- **命令注入**：`kill_process` 白名单 + u32 校验；`network_diagnostic` 字符集白名单（拒空格/分号/管道/`$`/反引号/前导 `-`）+ ping 加 `--`；sync 全程 SFTP 协议不拼 shell。
- **路径穿越**：`recording_store.rs` 文件名清洗 + 先 metadata 后读；`validate_sftp_path` 拒 `\0`/超长（除 S-5 的 list 漏网）。
- **凭据持久化**：`normalizeHost` 强制清空 password/passphrase；hosts.json/导出/备份均无凭据；会话恢复只存 hostId。
- **锁与并发**：全库仅两处 std 锁且都在纯同步方法内（error 槽已做中毒降级）；共享状态统一 tokio 锁；多锁获取顺序一致；russh「连接锁只握通道协商期」约定执行一致。
- **panic 面**：远端输入路径无索引越界（batch/monitor/SOCKS5 解析都有长度守卫）；非测试代码仅 R-1 一处 expect。
- **事件订阅清理**：disposed + unlisten 模式全库统一；终端实例、ResizeObserver、监控轮询 interval 清理完整。
- **CSP**：生产 `script-src 'self'`、`object-src 'none'`，无内联脚本；AI 请求走 Rust reqwest 不受 connect-src 影响。

## 六、建议修复顺序

1. **立即**（数据安全）：B-3（删旧重试）、B-5（覆盖确认）、S-1（先 metadata 后读）
2. **本迭代**（功能正确性）：B-1（目录竞态）、B-2（sync_jobs 泄漏）、B-4（会话关闭取消同步）、B-6（倍速闭包）
3. **随后**（性能）：P-1/P-2（回放）、B-8（spawn_blocking）、P-4（重连日志）
4. **择机**（卫生）：S-2/S-3（apiKey）、S-4（CSS 校验复用）、其余 P3 项
