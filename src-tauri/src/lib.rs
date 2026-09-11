pub mod launch;
pub mod logging;
pub mod recording_store;
pub mod ssh_manager;

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use launch::CliConnectPayload;
use ssh_manager::{
    load_known_hosts_snapshot, remove_known_hosts_entry, ConnectRequest, EventSink,
    NetworkDiagnostic, PortForwardInfo, ProcessInfo, RawOutput, ServerMetrics, SessionInfo,
    SftpChunk, SftpEntry, SftpTransferStart, SshConfigEntry, SshManager,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

/// 托盘「快捷连接」里的一条主机档案（id + 显示名）。前端推送、托盘菜单消费。
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayQuickConnect {
    pub id: String,
    pub name: String,
}

/// 托盘快捷连接清单：前端在主机档案变化时推送，托盘菜单据此重建。
#[derive(Default)]
pub struct TrayState {
    pub quick_connects: tokio::sync::Mutex<Vec<TrayQuickConnect>>,
}

/// 启动参数里的连接意图：首启动解析一次，前端经 `cli_launch_request` 取用。
#[derive(Default)]
pub struct CliState {
    pub initial: tokio::sync::Mutex<Option<CliConnectPayload>>,
}

pub struct AppState {
    pub ssh: Arc<SshManager>,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            ssh: Arc::new(SshManager::default()),
        }
    }
}

struct AppEventSink(AppHandle);

impl EventSink for AppEventSink {
    fn emit(&self, name: &str, payload: serde_json::Value) {
        let _ = self.0.emit(name, payload);
    }
}

/// 终端输出原始字节通道：把 SSH 输出直接以二进制推送到前端，
/// 免去 base64 编码与 JSON 序列化开销。
struct ChannelOutput(Channel<InvokeResponseBody>);

impl RawOutput for ChannelOutput {
    fn send_bytes(&self, data: Vec<u8>) -> Result<(), String> {
        self.0
            .send(InvokeResponseBody::Raw(data))
            .map_err(|error| error.to_string())
    }
}

fn decode_base64_payload(data: &str) -> Result<Vec<u8>, String> {
    BASE64_STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "二进制数据解码失败".to_string())
}

#[tauri::command]
async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ConnectRequest,
    on_output: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    let sink: Arc<dyn EventSink> = Arc::new(AppEventSink(app));
    let output: Arc<dyn RawOutput> = Arc::new(ChannelOutput(on_output));
    state
        .ssh
        .create(state.ssh.clone(), sink, Some(output), request)
        .await
}

#[tauri::command]
async fn ssh_write(state: State<'_, AppState>, id: u64, data: String) -> Result<(), String> {
    let data = decode_base64_payload(&data)?;
    state.ssh.write(id, data).await
}

#[tauri::command]
async fn ssh_resize(
    state: State<'_, AppState>,
    id: u64,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    state.ssh.resize(id, cols, rows).await
}

#[tauri::command]
async fn ssh_disconnect(app: AppHandle, state: State<'_, AppState>, id: u64) -> Result<(), String> {
    let sink: Arc<dyn EventSink> = Arc::new(AppEventSink(app));
    state.ssh.disconnect(sink, id).await;
    Ok(())
}

#[tauri::command]
async fn ssh_remove(state: State<'_, AppState>, id: u64) -> Result<(), String> {
    state.ssh.remove(id).await;
    Ok(())
}

#[tauri::command]
async fn ssh_list(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    Ok(state.ssh.list().await)
}

#[tauri::command]
async fn ssh_monitor(state: State<'_, AppState>, id: u64) -> Result<ServerMetrics, String> {
    state.ssh.monitor(id).await
}

#[tauri::command]
async fn ssh_processes(state: State<'_, AppState>, id: u64) -> Result<Vec<ProcessInfo>, String> {
    state.ssh.list_processes(id).await
}

#[tauri::command]
async fn ssh_kill_process(
    state: State<'_, AppState>,
    id: u64,
    pid: u32,
    signal: String,
) -> Result<(), String> {
    state.ssh.kill_process(id, pid, &signal).await
}

