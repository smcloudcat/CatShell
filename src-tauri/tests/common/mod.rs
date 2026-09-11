//! 集成测试共享基建：一个跑在本地回环上的 SSH 测试服务器。
//!
//! 提供三类能力，供 `ssh_e2e` / `sftp_e2e` / `forward_e2e` 复用：
//! - `TestSink` / `CollectOutput`：把事件与原始字节收集到内存里断言；
//! - `TestServer`：支持 shell 回显、SFTP 子系统、direct-tcpip 转发；
//! - 连接与 known_hosts 辅助函数。
#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use catshell_lib::ssh_manager::{ConnectRequest, EventSink, RawOutput, SshManager};
use russh::keys::*;
use russh::server::{self, Msg as ServerMsg, Server as _};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, FileMode, Handle, Name, OpenFlags, Status, StatusCode,
    Version,
};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// 收集原始输出通道字节的测试桩，验证 IPC Channel 输出路径。
pub struct CollectOutput(pub StdMutex<Vec<u8>>);

impl RawOutput for CollectOutput {
    fn send_bytes(&self, data: Vec<u8>) -> Result<(), String> {
        self.0.lock().unwrap().extend_from_slice(&data);
        Ok(())
    }
}

pub struct TestSink {
    pub events: StdMutex<Vec<(String, Value)>>,
    pub connected: Arc<AtomicBool>,
    pub closed: Arc<AtomicBool>,
    pub output: StdMutex<Vec<u8>>,
}

impl TestSink {
    pub fn new() -> Self {
        TestSink {
            events: StdMutex::new(Vec::new()),
            connected: Arc::new(AtomicBool::new(false)),
            closed: Arc::new(AtomicBool::new(false)),
            output: StdMutex::new(Vec::new()),
        }
    }

    /// 某类事件是否出现过。
    pub fn saw_event(&self, name: &str) -> bool {
        self.events
            .lock()
            .unwrap()
            .iter()
            .any(|(event, _)| event == name)
    }

    /// 收集所有 `session-status` 事件里的 status 字段。
    pub fn statuses(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == "session-status")
            .filter_map(|(_, payload)| payload["status"].as_str().map(str::to_owned))
            .collect()
    }

    /// 读取某类事件的最后一个 payload。
    pub fn last_event(&self, name: &str) -> Option<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(event, _)| event == name)
            .map(|(_, payload)| payload.clone())
    }
}

impl EventSink for TestSink {
    fn emit(&self, name: &str, payload: Value) {
        if name == "session-status" {
            let status = payload["status"].as_str().unwrap_or("");
            if status == "connected" {
                self.connected.store(true, Ordering::SeqCst);
            }
            if status == "closed" {
                self.closed.store(true, Ordering::SeqCst);
            }
        }
        if name == "session-output" {
            if let Some(data) = payload["data"].as_str() {
                if let Ok(bytes) = BASE64_STANDARD.decode(data) {
                    self.output.lock().unwrap().extend_from_slice(&bytes);
                }
            }
        }
        self.events
            .lock()
            .unwrap()
            .push((name.to_string(), payload));
    }
}

// ============================ 测试服务器 ============================

#[derive(Clone)]
pub struct TestServer {
    /// 该服务器实例被用作跳板时开出的 direct-tcpip 隧道数。
    /// 多跳测试以此证明流量真的穿过了跳板链而不是直连目标。
    pub tunnel_opens: Arc<std::sync::atomic::AtomicUsize>,
}

impl TestServer {
    pub fn new() -> Self {
        TestServer {
            tunnel_opens: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }
}

impl Default for TestServer {
    fn default() -> Self {
        Self::new()
    }
}

impl server::Server for TestServer {
    type Handler = TestSession;

    fn new_client(&mut self, _addr: Option<std::net::SocketAddr>) -> Self::Handler {
        // 每条 SSH 连接一份独立的文件系统，测试之间互不影响。
        TestSession::with_tunnel_opens(self.tunnel_opens.clone())
    }

