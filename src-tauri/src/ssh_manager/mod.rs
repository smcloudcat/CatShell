mod config;
mod forward;
mod monitor;
mod sftp;
mod types;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use bytes::Bytes;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{client, ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use serde::Serialize;
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

pub use config::{
    default_known_hosts_path, load_known_hosts_snapshot, parse_known_hosts, parse_ssh_config,
    remove_known_hosts_entries, remove_known_hosts_entry, ssh_config_path,
};
pub use sftp::{SftpChunk, SftpEntry, SftpTransferStart};
pub use types::{
    ConnectRequest, KnownHostEntry, KnownHostsSnapshot, NetworkDiagnostic, PartitionMetric,
    PortForwardInfo, ProcessInfo, ServerMetrics, SessionInfo, SshConfigEntry,
};

use types::{
    reconnect_delay, CONNECT_TIMEOUT, HOST_KEY_CONFIRM_TIMEOUT, MANUAL_POLL_INTERVAL,
    MAX_RECONNECT_ATTEMPTS,
};

pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, name: &str, payload: serde_json::Value);
}

pub struct ActiveSession {
    pub session_id: u64,
    pub info: SessionInfo,
    pub creds: ConnectRequest,
    pub conn: Mutex<Option<client::Handle<SshHandler>>>,
    pub write: Mutex<Option<ChannelWriteHalf<russh::client::Msg>>>,
    pub manual_closed: AtomicBool,
}

pub struct SshManager {
    pub sessions: Mutex<HashMap<u64, Arc<ActiveSession>>>,
    pub host_key_confirmations: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    known_hosts_path: std::sync::RwLock<Option<PathBuf>>,
    next_id: AtomicU64,
    pub forwards: Mutex<HashMap<u64, JoinHandle<()>>>,
    pub forward_info: Mutex<HashMap<u64, PortForwardInfo>>,
    remote_forwards: Mutex<HashMap<u64, forward::RemoteForwardInfo>>,
    remote_routes: Arc<Mutex<HashMap<(u64, u16), forward::RemoteForwardRoute>>>,
    next_forward_id: AtomicU64,
    pub sftp_transfers: Mutex<HashMap<u64, Arc<sftp::SftpTransfer>>>,
    next_transfer_id: AtomicU64,
}