/// 批量在多个会话上执行同一条命令并聚合输出。危险操作由前端负责二次确认与审计。
#[tauri::command]
async fn ssh_batch_exec(
    state: State<'_, AppState>,
    session_ids: Vec<u64>,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<Vec<ssh_manager::BatchExecItem>, String> {
    state
        .ssh
        .clone()
        .batch_exec(session_ids, command, timeout_secs.unwrap_or(10))
        .await
}

#[tauri::command]
async fn ssh_network_diagnostic(
    state: State<'_, AppState>,
    id: u64,
    kind: String,
    target: String,
) -> Result<NetworkDiagnostic, String> {
    state.ssh.network_diagnostic(id, kind, target).await
}

#[tauri::command]
async fn ssh_forward_start(
    state: State<'_, AppState>,
    id: u64,
    bind_host: String,
    bind_port: u16,
    target_host: String,
    target_port: u16,
) -> Result<PortForwardInfo, String> {
    state
        .ssh
        .start_local_forward(
            state.ssh.clone(),
            id,
            bind_host,
            bind_port,
            target_host,
            target_port,
        )
        .await
}

#[tauri::command]
async fn ssh_forward_start_remote(
    state: State<'_, AppState>,
    id: u64,
    bind_host: String,
    bind_port: u16,
    target_host: String,
    target_port: u16,
) -> Result<PortForwardInfo, String> {
    state
        .ssh
        .start_remote_forward(id, bind_host, bind_port, target_host, target_port)
        .await
}

#[tauri::command]
async fn ssh_forward_start_dynamic(
    state: State<'_, AppState>,
    id: u64,
    bind_host: String,
    bind_port: u16,
) -> Result<PortForwardInfo, String> {
    state
        .ssh
        .start_dynamic_forward(state.ssh.clone(), id, bind_host, bind_port)
        .await
}

#[tauri::command]
async fn ssh_forward_list(state: State<'_, AppState>) -> Result<Vec<PortForwardInfo>, String> {
    Ok(state.ssh.list_local_forwards().await)
}

#[tauri::command]
async fn ssh_forward_stop(state: State<'_, AppState>, forward_id: u64) -> Result<(), String> {
    state.ssh.stop_forward(forward_id).await
}

#[tauri::command]
async fn sftp_list(
    state: State<'_, AppState>,
    id: u64,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    state.ssh.sftp_list(id, path).await
}

#[tauri::command]
async fn sftp_read_file(
    state: State<'_, AppState>,
    id: u64,
    path: String,
) -> Result<String, String> {
    let data = state.ssh.sftp_read_file(id, path).await?;
    Ok(BASE64_STANDARD.encode(data))
}

#[tauri::command]
async fn sftp_write_file(
    state: State<'_, AppState>,
    id: u64,
    path: String,
    data: String,
) -> Result<(), String> {
    let data = decode_base64_payload(&data)?;
    state.ssh.sftp_write_file(id, path, data).await
}

#[tauri::command]
async fn sftp_remove_file(state: State<'_, AppState>, id: u64, path: String) -> Result<(), String> {
    state.ssh.sftp_remove_file(id, path).await
}

#[tauri::command]
async fn sftp_remove_dir(state: State<'_, AppState>, id: u64, path: String) -> Result<(), String> {
    state.ssh.sftp_remove_dir(id, path).await
}

#[tauri::command]
async fn sftp_mkdir(state: State<'_, AppState>, id: u64, path: String) -> Result<(), String> {
    state.ssh.sftp_mkdir(id, path).await
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, AppState>,
    id: u64,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    state.ssh.sftp_rename(id, from_path, to_path).await
}

#[tauri::command]
async fn sftp_chmod(
    state: State<'_, AppState>,
    id: u64,
    path: String,
    mode: u32,
) -> Result<(), String> {
    state.ssh.sftp_chmod(id, path, mode).await
}

#[tauri::command]
async fn sftp_download_begin(
    state: State<'_, AppState>,
    id: u64,
    path: String,
) -> Result<SftpTransferStart, String> {
    state.ssh.sftp_download_begin(id, path).await
}

#[tauri::command]
async fn sftp_download_chunk(
    state: State<'_, AppState>,
    transfer_id: u64,
) -> Result<SftpChunk, String> {
    state.ssh.sftp_download_chunk(transfer_id).await
}

#[tauri::command]
async fn sftp_upload_begin(
    state: State<'_, AppState>,
    id: u64,
    path: String,
    total: u64,
) -> Result<SftpTransferStart, String> {
    state.ssh.sftp_upload_begin(id, path, total).await
}

#[tauri::command]
async fn sftp_upload_chunk(
    state: State<'_, AppState>,
    transfer_id: u64,
    offset: u64,
    data: String,
) -> Result<(), String> {
    let data = decode_base64_payload(&data)?;
    state.ssh.sftp_upload_chunk(transfer_id, offset, data).await
}

#[tauri::command]
async fn sftp_upload_finish(state: State<'_, AppState>, transfer_id: u64) -> Result<(), String> {
    state.ssh.sftp_upload_finish(transfer_id).await
}

#[tauri::command]
async fn sftp_transfer_cancel(state: State<'_, AppState>, transfer_id: u64) -> Result<(), String> {
    state.ssh.sftp_transfer_cancel(transfer_id).await
}

/// 打开保存对话框选择本地目标路径并启动磁盘级下载（本地路径不出 Rust 边界）。
#[tauri::command]
async fn sftp_disk_download_pick(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    remote_path: String,
    resume: bool,
    speed_limit_kbs: Option<u64>,
) -> Result<Option<ssh_manager::SftpDiskTransferStart>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_name = std::path::Path::new(&remote_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| "远程路径无效".to_string())?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&file_name)
        .save_file(move |file_path| {
            let picked = file_path.and_then(|path| path.into_path().ok());
            let _ = tx.send(picked);
        });
    let picked = rx.await.map_err(|_| "保存对话框已关闭".to_string())?;
    let Some(local_path) = picked else {
        return Ok(None);
    };
    let local_path = local_path.to_string_lossy().to_string();
    let sink: Arc<dyn EventSink> = Arc::new(AppEventSink(app));
    state
        .ssh
        .sftp_disk_download_start(
            state.ssh.clone(),
            sink,
            id,
            remote_path,
            local_path,
            resume,
            speed_limit_kbs.unwrap_or(0),
        )
        .await
        .map(Some)
}

