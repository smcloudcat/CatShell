# CatShell 深度代码审计报告（第二轮）

- **审计日期**：2026-09-12
- **基线**：提交 `8688b22`（首轮审计 27 项修复全部入库、6 项 UI 优化与 SFTP 超时改造之后）
- **审计范围**：`src-tauri/src/` 全部 Rust 源文件（含 `ssh_manager/` 九个模块、`lib.rs`、`recording_store.rs`、`launch.rs`、`logging.rs`）、`src/` 前端全量（store / utils / api / types / views / components / styles / i18n）、`tauri.conf.json`（CSP 与 assetProtocol）、`capabilities/`、`.github/workflows/`、`scripts/`
- **方法**：四路并行逐文件审读（会话语义与安全 / 数据面 / 应用层与前端状态 / 前端视图层）+ 模式化扫描（注入面 / 数据丢失路径 / 超时与取消 / 锁跨 await / 算术边界 / 资源泄漏 / 订阅与清理），全部高优发现经主审二次源码核验（本轮已剔除 1 条前提不成立的低优发现）
- **严重度定义**：P0 可被利用的安全漏洞或必然的严重损坏；P1 数据丢失 / 功能缺陷 / 明显资源风险；P2 特定条件触发的缺陷；P3 卫生问题与一致性缺口

## 结论摘要

| 严重度 | 数量 | 代表问题 |
| --- | --- | --- |
| P0 | 1 | `~/.ssh/config` 写回未过滤控制字符 → 可注入 `ProxyCommand` 实现任意命令执行 |
| P1 | 5 | SFTP 流式上传 begin 即截断目标文件、磁盘下载「先删后改名」、递归删除根保护可被 `..` 绕过、assetProtocol scope 覆盖全盘、多跳连接第 2+ 跳私钥选择器写入死键 |
| P2 | 27 | SFTP 超时层叠误报（本轮改造引入）、重连退避睡眠后不检查手动关闭、同步流直写目标无临时文件、AI 请求跟随重定向携带 Bearer、解锁后跳板凭据不进本次连接等 |
| P3 | 23 | 悬空样式类名、危险操作缺二次确认、若干静默失败与口径不一致 |

> **复核说明（2026-09-12 同日二次核查）**：初版 42 项经逐条对码核验**全部成立，无误报**（核验过程中剔除过 1 条前提不成立的候选发现，未计入）；随后两路独立遗漏扫描新增 14 项（第六章 X-1 ~ X-14），其中 X-1 为新 P1。当前总计 56 项。

**与首轮相比**：首轮 P0 为 0，本轮**首次出现 P0**——`~/.ssh/config` 写回路径对 `Host` 模式与 `HostName` 未做控制字符过滤，而主机档案的导入路径被明确定义为不可信来源，二者组合构成完整的注入链。数据面仍然是短板集中区：SFTP 的三条写入路径（流式上传、磁盘下载收尾、目录同步）都存在「以非原子步骤处理用户已有文件」的模式，本轮把它们全部收敛为 P1/P2。此外，**2026-09-12 的 SFTP 超时改造（`f172a2b`）引入了 2 个新问题**（超时层叠误报、覆盖不全导致的半吊子保护），详见 B-5/B-6——超时值本身的选取合理，问题出在嵌套层次与覆盖范围。

整体评价：首轮修复的 27 项无一回归，凭据体系、命令注入白名单、路径穿越防护、CSP、事件订阅清理等既有优势保持。本轮的短板集中在**「不可信输入 → 文件系统写入」的边界**（config 写回、asset 协议）与**「用户已有文件的原子替换」**（SFTP 三条写路径）。

---

## 一、安全（Security）

### S-1【P0】`~/.ssh/config` 写回未过滤控制字符，可注入 `ProxyCommand` 实现任意命令执行
- **位置**：`src-tauri/src/ssh_manager/config.rs:244-260`（`build_host_block` 拼接）、`config.rs:329-340`（`write_ssh_config_to` 校验）
- **问题**：块拼接把所有字段原样写入，校验只挡「空值 + ASCII 空格」：
  ```rust
  block.push_str(&format!("  User {}\n", draft.user.trim()));          // user/hostname 无字符校验
  if name.is_empty() || name.contains(' ') { return Err(...) }         // 只挡空格，不挡 \n / \t
  ```
  `\t` 可绕过空格检查，`hostname` 连绕过都不需要（只校验非空）。构造 `HostConfigDraft.name = "prod\nHost *\n  ProxyCommand C:/evil.exe"` 即可写入任意指令。
- **影响**：`HostConfigDraft.name` 来自主机档案，而导入的档案文件在 `src/utils/hostImport.ts` 中被明确定义为**不可信来源**；`normalizeHost` 不清理 `name`。导入恶意档案 → 用户在设置页执行「写回 ~/.ssh/config」→ 注入内容进入用户配置 → 用户后续任何 `ssh <别名>`（含外部终端）都会执行注入的 `ProxyCommand`。这是从不可信输入到本机命令执行的完整链路。
- **修复**：写回前对 `name` / `hostname` / `user` / `identity_file` 统一做字符白名单（拒绝 `\r` `\n` `\t` 及控制字符），并在导入侧把 `name` 纳入清理范围。

### S-2【P1】assetProtocol scope 为全盘，渲染进程可及任意本地文件
- **位置**：`src-tauri/tauri.conf.json:26-29`（`"scope": ["**"]`）、配合 `src/App.tsx:467`、`src/types/theme.ts:123`
- **问题**：自定义背景图功能（`decf955`）启用 asset 协议时把 scope 设为 `**`，即整块磁盘；`isSafeBackgroundImage` 只做逃逸字符校验，不限制目录与扩展名；`convertFileSrc` 接受任意绝对路径。webview 侧 `img-src` 放行 `asset:`，因此 `<img src="asset://localhost/C:/Users/.../id_rsa">` 这类请求可被发起。
- **影响**：当前 CSP（`connect-src` 不含 `asset:`）阻断了 `fetch` 直接读取，实际可利用面是**文件存在性探测**与**图片类文件内容的像素级读取**。但范围过宽意味着：一旦未来引入 XSS 面或放宽 CSP，`~/.ssh/id_rsa`、`credential-vault.json` 即处于可读范围。背景图功能本身只需要用户选中的那一个文件。
- **修复**：scope 收窄为专用目录（如 `$APPDATA/backgrounds/**`），选图时把文件复制进该目录并校验扩展名；或改用一次性 token 授权。

