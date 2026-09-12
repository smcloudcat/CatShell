use ts_rs::TS;

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

/// 主机档案写回 `~/.ssh/config` 的草稿（不含任何凭据，私钥只写路径）。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostConfigDraft {
    /// Host 模式（即主机档案名称）。
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub user: String,
    /// 私钥路径；仅当连接方式为密钥认证时提供。
    pub identity_file: Option<String>,
}

/// 渲染一个 Host 块（不含尾部空行，块与块之间靠换行自然分隔）。
pub fn build_host_block(draft: &HostConfigDraft) -> String {
    let mut block = format!(
        "Host {}\n  HostName {}\n  Port {}\n",
        draft.name, draft.hostname, draft.port
    );
    if !draft.user.trim().is_empty() {
        block.push_str(&format!("  User {}\n", draft.user.trim()));
    }
    if let Some(identity) = draft
        .identity_file
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        block.push_str(&format!("  IdentityFile {}\n", identity.trim()));
    }
    block
}

/// 删除 `Host` 模式与给定名单（小写比较，OpenSSH 大小写不敏感）匹配的整块内容。
/// `Match` 块与其后归属不清的内容一律保留。返回 (新内容, 删除块数)。
pub fn remove_host_blocks(content: &str, names_lower: &[String]) -> (String, usize) {
    let mut removed = 0;
    let mut kept: Vec<&str> = Vec::new();
    // 当前块是否命中名单；块从 `Host` 行开始，到下一个 `Host` / `Match` 行或文末结束。
    let mut in_removed_block = false;
    for line in content.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("host ") || lower == "host" {
            let patterns: Vec<String> = trimmed[4..]
                .split_whitespace()
                .map(|pattern| pattern.trim_matches('"').to_ascii_lowercase())
                .collect();
            in_removed_block = patterns.iter().any(|pattern| names_lower.contains(pattern));
            if in_removed_block {
                removed += 1;
            } else {
                kept.push(line);
            }
            continue;
        }
        if lower.starts_with("match") {
            in_removed_block = false;
            kept.push(line);
            continue;
        }
        if !in_removed_block {
            kept.push(line);
        }
    }
    let mut result = kept.join("\n");
    if !result.is_empty() {
        result.push('\n');
    }
    (result, removed)
}

/// 按名单替换 + 追加主机块：已有同名 Host 块先移除（连同其选项行），再把全部草稿追加到文末。
/// 返回 (新内容, 被替换块数)。
pub fn upsert_host_blocks(content: &str, drafts: &[HostConfigDraft]) -> (String, usize) {
    let names: Vec<String> = drafts
        .iter()
        .map(|draft| draft.name.trim().to_ascii_lowercase())
        .collect();
    let (kept, removed) = remove_host_blocks(content, &names);
    let mut result = kept;
    for draft in drafts {
        result.push_str(&build_host_block(draft));
        result.push('\n');
    }
    (result, removed)
}

/// SSH config 字段必须是**不含控制字符的单行文本**。
///
/// `Host` 模式、`HostName`、`User`、`IdentityFile` 都会被原样拼进 `~/.ssh/config`，
/// 一旦含 `\n` / `\t` 就能注入新的指令行（例如 `Host *\n  ProxyCommand ...`），
/// 把「写回主机配置」升级为任意命令执行。主机档案可以从不可信文件导入，因此
/// 这里必须显式拒绝（审计 S-1）。
fn assert_plain_config_value(label: &str, value: &str) -> Result<(), String> {
    if value.chars().any(char::is_control) {
        return Err(format!(
            "{label}包含非法字符（不允许换行、制表符等控制字符）"
        ));
    }
    Ok(())
}

/// 把主机草稿写回 `~/.ssh/config`：先备份到 `.catshell-bak`，经 `.tmp` 临时文件
/// 原子替换（避免写一半崩溃留下残缺配置）。返回 (替换块数, 写入块数)。
pub fn write_ssh_config(drafts: &[HostConfigDraft]) -> Result<(usize, usize), String> {
    let path = ssh_config_path().ok_or_else(|| "无法定位用户主目录".to_string())?;
    write_ssh_config_to(&path, drafts)
}

/// [`write_ssh_config`] 的可注入路径版本（测试与通用实现共用）。
fn write_ssh_config_to(path: &Path, drafts: &[HostConfigDraft]) -> Result<(usize, usize), String> {
    if drafts.is_empty() {
        return Err("没有可写回的主机".to_string());
    }
    for draft in drafts {
        let name = draft.name.trim();
        if name.is_empty() || name.contains(' ') {
            return Err(format!(
                "主机名「{}」不能作为 Host 模式（不允许空格）",
                draft.name
            ));
        }
        if draft.hostname.trim().is_empty() {
            return Err(format!("主机「{}」缺少地址", draft.name));
        }
        // 控制字符注入面（审计 S-1）：四个字段都会原样进 config，逐一校验。
        assert_plain_config_value("主机名", name)?;
        assert_plain_config_value("主机地址", draft.hostname.trim())?;
        assert_plain_config_value("用户名", draft.user.trim())?;
        if let Some(identity) = draft.identity_file.as_deref() {
            assert_plain_config_value("私钥路径", identity.trim())?;
        }
    }
    let original = if path.exists() {
        std::fs::read_to_string(path)
            .map_err(|error| format!("读取 ~/.ssh/config 失败: {error}"))?
    } else {
        String::new()
    };
    // 已有配置先留备份；备份失败不阻断（只影响回滚能力）。
    if path.exists() {
        let _ = std::fs::copy(path, path.with_extension("catshell-bak"));
    }
    let (updated, removed) = upsert_host_blocks(&original, drafts);
    let tmp = path.with_extension("catshell-tmp");
    std::fs::write(&tmp, &updated).map_err(|error| format!("写入临时文件失败: {error}"))?;
    std::fs::rename(&tmp, path).map_err(|error| format!("替换 ~/.ssh/config 失败: {error}"))?;
    Ok((removed, drafts.len()))
}

