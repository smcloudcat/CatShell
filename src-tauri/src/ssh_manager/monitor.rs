use std::collections::HashMap;
use std::time::Duration;

use russh::{client, ChannelMsg, ChannelReadHalf};

use super::types::{NetworkDiagnostic, PartitionMetric, ProcessInfo, ServerMetrics};
use super::SshHandler;
use super::SshManager;

pub(super) const MONITOR_COMMAND: &str = r#"printf '__SSHOPS_METRICS_V1__\n'; printf 'os='; (uname -s 2>/dev/null || echo unknown); printf 'hostname='; (hostname 2>/dev/null || echo unknown); printf 'cpu_cores='; (getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0); printf 'load1='; (awk '{print $1}' /proc/loadavg 2>/dev/null || uptime 2>/dev/null | awk -F'load averages?: ' '{print $2}' | awk '{print $1}' || echo 0); printf 'cpu_percent='; (st1=$(awk 'NR==1 {print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat 2>/dev/null); sleep 0.4; st2=$(awk 'NR==1 {print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat 2>/dev/null); awk -v a="$st1" -v b="$st2" 'BEGIN{split(a,x," ");split(b,y," ");t=y[1]-x[1];i=y[2]-x[2];if(t<=0){printf "0"}else{p=(t-i)/t*100;printf "%.1f",(p<0?0:(p>100?100:p))}}' 2>/dev/null || echo 0); printf '\n'; printf 'mem_total_kb='; (awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); printf 'mem_available_kb='; (awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || awk '/^MemFree:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); printf 'disk_total_kb='; (df -Pk / 2>/dev/null | awk 'NR==2 {print $2}' || echo 0); printf 'disk_used_kb='; (df -Pk / 2>/dev/null | awk 'NR==2 {print $3}' || echo 0); printf 'disk_available_kb='; (df -Pk / 2>/dev/null | awk 'NR==2 {print $4}' || echo 0); printf 'partitions='; (df -Pk 2>/dev/null | awk 'NR>1 && $1 ~ /^\// {print $6"|"$2"|"$3"|"$4}' | awk '!seen[$1]++' | head -n 8 | tr '\n' ';' || echo); printf '\n'; printf 'network_rx_bytes='; (awk 'NR>2 && $1 !~ /^lo:/ {gsub(":", "", $1); rx += $2} END {print rx+0}' /proc/net/dev 2>/dev/null || echo 0); printf 'network_tx_bytes='; (awk 'NR>2 && $1 !~ /^lo:/ {gsub(":", "", $1); tx += $10} END {print tx+0}' /proc/net/dev 2>/dev/null || echo 0); printf '__SSHOPS_METRICS_END__\n'"#;
const PROCESS_COMMAND: &str = "ps -eo pid=,comm=,%cpu=,%mem= --sort=-%cpu 2>/dev/null | head -n 31";

fn parse_metric_u64(values: &HashMap<String, String>, key: &str) -> Result<u64, String> {
    values
        .get(key)
        .ok_or_else(|| format!("远程监控缺少指标: {key}"))?
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("远程监控指标无效: {key}"))
}

fn parse_partitions(raw: Option<&str>) -> Vec<PartitionMetric> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    raw.split(';')
        .filter_map(|entry| {
            let mut parts = entry.split('|');
            let mount_point = parts.next()?.trim().to_string();
            if mount_point.is_empty() {
                return None;
            }
            let total_kb = parts.next()?.trim().parse::<u64>().unwrap_or(0);
            let used_kb = parts.next()?.trim().parse::<u64>().unwrap_or(0);
            let available_kb = parts.next()?.trim().parse::<u64>().unwrap_or(0);
            Some(PartitionMetric {
                mount_point,
                total_kb,
                used_kb,
                available_kb,
            })
        })
        .collect()
}

pub(super) fn parse_metrics(session_id: u64, output: &[u8]) -> Result<ServerMetrics, String> {
    let text = String::from_utf8_lossy(output);
    let start = text
        .find("__SSHOPS_METRICS_V1__")
        .ok_or_else(|| "远程主机不支持监控采集协议".to_string())?;
    let end = text[start..]
        .find("__SSHOPS_METRICS_END__")
        .ok_or_else(|| "远程监控采集未正常结束".to_string())?
        + start;
    let mut values = HashMap::new();
    for line in text[start..end].lines().skip(1) {
        if let Some((key, value)) = line.split_once('=') {
            values.insert(key.to_string(), value.trim().to_string());
        }
    }
    let load_1m = values
        .get("load1")
        .ok_or_else(|| "远程监控缺少指标: load1".to_string())?
        .parse::<f64>()
        .map_err(|_| "远程监控指标无效: load1".to_string())?;
    let hostname = values
        .get("hostname")
        .cloned()
        .unwrap_or_else(|| "unknown".to_string());
    let os = values
        .get("os")
        .cloned()
        .unwrap_or_else(|| "unknown".to_string());
    let cpu_percent = values
        .get("cpu_percent")
        .and_then(|value| value.trim().parse::<f64>().ok())
        .map(|percent| percent.clamp(0.0, 100.0));
    let partitions = parse_partitions(values.get("partitions").map(String::as_str));
    Ok(ServerMetrics {
        session_id,
        hostname,
        os,
        cpu_cores: parse_metric_u64(&values, "cpu_cores")?.clamp(1, u32::MAX as u64) as u32,
        load_1m,
        cpu_percent,
        partitions,
        memory_total_kb: parse_metric_u64(&values, "mem_total_kb")?,
        memory_available_kb: parse_metric_u64(&values, "mem_available_kb")?,
        disk_total_kb: parse_metric_u64(&values, "disk_total_kb")?,
        disk_used_kb: parse_metric_u64(&values, "disk_used_kb")?,
        disk_available_kb: parse_metric_u64(&values, "disk_available_kb")?,
        network_rx_bytes: parse_metric_u64(&values, "network_rx_bytes")?,
        network_tx_bytes: parse_metric_u64(&values, "network_tx_bytes")?,
        collected_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default(),
    })
}

