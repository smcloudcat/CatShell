use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use russh_sftp::protocol::OpenFlags;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;
use ts_rs::TS;

use super::{EventSink, SshManager};

const MAX_SFTP_FILE_SIZE: usize = 64 * 1024 * 1024;
pub(super) const SFTP_CHUNK_SIZE: usize = 256 * 1024;
const REMOTE_DELETE_MAX_DEPTH: usize = 16;
const REMOTE_DELETE_ENTRY_BUDGET: usize = 20_000;
pub(super) const DISK_CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
pub(super) const DISK_PART_SUFFIX: &str = ".catshell-part";

/// SFTP 通道协商（channel open + subsystem + 初始化握手）的超时上限。
/// 正常服务器 2 秒内完成，海外高延迟链路 15 秒也足够；
/// 超时说明远端没有在跑 SFTP 服务或网络已经坏掉，继续等只会挂死。
const SFTP_OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// 单个 SFTP 短操作（列目录/改名/删除等）的超时上限。
const SFTP_OP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// 整文件读写（单次最多 64 MB）的超时上限：慢链路下 64 MB 远超 20 秒，
/// 但仍有硬上限，避免远端收下请求后停摆导致永久挂起（审计 B-6）。
const SFTP_BULK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
/// SFTP 通道关闭的超时上限（关闭挂起不应拖住已完成的操作结果）。
const SFTP_CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// 给 SFTP 短操作套超时。
///
/// russh-sftp 2.4 的会话层没有帧级超时：远端不回包时 `read_dir` 等调用的
/// future 会永久挂起，前端表现为「SFTP 列表一直加载中」——无错误、无法恢复、
/// 也没有任何日志。超时后必须给出明确错误，让用户可以重试而不是干等。
async fn with_sftp_timeout<T>(
    label: &str,
    fut: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    with_sftp_budget(label, SFTP_OP_TIMEOUT, fut).await
}

/// 整文件读写的超时包装：预算比短操作宽得多，但同样是硬上限（审计 B-6）。
async fn with_sftp_bulk_timeout<T>(
    label: &str,
    fut: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    with_sftp_budget(label, SFTP_BULK_TIMEOUT, fut).await
}

async fn with_sftp_budget<T>(
    label: &str,
    budget: std::time::Duration,
    fut: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match tokio::time::timeout(budget, fut).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "{label}超时（{} 秒）：网络不稳定或远端无响应，请重试",
            budget.as_secs()
        )),
    }
}

/// 静默关闭 SFTP 通道：关闭失败或挂起只丢弃结果，不影响主操作。
pub(super) async fn close_sftp_quietly(sftp: &russh_sftp::client::SftpSession) {
    let _ = tokio::time::timeout(SFTP_CLOSE_TIMEOUT, sftp.close()).await;
}

/// 带结果检查地关闭 SFTP 通道（保留既有「关闭失败报错」的语义，只补超时）。
async fn close_sftp_checked(sftp: &russh_sftp::client::SftpSession) -> Result<(), String> {
    match tokio::time::timeout(SFTP_CLOSE_TIMEOUT, sftp.close()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(format!("关闭 SFTP 通道失败: {error}")),
        Err(_) => Err("关闭 SFTP 通道超时".to_string()),
    }
}

#[derive(Clone, Debug, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number | null")]
    pub modified_at: Option<i64>,
    pub permissions: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SftpTransferStart {
    #[ts(type = "number")]
    pub transfer_id: u64,
    #[ts(type = "number")]
    pub total: u64,
}

#[derive(Clone, Debug, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SftpChunk {
    pub data: String,
    pub done: bool,
    #[ts(type = "number")]
    pub transferred: u64,
    #[ts(type = "number")]
    pub total: u64,
}

#[derive(Clone, Debug, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SftpDiskTransferStart {
    #[ts(type = "number")]
    pub transfer_id: u64,
    #[ts(type = "number")]
    pub total: u64,
    pub resumed: bool,
    /// 真实本地路径。令牌/对话框流程中它本就留在 Rust 侧；这里回传给前端
    /// 仅用于传输队列持久化（重启后续传需要），发起上传的令牌安全边界不变。
    pub local_path: String,
}

/// 一次性上传路径令牌：webview 仅凭令牌发起磁盘上传，无法指定任意本地路径。
#[derive(Clone, Debug)]
pub struct UploadPathToken {
    pub session_id: u64,
    pub local_path: String,
    pub remote_path: String,
    pub file_name: String,
    pub created: std::time::Instant,
}

impl UploadPathToken {
    const TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

    fn expired(&self) -> bool {
        self.created.elapsed() > Self::TTL
    }
}

#[derive(Clone, Debug, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SftpDiskUploadPick {
    #[ts(type = "number")]
    pub token: u64,
    pub file_name: String,
    pub remote_path: String,
}

#[derive(Clone, Debug, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SftpDiskTransferInfo {
    #[ts(type = "number")]
    pub transfer_id: u64,
    #[ts(type = "number")]
    pub session_id: u64,
    pub direction: String,
    pub file_name: String,
    pub remote_path: String,
    pub local_path: String,
    #[ts(type = "number")]
    pub transferred: u64,
    #[ts(type = "number")]
    pub total: u64,
    pub done: bool,
    pub cancelled: bool,
    pub error: Option<String>,
    /// 当前限速（KB/s，0 表示不限速）。
    #[ts(type = "number")]
    pub speed_limit_kbs: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpDiskProgress {
    v: u32,
    transfer_id: u64,
    session_id: u64,
    direction: String,
    file_name: String,
    transferred: u64,
    total: u64,
    done: bool,
    cancelled: bool,
    error: Option<String>,
    speed_limit_kbs: u64,
}

/// 落盘流式传输任务：数据完全在 Rust 侧读写本地磁盘，不经过前端内存。
/// 进度以节流事件（≥300ms）推送给前端；半成品文件支持断点续传
/// （下载为本地 `{target}.catshell-part`，上传为远端 `{target}.catshell-part`，完成后原子的 rename 还原目标名）。
pub struct SftpDiskTransfer {
    pub id: u64,
    pub session_id: u64,
    pub remote_path: String,
    pub local_path: String,
    pub part_path: String,
    pub file_name: String,
    pub direction: &'static str,
    pub total: u64,
    pub transferred: AtomicU64,
    pub cancelled: AtomicBool,
    pub done: AtomicBool,
    pub error: StdMutex<Option<String>>,
    pub last_emit: AtomicU64,
    /// 带宽限速（字节/秒，0 = 不限）。运行中可动态调整。
    pub speed_limit_bps: AtomicU64,
}

