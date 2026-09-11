//! SFTP 目录同步端到端测试。
//!
//! 链路：`sftp_sync_plan` 扫两侧树产差异 → `sftp_sync_start` 后台逐文件执行
//! → 轮询远端/本地目录验证结果。执行任务跑在 tauri 全局 runtime 上，
//! 测试侧以轮询等待完成（与运行时解耦）。

mod common;

use std::sync::Arc;
use std::time::Duration;

use catshell_lib::ssh_manager::SshManager;
use common::{connect_and_trust, connect_req, start_test_server, test_known_hosts_path, TestSink};

/// 轮询直到条件满足或超时（100ms 间隔，10s 上限）。
async fn wait_for<F: Fn() -> bool>(check: F) -> bool {
    for _ in 0..100 {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    check()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sync_upload_transfers_local_tree_to_remote() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move { start_test_server(tx).await });
    let port = rx.await.unwrap();

    // 本地临时目录：根文件 + 子目录文件。
    let local_dir = std::env::temp_dir().join(format!("catshell-sync-up-{}", std::process::id()));
    let sub_dir = local_dir.join("sub");
    std::fs::create_dir_all(&sub_dir).expect("创建临时目录应成功");
    std::fs::write(local_dir.join("a.txt"), b"local alpha").unwrap();
    std::fs::write(sub_dir.join("b.txt"), b"nested beta").unwrap();

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "sync-up", port,
    )));
    let sink = Arc::new(TestSink::new());
    let id = connect_and_trust(&manager, &sink, None, connect_req(port, false)).await;

    manager
        .sftp_mkdir(id, "/sync-up".to_string())
        .await
        .expect("建远端同步目录应成功");

    // 计划：目录 mkdir 先行，两个文件 add。
    let plan = manager
        .sftp_sync_plan(
            id,
            "upload".to_string(),
            local_dir.to_string_lossy().to_string(),
            "/sync-up".to_string(),
        )
        .await
        .expect("生成上传同步计划应成功");
    assert_eq!(plan.transfer_count, 2);
    assert_eq!(
        plan.total_bytes,
        ("local alpha".len() + "nested beta".len()) as u64
    );
    let actions: Vec<(&str, &str)> = plan
        .entries
        .iter()
        .map(|entry| (entry.relative_path.as_str(), entry.action.as_str()))
        .collect();
    assert!(actions.contains(&("a.txt", "add")));
    assert!(actions.contains(&("sub", "mkdir")));
    assert!(actions.contains(&("sub/b.txt", "add")));
    // 父目录先于子文件。
    let sub_index = plan
        .entries
        .iter()
        .position(|entry| entry.relative_path == "sub")
        .unwrap();
    let file_index = plan
        .entries
        .iter()
        .position(|entry| entry.relative_path == "sub/b.txt")
        .unwrap();
    assert!(sub_index < file_index);

    // 执行：后台任务，轮询远端直到内容可读。
    let started = manager
        .sftp_sync_start(
            manager.clone(),
            sink.clone(),
            id,
            "upload".to_string(),
            local_dir.to_string_lossy().to_string(),
            "/sync-up".to_string(),
            plan.entries,
        )
        .await
        .expect("启动同步应成功");
    assert_eq!(started.total_files, 2);

    let manager_for_poll = manager.clone();
    let uploaded = wait_for(|| {
        let manager = manager_for_poll.clone();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async move {
                let a = manager
                    .sftp_read_file(id, "/sync-up/a.txt".to_string())
                    .await;
                let b = manager
                    .sftp_read_file(id, "/sync-up/sub/b.txt".to_string())
                    .await;
                a.is_ok() && b.is_ok()
            })
        })
    })
    .await;
    if !uploaded {
        if let Some(progress) = sink.last_event("sftp-sync-progress") {
            panic!("同步未完成，最后事件: {progress}");
        }
        panic!("同步未完成且没有任何进度事件");
    }
    assert_eq!(
        manager
            .sftp_read_file(id, "/sync-up/a.txt".to_string())
            .await
            .unwrap(),
        b"local alpha"
    );
    assert_eq!(
        manager
            .sftp_read_file(id, "/sync-up/sub/b.txt".to_string())
            .await
            .unwrap(),
        b"nested beta"
    );

    // 重复同步：内容一致应全部跳过（无传输动作）。
    let replan = manager
        .sftp_sync_plan(
            id,
            "upload".to_string(),
            local_dir.to_string_lossy().to_string(),
            "/sync-up".to_string(),
        )
        .await
        .expect("二次生成计划应成功");
    assert_eq!(replan.transfer_count, 0, "内容一致时重复同步应全部跳过");
    assert_eq!(replan.skip_count, 3);

    let _ = std::fs::remove_dir_all(&local_dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sync_download_pulls_remote_files_to_local() {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _server_task = tokio::spawn(async move { start_test_server(tx).await });
    let port = rx.await.unwrap();

    let local_dir = std::env::temp_dir().join(format!("catshell-sync-down-{}", std::process::id()));
    std::fs::create_dir_all(&local_dir).expect("创建临时目录应成功");

    let manager = Arc::new(SshManager::with_known_hosts_path(test_known_hosts_path(
        "sync-down",
        port,
    )));
    let sink = Arc::new(TestSink::new());
    let id = connect_and_trust(&manager, &sink, None, connect_req(port, false)).await;

    // 远端已有种子文件 /readme.txt；计划下载整棵根树。
    let plan = manager
        .sftp_sync_plan(
            id,
            "download".to_string(),
            local_dir.to_string_lossy().to_string(),
            "/".to_string(),
        )
        .await
        .expect("生成下载同步计划应成功");
    assert!(
        plan.entries
            .iter()
            .any(|entry| entry.relative_path == "readme.txt" && entry.action == "add"),
        "readme.txt 应为新增动作"
    );

    manager
        .sftp_sync_start(
            manager.clone(),
            sink,
            id,
            "download".to_string(),
            local_dir.to_string_lossy().to_string(),
            "/".to_string(),
            plan.entries,
        )
        .await
        .expect("启动同步应成功");

    let target = local_dir.join("readme.txt");
    let downloaded = wait_for(|| target.is_file()).await;
    assert!(downloaded, "同步完成后本地应有 readme.txt");
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "hello from mock sftp\n"
    );

    let _ = std::fs::remove_dir_all(&local_dir);
}
