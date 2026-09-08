pub mod ssh_manager;

use std::sync::Arc;

use ssh_manager::{
    ConnectRequest, EventSink, NetworkDiagnostic, PortForwardInfo, ProcessInfo, ServerMetrics,
    SessionInfo, SftpEntry, SshManager,
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
async fn ssh_write(state: State<'_, AppState>, id: u64, data: Vec<u8>) -> Result<(), String> {
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
async fn ssh_kill_process(state: State<'_, AppState>, id: u64, pid: u32) -> Result<(), String> {
    state.ssh.kill_process(id, pid).await
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
) -> Result<Vec<u8>, String> {
    state.ssh.sftp_read_file(id, path).await
}

#[tauri::command]
async fn sftp_write_file(
    state: State<'_, AppState>,
    id: u64,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    state.ssh.sftp_write_file(id, path, data).await
}

#[tauri::command]
async fn sftp_remove_file(state: State<'_, AppState>, id: u64, path: String) -> Result<(), String> {
    state.ssh.sftp_remove_file(id, path).await
}

#[tauri::command]
async fn ssh_confirm_host_key(
    state: State<'_, AppState>,
    token: String,
    accepted: bool,
) -> Result<(), String> {
    state.ssh.confirm_host_key(token, accepted).await
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
            sftp_remove_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
