//! 批量命令执行聚合的端到端测试。
//!
//! 测试服务器在 exec 请求上回显 `exec: <命令>`（见 `tests/common/mod.rs`），
//! 因此断言聚焦于：聚合顺序、单台失败隔离与入参校验。

mod common;

use std::sync::Arc;
use std::time::Duration;

use catshell_lib::ssh_manager::SshManager;
use common::{connect_and_trust, connect_req, start_test_server, test_known_hosts_path, TestSink};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn batch_exec_aggregates_output_and_isolates_failures() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move { start_test_server(tx).await });
    let port = rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "batch-exec",
        port,
    )));
    let sink_a = Arc::new(TestSink::new());
    let sink_b = Arc::new(TestSink::new());
    let id_a = connect_and_trust(&manager, &sink_a, None, connect_req(port, false)).await;
    let id_b = connect_and_trust(&manager, &sink_b, None, connect_req(port, false)).await;

    // 混入一个不存在的会话，验证单台失败不影响其余目标。
    let items = manager
        .clone()
        .batch_exec(vec![id_a, 999_999, id_b], "uname -a".to_string(), 10)
        .await
        .expect("batch_exec should succeed");

    assert_eq!(items.len(), 3, "one item per requested session");
    assert_eq!(
        items[0].session_id, id_a,
        "results keep the requested order"
    );
    assert!(
        items[0].ok,
        "first session should succeed: {:?}",
        items[0].error
    );
    assert!(
        items[0].output.contains("exec: uname -a"),
        "output should contain the echo marker, got: {:?}",
        items[0].output
    );
    assert!(!items[0].truncated);

    assert!(
        !items[1].ok,
        "missing session should fail, got: {:?}",
        items[1]
    );
    assert!(
        items[1]
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("会话不存在"),
        "missing session error should mention the cause, got: {:?}",
        items[1].error
    );

    assert!(
        items[2].ok,
        "second session should succeed: {:?}",
        items[2].error
    );
    assert!(items[2].duration_ms > 0 || items[2].output.contains("exec:"));

    tokio::time::sleep(Duration::from_millis(100)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn batch_exec_rejects_invalid_input_without_touching_sessions() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move { start_test_server(tx).await });
    let port = rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "batch-exec-invalid",
        port,
    )));
    let sink = Arc::new(TestSink::new());
    let id = connect_and_trust(&manager, &sink, None, connect_req(port, false)).await;

    // 空命令
    let err = manager
        .clone()
        .batch_exec(vec![id], "   ".to_string(), 10)
        .await
        .expect_err("blank command must be rejected");
    assert!(err.contains("命令不能为空"));

    // 空目标
    let err = manager
        .clone()
        .batch_exec(vec![], "uname".to_string(), 10)
        .await
        .expect_err("empty target list must be rejected");
    assert!(err.contains("未选择目标会话"));

    // 超过目标数上限（33 个，其中含重复去重后仍超限）
    let ids: Vec<u64> = (1..=33).collect();
    let err = manager
        .clone()
        .batch_exec(ids, "uname".to_string(), 10)
        .await
        .expect_err("over-limit targets must be rejected");
    assert!(err.contains("目标会话过多"));

    // 命令过长
    let long_command = "x".repeat(5000);
    let err = manager
        .batch_exec(vec![id], long_command, 10)
        .await
        .expect_err("over-long command must be rejected");
    assert!(err.contains("命令过长"));
}
