//! SFTP 目录同步（单向 mirror）。
//!
//! 流程分两步：`sftp_sync_plan` 扫描源/目标两侧目录树产出差异计划（前端预览确认），
//! `sftp_sync_start` 按计划逐文件后台执行（串行、单文件失败不影响其余、随时可取消）。
//! 第一版刻意**不做镜像删除**：同步只新增/更新，绝不删除目标侧多余文件；
//! 「删除多余项」属于高危操作，待后续单独评审再立项。
//!
//! 比较规则（不取哈希，代价太高）：目标缺失 → 新增；大小不同 → 更新；
//! 大小相同但源 mtime 更新 → 更新；其余跳过。传输完成后源/目标 mtime 语义
//! 天然错开（新写入方时间更新），重复同步会正确判为 skip。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh_sftp::protocol::OpenFlags;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use ts_rs::TS;

use super::sftp::SFTP_CHUNK_SIZE;
use super::{EventSink, SshManager};

/// 同步方向：上传（本地 → 远程）。
pub const SYNC_UPLOAD: &str = "upload";
/// 同步方向：下载（远程 → 本地）。
pub const SYNC_DOWNLOAD: &str = "download";

const SYNC_MAX_DEPTH: usize = 16;
const SYNC_MAX_ENTRIES: usize = 20_000;
const SYNC_PROGRESS_INTERVAL: Duration = Duration::from_millis(300);
/// 事件里保留的最后几条错误，避免大目录失败刷爆事件通道。
const SYNC_MAX_REPORTED_ERRORS: usize = 20;

/// 单条同步动作。`action`：`mkdir`（建目录）/ `add`（新增）/ `update`（更新）/ `skip`（跳过）。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncPlanEntry {
    /// 相对路径，一律使用 `/` 分隔，不含 `..` 与前导分隔符。
    pub relative_path: String,
    pub action: String,
    /// 文件字节数（目录为 0）。
    #[ts(type = "number")]
    pub size: u64,
}

#[derive(Clone, Debug, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncPlan {
    #[ts(type = "number")]
    pub session_id: u64,
    pub direction: String,
    pub local_dir: String,
    pub remote_dir: String,
    pub entries: Vec<SyncPlanEntry>,
    /// 将实际传输的文件数（add + update）。
    pub transfer_count: usize,
    pub skip_count: usize,
    /// 将实际传输的字节总量。
    #[ts(type = "number")]
    pub total_bytes: u64,
}

#[derive(Clone, Debug, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncStartInfo {
    pub total_files: usize,
    #[ts(type = "number")]
    pub total_bytes: u64,
}

#[derive(Clone, Debug, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncProgress {
    pub v: u32,
    #[ts(type = "number")]
    pub session_id: u64,
    pub direction: String,
    pub done_files: usize,
    pub total_files: usize,
    #[ts(type = "number")]
    pub done_bytes: u64,
    #[ts(type = "number")]
    pub total_bytes: u64,
    pub current_file: Option<String>,
    pub finished: bool,
    pub cancelled: bool,
    pub errors: Vec<String>,
}

/// 一次同步任务的取消句柄：按会话登记，同一会话同时只允许一个同步任务。
pub struct SyncJob {
    pub session_id: u64,
    pub cancelled: AtomicBool,
}

impl SyncJob {
    fn new(session_id: u64) -> Arc<Self> {
        Arc::new(SyncJob {
            session_id,
            cancelled: AtomicBool::new(false),
        })
    }
}

/// 扫描时的节点元数据（本地与远程统一形态）。
#[derive(Clone, Copy, Debug)]
struct TreeNode {
    is_dir: bool,
    size: u64,
    mtime: i64,
}