    fn handle_session_error(&mut self, _error: <Self::Handler as server::Handler>::Error) {}
}

/// 单个 SSH 连接的服务端状态。
///
/// 需要持有 session channel 才能在 `subsystem_request` 时把 SFTP 跑在该 channel 上。
/// `fs` 挂在连接上而不是单个 SFTP 会话上：客户端每次操作都会新开一个 SFTP 子系统，
/// 状态若随会话销毁，「写一个文件再读回来」就会读到空内容。
pub struct TestSession {
    clients: Arc<Mutex<HashMap<ChannelId, Channel<ServerMsg>>>>,
    fs: SharedFs,
    /// 由 `ChannelStream` 自行搬运字节的通道：direct-tcpip 转发与 sftp 子系统。
    /// 这些通道的数据必须跳过 shell 的 `data()` 回显，否则协议流量会被塞进假回显，
    /// 客户端永远等不到合法的协议响应。
    passthrough_channels: HashSet<ChannelId>,
    /// 所 属服务器实例的隧道计数器（连接级共享）。
    tunnel_opens: Arc<std::sync::atomic::AtomicUsize>,
}

impl TestSession {
    pub fn new() -> Self {
        Self::with_tunnel_opens(Arc::new(std::sync::atomic::AtomicUsize::new(0)))
    }

    pub fn with_tunnel_opens(tunnel_opens: Arc<std::sync::atomic::AtomicUsize>) -> Self {
        TestSession {
            clients: Arc::new(Mutex::new(HashMap::new())),
            fs: SharedFs::seeded(),
            passthrough_channels: HashSet::new(),
            tunnel_opens,
        }
    }
}

impl server::Handler for TestSession {
    type Error = russh::Error;

    async fn channel_open_session(
        &mut self,
        channel: Channel<ServerMsg>,
        reply: server::ChannelOpenHandle,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let channel_key = channel.id();
        self.clients.lock().await.insert(channel_key, channel);
        reply.accept().await;
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.close(channel)?;
        Ok(())
    }

    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        if user == "test" && password == "secret" {
            Ok(server::Auth::Accept)
        } else {
            Ok(server::Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &ssh_key::PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let _ = session.channel_success(channel);
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let _ = session.channel_success(channel);
        session.data(channel, b"welcome to echo shell\r\n".to_vec())?;
        Ok(())
    }

    /// exec 请求：回显命令行并正常退出，供监控与批量执行的端到端测试使用。
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let _ = session.channel_success(channel);
        let echoed = format!("exec: {}\r\n", String::from_utf8_lossy(data));
        session.data(channel, echoed.into_bytes())?;
        let _ = session.eof(channel);
        let _ = session.close(channel);
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        // russh 会把字节同时投给 ChannelStream 和这里。转发通道归 ChannelStream 管，
        // 若在这里再回显一次，客户端会先收到一串假数据。
        if self.passthrough_channels.contains(&channel) {
            return Ok(());
        }
        let echoed = format!("echo: {}\r\n", String::from_utf8_lossy(data));
        session.data(channel, echoed.into_bytes())?;
        Ok(())
    }

    /// `sftp` 子系统：把 channel 交给 russh-sftp 的服务端驱动，跑在内存文件系统上。
    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel_id)?;
            return Ok(());
        }
        let channel = self.clients.lock().await.remove(&channel_id);
        let Some(channel) = channel else {
            session.channel_failure(channel_id)?;
            return Ok(());
        };
        self.passthrough_channels.insert(channel_id);
        session.channel_success(channel_id)?;
        let fs = self.fs.clone();
        // 必须在 handler 上下文里就地 await，不能用 spawn 脱离出去：
        // 一旦 handler 返回，session 就会把该 channel 的数据重新路由到 `data()` 回调，
        // SFTP 包会被当成 shell 输入处理，run 也拿不到后续字节。
        russh_sftp::server::run(channel.into_stream(), MockSftpFs::new(fs)).await;
        Ok(())
    }

    /// 本地转发（`direct-tcpip`）：服务端充当出口，把流量桥接到客户端指定的目标。
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<ServerMsg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let host = host_to_connect.to_string();
        let port = port_to_connect as u16;
        self.passthrough_channels.insert(channel.id());
        self.tunnel_opens.fetch_add(1, Ordering::SeqCst);
        reply.accept().await;
        tokio::spawn(async move {
            let Ok(mut target) = tokio::net::TcpStream::connect((host.as_str(), port)).await else {
                return;
            };
            let mut remote = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut target, &mut remote).await;
        });
        Ok(())
    }
}