### S-3【P2】发布工作流把更新签名私钥暴露为 job 级环境变量
- **位置**：`.github/workflows/release.yml:11-13`
- **问题**：`TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` 定义在 **job 级** `env`，其后每个 step 均可读取，包括 `npm ci`（依赖的 `postinstall` 等生命周期脚本）与所有第三方 action；且 `dtolnay/rust-toolchain@stable`、`Swatinem/rust-cache@v2` 按可变 tag 引用，`build-windows` 未声明 `permissions`。
- **影响**：被投毒的依赖或第三方 action 可窃取签名私钥，进而签发可被自动更新接受的恶意安装包——这是本项目最敏感的单点凭据。
- **修复**：密钥只在执行签名的 step 注入；`npm ci --ignore-scripts`；第三方 action 固定到 commit SHA；显式声明最小 `permissions`。

### S-4【P2】设置主加载路径不校验 theme 与阈值，与备份导入路径口径不一致
- **位置**：`src/store/settings.ts:373-374`（直接展开合并）对比 `src/views/settings/BackupPanel.tsx` 的 `normalizeTheme`（HEX 校验 + 数值夹紧 + `isSafeBackgroundImage`）
- **问题**：备份还原路径有全套结构校验，启动加载路径**无任何校验**就合并进 store；非有限数值（如被篡改的字符串）可进入 `gradient.angle`、`accentColor`、`backgroundImage`，乃至监控阈值（`Math.max(1, "abc")` 结果为 `NaN`）。
- **影响**：本地配置文件被篡改或写坏时，可造成样式异常与阈值逻辑失效（NaN 比较恒假/恒真），并放大 S-2 的取图面。威胁模型要求本地文件可被篡改，属防御纵深缺口。
- **修复**：主加载路径复用 `normalizeTheme`，并补一层「非有限数值 → 回落默认」。

---

## 二、数据完整性 Bug

### B-1【P1】SFTP 流式上传在 `begin` 阶段即截断目标文件，取消/回收会将其删除
- **位置**：`src-tauri/src/ssh_manager/sftp.rs:889-892`（`sftp.create(&path)` 直接作用于最终目标路径）、`sftp.rs:964-966`（`reap_idle_transfers` 注释自认「上传的中途文件是真实目标文件，需要清理」）、`sftp.rs:1009`（取消同理会删真实目标）
- **问题**：磁盘上传用 `.catshell-part` + 收尾 rename，是安全的；**流式上传**（大文件分块，前端驱动）直接 `create` 目标路径——`begin` 的瞬间既有远端文件已被截断为 0 字节，随后的块逐步写回。
  ```rust
  let file = sftp.create(&path).await?;     // path = 最终目标，立即截断
  ```
- **影响**：向一个已存在的远端文件上传，只要中途取消、通道空闲 10 分钟被回收、或前端漏发块，原文件先被截断、再被删除（`close_transfer(.., true)`），**旧内容无任何副本可恢复**。这是本轮最直接的数据丢失路径。
- **修复**：流式上传同样先写 `.catshell-part`，`finish` 时 rename 覆盖目标（与磁盘上传对齐）。

### B-2【P1】磁盘下载收尾「先删目标再改名」，改名失败即永久丢失原文件
- **位置**：`src-tauri/src/ssh_manager/sftp.rs:1158-1167`
- **问题**：收尾时无条件删除已存在的目标文件，再 rename 半成品：
  ```rust
  if tokio::fs::metadata(&transfer.local_path).await.is_ok() {
      let _ = tokio::fs::remove_file(&transfer.local_path).await;   // 原文件已删
  }
  if let Err(error) = tokio::fs::rename(&part_path, &transfer.local_path).await { ... }
  ```
- **影响**：`remove` 成功而 `rename` 失败（目标被杀软/他进程占用、跨卷、父目录被删）时，用户的原有文件永久消失，新内容困在半成品名下；下次续传还会因 `part_len >= total` 判为已完成而整段重下。
- **修复**：先把目标改名为 `.bak`，rename 成功后再删备份；失败则回滚。

### B-3【P1】递归删除的根目录保护可被 `.` / `..` 绕过，可清空任意上级目录
- **位置**：`src-tauri/src/ssh_manager/sftp.rs:679-681`（`sftp_remove_dir` 的准入检查）、`sftp.rs:474-476`（`segments_are_empty` 只判空段）、`sftp.rs:525-534`（`validate_sftp_path` 只拒空值/`\0`/超长）
- **问题**：`segments_are_empty("..")` 为 false，`validate_sftp_path("..")` 全部通过，于是 `".."`、`"."`、`"a/.."` 都能进入递归删除：
  ```rust
  let normalized = path.trim_end_matches('/');
  if normalized.is_empty() || segments_are_empty(normalized) { return Err("拒绝删除根目录"); }
  ```
- **影响**：一次构造的 `sftp_remove_dir` 调用即可**递归清空上级目录的全部内容**（预算 20000 条以内、无二次确认），随后才因 `remove_dir("..")` 失败报错——破坏已经发生。属远端数据的高危破坏面。
- **修复**：删除路径额外校验——拒绝任何等于 `.` / `..` 的路径段，并要求绝对路径；测试补 `..`、`.`、`a/..` 用例。

### B-4【P2】并发同名磁盘传输存在 TOCTOU，共用半成品路径交错写
- **位置**：`src-tauri/src/ssh_manager/sftp.rs:770-778`（`part_path_claimed` 只读检查）、`sftp.rs:1052-1053` 与 `1115-1118`（检查与登记之间隔着多个 await）
- **问题**：`part_path_claimed()` 取锁→返回布尔→释放锁；真正 `insert` 到 `sftp_disk_transfers` 之前还有 `open_sftp_channel`、`metadata`、`read_resume_stamp`、`open` 等多个 await。两个并发请求都会读到「未占用」，各自拿到同一个 `{target}.catshell-part`。
- **影响**：同一目标的两个传输交错写同一半成品文件，随后各自 rename 到目标，产出静默损坏的内容；队列重启后的自动续传场景更易触发。
- **修复**：把「检查占用」与「插入占位条目」放进同一把锁内原子完成（先占坑再开通道，失败回滚）。

---

## 三、正确性 Bug

