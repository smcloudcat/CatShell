pub mod ssh_manager;

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use ssh_manager::{
    load_known_hosts_snapshot, remove_known_hosts_entry, ConnectRequest, EventSink,
    NetworkDiagnostic, PortForwardInfo, ProcessInfo, ServerMetrics, SessionInfo, SftpChunk,
    SftpEntry, SftpTransferStart, SshConfigEntry, SshManager,
};
use tauri::{AppHandle, Emitter, State};

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
) -> Result<u64, String> {
    let sink: Arc<dyn EventSink> = Arc::new(AppEventSink(app));
    state.ssh.create(state.ssh.clone(), sink, request).await
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

#[tauri::command]
async fn ssh_confirm_host_key(
    state: State<'_, AppState>,
    token: String,
    accepted: bool,
) -> Result<(), String> {
    state.ssh.confirm_host_key(token, accepted).await
}

#[tauri::command]
async fn known_hosts_list() -> Result<ssh_manager::KnownHostsSnapshot, String> {
    load_known_hosts_snapshot(None)
}

#[tauri::command]
async fn known_hosts_remove(pattern: String, key_type: String) -> Result<usize, String> {
    if pattern.trim().is_empty() || key_type.trim().is_empty() {
        return Err("主机指纹条目无效".to_string());
    }
    remove_known_hosts_entry(None, pattern.trim(), key_type.trim())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            ssh_remove,
            ssh_list,
            ssh_confirm_host_key,
            known_hosts_list,
            known_hosts_remove,
            ssh_config_parse,
            ssh_monitor,
            ssh_processes,
            ssh_kill_process,
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
            sftp_download_begin,
            sftp_download_chunk,
            sftp_upload_begin,
            sftp_upload_chunk,
            sftp_upload_finish,
            sftp_transfer_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