/// 单条限速档位上限：防止误输入出天文数字（1 GB/s）以外的值没有意义。
pub const MAX_SPEED_LIMIT_KBS: u64 = 1024 * 1024;

/// 把前端传来的 KB/s 限速归一：0 表示不限，上限 [`MAX_SPEED_LIMIT_KBS`]。
pub fn normalize_speed_limit_kbs(kbs: u64) -> u64 {
    kbs.min(MAX_SPEED_LIMIT_KBS)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

impl SftpDiskTransfer {
    /// 错误槽的锁可能因其他线程 panic 而中毒。`panic = "abort"` 构建下，
    /// 把「读取一个错误字符串」升级成 `expect` 崩溃会直接终止整个应用，
    /// 这里退化为取回中毒锁的内部数据（P2-3）。
    fn error_guard(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

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
            error: self.error_guard().clone(),
            speed_limit_kbs: self.speed_limit_bps.load(Ordering::SeqCst) / 1024,
        }
    }

    fn progress(&self) -> SftpDiskProgress {
        SftpDiskProgress {
            v: super::EVENT_SCHEMA_VERSION,
            transfer_id: self.id,
            session_id: self.session_id,
            direction: self.direction.to_string(),
            file_name: self.file_name.clone(),
            transferred: self.transferred.load(Ordering::SeqCst),
            total: self.total,
            done: self.done.load(Ordering::SeqCst),
            cancelled: self.cancelled.load(Ordering::SeqCst),
            error: self.error_guard().clone(),
            speed_limit_kbs: self.speed_limit_bps.load(Ordering::SeqCst) / 1024,
        }
    }

    fn finish_with_error(&self, message: String) {
        tracing::error!(
            transfer_id = self.id,
            session_id = self.session_id,
            direction = self.direction,
            remote_path = %self.remote_path,
            transferred = self.transferred.load(Ordering::SeqCst),
            error = %message,
            "磁盘 SFTP 传输失败"
        );
        *self.error_guard() = Some(message);
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

/// 带宽限速的自校准等待：以「本次传输会话内已传字节 / 限速」算出应耗时长，
/// 落后于计划就睡到追平。每次醒来检查取消标记，分片 ≤100 ms 保证取消响应。
/// 续传的起始偏移不算会话字节，因此恢复后立刻按当前限速推进，不会先冲一段。
async fn pace_transfer(
    transfer: &SftpDiskTransfer,
    started_at: std::time::Instant,
    session_bytes: u64,
) {
    loop {
        let limit = transfer.speed_limit_bps.load(Ordering::SeqCst);
        if limit == 0 {
            return;
        }
        let target = std::time::Duration::from_secs_f64(session_bytes as f64 / limit as f64);
        let elapsed = started_at.elapsed();
        if target <= elapsed {
            return;
        }
        let slice = (target - elapsed).min(std::time::Duration::from_millis(100));
        tokio::time::sleep(slice).await;
        if transfer.cancelled.load(Ordering::SeqCst) {
            return;
        }
    }
}

pub fn validate_local_path(path: &str) -> Result<String, String> {
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

/// 断点续传的「源文件指纹」：长度 + 修改时间。
///
/// 只比对半成品长度是不安全的（P2-8）：源文件被替换后长度可能恰好不短于半成品，
/// 续传就会把新内容接到旧偏移之后，产出静默损坏的文件。因此首次写入半成品时把源文件
/// 指纹落盘，续传前必须完全一致，否则从 0 重传。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct ResumeStamp {
    total: u64,
    mtime: Option<i64>,
}

const RESUME_STAMP_SUFFIX: &str = ".meta";

/// 指纹文件路径。`stamp_base` 必须是**本地**路径：
/// 下载时为本地半成品路径，上传时为「本地源文件 + 半成品后缀」——
/// 上传的半成品在远端，但源文件在本地，指纹必须跟着源文件落盘。
fn resume_stamp_path(stamp_base: &str) -> String {
    format!("{stamp_base}{RESUME_STAMP_SUFFIX}")
}

async fn read_resume_stamp(stamp_base: &str) -> Option<ResumeStamp> {
    let raw = tokio::fs::read_to_string(resume_stamp_path(stamp_base))
        .await
        .ok()?;
    serde_json::from_str(&raw).ok()
}

async fn write_resume_stamp(stamp_base: &str, stamp: &ResumeStamp) {
    if let Ok(raw) = serde_json::to_string(stamp) {
        let _ = tokio::fs::write(resume_stamp_path(stamp_base), raw).await;
    }
}

async fn clear_resume_stamp(stamp_base: &str) {
    let _ = tokio::fs::remove_file(resume_stamp_path(stamp_base)).await;
}

/// 本地源文件的指纹（上传方向用）。
async fn local_file_stamp(path: &str, total: u64) -> ResumeStamp {
    ResumeStamp {
        total,
        mtime: tokio::fs::metadata(path)
            .await
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64),
    }
}

/// 纯函数：决定本次续传的起始偏移。
///
/// 返回 `Some(offset)` 当且仅当半成品非空、短于源文件，且指纹与首次写入时一致；
/// 指纹缺失（旧版本残留半成品）或不一致时返回 `None`，由调用方从 0 重新开始。
/// 原则是「宁可重传，不可续错」。
fn resume_offset(
    part_len: u64,
    recorded: Option<&ResumeStamp>,
    source: &ResumeStamp,
) -> Option<u64> {
    if part_len == 0 || part_len >= source.total {
        return None;
    }
    match recorded {
        Some(recorded) if recorded == source => Some(part_len),
        _ => None,
    }
}

/// 纯函数：为本次传输选择半成品路径（P2-9）。
///
/// 并发发起的同名上传/下载若共用 `{target}.catshell-part`，会互相覆盖，
/// 收尾 rename 时可能把别人写到一半的内容当成成品。当基准路径已被另一条进行中的
/// 传输占用时，改用带传输号的一次性路径（该路径不支持续传）。
fn part_path_for(base: &str, transfer_id: u64, occupied: bool) -> String {
    if occupied {
        format!("{base}-{transfer_id}")
    } else {
        base.to_string()
    }
}

/// 半成品**基准**路径的占坑集合（审计 B-4）。
///
/// 只做极短的纯内存增删、从不 await，因此用 std 锁足够；中毒也不该让释放失败，
/// 统一通过 [`lock_part_claims`] 取回内部数据继续。
pub(super) type PartPathClaims = Arc<StdMutex<std::collections::HashSet<String>>>;

pub(super) fn new_part_path_claims() -> PartPathClaims {
    Arc::new(StdMutex::new(std::collections::HashSet::new()))
}

fn lock_part_claims(
    claims: &StdMutex<std::collections::HashSet<String>>,
) -> std::sync::MutexGuard<'_, std::collections::HashSet<String>> {
    claims
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 基准半成品路径的占坑守卫：Drop 时归还。
///
/// 传输真正插入 `sftp_disk_transfers` 之前还有若干 await（打开通道、读元数据……），
/// 中途任何一步失败都会提前返回，所以释放必须挂在 Drop 上，而不是只写在任务收尾。
pub(super) struct PartPathGuard {
    claims: PartPathClaims,
    base: String,
}

impl Drop for PartPathGuard {
    fn drop(&mut self) {
        lock_part_claims(&self.claims).remove(&self.base);
    }
}

/// 传输闲置回收阈值：超过该时长既未拉取分片、也未收到取消的传输会被回收并释放 SFTP 通道。
const TRANSFER_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// 跨 command 调用存活的一次 SFTP 流式传输（上传或下载）。
/// 连接锁只在打开通道时短暂持有，之后所有读写都走独立的 SFTP 通道。
pub struct SftpTransfer {
    pub id: u64,
    pub session_id: u64,
    /// 本传输实际读写的远端路径：上传指向半成品 `{target}.catshell-part`，
    /// 下载指向源文件。最终目标路径另存于 `final_path`（审计 B-1）。
    pub path: String,
    /// 上传的最终目标路径，收尾由半成品 rename 至此；下载为 None。
    pub final_path: Option<String>,
    pub direction: &'static str,
    pub total: u64,
    pub transferred: AtomicU64,
    pub cancelled: AtomicBool,
    pub file: Mutex<Option<russh_sftp::client::fs::File>>,
    pub sftp: Mutex<Option<russh_sftp::client::SftpSession>>,
    /// 最近一次有进展的时间。用于回收前端已放弃的传输（既不继续拉分片也不取消），
    /// 否则该传输持有的 SFTP 通道会一直滞留到进程退出。
    last_active: StdMutex<std::time::Instant>,
}

impl SftpTransfer {
    fn new(
        id: u64,
        session_id: u64,
        path: String,
        direction: &'static str,
        total: u64,
        file: russh_sftp::client::fs::File,
        sftp: russh_sftp::client::SftpSession,
        final_path: Option<String>,
    ) -> Self {
        SftpTransfer {
            id,
            session_id,
            path,
            final_path,
            direction,
            total,
            transferred: AtomicU64::new(0),
            cancelled: AtomicBool::new(false),
            file: Mutex::new(Some(file)),
            sftp: Mutex::new(Some(sftp)),
            last_active: StdMutex::new(std::time::Instant::now()),
        }
    }

    /// 记录一次读写进展。锁中毒时静默跳过，不影响传输本身。
    fn touch(&self) {
        if let Ok(mut guard) = self.last_active.lock() {
            *guard = std::time::Instant::now();
        }
    }

    fn idle_for(&self) -> std::time::Duration {
        self.last_active
            .lock()
            .map(|guard| guard.elapsed())
            .unwrap_or_default()
    }
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
    let entries = with_sftp_timeout("读取远程目录", async {
        sftp.read_dir(path)
            .await
            .map_err(|error| format!("读取远程目录失败: {error}"))
    })
    .await?;
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
            with_sftp_timeout("删除远程目录", async {
                sftp.remove_dir(&child_path)
                    .await
                    .map_err(|error| format!("删除远程目录失败: {error}"))
            })
            .await?;
        } else {
            with_sftp_timeout("删除远程文件", async {
                sftp.remove_file(&child_path)
                    .await
                    .map_err(|error| format!("删除远程文件失败: {error}"))
            })
            .await?;
        }
    }
    Ok(())
}