### B-5【P2】SFTP 超时层叠错位：外层 20 秒短于内部最坏 45 秒，慢链路被误报超时（2026-09-12 改造引入）
- **位置**：`src-tauri/src/ssh_manager/sftp.rs:539-586`（`sftp_list` 用 `with_sftp_timeout` 包住整个闭包）对比 `sftp.rs:730-767`（`open_sftp_channel` 三步各 15 秒）
- **问题**：`with_sftp_timeout` 固定 20 秒（`SFTP_OP_TIMEOUT`），而它包裹的闭包内部包含 `open_sftp_channel`——后者的最坏耗时是 3 × 15 = 45 秒：
  ```rust
  let result = with_sftp_timeout("读取远程目录", async move {
      let sftp = self.open_sftp_channel(id).await?;   // 内部最坏 45s
      let entries = sftp.read_dir(path).await?;
  ```
- **影响**：高延迟链路上，即使每步都在各自 15 秒预算内（例如各 8 秒），外层也会在 20 秒先打断并报「读取远程目录超时（20 秒）」，同时 drop 掉仍在握手中的 future——既误报又丢弃了本可成功的连接。
- **修复**：外层超时改为 `> 3 × SFTP_OPEN_TIMEOUT`，或把 `open_sftp_channel` 移到外层包裹之外、只对 `read_dir` 计时。

### B-6【P2】超时保护覆盖不全，多处仍可永久挂起
- **位置**：`src-tauri/src/ssh_manager/sftp.rs:597-625`（`sftp_read_file` 的正文 `read`）、`sftp.rs:627-650`（`sftp_write_file` 的 `write_all` / `shutdown`）、`sftp.rs:492-521`（递归删除内部每个 `read_dir` / `remove_*`）、`sftp.rs:1045-1048` 与 `1045` 区段（磁盘传输的 `metadata`）、`src-tauri/src/ssh_manager/sync.rs:700-717` 与 `740-758`（同步流的每个读写块）
- **问题**：2026-09-12 的改造只给「通道三步 + 5 个快操作 + close + 磁盘/流式 chunk」加了超时；上述入口仍是裸 `await`。
- **影响**：与改造要解决的问题同因——远端收下请求后停摆，`sftp_read_file` 的正文读取、磁盘下载的 `metadata`、递归删除、同步任务都会永久挂住，前端表现为无限「加载中」。保护呈半吊子状态，反而更难诊断（有的路径超时、有的不超时）。
- **修复**：按操作时长分类补齐——单次固定量 IO 用 `SFTP_OP_TIMEOUT`，循环内每个块用 `DISK_CHUNK_TIMEOUT`，`metadata` 一律套快操作超时。

### B-7【P2】目录同步的流式读写直写目标文件，中断即用半截内容覆盖
- **位置**：`src-tauri/src/ssh_manager/sync.rs:690-696`（上传用 `WRITE|CREATE|TRUNCATE` 直写目标）、`sync.rs:735-737`（下载 `File::create(local)` 直写目标）
- **问题**：同步的每个文件都是直写最终路径，没有临时文件与原子替换。
- **影响**：更新一个已存在的文件时中途断网/取消/超时，目标文件被截断为半截且原内容已销毁；在下一次同步修复它之前，用户在该路径读到的都是损坏文件（对远端是远端损坏，对本地是本地损坏）。
- **修复**：沿用 `.catshell-part` 模式，收尾 rename；或至少「先写临时文件再替换」。

### B-8【P2】重连退避睡眠结束后不再检查手动关闭，已关闭的会话会被重新建连
- **位置**：`src-tauri/src/ssh_manager/mod.rs:984-992`（`'outer: loop` 顶部直接 `emit_status` + `open_shell`）、`mod.rs:1021` / `1031`（检查在 sleep **之前**）、`1045`、`1083`（另两处 sleep 同理）
- **问题**：`manual_closed` 的检查都发生在「决定是否重试」的时刻，随后 `sleep(reconnect_delay(attempt))`，睡眠结束回到循环顶部**没有二次检查**就直接建连：
  ```rust
  attempt = next_attempt;
  tokio::time::sleep(reconnect_delay(attempt)).await;   // 之后 loop 顶部直接 open_shell
  ```
- **影响**：用户在这个退避窗口（2/5/10/…秒）内点「断开」或关闭标签，睡眠结束后后端仍会新建 TCP + SSH 连接、完成认证并 emit `connected`。标签已消失（前端守卫会忽略事件），但后端多出一条幽灵连接占用资源，直到下次断开才回收。
- **修复**：在 `sleep` 之后、`open_shell` 之前重新检查 `session.manual_closed`，命中则 `break 'outer`。

### B-9【P2】主机指纹确认表按 `host:port:fingerprint` 去重，并发首次连接同一主机时其中一个静默失败
- **位置**：`src-tauri/src/ssh_manager/mod.rs:344-346`、`mod.rs:359-364`
- **问题**：token 不含会话 id，两次并发连接同一未信任主机时，第二次 `insert` 覆盖并丢弃第一个 `oneshot::Sender`，第一个接收端立即收到 `Err`，被 `unwrap_or(false)` 判为「用户拒绝」。
- **影响**：同一主机的两个并发连接中，一个无提示地失败，用户与日志都无法解释原因。
- **修复**：token 加入会话 id，或同一 token 复用一个广播式等待者（多个等待者共享结果）。

### B-10【P2】幽灵标签守卫仍可被迟到的 `connecting` 事件绕过
- **位置**：`src/store/sessions.ts:221-225`
- **问题**：今日修复把「未知会话」分支限制为仅放行 `connecting` / `connected`，但迟到或乱序的 `connecting` 事件仍会以空 `name`/`host` 凭空登记一个新会话。
- **影响**：会话计数徽标与托盘活动数虚高；该会话缺连接参数、无法重连，需重启收敛。
- **修复**：兜底登记再加一层条件——仅当本地确有进行中的 `open()` 请求（请求在途）时才允许登记。

### B-11【P2】录制回放未解析「跟随系统」，浅色系统下回放内容几乎不可读
- **位置**：`src/views/sessions/RecordingPlayerDialog.tsx:28`、`:63`；对照 `src/views/sessions/TerminalPane.tsx:30`（`useEffectiveMode`）
- **问题**：回放弹窗直接读原始 `theme.mode`，用 `themeMode === 'light' ? LIGHT : DARK` 取主题；主终端走 `useEffectiveMode()` 解析 auto。
- **影响**：模式为「跟随系统」且系统为浅色时，App 已把 `data-mode` 置为 light，CSS 把 `.recording-terminal .xterm-viewport` 强制为白底，而 xterm 主题仍是深色（浅色前景 + 深底），回放内容对比度极低，基本读不了。
- **修复**：回放复用 `resolveMode` / `useEffectiveMode`。