/// 打开目录选择对话框（SFTP 目录同步的本地侧入口），路径仅随选中结果返回。
#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |file_path| {
        let picked = file_path.and_then(|path| path.into_path().ok());
        let _ = tx.send(picked);
    });
    let picked = rx.await.map_err(|_| "目录选择对话框已关闭".to_string())?;
    Ok(picked.map(|path| path.to_string_lossy().to_string()))
}

/// 生成 SFTP 目录同步计划（扫描两侧目录树、产出差异动作清单供前端预览确认）。
#[tauri::command]
async fn sftp_sync_plan(
    state: State<'_, AppState>,
    id: u64,
    direction: String,
    local_dir: String,
    remote_dir: String,
) -> Result<ssh_manager::SyncPlan, String> {
    state
        .ssh
        .sftp_sync_plan(id, direction, local_dir, remote_dir)
        .await
}

/// 启动 SFTP 目录同步执行（后台逐文件串行，进度经 sftp-sync-progress 事件推送）。
#[tauri::command]
async fn sftp_sync_start(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    direction: String,
    local_dir: String,
    remote_dir: String,
    entries: Vec<ssh_manager::SyncPlanEntry>,
) -> Result<ssh_manager::SyncStartInfo, String> {
    let sink: Arc<dyn EventSink> = Arc::new(AppEventSink(app));
    state
        .ssh
        .sftp_sync_start(
            state.ssh.clone(),
            sink,
            id,
            direction,
            local_dir,
            remote_dir,
            entries,
        )
        .await
}

/// 取消会话进行中的目录同步任务。返回是否存在任务。
#[tauri::command]
async fn sftp_sync_cancel(state: State<'_, AppState>, id: u64) -> Result<bool, String> {
    Ok(state.ssh.sftp_sync_cancel(id).await)
}

