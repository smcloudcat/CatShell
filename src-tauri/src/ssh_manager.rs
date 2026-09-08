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
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, name: &str, payload: serde_json::Value);
}

const MAX_RECONNECT_ATTEMPTS: u32 = 3;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MANUAL_POLL_INTERVAL: Duration = Duration::from_millis(800);
const HOST_KEY_CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_SFTP_FILE_SIZE: usize = 64 * 1024 * 1024;

fn reconnect_delay(attempt: u32) -> Duration {
    match attempt {
        1 => Duration::from_secs(2),
        2 => Duration::from_secs(5),
        _ => Duration::from_secs(10),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub otp_secret: Option<String>,
    #[serde(default = "default_keepalive")]
    pub keepalive: u64,
    #[serde(default)]
    pub auto_reconnect: bool,
}

fn default_keepalive() -> u64 {
    30
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: u64,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMetrics {
    pub session_id: u64,
    pub hostname: String,
    pub os: String,
    pub cpu_cores: u32,
    pub load_1m: f64,
    pub memory_total_kb: u64,
    pub memory_available_kb: u64,
    pub disk_total_kb: u64,
    pub disk_used_kb: u64,
    pub disk_available_kb: u64,
    pub network_rx_bytes: u64,
    pub network_tx_bytes: u64,
    pub collected_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f64,
    pub memory_percent: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiagnostic {
    pub session_id: u64,
    pub kind: String,
    pub target: String,
    pub output: String,
    pub collected_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInfo {
    pub id: u64,
    pub session_id: u64,
    pub direction: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

#[derive(Clone, Debug)]
struct RemoteForwardRoute {
    target_host: String,
    target_port: u16,
}

#[derive(Clone, Debug)]
struct RemoteForwardInfo {
    session_id: u64,
    bind_host: String,
    bind_port: u16,
    requested_port: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: Option<i64>,
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

fn now_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
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
    known_hosts_path: Option<PathBuf>,
    next_id: AtomicU64,
    pub forwards: Mutex<HashMap<u64, JoinHandle<()>>>,
    pub forward_info: Mutex<HashMap<u64, PortForwardInfo>>,
    remote_forwards: Mutex<HashMap<u64, RemoteForwardInfo>>,
    remote_routes: Arc<Mutex<HashMap<(u64, u16), RemoteForwardRoute>>>,
    next_forward_id: AtomicU64,
}

#[cfg(test)]
mod tests {
    use super::{parse_metrics, parse_processes, read_socks_target, validate_network_target};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[test]
    fn parses_metrics_payload() {
        let payload = b"noise\n__SSHOPS_METRICS_V1__\nos=Linux\nhostname=node-1\ncpu_cores=4\nload1=0.42\nmem_total_kb=8000\nmem_available_kb=3000\ndisk_total_kb=100000\ndisk_used_kb=25000\ndisk_available_kb=75000\nnetwork_rx_bytes=1234\nnetwork_tx_bytes=5678\n__SSHOPS_METRICS_END__\n";
        let metrics = parse_metrics(7, payload).expect("metrics should parse");
        assert_eq!(metrics.session_id, 7);
        assert_eq!(metrics.hostname, "node-1");
        assert_eq!(metrics.cpu_cores, 4);
        assert!((metrics.load_1m - 0.42).abs() < f64::EPSILON);
        assert_eq!(metrics.disk_used_kb, 25_000);
    }

    #[test]
    fn rejects_incomplete_metrics_payload() {
        let error = parse_metrics(7, b"__SSHOPS_METRICS_V1__\nos=Linux\n")
            .expect_err("incomplete payload must fail");
        assert!(error.contains("未正常结束"));
    }

    #[test]
    fn parses_process_table_and_ignores_invalid_rows() {
        let processes = parse_processes(b" 12 sshd 1.5 0.2\ninvalid\n13 nginx 0.0 1.1\n");
        assert_eq!(processes.len(), 2);
        assert_eq!(processes[0].pid, 12);
        assert_eq!(processes[1].name, "nginx");
    }

    #[test]
    fn rejects_network_command_injection_targets() {
        assert_eq!(
            validate_network_target("example.internal").unwrap(),
            "example.internal"
        );
        assert!(validate_network_target("example.internal;id").is_err());
        assert!(validate_network_target("-n").is_err());
    }

    #[tokio::test]
    async fn parses_socks5_domain_connect_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
            let mut response = [0_u8; 2];
            stream.read_exact(&mut response).await.unwrap();
            assert_eq!(response, [0x05, 0x00]);
            stream
                .write_all(&[
                    0x05, 0x01, 0x00, 0x03, 0x0b, b'e', b'x', b'a', b'm', b'p', b'l', b'e', b'.',
                    b'c', b'o', b'm', 0x01, 0xbb,
                ])
                .await
                .unwrap();
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        let target = read_socks_target(&mut stream).await.unwrap();
        assert_eq!(target, ("example.com".to_string(), 443));
        client.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_unsupported_socks5_command() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
            let mut response = [0_u8; 2];
            stream.read_exact(&mut response).await.unwrap();
            stream
                .write_all(&[0x05, 0x03, 0x00, 0x01, 127, 0, 0, 1, 0, 53])
                .await
                .unwrap();
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        assert_eq!(read_socks_target(&mut stream).await.unwrap_err(), 0x07);
        client.await.unwrap();
    }
}

impl Default for SshManager {
    fn default() -> Self {
        SshManager {
            sessions: Mutex::new(HashMap::new()),
            host_key_confirmations: Arc::new(Mutex::new(HashMap::new())),
            known_hosts_path: None,
            next_id: AtomicU64::new(1),
            forwards: Mutex::new(HashMap::new()),
            forward_info: Mutex::new(HashMap::new()),
            remote_forwards: Mutex::new(HashMap::new()),
            remote_routes: Arc::new(Mutex::new(HashMap::new())),
            next_forward_id: AtomicU64::new(1),
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
    remote_routes: Arc<Mutex<HashMap<(u64, u16), RemoteForwardRoute>>>,
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

async fn read_socks_target(stream: &mut TcpStream) -> Result<(String, u16), u8> {
    let mut greeting = [0_u8; 2];
    stream.read_exact(&mut greeting).await.map_err(|_| 0x01)?;
    if greeting[0] != 0x05 || greeting[1] == 0 || greeting[1] > 32 {
        return Err(0x01);
    }
    let mut methods = vec![0_u8; greeting[1] as usize];
    stream.read_exact(&mut methods).await.map_err(|_| 0x01)?;
    if !methods.contains(&0x00) {
        let _ = stream.write_all(&[0x05, 0xff]).await;
        return Err(0xff);
    }
    stream.write_all(&[0x05, 0x00]).await.map_err(|_| 0x01)?;

    let mut request = [0_u8; 4];
    stream.read_exact(&mut request).await.map_err(|_| 0x01)?;
    if request[0] != 0x05 || request[2] != 0x00 {
        return Err(0x01);
    }
    if request[1] != 0x01 {
        return Err(0x07);
    }
    let host = match request[3] {
        0x01 => {
            let mut address = [0_u8; 4];
            stream.read_exact(&mut address).await.map_err(|_| 0x01)?;
            std::net::Ipv4Addr::from(address).to_string()
        }
        0x03 => {
            let length = stream.read_u8().await.map_err(|_| 0x01)? as usize;
            if length == 0 {
                return Err(0x08);
            }
            let mut address = vec![0_u8; length];
            stream.read_exact(&mut address).await.map_err(|_| 0x01)?;
            let address = String::from_utf8(address).map_err(|_| 0x08)?;
            validate_network_target(&address).map_err(|_| 0x08)?
        }
        0x04 => {
            let mut address = [0_u8; 16];
            stream.read_exact(&mut address).await.map_err(|_| 0x01)?;
            std::net::Ipv6Addr::from(address).to_string()
        }
        _ => return Err(0x08),
    };
    let port = stream.read_u16().await.map_err(|_| 0x01)?;
    if port == 0 {
        return Err(0x01);
    }
    Ok((host, port))
}

async fn write_socks_reply(stream: &mut TcpStream, status: u8) {
    let _ = stream
        .write_all(&[0x05, status, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        .await;
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

const MONITOR_COMMAND: &str = r#"printf '__SSHOPS_METRICS_V1__\n'; printf 'os='; (uname -s 2>/dev/null || echo unknown); printf 'hostname='; (hostname 2>/dev/null || echo unknown); printf 'cpu_cores='; (getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0); printf 'load1='; (awk '{print $1}' /proc/loadavg 2>/dev/null || uptime 2>/dev/null | awk -F'load averages?: ' '{print $2}' | awk '{print $1}' || echo 0); printf 'mem_total_kb='; (awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); printf 'mem_available_kb='; (awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || awk '/^MemFree:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); printf 'disk_total_kb='; (df -Pk / 2>/dev/null | awk 'NR==2 {print $2}' || echo 0); printf 'disk_used_kb='; (df -Pk / 2>/dev/null | awk 'NR==2 {print $3}' || echo 0); printf 'disk_available_kb='; (df -Pk / 2>/dev/null | awk 'NR==2 {print $4}' || echo 0); printf 'network_rx_bytes='; (awk 'NR>2 && $1 !~ /^lo:/ {gsub(":", "", $1); rx += $2} END {print rx+0}' /proc/net/dev 2>/dev/null || echo 0); printf 'network_tx_bytes='; (awk 'NR>2 && $1 !~ /^lo:/ {gsub(":", "", $1); tx += $10} END {print tx+0}' /proc/net/dev 2>/dev/null || echo 0); printf '__SSHOPS_METRICS_END__\n'"#;
const PROCESS_COMMAND: &str = "ps -eo pid=,comm=,%cpu=,%mem= --sort=-%cpu 2>/dev/null | head -n 31";

fn parse_metric_u64(values: &HashMap<String, String>, key: &str) -> Result<u64, String> {
    values
        .get(key)
        .ok_or_else(|| format!("远程监控缺少指标: {key}"))?
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("远程监控指标无效: {key}"))
}

fn parse_metrics(session_id: u64, output: &[u8]) -> Result<ServerMetrics, String> {
    let text = String::from_utf8_lossy(output);
    let start = text
        .find("__SSHOPS_METRICS_V1__")
        .ok_or_else(|| "远程主机不支持监控采集协议".to_string())?;
    let end = text[start..]
        .find("__SSHOPS_METRICS_END__")
        .ok_or_else(|| "远程监控采集未正常结束".to_string())?
        + start;
    let mut values = HashMap::new();
    for line in text[start..end].lines().skip(1) {
        if let Some((key, value)) = line.split_once('=') {
            values.insert(key.to_string(), value.trim().to_string());
        }
    }
    let load_1m = values
        .get("load1")
        .ok_or_else(|| "远程监控缺少指标: load1".to_string())?
        .parse::<f64>()
        .map_err(|_| "远程监控指标无效: load1".to_string())?;
    let hostname = values
        .get("hostname")
        .cloned()
        .unwrap_or_else(|| "unknown".to_string());
    let os = values
        .get("os")
        .cloned()
        .unwrap_or_else(|| "unknown".to_string());
    Ok(ServerMetrics {
        session_id,
        hostname,
        os,
        cpu_cores: parse_metric_u64(&values, "cpu_cores")?.clamp(1, u32::MAX as u64) as u32,
        load_1m,
        memory_total_kb: parse_metric_u64(&values, "mem_total_kb")?,
        memory_available_kb: parse_metric_u64(&values, "mem_available_kb")?,
        disk_total_kb: parse_metric_u64(&values, "disk_total_kb")?,
        disk_used_kb: parse_metric_u64(&values, "disk_used_kb")?,
        disk_available_kb: parse_metric_u64(&values, "disk_available_kb")?,
        network_rx_bytes: parse_metric_u64(&values, "network_rx_bytes")?,
        network_tx_bytes: parse_metric_u64(&values, "network_tx_bytes")?,
        collected_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default(),
    })
}

async fn read_exec_output(mut read: ChannelReadHalf) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    while let Some(message) = read.wait().await {
        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                output.extend_from_slice(&data);
                if output.len() > 256 * 1024 {
                    return Err("远程监控输出超过限制".to_string());
                }
            }
            ChannelMsg::Close => break,
            ChannelMsg::Eof => break,
            _ => {}
        }
    }
    Ok(output)
}

async fn exec_command(
    connection: &mut client::Handle<SshHandler>,
    command: &str,
) -> Result<Vec<u8>, String> {
    let channel = connection
        .channel_open_session()
        .await
        .map_err(|error| format!("打开远程命令通道失败: {error}"))?;
    channel
        .exec(false, command)
        .await
        .map_err(|error| format!("执行远程命令失败: {error}"))?;
    let (read, _write) = channel.split();
    tokio::time::timeout(Duration::from_secs(8), read_exec_output(read))
        .await
        .map_err(|_| "远程命令执行超时".to_string())?
}

fn parse_processes(output: &[u8]) -> Vec<ProcessInfo> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let name = fields.next()?.to_string();
            let cpu_percent = fields.next()?.parse().ok()?;
            let memory_percent = fields.next()?.parse().ok()?;
            Some(ProcessInfo {
                pid,
                name,
                cpu_percent,
                memory_percent,
            })
        })
        .collect()
}

fn validate_network_target(target: &str) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty()
        || target.starts_with('-')
        || target.len() > 253
        || !target.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']' | b'_')
        })
    {
        return Err("网络诊断目标无效".to_string());
    }
    Ok(target.to_string())
}

