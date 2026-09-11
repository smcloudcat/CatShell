//! 多跳 ProxyJump 端到端测试：验证客户端能逐级穿过跳板链到达目标。
//!
//! 测试服务器与辅助函数见 `tests/common/mod.rs`。

mod common;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use catshell_lib::ssh_manager::SshManager;
use common::{
    chain_proxy, connect_and_trust, connect_req, start_test_server, start_test_server_tracked,
    test_known_hosts_path, TestSink,
};

/// 两级跳板链：hop1 → hop2 → 目标（第三台独立服务器）。
///
/// 用三台实例而不是两台，是为了让「目标」也不被当作跳板使用，
/// 断言每跳的隧道计数各司其职：hop1、hop2 各开出一条 direct-tcpip，
/// 目标服务器一条都没开（它只提供 shell）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_hop_chain_reaches_target() {
    // 起三台服务器：hop1、hop2、target。
    let (hop1_tx, hop1_rx) = tokio::sync::oneshot::channel();
    let (hop2_tx, hop2_rx) = tokio::sync::oneshot::channel();
    let (target_tx, target_rx) = tokio::sync::oneshot::channel();
    let hop1_opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let hop2_opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let target_opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let _h1 = tokio::spawn({
        let opens = hop1_opens.clone();
        async move { start_test_server_tracked(hop1_tx, opens).await }
    });
    let _h2 = tokio::spawn({
        let opens = hop2_opens.clone();
        async move { start_test_server_tracked(hop2_tx, opens).await }
    });
    let _t = tokio::spawn({
        let opens = target_opens.clone();
        async move { start_test_server_tracked(target_tx, opens).await }
    });
    let hop1_port = hop1_rx.await.unwrap();
    let hop2_port = hop2_rx.await.unwrap();
    let target_port = target_rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "jump-two-hop",
        hop1_port,
    )));
    let sink = Arc::new(TestSink::new());
    let mut request = connect_req(target_port, false);
    request.proxy = Some(chain_proxy(&[hop1_port, hop2_port]));

    let id = connect_and_trust(&manager, &sink, None, request).await;

    // 每一跳都独立开出了 direct-tcpip 隧道；目标服务器没有开任何隧道。
    assert!(
        hop1_opens.load(Ordering::SeqCst) >= 1,
        "hop1 应开出直达 hop2 的隧道"
    );
    assert!(
        hop2_opens.load(Ordering::SeqCst) >= 1,
        "hop2 应开出直达目标的隧道"
    );
    assert_eq!(
        target_opens.load(Ordering::SeqCst),
        0,
        "目标服务器不应被当作跳板"
    );

    manager.disconnect(sink.clone(), id).await;
}

/// 单级跳板回归：行为与多跳改造前一致。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn single_hop_still_connects() {
    let (hop_tx, hop_rx) = tokio::sync::oneshot::channel();
    let (target_tx, target_rx) = tokio::sync::oneshot::channel();
    let hop_opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let _h = tokio::spawn({
        let opens = hop_opens.clone();
        async move { start_test_server_tracked(hop_tx, opens).await }
    });
    let _t = tokio::spawn(async move { start_test_server(target_tx).await });
    let hop_port = hop_rx.await.unwrap();
    let target_port = target_rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "jump-single",
        hop_port,
    )));
    let sink = Arc::new(TestSink::new());
    let mut request = connect_req(target_port, false);
    request.proxy = Some(chain_proxy(&[hop_port]));

    let id = connect_and_trust(&manager, &sink, None, request).await;
    assert!(
        hop_opens.load(Ordering::SeqCst) >= 1,
        "跳板应开出直达目标的隧道"
    );

    manager.disconnect(sink.clone(), id).await;
}

/// 三级链：hop1 → hop2 → hop3 → 目标，验证链式收集与逐级隧道在更深嵌套下仍成立。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn three_hop_chain_reaches_target() {
    let mut ports = Vec::new();
    let mut opens = Vec::new();
    for index in 0..3 {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let _task = tokio::spawn({
            let counter = counter.clone();
            async move { start_test_server_tracked(tx, counter).await }
        });
        ports.push(rx.await.unwrap());
        opens.push(counter);
        let _ = index;
    }
    let (target_tx, target_rx) = tokio::sync::oneshot::channel();
    let target_opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let _t = tokio::spawn({
        let opens = target_opens.clone();
        async move { start_test_server_tracked(target_tx, opens).await }
    });
    let target_port = target_rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "jump-three-hop",
        ports[0],
    )));
    let sink = Arc::new(TestSink::new());
    let mut request = connect_req(target_port, false);
    request.proxy = Some(chain_proxy(&ports));

    let id = connect_and_trust(&manager, &sink, None, request).await;
    for (index, counter) in opens.iter().enumerate() {
        assert!(
            counter.load(Ordering::SeqCst) >= 1,
            "第 {} 跳应开出隧道",
            index + 1
        );
    }
    assert_eq!(target_opens.load(Ordering::SeqCst), 0, "目标不应被当作跳板");

    manager.disconnect(sink.clone(), id).await;
}