/// 打开文件对话框选择要上传的本地文件并登记一次性令牌（真实路径不出 Rust 边界）。
#[tauri::command]
async fn sftp_disk_upload_pick(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    remote_dir: String,
) -> Result<Vec<ssh_manager::SftpDiskUploadPick>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |file_paths| {
        let picked = file_paths
            .map(|paths| {
                paths
                    .into_iter()
                    .filter_map(|path| path.into_path().ok())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let _ = tx.send(picked);
    });
    let picked = rx.await.map_err(|_| "文件对话框已关闭".to_string())?;
    if picked.is_empty() {
        return Ok(Vec::new());
    }
    let remote_dir = remote_dir.trim_end_matches('/').to_string();
    let remote_dir = if remote_dir.is_empty() {
        "/".to_string()
    } else {
        remote_dir
    };
    let files = picked
        .into_iter()
        .filter_map(|path| {
            let file_name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())?;
            let remote_path = format!("{remote_dir}/{file_name}");
            ssh_manager::validate_sftp_path(remote_path)
                .ok()
                .map(|remote_path| (path.to_string_lossy().to_string(), remote_path, file_name))
        })
        .collect::<Vec<_>>();
    if files.is_empty() {
        return Err("所选文件路径无效".to_string());
    }
    Ok(state.ssh.register_upload_tokens(id, files).await)
}

/// 凭一次性令牌启动磁盘级上传（本地路径仅存于 Rust 侧）。
#[tauri::command]
async fn sftp_disk_upload_start_token(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    token: u64,
    resume: bool,
    speed_limit_kbs: Option<u64>,
) -> Result<ssh_manager::SftpDiskTransferStart, String> {
    let picked = state.ssh.consume_upload_token(id, token).await?;
    let sink: Arc<dyn EventSink> = Arc::new(AppEventSink(app));
    state
        .ssh
        .sftp_disk_upload_start(
            state.ssh.clone(),
            sink,
            id,
            picked.local_path,
            picked.remote_path,
            resume,
            speed_limit_kbs.unwrap_or(0),
        )
        .await
}

/// 队列续传（下载）：不经对话框，以持久化队列中记录的显式本地路径启动磁盘级下载，
/// 恒为断点续传模式。路径经 validate_local_path 校验，防止路径穿越。
#[tauri::command]
async fn sftp_disk_download_start_path(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    remote_path: String,
    local_path: String,
    speed_limit_kbs: Option<u64>,
) -> Result<ssh_manager::SftpDiskTransferStart, String> {
    let sink: Arc<dyn EventSink> = Arc::new(AppEventSink(app));
    state
        .ssh
        .sftp_disk_download_start(
            state.ssh.clone(),
            sink,
            id,
            remote_path,
            local_path,
            true,
            speed_limit_kbs.unwrap_or(0),
        )
        .await
}

/// 队列续传（上传）：以持久化队列中记录的显式本地路径启动磁盘级上传，
/// 恒为断点续传模式。本地文件必须真实存在（validate_local_path + 存在性检查在核心方法内）。
#[tauri::command]
async fn sftp_disk_upload_start_path(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    local_path: String,
    remote_path: String,
    speed_limit_kbs: Option<u64>,
) -> Result<ssh_manager::SftpDiskTransferStart, String> {
    let sink: Arc<dyn EventSink> = Arc::new(AppEventSink(app));
    state
        .ssh
        .sftp_disk_upload_start(
            state.ssh.clone(),
            sink,
            id,
            local_path,
            remote_path,
            true,
            speed_limit_kbs.unwrap_or(0),
        )
        .await
}

#[tauri::command]
async fn sftp_disk_transfer_cancel(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: u64,
) -> Result<(), String> {
    let sink: Arc<dyn EventSink> = Arc::new(AppEventSink(app));
    state.ssh.sftp_disk_transfer_cancel(sink, transfer_id).await
}

/// 运行中动态调整磁盘传输的带宽限速（KB/s，0 = 不限）。
#[tauri::command]
async fn sftp_disk_transfer_set_limit(
    state: State<'_, AppState>,
    transfer_id: u64,
    speed_limit_kbs: u64,
) -> Result<(), String> {
    state
        .ssh
        .sftp_disk_transfer_set_limit(transfer_id, speed_limit_kbs)
        .await
}

#[tauri::command]
async fn sftp_disk_transfer_list(
    state: State<'_, AppState>,
    id: u64,
) -> Result<Vec<ssh_manager::SftpDiskTransferInfo>, String> {
    state.ssh.sftp_disk_transfer_list(id).await
}

#[tauri::command]
async fn kbi_respond(
    state: State<'_, AppState>,
    session_id: u64,
    answers: Vec<String>,
) -> Result<(), String> {
    state.ssh.answer_kbi(session_id, answers).await
}

