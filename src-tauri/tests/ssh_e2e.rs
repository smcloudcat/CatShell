//! SSH 连接生命周期、认证失败、主机密钥校验的端到端测试。
//!
//! 测试服务器与辅助函数见 `tests/common/mod.rs`。

mod common;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use catshell_lib::ssh_manager::{RawOutput, SshManager};
use common::{
    accept_pending_host_key, connect_and_trust, connect_req, start_test_server,
    test_known_hosts_path, CollectOutput, TestSink,
};
use russh::keys::{Algorithm, PrivateKey};

/// 轮询等待某个条件成立，超时后返回 false。
async fn wait_until<F: Fn() -> bool>(timeout: Duration, check: F) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    check()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_connection_lifecycle() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move { start_test_server(tx).await });
    let port = rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "lifecycle",
        port,
    )));
    let sink = Arc::new(TestSink::new());
    let id = connect_and_trust(&manager, &sink, None, connect_req(port, true)).await;

    manager
        .write(id, b"hello!".to_vec())
        .await
        .expect("write should work");

    let got_echo = wait_until(Duration::from_secs(10), || {
        String::from_utf8_lossy(&sink.output.lock().unwrap()).contains("echo: hello!")
    })
    .await;
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
    assert!(
        wait_until(Duration::from_secs(10), || sink
            .closed
            .load(Ordering::SeqCst))
        .await,
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
    let _server_task = tokio::spawn(async move { start_test_server(tx).await });
    let port = rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "raw-output",
        port,
    )));
    let sink = Arc::new(TestSink::new());
    // 同一份缓冲区既要作为 RawOutput 传给会话，又要在测试里读取，故保留强类型句柄。
    let collector = Arc::new(CollectOutput(StdMutex::new(Vec::new())));
    let output_sink: Arc<dyn RawOutput> = collector.clone();
    let id = connect_and_trust(&manager, &sink, Some(output_sink), connect_req(port, false)).await;

    manager
        .write(id, b"channel-test".to_vec())
        .await
        .expect("write should work");

    let raw = collector.clone();
    let got_raw = wait_until(Duration::from_secs(10), || {
        String::from_utf8_lossy(&raw.0.lock().unwrap()).contains("echo: channel-test")
    })
    .await;
    assert!(got_raw, "raw output channel should receive echoed bytes");

    manager.disconnect(sink.clone(), id).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bad_credentials_rejected_and_no_retry_without_autoreconnect() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let server_task = tokio::spawn(async move { start_test_server(tx).await });
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

    let statuses = sink.statuses();
    let _ = id;
    assert!(
        statuses.contains(&"closed".to_string()),
        "session should close after auth failure, got: {statuses:?}"
    );
    assert!(
        !statuses.contains(&"connected".to_string()),
        "must never connect with wrong password, got: {statuses:?}"
    );
    server_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn auth_failure_does_not_retry_with_auto_reconnect() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let server_task = tokio::spawn(async move { start_test_server(tx).await });
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

    let statuses = sink.statuses();
    let _ = id;
    assert!(
        statuses.contains(&"closed".to_string()),
        "session should close after auth failure, got: {statuses:?}"
    );
    assert!(
        !statuses.contains(&"reconnecting".to_string()),
        "auth failure with auto_reconnect must not emit reconnecting status, got: {statuses:?}"
    );
    assert!(
        !statuses.contains(&"connected".to_string()),
        "must never connect with wrong password, got: {statuses:?}"
    );
    server_task.abort();
}

/// 主机密钥与 known_hosts 记录不一致时必须直接拒绝。
///
/// 这是 MITM 的典型特征：绝不能退化成「弹个框让用户再确认一次」，
/// 因为用户此时看到的指纹正是攻击者的，点「信任」就把中间人放进来了。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changed_host_key_is_rejected_without_prompt() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move { start_test_server(tx).await });
    let port = rx.await.unwrap();

    let known_hosts = test_known_hosts_path("changed-key", port);
    let _ = std::fs::remove_file(&known_hosts);
    let manager = Arc::new(SshManager::with_known_hosts_path(known_hosts.clone()));

    // 第一次连接：指纹未知，走确认流程并被学进 known_hosts。
    let first = Arc::new(TestSink::new());
    let id = connect_and_trust(&manager, &first, None, connect_req(port, false)).await;
    assert!(
        known_hosts.exists(),
        "接受指纹后应写入 known_hosts: {known_hosts:?}"
    );
    let recorded = std::fs::read_to_string(&known_hosts).unwrap();
    assert!(
        recorded.contains("ssh-ed25519"),
        "known_hosts 应包含服务端公钥: {recorded:?}"
    );
    manager.disconnect(first.clone(), id).await;
    let _ = wait_until(Duration::from_secs(10), || {
        first.closed.load(Ordering::SeqCst)
    })
    .await;

    // 把记录替换成另一把密钥，模拟服务端主机密钥被换掉。
    let impostor = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let forged = format!(
        "[127.0.0.1]:{port} {}\n",
        impostor.public_key().to_openssh().unwrap()
    );
    std::fs::write(&known_hosts, forged).unwrap();

    // 第二次连接：必须阻断，且不得重新征求用户同意。
    let second = Arc::new(TestSink::new());
    let _ = manager
        .create(
            manager.clone(),
            second.clone(),
            None,
            connect_req(port, false),
        )
        .await;

    let _ = wait_until(Duration::from_secs(10), || {
        second.closed.load(Ordering::SeqCst)
    })
    .await;

    assert!(
        second.saw_event("host-key-warning"),
        "指纹变更必须发出 host-key-warning 事件"
    );
    assert!(
        !second.saw_event("host-key-prompt"),
        "指纹变更绝不能弹确认框让用户放行，那正是 MITM 想要的结果"
    );
    let statuses = second.statuses();
    assert!(
        !statuses.contains(&"connected".to_string()),
        "指纹变更后绝不能建立连接，got: {statuses:?}"
    );
    assert!(
        statuses.contains(&"closed".to_string()),
        "指纹变更后会话应关闭，got: {statuses:?}"
    );
}
