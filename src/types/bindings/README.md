# ⚠️ 自动生成，勿手改

本目录由 Rust 侧 [ts-rs](https://github.com/Aleph-Alpha/ts-rs) 在
`cargo test export_bindings` 时生成（导出目录经 `src-tauri/.cargo/config.toml`
的 `TS_RS_EXPORT_DIR` 注入）。**不要手动编辑本目录下的 `.ts` 文件。**

## 用途

这是 Rust DTO 与前端 `src/types/*.ts` 手写类型之间的**对照源（source of truth）**：

- 修改 Rust DTO 字段（改名、增删、类型变化）后跑 `npm run bindings:check`，
  diff 即为对前端手写类型的同步要求；
- 前端手写类型仍是应用的公共 API（含窄化联合如 `status: SessionStatus`，
  Rust 侧为 `String`，ts-rs 无法表达），迁移到直接消费绑定属后续工作。

## 覆盖范围

跨 IPC 的 22 个 DTO（`ssh_manager/types.rs`、`sftp.rs`、`sync.rs`、`batch.rs`、
`config.rs`、`keys.rs`、`recording_store.rs`）。刻意**不**导出：

- `ConnectRequest` / `ProxyConfig`（递归类型 + 明文凭据，且安全约定不实现 Serialize；
  TS 派生虽不引入序列化，但前端 `host.ts` 已有稳定镜像）；
- 内部状态类型（`SyncJob` / `SftpDiskTransfer` / `SftpTransfer` / `ActiveSession` 等，
  不过 IPC）；
- 事件 payload（`mod.rs` 内以 `serde_json::json!` 内联构造，尚未结构化，见 6.15）。

## 约定

- 64 位整数（`u64` / `i64`）一律 `#[ts(type = "number")]` 覆盖：Tauri IPC 走 JSON，
  前端拿到的就是 number，ts-rs 默认的 bigint 不符合实际。