### B-12【P2】硬盘/远程保真度退化：流式上传收尾不校验已传字节数
- **位置**：`src-tauri/src/ssh_manager/sftp.rs:981-1001`（`sftp_upload_finish`）
- **问题**：`finish` 只做 `shutdown()` 与关通道，不比较 `transfer.transferred` 与 `transfer.total`。
- **影响**：前端漏发/少发分片时，远端留下截断文件却判定上传成功，用户误以为文件完整。
- **修复**：`finish` 前校验一致，不一致则报错并按取消路径清理。

### B-13【P2】上传分片超时后偏移错位，前端重试会写坏文件
- **位置**：`src-tauri/src/ssh_manager/sftp.rs:920-939`
- **问题**：`timeout(DISK_CHUNK_TIMEOUT, file.write_all(&data))` 超时后 future 被 drop，远端句柄的写入位置可能已推进，但 `transferred` 未随之更新（`fetch_add` 在 timeout 之后）；而偏移校验用的正是 `transferred`。
- **影响**：前端按原 offset 重试同一分片时校验「通过」，实际却写到已推进的位置，产生重复字节/空洞，文件损坏。
- **修复**：超时即标记该传输失败终止（禁止在同一句柄上重试），或写入前 `seek` 到 `transferred`。

### B-14【P2】断点续传指纹只有「长度 + mtime」，同长同秒的不同内容会拼出损坏文件
- **位置**：`src-tauri/src/ssh_manager/sftp.rs:388-405`（`resume_offset`）、`sftp.rs:371-386`（`local_file_stamp`）；下载侧 mtime 来自远端秒级 `u32`
- **问题**：`ResumeStamp { total, mtime }` 无法区分「长度相同且 mtime 未变」的不同内容（`touch -r` 或同秒替换即可伪造）。
- **影响**：源文件被替换为等长内容且 mtime 未变时，续传把新内容接到旧偏移之后，产出静默损坏的文件（长度正确、内容错误）。
- **修复**：指纹加入首/尾分块的快速哈希（如 xxh3），或续传前校验半成品尾部与源文件对应字节。

### B-15【P2】保险箱锁定时删除主机，凭据永久残留且无 UI 可清理
- **位置**：`src/store/hosts.ts:103`、`src/store/vault.ts:190`
- **问题**：`removeCredential` 在 `!get().unlocked` 时静默 `return`；而 `hosts.remove` 已经先删除了主机。
- **影响**：锁定态下删除主机，主机消失但其加密凭据永久留在保险箱里，且入口已随主机一起消失，用户再也无法删除它。
- **修复**：删除失败返回状态并提示用户先解锁；或允许锁定态排队删除。

### B-16【P2】已定义错误码被裸 `Error` 取代，英文界面回退中文
- **位置**：`src/store/vault.ts:161`、`vault.ts:167`、`src/store/hosts.ts:89`
- **问题**：`throw new Error('原主密码不正确')` 等直接抛裸 Error，而 `ERROR_CODES.VAULT_OLD_PASSWORD_WRONG`、`ERROR_CODES.HOST_INVALID` 早已定义且有英文译文却无人引用（`AGENTS.md` 明确要求业务层抛 `AppError`）。
- **影响**：`errorText` 走原始 message 分支，英文界面下显示中文；错误码机制形同虚设。
- **修复**：改用 `throw new AppError(ERROR_CODES.X)`。

---

## 四、性能与体验

### P-1【P2】两处虚拟列表行高与 CSS 实际高度不符，长列表滚动错位
- **位置**：`src/views/sessions/SessionMonitorPanel.tsx:67`（`itemHeight: 37`）vs `src/styles/monitor.css:202-207`（`min-height: 36px`）；`src/views/sessions/SftpEntryList.tsx:26`（`ROW_HEIGHT = 52`）vs `src/styles/sftp.css:165`（`min-height: 42px`）
- **问题**：全局 `* { box-sizing: border-box }`（`glass.css:87`）下边框计入 `min-height`，进程行实际 36px 而占位按 37px 计算；SFTP 行则在虚拟化前后分别按 42px 与 52px（内联强制）渲染。
- **影响**：监控进程列表随滚动线性累积偏移（数百行可达数百像素），快速滚动出现跳动与空白；SFTP 目录跨过虚拟化阈值时行高整体跳变、滚动位置视觉漂移。
- **修复**：行高常量与 CSS 对齐（37→36、52→42），或反向在 CSS 中显式固定虚拟化行高。

### P-2【P2】面板尺寸只读不夹紧，窄窗口下沿用过大的历史值
- **位置**：`src/views/sessions/usePanelResize.ts:20-26`、`:40-41`；`src/views/sessions/sessionViewUtils.ts:65-68`
- **问题**：读取持久化尺寸时只校验 `> 0`，不做上界收敛；SFTP 面板的上限（`innerHeight * 0.62`）只在拖拽时计算，effect 未监听窗口 resize。
- **影响**：在大屏拖出的大尺寸存盘后换到小窗口/分屏，面板直接按旧值渲染，挤占甚至挤没终端区域（仅靠 CSS `min-height` 兜底）；同时新的默认值（监控 280 / SFTP 340）对已存在 localStorage 的用户永远不生效。
- **修复**：挂载与 resize 时按当前窗口重新夹紧，并对旧值做一次上限收敛迁移。

### P-3【P2】外观模式切换每次点击都写盘，快速连点写入顺序不确定
- **位置**：`src/views/settings/Appearance.tsx:43-57`、`src/store/settings.ts:199-209`
- **问题**：模式按钮 `setAppearanceMode(mode); void saveTheme()` 立即落盘，而同一面板的强调色/质感/背景改动只改内存、依赖手动「保存主题」；`saveTheme` 内部 `load → set → save` 无串行化。
- **影响**：快速连点「浅色/深色」时最终落盘值不保证是最后一次点击；用户在调试强调色等未保存改动时随手点一下模式，会把半成品主题一并固化。
- **修复**：模式切换也改为内存态 + 统一的保存入口，或在 store 内对 `saveTheme` 串行化/去抖。

