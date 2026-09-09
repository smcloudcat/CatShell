use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use russh_sftp::protocol::OpenFlags;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;

use super::{EventSink, SshManager};

const MAX_SFTP_FILE_SIZE: usize = 64 * 1024 * 1024;
const SFTP_CHUNK_SIZE: usize = 256 * 1024;
const REMOTE_DELETE_MAX_DEPTH: usize = 16;
const REMOTE_DELETE_ENTRY_BUDGET: usize = 20_000;
const DISK_CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const DISK_PART_SUFFIX: &str = ".catshell-part";

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: Option<i64>,
    pub permissions: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferStart {
    pub transfer_id: u64,
    pub total: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpChunk {
    pub data: String,
    pub done: bool,
    pub transferred: u64,
    pub total: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDiskTransferStart {
    pub transfer_id: u64,
    pub total: u64,
    pub resumed: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDiskTransferInfo {
    pub transfer_id: u64,
    pub session_id: u64,
    pub direction: String,
    pub file_name: String,
    pub remote_path: String,
    pub local_path: String,
    pub transferred: u64,
    pub total: u64,
    pub done: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpDiskProgress {
    transfer_id: u64,
    session_id: u64,
    direction: String,
    file_name: String,
    transferred: u64,
    total: u64,
    done: bool,
    cancelled: bool,
    error: Option<String>,
}

/// 落盘流式传输任务：数据完全在 Rust 侧读写本地磁盘，不经过前端内存。
/// 进度以节流事件（≥300ms）推送给前端；`.catshell-part` 半成品文件支持断点续传。
pub struct SftpDiskTransfer {
    pub id: u64,
    pub session_id: u64,
    pub remote_path: String,
    pub local_path: String,
    pub file_name: String,
    pub direction: &'static str,
    pub total: u64,
    pub transferred: AtomicU64,
    pub cancelled: AtomicBool,
    pub done: AtomicBool,
    pub error: StdMutex<Option<String>>,
    pub last_emit: AtomicU64,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

impl SftpDiskTransfer {
    fn info(&self) -> SftpDiskTransferInfo {
        SftpDiskTransferInfo {
            transfer_id: self.id,
            session_id: self.session_id,
            direction: self.direction.to_string(),
            file_name: self.file_name.clone(),
            remote_path: self.remote_path.clone(),
            local_path: self.local_path.clone(),
            transferred: self.transferred.load(Ordering::SeqCst),
            total: self.total,
            done: self.done.load(Ordering::SeqCst),
            cancelled: self.cancelled.load(Ordering::SeqCst),
            error: self.error.lock().expect("磁盘传输错误锁").clone(),
        }
    }

    fn progress(&self) -> SftpDiskProgress {
        SftpDiskProgress {
            transfer_id: self.id,
            session_id: self.session_id,
            direction: self.direction.to_string(),
            file_name: self.file_name.clone(),
            transferred: self.transferred.load(Ordering::SeqCst),
            total: self.total,
            done: self.done.load(Ordering::SeqCst),
            cancelled: self.cancelled.load(Ordering::SeqCst),
            error: self.error.lock().expect("磁盘传输错误锁").clone(),
        }
    }

    fn finish_with_error(&self, message: String) {
        *self.error.lock().expect("磁盘传输错误锁") = Some(message);
        self.done.store(true, Ordering::SeqCst);
    }
}

fn emit_disk_progress(sink: &dyn EventSink, transfer: &SftpDiskTransfer, force: bool) {
    let now = now_millis();
    if !force {
        let last = transfer.last_emit.load(Ordering::SeqCst);
        if now.saturating_sub(last) < 300 {
            return;
        }
    }
    transfer.last_emit.store(now, Ordering::SeqCst);
    sink.emit(
        "sftp-disk-progress",
        serde_json::to_value(transfer.progress()).unwrap_or_default(),
    );
}

fn validate_local_path(path: &str) -> Result<String, String> {
    let path = path.trim().to_string();
    if path.is_empty() || path.contains('\0') {
        return Err("本地路径无效".to_string());
    }
    if path.len() > 1024 {
        return Err("本地路径过长".to_string());
    }
    Ok(path)
}

fn part_file_path(local_path: &str) -> String {
    format!("{local_path}{DISK_PART_SUFFIX}")
}

/// 跨 command 调用存活的一次 SFTP 流式传输（上传或下载）。
/// 连接锁只在打开通道时短暂持有，之后所有读写都走独立的 SFTP 通道。
pub struct SftpTransfer {
    pub id: u64,
    pub session_id: u64,
    pub path: String,
    pub direction: &'static str,
    pub total: u64,
    pub transferred: AtomicU64,
    pub cancelled: AtomicBool,
    pub file: Mutex<Option<russh_sftp::client::fs::File>>,
    pub sftp: Mutex<Option<russh_sftp::client::SftpSession>>,
}

fn segments_are_empty(path: &str) -> bool {
    path.split('/').all(|item| item.is_empty())
}

async fn remove_remote_dir_recursive(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    depth: usize,
    budget: &mut usize,
) -> Result<(), String> {
    if depth > REMOTE_DELETE_MAX_DEPTH {
        return Err(format!(
            "目录嵌套超过 {REMOTE_DELETE_MAX_DEPTH} 层，已中止删除"
        ));
    }
    if *budget == 0 {
        return Err("目录条目数超过限制（20000），已中止删除".to_string());
    }
    let entries = sftp
        .read_dir(path)
        .await
        .map_err(|error| format!("读取远程目录失败: {error}"))?;
    let mut names: Vec<(String, bool)> = Vec::new();
    for entry in entries {
        if *budget == 0 {
            return Err("目录条目数超过限制（20000），已中止删除".to_string());
        }
        *budget -= 1;
        names.push((entry.path(), entry.file_type().is_dir()));
    }
    for (child_path, is_dir) in names {
        if is_dir {
            Box::pin(remove_remote_dir_recursive(
                sftp,
                &child_path,
                depth + 1,
                budget,
            ))
            .await?;
            sftp.remove_dir(&child_path)
                .await
                .map_err(|error| format!("删除远程目录失败: {error}"))?;
        } else {
            sftp.remove_file(&child_path)
                .await
                .map_err(|error| format!("删除远程文件失败: {error}"))?;
        }
    }
    Ok(())
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

impl SshManager {
    pub async fn sftp_list(&self, id: u64, path: String) -> Result<Vec<SftpEntry>, String> {
        let path = if path.trim().is_empty() {
            ".".to_string()
        } else {
            path
        };
        let sftp = self.open_sftp_channel(id).await?;
        let entries = sftp
            .read_dir(path)
            .await
            .map_err(|error| format!("读取远程目录失败: {error}"))?;
        let mut result = Vec::new();
        for entry in entries {
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
                permissions: metadata.permissions,
                owner: metadata
                    .user
                    .clone()
                    .or_else(|| metadata.uid.map(|value| value.to_string())),
                group: metadata
                    .group
                    .clone()
                    .or_else(|| metadata.gid.map(|value| value.to_string())),
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
        let sftp = self.open_sftp_channel(id).await?;
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
        let sftp = self.open_sftp_channel(id).await?;
        let mut file = sftp
            .create(&path)
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
        let sftp = self.open_sftp_channel(id).await?;
        sftp.remove_file(path)
            .await
            .map_err(|error| format!("删除远程文件失败: {error}"))?;
        sftp.close()
            .await
            .map_err(|error| format!("关闭 SFTP 通道失败: {error}"))
    }

    pub async fn sftp_mkdir(&self, id: u64, path: String) -> Result<(), String> {
        let path = validate_sftp_path(path)?;
        let sftp = self.open_sftp_channel(id).await?;
        sftp.create_dir(&path)
            .await
            .map_err(|error| format!("创建远程目录失败: {error}"))?;
        sftp.close()
            .await
            .map_err(|error| format!("关闭 SFTP 通道失败: {error}"))
    }

    /// 递归删除远程目录及其全部内容。拒绝根目录，限制递归深度与条目总数，
    /// 防止在超大目录树上失控；调用方必须先经过强确认流程。
    pub async fn sftp_remove_dir(&self, id: u64, path: String) -> Result<(), String> {
        let path = validate_sftp_path(path)?;
        let normalized = path.trim_end_matches('/');
        if normalized.is_empty() || segments_are_empty(normalized) {
            return Err("拒绝删除根目录".to_string());
        }
        let sftp = self.open_sftp_channel(id).await?;
        let mut budget = REMOTE_DELETE_ENTRY_BUDGET;
        remove_remote_dir_recursive(&sftp, &path, 0, &mut budget).await?;
        sftp.remove_dir(&path)
            .await
            .map_err(|error| format!("删除远程目录失败: {error}"))?;
        sftp.close()
            .await
            .map_err(|error| format!("关闭 SFTP 通道失败: {error}"))
    }

    pub async fn sftp_rename(&self, id: u64, from: String, to: String) -> Result<(), String> {
        let from = validate_sftp_path(from)?;
        let to = validate_sftp_path(to)?;
        let sftp = self.open_sftp_channel(id).await?;
        sftp.rename(&from, &to)
            .await
            .map_err(|error| format!("重命名远程文件失败: {error}"))?;
        sftp.close()
            .await
            .map_err(|error| format!("关闭 SFTP 通道失败: {error}"))
    }

    /// 修改远程文件/目录权限（八进制 mode，例如 0o644）。只传 permissions，
    /// 其余元数据字段保持默认值，避免覆盖远端属主/时间戳。
    pub async fn sftp_chmod(&self, id: u64, path: String, mode: u32) -> Result<(), String> {
        let path = validate_sftp_path(path)?;
        if mode > 0o7777 {
            return Err("权限值无效（应为 3~4 位八进制，例如 644）".to_string());
        }
        let sftp = self.open_sftp_channel(id).await?;
        sftp.set_metadata(
            &path,
            russh_sftp::protocol::FileAttributes {
                permissions: Some(mode),
                ..Default::default()
            },
        )
        .await
        .map_err(|error| format!("修改远程权限失败: {error}"))?;
        sftp.close()
            .await
            .map_err(|error| format!("关闭 SFTP 通道失败: {error}"))
    }

    /// 打开独立的 SFTP 子系统通道。连接锁仅在通道建立期间持有，
    /// 返回后的 SFTP 读写不再阻塞该会话的终端输入。
    pub(super) async fn open_sftp_channel(
        &self,
        id: u64,
    ) -> Result<russh_sftp::client::SftpSession, String> {
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
        Ok(sftp)
    }

    pub(super) async fn transfer_ref(&self, transfer_id: u64) -> Result<Arc<SftpTransfer>, String> {
        self.sftp_transfers
            .lock()
            .await
            .get(&transfer_id)
            .cloned()
            .ok_or_else(|| "传输任务不存在或已结束".to_string())
    }

    pub(super) async fn close_transfer(&self, transfer: &SftpTransfer, remove_partial: bool) {
        let file = transfer.file.lock().await.take();
        if let Some(mut file) = file {
            let _ = file.shutdown().await;
        }
        let sftp = transfer.sftp.lock().await.take();
        if let Some(sftp) = sftp {
            if remove_partial {
                let _ = sftp.remove_file(&transfer.path).await;
            }
            let _ = sftp.close().await;
        }
    }

    pub async fn sftp_download_begin(
        &self,
        id: u64,
        path: String,
    ) -> Result<SftpTransferStart, String> {
        let path = validate_sftp_path(path)?;
        let sftp = self.open_sftp_channel(id).await?;
        let metadata = sftp
            .metadata(&path)
            .await
            .map_err(|error| format!("读取远程文件信息失败: {error}"))?;
        let total = metadata.size.unwrap_or(0);
        let file = sftp
            .open(&path)
            .await
            .map_err(|error| format!("打开远程文件失败: {error}"))?;
        let transfer_id = self.next_transfer_id.fetch_add(1, Ordering::SeqCst);
        let transfer = Arc::new(SftpTransfer {
            id: transfer_id,
            session_id: id,
            path,
            direction: "download",
            total,
            transferred: AtomicU64::new(0),
            cancelled: AtomicBool::new(false),
            file: Mutex::new(Some(file)),
            sftp: Mutex::new(Some(sftp)),
        });
        self.sftp_transfers
            .lock()
            .await
            .insert(transfer_id, transfer.clone());
        Ok(SftpTransferStart { transfer_id, total })
    }

    pub async fn sftp_download_chunk(&self, transfer_id: u64) -> Result<SftpChunk, String> {
        let transfer = self.transfer_ref(transfer_id).await?;
        if transfer.cancelled.load(Ordering::SeqCst) {
            return Err("传输已取消".to_string());
        }
        let mut file_guard = transfer.file.lock().await;
        let file = file_guard
            .as_mut()
            .ok_or_else(|| "传输已结束".to_string())?;
        let mut chunk = vec![0_u8; SFTP_CHUNK_SIZE];
        let mut filled = 0_usize;
        while filled < chunk.len() {
            let n = file
                .read(&mut chunk[filled..])
                .await
                .map_err(|error| format!("读取远程文件失败: {error}"))?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        chunk.truncate(filled);
        drop(file_guard);
        let transferred = transfer
            .transferred
            .fetch_add(filled as u64, Ordering::SeqCst)
            + filled as u64;
        let done = filled == 0;
        if done {
            self.close_transfer(&transfer, false).await;
            self.sftp_transfers.lock().await.remove(&transfer_id);
        }
        Ok(SftpChunk {
            data: BASE64_STANDARD.encode(&chunk),
            done,
            transferred,
            total: transfer.total,
        })
    }

    pub async fn sftp_upload_begin(
        &self,
        id: u64,
        path: String,
        total: u64,
    ) -> Result<SftpTransferStart, String> {
        let path = validate_sftp_path(path)?;
        let sftp = self.open_sftp_channel(id).await?;
        let file = sftp
            .create(&path)
            .await
            .map_err(|error| format!("创建远程文件失败: {error}"))?;
        let transfer_id = self.next_transfer_id.fetch_add(1, Ordering::SeqCst);
        let transfer = Arc::new(SftpTransfer {
            id: transfer_id,
            session_id: id,
            path,
            direction: "upload",
            total,
            transferred: AtomicU64::new(0),
            cancelled: AtomicBool::new(false),
            file: Mutex::new(Some(file)),
            sftp: Mutex::new(Some(sftp)),
        });
        self.sftp_transfers
            .lock()
            .await
            .insert(transfer_id, transfer.clone());
        Ok(SftpTransferStart { transfer_id, total })
    }

    pub async fn sftp_upload_chunk(
        &self,
        transfer_id: u64,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<(), String> {
        let transfer = self.transfer_ref(transfer_id).await?;
        if transfer.cancelled.load(Ordering::SeqCst) {
            return Err("传输已取消".to_string());
        }
        let expected = transfer.transferred.load(Ordering::SeqCst);
        if offset != expected {
            return Err(format!(
                "上传分片偏移不连续，期望 {expected}，实际 {offset}"
            ));
        }
        let mut file_guard = transfer.file.lock().await;
        let file = file_guard
            .as_mut()
            .ok_or_else(|| "传输已结束".to_string())?;
        file.write_all(&data)
            .await
            .map_err(|error| format!("写入远程文件失败: {error}"))?;
        drop(file_guard);
        transfer
            .transferred
            .fetch_add(data.len() as u64, Ordering::SeqCst);
        Ok(())
    }

    pub async fn sftp_upload_finish(&self, transfer_id: u64) -> Result<(), String> {
        let removed = self.sftp_transfers.lock().await.remove(&transfer_id);
        let Some(transfer) = removed else {
            return Err("传输任务不存在或已结束".to_string());
        };
        if transfer.cancelled.load(Ordering::SeqCst) {
            self.close_transfer(&transfer, true).await;
            return Err("传输已取消".to_string());
        }
        let file = transfer.file.lock().await.take();
        if let Some(mut file) = file {
            file.shutdown()
                .await
                .map_err(|error| format!("完成远程文件写入失败: {error}"))?;
        }
        let sftp = transfer.sftp.lock().await.take();
        if let Some(sftp) = sftp {
            let _ = sftp.close().await;
        }
        Ok(())
    }

    pub async fn sftp_transfer_cancel(&self, transfer_id: u64) -> Result<(), String> {
        let removed = self.sftp_transfers.lock().await.remove(&transfer_id);
        let Some(transfer) = removed else {
            return Ok(());
        };
        transfer.cancelled.store(true, Ordering::SeqCst);
        self.close_transfer(&transfer, transfer.direction == "upload")
            .await;
        Ok(())
    }

    /// 磁盘级下载：远端文件直接流入本地磁盘（Rust 侧读写），
    /// 存在 `.catshell-part` 半成品时自动断点续传。
    pub async fn sftp_disk_download_start(
        &self,
        manager: Arc<SshManager>,
        sink: Arc<dyn EventSink>,
        id: u64,
        remote_path: String,
        local_path: String,
        resume: bool,
    ) -> Result<SftpDiskTransferStart, String> {
        let remote_path = validate_sftp_path(remote_path)?;
        let local_path = validate_local_path(&local_path)?;
        if Path::new(&local_path).is_dir() {
            return Err("目标路径是一个已存在的目录".to_string());
        }
        let file_name = Path::new(&remote_path)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .ok_or_else(|| "远程路径无效".to_string())?;
        if let Some(parent) = Path::new(&local_path).parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("创建本地目录失败: {error}"))?;
            }
        }

        let sftp = self.open_sftp_channel(id).await?;
        let metadata = sftp
            .metadata(&remote_path)
            .await
            .map_err(|error| format!("读取远程文件信息失败: {error}"))?;
        let total = metadata.size.unwrap_or(0);
        let part_path = part_file_path(&local_path);

        let mut start_offset: u64 = 0;
        let mut resumed = false;
        if resume {
            if let Ok(part_meta) = std::fs::metadata(&part_path) {
                let part_len = part_meta.len();
                if part_len > 0 && part_len < total {
                    start_offset = part_len;
                    resumed = true;
                }
            }
        }

        let mut remote_file = sftp
            .open(&remote_path)
            .await
            .map_err(|error| format!("打开远程文件失败: {error}"))?;
        if start_offset > 0 {
            remote_file
                .seek(std::io::SeekFrom::Start(start_offset))
                .await
                .map_err(|error| format!("远程文件定位断点失败: {error}"))?;
        }
        let mut local_file = if resumed {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(&part_path)
                .await
                .map_err(|error| format!("打开本地半成品文件失败: {error}"))?
        } else {
            tokio::fs::File::create(&part_path)
                .await
                .map_err(|error| format!("创建本地文件失败: {error}"))?
        };

        let transfer_id = self.next_disk_transfer_id.fetch_add(1, Ordering::SeqCst);
        let transfer = Arc::new(SftpDiskTransfer {
            id: transfer_id,
            session_id: id,
            remote_path,
            local_path,
            file_name,
            direction: "download",
            total,
            transferred: AtomicU64::new(start_offset),
            cancelled: AtomicBool::new(false),
            done: AtomicBool::new(false),
            error: StdMutex::new(None),
            last_emit: AtomicU64::new(now_millis()),
        });
        self.sftp_disk_transfers
            .lock()
            .await
            .insert(transfer_id, transfer.clone());

        tauri::async_runtime::spawn(async move {
            let mut buffer = vec![0_u8; SFTP_CHUNK_SIZE];
            loop {
                if transfer.cancelled.load(Ordering::SeqCst) {
                    transfer.done.store(true, Ordering::SeqCst);
                    emit_disk_progress(sink.as_ref(), &transfer, true);
                    break;
                }
                let read =
                    tokio::time::timeout(DISK_CHUNK_TIMEOUT, remote_file.read(&mut buffer)).await;
                match read {
                    Err(_) => {
                        transfer.finish_with_error("读取远程文件超时".to_string());
                        emit_disk_progress(sink.as_ref(), &transfer, true);
                        break;
                    }
                    Ok(Err(error)) => {
                        transfer.finish_with_error(format!("读取远程文件失败: {error}"));
                        emit_disk_progress(sink.as_ref(), &transfer, true);
                        break;
                    }
                    Ok(Ok(0)) => {
                        if let Err(error) = remote_file.shutdown().await {
                            transfer.finish_with_error(format!("完成远程读取失败: {error}"));
                            emit_disk_progress(sink.as_ref(), &transfer, true);
                            break;
                        }
                        if let Err(error) = local_file.sync_all().await {
                            transfer.finish_with_error(format!("写入本地文件失败: {error}"));
                            emit_disk_progress(sink.as_ref(), &transfer, true);
                            break;
                        }
                        drop(local_file);
                        drop(remote_file);
                        let _ = sftp.close().await;
                        if Path::new(&transfer.local_path).exists() {
                            let _ = std::fs::remove_file(&transfer.local_path);
                        }
                        if let Err(error) = std::fs::rename(&part_path, &transfer.local_path) {
                            transfer.finish_with_error(format!("保存本地文件失败: {error}"));
                            emit_disk_progress(sink.as_ref(), &transfer, true);
                            break;
                        }
                        transfer.done.store(true, Ordering::SeqCst);
                        emit_disk_progress(sink.as_ref(), &transfer, true);
                        break;
                    }
                    Ok(Ok(n)) => {
                        if let Err(error) = local_file.write_all(&buffer[..n]).await {
                            transfer.finish_with_error(format!("写入本地文件失败: {error}"));
                            emit_disk_progress(sink.as_ref(), &transfer, true);
                            break;
                        }
                        transfer.transferred.fetch_add(n as u64, Ordering::SeqCst);
                        emit_disk_progress(sink.as_ref(), &transfer, false);
                    }
                }
            }
            manager
                .sftp_disk_transfers
                .lock()
                .await
                .remove(&transfer_id);
        });
        Ok(SftpDiskTransferStart {
            transfer_id,
            total,
            resumed,
        })
    }

    /// 磁盘级上传：本地文件在 Rust 侧读盘直接写入远端，不经前端内存。
    /// 远端已存在更小的同名文件且 resume=true 时从远端断点续写。
    pub async fn sftp_disk_upload_start(
        &self,
        manager: Arc<SshManager>,
        sink: Arc<dyn EventSink>,
        id: u64,
        local_path: String,
        remote_path: String,
        resume: bool,
    ) -> Result<SftpDiskTransferStart, String> {
        let remote_path = validate_sftp_path(remote_path)?;
        let local_path = validate_local_path(&local_path)?;
        let local_meta = tokio::fs::metadata(&local_path)
            .await
            .map_err(|error| format!("读取本地文件失败: {error}"))?;
        if !local_meta.is_file() {
            return Err("本地路径不是一个文件".to_string());
        }
        let total = local_meta.len();
        let file_name = Path::new(&local_path)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .ok_or_else(|| "本地路径无效".to_string())?;

        let sftp = self.open_sftp_channel(id).await?;
        let mut start_offset: u64 = 0;
        let mut resumed = false;
        if resume {
            if let Ok(remote_meta) = sftp.metadata(&remote_path).await {
                let remote_len = remote_meta.size.unwrap_or(0);
                if remote_len > 0 && remote_len < total {
                    start_offset = remote_len;
                    resumed = true;
                }
            }
        }

        let mut remote_file = if resumed {
            let mut file = sftp
                .open_with_flags(&remote_path, OpenFlags::WRITE | OpenFlags::CREATE)
                .await
                .map_err(|error| format!("打开远程文件失败: {error}"))?;
            file.seek(std::io::SeekFrom::Start(start_offset))
                .await
                .map_err(|error| format!("远程文件定位断点失败: {error}"))?;
            file
        } else {
            sftp.create(&remote_path)
                .await
                .map_err(|error| format!("创建远程文件失败: {error}"))?
        };
        let mut local_file = tokio::fs::File::open(&local_path)
            .await
            .map_err(|error| format!("打开本地文件失败: {error}"))?;
        if start_offset > 0 {
            local_file
                .seek(std::io::SeekFrom::Start(start_offset))
                .await
                .map_err(|error| format!("本地文件定位断点失败: {error}"))?;
        }

        let transfer_id = self.next_disk_transfer_id.fetch_add(1, Ordering::SeqCst);
        let transfer = Arc::new(SftpDiskTransfer {
            id: transfer_id,
            session_id: id,
            remote_path,
            local_path,
            file_name,
            direction: "upload",
            total,
            transferred: AtomicU64::new(start_offset),
            cancelled: AtomicBool::new(false),
            done: AtomicBool::new(false),
            error: StdMutex::new(None),
            last_emit: AtomicU64::new(now_millis()),
        });
        self.sftp_disk_transfers
            .lock()
            .await
            .insert(transfer_id, transfer.clone());

        tauri::async_runtime::spawn(async move {
            let mut buffer = vec![0_u8; SFTP_CHUNK_SIZE];
            loop {
                if transfer.cancelled.load(Ordering::SeqCst) {
                    transfer.done.store(true, Ordering::SeqCst);
                    emit_disk_progress(sink.as_ref(), &transfer, true);
                    break;
                }
                let read =
                    tokio::time::timeout(DISK_CHUNK_TIMEOUT, local_file.read(&mut buffer)).await;
                match read {
                    Err(_) => {
                        transfer.finish_with_error("读取本地文件超时".to_string());
                        emit_disk_progress(sink.as_ref(), &transfer, true);
                        break;
                    }
                    Ok(Err(error)) => {
                        transfer.finish_with_error(format!("读取本地文件失败: {error}"));
                        emit_disk_progress(sink.as_ref(), &transfer, true);
                        break;
                    }
                    Ok(Ok(0)) => {
                        if let Err(error) = remote_file.shutdown().await {
                            transfer.finish_with_error(format!("完成远程写入失败: {error}"));
                            emit_disk_progress(sink.as_ref(), &transfer, true);
                            break;
                        }
                        let _ = sftp.close().await;
                        transfer.done.store(true, Ordering::SeqCst);
                        emit_disk_progress(sink.as_ref(), &transfer, true);
                        break;
                    }
                    Ok(Ok(n)) => {
                        let write = tokio::time::timeout(
                            DISK_CHUNK_TIMEOUT,
                            remote_file.write_all(&buffer[..n]),
                        )
                        .await;
                        match write {
                            Err(_) => {
                                transfer.finish_with_error("写入远程文件超时".to_string());
                                emit_disk_progress(sink.as_ref(), &transfer, true);
                                break;
                            }
                            Ok(Err(error)) => {
                                transfer.finish_with_error(format!("写入远程文件失败: {error}"));
                                emit_disk_progress(sink.as_ref(), &transfer, true);
                                break;
                            }
                            Ok(Ok(())) => {
                                transfer.transferred.fetch_add(n as u64, Ordering::SeqCst);
                                emit_disk_progress(sink.as_ref(), &transfer, false);
                            }
                        }
                    }
                }
            }
            manager
                .sftp_disk_transfers
                .lock()
                .await
                .remove(&transfer_id);
        });
        Ok(SftpDiskTransferStart {
            transfer_id,
            total,
            resumed,
        })
    }

    /// 取消磁盘传输任务。半成品文件保留以支持断点续传。
    pub async fn sftp_disk_transfer_cancel(
        &self,
        sink: Arc<dyn EventSink>,
        transfer_id: u64,
    ) -> Result<(), String> {
        let removed = self
            .sftp_disk_transfers
            .lock()
            .await
            .get(&transfer_id)
            .cloned();
        let Some(transfer) = removed else {
            return Ok(());
        };
        transfer.cancelled.store(true, Ordering::SeqCst);
        // 循环下一轮读到取消标记后自行收尾；这里同步推送一次状态。
        emit_disk_progress(sink.as_ref(), &transfer, true);
        Ok(())
    }

    /// 列出会话中仍在进行的磁盘传输（用于面板重新挂载时恢复进度行）。
    pub async fn sftp_disk_transfer_list(
        &self,
        session_id: u64,
    ) -> Result<Vec<SftpDiskTransferInfo>, String> {
        let transfers = self.sftp_disk_transfers.lock().await;
        Ok(transfers
            .values()
            .filter(|transfer| {
                transfer.session_id == session_id && !transfer.done.load(Ordering::SeqCst)
            })
            .map(|transfer| transfer.info())
            .collect())
    }
}