#[tauri::command]
async fn ssh_ping(state: State<'_, AppState>, id: u64) -> Result<u64, String> {
    state.ssh.ping(id).await
}

/// 更新系统托盘状态：有活动会话时显示绿色角标图标与会话数提示。
#[tauri::command]
async fn tray_set_active_count(app: AppHandle, count: u64) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let tray = app.tray_by_id("main-tray");
        let Some(tray) = tray else {
            return Ok(());
        };
        if count > 0 {
            let _ = tray.set_icon(Some(active_tray_image()));
            let _ = tray.set_tooltip(Some(format!("CatShell · {count} 个活动会话")));
        } else {
            if let Some(icon) = app.default_window_icon() {
                let _ = tray.set_icon(Some(icon.clone()));
            }
            let _ = tray.set_tooltip(Some("CatShell"));
        }
    }
    #[cfg(not(desktop))]
    let _ = (app, count);
    Ok(())
}

/// 前端取首启动的命令行连接意图（`catshell user@host` / `catshell 档案名`）。
/// 不清除：dev 模式页面重载后仍能恢复意图，前端侧按一次性消费。
#[tauri::command]
async fn cli_launch_request(
    state: State<'_, CliState>,
) -> Result<Option<CliConnectPayload>, String> {
    Ok(state.initial.lock().await.clone())
}

/// 前端推送托盘「快捷连接」清单（主机档案变化时调用），并重建托盘菜单。
#[tauri::command]
async fn tray_set_quick_connects(
    app: AppHandle,
    state: State<'_, TrayState>,
    items: Vec<TrayQuickConnect>,
) -> Result<(), String> {
    *state.quick_connects.lock().await = items;
    let snapshot = state.quick_connects.lock().await.clone();
    rebuild_tray_menu(&app, &snapshot)
}

/// AI 请求参数：端点 / 密钥 / 模型全部由前端每次传入，Rust 侧不落盘、不进审计。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiCompleteRequest {
    endpoint: String,
    api_key: Option<String>,
    model: String,
    /// 完整的 OpenAI chat 格式消息序列（前端拼好 system / user）。
    messages: Vec<AiChatMessage>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    temperature: Option<f32>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AiChatMessage {
    role: String,
    content: String,
}

/// 调用用户配置的 OpenAI 兼容 `/chat/completions` 接口（AI 辅助，6.17）。
/// 无状态透传：CatShell 不内置任何模型服务，网络与凭据行为完全由用户配置决定。
#[tauri::command]
async fn ai_complete(request: AiCompleteRequest) -> Result<String, String> {
    let endpoint = request.endpoint.trim().trim_end_matches('/').to_string();
    if endpoint.is_empty() {
        return Err("AI 接口地址未配置".to_string());
    }
    if request.model.trim().is_empty() {
        return Err("AI 模型名未配置".to_string());
    }
    if request.messages.is_empty() {
        return Err("AI 请求内容为空".to_string());
    }
    let url = format!("{endpoint}/chat/completions");
    let mut body = serde_json::json!({
        "model": request.model.trim(),
        "messages": request.messages,
        "stream": false,
    });
    if let Some(max_tokens) = request.max_tokens {
        body["max_tokens"] = serde_json::json!(max_tokens);
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败: {error}"))?;
    let mut http = client.post(&url).json(&body);
    if let Some(key) = request.api_key.as_deref() {
        let key = key.trim();
        if !key.is_empty() {
            http = http.bearer_auth(key);
        }
    }
    let response = http
        .send()
        .await
        .map_err(|error| format!("请求 AI 接口失败: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取 AI 响应失败: {error}"))?;
    if !status.is_success() {
        // 截断错误体，避免超长 HTML 错误页刷屏。
        let snippet: String = text.chars().take(400).collect();
        return Err(format!("AI 接口返回 {status}: {snippet}"));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("解析 AI 响应失败: {error}"))?;
    parsed
        .pointer("/choices/0/message/content")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            format!("AI 响应缺少 choices[0].message.content: {}", {
                let snippet: String = text.chars().take(200).collect();
                snippet
            })
        })
}