pub fn validate_sftp_path(path: String) -> Result<String, String> {
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
        let started = std::time::Instant::now();
        // 空 path 兜底为当前目录；其余与其他 SFTP 方法统一走路径校验（审计 S-5）。
        let path = if path.trim().is_empty() {
            ".".to_string()
        } else {
            validate_sftp_path(path)?
        };
        // 通道协商内部自带 3 × 15 秒预算，必须留在外层超时之外：否则慢链路（每步各 8 秒
        // 仍属正常）会被外层 20 秒先行打断，既误报超时又白白丢弃一次可用连接（审计 B-5）。
        let sftp = self.open_sftp_channel(id).await?;
        let result = with_sftp_timeout("读取远程目录", async {
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
            Ok(result)
        })
        .await;
        close_sftp_quietly(&sftp).await;
        if result.is_ok() {
            tracing::info!(
                session_id = id,
                elapsed_ms = started.elapsed().as_millis() as u64,
                "SFTP 目录列表完成"
            );
        }
        result
    }

    pub async fn sftp_read_file(&self, id: u64, path: String) -> Result<Vec<u8>, String> {
        let path = validate_sftp_path(path)?;
        let sftp = self.open_sftp_channel(id).await?;
        // 必须先查元数据再读：`sftp.read` 会把远端文件完整读进内存，
        // 事后校验上限挡不住 10 GB 文件把内存吃满（审计 S-1）。
        let size = with_sftp_timeout("读取远程文件信息", async {
            Ok(sftp
                .metadata(&path)
                .await
                .map_err(|error| format!("读取远程文件信息失败: {error}"))?
                .size
                .unwrap_or(0))
        })
        .await?;
        if size > MAX_SFTP_FILE_SIZE as u64 {
            close_sftp_quietly(&sftp).await;
            return Err("文件超过 64 MB 下载限制".to_string());
        }
        let data = match with_sftp_bulk_timeout("读取远程文件", async {
            sftp.read(path)
                .await
                .map_err(|error| format!("读取远程文件失败: {error}"))
        })
        .await
        {
            Ok(data) => data,
            Err(error) => {
                close_sftp_quietly(&sftp).await;
                return Err(error);
            }
        };
        if data.len() > MAX_SFTP_FILE_SIZE {
            close_sftp_quietly(&sftp).await;
            return Err("文件超过 64 MB 下载限制".to_string());
        }
        close_sftp_quietly(&sftp).await;
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
        // 与流式上传同口径（审计 B-1）：直接 create(目标) 会在写入中途失败时把
        // 既有远端文件截断，改为先写半成品、成功后再 rename 覆盖。
        let part_path = format!("{path}{DISK_PART_SUFFIX}");
        let mut file = sftp
            .create(&part_path)
            .await
            .map_err(|error| format!("创建远程文件失败: {error}"))?;
        let written = with_sftp_bulk_timeout("写入远程文件", async {
            file.write_all(&data)
                .await
                .map_err(|error| format!("写入远程文件失败: {error}"))?;
            file.shutdown()
                .await
                .map_err(|error| format!("完成远程文件写入失败: {error}"))
        })
        .await;
        if let Err(error) = written {
            let _ = sftp.remove_file(&part_path).await;
            close_sftp_quietly(&sftp).await;
            return Err(error);
        }
        // 覆盖已存在目标：rename 失败（服务端不允许覆盖）时先删旧再重试，
        // 此刻半成品内容完整，删旧不会造成数据损失。
        if sftp.rename(&part_path, &path).await.is_err() {
            let _ = sftp.remove_file(&path).await;
            if let Err(error) = sftp.rename(&part_path, &path).await {
                let _ = sftp.remove_file(&part_path).await;
                close_sftp_quietly(&sftp).await;
                return Err(format!("保存远程文件失败: {error}"));
            }
        }
        close_sftp_checked(&sftp).await
    }

    pub async fn sftp_remove_file(&self, id: u64, path: String) -> Result<(), String> {
        let path = validate_sftp_path(path)?;
        let sftp = self.open_sftp_channel(id).await?;
        with_sftp_timeout("删除远程文件", async {
            sftp.remove_file(path)
                .await
                .map_err(|error| format!("删除远程文件失败: {error}"))
        })
        .await?;
        close_sftp_checked(&sftp).await
    }

    pub async fn sftp_mkdir(&self, id: u64, path: String) -> Result<(), String> {
        let path = validate_sftp_path(path)?;
        let sftp = self.open_sftp_channel(id).await?;
        with_sftp_timeout("创建远程目录", async {
            sftp.create_dir(&path)
                .await
                .map_err(|error| format!("创建远程目录失败: {error}"))
        })
        .await?;
        close_sftp_checked(&sftp).await
    }

    /// 递归删除远程目录及其全部内容。拒绝根目录，限制递归深度与条目总数，
    /// 防止在超大目录树上失控；调用方必须先经过强确认流程。
    pub async fn sftp_remove_dir(&self, id: u64, path: String) -> Result<(), String> {
        let path = validate_sftp_path(path)?;
        // `.` / `..` 段会让递归删除作用到当前目录之外（`..` 即清空上级目录），
        // 必须在准入阶段拒绝（审计 B-3）。
        if path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
        {
            return Err("拒绝删除含 . 或 .. 的路径".to_string());
        }
        let normalized = path.trim_end_matches('/');
        if normalized.is_empty() || segments_are_empty(normalized) {
            return Err("拒绝删除根目录".to_string());
        }
        let sftp = self.open_sftp_channel(id).await?;
        let mut budget = REMOTE_DELETE_ENTRY_BUDGET;
        remove_remote_dir_recursive(&sftp, &path, 0, &mut budget).await?;
        with_sftp_timeout("删除远程目录", async {
            sftp.remove_dir(&path)
                .await
                .map_err(|error| format!("删除远程目录失败: {error}"))
        })
        .await?;
        close_sftp_checked(&sftp).await
    }

    pub async fn sftp_rename(&self, id: u64, from: String, to: String) -> Result<(), String> {
        let from = validate_sftp_path(from)?;
        let to = validate_sftp_path(to)?;
        let sftp = self.open_sftp_channel(id).await?;
        with_sftp_timeout("重命名远程文件", async {
            sftp.rename(&from, &to)
                .await
                .map_err(|error| format!("重命名远程文件失败: {error}"))
        })
        .await?;
        close_sftp_checked(&sftp).await
    }

    /// 修改远程文件/目录权限（八进制 mode，例如 0o644）。只传 permissions，
    /// 其余元数据字段保持默认值，避免覆盖远端属主/时间戳。
    pub async fn sftp_chmod(&self, id: u64, path: String, mode: u32) -> Result<(), String> {
        let path = validate_sftp_path(path)?;
        if mode > 0o7777 {
            return Err("权限值无效（应为 3~4 位八进制，例如 644）".to_string());
        }
        let sftp = self.open_sftp_channel(id).await?;
        with_sftp_timeout("修改远程权限", async {
            sftp.set_metadata(
                &path,
                russh_sftp::protocol::FileAttributes {
                    permissions: Some(mode),
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| format!("修改远程权限失败: {error}"))
        })
        .await?;
        close_sftp_checked(&sftp).await
    }

    /// 打开独立的 SFTP 子系统通道。连接锁仅在通道协商期间持有（见
    /// `SshManager::open_session_channel`），子系统握手与后续读写都不再阻塞终端输入。
    pub(super) async fn open_sftp_channel(
        &self,
        id: u64,
    ) -> Result<russh_sftp::client::SftpSession, String> {
        let started = std::time::Instant::now();
        // 三步各带超时（SFTP_OPEN_TIMEOUT）：远端不回包时这些 future 会永久挂起，
        // 超时后 future 被 drop，tokio Mutex 的连接锁随之释放，会话不受污染。
        let channel = tokio::time::timeout(SFTP_OPEN_TIMEOUT, self.open_session_channel(id))
            .await
            .map_err(|_| {
                format!(
                    "打开 SFTP 通道超时（{} 秒）：远端无响应",
                    SFTP_OPEN_TIMEOUT.as_secs()
                )
            })??;
        tokio::time::timeout(SFTP_OPEN_TIMEOUT, channel.request_subsystem(true, "sftp"))
            .await
            .map_err(|_| {
                format!(
                    "请求 SFTP 子系统超时（{} 秒）：远端可能未提供 SFTP 服务",
                    SFTP_OPEN_TIMEOUT.as_secs()
                )
            })?
            .map_err(|error| format!("请求 SFTP 子系统失败: {error}"))?;
        let sftp = tokio::time::timeout(
            SFTP_OPEN_TIMEOUT,
            russh_sftp::client::SftpSession::new(channel.into_stream()),
        )
        .await
        .map_err(|_| format!("初始化 SFTP 超时（{} 秒）", SFTP_OPEN_TIMEOUT.as_secs()))?
        .map_err(|error| format!("初始化 SFTP 失败: {error}"))?;
        tracing::info!(
            session_id = id,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "SFTP 通道就绪"
        );
        Ok(sftp)
    }

    /// 原子占用半成品**基准**路径（审计 B-4）。
    ///
    /// 旧实现「先查占用、再建传输」之间隔着 open_sftp_channel / metadata / open 等多个
    /// await：两个并发同名传输都会读到「未占用」，拿到同一个 `{target}.catshell-part`
    /// 交错写入，收尾各自 rename 成目标名，产出静默损坏的内容。
    ///
    /// 现在「检查 + 占坑」在同一把锁内一次完成：抢到基准路径的传输才支持断点续传，
    /// 没抢到的改用带传输号的一次性路径（天然不冲突）。返回的第二项是占坑守卫，
    /// 调用方需持有到传输结束；中途提前返回时由 Drop 自动归还。
    fn claim_part_path(&self, base: &str, transfer_id: u64) -> (String, Option<PartPathGuard>) {
        let mut claims = lock_part_claims(&self.claimed_part_paths);
        if claims.insert(base.to_string()) {
            (
                base.to_string(),
                Some(PartPathGuard {
                    claims: self.claimed_part_paths.clone(),
                    base: base.to_string(),
                }),
            )
        } else {
            (part_path_for(base, transfer_id, true), None)
        }
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
            close_sftp_quietly(&sftp).await;
        }
    }

    pub async fn sftp_download_begin(
        &self,
        id: u64,
        path: String,
    ) -> Result<SftpTransferStart, String> {
        // 新建传输时顺带回收上一次被放弃的传输，避免闲置通道累积。
        self.reap_idle_transfers(TRANSFER_IDLE_TIMEOUT).await;
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
        let transfer = Arc::new(SftpTransfer::new(
            transfer_id,
            id,
            path,
            "download",
            total,
            file,
            sftp,
            None,
        ));
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
            let n = tokio::time::timeout(DISK_CHUNK_TIMEOUT, file.read(&mut chunk[filled..]))
                .await
                .map_err(|_| "读取远程数据超时：网络不稳定，请取消后重试".to_string())?
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
        transfer.touch();
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
        // 新建传输时顺带回收上一次被放弃的传输，避免闲置通道累积。
        self.reap_idle_transfers(TRANSFER_IDLE_TIMEOUT).await;
        let path = validate_sftp_path(path)?;
        let sftp = self.open_sftp_channel(id).await?;
        // 先写半成品、收尾再 rename 到目标名：直接 `create(目标)` 会在 begin 阶段就
        // 截断既有远端文件，中途取消/空闲回收再删除它，旧内容便无副本可恢复（审计 B-1）。
        let part_path = format!("{path}{DISK_PART_SUFFIX}");
        let file = sftp
            .create(&part_path)
            .await
            .map_err(|error| format!("创建远程文件失败: {error}"))?;
        let transfer_id = self.next_transfer_id.fetch_add(1, Ordering::SeqCst);
        let transfer = Arc::new(SftpTransfer::new(
            transfer_id,
            id,
            part_path,
            "upload",
            total,
            file,
            sftp,
            Some(path),
        ));
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
        match tokio::time::timeout(DISK_CHUNK_TIMEOUT, file.write_all(&data)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(format!("写入远程文件失败: {error}")),
            Err(_) => {
                // 超时后远端写入位置不可知，禁止在同一句柄上按原偏移重试：那会把数据
                // 写到已推进的位置，产出重复字节或空洞（审计 B-13）。
                transfer.cancelled.store(true, Ordering::SeqCst);
                return Err("写入远程数据超时：传输已终止，请取消后重新上传".to_string());
            }
        }
        drop(file_guard);
        transfer
            .transferred
            .fetch_add(data.len() as u64, Ordering::SeqCst);
        transfer.touch();
        Ok(())
    }

    /// 回收长时间无进展的一次性传输。
    ///
    /// 前端若在 `begin` 之后既不拉取分片也不取消（页面重载、断网、逻辑分支遗漏），
    /// 该传输持有的 SFTP 通道会一直滞留到进程退出。返回本次回收的数量。
    pub async fn reap_idle_transfers(&self, idle: std::time::Duration) -> usize {
        let stale: Vec<Arc<SftpTransfer>> = {
            let transfers = self.sftp_transfers.lock().await;
            transfers
                .values()
                .filter(|transfer| transfer.idle_for() >= idle)
                .cloned()
                .collect()
        };
        if !stale.is_empty() {
            tracing::info!(
                count = stale.len(),
                idle_secs = idle.as_secs(),
                "回收长期无进展的 SFTP 传输"
            );
        }
        let mut reaped = 0;
        for transfer in stale {
            // 与显式取消保持一致：上传清理的是半成品 `{target}.catshell-part`（B-1 后
            // 不再是真实目标文件），下载保留半成品以便续传。
            transfer.cancelled.store(true, Ordering::SeqCst);
            self.close_transfer(&transfer, transfer.direction == "upload")
                .await;
            if self
                .sftp_transfers
                .lock()
                .await
                .remove(&transfer.id)
                .is_some()
            {
                reaped += 1;
            }
        }
        reaped
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
        // 前端漏发/少发分片时必须以失败结束，否则远端留下截断文件却被判定成功（审计 B-12）。
        let transferred = transfer.transferred.load(Ordering::SeqCst);
        if transferred != transfer.total {
            self.close_transfer(&transfer, true).await;
            return Err(format!(
                "上传数据不完整（已接收 {transferred}/{} 字节），不完整内容已清理",
                transfer.total
            ));
        }
        let file = transfer.file.lock().await.take();
        if let Some(mut file) = file {
            if let Err(error) = file.shutdown().await {
                self.close_transfer(&transfer, true).await;
                return Err(format!("完成远程文件写入失败: {error}"));
            }
        }
        let Some(final_path) = transfer.final_path.clone() else {
            self.close_transfer(&transfer, true).await;
            return Err("上传任务缺少目标路径".to_string());
        };
        let sftp = transfer.sftp.lock().await.take();
        let Some(sftp) = sftp else {
            return Ok(());
        };
        // 半成品 rename 到目标名。目标已存在且服务端不允许覆盖时，先删旧再重试——
        // 此刻半成品内容完整，删旧目标不会造成数据损失（审计 B-1/B-3）。
        let part_path = transfer.path.clone();
        if sftp.rename(&part_path, &final_path).await.is_err() {
            let _ = sftp.remove_file(&final_path).await;
            if let Err(error) = sftp.rename(&part_path, &final_path).await {
                close_sftp_quietly(&sftp).await;
                return Err(format!(
                    "保存远程文件失败: {error}（不完整内容留在 {part_path}）"
                ));
            }
        }
        close_sftp_quietly(&sftp).await;
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
        speed_limit_kbs: u64,
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
            if !parent.as_os_str().is_empty() {
                // create_dir_all 对已存在目录是 no-op；走 tokio 阻塞池避免慢盘卡 worker。
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|error| format!("创建本地目录失败: {error}"))?;
            }
        }

        let sftp = self.open_sftp_channel(id).await?;
        let metadata = with_sftp_timeout("读取远程文件信息", async {
            sftp.metadata(&remote_path)
                .await
                .map_err(|error| format!("读取远程文件信息失败: {error}"))
        })
        .await?;
        let total = metadata.size.unwrap_or(0);
        let transfer_id = self.next_disk_transfer_id.fetch_add(1, Ordering::SeqCst);
        let part_base = part_file_path(&local_path);
        let (part_path, part_claim) = self.claim_part_path(&part_base, transfer_id);
        let occupied = part_claim.is_none();

        // 源文件指纹：续传前必须与原文件完全一致，否则从 0 重传（P2-8）。
        let source_stamp = ResumeStamp {
            total,
            mtime: metadata.mtime.map(i64::from),
        };
        let mut start_offset: u64 = 0;
        let mut resumed = false;
        if resume && !occupied {
            let part_len = tokio::fs::metadata(&part_path)
                .await
                .map(|meta| meta.len())
                .unwrap_or(0);
            let recorded = read_resume_stamp(&part_path).await;
            if let Some(offset) = resume_offset(part_len, recorded.as_ref(), &source_stamp) {
                start_offset = offset;
                resumed = true;
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
            let file = tokio::fs::File::create(&part_path)
                .await
                .map_err(|error| format!("创建本地文件失败: {error}"))?;
            // 半成品与源文件指纹同时落盘，中途中断也能安全续传。
            write_resume_stamp(&part_path, &source_stamp).await;
            file
        };

        let transfer = Arc::new(SftpDiskTransfer {
            id: transfer_id,
            session_id: id,
            remote_path,
            local_path: local_path.clone(),
            part_path: part_path.clone(),
            file_name,
            direction: "download",
            total,
            transferred: AtomicU64::new(start_offset),
            cancelled: AtomicBool::new(false),
            done: AtomicBool::new(false),
            error: StdMutex::new(None),
            last_emit: AtomicU64::new(now_millis()),
            speed_limit_bps: AtomicU64::new(normalize_speed_limit_kbs(speed_limit_kbs) * 1024),
        });
        self.sftp_disk_transfers
            .lock()
            .await
            .insert(transfer_id, transfer.clone());

        tauri::async_runtime::spawn(async move {
            let started_at = std::time::Instant::now();
            let mut session_bytes: u64 = 0;
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
                        close_sftp_quietly(&sftp).await;
                        // 收尾不直接删旧文件，而是先改名为备份、rename 成功后再删：
                        // 先删再 rename 时，rename 失败会让用户原有文件永久丢失（审计 B-2）。
                        let backup_path = format!("{}.catshell-bak", transfer.local_path);
                        let had_existing = tokio::fs::metadata(&transfer.local_path).await.is_ok();
                        if had_existing {
                            let _ = tokio::fs::remove_file(&backup_path).await;
                            if let Err(error) =
                                tokio::fs::rename(&transfer.local_path, &backup_path).await
                            {
                                transfer
                                    .finish_with_error(format!("备份已有本地文件失败: {error}"));
                                emit_disk_progress(sink.as_ref(), &transfer, true);
                                break;
                            }
                        }
                        if let Err(error) =
                            tokio::fs::rename(&part_path, &transfer.local_path).await
                        {
                            // 回滚：把备份改回原名；半成品保留，供下次续传。
                            if had_existing {
                                let _ = tokio::fs::rename(&backup_path, &transfer.local_path).await;
                            }
                            transfer.finish_with_error(format!("保存本地文件失败: {error}"));
                            emit_disk_progress(sink.as_ref(), &transfer, true);
                            break;
                        }
                        if had_existing {
                            let _ = tokio::fs::remove_file(&backup_path).await;
                        }
                        clear_resume_stamp(&part_path).await;
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
                        session_bytes += n as u64;
                        emit_disk_progress(sink.as_ref(), &transfer, false);
                        pace_transfer(&transfer, started_at, session_bytes).await;
                    }
                }
            }
            manager
                .sftp_disk_transfers
                .lock()
                .await
                .remove(&transfer_id);
            // 传输结束后才归还半成品基准路径的占坑（审计 B-4）。
            drop(part_claim);
        });
        Ok(SftpDiskTransferStart {
            transfer_id,
            total,
            resumed,
            local_path,
        })
    }

    /// 磁盘级上传：本地文件在 Rust 侧读盘直接写入远端，不经前端内存。
    /// 先写远端半成品 `{target}.catshell-part`，成功后 rename 还原目标名：
    /// 断点续传只发生在半成品上，绝不会把新内容追加到无关的已存在文件里。
    pub async fn sftp_disk_upload_start(
        &self,
        manager: Arc<SshManager>,
        sink: Arc<dyn EventSink>,
        id: u64,
        local_path: String,
        remote_path: String,
        resume: bool,
        speed_limit_kbs: u64,
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
        let part_base = format!("{remote_path}{DISK_PART_SUFFIX}");
        let transfer_id = self.next_disk_transfer_id.fetch_add(1, Ordering::SeqCst);
        let (part_path, part_claim) = self.claim_part_path(&part_base, transfer_id);
        let occupied = part_claim.is_none();
        // 上传方向的指纹跟随本地源文件落盘（半成品在远端）。
        let stamp_base = format!("{local_path}{DISK_PART_SUFFIX}");
        let source_stamp = local_file_stamp(&local_path, total).await;

        let sftp = self.open_sftp_channel(id).await?;
        let mut start_offset: u64 = 0;
        let mut resumed = false;
        if resume && !occupied {
            let recorded = read_resume_stamp(&stamp_base).await;
            let part_len = match recorded {
                Some(_) => with_sftp_timeout("读取远程半成品信息", async {
                    sftp.metadata(&part_path)
                        .await
                        .map_err(|error| format!("读取远程半成品信息失败: {error}"))
                })
                .await
                .map(|meta| meta.size.unwrap_or(0))
                .unwrap_or(0),
                None => 0,
            };
            if let Some(offset) = resume_offset(part_len, recorded.as_ref(), &source_stamp) {
                start_offset = offset;
                resumed = true;
            }
        }

        let mut remote_file = if resumed {
            let mut file = sftp
                .open_with_flags(&part_path, OpenFlags::WRITE | OpenFlags::CREATE)
                .await
                .map_err(|error| format!("打开远程半成品文件失败: {error}"))?;
            file.seek(std::io::SeekFrom::Start(start_offset))
                .await
                .map_err(|error| format!("远程文件定位断点失败: {error}"))?;
            file
        } else {
            let file = sftp
                .create(&part_path)
                .await
                .map_err(|error| format!("创建远程半成品文件失败: {error}"))?;
            // 半成品与源文件指纹同时就位，中途中断也能安全续传。
            write_resume_stamp(&stamp_base, &source_stamp).await;
            file
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

        let transfer = Arc::new(SftpDiskTransfer {
            id: transfer_id,
            session_id: id,
            remote_path,
            local_path: local_path.clone(),
            part_path: part_path.clone(),
            file_name,
            direction: "upload",
            total,
            transferred: AtomicU64::new(start_offset),
            cancelled: AtomicBool::new(false),
            done: AtomicBool::new(false),
            error: StdMutex::new(None),
            last_emit: AtomicU64::new(now_millis()),
            speed_limit_bps: AtomicU64::new(normalize_speed_limit_kbs(speed_limit_kbs) * 1024),
        });
        self.sftp_disk_transfers
            .lock()
            .await
            .insert(transfer_id, transfer.clone());

        tauri::async_runtime::spawn(async move {
            let started_at = std::time::Instant::now();
            let mut session_bytes: u64 = 0;
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
                        // 半成品还原为目标名。SSH_FXP_RENAME 不允许覆盖时才删旧目标重试
                        // （先确认目标存在再删，防止误删；重试失败时半成品文件仍在，
                        //  尽力把它还原回目标名，避免「旧文件已删、新文件卡在 .part」（审计 B-3）。
                        if sftp
                            .rename(&part_path, &transfer.remote_path)
                            .await
                            .is_err()
                        {
                            let target_exists = sftp.metadata(&transfer.remote_path).await.is_ok();
                            if !target_exists {
                                transfer.finish_with_error(format!(
                                    "保存远程文件失败：无法将半成品 {} 还原为 {}（目标不存在且 rename 被拒绝）",
                                    part_path, transfer.remote_path
                                ));
                                emit_disk_progress(sink.as_ref(), &transfer, true);
                                break;
                            }
                            if let Err(error) = sftp.remove_file(&transfer.remote_path).await {
                                transfer.finish_with_error(format!(
                                    "保存远程文件失败：目标已存在且无法删除旧文件: {error}"
                                ));
                                emit_disk_progress(sink.as_ref(), &transfer, true);
                                break;
                            }
                            if let Err(error) = sftp.rename(&part_path, &transfer.remote_path).await
                            {
                                // 旧目标已删、新文件还是半成品名：再试一次把它归位。
                                let restored =
                                    sftp.rename(&part_path, &transfer.remote_path).await.is_ok();
                                transfer.finish_with_error(format!(
                                    "保存远程文件失败: {error}{}",
                                    if restored {
                                        String::new()
                                    } else {
                                        format!(
                                            "（旧目标文件已被删除，本次上传内容保留在 {}）",
                                            part_path
                                        )
                                    }
                                ));
                                emit_disk_progress(sink.as_ref(), &transfer, true);
                                break;
                            }
                        }
                        close_sftp_quietly(&sftp).await;
                        clear_resume_stamp(&stamp_base).await;
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
                                session_bytes += n as u64;
                                emit_disk_progress(sink.as_ref(), &transfer, false);
                                pace_transfer(&transfer, started_at, session_bytes).await;
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
            // 传输结束后才归还半成品基准路径的占坑（审计 B-4）。
            drop(part_claim);
        });
        Ok(SftpDiskTransferStart {
            transfer_id,
            total,
            resumed,
            local_path,
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

    /// 运行中动态调整带宽限速（KB/s，0 = 不限）。限速被调小后传输循环会在
    /// 下一个 pace 点自行放慢，无需重建传输。
    pub async fn sftp_disk_transfer_set_limit(
        &self,
        transfer_id: u64,
        speed_limit_kbs: u64,
    ) -> Result<(), String> {
        let removed = self
            .sftp_disk_transfers
            .lock()
            .await
            .get(&transfer_id)
            .cloned();
        let Some(transfer) = removed else {
            return Err("传输不存在或已结束".to_string());
        };
        transfer.speed_limit_bps.store(
            normalize_speed_limit_kbs(speed_limit_kbs) * 1024,
            Ordering::SeqCst,
        );
        Ok(())
    }

    /// 为 Rust 侧文件对话框选中的本地上传文件登记一次性令牌（webview 不接触真实路径）。
    pub async fn register_upload_tokens(
        &self,
        session_id: u64,
        files: Vec<(String, String, String)>,
    ) -> Vec<SftpDiskUploadPick> {
        let mut tokens = self.sftp_upload_path_tokens.lock().await;
        tokens.retain(|_, token| !token.expired());
        files
            .into_iter()
            .map(|(local_path, remote_path, file_name)| {
                let token = self.next_upload_token.fetch_add(1, Ordering::SeqCst);
                let pick = SftpDiskUploadPick {
                    token,
                    file_name: file_name.clone(),
                    remote_path: remote_path.clone(),
                };
                tokens.insert(
                    token,
                    UploadPathToken {
                        session_id,
                        local_path,
                        remote_path,
                        file_name,
                        created: std::time::Instant::now(),
                    },
                );
                pick
            })
            .collect()
    }

    /// 消费一次性上传令牌（绑定会话、过期即失效）。
    pub async fn consume_upload_token(
        &self,
        session_id: u64,
        token: u64,
    ) -> Result<UploadPathToken, String> {
        let mut tokens = self.sftp_upload_path_tokens.lock().await;
        let entry = tokens
            .remove(&token)
            .ok_or_else(|| "上传令牌无效或已过期，请重新选择文件".to_string())?;
        if entry.session_id != session_id {
            return Err("上传令牌与会话不匹配".to_string());
        }
        if entry.expired() {
            return Err("上传令牌无效或已过期，请重新选择文件".to_string());
        }
        Ok(entry)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reaping_idle_transfers_on_empty_manager_is_a_noop() {
        let manager = SshManager::default();
        assert_eq!(manager.reap_idle_transfers(TRANSFER_IDLE_TIMEOUT).await, 0);
        // 阈值为 0 时同样不应出错，只是没有可回收对象
        assert_eq!(
            manager.reap_idle_transfers(std::time::Duration::ZERO).await,
            0
        );
    }

    #[test]
    fn idle_timeout_is_long_enough_to_survive_a_slow_but_alive_transfer() {
        // 阈值必须明显大于单分片超时（60s），否则正常传输会被误回收
        assert!(TRANSFER_IDLE_TIMEOUT >= DISK_CHUNK_TIMEOUT * 5);
    }

    fn stamp(total: u64, mtime: Option<i64>) -> ResumeStamp {
        ResumeStamp { total, mtime }
    }

    #[test]
    fn resumes_only_when_the_source_fingerprint_matches() {
        let source = stamp(1000, Some(42));
        assert_eq!(resume_offset(400, Some(&source), &source), Some(400));
    }

    #[test]
    fn refuses_to_resume_after_the_source_file_changed() {
        let source = stamp(1000, Some(42));
        let stale = stamp(1000, Some(7));
        assert_eq!(resume_offset(400, Some(&stale), &source), None);
        // 长度也变了（源文件被替换）
        let replaced = stamp(2000, Some(99));
        assert_eq!(resume_offset(400, Some(&replaced), &source), None);
    }

    #[test]
    fn refuses_to_resume_without_a_recorded_fingerprint() {
        // 旧版本留下的半成品没有指纹文件，必须保守地从 0 重传
        let source = stamp(1000, Some(42));
        assert_eq!(resume_offset(400, None, &source), None);
    }

    #[test]
    fn refuses_to_resume_on_empty_or_oversized_partial() {
        let source = stamp(1000, Some(42));
        assert_eq!(resume_offset(0, Some(&source), &source), None);
        assert_eq!(resume_offset(1000, Some(&source), &source), None);
        assert_eq!(resume_offset(9999, Some(&source), &source), None);
    }

    #[test]
    fn concurrent_transfers_get_distinct_partial_paths() {
        let base = "/upload/report.bin.catshell-part";
        assert_eq!(part_path_for(base, 7, false), base);
        let unique = part_path_for(base, 7, true);
        assert_ne!(unique, base);
        assert!(unique.starts_with(base));
        // 另一条并发任务拿到的是另一种后缀，二者不会互相覆盖
        assert_ne!(unique, part_path_for(base, 8, true));
    }

    #[test]
    fn normalizes_speed_limit_kbs() {
        assert_eq!(normalize_speed_limit_kbs(0), 0);
        assert_eq!(normalize_speed_limit_kbs(1024), 1024);
        // 超上限截断到 1 GB/s，防止误输入出天文数字
        assert_eq!(normalize_speed_limit_kbs(u64::MAX), MAX_SPEED_LIMIT_KBS);
    }

    fn paced_transfer(limit_bps: u64) -> SftpDiskTransfer {
        SftpDiskTransfer {
            id: 1,
            session_id: 1,
            remote_path: "/r".to_string(),
            local_path: "/l".to_string(),
            part_path: "/l.catshell-part".to_string(),
            file_name: "f".to_string(),
            direction: "download",
            total: 0,
            transferred: AtomicU64::new(0),
            cancelled: AtomicBool::new(false),
            done: AtomicBool::new(false),
            error: StdMutex::new(None),
            last_emit: AtomicU64::new(0),
            speed_limit_bps: AtomicU64::new(limit_bps),
        }
    }

    #[tokio::test]
    async fn pace_returns_immediately_without_limit() {
        let transfer = paced_transfer(0);
        let started = std::time::Instant::now();
        pace_transfer(&transfer, started, u64::MAX / 2).await;
        assert!(started.elapsed() < std::time::Duration::from_millis(50));
    }

    #[tokio::test]
    async fn pace_throttles_when_ahead_of_schedule() {
        // 限速 4 KB/s，已传 6 KB：应耗 1.5 s，pace 至少等到接近该时刻。
        let transfer = paced_transfer(4 * 1024);
        let started = std::time::Instant::now();
        pace_transfer(&transfer, started, 6 * 1024).await;
        assert!(started.elapsed() >= std::time::Duration::from_millis(1400));
    }

    #[tokio::test]
    async fn pace_skips_when_behind_schedule() {
        // 限速 1 MB/s，只传了 1 KB：远未到计划时间，应立即返回。
        let transfer = paced_transfer(1024 * 1024);
        let started = std::time::Instant::now();
        pace_transfer(&transfer, started, 1024).await;
        assert!(started.elapsed() < std::time::Duration::from_millis(50));
    }

    #[test]
    fn poisoned_error_slot_does_not_abort_the_transfer() {
        let transfer = SftpDiskTransfer {
            id: 1,
            session_id: 1,
            remote_path: "/r".to_string(),
            local_path: "/l".to_string(),
            part_path: "/l.catshell-part".to_string(),
            file_name: "f".to_string(),
            direction: "download",
            total: 10,
            transferred: AtomicU64::new(0),
            cancelled: AtomicBool::new(false),
            done: AtomicBool::new(false),
            error: StdMutex::new(None),
            last_emit: AtomicU64::new(0),
            speed_limit_bps: AtomicU64::new(0),
        };
        // 模拟其他线程在持锁时 panic，导致错误槽中毒
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = transfer.error.lock().unwrap();
            panic!("poison");
        }));
        assert!(transfer.error.is_poisoned());
        // panic = "abort" 构建下这里若走 expect 会终止整个应用
        transfer.finish_with_error("boom".to_string());
        assert!(transfer.done.load(Ordering::SeqCst));
        assert_eq!(transfer.info().error.as_deref(), Some("boom"));
    }
}