/// 纯函数：源/目标两侧的相对路径树 → 按执行顺序排列的动作清单。
///
/// 目录条目天然排在文件之前（BTreeMap 字典序使父路径先于子路径），
/// 保证父目录先创建。类型冲突（源是文件、目标是目录，或反之）按 update
/// 处理——执行阶段该动作必然失败并被逐文件错误收集，不会静默吞掉。
fn compute_sync_actions(
    source: &BTreeMap<String, TreeNode>,
    target: &BTreeMap<String, TreeNode>,
) -> Vec<SyncPlanEntry> {
    let mut entries = Vec::with_capacity(source.len());
    for (path, node) in source {
        let action = match target.get(path) {
            None => {
                if node.is_dir {
                    "mkdir"
                } else {
                    "add"
                }
            }
            Some(existing) => {
                if node.is_dir {
                    if existing.is_dir {
                        "skip"
                    } else {
                        // 类型冲突：交给执行阶段报错。
                        "update"
                    }
                } else if existing.is_dir
                    || existing.size != node.size
                    || node.mtime > existing.mtime
                {
                    "update"
                } else {
                    "skip"
                }
            }
        };
        entries.push(SyncPlanEntry {
            relative_path: path.clone(),
            action: action.to_string(),
            size: if node.is_dir { 0 } else { node.size },
        });
    }
    entries
}

/// 校验前端回传的相对路径：拒绝空串、绝对路径、反斜杠与 `..` 上跳。
fn validate_relative_path(raw: &str) -> Result<String, String> {
    let path = raw.trim();
    if path.is_empty() {
        return Err("同步相对路径为空".to_string());
    }
    if path.starts_with('/') || path.starts_with('\\') || path.contains('\\') {
        return Err(format!("同步相对路径含非法分隔符: {path}"));
    }
    if path
        .split('/')
        .any(|segment| segment == ".." || segment.is_empty() && path.contains("//"))
    {
        return Err(format!("同步相对路径含上跳或空段: {path}"));
    }
    if path.len() > 1024 {
        return Err("同步相对路径过长".to_string());
    }
    Ok(path.to_string())
}

/// 拼接远程路径（base 末尾多余 `/` 去重）。
fn join_remote(base: &str, relative: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.is_empty() {
        format!("/{relative}")
    } else {
        format!("{trimmed}/{relative}")
    }
}

/// 递归扫描本地目录树（不跟随符号链接），带深度与总量预算。
fn scan_local_dir(
    root: &Path,
    map: &mut BTreeMap<String, TreeNode>,
    budget: &mut usize,
) -> Result<(), String> {
    fn walk(
        dir: &Path,
        relative: &str,
        depth: usize,
        map: &mut BTreeMap<String, TreeNode>,
        budget: &mut usize,
    ) -> Result<(), String> {
        if depth > SYNC_MAX_DEPTH {
            return Err(format!(
                "本地目录嵌套过深（>{} 层）: {}",
                SYNC_MAX_DEPTH, relative
            ));
        }
        let read_dir = std::fs::read_dir(dir)
            .map_err(|error| format!("读取本地目录失败 {relative}: {error}"))?;
        for entry in read_dir {
            if *budget == 0 {
                return Err(format!("本地目录条目数超过 {SYNC_MAX_ENTRIES} 上限"));
            }
            *budget -= 1;
            let entry = entry.map_err(|error| format!("遍历本地目录失败 {relative}: {error}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            let child_relative = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            // 符号链接一律跳过，避免环与越界。
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                map.insert(
                    child_relative.clone(),
                    TreeNode {
                        is_dir: true,
                        size: 0,
                        mtime: 0,
                    },
                );
                walk(&entry.path(), &child_relative, depth + 1, map, budget)?;
            } else if meta.is_file() {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs() as i64)
                    .unwrap_or(0);
                map.insert(
                    child_relative,
                    TreeNode {
                        is_dir: false,
                        size: meta.len(),
                        mtime,
                    },
                );
            }
        }
        Ok(())
    }
    walk(root, "", 0, map, budget)
}