async fn read_exec_output(mut read: ChannelReadHalf) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    while let Some(message) = read.wait().await {
        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                output.extend_from_slice(&data);
                if output.len() > 256 * 1024 {
                    return Err("远程监控输出超过限制".to_string());
                }
            }
            ChannelMsg::Close => break,
            ChannelMsg::Eof => break,
            _ => {}
        }
    }
    Ok(output)
}

pub(super) async fn exec_command(
    connection: &mut client::Handle<SshHandler>,
    command: &str,
) -> Result<Vec<u8>, String> {
    let channel = connection
        .channel_open_session()
        .await
        .map_err(|error| format!("打开远程命令通道失败: {error}"))?;
    channel
        .exec(false, command)
        .await
        .map_err(|error| format!("执行远程命令失败: {error}"))?;
    let (read, _write) = channel.split();
    tokio::time::timeout(Duration::from_secs(8), read_exec_output(read))
        .await
        .map_err(|_| "远程命令执行超时".to_string())?
}

fn parse_processes(output: &[u8]) -> Vec<ProcessInfo> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let name = fields.next()?.to_string();
            let cpu_percent = fields.next()?.parse().ok()?;
            let memory_percent = fields.next()?.parse().ok()?;
            Some(ProcessInfo {
                pid,
                name,
                cpu_percent,
                memory_percent,
            })
        })
        .collect()
}

pub(super) fn validate_network_target(target: &str) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty()
        || target.starts_with('-')
        || target.len() > 253
        || !target.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']' | b'_')
        })
    {
        return Err("网络诊断目标无效".to_string());
    }
    Ok(target.to_string())
}

fn now_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

impl SshManager {
    pub async fn monitor(&self, id: u64) -> Result<ServerMetrics, String> {
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        let channel = connection
            .channel_open_session()
            .await
            .map_err(|error| format!("打开监控通道失败: {error}"))?;
        channel
            .exec(false, MONITOR_COMMAND)
            .await
            .map_err(|error| format!("执行监控命令失败: {error}"))?;
        let (read, _write) = channel.split();
        let output = tokio::time::timeout(Duration::from_secs(8), read_exec_output(read))
            .await
            .map_err(|_| "远程监控采集超时".to_string())??;
        parse_metrics(id, &output)
    }

