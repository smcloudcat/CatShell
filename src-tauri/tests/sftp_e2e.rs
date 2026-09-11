//! SFTP 全链路端到端测试。
//!
//! 链路：`SshManager` → SSH 子系统 `sftp` → russh-sftp 服务端 → 内存文件系统。
//! 测试服务器与辅助函数见 `tests/common/mod.rs`。

mod common;

use std::sync::Arc;

use catshell_lib::ssh_manager::SshManager;
use common::{connect_and_trust, connect_req, start_test_server, test_known_hosts_path, TestSink};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sftp_directory_file_and_mutation_roundtrip() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move { start_test_server(tx).await });
    let port = rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "sftp", port,
    )));
    let sink = Arc::new(TestSink::new());
    let id = connect_and_trust(&manager, &sink, None, connect_req(port, false)).await;

    // 列目录：文件与目录要能区分开，大小要对得上。
    let entries = manager
        .sftp_list(id, "/".to_string())
        .await
        .expect("列出根目录应成功");
    let readme = entries
        .iter()
        .find(|entry| entry.name == "readme.txt")
        .expect("根目录应有 readme.txt");
    assert_eq!(readme.kind, "file");
    assert_eq!(readme.size, "hello from mock sftp\n".len() as u64);
    let logs = entries
        .iter()
        .find(|entry| entry.name == "logs")
        .expect("根目录应有 logs");
    assert_eq!(logs.kind, "directory");

    // 读文件。
    let content = manager
        .sftp_read_file(id, "/readme.txt".to_string())
        .await
        .expect("读文件应成功");
    assert_eq!(String::from_utf8_lossy(&content), "hello from mock sftp\n");

    // 写新文件。
    let payload = b"uploaded via sftp\n".to_vec();
    manager
        .sftp_write_file(id, "/upload.txt".to_string(), payload.clone())
        .await
        .expect("写文件应成功");

    // 回读验证内容一致 —— 这一步同时证明文件系统状态跨 SFTP 会话是保持的。
    let read_back = manager
        .sftp_read_file(id, "/upload.txt".to_string())
        .await
        .expect("回读应成功");
    assert_eq!(read_back, payload, "写入后再读回应完全一致");

    // 覆盖写：应替换而不是追加。
    let replaced = b"x".to_vec();
    manager
        .sftp_write_file(id, "/upload.txt".to_string(), replaced.clone())
        .await
        .expect("覆盖写应成功");
    let read_again = manager
        .sftp_read_file(id, "/upload.txt".to_string())
        .await
        .expect("再读应成功");
    assert_eq!(read_again, replaced, "覆盖写应替换旧内容");

    // 新建目录。
    manager
        .sftp_mkdir(id, "/newdir".to_string())
        .await
        .expect("建目录应成功");
    let entries = manager
        .sftp_list(id, "/".to_string())
        .await
        .expect("再列目录应成功");
    assert!(
        entries
            .iter()
            .any(|entry| entry.name == "newdir" && entry.kind == "directory"),
        "新建的目录应出现在列表里"
    );

    // 重命名。
    manager
        .sftp_rename(id, "/upload.txt".to_string(), "/renamed.txt".to_string())
        .await
        .expect("重命名应成功");
    let entries = manager
        .sftp_list(id, "/".to_string())
        .await
        .expect("列目录应成功");
    assert!(entries.iter().any(|entry| entry.name == "renamed.txt"));
    assert!(!entries.iter().any(|entry| entry.name == "upload.txt"));

    // 改权限。
    manager
        .sftp_chmod(id, "/renamed.txt".to_string(), 0o600)
        .await
        .expect("chmod 应成功");
    let entries = manager
        .sftp_list(id, "/".to_string())
        .await
        .expect("列目录应成功");
    let renamed = entries
        .iter()
        .find(|entry| entry.name == "renamed.txt")
        .expect("重命名后的文件应仍存在");
    let permissions = renamed.permissions.unwrap_or(0) & 0o777;
    assert_eq!(permissions, 0o600, "chmod 后权限位应更新");

    // 删除文件与目录。
    manager
        .sftp_remove_file(id, "/renamed.txt".to_string())
        .await
        .expect("删除文件应成功");
    manager
        .sftp_remove_dir(id, "/newdir".to_string())
        .await
        .expect("删除目录应成功");
    let entries = manager
        .sftp_list(id, "/".to_string())
        .await
        .expect("列目录应成功");
    assert!(!entries.iter().any(|entry| entry.name == "renamed.txt"));
    assert!(!entries.iter().any(|entry| entry.name == "newdir"));

    manager.disconnect(sink.clone(), id).await;
}

/// 读取不存在的文件应给出可诊断的错误，而不是静默返回空内容。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sftp_missing_file_reports_error() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move { start_test_server(tx).await });
    let port = rx.await.unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "sftp-missing",
        port,
    )));
    let sink = Arc::new(TestSink::new());
    let id = connect_and_trust(&manager, &sink, None, connect_req(port, false)).await;

    let error = manager
        .sftp_read_file(id, "/nope.txt".to_string())
        .await
        .expect_err("读不存在的文件应失败");
    // S-1 修复后先查 metadata 再读：文件不存在在 metadata 阶段即报错。
    assert!(
        error.contains("读取远程文件信息失败") || error.contains("读取远程文件失败"),
        "错误信息应可诊断，got: {error}"
    );

    manager.disconnect(sink.clone(), id).await;
}

/// 非法远程路径在发起连接之前就该被拦下。
#[tokio::test]
async fn sftp_rejects_invalid_remote_path() {
    let manager = SshManager::with_known_hosts_path(test_known_hosts_path("sftp-path", 0));

    let blank = manager
        .sftp_read_file(1, "   ".to_string())
        .await
        .expect_err("空白路径应被拒绝");
    assert!(blank.contains("远程路径无效"), "got: {blank}");

    let nul = manager
        .sftp_write_file(1, "/bad\0name".to_string(), vec![1, 2, 3])
        .await
        .expect_err("含 NUL 的路径应被拒绝");
    assert!(nul.contains("远程路径无效"), "got: {nul}");

    let too_long = manager
        .sftp_mkdir(1, format!("/{}", "a".repeat(5000)))
        .await
        .expect_err("超长路径应被拒绝");
    assert!(too_long.contains("远程路径过长"), "got: {too_long}");
}