impl Default for SshManager {
    fn default() -> Self {
        SshManager {
            sessions: Mutex::new(HashMap::new()),
            host_key_confirmations: Arc::new(Mutex::new(HashMap::new())),
            known_hosts_path: std::sync::RwLock::new(None),
            next_id: AtomicU64::new(1),
            forwards: Mutex::new(HashMap::new()),
            forward_info: Mutex::new(HashMap::new()),
            remote_forwards: Mutex::new(HashMap::new()),
            remote_routes: Arc::new(Mutex::new(HashMap::new())),
            next_forward_id: AtomicU64::new(1),
            sftp_transfers: Mutex::new(HashMap::new()),
            next_transfer_id: AtomicU64::new(1),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusPayload {
    id: u64,
    status: String,
    reason: Option<String>,
    attempt: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputPayload {
    id: u64,
    data: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostKeyPayload {
    token: String,
    host: String,
    port: u16,
    fingerprint: String,
}

fn emit_status(sink: &dyn EventSink, id: u64, status: &str, reason: Option<String>, attempt: u32) {
    let payload = StatusPayload {
        id,
        status: status.to_string(),
        reason,
        attempt,
    };
    sink.emit(
        "session-status",
        serde_json::to_value(payload).unwrap_or_default(),
    );
}

fn emit_output(sink: &dyn EventSink, id: u64, data: Vec<u8>) {
    let payload = OutputPayload {
        id,
        data: BASE64_STANDARD.encode(&data),
    };
    sink.emit(
        "session-output",
        serde_json::to_value(payload).unwrap_or_default(),
    );
}

fn is_host_key_error(error: &str) -> bool {
    error.contains("Unknown server key")
        || error.contains("Key changed")
        || error.contains("主机密钥")
}

#[derive(Debug)]
struct ConnectError {
    message: String,
    permanent: bool,
    host_key: bool,
}

impl ConnectError {
    fn transient(message: impl Into<String>) -> Self {
        ConnectError {
            message: message.into(),
            permanent: false,
            host_key: false,
        }
    }

    fn permanent(message: impl Into<String>) -> Self {
        ConnectError {
            message: message.into(),
            permanent: true,
            host_key: false,
        }
    }

    fn from_connect(message: String) -> Self {
        let host_key = is_host_key_error(&message);
        ConnectError {
            message,
            permanent: false,
            host_key,
        }
    }
}

pub struct SshHandler {
    host: String,
    port: u16,
    sink: Arc<dyn EventSink>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    known_hosts_path: Option<PathBuf>,
    session_id: u64,
    remote_routes: Arc<Mutex<HashMap<(u64, u16), forward::RemoteForwardRoute>>>,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let public_key = server_public_key.public_key();
        let fingerprint = public_key
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        let known = match &self.known_hosts_path {
            Some(path) => russh::keys::known_hosts::check_known_hosts_path(
                &self.host,
                self.port,
                &public_key,
                path,
            ),
            None => russh::keys::known_hosts::check_known_hosts(&self.host, self.port, &public_key),
        };
        match known {
            Ok(true) => return Ok(true),
            Err(err) => {
                let reason = format!("主机密钥与 known_hosts 不匹配: {err}");
                self.sink.emit(
                    "host-key-warning",
                    serde_json::json!({ "host": self.host, "port": self.port, "fingerprint": fingerprint, "reason": reason }),
                );
                return Ok(false);
            }
            Ok(false) => {}
        }

        let token = format!("{}:{}:{}", self.host, self.port, fingerprint);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(token.clone(), sender);
        self.sink.emit(
            "host-key-prompt",
            serde_json::to_value(HostKeyPayload {
                token: token.clone(),
                host: self.host.clone(),
                port: self.port,
                fingerprint: fingerprint.clone(),
            })
            .unwrap_or_default(),
        );

        let accepted = tokio::time::timeout(HOST_KEY_CONFIRM_TIMEOUT, receiver)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(false);
        self.pending.lock().await.remove(&token);
        if accepted {
            match &self.known_hosts_path {
                Some(path) => russh::keys::known_hosts::learn_known_hosts_path(
                    &self.host,
                    self.port,
                    &public_key,
                    path,
                ),
                None => {
                    russh::keys::known_hosts::learn_known_hosts(&self.host, self.port, &public_key)
                }
            }
            .map_err(russh::Error::from)?;
        }
        Ok(accepted)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let port = u16::try_from(connected_port).ok();
        let route = match port {
            Some(port) => self
                .remote_routes
                .lock()
                .await
                .get(&(self.session_id, port))
                .cloned(),
            None => None,
        };
        let Some(route) = route else {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        };

        tokio::spawn(async move {
            let local =
                match TcpStream::connect((route.target_host.as_str(), route.target_port)).await {
                    Ok(stream) => stream,
                    Err(_) => {
                        reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
                        return;
                    }
                };
            reply.accept().await;
            let mut remote = channel.into_stream();
            let mut local = local;
            let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
        });
        Ok(())
    }
}

async fn open_shell(
    creds: &ConnectRequest,
    session_id: u64,
    sink: Arc<dyn EventSink>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    known_hosts_path: Option<PathBuf>,
    remote_routes: Arc<Mutex<HashMap<(u64, u16), forward::RemoteForwardRoute>>>,
) -> Result<
    (
        client::Handle<SshHandler>,
        ChannelReadHalf,
        ChannelWriteHalf<russh::client::Msg>,
    ),
    ConnectError,
> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(creds.keepalive.clamp(5, 300))),
        keepalive_max: 2,
        ..Default::default()
    });
    let handler = SshHandler {
        host: creds.host.clone(),
        port: creds.port,
        sink,
        pending,
        known_hosts_path,
        session_id,
        remote_routes,
    };
    let mut session = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(config, (creds.host.as_str(), creds.port), handler),
    )
    .await
    .map_err(|_| {
        ConnectError::transient(format!(
            "连接超时：{} 秒内未能与服务器建立连接",
            CONNECT_TIMEOUT.as_secs()
        ))
    })?
    .map_err(|e| ConnectError::from_connect(format!("连接失败: {e}")))?;

    let username = creds.username.clone();
    match creds.auth_method.as_str() {
        "password" => {
            let password = creds
                .password
                .clone()
                .ok_or_else(|| ConnectError::permanent("未提供登录密码"))?;
            let result = session
                .authenticate_password(username, password)
                .await
                .map_err(|e| ConnectError::transient(format!("认证请求失败: {e}")))?;
            if !result.success() {
                return Err(ConnectError::permanent(
                    "认证失败：密码不正确或该账户不可用",
                ));
            }
        }
        "key" => {
            let key_path = creds
                .key_path
                .clone()
                .ok_or_else(|| ConnectError::permanent("未选择私钥文件"))?;
            let key_pair = load_secret_key(&key_path, creds.passphrase.as_deref())
                .map_err(|e| ConnectError::permanent(format!("私钥加载失败: {e}")))?;
            let rsa_hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(|e| ConnectError::transient(format!("RSA 算法协商失败: {e}")))?
                .flatten();
            let result = session
                .authenticate_publickey(
                    username,
                    PrivateKeyWithHashAlg::new(Arc::new(key_pair), rsa_hash),
                )
                .await
                .map_err(|e| ConnectError::transient(format!("认证请求失败: {e}")))?;
            if !result.success() {
                return Err(ConnectError::permanent(
                    "认证失败：请检查私钥与口令是否与账户匹配",
                ));
            }
        }
        "keyboard-interactive" => {
            let otp = creds
                .otp_secret
                .clone()
                .ok_or_else(|| ConnectError::permanent("未提供一次性验证码"))?;
            let password = creds.password.clone().unwrap_or_default();
            let mut response = session
                .authenticate_keyboard_interactive_start(username, None::<String>)
                .await
                .map_err(|e| ConnectError::transient(format!("认证请求失败: {e}")))?;
            let mut rounds = 0;
            loop {
                match response {
                    russh::client::KeyboardInteractiveAuthResponse::Success => break,
                    russh::client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                        return Err(ConnectError::permanent(
                            "认证失败：一次性验证码不正确或该账户不可用",
                        ))
                    }
                    russh::client::KeyboardInteractiveAuthResponse::InfoRequest {
                        prompts, ..
                    } => {
                        if prompts.is_empty() || prompts.len() > 8 || rounds >= 4 {
                            return Err(ConnectError::permanent(
                                "认证失败：服务器返回了不支持的交互式认证提示",
                            ));
                        }
                        response = session
                            .authenticate_keyboard_interactive_respond(
                                prompts
                                    .into_iter()
                                    .map(|prompt| {
                                        let text = prompt.prompt.to_ascii_lowercase();
                                        let otp_prompt = text.contains("otp")
                                            || text.contains("code")
                                            || text.contains("token")
                                            || text.contains("passcode")
                                            || text.contains("验证")
                                            || text.contains("动态口令");
                                        if otp_prompt {
                                            otp.clone()
                                        } else if text.contains("password") || text.contains("密码")
                                        {
                                            password.clone()
                                        } else {
                                            otp.clone()
                                        }
                                    })
                                    .collect(),
                            )
                            .await
                            .map_err(|e| ConnectError::transient(format!("认证请求失败: {e}")))?;
                        rounds += 1;
                    }
                }
            }
        }
        other => {
            return Err(ConnectError::permanent(format!(
                "不支持的认证方式: {other}"
            )))
        }
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| ConnectError::transient(format!("打开会话通道失败: {e}")))?;
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|e| ConnectError::transient(format!("申请终端失败: {e}")))?;
    channel
        .request_shell(false)
        .await
        .map_err(|e| ConnectError::transient(format!("打开远程 Shell 失败: {e}")))?;

    let (read_half, write_half) = channel.split();
    Ok((session, read_half, write_half))
}

