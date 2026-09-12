mod batch;
mod config;
mod forward;
mod keys;
mod monitor;
mod sftp;
mod sync;
mod types;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use bytes::Bytes;
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{client, ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use serde::Serialize;
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

pub use batch::{BatchExecItem, BATCH_MAX_TIMEOUT_SECS, BATCH_MIN_TIMEOUT_SECS};
pub use config::{
    default_known_hosts_path, load_known_hosts_snapshot, parse_known_hosts, parse_ssh_config,
    remove_known_hosts_entries, remove_known_hosts_entry, ssh_config_path, write_ssh_config,
    HostConfigDraft,
};
pub use keys::{
    delete_keypair, generate_keypair, list_keys, read_public_key, GeneratedKeypair, SshKeyEntry,
};
pub use sftp::{
    validate_sftp_path, SftpChunk, SftpDiskTransferInfo, SftpDiskTransferStart, SftpDiskUploadPick,
    SftpEntry, SftpTransferStart,
};
pub use sync::{SyncPlan, SyncPlanEntry, SyncProgress, SyncStartInfo};
pub use types::{
    ConnectRequest, KnownHostEntry, KnownHostsSnapshot, NetworkDiagnostic, PartitionMetric,
    PortForwardInfo, ProcessInfo, ProxyConfig, ServerMetrics, SessionInfo, SshConfigEntry,
};

use types::{
    advance_reconnect_attempt, classify_known_host, reconnect_delay, HostKeyVerdict,
    CONNECT_TIMEOUT, HOST_KEY_CONFIRM_TIMEOUT, MANUAL_POLL_INTERVAL, OUTPUT_FLUSH_INTERVAL,
    OUTPUT_FLUSH_THRESHOLD,
};

/// 终端输出的原始字节通道抽象。Tauri 前端通过 IPC Channel 实现，
/// 测试环境保持 None 走事件回退，SSH 核心不依赖 Tauri 类型。
pub trait RawOutput: Send + Sync + 'static {
    fn send_bytes(&self, data: Vec<u8>) -> Result<(), String>;
}

pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, name: &str, payload: serde_json::Value);
}

pub struct ActiveSession {
    pub session_id: u64,
    pub info: SessionInfo,
    pub creds: ConnectRequest,
    pub conn: Mutex<Option<client::Handle<SshHandler>>>,
    /// ProxyJump 跳板链各级连接（按连接顺序：链头在前）。目标会话存活期间必须
    /// 保持这些 Handle，任何一级被 drop 都会关闭其开出的隧道、掐断整条链路。
    pub proxy_conn: Mutex<Vec<client::Handle<SshHandler>>>,
    pub write: Mutex<Option<ChannelWriteHalf<russh::client::Msg>>>,
    pub output: Option<Arc<dyn RawOutput>>,
    pub manual_closed: AtomicBool,
    /// 终端输出 IPC 通道发送失败计数（诊断用，见 dispatch_output）。
    pub dropped_outputs: AtomicU64,
}

/// P2-7：`ActiveSession` 的生命周期依赖 Arc 归零，一旦外部仍持有 `Arc`（前端回调、
/// 挂起的任务）而管理表已移除该会话，重连循环仍有被重新拉起的可能。这里在最后一次
/// 释放时兜底置位手动关闭标记，让任何仍在运行的重连循环立即收束，并留一条诊断日志。
impl Drop for ActiveSession {
    fn drop(&mut self) {
        self.manual_closed.store(true, Ordering::SeqCst);
        tracing::debug!(
            session_id = self.session_id,
            target = %self.creds.redacted_summary(),
            "会话对象释放"
        );
    }
}

/// 一条本地/动态转发下已建立连接的子任务集合（P2-6）。
///
/// 只 abort listener 只会停止接受新连接，已在转发中的隧道会一直存活到对端关闭，
/// 所以单独登记子任务句柄，停止转发时一并 abort。
pub type ForwardChildren = Arc<Mutex<Vec<JoinHandle<()>>>>;