/// 依据快捷连接清单重建托盘菜单（快捷连接子菜单 + 显示 / 退出）。
#[cfg(desktop)]
fn rebuild_tray_menu(app: &AppHandle, quick: &[TrayQuickConnect]) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, Submenu};

    let tray = app.tray_by_id("main-tray").ok_or("托盘未初始化")?;
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "退出 CatShell", true, None::<&str>)
        .map_err(|error| error.to_string())?;

    let submenu = Submenu::with_id(app, "quick-connect", "快捷连接", true)
        .map_err(|error| error.to_string())?;
    if quick.is_empty() {
        let empty = MenuItem::with_id(app, "qc-empty", "暂无主机档案", false, None::<&str>)
            .map_err(|error| error.to_string())?;
        submenu.append(&empty).map_err(|error| error.to_string())?;
    } else {
        for item in quick.iter().take(15) {
            // 显示名可能重复，菜单 id 用档案 id 保证唯一。
            let entry = MenuItem::with_id(
                app,
                format!("qc:{}", item.id),
                &item.name,
                true,
                None::<&str>,
            )
            .map_err(|error| error.to_string())?;
            submenu.append(&entry).map_err(|error| error.to_string())?;
        }
    }
    let menu =
        Menu::with_items(app, &[&submenu, &show, &quit]).map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}

#[cfg(not(desktop))]
fn rebuild_tray_menu(_app: &AppHandle, _quick: &[TrayQuickConnect]) -> Result<(), String> {
    Ok(())
}

/// 生成活动会话角标图标：32x32 绿色圆点。
#[cfg(desktop)]
fn active_tray_image() -> tauri::image::Image<'static> {
    const SIZE: usize = 32;
    let mut rgba = vec![0_u8; SIZE * SIZE * 4];
    let center = (SIZE as f32 - 1.0) / 2.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let distance = (dx * dx + dy * dy).sqrt();
            if distance <= 11.0 {
                let index = (y * SIZE + x) * 4;
                rgba[index] = 34;
                rgba[index + 1] = 197;
                rgba[index + 2] = 94;
                rgba[index + 3] = if distance <= 9.5 { 255 } else { 160 };
            }
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}

#[tauri::command]
async fn ssh_confirm_host_key(
    state: State<'_, AppState>,
    token: String,
    accepted: bool,
) -> Result<(), String> {
    state.ssh.confirm_host_key(token, accepted).await
}

#[tauri::command]
async fn known_hosts_list(
    state: State<'_, AppState>,
) -> Result<ssh_manager::KnownHostsSnapshot, String> {
    let path = state.ssh.effective_known_hosts_path().await;
    load_known_hosts_snapshot(path.as_deref())
}

#[tauri::command]
async fn known_hosts_remove(
    state: State<'_, AppState>,
    pattern: String,
    key_type: String,
) -> Result<usize, String> {
    if pattern.trim().is_empty() || key_type.trim().is_empty() {
        return Err("主机指纹条目无效".to_string());
    }
    let path = state.ssh.effective_known_hosts_path().await;
    remove_known_hosts_entry(path.as_deref(), pattern.trim(), key_type.trim())
}

/// 切换 known_hosts 存储策略：openssh = ~/.ssh/known_hosts（默认），appdata = 应用数据目录独立存储。
///
/// 注意（P2-4）：`openssh` 模式会直接读写用户真实的 `~/.ssh/known_hosts`——这与 OpenSSH
/// 命令行共享同一份文件，删除条目会影响 `ssh` 命令行的信任状态。前端在切回该模式前必须
/// 明确告知用户这一副作用。
#[tauri::command]
async fn known_hosts_set_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
) -> Result<(), String> {
    match mode.as_str() {
        "openssh" => {
            state.ssh.set_known_hosts_path(None).await;
        }
        "appdata" => {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|_| "无法定位应用数据目录".to_string())?;
            std::fs::create_dir_all(&dir).map_err(|err| format!("创建应用数据目录失败: {err}"))?;
            state
                .ssh
                .set_known_hosts_path(Some(&dir.join("known_hosts")))
                .await;
        }
        other => return Err(format!("未知的 known_hosts 存储模式: {other}")),
    }
    Ok(())
}

// ------------------------------------------------------------------
// 录制存储（asciicast v2）。录制采集在前端输出流上，这里只负责落盘与读取。
// ------------------------------------------------------------------

fn recordings_dir_of(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录".to_string())?;
    recording_store::ensure_recordings_dir(&dir)
}