// ============================ 内存 SFTP 文件系统 ============================

struct MockEntry {
    is_dir: bool,
    data: Vec<u8>,
    permissions: u32,
    /// 最近写入时间（unix 秒），同步功能依赖 mtime 比较差异。
    mtime: u64,
}

/// 连接级共享的内存文件系统。
///
/// 客户端每次 SFTP 操作都会新开一个子系统会话，状态若只挂在单个会话上，
/// 「写入后再读回」就会落到另一个空文件系统里，因此状态必须挂在 SSH 连接上。
#[derive(Clone)]
pub struct SharedFs(Arc<Mutex<HashMap<String, MockEntry>>>);

impl SharedFs {
    fn seeded() -> Self {
        let mut fs = HashMap::new();
        fs.insert(
            "/".to_string(),
            MockEntry {
                is_dir: true,
                data: Vec::new(),
                permissions: 0o755,
                mtime: now_unix_secs(),
            },
        );
        fs.insert(
            "/logs".to_string(),
            MockEntry {
                is_dir: true,
                data: Vec::new(),
                permissions: 0o755,
                mtime: now_unix_secs(),
            },
        );
        fs.insert(
            "/readme.txt".to_string(),
            MockEntry {
                is_dir: false,
                data: b"hello from mock sftp\n".to_vec(),
                permissions: 0o644,
                mtime: now_unix_secs(),
            },
        );
        SharedFs(Arc::new(Mutex::new(fs)))
    }
}

/// 单个 SFTP 会话：在连接级共享文件系统之上维护句柄表。
pub struct MockSftpFs {
    fs: SharedFs,
    handles: HashMap<String, String>,
    read_done: HashSet<String>,
    next_handle: u64,
}

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn mode_bits(is_dir: bool) -> u32 {
    if is_dir {
        FileMode::DIR.bits()
    } else {
        FileMode::REG.bits()
    }
}

fn attrs_of(entry: &MockEntry) -> FileAttributes {
    FileAttributes {
        size: Some(entry.data.len() as u64),
        uid: Some(0),
        user: None,
        gid: Some(0),
        group: None,
        permissions: Some(entry.permissions | mode_bits(entry.is_dir)),
        atime: Some(0),
        mtime: Some(entry.mtime as u32),
    }
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

impl MockSftpFs {
    pub fn new(fs: SharedFs) -> Self {
        MockSftpFs {
            fs,
            handles: HashMap::new(),
            read_done: HashSet::new(),
            next_handle: 1,
        }
    }

    /// 把客户端传来的路径归一成绝对路径。
    fn resolve(&self, path: &str) -> String {
        let path = path.trim();
        if path.is_empty() || path == "." || path == "./" {
            return "/".to_string();
        }
        if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        }
    }

    fn open_handle(&mut self, path: &str) -> String {
        let handle = format!("h{}", self.next_handle);
        self.next_handle += 1;
        self.handles.insert(handle.clone(), path.to_string());
        handle
    }

    fn path_of(&self, handle: &str) -> Result<String, StatusCode> {
        self.handles.get(handle).cloned().ok_or(StatusCode::Failure)
    }
}