/// 递归扫描远程目录树，带深度与总量预算。
async fn scan_remote_dir(
    sftp: &russh_sftp::client::SftpSession,
    root: &str,
    map: &mut BTreeMap<String, TreeNode>,
    budget: &mut usize,
) -> Result<(), String> {
    async fn walk(
        sftp: &russh_sftp::client::SftpSession,
        dir: &str,
        relative: &str,
        depth: usize,
        map: &mut BTreeMap<String, TreeNode>,
        budget: &mut usize,
    ) -> Result<(), String> {
        if depth > SYNC_MAX_DEPTH {
            return Err(format!(
                "远程目录嵌套过深（>{} 层）: {relative}",
                SYNC_MAX_DEPTH
            ));
        }
        let entries = sftp
            .read_dir(dir)
            .await
            .map_err(|error| format!("读取远程目录失败 {relative}: {error}"))?;
        for entry in entries {
            if *budget == 0 {
                return Err(format!("远程目录条目数超过 {SYNC_MAX_ENTRIES} 上限"));
            }
            *budget -= 1;
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = entry.metadata();
            let child_relative = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            let child_path = join_remote(dir, &name);
            if meta.file_type().is_dir() {
                map.insert(
                    child_relative.clone(),
                    TreeNode {
                        is_dir: true,
                        size: 0,
                        mtime: 0,
                    },
                );
                Box::pin(walk(
                    sftp,
                    &child_path,
                    &child_relative,
                    depth + 1,
                    map,
                    budget,
                ))
                .await?;
            } else if meta.file_type().is_symlink() {
                // 与本地侧一致：符号链接跳过。
                continue;
            } else {
                map.insert(
                    child_relative,
                    TreeNode {
                        is_dir: false,
                        size: meta.size.unwrap_or(0),
                        mtime: meta.mtime.map(|value| value as i64).unwrap_or(0),
                    },
                );
            }
        }
        Ok(())
    }
    walk(sftp, root, "", 0, map, budget).await
}

fn direction_of(direction: &str) -> Result<&'static str, String> {
    match direction {
        SYNC_UPLOAD => Ok(SYNC_UPLOAD),
        SYNC_DOWNLOAD => Ok(SYNC_DOWNLOAD),
        other => Err(format!("未知的同步方向: {other}")),
    }
}

impl SshManager {
    /// 生成同步计划：扫描源/目标两侧目录树并产出差异动作清单。
    pub async fn sftp_sync_plan(
        &self,
        id: u64,
        direction: String,
        local_dir: String,
        remote_dir: String,
    ) -> Result<SyncPlan, String> {
        let direction = direction_of(&direction)?;
        let remote_dir = super::sftp::validate_sftp_path(remote_dir)?;
        let local_dir = local_dir.trim().to_string();
        if local_dir.is_empty() {
            return Err("本地目录路径为空".to_string());
        }
        let local_path = PathBuf::from(&local_dir);
        let meta =
            std::fs::metadata(&local_path).map_err(|error| format!("读取本地目录失败: {error}"))?;
        if !meta.is_dir() {
            return Err("本地路径不是一个目录".to_string());
        }

        let (source, target) = match direction {
            SYNC_UPLOAD => {
                let mut local_map = BTreeMap::new();
                let mut budget = SYNC_MAX_ENTRIES;
                scan_local_dir(&local_path, &mut local_map, &mut budget)?;
                let sftp = self.open_sftp_channel(id).await?;
                let mut remote_map = BTreeMap::new();
                let mut budget = SYNC_MAX_ENTRIES;
                let scan = scan_remote_dir(&sftp, &remote_dir, &mut remote_map, &mut budget).await;
                let _ = sftp.close().await;
                scan?;
                (local_map, remote_map)
            }
            _ => {
                let sftp = self.open_sftp_channel(id).await?;
                let mut remote_map = BTreeMap::new();
                let mut budget = SYNC_MAX_ENTRIES;
                let scan = scan_remote_dir(&sftp, &remote_dir, &mut remote_map, &mut budget).await;
                let _ = sftp.close().await;
                scan?;
                let mut local_map = BTreeMap::new();
                let mut budget = SYNC_MAX_ENTRIES;
                scan_local_dir(&local_path, &mut local_map, &mut budget)?;
                (remote_map, local_map)
            }
        };

        let entries = compute_sync_actions(&source, &target);
        let transfer_count = entries
            .iter()
            .filter(|entry| entry.action == "add" || entry.action == "update")
            .count();
        let skip_count = entries
            .iter()
            .filter(|entry| entry.action == "skip")
            .count();
        let total_bytes = entries
            .iter()
            .filter(|entry| entry.action == "add" || entry.action == "update")
            .map(|entry| entry.size)
            .sum();
        Ok(SyncPlan {
            session_id: id,
            direction: direction.to_string(),
            local_dir,
            remote_dir,
            entries,
            transfer_count,
            skip_count,
            total_bytes,
        })
    }