#[cfg(test)]
mod tests {
    use super::{
        build_host_block, parse_known_hosts, parse_ssh_config, remove_known_hosts_entries,
        upsert_host_blocks, write_ssh_config_to, HostConfigDraft,
    };

    fn draft(name: &str, hostname: &str) -> HostConfigDraft {
        HostConfigDraft {
            name: name.to_string(),
            hostname: hostname.to_string(),
            port: 22,
            user: "alice".to_string(),
            identity_file: None,
        }
    }

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

    #[test]
    fn builds_host_block_with_optional_fields() {
        let block = build_host_block(&draft("web", "web.example.com"));
        assert_eq!(
            block,
            "Host web\n  HostName web.example.com\n  Port 22\n  User alice\n"
        );
        let full = build_host_block(&HostConfigDraft {
            name: "db".to_string(),
            hostname: "10.0.0.2".to_string(),
            port: 2222,
            user: "root".to_string(),
            identity_file: Some("C:/keys/db".to_string()),
        });
        assert_eq!(
            full,
            "Host db\n  HostName 10.0.0.2\n  Port 2222\n  User root\n  IdentityFile C:/keys/db\n"
        );
    }

    #[test]
    fn upsert_replaces_same_host_and_keeps_others() {
        let existing = "# my keys\nHost web\n  HostName old.example.com\n  User bob\nHost db\n  HostName db.example.com\n\nHost *\n  Compression yes\n";
        let (updated, replaced) = upsert_host_blocks(existing, &[draft("web", "web.example.com")]);
        assert_eq!(replaced, 1);
        // 旧 web 块被整体移除，db 与注释、通配块保留，新 web 追加到文末。
        assert!(!updated.contains("old.example.com"));
        assert!(updated.contains("# my keys"));
        assert!(updated.contains("HostName db.example.com"));
        assert!(updated.contains("Host *\n  Compression yes"));
        assert!(
            updated.ends_with("Host web\n  HostName web.example.com\n  Port 22\n  User alice\n\n")
        );
    }

    #[test]
    fn host_block_matching_is_case_insensitive_and_preserves_match_blocks() {
        let existing = "Host WEB\n  HostName old.example.com\n\nMatch host proxy\n  User bob\nMatch final all\n  User root\n";
        let (updated, replaced) = upsert_host_blocks(existing, &[draft("web", "web.example.com")]);
        assert_eq!(replaced, 1);
        assert!(!updated.contains("old.example.com"));
        assert!(updated.contains("Match host proxy"));
        assert!(updated.contains("Match final all"));
        // Match 块内的选项行原样保留。
        assert!(updated.contains("User bob"));
        assert!(updated.contains("User root"));
    }

    #[test]
    fn write_ssh_config_atomic_with_backup() {
        let dir = std::env::temp_dir().join(format!(
            "catshell-config-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config");

        // 首次写入（文件不存在）。
        let (replaced, written) =
            write_ssh_config_to(&path, &[draft("web", "web.example.com")]).unwrap();
        assert_eq!((replaced, written), (0, 1));
        assert!(path.exists());
        assert!(!dir.join("config.catshell-bak").exists());

        // 第二次写入替换同名块并留备份。
        let (replaced, written) = write_ssh_config_to(
            &path,
            &[
                draft("web", "new.example.com"),
                draft("db", "db.example.com"),
            ],
        )
        .unwrap();
        assert_eq!((replaced, written), (1, 2));
        assert!(dir.join("config.catshell-bak").exists());
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(!content.contains("web.example.com") || content.contains("new.example.com"));
        assert!(content.contains("new.example.com"));
        assert!(content.contains("db.example.com"));
        // 解析器能读回写出的块。
        let entries = parse_ssh_config(&content);
        assert!(entries.iter().any(
            |entry| entry.host == "web" && entry.hostname.as_deref() == Some("new.example.com")
        ));

        // 校验拒绝：空名单 / 空格主机名 / 空地址。
        assert!(write_ssh_config_to(&path, &[]).is_err());
        assert!(write_ssh_config_to(&path, &[draft("bad name", "h")]).is_err());
        assert!(write_ssh_config_to(
            &path,
            &[HostConfigDraft {
                name: "x".to_string(),
                hostname: " ".to_string(),
                port: 22,
                user: String::new(),
                identity_file: None,
            }]
        )
        .is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
