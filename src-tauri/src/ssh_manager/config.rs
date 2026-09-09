use std::path::{Path, PathBuf};

use super::types::{home_dir, KnownHostEntry, KnownHostsSnapshot, SshConfigEntry};

/// 与 russh-keys 默认 known_hosts 路径保持一致：Windows 为 `~\ssh\known_hosts`，其余平台为 `~/.ssh/known_hosts`。
pub fn default_known_hosts_path() -> Option<PathBuf> {
    let home = home_dir()?;
    #[cfg(target_os = "windows")]
    {
        Some(home.join("ssh").join("known_hosts"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Some(home.join(".ssh").join("known_hosts"))
    }
}

pub fn ssh_config_path() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".ssh").join("config"))
}

pub fn parse_known_hosts_line(line: &str) -> Option<KnownHostEntry> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('@') {
        return None;
    }
    let mut parts = trimmed.split_whitespace();
    let pattern = parts.next()?.to_string();
    let key_type = parts.next()?.to_string();
    let key_data = parts.next()?.to_string();
    let fingerprint = russh::keys::parse_public_key_base64(&key_data)
        .map(|key| key.fingerprint(russh::keys::HashAlg::Sha256).to_string())
        .unwrap_or_else(|_| "无法解析".to_string());
    Some(KnownHostEntry {
        pattern,
        key_type,
        fingerprint,
    })
}

pub fn parse_known_hosts(content: &str) -> Vec<KnownHostEntry> {
    content.lines().filter_map(parse_known_hosts_line).collect()
}

fn known_hosts_line_matches(line: &str, pattern: &str, key_type: &str) -> bool {
    let Some(entry) = parse_known_hosts_line(line) else {
        return false;
    };
    entry.pattern == pattern && entry.key_type == key_type
}

/// 删除指定 pattern + key_type 的 known_hosts 行，返回 (新内容, 删除行数)。
/// 注释与空行原样保留。
pub fn remove_known_hosts_entries(content: &str, pattern: &str, key_type: &str) -> (String, usize) {
    let mut removed = 0;
    let mut kept: Vec<&str> = Vec::new();
    for line in content.lines() {
        if known_hosts_line_matches(line, pattern, key_type) {
            removed += 1;
        } else {
            kept.push(line);
        }
    }
    let mut result = kept.join("\n");
    if content.ends_with('\n') && !result.is_empty() {
        result.push('\n');
    }
    (result, removed)
}

fn parse_ssh_config_value(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let (keyword, rest) = match trimmed.split_once('=') {
        Some((keyword, rest)) => (keyword.trim(), rest.trim()),
        None => {
            let mut parts = trimmed.split_whitespace();
            let keyword = parts.next()?;
            let rest = parts.next().map(|value| value.trim())?;
            (keyword, rest)
        }
    };
    if rest.is_empty() {
        return None;
    }
    let value = rest.trim_matches('"').trim_matches('\'').to_string();
    if value.is_empty() {
        return None;
    }
    Some((keyword.to_ascii_lowercase(), value))
}

pub fn parse_ssh_config(content: &str) -> Vec<SshConfigEntry> {
    let mut entries: Vec<SshConfigEntry> = Vec::new();
    let mut current: Option<(Vec<String>, SshConfigEntry)> = None;
    for line in content.lines() {
        let (keyword, value) = match parse_ssh_config_value(line) {
            Some(pair) => pair,
            None => continue,
        };
        match keyword.as_str() {
            "host" => {
                if let Some((_, entry)) = current.take() {
                    entries.push(entry);
                }
                let patterns: Vec<String> = value
                    .split_whitespace()
                    .map(|item| item.trim().to_string())
                    .filter(|item| !item.is_empty())
                    .collect();
                let address = patterns
                    .iter()
                    .find(|item| {
                        !item.contains('*') && !item.contains('?') && !item.starts_with('!')
                    })
                    .cloned();
                if let Some(address) = address {
                    current = Some((
                        patterns,
                        SshConfigEntry {
                            host: address,
                            hostname: None,
                            port: None,
                            user: None,
                            identity_file: None,
                        },
                    ));
                }
            }
            "match" => {
                if let Some((_, entry)) = current.take() {
                    entries.push(entry);
                }
            }
            _ => {
                let Some((_, entry)) = current.as_mut() else {
                    continue;
                };
                match keyword.as_str() {
                    "hostname" => entry.hostname = Some(value),
                    "port" => entry.port = value.parse::<u16>().ok().filter(|port| *port > 0),
                    "user" => entry.user = Some(value),
                    "identityfile" if entry.identity_file.is_none() => {
                        entry.identity_file = Some(expand_ssh_config_path(&value));
                    }
                    _ => {}
                }
            }
        }
    }
    if let Some((_, entry)) = current.take() {
        entries.push(entry);
    }
    entries
}