pub struct SshManager {
    pub sessions: Mutex<HashMap<u64, Arc<ActiveSession>>>,
    pub host_key_confirmations: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    /// 等待前端应答的交互式（keyboard-interactive）认证提示，按会话 id 索引。
    pub kbi_prompts: KbiPromptMap,
    /// 运行时生效的 known_hosts 路径（None = OpenSSH 默认）。
    ///
    /// 与其他共享状态统一使用 `tokio::sync::RwLock`（P2-1）：本结构的方法都在异步上下文中
    /// 调用，混用 `std::sync::RwLock` 一旦发生锁中毒，`expect` 会在 `panic = "abort"` 下
    /// 直接终止整个应用。`tokio::sync::RwLock` 的守卫不返回 `Result`，从类型上消除了该路径。
    known_hosts_path: tokio::sync::RwLock<Option<PathBuf>>,
    next_id: AtomicU64,
    pub forwards: Mutex<HashMap<u64, JoinHandle<()>>>,
    /// 每条本地/动态转发下已建立的连接子任务（P2-6），停止转发时一并 abort。
    pub forward_children: Mutex<HashMap<u64, ForwardChildren>>,
    pub forward_info: Mutex<HashMap<u64, PortForwardInfo>>,
    remote_forwards: Mutex<HashMap<u64, forward::RemoteForwardInfo>>,
    remote_routes: Arc<Mutex<HashMap<(u64, u16), forward::RemoteForwardRoute>>>,
    next_forward_id: AtomicU64,
    pub sftp_transfers: Mutex<HashMap<u64, Arc<sftp::SftpTransfer>>>,
    pub sftp_disk_transfers: Mutex<HashMap<u64, Arc<sftp::SftpDiskTransfer>>>,
    /// 半成品基准路径的占坑集合（审计 B-4）：把「检查占用」与「占坑」做成原子操作，
    /// 避免并发同名磁盘传输共用同一个 `{target}.catshell-part` 交错写。
    claimed_part_paths: sftp::PartPathClaims,
    next_transfer_id: AtomicU64,
    next_disk_transfer_id: AtomicU64,
    /// 磁盘上传路径令牌：本地路径只能经 Rust 侧文件对话框选取，webview 仅持有一次性令牌。
    pub sftp_upload_path_tokens: Mutex<HashMap<u64, sftp::UploadPathToken>>,
    next_upload_token: AtomicU64,
    /// 目录同步任务取消句柄，按会话登记（同一会话同时一个同步任务）。
    pub sync_jobs: Mutex<HashMap<u64, Arc<sync::SyncJob>>>,
}

impl Default for SshManager {
    fn default() -> Self {
        SshManager {
            sessions: Mutex::new(HashMap::new()),
            host_key_confirmations: Arc::new(Mutex::new(HashMap::new())),
            kbi_prompts: Arc::new(Mutex::new(HashMap::new())),
            known_hosts_path: tokio::sync::RwLock::new(None),
            next_id: AtomicU64::new(1),
            forwards: Mutex::new(HashMap::new()),
            forward_children: Mutex::new(HashMap::new()),
            forward_info: Mutex::new(HashMap::new()),
            remote_forwards: Mutex::new(HashMap::new()),
            remote_routes: Arc::new(Mutex::new(HashMap::new())),
            next_forward_id: AtomicU64::new(1),
            sftp_transfers: Mutex::new(HashMap::new()),
            sftp_disk_transfers: Mutex::new(HashMap::new()),
            claimed_part_paths: sftp::new_part_path_claims(),
            next_transfer_id: AtomicU64::new(1),
            next_disk_transfer_id: AtomicU64::new(1),
            sftp_upload_path_tokens: Mutex::new(HashMap::new()),
            next_upload_token: AtomicU64::new(1),
            sync_jobs: Mutex::new(HashMap::new()),
        }
    }
}