async fn shell_loop(
    sink: Arc<dyn EventSink>,
    session: Arc<ActiveSession>,
    mut channel_read: ChannelReadHalf,
) -> String {
    let mut reason = "连接已关闭".to_string();
    loop {
        tokio::select! {
            msg = channel_read.wait() => match msg {
                Some(ChannelMsg::Data { data }) => emit_output(sink.as_ref(), session.session_id, data.to_vec()),
                Some(ChannelMsg::ExtendedData { data, .. }) => emit_output(sink.as_ref(), session.session_id, data.to_vec()),
                Some(ChannelMsg::Eof) => {}
                Some(ChannelMsg::Close) => return reason,
                Some(_) => {}
                None => return reason,
            },
            _ = tokio::time::sleep(MANUAL_POLL_INTERVAL) => {
                if session.manual_closed.load(Ordering::SeqCst) {
                    reason = "已手动断开".to_string();
                    return reason;
                }
            }
        }
    }
}

async fn run_session(
    sink: Arc<dyn EventSink>,
    manager: Arc<SshManager>,
    session: Arc<ActiveSession>,
) {
    let id = session.session_id;
    let creds = session.creds.clone();
    let mut attempt: u32 = 0;

    let final_reason = 'outer: loop {
        let status_label = if attempt == 0 {
            "connecting"
        } else {
            "reconnecting"
        };
        emit_status(sink.as_ref(), id, status_label, None, attempt);

        match open_shell(
            &creds,
            id,
            sink.clone(),
            manager.host_key_confirmations.clone(),
            manager.effective_known_hosts_path(),
            manager.remote_routes.clone(),
        )
        .await
        {
            Err(err) => {
                let reason = err.message.clone();
                emit_status(
                    sink.as_ref(),
                    id,
                    "disconnected",
                    Some(reason.clone()),
                    attempt,
                );
                if !creds.auto_reconnect
                    || session.manual_closed.load(Ordering::SeqCst)
                    || err.host_key
                    || err.permanent
                    || attempt >= MAX_RECONNECT_ATTEMPTS
                {
                    break 'outer Some(reason);
                }
                attempt += 1;
                tokio::time::sleep(reconnect_delay(attempt)).await;
            }
            Ok((conn, read_half, write_half)) => {
                attempt = 0;
                let mut conn = conn;
                if let Err(error) = manager.restore_remote_forwards(id, &mut conn).await {
                    emit_status(sink.as_ref(), id, "disconnected", Some(error), attempt);
                    if session.manual_closed.load(Ordering::SeqCst) || !creds.auto_reconnect {
                        break 'outer Some("远程端口转发恢复失败".to_string());
                    }
                    attempt += 1;
                    tokio::time::sleep(reconnect_delay(attempt)).await;
                    continue;
                }
                emit_status(sink.as_ref(), id, "connected", None, 0);
                {
                    let mut lock = session.conn.lock().await;
                    *lock = Some(conn);
                }
                {
                    let mut lock = session.write.lock().await;
                    *lock = Some(write_half);
                }
                let reason = shell_loop(sink.clone(), session.clone(), read_half).await;
                {
                    let mut lock = session.conn.lock().await;
                    *lock = None;
                }
                {
                    let mut lock = session.write.lock().await;
                    *lock = None;
                }
                emit_status(sink.as_ref(), id, "disconnected", Some(reason.clone()), 0);

                if session.manual_closed.load(Ordering::SeqCst) || !creds.auto_reconnect {
                    break 'outer Some(reason);
                }
                attempt += 1;
                if attempt >= MAX_RECONNECT_ATTEMPTS {
                    break 'outer Some(reason);
                }
                attempt += 1;
                tokio::time::sleep(reconnect_delay(attempt)).await;
            }
        }
    };

    emit_status(sink.as_ref(), id, "closed", final_reason, 0);
    manager.stop_forwards_for_session(id).await;
    {
        let mut sessions = manager.sessions.lock().await;
        sessions.remove(&id);
    }
}

