use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use super::SshManager;

const MAX_SFTP_FILE_SIZE: usize = 64 * 1024 * 1024;
const SFTP_CHUNK_SIZE: usize = 256 * 1024;
const REMOTE_DELETE_MAX_DEPTH: usize = 16;
const REMOTE_DELETE_ENTRY_BUDGET: usize = 20_000;

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
}