    /// 启动同步执行：后台逐文件按计划动作串行处理，进度经事件推送。
    /// 同一会话同时只允许一个同步任务（重复启动直接拒绝）。
    pub async fn sftp_sync_start(
        &self,
        manager: Arc<SshManager>,
        sink: Arc<dyn EventSink>,
        id: u64,
        direction: String,
        local_dir: String,
        remote_dir: String,
        entries: Vec<SyncPlanEntry>,
    ) -> Result<SyncStartInfo, String> {
        let direction = direction_of(&direction)?;
        let remote_dir = super::sftp::validate_sftp_path(remote_dir)?;
        let local_dir = local_dir.trim().to_string();
        if local_dir.is_empty() {
            return Err("本地目录路径为空".to_string());
        }
        if entries.len() > SYNC_MAX_ENTRIES {
            return Err(format!("同步条目数超过 {SYNC_MAX_ENTRIES} 上限"));
        }
        let mut validated = Vec::with_capacity(entries.len());
        for entry in entries {
            let path = validate_relative_path(&entry.relative_path)?;
            let action = match entry.action.as_str() {
                "mkdir" | "add" | "update" | "skip" => entry.action,
                other => return Err(format!("未知同步动作: {other}")),
            };
            validated.push(SyncPlanEntry {
                relative_path: path,
                action,
                size: entry.size,
            });
        }
        let transfer_count = validated
            .iter()
            .filter(|entry| entry.action == "add" || entry.action == "update")
            .count();
        let total_bytes = validated
            .iter()
            .filter(|entry| entry.action == "add" || entry.action == "update")
            .map(|entry| entry.size)
            .sum();

        {
            let jobs = self.sync_jobs.lock().await;
            if jobs.contains_key(&id) {
                return Err("该会话已有同步任务在进行".to_string());
            }
        }
        let job = SyncJob::new(id);
        self.sync_jobs.lock().await.insert(id, job.clone());

        // 会话在校验阶段先确认可用，避免任务起跑即失败。
        let sftp = self.open_sftp_channel(id).await?;
        let session_id = id;
        tauri::async_runtime::spawn(async move {
            run_sync_job(
                manager,
                sink,
                job,
                sftp,
                session_id,
                direction,
                local_dir,
                remote_dir,
                validated,
                transfer_count,
                total_bytes,
            )
            .await;
        });
        Ok(SyncStartInfo {
            total_files: transfer_count,
            total_bytes,
        })
    }

