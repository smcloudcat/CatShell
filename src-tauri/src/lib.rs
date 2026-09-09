pub mod ssh_manager;

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use ssh_manager::{
    load_known_hosts_snapshot, remove_known_hosts_entry, ConnectRequest, EventSink,
    NetworkDiagnostic, PortForwardInfo, ProcessInfo, RawOutput, ServerMetrics, SessionInfo,
    SftpChunk, SftpEntry, SftpTransferStart, SshConfigEntry, SshManager,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

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

#[tauri::command]
async fn sftp_disk_download_start(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    remote_path: String,
    local_path: String,
    resume: bool,
) -> Result<ssh_manager::SftpDiskTransferStart, String> {
    let sink: Arc<dyn EventSink> = Arc::new(AppEventSink(app));
    state
        .ssh
        .sftp_disk_download_start(state.ssh.clone(), sink, id, remote_path, local_path, resume)
        .await
}

#[tauri::command]
async fn sftp_disk_upload_start(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u64,
    local_path: String,
    remote_path: String,
    resume: bool,
) -> Result<ssh_manager::SftpDiskTransferStart, String> {
    let sink: Arc<dyn EventSink> = Arc::new(AppEventSink(app));
    state
        .ssh
        .sftp_disk_upload_start(state.ssh.clone(), sink, id, local_path, remote_path, resume)
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
    load_known_hosts_snapshot(state.ssh.effective_known_hosts_path().as_deref())
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
    remove_known_hosts_entry(
        state.ssh.effective_known_hosts_path().as_deref(),
        pattern.trim(),
        key_type.trim(),
    )
}

/// 切换 known_hosts 存储策略：openssh = ~/.ssh/known_hosts（默认），appdata = 应用数据目录独立存储。
#[tauri::command]
async fn known_hosts_set_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
) -> Result<(), String> {
    match mode.as_str() {
        "openssh" => {
            state.ssh.set_known_hosts_path(None);
        }
        "appdata" => {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|_| "无法定位应用数据目录".to_string())?;
            std::fs::create_dir_all(&dir).map_err(|err| format!("创建应用数据目录失败: {err}"))?;
            state
                .ssh
                .set_known_hosts_path(Some(&dir.join("known_hosts")));
        }
        other => return Err(format!("未知的 known_hosts 存储模式: {other}")),
    }
    Ok(())
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

#[cfg(desktop)]
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
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
            sftp_chmod,
            sftp_download_begin,
            sftp_download_chunk,
            sftp_upload_begin,
            sftp_upload_chunk,
            sftp_upload_finish,
            sftp_transfer_cancel,
            sftp_disk_download_start,
            sftp_disk_upload_start,
            sftp_disk_transfer_cancel,
            sftp_disk_transfer_list,
            tray_set_active_count
        ])
        .setup(|app| {
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
                tray.on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
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
