use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub(super) const MAX_RECONNECT_ATTEMPTS: u32 = 3;
pub(super) const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const MANUAL_POLL_INTERVAL: Duration = Duration::from_millis(800);
pub(super) const HOST_KEY_CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

/// PTY 输出聚合窗口：积压数据最多攒这么久就发一次，避免高频小包演变成 IPC 事件风暴。
pub(super) const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// PTY 输出聚合体积上限：攒满即发，避免大输出场景下延迟被窗口时间拖长。
pub(super) const OUTPUT_FLUSH_THRESHOLD: usize = 64 * 1024;

/// 跳板机连接参数（含明文凭据）。
///
/// 刻意**不**实现 `Debug` / `Serialize`：一次不慎的 `{:?}` 日志或序列化就会把口令写出去。
/// 需要记录日志时走 `ConnectRequest::redacted_summary`。
///
/// 多跳：`next` 指向下一级跳板，链式嵌套（ProxyJump 链）。连接顺序为
/// 链头 → 链尾 → 目标，即每一跳都经由前面所有跳板到达。`next` 缺省为
/// `None`（单级跳板），旧数据无需迁移。
#[derive(Clone, Deserialize)]
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
    #[serde(default)]
    pub next: Option<Box<ProxyConfig>>,
}

impl ProxyConfig {
    /// 收集整条跳板链（含自身），按连接顺序返回：链头在前，链尾在后。
    pub fn collect_chain(&self) -> Vec<&ProxyConfig> {
        let mut hops = Vec::new();
        let mut cursor: Option<&ProxyConfig> = Some(self);
        while let Some(hop) = cursor {
            hops.push(hop);
            cursor = hop.next.as_deref();
        }
        hops
    }
}

impl Drop for ProxyConfig {
    fn drop(&mut self) {
        zeroize_secret(&mut self.password);
        zeroize_secret(&mut self.passphrase);
    }
}

/// 建立连接所需的完整参数，其中包含明文凭据。
///
/// 安全约定：
/// - **不**派生 `Debug` / `Serialize`，从类型层面堵住「顺手打印/序列化凭据」的路径；
/// - 实现 `Drop`，在会话结束、重连换凭据等时点把明文覆盖掉，缩短内存驻留窗口；
/// - 需要输出诊断信息时使用 `redacted_summary()`。
#[derive(Clone, Deserialize)]
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

impl ConnectRequest {
    /// 可用于日志的安全摘要：只包含连接目标与认证方式，绝不含凭据本身。
    pub fn redacted_summary(&self) -> String {
        format!(
            "{}@{}:{} auth={} keepalive={} autoReconnect={} proxy={}",
            self.username,
            self.host,
            self.port,
            self.auth_method,
            self.keepalive,
            self.auto_reconnect,
            match &self.proxy {
                Some(proxy) => format!("{}@{}:{}", proxy.username, proxy.host, proxy.port),
                None => "none".to_string(),
            }
        )
    }
}

impl Drop for ConnectRequest {
    fn drop(&mut self) {
        zeroize_secret(&mut self.password);
        zeroize_secret(&mut self.passphrase);
        zeroize_secret(&mut self.otp_secret);
    }
}