impl russh_sftp::server::Handler for MockSftpFs {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let resolved = self.resolve(&path);
        Ok(Name {
            id,
            files: vec![File::dummy(resolved)],
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let resolved = self.resolve(&path);
        let fs = self.fs.0.lock().await;
        let entry = fs.get(&resolved).ok_or(StatusCode::NoSuchFile)?;
        Ok(Attrs {
            id,
            attrs: attrs_of(entry),
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let resolved = self.resolve(&path);
        {
            let fs = self.fs.0.lock().await;
            match fs.get(&resolved) {
                Some(entry) if entry.is_dir => {}
                Some(_) => return Err(StatusCode::Failure),
                None => return Err(StatusCode::NoSuchFile),
            }
        }
        let handle = self.open_handle(&resolved);
        Ok(Handle { id, handle })
    }

    /// 一次性返回目录下所有直接子项，第二次调用报 EOF —— 客户端靠 EOF 结束迭代。
    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let dir = self.path_of(&handle)?;
        if !self.read_done.insert(handle) {
            return Err(StatusCode::Eof);
        }
        let prefix = if dir == "/" {
            "/".to_string()
        } else {
            format!("{dir}/")
        };
        let fs = self.fs.0.lock().await;
        let mut files = Vec::new();
        for (path, entry) in fs.iter() {
            if path == &dir {
                continue;
            }
            let Some(rest) = path.strip_prefix(&prefix) else {
                continue;
            };
            // 只要直接子项，孙辈留给下一次 opendir。
            if rest.is_empty() || rest.contains('/') {
                continue;
            }
            files.push(File::new(rest, attrs_of(entry)));
        }
        files.sort_by(|left, right| left.filename.cmp(&right.filename));
        Ok(Name { id, files })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let resolved = self.resolve(&filename);
        let creating = pflags.contains(OpenFlags::CREATE) || pflags.contains(OpenFlags::TRUNCATE);
        {
            let mut fs = self.fs.0.lock().await;
            match fs.get_mut(&resolved) {
                Some(entry) if pflags.contains(OpenFlags::TRUNCATE) && !entry.is_dir => {
                    entry.data.clear();
                    entry.mtime = now_unix_secs();
                }
                Some(_) => {}
                None => {
                    if !creating {
                        return Err(StatusCode::NoSuchFile);
                    }
                    fs.insert(
                        resolved.clone(),
                        MockEntry {
                            is_dir: false,
                            data: Vec::new(),
                            permissions: 0o644,
                            mtime: now_unix_secs(),
                        },
                    );
                }
            }
        }
        let handle = self.open_handle(&resolved);
        Ok(Handle { id, handle })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let path = self.path_of(&handle)?;
        let fs = self.fs.0.lock().await;
        let entry = fs.get(&path).ok_or(StatusCode::NoSuchFile)?;
        let start = (offset as usize).min(entry.data.len());
        let end = (start + len as usize).min(entry.data.len());
        if start >= entry.data.len() {
            // 读到文件末尾，客户端据此停止拉取。
            return Err(StatusCode::Eof);
        }
        Ok(Data {
            id,
            data: entry.data[start..end].to_vec(),
        })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let path = self.path_of(&handle)?;
        let mut fs = self.fs.0.lock().await;
        let entry = fs.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
        let offset = offset as usize;
        if entry.data.len() < offset {
            entry.data.resize(offset, 0);
        }
        let end = offset + data.len();
        if entry.data.len() < end {
            entry.data.resize(end, 0);
        }
        entry.data[offset..end].copy_from_slice(&data);
        Ok(ok_status(id))
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        self.read_done.remove(&handle);
        Ok(ok_status(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let resolved = self.resolve(&path);
        let mut fs = self.fs.0.lock().await;
        if fs.contains_key(&resolved) {
            return Err(StatusCode::Failure);
        }
        fs.insert(
            resolved,
            MockEntry {
                is_dir: true,
                data: Vec::new(),
                permissions: 0o755,
                mtime: now_unix_secs(),
            },
        );
        Ok(ok_status(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let resolved = self.resolve(&filename);
        let mut fs = self.fs.0.lock().await;
        match fs.get(&resolved) {
            Some(entry) if !entry.is_dir => {}
            Some(_) => return Err(StatusCode::Failure),
            None => return Err(StatusCode::NoSuchFile),
        }
        fs.remove(&resolved);
        Ok(ok_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let resolved = self.resolve(&path);
        let mut fs = self.fs.0.lock().await;
        match fs.get(&resolved) {
            Some(entry) if entry.is_dir => {}
            Some(_) => return Err(StatusCode::Failure),
            None => return Err(StatusCode::NoSuchFile),
        }
        fs.remove(&resolved);
        Ok(ok_status(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let from = self.resolve(&oldpath);
        let to = self.resolve(&newpath);
        let mut fs = self.fs.0.lock().await;
        let entry = fs.remove(&from).ok_or(StatusCode::NoSuchFile)?;
        fs.insert(to, entry);
        Ok(ok_status(id))
    }

    /// `chmod` 走到这里，只更新权限位，保留类型位。
    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let resolved = self.resolve(&path);
        let Some(new_perms) = attrs.permissions else {
            return Ok(ok_status(id));
        };
        let mut fs = self.fs.0.lock().await;
        let entry = fs.get_mut(&resolved).ok_or(StatusCode::NoSuchFile)?;
        entry.permissions = new_perms & 0o7777;
        Ok(ok_status(id))
    }
}

// ============================ 启动与辅助 ============================

/// 起一个测试 SSH 服务器，返回监听端口。
pub async fn start_test_server(port_ready: tokio::sync::oneshot::Sender<u16>) {
    start_test_server_tracked(port_ready, Arc::new(std::sync::atomic::AtomicUsize::new(0))).await
}

/// 起一个测试 SSH 服务器并把 direct-tcpip 隧道计数写进调用方给的计数器，
/// 供多跳测试证明「流量真的穿过了跳板」。
pub async fn start_test_server_tracked(
    port_ready: tokio::sync::oneshot::Sender<u16>,
    tunnel_opens: Arc<std::sync::atomic::AtomicUsize>,
) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _ = port_ready.send(port);
    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        auth_rejection_time: Duration::from_millis(100),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        keys: vec![PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()],
        ..Default::default()
    });
    let mut server = TestServer { tunnel_opens };
    server.run_on_socket(config, &listener).await.unwrap();
}

pub fn connect_req(port: u16, auto_reconnect: bool) -> ConnectRequest {
    ConnectRequest {
        name: "echo-test".to_string(),
        host: "127.0.0.1".to_string(),
        port,
        username: "test".to_string(),
        auth_method: "password".to_string(),
        password: Some("secret".to_string()),
        key_path: None,
        passphrase: None,
        otp_secret: None,
        keepalive: 5,
        auto_reconnect,
        proxy: None,
    }
}

/// 构造一条跳板链请求（每跳都是 password 认证的本地测试服务器）。
pub fn chain_proxy(hops: &[u16]) -> catshell_lib::ssh_manager::ProxyConfig {
    use catshell_lib::ssh_manager::ProxyConfig;
    let mut next: Option<Box<ProxyConfig>> = None;
    for &port in hops.iter().rev() {
        next = Some(Box::new(ProxyConfig {
            host: "127.0.0.1".to_string(),
            port,
            username: "test".to_string(),
            auth_method: "password".to_string(),
            password: Some("secret".to_string()),
            key_path: None,
            passphrase: None,
            next,
        }));
    }
    *next.expect("至少一跳")
}

/// 接受最近一次待确认的主机指纹。返回是否真的有一次待确认请求。
pub async fn accept_pending_host_key(manager: &SshManager, sink: &TestSink) -> bool {
    let token = sink
        .last_event("host-key-prompt")
        .and_then(|payload| payload["token"].as_str().map(str::to_owned));
    match token {
        Some(token) => manager.confirm_host_key(token, true).await.is_ok(),
        None => false,
    }
}

/// 每个测试用独立 known_hosts 文件，避免相互污染。
pub fn test_known_hosts_path(label: &str, port: u16) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "catshell-{label}-{}-{port}-known-hosts",
        std::process::id()
    ))
}

/// 建立连接并把主机指纹学进 known_hosts，返回会话 id。
pub async fn connect_and_trust(
    manager: &Arc<SshManager>,
    sink: &Arc<TestSink>,
    collector: Option<Arc<dyn RawOutput>>,
    req: ConnectRequest,
) -> u64 {
    let id = manager
        .create(manager.clone(), sink.clone(), collector, req)
        .await
        .expect("create should succeed");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !sink.connected.load(Ordering::SeqCst) && tokio::time::Instant::now() < deadline {
        accept_pending_host_key(manager, sink).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        sink.connected.load(Ordering::SeqCst),
        "should connect within 15s, events: {:?}",
        sink.events
            .lock()
            .unwrap()
            .iter()
            .take(8)
            .collect::<Vec<_>>()
    );
    id
}