### P-4【P2】两处不可逆删除缺二次确认，误点即永久丢失
- **位置**：`src/views/settings/SnippetPanel.tsx:56`（删除命令片段）、`src/views/sessions/RecordingLibraryDialog.tsx:39-46`、`:93-100`（删除录制文件）
- **问题**：两处 `onClick` 直接调用删除，无 `confirmDialog`；片段删除按钮与「编辑」按钮同排同尺寸。
- **影响**：误点即永久删除，无撤销途径；与主机/密钥/凭据的确认策略不一致。
- **修复**：删除前套 `confirmDialog({ danger: true })`。

### P-5【P2】关于页外链与邮件打开失败被静默吞掉
- **位置**：`src/views/settings/AboutPanel.tsx:21-23`
- **问题**：`void openUrl(url).catch(() => undefined)`。
- **影响**：系统未注册 `mailto:`、opener 权限被拒、外部浏览器不可用时，点击「打开 / 写邮件」毫无反应，用户无法定位原因。本次新增的功能在失败时没有任何反馈通道。
- **修复**：`catch` 内 `showToast(errorText(...), 'error')`。

### P-6【P2】录制缓冲无上限，且关闭标签/重连不清理录制态
- **位置**：`src/store/recording.ts:81`（`session.chunks.push` 无字节或条数上限）、`src/store/sessions.ts:387-389`（`closeTab` 只 `clearSessionLog`）、`sessions.ts:323-369`（`reconnect` 同）
- **问题**：录制缓冲按输出字节无限增长；关闭或重连正在录制的标签后，缓冲与 `useRecordingStore.active[id]` 残留。
- **影响**：长时间高频输出的会话可撑爆渲染进程内存；关闭后录制指示灯卡在「录制中」，无法再操作该条目。
- **修复**：缓冲设上限（对齐会话日志的 2 MB 量级）；`closeTab` / `reconnect` 一并清理录制态。

### P-7【P3】sessionRestore 在每次状态事件都触发落盘
- **位置**：`src/store/sessionRestore.ts:67-83`
- **问题**：判重条件包含 `state.sessions === prev.sessions`，而每次 status 更新都会新建 `sessions` 对象，于是每次连接/断开都 `load + save` 一次。
- **影响**：标签实际未变化也产生无谓的文件 IO。
- **修复**：比较派生出的 tabs 内容而非 `sessions` 引用。

### P-8【P3】审计日志去抖持久化在退出时丢末尾记录
- **位置**：`src/store/audit.ts:35-41`
- **问题**：1 秒去抖写盘，退出/关闭窗口路径没有 flush 钩子。
- **影响**：退出前 1 秒内的审计记录（含「断开」「关闭」这类关键动作）丢失。审计场景下丢记录比性能更敏感。
- **修复**：在退出事件或窗口关闭前 flush 一次。

---

## 五、健壮性与卫生

### R-1【P3】`known_hosts` 删除走非原子写回
- **位置**：`src-tauri/src/ssh_manager/config.rs:223-225`（对照同文件 `:352-354` 的 `.tmp` + rename 实现）
- **影响**：写入中途崩溃/断电会截断 known_hosts，之后所有主机被当作未知需重新确认（不丢私钥，但体验受损）。
- **修复**：复用原子替换。

### R-2【P3】`Host` 块识别遗漏制表符分隔，且新块追加在 `Host *` 之后可能不生效
- **位置**：`src-tauri/src/ssh_manager/config.rs:272-277`（`lower.starts_with("host ")` 不匹配 `Host\tweb`）、`config.rs:303-315`（新块一律追加到文末）
- **影响**：`Host<TAB>web` 形式的旧块不会被移除，留下重复块；且 OpenSSH 取「首个获得的值」，若文件前部存在 `Host *` 并设置了 `HostName`，追加在末尾的新块会被覆盖——编辑主机后配置静默失效。
- **修复**：按空白切分关键字判断；新块插入到首个 `Host *` / `Match` 之前。

### R-3【P3】交互式认证成功后确认通道未清理
- **位置**：`src-tauri/src/ssh_manager/mod.rs:491-500`
- **影响**：成功分支未 `pending.remove(&session_id)`（错误分支有），每次成功认证残留一条；重连反复认证会累积，后续 `answer_kbi` 可能命中陈旧条目。
- **修复**：成功路径同样移除。

### R-4【P3】`disconnect` 跨 await 持有写半连接锁
- **位置**：`src-tauri/src/ssh_manager/mod.rs:1306-1308`
- **影响**：`if let Some(half) = session.write.lock().await.as_mut()` 的临时 guard 覆盖整段 `half.close().await`；关闭阻塞期间同会话的 `write` / `resize` 全部挂起。
- **修复**：取出后释放锁，再在锁外 `close`。

### R-5【P3】跳板链只校验链头，内层空字段导致无意义重连
- **位置**：`src-tauri/src/ssh_manager/mod.rs:1228-1232`
- **影响**：`create` 只校验 `req.proxy` 的首跳，`proxy.next` 各级不校验；空 host 的跳板连接失败被归为「瞬时错误」，在 `MAX_RECONNECT_ATTEMPTS` 内反复重试并延迟报错。
- **修复**：遍历 `collect_chain()` 校验每一跳。

### R-6【P3】悬空样式类名（JSX 引用但 CSS 未定义）
- **位置与类名**：`panel-copy`（`AboutPanel.tsx:39,49`、`SettingsView.tsx:198,218,237`）、`modal-actions`（`SftpSyncDialog.tsx:185,261`）、`card-footer`（`HomeView.tsx:84,91`）、`host-group-name`（`HostsView.tsx:278`）、`shortcut-group`（`ShortcutsDialog.tsx:20`）、`proxy-hop-actions`（`HostProxyFields.tsx:201`）、`audit-panel`（`AuditPanel.tsx:82`）、`snippet-panel`（`SnippetPanel.tsx:34`）、`vault-panel`（`VaultPanel.tsx:134`）
- **影响**：多数有外层类兜底、视觉可接受；但 `panel-copy` 是本次新增关于页的正文容器，缺失排版样式会让「关于」页段落密度与既有页面不一致。与首轮发现的 AiPanel 问题同源——**新增组件时类名写进 JSX 但忘了写 CSS**。
- **修复**：补齐定义，或在 CI 增加「JSX 类名 ↔ CSS 选择器」的静态对账脚本。

