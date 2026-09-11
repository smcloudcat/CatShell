//! 命令行启动参数解析（6.16）：`catshell user@host[:port]` 直连临时目标，
//! `catshell <主机档案名>`（或 `--profile <名>`）直连已保存档案。
//!
//! 解析是纯函数，连接动作完全由前端完成（凭据在保险箱里，Rust 不经手）；
//! Rust 只负责把意图送达窗口（首启动命令 / second-instance 事件）。

use serde::Serialize;
use ts_rs::TS;

/// 启动参数解析出的连接意图。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CliConnectPayload {
    /// `adhoc` = 临时目标（`user@host[:port]`）；`profile` = 主机档案名。
    pub kind: String,
    /// `adhoc` 时的登录用户（`user@host` 里 `@` 前的部分，可省略）。
    pub user: Option<String>,
    /// `adhoc` 时的目标地址。
    pub host: Option<String>,
    /// `adhoc` 时的端口（`host:port` 里可省略，默认 22 由前端处理）。
    pub port: Option<u16>,
    /// `profile` 时的档案名。
    pub name: Option<String>,
}

fn profile_payload(name: &str) -> Option<CliConnectPayload> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some(CliConnectPayload {
        kind: "profile".to_string(),
        user: None,
        host: None,
        port: None,
        name: Some(name.to_string()),
    })
}

fn adhoc_payload(target: &str) -> Option<CliConnectPayload> {
    let target = target.trim();
    let (user, rest) = match target.split_once('@') {
        Some((user, rest)) if !user.trim().is_empty() && !rest.trim().is_empty() => {
            (Some(user.trim().to_string()), rest.trim())
        }
        Some(_) => return None,
        None => (None, target),
    };
    // `host:port`：按最后一个冒号拆，端口必须是纯数字（兼容 host 是域名 / IPv4；
    // 裸 IPv6 字面量冒号歧义，v1 不支持，请改用 --profile 档案方式）。
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => match port.parse::<u16>() {
            Ok(port) if port > 0 => (host, Some(port)),
            _ => return None,
        },
        _ => (rest, None),
    };
    if host.is_empty() {
        return None;
    }
    Some(CliConnectPayload {
        kind: "adhoc".to_string(),
        user,
        host: Some(host.to_string()),
        port,
        name: None,
    })
}

/// 解析启动参数为连接意图；没有连接意图时返回 `None`。
///
/// 规则：
/// - `--profile <名>` / `--connect <名>` / `--profile=<名>`：按档案名直连；
/// - 第一个不含 `@` 的位置参数：视为档案名；
/// - 含 `@` 的位置参数：视为 `user@host[:port]` 临时目标；
/// - 其余 `-` 开关（Tauri / webview 内部 flag）忽略。
pub fn parse_cli_connect(args: &[String]) -> Option<CliConnectPayload> {
    let mut positional: Vec<&str> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--profile" || arg == "--connect" {
            let name = args.get(index + 1)?;
            if name.starts_with('-') {
                return None;
            }
            return profile_payload(name);
        }
        if let Some(name) = arg
            .strip_prefix("--profile=")
            .or_else(|| arg.strip_prefix("--connect="))
        {
            return profile_payload(name);
        }
        if !arg.starts_with('-') {
            positional.push(arg);
        }
        index += 1;
    }
    let target = positional.first()?;
    if target.contains('@') {
        adhoc_payload(target)
    } else {
        profile_payload(target)
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_cli_connect, CliConnectPayload};

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn adhoc(user: Option<&str>, host: &str, port: Option<u16>) -> CliConnectPayload {
        CliConnectPayload {
            kind: "adhoc".to_string(),
            user: user.map(|s| s.to_string()),
            host: Some(host.to_string()),
            port,
            name: None,
        }
    }

    fn profile(name: &str) -> CliConnectPayload {
        CliConnectPayload {
            kind: "profile".to_string(),
            user: None,
            host: None,
            port: None,
            name: Some(name.to_string()),
        }
    }

    #[test]
    fn no_args_means_no_intent() {
        assert_eq!(parse_cli_connect(&args(&[])), None);
        assert_eq!(parse_cli_connect(&args(&["--flag-only"])), None);
    }

    #[test]
    fn parses_user_host_and_port() {
        assert_eq!(
            parse_cli_connect(&args(&["root@web.example.com"])),
            Some(adhoc(Some("root"), "web.example.com", None))
        );
        assert_eq!(
            parse_cli_connect(&args(&["root@web.example.com:2222"])),
            Some(adhoc(Some("root"), "web.example.com", Some(2222)))
        );
        assert_eq!(
            parse_cli_connect(&args(&["web.example.com"])).unwrap().kind,
            "profile"
        );
    }

    #[test]
    fn bare_host_is_treated_as_profile_name() {
        // 不含 @ 的目标可能是档案名；解析为 profile 交给前端按名匹配。
        assert_eq!(
            parse_cli_connect(&args(&["prod-web"])),
            Some(profile("prod-web"))
        );
    }

    #[test]
    fn malformed_adhoc_targets_are_rejected() {
        assert_eq!(parse_cli_connect(&args(&["@hostonly"])), None, "缺用户名");
        assert_eq!(parse_cli_connect(&args(&["root@"])), None, "缺主机名");
        assert_eq!(
            parse_cli_connect(&args(&["root@host:notaport"])),
            None,
            "端口段非法"
        );
        assert_eq!(
            parse_cli_connect(&args(&["root@host:"])),
            None,
            "端口段为空"
        );
        assert_eq!(
            parse_cli_connect(&args(&["root@host:0"])),
            None,
            "端口 0 非法"
        );
    }

    #[test]
    fn profile_flag_wins_over_positional() {
        assert_eq!(
            parse_cli_connect(&args(&["--profile", "prod", "extra@x"])),
            Some(profile("prod"))
        );
        assert_eq!(
            parse_cli_connect(&args(&["--connect=staging"])),
            Some(profile("staging"))
        );
        assert_eq!(
            parse_cli_connect(&args(&["--profile"])),
            None,
            "缺值即无意图"
        );
        assert_eq!(
            parse_cli_connect(&args(&["--profile", "--next-flag"])),
            None
        );
    }
}
