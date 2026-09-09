use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use catshell_lib::ssh_manager::{ConnectRequest, EventSink, RawOutput, SshManager};
use russh::keys::*;
use russh::server::{self, Msg as ServerMsg, Server as _};
use russh::{Channel, ChannelId};
use serde_json::Value;
use tokio::net::TcpListener;

/// 收集原始输出通道字节的测试桩，验证 IPC Channel 输出路径。
struct CollectOutput(StdMutex<Vec<u8>>);

impl RawOutput for CollectOutput {
    fn send_bytes(&self, data: Vec<u8>) -> Result<(), String> {
        self.0.lock().unwrap().extend_from_slice(&data);
        Ok(())
    }
}

struct TestSink {
    events: std::sync::Mutex<Vec<(String, Value)>>,
    connected: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    output: std::sync::Mutex<Vec<u8>>,
}

impl TestSink {
    fn new() -> Self {
        TestSink {
            events: std::sync::Mutex::new(Vec::new()),
            connected: Arc::new(AtomicBool::new(false)),
            closed: Arc::new(AtomicBool::new(false)),
            output: std::sync::Mutex::new(Vec::new()),
        }
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

#[derive(Clone)]
struct EchoServer;

impl server::Server for EchoServer {
    type Handler = Self;

    fn new_client(&mut self, _addr: Option<std::net::SocketAddr>) -> Self {
        EchoServer
    }

    fn handle_session_error(&mut self, _error: <Self::Handler as server::Handler>::Error) {}
}

impl server::Handler for EchoServer {
    type Error = russh::Error;

    async fn channel_open_session(
        &mut self,
        _channel: Channel<ServerMsg>,
        reply: server::ChannelOpenHandle,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
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

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let echoed = format!("echo: {}\r\n", String::from_utf8_lossy(data));
        session.data(channel, echoed.into_bytes())?;
        Ok(())
    }
}

async fn start_echo_server(port_ready: tokio::sync::oneshot::Sender<u16>) {
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
    let mut server = EchoServer;
    server.run_on_socket(config, &listener).await.unwrap();
}

fn connect_req(port: u16, auto_reconnect: bool) -> ConnectRequest {
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

async fn accept_pending_host_key(manager: &SshManager, sink: &TestSink) {
    let token = sink
        .events
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|(name, _)| name == "host-key-prompt")
        .and_then(|(_, payload)| payload["token"].as_str().map(str::to_owned));
    if let Some(token) = token {
        let _ = manager.confirm_host_key(token, true).await;
    }
}

fn test_known_hosts_path(label: &str, port: u16) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "catshell-{label}-{}-{port}-known-hosts",
        std::process::id()
    ))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_connection_lifecycle() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move { start_echo_server(tx).await });
    let port = rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "lifecycle",
        port,
    )));
    let sink = Arc::new(TestSink::new());
    let id = manager
        .create(manager.clone(), sink.clone(), None, connect_req(port, true))
        .await
        .expect("create should succeed");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !sink.connected.load(Ordering::SeqCst) && tokio::time::Instant::now() < deadline {
        accept_pending_host_key(&manager, &sink).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        sink.connected.load(Ordering::SeqCst),
        "should connect within 15s, events: {:?}",
        sink.events
            .lock()
            .unwrap()
            .iter()
            .take(6)
            .collect::<Vec<_>>()
    );

    manager
        .write(id, b"hello!".to_vec())
        .await
        .expect("write should work");

    let output_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut got_echo = false;
    while tokio::time::Instant::now() < output_deadline {
        let out = sink.output.lock().unwrap().clone();
        if String::from_utf8_lossy(&out).contains("echo: hello!") {
            got_echo = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(got_echo, "should receive echoed output from server");

    tokio::time::sleep(Duration::from_millis(300)).await;
    let session = manager.list().await;
    assert_eq!(session.len(), 1, "manager should track the session");
    assert!(
        session[0].status == "connected" || session[0].status == "connecting",
        "session should be connected, got: {}",
        session[0].status
    );

    manager.disconnect(sink.clone(), id).await;
    let close_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !sink.closed.load(Ordering::SeqCst) && tokio::time::Instant::now() < close_deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        sink.closed.load(Ordering::SeqCst),
        "session should close after manual disconnect"
    );
    let sessions = manager.list().await;
    assert!(
        sessions.is_empty(),
        "session should be removed from manager after close"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn raw_output_channel_receives_shell_data() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move { start_echo_server(tx).await });
    let port = rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "raw-output",
        port,
    )));
    let sink = Arc::new(TestSink::new());
    let collector = Arc::new(CollectOutput(StdMutex::new(Vec::new())));
    let id = manager
        .create(
            manager.clone(),
            sink.clone(),
            Some(collector.clone()),
            connect_req(port, false),
        )
        .await
        .expect("create should succeed");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !sink.connected.load(Ordering::SeqCst) && tokio::time::Instant::now() < deadline {
        accept_pending_host_key(&manager, &sink).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        sink.connected.load(Ordering::SeqCst),
        "should connect within 15s"
    );

    manager
        .write(id, b"channel-test".to_vec())
        .await
        .expect("write should work");

    let output_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut got_raw = false;
    while tokio::time::Instant::now() < output_deadline {
        let out = collector.0.lock().unwrap().clone();
        if String::from_utf8_lossy(&out).contains("echo: channel-test") {
            got_raw = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(got_raw, "raw output channel should receive echoed bytes");

    manager.disconnect(sink.clone(), id).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bad_credentials_rejected_and_no_retry_without_autoreconnect() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let server_task = tokio::spawn(async move { start_echo_server(tx).await });
    let port = rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "bad-credentials",
        port,
    )));
    let sink = Arc::new(TestSink::new());
    let mut req = connect_req(port, false);
    req.password = Some("wrong-password".to_string());
    let id = manager
        .create(manager.clone(), sink.clone(), None, req)
        .await
        .expect("create should not fail");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        accept_pending_host_key(&manager, &sink).await;
        if sink.closed.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let events = sink.events.lock().unwrap();
    let statuses: Vec<&str> = events
        .iter()
        .filter(|(n, _)| n == "session-status")
        .filter_map(|(_, p)| p["status"].as_str())
        .collect();
    let _ = id;
    assert!(
        statuses.contains(&"closed"),
        "session should close after auth failure, got: {statuses:?}"
    );
    assert!(
        !statuses.contains(&"connected"),
        "must never connect with wrong password, got: {statuses:?}"
    );
    server_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn auth_failure_does_not_retry_with_auto_reconnect() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let server_task = tokio::spawn(async move { start_echo_server(tx).await });
    let port = rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "auth-no-retry",
        port,
    )));
    let sink = Arc::new(TestSink::new());
    let mut req = connect_req(port, true);
    req.password = Some("wrong-password".to_string());
    let id = manager
        .create(manager.clone(), sink.clone(), None, req)
        .await
        .expect("create should not fail");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        accept_pending_host_key(&manager, &sink).await;
        if sink.closed.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let events = sink.events.lock().unwrap();
    let statuses: Vec<&str> = events
        .iter()
        .filter(|(n, _)| n == "session-status")
        .filter_map(|(_, p)| p["status"].as_str())
        .collect();
    let _ = id;
    assert!(
        statuses.contains(&"closed"),
        "session should close after auth failure, got: {statuses:?}"
    );
    assert!(
        !statuses.contains(&"reconnecting"),
        "auth failure with auto_reconnect must not emit reconnecting status, got: {statuses:?}"
    );
    assert!(
        !statuses.contains(&"connected"),
        "must never connect with wrong password, got: {statuses:?}"
    );
    server_task.abort();
}