### R-7【P3】「关于」页与页签文案未补英文词典
- **位置**：`src/views/settings/AboutPanel.tsx:37-64`、`src/views/SettingsView.tsx:33`、`src/i18n/index.ts`
- **影响**：`联系与主页 / 作者博客 / 打开 / 联系邮箱 / 写邮件 / 使用协议 / 关于 / 版本 · 联系方式 · 使用协议` 等键在 en 字典缺失，英文界面整块回退中文；页签走 `t(TABS[...].labelKey)` 动态键，`i18n:check` 静态扫描发现不了。
- **修复**：补齐 en 词条，并纳入 `i18n:audit` 的动态键清单。

### R-8【P3】拖放上传不过滤目录与空文件
- **位置**：`src/views/sessions/SftpDropZone.tsx:29-34`
- **影响**：拖入文件夹会按 0 字节同名文件上传（或直接报错），同名目录还会触发覆盖确认，产生脏远端条目。
- **修复**：过滤 `size === 0` 与无 `type` 的目录项并提示。

### R-9【P3】选择背景图片无异常兜底
- **位置**：`src/views/settings/ThemeParams.tsx:91`、`:105-110`
- **影响**：`await import('@tauri-apps/plugin-dialog')` 与 `open(...)` 无 try/catch，非 Tauri 环境或插件不可用时产生未处理的 Promise rejection 且界面无提示。
- **修复**：包 try/catch 并 toast。

### R-10【P3】覆盖密钥的冲突判定依赖错误文案子串
- **位置**：`src/views/settings/KeypairPanel.tsx:112`（`message.includes('已存在')`）
- **影响**：后端文案调整后不再弹覆盖确认；其它含「已存在」的错误会误弹高危确认。
- **修复**：改用错误码或结构化错误类型判定。

### R-11【P3】危险按钮缺静止态强调色
- **位置**：`src/styles/hosts.css:184`（仅定义 `.host-icon-btn.danger:hover`）
- **影响**：SFTP 行删除、进程终止、凭据删除等入口未悬停时与普通按钮同色，危险操作视觉区分不足。
- **修复**：补 `.host-icon-btn.danger` 基础态 `color: var(--err)`。

### R-12【P3】路径左截断用 `direction: rtl` 带来 bidi 副作用
- **位置**：`src/views/sessions/SftpToolbar.tsx:97`、`src/styles/sftp.css:39-49`
- **影响**：段首/段尾的中性字符与镜像字符（`(`、`[`、`<`）在 RTL 段落方向下可能显示乱序或镜像；纯 ASCII 路径不受影响（复制得到的始终是逻辑序）。
- **修复**：加 `unicode-bidi: plaintext` 或改用 `<bdi>`。

### R-13【P3】SFTP 面板其余异步路径未做卸载保护
- **位置**：`src/views/sessions/SessionSftpPanel.tsx:161-236`、`:508-545`
- **问题**：只有 `loadDirectory` 检查 `disposedRef`；`uploadFiles`、`handleDelete`、`saveEditor`、`submitNameDialog` 等在 await 结束后仍会写状态。
- **影响**：`key={activeId}` 重挂载后旧实例的异步回调继续写状态与审计时序。
- **修复**：抽一个统一的 `guard()`，所有异步收尾复用。

### R-14【P3】零散静默失败与一致性缺口
- `src/store/hosts.ts:39`、`vault.ts:97`、`snippets.ts:26`：plugin-store 失败后写 localStorage 的兜底自身无 try/catch，配额耗尽时 `persist` reject 而内存已改，调用方误判保存结果。
- `src-tauri/src/recording_store.rs:58-62`：`ensure_recordings_dir` 在 async 上下文同步建目录（同类 IO 已统一移入阻塞池）。
- `src-tauri/src/ssh_manager/sftp.rs:360-368`：续传指纹读写全 `let _ =`，磁盘满/权限错时静默失效；`:407-413` 并发备用半成品用 `-{id}` 后缀，不可续传也不清理。
- `src/views/sessions/SftpEntryList.tsx:45`：虚拟化行内联强制高度与 CSS `min-height` 双源，后续改动易踩（见 P-1）。

---

## 六、复核轮补充发现（二次核查新增 X-1 ~ X-14）

> 初版报告完成后，对其余 20 余项低优发现逐条对码核验（全部成立），并由两路独立遗漏扫描覆盖初版较薄的区域（连接表单链路、AI 请求实现、CI、录制存储等），新增以下 14 项，全部经主审二次核验。

### X-1【P1】多跳连接第 2+ 跳的私钥选择器写入无效字段，选择结果被静默丢弃
- **位置**：`src/views/hosts/HostProxyFields.tsx:197`（`keyTarget={'proxyHopKeyPath:${index}'}`）、`src/views/hosts/ConnectDialog.tsx:104`（`set({ [target]: file })`）
- **问题**：第 1 跳的 `keyTarget` 是有效字段 `proxyKeyPath`（`HostProxyFields.tsx:13`），第 2+ 跳却拼出 `proxyHopKeyPath:0` 这类键——全库仅此一处出现，`ConnectFormState` 无此字段、无人读取；而 `updateHop(index, { keyPath })`（`:140`）才是正确通道，却未被私钥选择使用。
- **影响**：凡第 2+ 跳使用密钥认证，点「选择私钥」后表单不变，校验必报跳板私钥缺失或以空路径连接——功能完全失效。
- **修复**：`pickKey` 解析 `proxyHopKeyPath:<n>` 目标时改调 `updateHop(n, { keyPath: file })`。

### X-2【P2】解锁保险箱后取回的第 2+ 跳凭据不参与本次连接
- **位置**：`src/views/hosts/ConnectDialog.tsx:158-170`
- **问题**：解锁后 `hopCredentials` 合并了保险箱里的跳板密码，但只通过 `setForm` 写入 state（React 异步）；紧随其后的 `validateForConnect(form, ...)`（165）与 `validateProxyInput(form, ...)`（170）读取的仍是**闭包中的旧 form**（各跳密码为空），`buildConnectRequest` 组链用的正是这份旧数据。
- **影响**：保险箱锁定时点「连接」→ 弹解锁 → 解锁成功后，第 2+ 跳已存凭据被漏掉，多跳认证失败；需取消后重新连接才正常。
- **修复**：把 `hopCredentials` 作为参数传给校验与组链函数，不依赖异步 state。