impl SshManager {
    pub fn with_known_hosts_path(path: PathBuf) -> Self {
        Self {
            known_hosts_path: std::sync::RwLock::new(Some(path)),
            ..Self::default()
        }
    }

    /// 运行时切换 known_hosts 存储位置（None = OpenSSH 兼容的 ~/.ssh/known_hosts）。
    /// 只影响之后建立的新连接，已建立会话不受影响。
    pub fn set_known_hosts_path(&self, path: Option<&std::path::Path>) {
        *self.known_hosts_path.write().expect("known_hosts_path 锁") =
            path.map(std::path::Path::to_path_buf);
    }

    /// 当前生效的 known_hosts 路径（None 表示使用默认 ~/.ssh/known_hosts）。
    pub fn effective_known_hosts_path(&self) -> Option<PathBuf> {
        self.known_hosts_path
            .read()
            .expect("known_hosts_path 锁")
            .clone()
    }

    pub(super) async fn session_ref(&self, id: u64) -> Result<Arc<ActiveSession>, String> {
        self.sessions
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| "会话不存在".to_string())
    }

    pub async fn confirm_host_key(&self, token: String, accepted: bool) -> Result<(), String> {
        let sender = self
            .host_key_confirmations
            .lock()
            .await
            .remove(&token)
            .ok_or_else(|| "主机指纹确认请求已过期".to_string())?;
        sender
            .send(accepted)
            .map_err(|_| "主机指纹确认请求已结束".to_string())
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.lock().await;
        sessions
            .values()
            .map(|s| {
                let mut info = s.info.clone();
                if s.manual_closed.load(Ordering::SeqCst) {
                    info.status = "disconnected".to_string();
                }
                info
            })
            .collect()
    }

    pub async fn create(
        &self,
        manager: Arc<SshManager>,
        sink: Arc<dyn EventSink>,
        req: ConnectRequest,
    ) -> Result<u64, String> {
        if req.host.trim().is_empty() {
            return Err("主机地址不能为空".to_string());
        }
        if req.username.trim().is_empty() {
            return Err("用户名不能为空".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let name = if req.name.trim().is_empty() {
            format!("{}@{}", req.username, req.host)
        } else {
            req.name.trim().to_string()
        };
        let info = SessionInfo {
            id,
            name,
            host: req.host.clone(),
            port: req.port,
            username: req.username.clone(),
            status: "connecting".to_string(),
            reason: None,
        };
        let session = Arc::new(ActiveSession {
            session_id: id,
            info,
            creds: req,
            conn: Mutex::new(None),
            write: Mutex::new(None),
            manual_closed: AtomicBool::new(false),
        });
        self.sessions.lock().await.insert(id, session.clone());
        tauri::async_runtime::spawn(run_session(sink.clone(), manager, session));
        Ok(id)
    }

    pub async fn write(&self, id: u64, data: Vec<u8>) -> Result<(), String> {
        let session = self.session_ref(id).await?;
        let mut write_lock = session.write.lock().await;
        let half = write_lock
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        half.data_bytes(Bytes::from(data))
            .await
            .map_err(|e| format!("发送数据失败: {e}"))
    }

    pub async fn resize(&self, id: u64, cols: u32, rows: u32) -> Result<(), String> {
        let session = self.session_ref(id).await?;
        let mut write_lock = session.write.lock().await;
        if let Some(half) = write_lock.as_mut() {
            half.window_change(cols.clamp(2, 500), rows.clamp(2, 500), 0, 0)
                .await
                .map_err(|e| format!("调整窗口失败: {e}"))?;
        }
        Ok(())
    }

    pub async fn disconnect(&self, sink: Arc<dyn EventSink>, id: u64) {
        self.stop_forwards_for_session(id).await;
        if let Ok(session) = self.session_ref(id).await {
            session.manual_closed.store(true, Ordering::SeqCst);
            if let Some(half) = session.write.lock().await.as_mut() {
                let _ = half.close().await;
            }
        }
        emit_status(sink.as_ref(), id, "closing", None, 0);
    }

    pub async fn remove(&self, id: u64) {
        self.stop_forwards_for_session(id).await;
        if let Ok(session) = self.session_ref(id).await {
            session.manual_closed.store(true, Ordering::SeqCst);
        }
        self.sessions.lock().await.remove(&id);
    }
}
