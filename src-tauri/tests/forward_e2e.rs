//! 端口转发端到端测试：验证本地转发真的把流量送过了 SSH 通道。
//!
//! 测试服务器与辅助函数见 `tests/common/mod.rs`。

mod common;

use std::sync::Arc;
use std::time::Duration;

use catshell_lib::ssh_manager::SshManager;
use common::{connect_and_trust, connect_req, start_test_server, test_known_hosts_path, TestSink};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// 目标服务：一个本地 TCP 回显，充当「转发要到达的内网机器」。
async fn spawn_target_echo(ready: tokio::sync::oneshot::Sender<u16>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _ = ready.send(port);
    while let Ok((mut stream, _)) = listener.accept().await {
        tokio::spawn(async move {
            let mut buffer = vec![0u8; 1024];
            while let Ok(read) = stream.read(&mut buffer).await {
                if read == 0 {
                    break;
                }
                let reply = format!("target: {}", String::from_utf8_lossy(&buffer[..read]));
                if stream.write_all(reply.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
    }
}

/// 本地转发：客户端连本地端口 → SSH 服务端出网 → 目标服务。
///
/// 这是三类转发里唯一不依赖服务端额外请求类型的主路径，
/// 也覆盖了「服务端接受 direct-tcpip 并桥接数据」这段最容易写错的代码。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_forward_carries_traffic_through_ssh() {
    let (target_tx, target_rx) = tokio::sync::oneshot::channel();
    let _target_task = tokio::spawn(async move { spawn_target_echo(target_tx).await });
    let target_port = target_rx.await.unwrap();

    let (tx, rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move { start_test_server(tx).await });
    let port = rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "local-forward",
        port,
    )));
    let sink = Arc::new(TestSink::new());
    let id = connect_and_trust(&manager, &sink, None, connect_req(port, false)).await;

    let info = manager
        .start_local_forward(
            manager.clone(),
            id,
            "127.0.0.1".to_string(),
            0,
            "127.0.0.1".to_string(),
            target_port,
        )
        .await
        .expect("local forward should start");
    assert!(info.bind_port > 0, "应分配到实际监听端口");

    let mut client = TcpStream::connect(("127.0.0.1", info.bind_port))
        .await
        .expect("应能连上本地转发端口");
    client.write_all(b"ping").await.expect("写入应成功");

    let mut buffer = vec![0u8; 64];
    let read = tokio::time::timeout(Duration::from_secs(10), client.read(&mut buffer))
        .await
        .expect("转发的读取不应超时")
        .expect("应读到目标服务的回显");
    assert_eq!(
        String::from_utf8_lossy(&buffer[..read]),
        "target: ping",
        "数据应穿过 SSH 到达目标服务并原样回显"
    );

    manager.stop_forward(info.id).await.expect("停止转发应成功");
    assert!(
        manager.list_local_forwards().await.is_empty(),
        "停止后转发列表应为空"
    );

    manager.disconnect(sink.clone(), id).await;
}

/// 本地转发只允许绑定回环地址，避免把内网服务意外暴露到公网。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_forward_rejects_non_loopback_bind() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move { start_test_server(tx).await });
    let port = rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "forward-bind",
        port,
    )));
    let sink = Arc::new(TestSink::new());
    let id = connect_and_trust(&manager, &sink, None, connect_req(port, false)).await;

    let error = manager
        .start_local_forward(
            manager.clone(),
            id,
            "0.0.0.0".to_string(),
            0,
            "127.0.0.1".to_string(),
            8080,
        )
        .await
        .expect_err("绑定 0.0.0.0 必须被拒绝");
    assert!(
        error.contains("回环"),
        "错误信息应说明只允许回环地址，got: {error}"
    );

    manager.disconnect(sink.clone(), id).await;
}
