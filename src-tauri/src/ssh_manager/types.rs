use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub(super) const MAX_RECONNECT_ATTEMPTS: u32 = 3;
pub(super) const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const MANUAL_POLL_INTERVAL: Duration = Duration::from_millis(800);
pub(super) const HOST_KEY_CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub otp_secret: Option<String>,
    #[serde(default = "default_keepalive")]
    pub keepalive: u64,
    #[serde(default)]
    pub auto_reconnect: bool,
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
}

fn default_keepalive() -> u64 {
    30
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: u64,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionMetric {
    pub mount_point: String,
    pub total_kb: u64,
    pub used_kb: u64,
    pub available_kb: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMetrics {
    pub session_id: u64,
    pub hostname: String,
    pub os: String,
    pub cpu_cores: u32,
    pub load_1m: f64,
    pub cpu_percent: Option<f64>,
    pub partitions: Vec<PartitionMetric>,
    pub memory_total_kb: u64,
    pub memory_available_kb: u64,
    pub disk_total_kb: u64,
    pub disk_used_kb: u64,
    pub disk_available_kb: u64,
    pub network_rx_bytes: u64,
    pub network_tx_bytes: u64,
    pub collected_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f64,
    pub memory_percent: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiagnostic {
    pub session_id: u64,
    pub kind: String,
    pub target: String,
    pub output: String,
    pub collected_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInfo {
    pub id: u64,
    pub session_id: u64,
    pub direction: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub pattern: String,
    pub key_type: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostsSnapshot {
    pub path: String,
    pub entries: Vec<KnownHostEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigEntry {
    pub host: String,
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
}

pub(super) fn reconnect_delay(attempt: u32) -> Duration {
    match attempt {
        1 => Duration::from_secs(2),
        2 => Duration::from_secs(5),
        _ => Duration::from_secs(10),
    }
}

pub(super) fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE")
            .filter(|value| !value.is_empty())
            .or_else(|| std::env::var_os("HOME").filter(|value| !value.is_empty()))
            .map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
            .map(PathBuf::from)
    }
}