    /// RTT 探测：执行空命令并测量整个 SSH 往返耗时（毫秒）。
    pub async fn ping(&self, id: u64) -> Result<u64, String> {
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        let started = std::time::Instant::now();
        let mut channel = connection
            .channel_open_session()
            .await
            .map_err(|error| format!("打开探测通道失败: {error}"))?;
        channel
            .exec(true, ":")
            .await
            .map_err(|error| format!("执行探测命令失败: {error}"))?;
        // 整体限时，避免无响应服务器让通道排水循环永久持有连接锁
        let drain = async {
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Close | ChannelMsg::Eof => break,
                    _ => {}
                }
            }
        };
        match tokio::time::timeout(std::time::Duration::from_secs(10), drain).await {
            Ok(()) => Ok(started.elapsed().as_millis() as u64),
            Err(_) => Err("RTT 探测超时：服务器未在 10 秒内响应".to_string()),
        }
    }

    pub async fn list_processes(&self, id: u64) -> Result<Vec<ProcessInfo>, String> {
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        Ok(parse_processes(
            &exec_command(connection, PROCESS_COMMAND).await?,
        ))
    }

    pub async fn kill_process(&self, id: u64, pid: u32, signal: &str) -> Result<(), String> {
        if pid == 0 || pid > 4_194_304 {
            return Err("进程号无效".to_string());
        }
        let signal = match signal.to_ascii_uppercase().as_str() {
            "TERM" => "TERM",
            "KILL" => "KILL",
            _ => return Err("不支持的终止信号，仅允许 TERM 或 KILL".to_string()),
        };
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        let command = format!("kill -{signal} {pid}");
        exec_command(connection, &command).await.map(|_| ())
    }

    pub async fn network_diagnostic(
        &self,
        id: u64,
        kind: String,
        target: String,
    ) -> Result<NetworkDiagnostic, String> {
        let kind = kind.trim().to_ascii_lowercase();
        if kind != "ping" && kind != "trace" {
            return Err("不支持的网络诊断类型".to_string());
        }
        let target = validate_network_target(&target)?;
        let command = if kind == "ping" {
            format!("ping -c 4 -W 2 -- {target} 2>&1")
        } else {
            format!("(tracepath -m 12 -w 2 {target} || traceroute -m 12 -w 2 {target} || ping -c 1 -W 2 {target}) 2>&1")
        };
        let session = self.session_ref(id).await?;
        let mut connection = session.conn.lock().await;
        let connection = connection
            .as_mut()
            .ok_or_else(|| "会话尚未连接".to_string())?;
        let output = exec_command(connection, &command).await?;
        Ok(NetworkDiagnostic {
            session_id: id,
            kind,
            target,
            output: String::from_utf8_lossy(&output).trim().to_string(),
            collected_at: now_unix_seconds(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_metrics, parse_processes, validate_network_target};

    #[test]
    fn parses_metrics_payload() {
        let payload = b"noise\n__SSHOPS_METRICS_V1__\nos=Linux\nhostname=node-1\ncpu_cores=4\nload1=0.42\nmem_total_kb=8000\nmem_available_kb=3000\ndisk_total_kb=100000\ndisk_used_kb=25000\ndisk_available_kb=75000\nnetwork_rx_bytes=1234\nnetwork_tx_bytes=5678\n__SSHOPS_METRICS_END__\n";
        let metrics = parse_metrics(7, payload).expect("metrics should parse");
        assert_eq!(metrics.session_id, 7);
        assert_eq!(metrics.hostname, "node-1");
        assert_eq!(metrics.cpu_cores, 4);
        assert!((metrics.load_1m - 0.42).abs() < f64::EPSILON);
        assert_eq!(metrics.disk_used_kb, 25_000);
    }

    #[test]
    fn rejects_incomplete_metrics_payload() {
        let error = parse_metrics(7, b"__SSHOPS_METRICS_V1__\nos=Linux\n")
            .expect_err("incomplete payload must fail");
        assert!(error.contains("未正常结束"));
    }

    #[test]
    fn parses_process_table_and_ignores_invalid_rows() {
        let processes = parse_processes(b" 12 sshd 1.5 0.2\ninvalid\n13 nginx 0.0 1.1\n");
        assert_eq!(processes.len(), 2);
        assert_eq!(processes[0].pid, 12);
        assert_eq!(processes[1].name, "nginx");
    }

    #[test]
    fn parses_metrics_partitions_and_cpu_percent() {
        let payload = b"__SSHOPS_METRICS_V1__\nos=Linux\nhostname=node-1\ncpu_cores=4\nload1=0.42\ncpu_percent=37.5\nmem_total_kb=8000\nmem_available_kb=3000\ndisk_total_kb=100000\ndisk_used_kb=25000\ndisk_available_kb=75000\npartitions=/|100000|25000|75000;/data|500000|100000|400000;/boot/efi|1024|2|1022;\nnetwork_rx_bytes=1\nnetwork_tx_bytes=1\n__SSHOPS_METRICS_END__\n";
        let metrics = parse_metrics(7, payload).expect("metrics should parse");
        assert_eq!(metrics.cpu_percent, Some(37.5));
        assert_eq!(metrics.partitions.len(), 3);
        assert_eq!(metrics.partitions[0].mount_point, "/");
        assert_eq!(metrics.partitions[0].used_kb, 25_000);
        assert_eq!(metrics.partitions[1].mount_point, "/data");
        assert_eq!(metrics.partitions[2].total_kb, 1024);
    }

    #[test]
    fn tolerates_missing_partitions_and_cpu_percent() {
        let payload = b"__SSHOPS_METRICS_V1__\nos=Linux\nhostname=node-1\ncpu_cores=2\nload1=0.10\nmem_total_kb=1000\nmem_available_kb=500\ndisk_total_kb=1000\ndisk_used_kb=100\ndisk_available_kb=900\nnetwork_rx_bytes=1\nnetwork_tx_bytes=1\n__SSHOPS_METRICS_END__\n";
        let metrics = parse_metrics(7, payload).expect("metrics should parse");
        assert_eq!(metrics.cpu_percent, None);
        assert!(metrics.partitions.is_empty());
    }

    #[test]
    fn rejects_network_command_injection_targets() {
        assert_eq!(
            validate_network_target("example.internal").unwrap(),
            "example.internal"
        );
        assert!(validate_network_target("example.internal;id").is_err());
        assert!(validate_network_target("-n").is_err());
    }
}