async fn open_shell(
    creds: &ConnectRequest,
    session_id: u64,
    sink: Arc<dyn EventSink>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    known_hosts_path: Option<PathBuf>,
    remote_routes: Arc<Mutex<HashMap<(u64, u16), RemoteForwardRoute>>>,
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
    .map_err(|_| ConnectError::transient(format!("连接超时：{} 秒内未能与服务器建立连接", CONNECT_TIMEOUT.as_secs())))?
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
                                        } else if text.contains("password") || text.contains("密码") {
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
        other => return Err(ConnectError::permanent(format!("不支持的认证方式: {other}"))),
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
            manager.known_hosts_path.clone(),
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
            known_hosts_path: Some(path),
            ..Self::default()
        }
    }

    async fn session_ref(&self, id: u64) -> Result<Arc<ActiveSession>, String> {
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

    pub async fn monitor(&self, id: u64) -> Result<ServerMetrics, String> {
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        let channel = connection
            .channel_open_session()
            .await
            .map_err(|error| format!("打开监控通道失败: {error}"))?;
        channel
            .exec(false, MONITOR_COMMAND)
            .await
            .map_err(|error| format!("执行监控命令失败: {error}"))?;
        let (read, _write) = channel.split();
        let output = tokio::time::timeout(Duration::from_secs(8), read_exec_output(read))
            .await
            .map_err(|_| "远程监控采集超时".to_string())??;
        parse_metrics(id, &output)
    }

    pub async fn list_processes(&self, id: u64) -> Result<Vec<ProcessInfo>, String> {
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        Ok(parse_processes(
            &exec_command(connection, PROCESS_COMMAND).await?,
        ))
    }

    pub async fn kill_process(&self, id: u64, pid: u32) -> Result<(), String> {
        if pid == 0 || pid > 4_194_304 {
            return Err("进程号无效".to_string());
        }
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        let command = format!("kill -TERM {pid}");
        exec_command(connection, &command).await.map(|_| ())
    }

    pub async fn network_diagnostic(
        &self,
        id: u64,
        kind: String,
        target: String,
    ) -> Result<NetworkDiagnostic, String> {
        let kind = kind.trim().to_ascii_lowercase();
        if kind != "ping" && kind != "trace" {
            return Err("不支持的网络诊断类型".to_string());
        }
        let target = validate_network_target(&target)?;
        let command = if kind == "ping" {
            format!("ping -c 4 -W 2 -- {target} 2>&1")
        } else {
            format!("(tracepath -m 12 -w 2 {target} || traceroute -m 12 -w 2 {target} || ping -c 1 -W 2 {target}) 2>&1")
        };
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        let output = exec_command(connection, &command).await?;
        Ok(NetworkDiagnostic {
            session_id: id,
            kind,
            target,
            output: String::from_utf8_lossy(&output).trim().to_string(),
            collected_at: now_unix_seconds(),
        })
    }

    pub async fn start_local_forward(
        &self,
        manager: Arc<SshManager>,
        session_id: u64,
        bind_host: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    ) -> Result<PortForwardInfo, String> {
        let bind_host = bind_host.trim().to_string();
        if bind_host != "127.0.0.1" && bind_host != "localhost" && bind_host != "::1" {
            return Err("本地转发只允许绑定回环地址".to_string());
        }
        let target_host = validate_network_target(&target_host)?;
        if target_port == 0 {
            return Err("目标端口无效".to_string());
        }
        {
            let session = self.session_ref(session_id).await?;
            if session.conn.lock().await.is_none() {
                return Err("会话尚未连接".to_string());
            }
        }
        let listener = TcpListener::bind((bind_host.as_str(), bind_port))
            .await
            .map_err(|error| format!("绑定本地端口失败: {error}"))?;
        let actual_port = listener
            .local_addr()
            .map_err(|error| format!("读取本地端口失败: {error}"))?
            .port();
        let id = self.next_forward_id.fetch_add(1, Ordering::SeqCst);
        let info = PortForwardInfo {
            id,
            session_id,
            direction: "local".to_string(),
            bind_host: bind_host.clone(),
            bind_port: actual_port,
            target_host: target_host.clone(),
            target_port,
        };
        let task_info = info.clone();
        let task = tokio::spawn(async move {
            let session_id = task_info.session_id;
            let target_host = task_info.target_host.clone();
            let target_port = task_info.target_port;
            loop {
                let (local, _) = match listener.accept().await {
                    Ok(connection) => connection,
                    Err(_) => break,
                };
                let manager = manager.clone();
                let target_host = target_host.clone();
                tokio::spawn(async move {
                    let channel = {
                        let Ok(session) = manager.session_ref(session_id).await else {
                            return;
                        };
                        let mut connection = session.conn.lock().await;
                        let Some(connection) = connection.as_mut() else {
                            return;
                        };
                        match connection
                            .channel_open_direct_tcpip(
                                &target_host,
                                target_port as u32,
                                "127.0.0.1",
                                0,
                            )
                            .await
                        {
                            Ok(channel) => channel,
                            Err(_) => return,
                        }
                    };
                    let mut remote = channel.into_stream();
                    let mut local = local;
                    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                });
            }
        });
        self.forwards.lock().await.insert(id, task);
        self.forward_info.lock().await.insert(id, info.clone());
        Ok(info)
    }

    pub async fn start_remote_forward(
        &self,
        session_id: u64,
        bind_host: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    ) -> Result<PortForwardInfo, String> {
        let bind_host = bind_host.trim().to_string();
        if bind_host != "127.0.0.1" && bind_host != "localhost" {
            return Err("远程转发只允许监听远端回环地址".to_string());
        }
        let target_host = validate_network_target(&target_host)?;
        if target_port == 0 {
            return Err("目标端口无效".to_string());
        }
        let session = self.session_ref(session_id).await?;
        let actual_port = {
            let mut connection = session.conn.lock().await;
            let connection = connection
                .as_mut()
                .ok_or_else(|| "会话尚未连接".to_string())?;
            let port = connection
                .tcpip_forward(bind_host.clone(), bind_port as u32)
                .await
                .map_err(|error| format!("请求远程端口转发失败: {error}"))?;
            u16::try_from(if port == 0 { bind_port as u32 } else { port })
                .map_err(|_| "远程端口无效".to_string())?
        };
        if actual_port == 0 {
            return Err("远程服务器未返回有效监听端口".to_string());
        }

        let id = self.next_forward_id.fetch_add(1, Ordering::SeqCst);
        self.remote_routes.lock().await.insert(
            (session_id, actual_port),
            RemoteForwardRoute {
                target_host: target_host.clone(),
                target_port,
            },
        );
        self.remote_forwards.lock().await.insert(
            id,
            RemoteForwardInfo {
                session_id,
                bind_host: bind_host.clone(),
                bind_port: actual_port,
                requested_port: bind_port,
            },
        );
        let info = PortForwardInfo {
            id,
            session_id,
            direction: "remote".to_string(),
            bind_host,
            bind_port: actual_port,
            target_host,
            target_port,
        };
        self.forward_info.lock().await.insert(id, info.clone());
        Ok(info)
    }

    pub async fn start_dynamic_forward(
        &self,
        manager: Arc<SshManager>,
        session_id: u64,
        bind_host: String,
        bind_port: u16,
    ) -> Result<PortForwardInfo, String> {
        let bind_host = bind_host.trim().to_string();
        if bind_host != "127.0.0.1" && bind_host != "localhost" && bind_host != "::1" {
            return Err("动态转发只允许绑定回环地址".to_string());
        }
        {
            let session = self.session_ref(session_id).await?;
            if session.conn.lock().await.is_none() {
                return Err("会话尚未连接".to_string());
            }
        }
        let listener = TcpListener::bind((bind_host.as_str(), bind_port))
            .await
            .map_err(|error| format!("绑定 SOCKS5 端口失败: {error}"))?;
        let actual_port = listener
            .local_addr()
            .map_err(|error| format!("读取 SOCKS5 端口失败: {error}"))?
            .port();
        let id = self.next_forward_id.fetch_add(1, Ordering::SeqCst);
        let info = PortForwardInfo {
            id,
            session_id,
            direction: "dynamic".to_string(),
            bind_host: bind_host.clone(),
            bind_port: actual_port,
            target_host: "SOCKS5".to_string(),
            target_port: 0,
        };
        let task = tokio::spawn(async move {
            loop {
                let (mut local, peer) = match listener.accept().await {
                    Ok(connection) => connection,
                    Err(_) => break,
                };
                let manager = manager.clone();
                tokio::spawn(async move {
                    let (target_host, target_port) = match tokio::time::timeout(
                        Duration::from_secs(10),
                        read_socks_target(&mut local),
                    )
                    .await
                    {
                        Ok(Ok(target)) => target,
                        Ok(Err(status)) => {
                            if status != 0xff {
                                write_socks_reply(&mut local, status).await;
                            }
                            return;
                        }
                        Err(_) => {
                            write_socks_reply(&mut local, 0x01).await;
                            return;
                        }
                    };
                    let channel = {
                        let Ok(session) = manager.session_ref(session_id).await else {
                            write_socks_reply(&mut local, 0x01).await;
                            return;
                        };
                        let mut connection = session.conn.lock().await;
                        let Some(connection) = connection.as_mut() else {
                            write_socks_reply(&mut local, 0x01).await;
                            return;
                        };
                        match connection
                            .channel_open_direct_tcpip(
                                &target_host,
                                target_port as u32,
                                peer.ip().to_string(),
                                peer.port() as u32,
                            )
                            .await
                        {
                            Ok(channel) => channel,
                            Err(_) => {
                                write_socks_reply(&mut local, 0x05).await;
                                return;
                            }
                        }
                    };
                    write_socks_reply(&mut local, 0x00).await;
                    let mut remote = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                });
            }
        });
        self.forwards.lock().await.insert(id, task);
        self.forward_info.lock().await.insert(id, info.clone());
        Ok(info)
    }

    pub async fn list_local_forwards(&self) -> Vec<PortForwardInfo> {
        self.forward_info.lock().await.values().cloned().collect()
    }

    pub async fn stop_forward(&self, id: u64) -> Result<(), String> {
        if let Some(task) = self.forwards.lock().await.remove(&id) {
            task.abort();
            self.forward_info.lock().await.remove(&id);
            return Ok(());
        }

        let remote = self
            .remote_forwards
            .lock()
            .await
            .remove(&id)
            .ok_or_else(|| "端口转发不存在".to_string())?;
        let cancel_result = {
            let session = self.session_ref(remote.session_id).await.ok();
            if let Some(session) = session {
                let mut connection = session.conn.lock().await;
                if let Some(connection) = connection.as_mut() {
                    Some(
                        connection
                            .cancel_tcpip_forward(remote.bind_host.clone(), remote.bind_port as u32)
                            .await
                            .map_err(|error| format!("停止远程端口转发失败: {error}")),
                    )
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some(Err(error)) = cancel_result {
            self.remote_forwards.lock().await.insert(id, remote);
            return Err(error);
        }
        self.remote_routes
            .lock()
            .await
            .remove(&(remote.session_id, remote.bind_port));
        self.forward_info.lock().await.remove(&id);
        Ok(())
    }

    async fn restore_remote_forwards(
        &self,
        session_id: u64,
        connection: &mut client::Handle<SshHandler>,
    ) -> Result<(), String> {
        let forwards: Vec<(u64, RemoteForwardInfo)> = self
            .remote_forwards
            .lock()
            .await
            .iter()
            .filter(|(_, info)| info.session_id == session_id)
            .map(|(id, info)| (*id, info.clone()))
            .collect();
        for (id, info) in forwards {
            let port = connection
                .tcpip_forward(info.bind_host.clone(), info.requested_port as u32)
                .await
                .map_err(|error| format!("恢复远程端口转发失败: {error}"))?;
            let actual_port = u16::try_from(if port == 0 {
                info.requested_port as u32
            } else {
                port
            })
            .map_err(|_| "恢复远程端口无效".to_string())?;
            let mut remote_forwards = self.remote_forwards.lock().await;
            let Some(current) = remote_forwards.get_mut(&id) else {
                continue;
            };
            let old_port = current.bind_port;
            current.bind_port = actual_port;
            drop(remote_forwards);
            let mut routes = self.remote_routes.lock().await;
            let route = routes.remove(&(session_id, old_port));
            if let Some(info) = self.forward_info.lock().await.get_mut(&id) {
                info.bind_port = actual_port;
            }
            // The route target is kept under the new server-assigned port.
            if let Some(route) = route {
                routes.insert((session_id, actual_port), route);
            }
        }
        Ok(())
    }

    async fn stop_forwards_for_session(&self, session_id: u64) {
        let ids: Vec<u64> = self
            .forward_info
            .lock()
            .await
            .values()
            .filter(|info| info.session_id == session_id)
            .map(|info| info.id)
            .collect();
        for id in ids {
            let _ = self.stop_forward(id).await;
        }
    }

    pub async fn sftp_list(&self, id: u64, path: String) -> Result<Vec<SftpEntry>, String> {
        let path = if path.trim().is_empty() {
            ".".to_string()
        } else {
            path
        };
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        let channel = connection
            .channel_open_session()
            .await
            .map_err(|error| format!("打开 SFTP 通道失败: {error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("请求 SFTP 子系统失败: {error}"))?;
        let stream = channel.into_stream();
        let sftp = russh_sftp::client::SftpSession::new(stream)
            .await
            .map_err(|error| format!("初始化 SFTP 失败: {error}"))?;
        let mut entries = sftp
            .read_dir(path)
            .await
            .map_err(|error| format!("读取远程目录失败: {error}"))?;
        let mut result = Vec::new();
        while let Some(entry) = entries.next() {
            let metadata = entry.metadata();
            let kind = if metadata.file_type().is_dir() {
                "directory"
            } else if metadata.file_type().is_symlink() {
                "symlink"
            } else {
                "file"
            };
            result.push(SftpEntry {
                name: entry.file_name(),
                path: entry.path(),
                kind: kind.to_string(),
                size: metadata.size.unwrap_or(0),
                modified_at: metadata.mtime.map(|value| value as i64),
            });
        }
        result.sort_by(|left, right| {
            left.kind
                .cmp(&right.kind)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        let _ = sftp.close().await;
        Ok(result)
    }

    pub async fn sftp_read_file(&self, id: u64, path: String) -> Result<Vec<u8>, String> {
        let path = validate_sftp_path(path)?;
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        let channel = connection
            .channel_open_session()
            .await
            .map_err(|error| format!("打开 SFTP 通道失败: {error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("请求 SFTP 子系统失败: {error}"))?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| format!("初始化 SFTP 失败: {error}"))?;
        let data = sftp
            .read(path)
            .await
            .map_err(|error| format!("读取远程文件失败: {error}"))?;
        if data.len() > MAX_SFTP_FILE_SIZE {
            let _ = sftp.close().await;
            return Err("文件超过 64 MB 下载限制".to_string());
        }
        let _ = sftp.close().await;
        Ok(data)
    }

    pub async fn sftp_write_file(
        &self,
        id: u64,
        path: String,
        data: Vec<u8>,
    ) -> Result<(), String> {
        let path = validate_sftp_path(path)?;
        if data.len() > MAX_SFTP_FILE_SIZE {
            return Err("文件超过 64 MB 上传限制".to_string());
        }
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        let channel = connection
            .channel_open_session()
            .await
            .map_err(|error| format!("打开 SFTP 通道失败: {error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("请求 SFTP 子系统失败: {error}"))?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| format!("初始化 SFTP 失败: {error}"))?;
        let mut file = sftp
            .create(path)
            .await
            .map_err(|error| format!("创建远程文件失败: {error}"))?;
        file.write_all(&data)
            .await
            .map_err(|error| format!("写入远程文件失败: {error}"))?;
        file.shutdown()
            .await
            .map_err(|error| format!("完成远程文件写入失败: {error}"))?;
        sftp.close()
            .await
            .map_err(|error| format!("关闭 SFTP 通道失败: {error}"))
    }

    pub async fn sftp_remove_file(&self, id: u64, path: String) -> Result<(), String> {
        let path = validate_sftp_path(path)?;
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        let channel = connection
            .channel_open_session()
            .await
            .map_err(|error| format!("打开 SFTP 通道失败: {error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("请求 SFTP 子系统失败: {error}"))?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| format!("初始化 SFTP 失败: {error}"))?;
        sftp.remove_file(path)
            .await
            .map_err(|error| format!("删除远程文件失败: {error}"))?;
        sftp.close()
            .await
            .map_err(|error| format!("关闭 SFTP 通道失败: {error}"))
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

fn validate_sftp_path(path: String) -> Result<String, String> {
    let path = path.trim().to_string();
    if path.is_empty() || path.contains('\0') {
        return Err("远程路径无效".to_string());
    }
    if path.len() > 4096 {
        return Err("远程路径过长".to_string());
    }
    Ok(path)
}