### X-3【P2】AI 请求跟随重定向，同主机 https→http 降级仍携带 Bearer
- **位置**：`src-tauri/src/lib.rs:752-756`
- **问题**：`reqwest::Client::builder().timeout(60s).build()` 未禁用重定向；reqwest 默认策略（`Policy::limited(10)`）仅在**跨主机**时剥离 `Authorization`，同主机 scheme 降级（https→http）不剥离。
- **影响**：可信端点被劫持或返回 301 到 http 时，API Key 明文外发——与「endpoint 必须 https」的既有校验（首轮 S-3）没有形成闭环。
- **修复**：`.redirect(reqwest::redirect::Policy::none)`（一行）。

### X-4【P2】AI 响应体无上限读入内存
- **位置**：`src-tauri/src/lib.rs:768-771`（`response.text().await`）
- **问题**：无大小限制；60 秒总超时挡不住高速响应——局域网内恶意/被劫持端点可在超时窗口内推送任意大小数据进内存，之后才截断为 400 字符。
- **影响**：内存尖峰乃至 OOM（panic=abort 下直接崩进程）。
- **修复**：先查 `Content-Length`，或用 `chunk()` 累积并设上限（如 8 MB）。

### X-5【P2】CI 前端/rust job 未收紧权限，第三方 action 未固定 SHA，无超时
- **位置**：`.github/workflows/ci.yml:8-47`
- **问题**：仅 audit job 声明了 `permissions:`，frontend/rust 继承仓库默认 token；`dtolnay/rust-toolchain@stable`、`Swatinem/rust-cache@v2` 均为浮动 tag；所有 job 无 `timeout-minutes`（默认 360 分钟）。
- **影响**：第三方 action 被投毒时可获过宽 token；挂起 job 长期占用 runner。
- **修复**：两 job 补 `permissions: {contents: read}`；action 固定 commit SHA；加超时。（与 S-3 一并整改）

### X-6【P2】ForwardView 会话下拉悬挂：选中会话断开后表单不更新
- **位置**：`src/views/ForwardView.tsx:43-48`（effect 只在 `!form.sessionId` 时填充）、`:67-74`（`startForward` 只校验数字非零，不校验会话仍 connected）
- **问题**：首个连接会话断开后，`form.sessionId` 仍指向它（非空不再触发填充）；下拉选项列表只剩在线会话，显示值与实际提交值脱节。
- **影响**：对已断开会话发起转发，后端报错文案难以理解；或用户以为选了 A 实际提交的是旧的 B。
- **修复**：当前 `sessionId` 不在 connectedSessions 中时重置为空，或提交前校验。

### X-7【P2】closeTab 与 disconnect 并发发射，后到的 disconnect 对已移除会话报错
- **位置**：`src/views/sessions/SessionsView.tsx:112-123`
- **问题**：注释写「关闭标签前先断开连接」，但 `void disconnect(id)` 与 `void closeTab(id)` 同时发射、无顺序保证；`closeTab` 内 `sshRemove` 先返回时，后到的 `sshDisconnect` 对已移除会话返回错误，被 catch 捕获弹「断开连接失败」toast。
- **影响**：正常关标签也可能弹出失败提示（误报），干扰用户判断。
- **修复**：`await disconnect` 后再 `closeTab`，或捕获「会话不存在」类错误不提示。

### X-8【P3】主机导入预览的 busy 防重无效
- **位置**：`src/views/hosts/HostImportPreviewModal.tsx:23-30`、`:60`
- **问题**：`confirm()` 同步执行 `setBusy(true) → onConfirm() → finally setBusy(false)`，而 `onConfirm` 是 fire-and-forget 异步——busy 同帧复位，按钮禁用从不生效。
- **影响**：快速双击可重复触发导入（当前 upsert 幂等、危害有限，但防重形同虚设）。
- **修复**：`onConfirm` 返回 Promise，resolve 前保持 busy。

### X-9【P3】AuditPanel 动作映射缺新动作，审计列表显示原始键
- **位置**：`src/views/settings/AuditPanel.tsx:10-42`（`ACTION_LABELS`）、对照 `src/views/sessions/SessionsView.tsx:206/216/265`
- **问题**：`session.record-start` / `session.record-stop` / `command.batch-exec` 等动作已写入审计，但映射表缺失，fallback 直接渲染 `entry.action`。
- **影响**：中文界面下这些记录显示英文原始键。
- **修复**：补齐映射与 en 词条。

### X-10【P3】VaultPanel「闲置自动锁定：关闭」英文误译为 "Close"
- **位置**：`src/views/settings/VaultPanel.tsx:234`（`AUTO_LOCK_LABELS[0]='关闭'` 经 `t()` 命中全局键 `'关闭': 'Close'`）
- **影响**：英文界面下该选项显示 "Close"（关闭窗口），语义应为 Off/Disabled。
- **修复**：改用独立键（如 `'不自动锁定': 'Disabled'`）。

### X-11【P3】recording_save 直接写目标文件，非原子
- **位置**：`src-tauri/src/recording_store.rs:73-75`（`std::fs::write(&path, ...)`）
- **影响**：断电/崩溃留下半截 `.cast`，仍会被 `list_recordings` 展示且读取失败。
- **修复**：写临时名后 rename（仓库 sftp/sync 已有同模式）。

### X-12【P3】`ConnectRequest` / `ProxyConfig` 缺基本边界校验
- **位置**：`src-tauri/src/ssh_manager/types.rs:27-40`、`:70-90`
- **问题**：`port` 允许 0，`host`/`username`/`name` 无长度上限与空值校验，原样进入 `redacted_summary()` 日志与 `session-status` 事件；`proxy.next` 链无深度上限。
- **影响**：超长字符串放大 IPC/日志体积；port=0 报错难懂；异常深链拖长连接流程。
- **修复**：反序列化后统一校验（port ≥ 1、字符串长度上限、链深上限）。

### X-13【P3】`known_hosts_list` / `known_hosts_remove` 在 async command 内做同步文件 IO
- **位置**：`src-tauri/src/lib.rs:865-883`
- **问题**：直接同步读写 `~/.ssh` 下文件；同文件其余路径已统一走 `spawn_blocking` 并有注释说明可能挂网络盘，此处口径不一致（同类的还有 `lib.rs:905` 的 `create_dir_all` 与 `recording_store.rs:58-62` 的 `ensure_recordings_dir` 调用链）。
- **影响**：慢盘/网络盘上阻塞 tokio worker。
- **修复**：挪入 `spawn_blocking`，与 P-6 口径对齐。

