use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub(super) const MAX_RECONNECT_ATTEMPTS: u32 = 3;
pub(super) const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const MANUAL_POLL_INTERVAL: Duration = Duration::from_millis(800);
pub(super) const HOST_KEY_CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

/// PTY 输出聚合窗口：积压数据最多攒这么久就发一次，避免高频小包演变成 IPC 事件风暴。
pub(super) const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// PTY 输出聚合体积上限：攒满即发，避免大输出场景下延迟被窗口时间拖长。
pub(super) const OUTPUT_FLUSH_THRESHOLD: usize = 64 * 1024;

/// 连接参数的字符串长度上限（审计 X-12）。
///
/// 这些值会原样进入 `redacted_summary()` 日志与 `session-status` 事件，无上限时
/// 超长字符串会放大 IPC/日志体积；端口 0 也只会换来一条难懂的底层报错。
pub(super) const MAX_HOST_LEN: usize = 255;
pub(super) const MAX_USERNAME_LEN: usize = 128;
pub(super) const MAX_NAME_LEN: usize = 120;
pub(super) const MAX_KEY_PATH_LEN: usize = 1024;
/// 跳板链最大深度：再深的链只会把连接流程拖长，没有任何实际用途（审计 X-12）。
pub(super) const MAX_PROXY_DEPTH: usize = 8;

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

    /// 校验单跳的必填项与长度上限（审计 R-5 / X-12）。`hop_index` 从 0 起，用于报错定位。
    pub(super) fn validate_hop(&self, hop_index: usize) -> Result<(), String> {
        let label = if hop_index == 0 {
            "跳板机".to_string()
        } else {
            format!("第 {} 跳跳板机", hop_index + 1)
        };
        if self.host.trim().is_empty() {
            return Err(format!("{label}地址不能为空"));
        }
        if self.host.chars().count() > MAX_HOST_LEN {
            return Err(format!("{label}地址过长（最多 {MAX_HOST_LEN} 个字符）"));
        }
        if self.port == 0 {
            return Err(format!("{label}端口必须在 1~65535 之间"));
        }
        if self.username.trim().is_empty() {
            return Err(format!("{label}用户名不能为空"));
        }
        if self.username.chars().count() > MAX_USERNAME_LEN {
            return Err(format!(
                "{label}用户名过长（最多 {MAX_USERNAME_LEN} 个字符）"
            ));
        }
        if let Some(path) = self.key_path.as_deref() {
            if path.chars().count() > MAX_KEY_PATH_LEN {
                return Err(format!(
                    "{label}私钥路径过长（最多 {MAX_KEY_PATH_LEN} 个字符）"
                ));
            }
        }
        Ok(())
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

    /// 连接前的统一校验：非空、长度上限、端口范围，以及**整条**跳板链的逐跳检查。
    ///
    /// 此前只校验链头（审计 R-5）：`proxy.next` 各级的空字段会一路带到 `create`，
    /// 被归类成「瞬时错误」后在 `MAX_RECONNECT_ATTEMPTS` 内反复重试并延迟报错。
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.host.trim().is_empty() {
            return Err("主机地址不能为空".to_string());
        }
        if self.host.chars().count() > MAX_HOST_LEN {
            return Err(format!("主机地址过长（最多 {MAX_HOST_LEN} 个字符）"));
        }
        if self.port == 0 {
            return Err("端口必须在 1~65535 之间".to_string());
        }
        if self.username.trim().is_empty() {
            return Err("用户名不能为空".to_string());
        }
        if self.username.chars().count() > MAX_USERNAME_LEN {
            return Err(format!("用户名过长（最多 {MAX_USERNAME_LEN} 个字符）"));
        }
        if self.name.chars().count() > MAX_NAME_LEN {
            return Err(format!("会话名称过长（最多 {MAX_NAME_LEN} 个字符）"));
        }
        if let Some(path) = self.key_path.as_deref() {
            if path.chars().count() > MAX_KEY_PATH_LEN {
                return Err(format!("私钥路径过长（最多 {MAX_KEY_PATH_LEN} 个字符）"));
            }
        }
        if let Some(mut hop) = self.proxy.as_ref() {
            let mut index = 0usize;
            loop {
                if index >= MAX_PROXY_DEPTH {
                    return Err(format!("跳板链最多支持 {MAX_PROXY_DEPTH} 跳"));
                }
                hop.validate_hop(index)?;
                match hop.next.as_deref() {
                    Some(next) => {
                        hop = next;
                        index += 1;
                    }
                    None => break,
                }
            }
        }
        Ok(())
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

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    #[ts(type = "number")]
    pub id: u64,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PartitionMetric {
    pub mount_point: String,
    #[ts(type = "number")]
    pub total_kb: u64,
    #[ts(type = "number")]
    pub used_kb: u64,
    #[ts(type = "number")]
    pub available_kb: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ServerMetrics {
    #[ts(type = "number")]
    pub session_id: u64,
    pub hostname: String,
    pub os: String,
    pub cpu_cores: u32,
    pub load_1m: f64,
    pub cpu_percent: Option<f64>,
    pub partitions: Vec<PartitionMetric>,
    #[ts(type = "number")]
    pub memory_total_kb: u64,
    #[ts(type = "number")]
    pub memory_available_kb: u64,
    #[ts(type = "number")]
    pub disk_total_kb: u64,
    #[ts(type = "number")]
    pub disk_used_kb: u64,
    #[ts(type = "number")]
    pub disk_available_kb: u64,
    #[ts(type = "number")]
    pub network_rx_bytes: u64,
    #[ts(type = "number")]
    pub network_tx_bytes: u64,
    #[ts(type = "number")]
    pub collected_at: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f64,
    pub memory_percent: f64,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiagnostic {
    #[ts(type = "number")]
    pub session_id: u64,
    pub kind: String,
    pub target: String,
    pub output: String,
    #[ts(type = "number")]
    pub collected_at: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInfo {
    #[ts(type = "number")]
    pub id: u64,
    #[ts(type = "number")]
    pub session_id: u64,
    pub direction: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub pattern: String,
    pub key_type: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostsSnapshot {
    pub path: String,
    pub entries: Vec<KnownHostEntry>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
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

    fn chained(hosts: &[&str]) -> ProxyConfig {
        let mut iter = hosts.iter().rev();
        let last = iter.next().expect("至少一跳");
        let mut chain = ProxyConfig {
            host: (*last).to_string(),
            port: 22,
            username: "ops".to_string(),
            auth_method: "password".to_string(),
            password: None,
            key_path: None,
            passphrase: None,
            next: None,
        };
        for host in iter {
            chain = ProxyConfig {
                host: (*host).to_string(),
                port: 22,
                username: "ops".to_string(),
                auth_method: "password".to_string(),
                password: None,
                key_path: None,
                passphrase: None,
                next: Some(Box::new(chain)),
            };
        }
        chain
    }

    #[test]
    fn validate_accepts_a_well_formed_request() {
        assert!(sample_request().validate().is_ok());
    }

    #[test]
    fn validate_rejects_empty_target_fields() {
        let mut request = sample_request();
        request.host = "   ".to_string();
        assert!(request.validate().is_err());

        let mut request = sample_request();
        request.username = String::new();
        assert!(request.validate().is_err());
    }

    #[test]
    fn validate_rejects_zero_port() {
        let mut request = sample_request();
        request.port = 0;
        let error = request.validate().expect_err("端口 0 必须被拒绝");
        assert!(error.contains("端口"));
    }

    #[test]
    fn validate_rejects_oversized_fields() {
        let mut request = sample_request();
        request.host = "h".repeat(MAX_HOST_LEN + 1);
        assert!(request.validate().is_err());

        let mut request = sample_request();
        request.name = "n".repeat(MAX_NAME_LEN + 1);
        assert!(request.validate().is_err());

        let mut request = sample_request();
        request.key_path = Some("k".repeat(MAX_KEY_PATH_LEN + 1));
        assert!(request.validate().is_err());
    }

    #[test]
    fn validate_checks_every_hop_not_just_the_head() {
        // 第 3 跳地址为空：此前只校验链头，空字段会一路带到连接流程（审计 R-5）。
        let mut request = sample_request();
        request.proxy = Some(chained(&["jump", "relay", "   "]));
        let error = request.validate().expect_err("内层空地址必须被拒绝");
        assert!(error.contains("第 3 跳"), "报错要能定位到具体跳数: {error}");

        // 内层端口 0 同样要被拦下。
        let mut request = sample_request();
        let mut chain = chained(&["jump", "relay"]);
        chain.next.as_mut().expect("二级存在").port = 0;
        request.proxy = Some(chain);
        assert!(request.validate().is_err());
    }

    #[test]
    fn validate_caps_proxy_chain_depth() {
        let hosts: Vec<String> = (0..MAX_PROXY_DEPTH + 1)
            .map(|index| format!("hop{index}"))
            .collect();
        let refs: Vec<&str> = hosts.iter().map(String::as_str).collect();

        let mut request = sample_request();
        request.proxy = Some(chained(&refs[..MAX_PROXY_DEPTH]));
        assert!(request.validate().is_ok(), "恰好达到上限应当放行");

        let mut request = sample_request();
        request.proxy = Some(chained(&refs));
        let error = request.validate().expect_err("超过深度上限必须被拒绝");
        assert!(error.contains("跳板链"), "错误信息应说明链长限制: {error}");
    }
}