    /// 取消进行中的同步任务。返回是否存在任务。
    pub async fn sftp_sync_cancel(&self, id: u64) -> bool {
        let jobs = self.sync_jobs.lock().await;
        match jobs.get(&id) {
            Some(job) => {
                job.cancelled.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }
}

/// 同步执行主体：单文件粒度串行，失败隔离，取消即刻停止。
#[allow(clippy::too_many_arguments)]
async fn run_sync_job(
    manager: Arc<SshManager>,
    sink: Arc<dyn EventSink>,
    job: Arc<SyncJob>,
    sftp: russh_sftp::client::SftpSession,
    session_id: u64,
    direction: &'static str,
    local_dir: String,
    remote_dir: String,
    entries: Vec<SyncPlanEntry>,
    total_files: usize,
    total_bytes: u64,
) {
    let local_root = PathBuf::from(&local_dir);
    let mut done_files = 0_usize;
    let mut done_bytes = 0_u64;
    let mut errors: Vec<String> = Vec::new();
    let mut current_file: Option<String> = None;
    let mut last_emit = now_millis();

    let report = |force: bool,
                  done_files: usize,
                  done_bytes: u64,
                  current_file: &Option<String>,
                  errors: &Vec<String>,
                  finished: bool,
                  cancelled: bool,
                  last_emit: &mut u64| {
        let now = now_millis();
        if !force && now.saturating_sub(*last_emit) < SYNC_PROGRESS_INTERVAL.as_millis() as u64 {
            return;
        }
        *last_emit = now;
        sink.emit(
            "sftp-sync-progress",
            serde_json::to_value(SyncProgress {
                v: super::EVENT_SCHEMA_VERSION,
                session_id,
                direction: direction.to_string(),
                done_files,
                total_files,
                done_bytes,
                total_bytes,
                current_file: current_file.clone(),
                finished,
                cancelled,
                errors: errors
                    .iter()
                    .rev()
                    .take(SYNC_MAX_REPORTED_ERRORS)
                    .rev()
                    .cloned()
                    .collect(),
            })
            .unwrap_or_default(),
        );
    };

    for entry in &entries {
        if job.cancelled.load(Ordering::SeqCst) {
            break;
        }
        if entry.action == "skip" {
            continue;
        }
        current_file = Some(entry.relative_path.clone());
        let action_result: Result<(), String> = if entry.action == "mkdir" {
            match direction {
                SYNC_UPLOAD => {
                    let remote = join_remote(&remote_dir, &entry.relative_path);
                    sftp.create_dir(&remote)
                        .await
                        .map_err(|error| format!("{remote}: {error}"))
                }
                _ => {
                    let local = local_root.join(&entry.relative_path);
                    tokio::fs::create_dir_all(&local)
                        .await
                        .map_err(|error| format!("{}: {error}", local.display()))
                }
            }
        } else {
            match direction {
                SYNC_UPLOAD => {
                    let local = local_root.join(&entry.relative_path);
                    let remote = join_remote(&remote_dir, &entry.relative_path);
                    stream_upload(&sftp, &local, &remote).await.map(|_| ())
                }
                _ => {
                    let remote = join_remote(&remote_dir, &entry.relative_path);
                    let local = local_root.join(&entry.relative_path);
                    stream_download(&sftp, &remote, &local).await.map(|_| ())
                }
            }
        };
        if let Err(error) = action_result {
            let mut message = error;
            if message.len() > 300 {
                message.truncate(300);
            }
            if errors.len() == SYNC_MAX_REPORTED_ERRORS * 4 {
                errors.remove(0);
            }
            errors.push(format!("{}: {}", entry.relative_path, message));
        } else if entry.action != "mkdir" {
            done_files += 1;
            done_bytes += entry.size;
        }
        report(
            false,
            done_files,
            done_bytes,
            &current_file,
            &errors,
            false,
            false,
            &mut last_emit,
        );
    }

    let cancelled = job.cancelled.load(Ordering::SeqCst);
    report(
        true,
        done_files,
        done_bytes,
        &current_file,
        &errors,
        true,
        cancelled,
        &mut last_emit,
    );
    manager.sync_jobs.lock().await.remove(&session_id);
    let _ = sftp.close().await;
}

/// 上传单个文件：本地读 → 远程写，返回传输字节数。
async fn stream_upload(
    sftp: &russh_sftp::client::SftpSession,
    local: &Path,
    remote: &str,
) -> Result<u64, String> {
    let mut local_file = tokio::fs::File::open(local)
        .await
        .map_err(|error| format!("打开本地文件失败 {}: {error}", local.display()))?;
    let mut remote_file = sftp
        .open_with_flags(
            remote,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|error| format!("创建远程文件失败 {remote}: {error}"))?;
    let mut buffer = vec![0_u8; SFTP_CHUNK_SIZE];
    let mut total = 0_u64;
    loop {
        let n = local_file
            .read(&mut buffer)
            .await
            .map_err(|error| format!("读取本地文件失败 {}: {error}", local.display()))?;
        if n == 0 {
            break;
        }
        remote_file
            .write_all(&buffer[..n])
            .await
            .map_err(|error| format!("写入远程文件失败 {remote}: {error}"))?;
        total += n as u64;
    }
    remote_file
        .shutdown()
        .await
        .map_err(|error| format!("收尾远程文件失败 {remote}: {error}"))?;
    Ok(total)
}

/// 下载单个文件：远程读 → 本地写，返回传输字节数。
async fn stream_download(
    sftp: &russh_sftp::client::SftpSession,
    remote: &str,
    local: &Path,
) -> Result<u64, String> {
    let mut remote_file = sftp
        .open(remote)
        .await
        .map_err(|error| format!("打开远程文件失败 {remote}: {error}"))?;
    if let Some(parent) = local.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("创建本地目录失败 {}: {error}", parent.display()))?;
    }
    let mut local_file = tokio::fs::File::create(local)
        .await
        .map_err(|error| format!("创建本地文件失败 {}: {error}", local.display()))?;
    let mut buffer = vec![0_u8; SFTP_CHUNK_SIZE];
    let mut total = 0_u64;
    loop {
        let n = remote_file
            .read(&mut buffer)
            .await
            .map_err(|error| format!("读取远程文件失败 {remote}: {error}"))?;
        if n == 0 {
            break;
        }
        local_file
            .write_all(&buffer[..n])
            .await
            .map_err(|error| format!("写入本地文件失败 {}: {error}", local.display()))?;
        total += n as u64;
    }
    local_file
        .flush()
        .await
        .map_err(|error| format!("收尾本地文件失败 {}: {error}", local.display()))?;
    Ok(total)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(is_dir: bool, size: u64, mtime: i64) -> TreeNode {
        TreeNode {
            is_dir,
            size,
            mtime,
        }
    }