### X-14【P3】`tray_set_quick_connects` 双锁窗口 + 静默截断
- **位置**：`src-tauri/src/lib.rs:663-664`、`:809`
- **问题**：两次 `lock().await` 之间并发调用可插入，菜单快照与状态短暂不一致；`iter().take(15)` 丢弃第 16 个起的档案且无反馈。
- **影响**：托盘入口与主机档案不一致（并发窗口/超 15 个档案时）。
- **修复**：单次锁内完成快照；截断时返回提示。

## 七、已核查、确认无问题的方面

- **凭据体系**：vaultCrypto 实现正确（PBKDF2-SHA256 600k + AES-GCM 256 + 每字段随机 16 字节盐 + 每次加密新随机 12 字节 IV，无 IV 重用）；解密后结构校验；apiKey 走系统 keyring，持久化文件与 localStorage 一律写空串；`ConnectRequest` / `ProxyConfig` 不派生 `Debug`/`Serialize` 并在 `Drop` 中零化口令，全库无 `tracing!` 打印敏感字段。
- **XSS 面**：全库无 `dangerouslySetInnerHTML` / `innerHTML` / `document.write`；远端字节只写入 xterm 实例；AI 输出纯文本渲染；导出日志有 ANSI 清洗。
- **命令注入**：`monitor.rs` 的进程 Kill 走 signal 白名单 + pid 上限，网络诊断走字符白名单（拒空格/分号/管道/`$`/反引号/前导 `-`）且 ping 加 `--`；`batch.rs` 有命令长度与并发上限；目录同步全程走 SFTP 协议，不拼 shell。
- **路径穿越**：`recording_store.rs` 文件名清洗 + 「清洗后精确比对」拒绝 `../`；`keys.rs` 的删除/读取经 `canonicalize` 后按路径分量比对，符号链接与同前缀兄弟目录逃逸均被阻断（除 B-3 的 `..` 漏网与 S-1 的写回注入）。
- **指纹校验**：变更走 `HostKeyVerdict::Changed` 硬阻断，绝不降级为「确认即放行」；仅未知主机弹确认。
- **锁与并发**：共享状态统一 tokio 锁；会话表锁从不与单会话 `conn`/`write` 锁嵌套持有；`close_transfer` / `sftp_upload_finish` 均为 `take()` 后释放再 await；无死锁环（除 R-4 的单点持锁时长）。
- **panic 面**：生产代码路径无 `unwrap` / `expect` / `panic!` / 切片索引；`pid` / `cpu_cores` / 限速 / 目录深度与条目预算均有界；`sum_transfer_bytes` 已 `checked_add`。
- **IPC 与事件**：`eventSchema` 版本守卫对所有事件订阅生效；63 个 command 全部在 `generate_handler!` 注册；输出 Channel id 回填已缓冲；终端输出丢弃计数与周期 warn 实现正确（首轮 R-3 修复有效）。
- **资源清理**：会话自然收尾 / disconnect / remove 三条路径均调用 `stop_forwards_for_session` + `cancel_transfers_for_session`；磁盘传输在取消/超时/错误/EOF 各分支都自行摘除条目，无僵尸泄漏；转发中继挂 `AbortHandle` 集合，撤销时 `abort_all`。
- **CSP**：生产 `script-src 'self'`、`object-src 'none'`、`base-uri 'self'`，无内联脚本；`unsafe-inline` 仅在 `style-src`（xterm/组件必需）；`devCsp` 的 script 放宽仅限开发期。
- **前端修复无回归**：StrictMode 的 `disposedRef` 复位（`SessionSftpPanel.tsx:104`）、目录加载 requestId、上传覆盖确认失败即中止、回放 `speedRef` + timeline memo + seek 分批、进程与目录列表 memo、快捷键 effect 依赖，均经本轮复核确认有效。全库仅一处 ref 型 disposed 标记（已修）。
- **本轮改造核验**：`with_sftp_timeout` / `close_sftp_quietly` / `close_sftp_checked` 三个 helper 实现正确（超时值选取合理、超时后连接锁随 future drop 释放、静默关闭仅用于已提交数据的收尾）；`isSafeBackgroundImage` 并未被放宽（仍拒反斜杠），`normalizeBackgroundImagePath` 只做 `\` → `/` 转换；新增 `about-*` 样式类均已定义。

## 八、建议修复顺序

1. **立即（安全 / 数据丢失）**
   - S-1 `~/.ssh/config` 写回字符白名单（唯一的 P0，且修复成本极低）
   - B-1 流式上传先写半成品、B-2 下载收尾改「改名 + 回滚」
   - B-3 递归删除拒绝 `.` / `..` 段
   - S-2 assetProtocol scope 收窄到专用背景目录
   - X-1 多跳私钥选择器修复（P1 功能失效，改动局部）
2. **本迭代（正确性与体验）**
   - B-5 修正超时层叠（外层 > 内部预算）、B-6 补齐覆盖不全的超时点
   - B-7 同步流改原子替换、B-4 并发占位原子化
   - B-8 重连退避后补检查、B-9 指纹确认表按会话隔离
   - X-3 AI 请求禁用重定向、X-4 响应体上限、X-2 解锁后凭据直传
   - B-16 错误码回归 `AppError`、B-15 锁定态删除给出反馈
   - P-1 行高对齐、P-4 删除二次确认、P-5 关于页失败反馈、P-6 录制缓冲上限
   - X-6 转发页会话校验、X-7 关标签顺序化
3. **随后（性能与一致性）**
   - S-3 / X-5 发布与 CI 工作流密钥与权限收窄、S-4 主加载路径校验
   - P-2 面板尺寸夹紧、P-3 主题保存串行化、P-7/P-8 落盘时机
   - B-10 ~ B-13（幽灵 connecting、回放 auto 主题、上传分片偏移与收尾校验）
4. **择机（卫生）**
   - R 组全部（悬空类名、i18n 补词、拖放过滤、错误码判定、bidi、统一卸载守卫等）
   - X-8 ~ X-14（导入 busy、审计映射、误译、录制原子写、边界校验、known_hosts 阻塞 IO、托盘快照）

> 说明：复核轮同样未做任何代码改动，全部 56 项均待修复。建议按批次提交（每批独立验证：`npm run lint` / `test` / `build` + `cargo fmt --check` / `clippy` / `test`）。
