//! 日志初始化。
//!
//! release 构建使用 `windows_subsystem = "windows"`，没有控制台，因此连接失败、
//! SFTP 中断、更新报错等信息必须落盘才能事后追查；debug 构建同时输出到 stdout。
//!
//! **安全约定**：日志中绝不允许出现密码、私钥口令、OTP 密钥或私钥内容。
//! 需要记录连接信息时使用 `ConnectRequest::redacted_summary()`。

use std::path::PathBuf;

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// 默认日志级别。可通过环境变量 `CATSHELL_LOG` 覆盖（例如 `CATSHELL_LOG=debug`、
/// `CATSHELL_LOG=catshell_lib::ssh_manager=trace`）。
const DEFAULT_LEVEL: &str = "info";

/// 日志文件名（按天滚动，保留最近 7 个文件）。
const LOG_FILE_PREFIX: &str = "catshell.log";

pub struct LogGuard {
    _guard: tracing_appender::non_blocking::WorkerGuard,
}

/// 初始化全局日志订阅者。
///
/// `log_dir` 为 `None` 时只输出到 stdout（无控制台的环境下等于静默）。
/// 重复调用会被忽略，不会 panic。
pub fn init(log_dir: Option<PathBuf>) -> Option<LogGuard> {
    let filter =
        EnvFilter::try_from_env("CATSHELL_LOG").unwrap_or_else(|_| EnvFilter::new(DEFAULT_LEVEL));

    let registry = tracing_subscriber::registry().with(filter);

    // 有可写目录时落盘；release 构建下这是唯一可用的诊断途径。
    let file_writer = log_dir.and_then(|dir| {
        if let Err(error) = std::fs::create_dir_all(&dir) {
            eprintln!("无法创建日志目录 {}: {error}", dir.display());
            return None;
        }
        let appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(LOG_FILE_PREFIX)
            .max_log_files(7)
            .build(&dir)
            .ok()?;
        let (writer, guard) = tracing_appender::non_blocking(appender);
        Some((writer, guard))
    });

    let (file_layer, guard) = match file_writer {
        Some((writer, guard)) => (
            Some(
                tracing_subscriber::fmt::layer()
                    .with_writer(writer)
                    // 文件里不需要 ANSI 颜色码
                    .with_ansi(false),
            ),
            Some(guard),
        ),
        None => (None, None),
    };

    // debug 构建保留 stdout，便于 `npm run tauri dev` 时直接观察
    let stdout_layer = if cfg!(debug_assertions) {
        Some(tracing_subscriber::fmt::layer().with_ansi(true))
    } else {
        None
    };

    let installed = registry
        .with(file_layer)
        .with(stdout_layer)
        .try_init()
        .is_ok();
    if !installed {
        return None;
    }

    guard.map(|guard| LogGuard { _guard: guard })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_level_parses_as_a_valid_env_filter() {
        assert!(
            EnvFilter::try_new(DEFAULT_LEVEL).is_ok(),
            "默认日志级别必须是合法的 EnvFilter 表达式"
        );
    }
}