/// 就地零化一个可选口令：覆盖底层字节缓冲后清空长度，避免明文留在已释放的堆内存里。
fn zeroize_secret(secret: &mut Option<String>) {
    use zeroize::Zeroize;
    if let Some(value) = secret.as_mut() {
        value.zeroize();
    }
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

/// known_hosts 校验结果对应的处置动作。
#[derive(Debug, PartialEq, Eq)]
pub(super) enum HostKeyVerdict {
    /// 指纹已记录且完全匹配，可直接连接。
    Trusted,
    /// 指纹已记录但与对端不一致：存在中间人风险，必须阻断连接。
    Changed(String),
    /// 首次见到该主机，需要用户人工确认指纹。
    Unknown,
}

/// 把 known_hosts 查询结果映射为处置动作。
///
/// `Err` 代表「已记录密钥与对端不一致」——这是 MITM 的典型特征，
/// 只能拒绝连接，绝不能退化成「让用户确认一下就放行」。
pub(super) fn classify_known_host(result: Result<bool, String>) -> HostKeyVerdict {
    match result {
        Ok(true) => HostKeyVerdict::Trusted,
        Ok(false) => HostKeyVerdict::Unknown,
        Err(reason) => HostKeyVerdict::Changed(reason),
    }
}

/// 推进一次重连计数，返回下一次尝试的序号；返回 `None` 表示重连预算已用尽。
///
/// 重连计数只允许通过本函数推进。此前重连循环里存在「同一轮内两次 `attempt += 1`」，
/// 导致退避档位被跳过、实际重试次数少于 `MAX_RECONNECT_ATTEMPTS`。集中到单一入口后，
/// 这类重复自增在结构上不再可能发生。
pub(super) fn advance_reconnect_attempt(attempt: u32) -> Option<u32> {
    if attempt >= MAX_RECONNECT_ATTEMPTS {
        None
    } else {
        Some(attempt + 1)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_budget_allows_exactly_max_attempts() {
        let mut attempt = 0;
        let mut steps = Vec::new();
        while let Some(next) = advance_reconnect_attempt(attempt) {
            attempt = next;
            steps.push(attempt);
        }
        assert_eq!(
            steps,
            vec![1, 2, 3],
            "重连预算应恰好提供 {MAX_RECONNECT_ATTEMPTS} 次重试"
        );
        assert_eq!(attempt, MAX_RECONNECT_ATTEMPTS);
    }

    #[test]
    fn reconnect_budget_is_exhausted_after_max_attempts() {
        assert_eq!(advance_reconnect_attempt(0), Some(1));
        assert_eq!(advance_reconnect_attempt(2), Some(3));
        assert_eq!(advance_reconnect_attempt(MAX_RECONNECT_ATTEMPTS), None);
        assert_eq!(advance_reconnect_attempt(MAX_RECONNECT_ATTEMPTS + 5), None);
    }

    #[test]
    fn reconnect_delay_backs_off_per_attempt_tier() {
        assert_eq!(reconnect_delay(1), Duration::from_secs(2));
        assert_eq!(reconnect_delay(2), Duration::from_secs(5));
        assert_eq!(reconnect_delay(3), Duration::from_secs(10));
        assert_eq!(reconnect_delay(9), Duration::from_secs(10));
    }

    #[test]
    fn recorded_matching_key_is_trusted() {
        assert_eq!(classify_known_host(Ok(true)), HostKeyVerdict::Trusted);
    }

    #[test]
    fn unrecorded_host_requires_user_confirmation() {
        assert_eq!(classify_known_host(Ok(false)), HostKeyVerdict::Unknown);
    }

    #[test]
    fn changed_key_is_blocked_and_never_downgraded_to_a_prompt() {
        let verdict = classify_known_host(Err("key mismatch".to_string()));
        match verdict {
            HostKeyVerdict::Changed(reason) => assert!(reason.contains("key mismatch")),
            other => panic!("密钥变更必须判为 Changed（阻断连接），实际: {other:?}"),
        }
    }

    #[test]
    fn changed_key_is_distinct_from_unknown_host() {
        // 二者必须保持可区分：Unknown 允许人工确认后放行，Changed 只能拒绝。
        assert_ne!(
            classify_known_host(Err("boom".to_string())),
            HostKeyVerdict::Unknown
        );
    }

    fn sample_request() -> ConnectRequest {
        ConnectRequest {
            name: "prod".to_string(),
            host: "10.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_method: "password".to_string(),
            password: Some("ZZ_SECRET_PASSWORD_ZZ".to_string()),
            key_path: None,
            passphrase: Some("ZZ_SECRET_PASSPHRASE_ZZ".to_string()),
            otp_secret: Some("ZZ_SECRET_OTP_ZZ".to_string()),
            keepalive: 30,
            auto_reconnect: true,
            proxy: Some(ProxyConfig {
                host: "jump".to_string(),
                port: 2222,
                username: "ops".to_string(),
                auth_method: "password".to_string(),
                password: Some("ZZ_SECRET_PROXY_PW_ZZ".to_string()),
                key_path: None,
                passphrase: Some("ZZ_SECRET_PROXY_PP_ZZ".to_string()),
                next: None,
            }),
        }
    }

    #[test]
    fn redacted_summary_describes_the_target_without_leaking_credentials() {
        let summary = sample_request().redacted_summary();
        for secret in [
            "ZZ_SECRET_PASSWORD_ZZ",
            "ZZ_SECRET_PASSPHRASE_ZZ",
            "ZZ_SECRET_OTP_ZZ",
            "ZZ_SECRET_PROXY_PW_ZZ",
            "ZZ_SECRET_PROXY_PP_ZZ",
        ] {
            assert!(
                !summary.contains(secret),
                "日志摘要泄漏了凭据 {secret}: {summary}"
            );
        }
        assert!(summary.contains("root@10.0.0.1:22"));
        assert!(summary.contains("auth=password"));
        assert!(summary.contains("ops@jump:2222"));
    }

    #[test]
    fn redacted_summary_reports_absent_proxy_explicitly() {
        let mut request = sample_request();
        request.proxy = None;
        assert!(request.redacted_summary().contains("proxy=none"));
    }

    #[test]
    fn collect_chain_returns_hops_in_connection_order() {
        let request = sample_request();
        let proxy = request.proxy.as_ref().expect("sample 含单级跳板");
        let chain = proxy.collect_chain();
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].host, "jump");

        // 二级链：jump -> relay -> 目标。连接顺序必须是链头在前。
        let mut relay = proxy.clone();
        relay.next = Some(Box::new(ProxyConfig {
            host: "relay".to_string(),
            port: 2200,
            username: "inner".to_string(),
            auth_method: "key".to_string(),
            password: None,
            key_path: Some("/tmp/id_ed25519".to_string()),
            passphrase: None,
            next: None,
        }));
        let chain = relay.collect_chain();
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0].host, "jump");
        assert_eq!(chain[1].host, "relay");
        assert_eq!(chain[1].port, 2200);
    }

    #[test]
    fn deserializes_chained_proxy_from_camel_case_json() {
        let json = serde_json::json!({
            "name": "prod",
            "host": "10.0.0.1",
            "port": 22,
            "username": "root",
            "authMethod": "password",
            "password": "pw",
            "keepalive": 30,
            "autoReconnect": true,
            "proxy": {
                "host": "jump",
                "port": 2222,
                "username": "ops",
                "authMethod": "password",
                "password": "jump-pw",
                "next": {
                    "host": "relay",
                    "port": 2200,
                    "username": "inner",
                    "authMethod": "key",
                    "keyPath": "/tmp/id_ed25519"
                }
            }
        });
        let request: ConnectRequest = serde_json::from_value(json).expect("camelCase 反序列化");
        let proxy = request.proxy.as_ref().expect("跳板链存在");
        let chain = proxy.collect_chain();
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0].host, "jump");
        assert_eq!(chain[1].host, "relay");
        assert_eq!(chain[1].auth_method, "key");
    }

    #[test]
    fn zeroize_secret_clears_the_stored_value() {
        let mut secret = Some("ZZ_SECRET_ZZ".to_string());
        zeroize_secret(&mut secret);
        assert_eq!(secret.as_deref(), Some(""));
    }

    #[test]
    fn zeroize_secret_tolerates_absent_values() {
        let mut secret: Option<String> = None;
        zeroize_secret(&mut secret);
        assert!(secret.is_none());
    }
}