    #[test]
    fn relative_path_validation_rejects_traversal_and_separators() {
        assert!(validate_relative_path("a/b.txt").is_ok());
        assert!(validate_relative_path("子目录/文件.txt").is_ok());
        assert!(validate_relative_path("").is_err());
        assert!(validate_relative_path("/abs").is_err());
        assert!(validate_relative_path("a/../b").is_err());
        assert!(validate_relative_path("a\\b").is_err());
    }

    #[test]
    fn join_remote_dedupes_trailing_slash() {
        assert_eq!(join_remote("/srv/data", "a.txt"), "/srv/data/a.txt");
        assert_eq!(join_remote("/srv/data/", "a.txt"), "/srv/data/a.txt");
        assert_eq!(join_remote("/", "a.txt"), "/a.txt");
    }

    #[test]
    fn sync_actions_cover_add_update_skip_and_dir_ordering() {
        let mut source = BTreeMap::new();
        source.insert("dir".to_string(), node(true, 0, 0));
        source.insert("dir/sub".to_string(), node(true, 0, 0));
        source.insert("dir/new.txt".to_string(), node(false, 10, 100));
        source.insert("same.txt".to_string(), node(false, 5, 50));
        source.insert("bigger.txt".to_string(), node(false, 20, 40));
        source.insert("newer.txt".to_string(), node(false, 5, 90));
        source.insert("older.txt".to_string(), node(false, 5, 10));

        let mut target = BTreeMap::new();
        target.insert("same.txt".to_string(), node(false, 5, 60));
        target.insert("bigger.txt".to_string(), node(false, 7, 99));
        target.insert("newer.txt".to_string(), node(false, 5, 50));
        target.insert("older.txt".to_string(), node(false, 5, 99));

        let actions = compute_sync_actions(&source, &target);
        let by_path: std::collections::HashMap<&str, &str> = actions
            .iter()
            .map(|entry| (entry.relative_path.as_str(), entry.action.as_str()))
            .collect();

        assert_eq!(by_path.get("dir"), Some(&"mkdir"));
        assert_eq!(by_path.get("dir/sub"), Some(&"mkdir"));
        assert_eq!(by_path.get("dir/new.txt"), Some(&"add"));
        assert_eq!(by_path.get("same.txt"), Some(&"skip"));
        assert_eq!(by_path.get("bigger.txt"), Some(&"update"));
        assert_eq!(by_path.get("newer.txt"), Some(&"update"));
        // 大小相同、目标 mtime 更新 → 跳过（源并非更新方）。
        assert_eq!(by_path.get("older.txt"), Some(&"skip"));
        // 父目录先于子路径。
        let dir_index = actions
            .iter()
            .position(|entry| entry.relative_path == "dir")
            .unwrap();
        let sub_index = actions
            .iter()
            .position(|entry| entry.relative_path == "dir/sub")
            .unwrap();
        let file_index = actions
            .iter()
            .position(|entry| entry.relative_path == "dir/new.txt")
            .unwrap();
        // 真正需要保证的顺序不变量：父目录条目先于其内部条目（"dir" < "dir/…"）。
        // 同级文件与子目录之间的相对顺序无所谓（"dir/new.txt" 按字典序可能排在
        // "dir/sub" 之前，这不影响正确性——各自父目录都已先创建）。
        assert!(dir_index < sub_index);
        assert!(dir_index < file_index);
    }

    #[test]
    fn sync_actions_flag_type_conflicts_for_isolated_failure() {
        let mut source = BTreeMap::new();
        source.insert("conflict".to_string(), node(false, 3, 10));
        let mut target = BTreeMap::new();
        target.insert("conflict".to_string(), node(true, 0, 0));
        let actions = compute_sync_actions(&source, &target);
        assert_eq!(actions[0].action, "update");
    }
}