#[tauri::command]
async fn recording_save(
    app: AppHandle,
    base_name: String,
    content: String,
) -> Result<recording_store::RecordingMeta, String> {
    let dir = recordings_dir_of(&app)?;
    // 文件写入很快，直接放 async 上下文执行可接受；用 spawn_blocking 隔离潜在的磁盘阻塞。
    tokio::task::spawn_blocking(move || recording_store::save_recording(&dir, &base_name, &content))
        .await
        .map_err(|error| format!("保存任务异常: {error}"))?
}

#[tauri::command]
async fn recording_list(app: AppHandle) -> Result<Vec<recording_store::RecordingMeta>, String> {
    let dir = recordings_dir_of(&app)?;
    Ok(recording_store::list_recordings(&dir))
}

#[tauri::command]
async fn recording_read(app: AppHandle, name: String) -> Result<String, String> {
    let dir = recordings_dir_of(&app)?;
    tokio::task::spawn_blocking(move || recording_store::read_recording(&dir, &name))
        .await
        .map_err(|error| format!("读取任务异常: {error}"))?
}

#[tauri::command]
async fn recording_delete(app: AppHandle, name: String) -> Result<(), String> {
    let dir = recordings_dir_of(&app)?;
    tokio::task::spawn_blocking(move || recording_store::delete_recording(&dir, &name))
        .await
        .map_err(|error| format!("删除任务异常: {error}"))?
}

#[tauri::command]
async fn ssh_config_parse() -> Result<Vec<SshConfigEntry>, String> {
    let path = ssh_manager::ssh_config_path().ok_or_else(|| "无法定位用户主目录".to_string())?;
    if !path.exists() {
        return Err("未找到 ~/.ssh/config 文件".to_string());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|err| format!("读取 ~/.ssh/config 失败: {err}"))?;
    Ok(ssh_manager::parse_ssh_config(&content))
}

/// 生成 Ed25519 密钥对（可选口令加密），写入私钥与 `.pub` 公钥文件。
#[tauri::command]
async fn keypair_generate(
    private_path: String,
    passphrase: Option<String>,
    comment: String,
    overwrite: bool,
) -> Result<ssh_manager::GeneratedKeypair, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ssh_manager::generate_keypair(&private_path, passphrase.as_deref(), &comment, overwrite)
    })
    .await
    .map_err(|error| format!("生成任务异常: {error}"))?
}

/// 浏览 `~/.ssh` 目录：密钥成组展示（私钥 + `.pub`，含类型与 SHA256 指纹），其余文件列出。
#[tauri::command]
async fn keypair_list() -> Result<Vec<ssh_manager::SshKeyEntry>, String> {
    tauri::async_runtime::spawn_blocking(ssh_manager::list_keys)
        .await
        .map_err(|error| format!("扫描任务异常: {error}"))?
}

/// 删除密钥对（私钥 + `.pub`）。仅允许 `~/.ssh` 内可识别的私钥文件。
#[tauri::command]
async fn keypair_delete(private_path: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_manager::delete_keypair(&private_path))
        .await
        .map_err(|error| format!("删除任务异常: {error}"))?
}

/// 读取公钥单行内容（传入私钥路径时自动找同名 `.pub`），用于复制到剪贴板。
#[tauri::command]
async fn keypair_public_key(private_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ssh_manager::read_public_key(&private_path))
        .await
        .map_err(|error| format!("读取任务异常: {error}"))?
}

/// 把主机档案写回 `~/.ssh/config`（同名 Host 块替换、其余保留、先备份再原子替换）。
#[tauri::command]
async fn ssh_config_write(
    drafts: Vec<ssh_manager::HostConfigDraft>,
) -> Result<(usize, usize), String> {
    tauri::async_runtime::spawn_blocking(move || ssh_manager::write_ssh_config(&drafts))
        .await
        .map_err(|error| format!("写回任务异常: {error}"))?
}

#[cfg(desktop)]
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 日志目录：应用数据目录下的 `logs/`。取不到时返回 `None`，退化为仅输出到 stdout。
fn log_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    match app.path().app_data_dir() {
        Ok(dir) => Some(dir.join("logs")),
        Err(error) => {
            eprintln!("无法解析应用数据目录，日志将只输出到 stdout: {error}");
            None
        }
    }
}