/// 事件 payload 的 schema 版本号（P2-13）。
///
/// 前端按版本号校验 payload；字段改名/语义变化时递增，前端即可显式拒绝而不是
/// 静默读到 `undefined`。Rust 与前端各持一份常量，由测试锁定两者一致。
pub const EVENT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusPayload {
    v: u32,
    id: u64,
    status: String,
    reason: Option<String>,
    attempt: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputPayload {
    v: u32,
    id: u64,
    data: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostKeyPayload {
    v: u32,
    token: String,
    host: String,
    port: u16,
    fingerprint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KbiPromptPayload {
    v: u32,
    session_id: u64,
    name: String,
    instructions: String,
    prompts: Vec<KbiPromptField>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KbiPromptField {
    prompt: String,
    echo: bool,
}

fn emit_status(sink: &dyn EventSink, id: u64, status: &str, reason: Option<String>, attempt: u32) {
    let payload = StatusPayload {
        v: EVENT_SCHEMA_VERSION,
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
        v: EVENT_SCHEMA_VERSION,
        id,
        data: BASE64_STANDARD.encode(&data),
    };
    sink.emit(
        "session-output",
        serde_json::to_value(payload).unwrap_or_default(),
    );
}

/// 终端输出优先走原始字节通道（IPC Channel），不可用时回退到 base64 事件。
fn dispatch_output(sink: &dyn EventSink, session: &ActiveSession, data: Vec<u8>) {
    match &session.output {
        Some(raw) => {
            // IPC Channel 关闭/拥塞时输出会整块丢弃，用户表现为「命令执行了但没输出」。
            // 至少计数并在丢满一批时 warn，让日志可追查（审计 R-3）。
            if raw.send_bytes(data).is_err() {
                let dropped = session
                    .dropped_outputs
                    .fetch_add(1, Ordering::Relaxed)
                    .wrapping_add(1);
                if dropped == 1 || dropped.is_multiple_of(100) {
                    tracing::warn!(
                        session_id = session.session_id,
                        dropped,
                        "终端输出 IPC 通道发送失败，输出被丢弃"
                    );
                }
            }
        }
        None => emit_output(sink, session.session_id, data),
    }
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
        }
        .map_err(|err| err.to_string());
        match classify_known_host(known) {
            HostKeyVerdict::Trusted => return Ok(true),
            HostKeyVerdict::Changed(err) => {
                let reason = format!("主机密钥与 known_hosts 不匹配: {err}");
                tracing::warn!(
                    host = %self.host,
                    port = self.port,
                    fingerprint = %fingerprint,
                    "主机密钥与已记录指纹不一致，已阻断连接"
                );
                self.sink.emit(
                    "host-key-warning",
                    serde_json::json!({ "v": EVENT_SCHEMA_VERSION, "host": self.host, "port": self.port, "fingerprint": fingerprint, "reason": reason }),
                );
                return Ok(false);
            }
            HostKeyVerdict::Unknown => {}
        }

        // token 必须带上会话 id（审计 B-9）：同一个 `host:port:fingerprint` 可能在两个
        // 并发会话里同时首次出现，旧实现用「host:port:fingerprint」当键，第二次 insert
        // 会覆盖并丢弃第一个 oneshot::Sender，其接收端立刻收到 Err 而被 `unwrap_or(false)`
        // 判成「用户拒绝」——两个并发连接里有一个会毫无提示地失败。
        // 前端只是把收到的 token 原样回传，加一段后缀不改变契约。
        let token = format!(
            "{}:{}:{}:{}",
            self.host, self.port, fingerprint, self.session_id
        );
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(token.clone(), sender);
        self.sink.emit(
            "host-key-prompt",
            serde_json::to_value(HostKeyPayload {
                v: EVENT_SCHEMA_VERSION,
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

        // 中继任务句柄登记进路由：stop_forward 撤销路由时 abort 全部在飞连接（审计 R-2）。
        let relays = route.relays.clone();
        let relay_handle = tokio::spawn(async move {
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
        relays.push(relay_handle.abort_handle());
        Ok(())
    }
}

/// 等待前端应答的交互式认证提示发送端，按会话 id 索引。
pub type KbiPromptMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Vec<String>>>>>;

/// 连接 SSH Agent：Windows 优先 Pageant，其次 OpenSSH agent 命名管道；
/// 其他平台读取 SSH_AUTH_SOCK。
async fn connect_ssh_agent(
) -> Result<AgentClient<Box<dyn AgentStream + Send + Unpin>>, ConnectError> {
    #[cfg(windows)]
    {
        if let Ok(client) = AgentClient::connect_pageant().await {
            return Ok(client.dynamic());
        }
        let client = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
            .await
            .map_err(|error| {
                ConnectError::permanent(format!(
                    "无法连接 SSH Agent（已尝试 Pageant 与 OpenSSH agent 命名管道）: {error}"
                ))
            })?;
        Ok(client.dynamic())
    }
    #[cfg(not(windows))]
    {
        let client = AgentClient::connect_env().await.map_err(|error| {
            ConnectError::permanent(format!(
                "无法连接 SSH Agent（读取 SSH_AUTH_SOCK 失败，请确认 ssh-agent 已启动）: {error}"
            ))
        })?;
        Ok(client.dynamic())
    }
}

/// 交互式认证：把服务器提示转发给前端弹窗并等待用户应答（带超时）。
async fn request_kbi_answers(
    sink: &dyn EventSink,
    pending: &KbiPromptMap,
    session_id: u64,
    name: &str,
    instructions: &str,
    prompts: &[client::Prompt],
) -> Result<Vec<String>, ConnectError> {
    const KBI_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
    let (sender, receiver) = oneshot::channel();
    pending.lock().await.insert(session_id, sender);
    sink.emit(
        "kbi-prompt",
        serde_json::to_value(KbiPromptPayload {
            v: EVENT_SCHEMA_VERSION,
            session_id,
            name: name.to_string(),
            instructions: instructions.to_string(),
            prompts: prompts
                .iter()
                .map(|prompt| KbiPromptField {
                    prompt: prompt.prompt.clone(),
                    echo: prompt.echo,
                })
                .collect(),
        })
        .unwrap_or_default(),
    );
    let answers = match tokio::time::timeout(KBI_PROMPT_TIMEOUT, receiver).await {
        Ok(Ok(answers)) => answers,
        Ok(Err(_)) | Err(_) => {
            pending.lock().await.remove(&session_id);
            return Err(ConnectError::permanent(
                "交互式认证已取消或超时（120 秒内未收到应答）",
            ));
        }
    };
    Ok(answers)
}

fn kbi_auto_answer(prompt_text: &str, otp: &str, password: &str) -> String {
    let text = prompt_text.to_ascii_lowercase();
    let otp_prompt = text.contains("otp")
        || text.contains("code")
        || text.contains("token")
        || text.contains("passcode")
        || text.contains("验证")
        || text.contains("动态口令");
    if otp_prompt {
        otp.to_string()
    } else if text.contains("password") || text.contains("密码") {
        password.to_string()
    } else {
        otp.to_string()
    }
}

/// 在已建立的 SSH 连接上执行认证。password/key/keyboard-interactive/agent 四种方式；
/// 跳板机不传 otp_secret，因此不会触发交互式提示。
#[allow(clippy::too_many_arguments)]
async fn authenticate_connection(
    session: &mut client::Handle<SshHandler>,
    username: &str,
    auth_method: &str,
    password: Option<&str>,
    key_path: Option<&str>,
    passphrase: Option<&str>,
    otp_secret: Option<&str>,
    sink: &Arc<dyn EventSink>,
    kbi_pending: &KbiPromptMap,
    session_id: u64,
) -> Result<(), ConnectError> {
    match auth_method {
        "password" => {
            let password = password.ok_or_else(|| ConnectError::permanent("未提供登录密码"))?;
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
            let key_path = key_path.ok_or_else(|| ConnectError::permanent("未选择私钥文件"))?;
            let key_pair = load_secret_key(key_path, passphrase)
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
        "keyboard-interactive" => match otp_secret {
            Some(otp) => {
                let password = password.unwrap_or_default();
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
                            prompts,
                            ..
                        } => {
                            if prompts.is_empty() || prompts.len() > 8 || rounds >= 4 {
                                return Err(ConnectError::permanent(
                                    "认证失败：服务器返回了不支持的交互式认证提示",
                                ));
                            }
                            response = session
                                .authenticate_keyboard_interactive_respond(
                                    prompts
                                        .iter()
                                        .map(|prompt| {
                                            kbi_auto_answer(&prompt.prompt, otp, password)
                                        })
                                        .collect(),
                                )
                                .await
                                .map_err(|e| {
                                    ConnectError::transient(format!("认证请求失败: {e}"))
                                })?;
                            rounds += 1;
                        }
                    }
                }
            }
            None => {
                let mut response = session
                    .authenticate_keyboard_interactive_start(username, None::<String>)
                    .await
                    .map_err(|e| ConnectError::transient(format!("认证请求失败: {e}")))?;
                let mut rounds = 0;
                loop {
                    match response {
                        russh::client::KeyboardInteractiveAuthResponse::Success => break,
                        russh::client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                            return Err(ConnectError::permanent("认证失败：交互式认证未通过"))
                        }
                        russh::client::KeyboardInteractiveAuthResponse::InfoRequest {
                            name,
                            instructions,
                            prompts,
                        } => {
                            if prompts.is_empty() || prompts.len() > 4 || rounds >= 3 {
                                return Err(ConnectError::permanent(
                                    "认证失败：服务器返回了不支持的交互式认证提示",
                                ));
                            }
                            let answers = request_kbi_answers(
                                sink.as_ref(),
                                kbi_pending,
                                session_id,
                                &name,
                                &instructions,
                                &prompts,
                            )
                            .await?;
                            let mut answers = answers;
                            answers.resize(prompts.len(), String::new());
                            response = session
                                .authenticate_keyboard_interactive_respond(answers)
                                .await
                                .map_err(|e| {
                                    ConnectError::transient(format!("认证请求失败: {e}"))
                                })?;
                            rounds += 1;
                        }
                    }
                }
            }
        },
        "agent" => {
            let mut agent = connect_ssh_agent().await?;
            let identities = agent
                .request_identities()
                .await
                .map_err(|e| ConnectError::permanent(format!("读取 SSH Agent 密钥失败: {e}")))?;
            if identities.is_empty() {
                return Err(ConnectError::permanent("SSH Agent 中没有可用的密钥"));
            }
            let rsa_hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(|e| ConnectError::transient(format!("RSA 算法协商失败: {e}")))?
                .flatten();
            let username = username.to_string();
            for identity in &identities {
                let attempt = match identity {
                    AgentIdentity::Certificate { certificate, .. } => {
                        session
                            .authenticate_certificate_with(
                                username.clone(),
                                certificate.clone(),
                                rsa_hash,
                                &mut agent,
                            )
                            .await
                    }
                    _ => {
                        session
                            .authenticate_publickey_with(
                                username.clone(),
                                identity.public_key().into_owned(),
                                rsa_hash,
                                &mut agent,
                            )
                            .await
                    }
                };
                match attempt {
                    Ok(result) => {
                        if result.success() {
                            return Ok(());
                        }
                    }
                    Err(e) => {
                        return Err(ConnectError::transient(format!(
                            "SSH Agent 认证请求失败: {e}"
                        )));
                    }
                }
            }
            return Err(ConnectError::permanent(format!(
                "认证失败：SSH Agent 中的 {} 个密钥均未被服务器接受",
                identities.len()
            )));
        }
        other => {
            return Err(ConnectError::permanent(format!(
                "不支持的认证方式: {other}"
            )))
        }
    }
    Ok(())
}

async fn open_shell(
    creds: &ConnectRequest,
    session_id: u64,
    sink: Arc<dyn EventSink>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    kbi_pending: KbiPromptMap,
    known_hosts_path: Option<PathBuf>,
    remote_routes: Arc<Mutex<HashMap<(u64, u16), forward::RemoteForwardRoute>>>,
) -> Result<
    (
        client::Handle<SshHandler>,
        Vec<client::Handle<SshHandler>>,
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
        sink: sink.clone(),
        pending: pending.clone(),
        known_hosts_path,
        session_id,
        remote_routes: remote_routes.clone(),
    };
    let (mut session, proxy_conn) = match &creds.proxy {
        Some(proxy) => {
            // 多跳 ProxyJump：逐级「连上跳板 → 认证 → 在其上开直达下一目标的隧道」，
            // 最后一跳的隧道终点才是真正的目标服务器。每一跳都独立做主机指纹确认
            //（handler 的 host 字段取各自地址），凭据也各自独立。
            let hops = proxy.collect_chain();
            let mut established: Vec<client::Handle<SshHandler>> = Vec::with_capacity(hops.len());
            // 上一跳开出的 direct-tcpip 通道；首跳直接走 TCP。
            let mut tunnel: Option<russh::Channel<client::Msg>> = None;
            // 本跳的 TCP 目标：首跳是跳板自身，后续经由前一级隧道到达。
            for (index, hop) in hops.iter().enumerate() {
                let hop_handler = SshHandler {
                    host: hop.host.clone(),
                    port: hop.port,
                    sink: sink.clone(),
                    pending: pending.clone(),
                    known_hosts_path: handler.known_hosts_path.clone(),
                    session_id,
                    remote_routes: remote_routes.clone(),
                };
                let connect_result = match tunnel.take() {
                    Some(channel) => {
                        tokio::time::timeout(
                            CONNECT_TIMEOUT,
                            client::connect_stream(
                                config.clone(),
                                channel.into_stream(),
                                hop_handler,
                            ),
                        )
                        .await
                    }
                    None => {
                        tokio::time::timeout(
                            CONNECT_TIMEOUT,
                            client::connect(
                                config.clone(),
                                (hop.host.as_str(), hop.port),
                                hop_handler,
                            ),
                        )
                        .await
                    }
                };
                let mut hop_session = connect_result
                    .map_err(|_| {
                        ConnectError::transient(format!(
                            "第 {} 跳连接超时：{} 秒内未能与 {}:{} 建立连接",
                            index + 1,
                            CONNECT_TIMEOUT.as_secs(),
                            hop.host,
                            hop.port
                        ))
                    })?
                    .map_err(|e| {
                        ConnectError::from_connect(format!(
                            "第 {} 跳（{}:{}）连接失败: {e}",
                            index + 1,
                            hop.host,
                            hop.port
                        ))
                    })?;
                authenticate_connection(
                    &mut hop_session,
                    &hop.username,
                    &hop.auth_method,
                    hop.password.as_deref(),
                    hop.key_path.as_deref(),
                    hop.passphrase.as_deref(),
                    None,
                    &sink,
                    &kbi_pending,
                    session_id,
                )
                .await?;
                // 本跳要直达的下一目标：还有下一跳就是下一跳，否则是目标服务器。
                let (next_host, next_port) = hops
                    .get(index + 1)
                    .map(|next| (next.host.clone(), u32::from(next.port)))
                    .unwrap_or_else(|| (creds.host.clone(), u32::from(creds.port)));
                let channel = hop_session
                    .channel_open_direct_tcpip(next_host.clone(), next_port, "127.0.0.1", 0)
                    .await
                    .map_err(|e| {
                        ConnectError::transient(format!(
                            "第 {} 跳（{}:{}）建立到 {next_host}:{next_port} 的隧道失败: {e}",
                            index + 1,
                            hop.host,
                            hop.port
                        ))
                    })?;
                tunnel = Some(channel);
                established.push(hop_session);
            }
            // 不用 expect（审计 R-1）：依赖 collect_chain 语义的隐式不变式一旦变化，
            // panic=abort 会崩掉整个应用且 sessions 条目来不及清理。
            let final_stream = tunnel
                .ok_or_else(|| {
                    ConnectError::transient("跳板链为空但代码走到了隧道分支".to_string())
                })?
                .into_stream();
            let tunneled = tokio::time::timeout(
                CONNECT_TIMEOUT,
                client::connect_stream(config.clone(), final_stream, handler),
            )
            .await
            .map_err(|_| {
                ConnectError::transient(format!(
                    "连接超时：{} 秒内未能经由跳板链连接服务器",
                    CONNECT_TIMEOUT.as_secs()
                ))
            })?
            .map_err(|e| ConnectError::from_connect(format!("连接失败: {e}")))?;
            (tunneled, established)
        }
        None => {
            let session = tokio::time::timeout(
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
            (session, Vec::new())
        }
    };

    authenticate_connection(
        &mut session,
        &creds.username,
        &creds.auth_method,
        creds.password.as_deref(),
        creds.key_path.as_deref(),
        creds.passphrase.as_deref(),
        creds.otp_secret.as_deref(),
        &sink,
        &kbi_pending,
        session_id,
    )
    .await?;

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
    Ok((session, proxy_conn, read_half, write_half))
}

/// 累积 PTY 输出，凑够一个时间窗口或体积阈值再一次性发往 IPC。
///
/// `cat` 大文件、`tail -f`、编译日志等场景下，远端会在极短时间内产生海量小包；
/// 逐包 emit 会把 WebView 主线程压垮（表现为界面卡顿甚至假死）。
fn flush_output(sink: &dyn EventSink, session: &ActiveSession, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    dispatch_output(sink, session, std::mem::take(pending));
}

async fn shell_loop(
    sink: Arc<dyn EventSink>,
    session: Arc<ActiveSession>,
    mut channel_read: ChannelReadHalf,
) -> String {
    let mut reason = "连接已关闭".to_string();
    let mut pending: Vec<u8> = Vec::new();

    loop {
        // 有积压数据时用短窗口等聚合，空闲时退回手动关闭轮询间隔，不额外增加唤醒次数。
        let wait = if pending.is_empty() {
            MANUAL_POLL_INTERVAL
        } else {
            OUTPUT_FLUSH_INTERVAL
        };

        match tokio::time::timeout(wait, channel_read.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => {
                pending.extend_from_slice(&data);
                if pending.len() >= OUTPUT_FLUSH_THRESHOLD {
                    flush_output(sink.as_ref(), &session, &mut pending);
                }
            }
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                pending.extend_from_slice(&data);
                if pending.len() >= OUTPUT_FLUSH_THRESHOLD {
                    flush_output(sink.as_ref(), &session, &mut pending);
                }
            }
            Ok(Some(ChannelMsg::Eof)) => {}
            Ok(Some(ChannelMsg::Close)) | Ok(None) => {
                flush_output(sink.as_ref(), &session, &mut pending);
                return reason;
            }
            Ok(Some(_)) => {}
            // 窗口到期：发走已聚合字节，并顺带检查手动关闭标志。
            Err(_elapsed) => {
                flush_output(sink.as_ref(), &session, &mut pending);
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
        // 退避睡眠结束后必须复查「用户是否已手动关闭」：旧实现只在「决定是否重试」的
        // 时刻检查，而随后的 sleep（2/5/10…秒）窗口里点断开或关标签会被完全漏掉，
        // 醒来后照样建连，留下一条前端已经不认的幽灵连接（审计 B-8）。
        if session.manual_closed.load(Ordering::SeqCst) {
            break 'outer Some("已手动断开".to_string());
        }
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
            manager.kbi_prompts.clone(),
            manager.effective_known_hosts_path().await,
            manager.remote_routes.clone(),
        )
        .await
        {
            Err(err) => {
                let reason = err.message.clone();
                tracing::warn!(
                    session_id = id,
                    attempt,
                    permanent = err.permanent,
                    host_key = err.host_key,
                    error = %reason,
                    "SSH 连接失败"
                );
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
                {
                    break 'outer Some(reason);
                }
                let Some(next_attempt) = advance_reconnect_attempt(attempt) else {
                    break 'outer Some(reason);
                };
                attempt = next_attempt;
                tokio::time::sleep(reconnect_delay(attempt)).await;
            }
            Ok((conn, proxy_conn, read_half, write_half)) => {
                attempt = 0;
                let mut conn = conn;
                if let Err(error) = manager.restore_remote_forwards(id, &mut conn).await {
                    emit_status(sink.as_ref(), id, "disconnected", Some(error), attempt);
                    if session.manual_closed.load(Ordering::SeqCst) || !creds.auto_reconnect {
                        break 'outer Some("远程端口转发恢复失败".to_string());
                    }
                    let Some(next_attempt) = advance_reconnect_attempt(attempt) else {
                        break 'outer Some("远程端口转发恢复失败".to_string());
                    };
                    attempt = next_attempt;
                    tokio::time::sleep(reconnect_delay(attempt)).await;
                    continue;
                }
                emit_status(sink.as_ref(), id, "connected", None, 0);
                {
                    let mut lock = session.conn.lock().await;
                    *lock = Some(conn);
                }
                {
                    let mut lock = session.proxy_conn.lock().await;
                    *lock = proxy_conn;
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
                    let mut lock = session.proxy_conn.lock().await;
                    *lock = Vec::new();
                }
                {
                    let mut lock = session.write.lock().await;
                    *lock = None;
                }
                emit_status(sink.as_ref(), id, "disconnected", Some(reason.clone()), 0);

                if session.manual_closed.load(Ordering::SeqCst) || !creds.auto_reconnect {
                    break 'outer Some(reason);
                }
                let Some(next_attempt) = advance_reconnect_attempt(attempt) else {
                    break 'outer Some(reason);
                };
                attempt = next_attempt;
                tokio::time::sleep(reconnect_delay(attempt)).await;
            }
        }
    };

    tracing::info!(
        session_id = id,
        reason = %final_reason.as_deref().unwrap_or("已关闭"),
        attempts = attempt,
        "会话结束"
    );
    emit_status(sink.as_ref(), id, "closed", final_reason, 0);
    manager.stop_forwards_for_session(id).await;
    // 自然收尾路径此前漏了传输/同步取消，磁盘级传输要等 10 分钟 idle 回收（审计 B-4）。
    manager.cancel_transfers_for_session(id).await;
    {
        let mut sessions = manager.sessions.lock().await;
        sessions.remove(&id);
    }
}

impl SshManager {
    pub fn with_known_hosts_path(path: PathBuf) -> Self {
        Self {
            known_hosts_path: tokio::sync::RwLock::new(Some(path)),
            ..Self::default()
        }
    }

    /// 运行时切换 known_hosts 存储位置（None = OpenSSH 兼容的 ~/.ssh/known_hosts）。
    /// 只影响之后建立的新连接，已建立会话不受影响。
    pub async fn set_known_hosts_path(&self, path: Option<&std::path::Path>) {
        *self.known_hosts_path.write().await = path.map(std::path::Path::to_path_buf);
    }

    /// 当前生效的 known_hosts 路径（None 表示使用默认 ~/.ssh/known_hosts）。
    pub async fn effective_known_hosts_path(&self) -> Option<PathBuf> {
        self.known_hosts_path.read().await.clone()
    }

    pub(super) async fn session_ref(&self, id: u64) -> Result<Arc<ActiveSession>, String> {
        self.sessions
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| "会话不存在".to_string())
    }

    /// 打开一个会话通道，**只在通道协商期间**持有连接锁（P2-2）。
    ///
    /// `russh` 的 `client::Handle` 不可克隆、`channel_open_session` 需要 `&mut self`，
    /// 因此此前 monitor/ping/进程列表/SFTP 等实现把连接锁一直握到命令执行完毕
    /// （监控 8s、探测 10s），同会话的终端输入与其他操作在此期间全部被串行化。
    /// 通道一旦建立即可脱离 `Handle` 独立收发（`exec` 取 `&self`，`split` 消费自身），
    /// 所以把锁的持有范围收缩到协商这一步。
    pub(super) async fn open_session_channel(
        &self,
        id: u64,
    ) -> Result<russh::Channel<russh::client::Msg>, String> {
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        connection
            .channel_open_session()
            .await
            .map_err(|error| format!("打开会话通道失败: {error}"))
    }

    /// 会话结束时收束其名下所有传输（P2-5）。
    ///
    /// `disconnect` / `remove` 此前只停转发与终端通道，磁盘级传输与前端一次性传输仍会
    /// 继续读写（磁盘传输还持有独立 SFTP 通道），表现为「会话已关闭但传输还在动」。
    async fn cancel_transfers_for_session(&self, session_id: u64) {
        let streaming: Vec<Arc<sftp::SftpTransfer>> = {
            let transfers = self.sftp_transfers.lock().await;
            transfers
                .values()
                .filter(|transfer| transfer.session_id == session_id)
                .cloned()
                .collect()
        };
        for transfer in streaming {
            transfer.cancelled.store(true, Ordering::SeqCst);
        }

        let disk: Vec<Arc<sftp::SftpDiskTransfer>> = {
            let transfers = self.sftp_disk_transfers.lock().await;
            transfers
                .values()
                .filter(|transfer| transfer.session_id == session_id)
                .cloned()
                .collect()
        };
        for transfer in disk {
            transfer.cancelled.store(true, Ordering::SeqCst);
        }

        // 会话关闭时同样取消目录同步任务（审计 B-4）：否则 sync job 会拿着
        // 已死的 SftpSession 把剩余条目（至多 20 000 个）逐个跑失败，
        // 并持续向前端已离开的会话 emit sftp-sync-progress。
        self.sftp_sync_cancel(session_id).await;
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
        output: Option<Arc<dyn RawOutput>>,
        req: ConnectRequest,
    ) -> Result<u64, String> {
        if req.host.trim().is_empty() {
            return Err("主机地址不能为空".to_string());
        }
        if req.username.trim().is_empty() {
            return Err("用户名不能为空".to_string());
        }
        if let Some(proxy) = &req.proxy {
            if proxy.host.trim().is_empty() || proxy.username.trim().is_empty() {
                return Err("跳板机地址或用户名不能为空".to_string());
            }
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
            proxy_conn: Mutex::new(Vec::new()),
            write: Mutex::new(None),
            output,
            manual_closed: AtomicBool::new(false),
            dropped_outputs: AtomicU64::new(0),
        });
        // 只记录连接目标与认证方式，绝不记录凭据（redacted_summary 已剔除口令字段）。
        tracing::info!(session_id = id, target = %session.creds.redacted_summary(), "建立会话");
        self.sessions.lock().await.insert(id, session.clone());
        tauri::async_runtime::spawn(run_session(sink.clone(), manager, session));
        Ok(id)
    }

    /// 前端应答交互式认证提示。没有等待中的提示时返回错误。
    pub async fn answer_kbi(&self, session_id: u64, answers: Vec<String>) -> Result<(), String> {
        let sender = self
            .kbi_prompts
            .lock()
            .await
            .remove(&session_id)
            .ok_or_else(|| "没有等待中的交互式认证提示".to_string())?;
        sender
            .send(answers)
            .map_err(|_| "交互式认证请求已结束".to_string())
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
        self.cancel_transfers_for_session(id).await;
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
        self.cancel_transfers_for_session(id).await;
        if let Ok(session) = self.session_ref(id).await {
            session.manual_closed.store(true, Ordering::SeqCst);
        }
        self.sessions.lock().await.remove(&id);
    }
}
