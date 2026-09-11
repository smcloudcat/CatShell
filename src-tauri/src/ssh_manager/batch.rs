//! 批量命令执行聚合。
//!
//! 在每个选定会话的专用通道上执行同一条命令（通道协商在连接锁外完成，见
//! `SshManager::open_session_channel`），并发推进、逐台收集输出与耗时，
//! 单台失败不影响其余目标。

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::monitor::exec_command;
use super::SshManager;

/// 单台输出的最大收集字节数，超过即截断并标记 `truncated`。
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// 单次批量执行的目标会话数上限。
const MAX_BATCH_TARGETS: usize = 32;
/// 单条命令的最大长度。
const MAX_COMMAND_LEN: usize = 4096;
/// 批量执行超时的夹取区间（秒）。
pub const BATCH_MIN_TIMEOUT_SECS: u64 = 1;
pub const BATCH_MAX_TIMEOUT_SECS: u64 = 120;
const _: () = assert!(BATCH_MAX_TIMEOUT_SECS >= BATCH_MIN_TIMEOUT_SECS);

/// 一台会话的批量执行结果。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExecItem {
    pub session_id: u64,
    pub name: String,
    pub ok: bool,
    pub output: String,
    pub error: Option<String>,
    pub duration_ms: u64,
    pub truncated: bool,
}

impl SshManager {
    /// 在多个会话上并发执行同一条命令并聚合结果。
    ///
    /// - `session_ids` 自动去重、保持传入顺序，最多 `MAX_BATCH_TARGETS` 个；
    /// - `timeout_secs` 夹取到 `[MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS]`；
    /// - 校验失败整体返回 `Err`；单台执行失败记入该条的 `error`，不影响其他台。
    pub async fn batch_exec(
        self: Arc<Self>,
        session_ids: Vec<u64>,
        command: String,
        timeout_secs: u64,
    ) -> Result<Vec<BatchExecItem>, String> {
        let command = command.trim().to_string();
        if command.is_empty() {
            return Err("命令不能为空".to_string());
        }
        if command.len() > MAX_COMMAND_LEN {
            return Err("命令过长".to_string());
        }
        let mut ids: Vec<u64> = Vec::new();
        for id in session_ids {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        if ids.is_empty() {
            return Err("未选择目标会话".to_string());
        }
        if ids.len() > MAX_BATCH_TARGETS {
            return Err(format!("目标会话过多，一次最多 {MAX_BATCH_TARGETS} 个"));
        }
        let timeout =
            Duration::from_secs(timeout_secs.clamp(BATCH_MIN_TIMEOUT_SECS, BATCH_MAX_TIMEOUT_SECS));

        let mut handles = Vec::with_capacity(ids.len());
        for id in ids {
            let manager = Arc::clone(&self);
            let command = command.clone();
            handles.push(tokio::spawn(async move {
                exec_on_session(manager, id, command, timeout).await
            }));
        }

        let mut items = Vec::with_capacity(handles.len());
        for handle in handles {
            // 任务只返回值不 panic；即便真的 panic，也归一成该台的失败结果而不是整个应用退出。
            items.push(handle.await.unwrap_or_else(|error| BatchExecItem {
                session_id: 0,
                name: String::new(),
                ok: false,
                output: String::new(),
                error: Some(format!("批量执行任务异常: {error}")),
                duration_ms: 0,
                truncated: false,
            }));
        }
        Ok(items)
    }
}

async fn exec_on_session(
    manager: Arc<SshManager>,
    id: u64,
    command: String,
    timeout: Duration,
) -> BatchExecItem {
    let started = Instant::now();
    let name = manager
        .session_ref(id)
        .await
        .map(|session| session.info.name.clone())
        .unwrap_or_else(|_| format!("#{id}"));
    let result = async {
        let channel = manager.open_session_channel(id).await?;
        exec_command(channel, &command, timeout).await
    }
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(bytes) => {
            let truncated = bytes.len() > MAX_OUTPUT_BYTES;
            let clipped = if truncated {
                &bytes[..MAX_OUTPUT_BYTES]
            } else {
                &bytes[..]
            };
            BatchExecItem {
                session_id: id,
                name,
                ok: true,
                output: String::from_utf8_lossy(clipped).to_string(),
                error: None,
                duration_ms,
                truncated,
            }
        }
        Err(error) => BatchExecItem {
            session_id: id,
            name,
            ok: false,
            output: String::new(),
            error: Some(error),
            duration_ms,
            truncated: false,
        },
    }
}