pub fn run() {
    // 解析命令行连接意图（`catshell user@host[:port]` / `catshell 档案名`）：
    // 首启动存入 CliState 供前端取用；second-instance 路径在回调里另行解析转发。
    let launch_intent = launch::parse_cli_connect(&std::env::args().skip(1).collect::<Vec<_>>());
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 第二实例的启动参数也可能携带连接意图：转发给主窗口后只显示窗口。
            if let Some(intent) = launch::parse_cli_connect(&args) {
                let payload = serde_json::json!({
                    "v": ssh_manager::EVENT_SCHEMA_VERSION,
                    "kind": intent.kind,
                    "user": intent.user,
                    "host": intent.host,
                    "port": intent.port,
                    "name": intent.name,
                });
                let _ = app.emit("cli-connect", payload);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .manage(CliState {
            initial: tokio::sync::Mutex::new(launch_intent),
        })
        .manage(TrayState::default())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            ssh_remove,
            ssh_list,
            ssh_ping,
            kbi_respond,
            ssh_confirm_host_key,
            known_hosts_list,
            known_hosts_remove,
            known_hosts_set_mode,
            recording_save,
            recording_list,
            recording_read,
            recording_delete,
            ssh_config_parse,
            keypair_generate,
            keypair_list,
            keypair_delete,
            keypair_public_key,
            ssh_config_write,
            ssh_monitor,
            ssh_processes,
            ssh_kill_process,
            ssh_batch_exec,
            ssh_network_diagnostic,
            ssh_forward_start,
            ssh_forward_start_remote,
            ssh_forward_start_dynamic,
            ssh_forward_list,
            ssh_forward_stop,
            sftp_list,
            sftp_read_file,
            sftp_write_file,
            sftp_remove_file,
            sftp_remove_dir,
            sftp_mkdir,
            sftp_rename,
            sftp_chmod,
            sftp_download_begin,
            sftp_download_chunk,
            sftp_upload_begin,
            sftp_upload_chunk,
            sftp_upload_finish,
            sftp_transfer_cancel,
            sftp_disk_download_pick,
            sftp_disk_download_start_path,
            sftp_disk_upload_pick,
            sftp_disk_upload_start_token,
            sftp_disk_upload_start_path,
            sftp_disk_transfer_cancel,
            sftp_disk_transfer_set_limit,
            pick_directory,
            sftp_sync_plan,
            sftp_sync_start,
            sftp_sync_cancel,
            sftp_disk_transfer_list,
            tray_set_active_count,
            ai_complete,
            cli_launch_request,
            tray_set_quick_connects
        ])
        .setup(|app| {
            // release 构建没有控制台，日志必须落盘才能事后追查连接/传输故障。
            // 日志级别可用环境变量 CATSHELL_LOG 覆盖，默认 info。
            let log_guard = logging::init(log_dir(app.handle()));
            app.manage(log_guard);

            #[cfg(desktop)]
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
                let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "退出 CatShell", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &quit])?;
                let mut tray = TrayIconBuilder::with_id("main-tray")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .tooltip("CatShell");
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    if let Some(host_id) = id.strip_prefix("qc:") {
                        // 托盘快捷连接：把档案 id 交给前端走共用直连链路。
                        let payload = serde_json::json!({
                            "v": ssh_manager::EVENT_SCHEMA_VERSION,
                            "hostId": host_id,
                        });
                        let _ = app.emit("tray-quick-connect", payload);
                        show_main_window(app);
                        return;
                    }
                    match id {
                        "show" => show_main_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            }

            // 后台回收前端已放弃的 SFTP 流式传输：这类传输如果不回收，
            // 其持有的 SSH 通道会一直滞留到进程退出（长时运行的运维工具会持续累积）。
            // 新建传输时也会顺带回收一次，这里负责「长时间不再发起传输」的场景。
            let manager = app.state::<AppState>().ssh.clone();
            tauri::async_runtime::spawn(async move {
                const REAP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5 * 60);
                loop {
                    tokio::time::sleep(REAP_INTERVAL).await;
                    let _ = manager
                        .reap_idle_transfers(std::time::Duration::from_secs(10 * 60))
                        .await;
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri_plugin_window_state::AppHandleExt as _;
                use tauri_plugin_window_state::StateFlags;
                let _ = app.save_window_state(StateFlags::all());
            }
        });
}