fn expand_ssh_config_path(value: &str) -> String {
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        if let Some(home) = home_dir() {
            return home
                .join(rest.replace('\\', "/"))
                .to_string_lossy()
                .to_string();
        }
    }
    if value == "~" {
        if let Some(home) = home_dir() {
            return home.to_string_lossy().to_string();
        }
    }
    value.replace(
        "%d",
        &home_dir()
            .map(|home| home.to_string_lossy().to_string())
            .unwrap_or_default(),
    )
}

pub fn load_known_hosts_snapshot(path: Option<&Path>) -> Result<KnownHostsSnapshot, String> {
    let resolved = match path {
        Some(path) => path.to_path_buf(),
        None => default_known_hosts_path().ok_or_else(|| "无法定位用户主目录".to_string())?,
    };
    if !resolved.exists() {
        return Ok(KnownHostsSnapshot {
            path: resolved.to_string_lossy().to_string(),
            entries: Vec::new(),
        });
    }
    let content = std::fs::read_to_string(&resolved)
        .map_err(|err| format!("读取 known_hosts 失败: {err}"))?;
    Ok(KnownHostsSnapshot {
        path: resolved.to_string_lossy().to_string(),
        entries: parse_known_hosts(&content),
    })
}

pub fn remove_known_hosts_entry(
    path: Option<&Path>,
    pattern: &str,
    key_type: &str,
) -> Result<usize, String> {
    let resolved = match path {
        Some(path) => path.to_path_buf(),
        None => default_known_hosts_path().ok_or_else(|| "无法定位用户主目录".to_string())?,
    };
    if !resolved.exists() {
        return Ok(0);
    }
    let content = std::fs::read_to_string(&resolved)
        .map_err(|err| format!("读取 known_hosts 失败: {err}"))?;
    let (updated, removed) = remove_known_hosts_entries(&content, pattern, key_type);
    if removed == 0 {
        return Ok(0);
    }
    let backup = resolved.with_extension("bak");
    std::fs::copy(&resolved, &backup).map_err(|err| format!("备份 known_hosts 失败: {err}"))?;
    std::fs::write(&resolved, updated).map_err(|err| format!("写入 known_hosts 失败: {err}"))?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::{parse_known_hosts, parse_ssh_config, remove_known_hosts_entries};

    #[test]
    fn parses_known_hosts_lines_and_fingerprints() {
        let entries = parse_known_hosts(
            "# comment\n\nexample.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEydX/vSYBc760zUK2vOVsFNCYy+nXi6yfhQyuWJa3AN test\n|1|abcdef=|ghijkl= ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ\nbroken\n",
        );
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].pattern, "example.com");
        assert_eq!(entries[0].key_type, "ssh-ed25519");
        assert!(entries[0].fingerprint.starts_with("SHA256:"));
        assert!(entries[1].pattern.starts_with("|1|"));
    }

    #[test]
    fn removes_known_hosts_entries_matching_pattern_and_key_type() {
        let content = "a.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEydX/vSYBc760zUK2vOVsFNCYy+nXi6yfhQyuWJa3AN\nb.example.com ssh-rsa AAAAB3NzaC1yc2EAA\na.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEydX/vSYBc760zUK2vOVsFNCYy+nXi6yfhQyuWJa3AN\n";
        let (updated, removed) =
            remove_known_hosts_entries(content, "a.example.com", "ssh-ed25519");
        assert_eq!(removed, 2);
        assert!(updated.contains("b.example.com"));
        assert!(!updated.contains("a.example.com"));
    }

    #[test]
    fn parses_ssh_config_blocks() {
        let entries = parse_ssh_config(
            "# comment\nHost web db\n  HostName web.example.com\n  Port 2222\n  User alice\n  IdentityFile ~/.ssh/id_ed25519\n\nHost *\n  Compression yes\n\nHost jump\n  Hostname = 10.0.0.1\n",
        );
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].host, "web");
        assert_eq!(entries[0].hostname.as_deref(), Some("web.example.com"));
        assert_eq!(entries[0].port, Some(2222));
        assert_eq!(entries[0].user.as_deref(), Some("alice"));
        assert!(entries[0]
            .identity_file
            .as_deref()
            .unwrap()
            .ends_with("id_ed25519"));
        assert_eq!(entries[1].host, "jump");
        assert_eq!(entries[1].hostname.as_deref(), Some("10.0.0.1"));
    }

    #[test]
    fn skips_wildcard_and_match_blocks() {
        let entries = parse_ssh_config(
            "Match host proxy\n  User bob\nHost *\n  User root\nHost real\n  User carol\n",
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "real");
        assert_eq!(entries[0].user.as_deref(), Some("carol"));
    }
}
