//! SSH 密钥管理：生成 Ed25519 密钥对、浏览 `~/.ssh` 目录、删除密钥对。
//!
//! 生成与解析复用 russh 内置的 `ssh_key`（`russh::keys::ssh_key`，与认证加载
//! `load_secret_key` 同一版本线），保证生成出的密钥一定能被本应用连接流程加载。
//! 删除操作只接受「内容确实是私钥」的文件，config / known_hosts 永远删不掉。

use std::path::{Path, PathBuf};

use russh::keys::ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey, PublicKey};
use ts_rs::TS;

const PRIVATE_PEM_PREFIX: &str = "-----BEGIN";

/// `~/.ssh` 目录（所有平台一致，与 known_hosts 保持对齐，审计 M-1）。
pub fn ssh_dir() -> Result<PathBuf, String> {
    default_known_hosts_parent()
}

fn default_known_hosts_parent() -> Result<PathBuf, String> {
    let known_hosts = super::config::default_known_hosts_path()
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    known_hosts
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位 .ssh 目录".to_string())
}

#[derive(Clone, Debug, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SshKeyEntry {
    /// 主文件名：私钥名（有私钥时）或 `.pub` 去掉后缀的名。
    pub file_name: String,
    /// `key` = 密钥（私钥或公钥）；`other` = 目录里的其它文件（config、known_hosts 等）。
    pub kind: String,
    pub has_private: bool,
    pub has_public: bool,
    pub key_type: Option<String>,
    pub fingerprint: Option<String>,
    pub comment: Option<String>,
    /// 私钥是否带口令（OpenSSH 格式；其它格式无法判断时保持 false）。
    pub encrypted: bool,
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub modified_ms: u64,
    pub private_path: Option<String>,
    pub public_path: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GeneratedKeypair {
    pub private_path: String,
    pub public_path: String,
    /// OpenSSH 单行公钥（含类型、base64 与备注），可直接贴到服务端 authorized_keys。
    pub public_key: String,
    pub key_type: String,
    pub fingerprint: String,
}

fn fingerprint_of(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 目标已存在时回传的稳定错误码前缀（前端据此弹出「覆盖」确认）。
///
/// 不能用文案匹配：`目标路径是一个已存在的目录` 这类错误同样含「已存在」，
/// 但覆盖无法解决，误判会让用户在确认后再次失败。前端只认这个机器码。
pub const KEYPAIR_EXISTS_CODE: &str = "KEYPAIR_EXISTS";

/// 校验目标路径能安全用于生成：非空、绝对路径、不是已存在的目录。
/// 不限制必须位于 `~/.ssh`（保存对话框由用户自由选择），但文件存在与否由 `overwrite` 控制。
fn validate_generate_target(path: &str, overwrite: bool) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("保存路径为空".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("保存路径必须是绝对路径".to_string());
    }
    if path.is_dir() {
        return Err("目标路径是一个已存在的目录".to_string());
    }
    if path.exists() && !overwrite {
        return Err(format!("{KEYPAIR_EXISTS_CODE}: 目标文件已存在"));
    }
    Ok(path)
}

/// 生成 Ed25519 密钥对并写入私钥 / `.pub` 两个文件。口令可选（OpenSSH 加密格式）。
pub fn generate_keypair(
    private_path: &str,
    passphrase: Option<&str>,
    comment: &str,
    overwrite: bool,
) -> Result<GeneratedKeypair, String> {
    let private_path = validate_generate_target(private_path, overwrite)?;
    let public_path = PathBuf::from(format!("{}.pub", private_path.to_string_lossy()));
    if public_path.exists() && !overwrite {
        return Err(format!("{KEYPAIR_EXISTS_CODE}: 同名公钥文件（.pub）已存在"));
    }

    let mut key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .map_err(|error| format!("生成密钥失败: {error}"))?;
    if !comment.trim().is_empty() {
        key.set_comment(comment.trim());
    }
    if let Some(passphrase) = passphrase {
        if !passphrase.is_empty() {
            key = key
                .encrypt(&mut rand::rng(), passphrase)
                .map_err(|error| format!("私钥加密失败: {error}"))?;
        }
    }

    let public_key = key
        .public_key()
        .to_openssh()
        .map_err(|error| format!("序列化公钥失败: {error}"))?;
    let private_pem = key
        .to_openssh(LineEnding::LF)
        .map_err(|error| format!("序列化私钥失败: {error}"))?;

    // 两阶段提交（审计 M-4）：先写同目录唯一临时文件并完成权限收紧，
    // 全部成功后才替换正式文件；任一步失败回滚，绝不留下「新私钥 + 旧公钥」
    // 的不匹配密钥对，也不再忽略权限设置失败。
    // 注意用「追加后缀」而不是 with_extension（后者会替换 .pub 等已有扩展名，
    // 导致私钥/公钥临时文件同名互相覆盖）。
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let private_tmp = append_suffix(&private_path, &format!(".catshell-gen-{stamp}"));
    let public_tmp = append_suffix(&public_path, &format!(".catshell-gen-{stamp}"));

    std::fs::write(&private_tmp, private_pem.as_bytes())
        .map_err(|error| format!("写入私钥失败: {error}"))?;
    // 类 Unix 平台收紧私钥权限为 0600（Windows 走 NTFS 默认 ACL）；
    // 权限收紧失败视为生成失败，避免把宽权限私钥留在磁盘上。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&private_tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("设置私钥权限失败: {error}"))?;
    }
    let cleanup_tmps = |private_tmp: &Path, public_tmp: &Path| {
        let _ = std::fs::remove_file(private_tmp);
        let _ = std::fs::remove_file(public_tmp);
    };
    if let Err(error) = std::fs::write(&public_tmp, format!("{public_key}\n")) {
        cleanup_tmps(&private_tmp, &public_tmp);
        return Err(format!("写入公钥失败: {error}"));
    }
    if let Err(error) = replace_with_backup(&private_path, &private_tmp, stamp) {
        cleanup_tmps(&private_tmp, &public_tmp);
        return Err(error);
    }
    if let Err(error) = replace_with_backup(&public_path, &public_tmp, stamp) {
        // 私钥已换新、公钥替换失败：回滚私钥到旧文件，保持密钥对一致。
        let private_bak = append_suffix(&private_path, &format!(".catshell-bak-{stamp}"));
        if private_bak.exists() {
            let _ = std::fs::rename(&private_bak, &private_path);
        }
        cleanup_tmps(&private_tmp, &public_tmp);
        return Err(error);
    }

    Ok(GeneratedKeypair {
        private_path: private_path.to_string_lossy().to_string(),
        public_path: public_path.to_string_lossy().to_string(),
        public_key,
        key_type: key.algorithm().to_string(),
        fingerprint: fingerprint_of(key.public_key()),
    })
}

/// 在路径字符串后追加后缀（保留原扩展名；`with_extension` 会替换已有扩展名）。
fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{}", path.to_string_lossy(), suffix))
}

/// 同步版两阶段替换（审计 M-4）：旧文件先挪到备份名（不是删除），新文件 rename
/// 到位后再清理备份；替换失败把备份改回原名，旧文件永不丢失。
/// `stamp` 由调用方传入并保证同一次生成的备份名可预测（供失败回滚定位）。
fn replace_with_backup(target: &Path, source: &Path, stamp: u128) -> Result<(), String> {
    let had_existing = target.exists();
    let backup = append_suffix(target, &format!(".catshell-bak-{stamp}"));
    if had_existing {
        std::fs::rename(target, &backup)
            .map_err(|error| format!("备份旧文件失败 {}: {error}", target.display()))?;
    }
    if let Err(error) = std::fs::rename(source, target) {
        if had_existing {
            let _ = std::fs::rename(&backup, target);
        }
        return Err(format!(
            "替换文件失败 {}: {error}（旧文件已回滚）",
            target.display()
        ));
    }
    if had_existing {
        let _ = std::fs::remove_file(&backup);
    }
    Ok(())
}

/// 解析公钥文件内容（一行 OpenSSH 格式）。
fn parse_public_text(text: &str) -> Option<(String, String, Option<String>)> {
    let line = text.lines().find(|line| !line.trim().is_empty())?;
    let public = PublicKey::from_openssh(line).ok()?;
    let comment = public.comment().to_string();
    let comment = if comment.is_empty() {
        None
    } else {
        Some(comment)
    };
    Some((
        public.algorithm().to_string(),
        fingerprint_of(&public),
        comment,
    ))
}

/// 判断私钥文件：返回 (解析成功, 是否加密)。
fn inspect_private(path: &Path) -> (bool, bool) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (false, false);
    };
    if !text.trim_start().starts_with(PRIVATE_PEM_PREFIX) {
        return (false, false);
    }
    if let Ok(key) = PrivateKey::from_openssh(&text) {
        return (true, key.is_encrypted());
    }
    // OpenSSH 之外的 PEM（PKCS#8 / 传统 RSA）交给 russh 的加载器兜底。
    (
        russh::keys::load_secret_key(path.to_string_lossy().as_ref(), None).is_ok(),
        false,
    )
}

/// 浏览 `~/.ssh` 目录：密钥成组（私钥 + `.pub`），其余文件原样列出（kind=other）。
pub fn list_keys() -> Result<Vec<SshKeyEntry>, String> {
    let dir = ssh_dir()?;
    let entries =
        std::fs::read_dir(&dir).map_err(|error| format!("读取 .ssh 目录失败: {error}"))?;

    // base 名 -> (私钥路径, 公钥路径)
    let mut grouped: std::collections::BTreeMap<String, (Option<PathBuf>, Option<PathBuf>)> =
        std::collections::BTreeMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let (base, is_public) = match name.strip_suffix(".pub") {
            Some(base) => (base.to_string(), true),
            None => (name.clone(), false),
        };
        let slot = grouped.entry(base).or_default();
        if is_public {
            slot.1 = Some(path);
        } else {
            slot.0 = Some(path);
        }
    }

    let mut result = Vec::new();
    for (base, (private, public)) in grouped {
        let primary = private.as_ref().or(public.as_ref());
        let Some(primary) = primary else { continue };
        let size = std::fs::metadata(primary)
            .map(|meta| meta.len())
            .unwrap_or(0);

        let mut entry = SshKeyEntry {
            file_name: base.clone(),
            kind: "other".to_string(),
            has_private: private.is_some(),
            has_public: public.is_some(),
            key_type: None,
            fingerprint: None,
            comment: None,
            encrypted: false,
            size,
            modified_ms: modified_ms(primary),
            private_path: private
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            public_path: public
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
        };

        // 公钥信息优先从 .pub 拿；私钥能无口令加载时以其为准。
        if let Some(public_path) = &public {
            if let Ok(text) = std::fs::read_to_string(public_path) {
                if let Some((key_type, fingerprint, comment)) = parse_public_text(&text) {
                    entry.key_type = Some(key_type);
                    entry.fingerprint = Some(fingerprint);
                    entry.comment = comment;
                }
            }
        }
        if let Some(private_path) = &private {
            let (parsed, encrypted) = inspect_private(private_path);
            if parsed {
                entry.kind = "key".to_string();
                entry.encrypted = encrypted;
                if !encrypted {
                    if let Ok(key) =
                        russh::keys::load_secret_key(private_path.to_string_lossy().as_ref(), None)
                    {
                        entry.key_type = Some(key.public_key().algorithm().to_string());
                        entry.fingerprint = Some(fingerprint_of(key.public_key()));
                        let comment = key.public_key().comment().to_string();
                        if !comment.is_empty() {
                            entry.comment = Some(comment);
                        }
                    }
                }
            } else if entry.has_public && entry.key_type.is_some() {
                // 只有 .pub（私钥缺失或无法识别）也算密钥条目。
                entry.kind = "key".to_string();
            }
        }

        result.push(entry);
    }

    result.sort_by(|a, b| {
        let rank = |entry: &SshKeyEntry| if entry.kind == "key" { 0 } else { 1 };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.file_name.cmp(&b.file_name))
    });
    Ok(result)
}

/// 删除密钥对（私钥 + `.pub`）。只允许删除 `~/.ssh` 内「内容确实是私钥」的文件，
/// config / known_hosts / 其它文件一律拒绝。返回删除的文件数。
pub fn delete_keypair(private_path: &str) -> Result<usize, String> {
    let dir = ssh_dir()?;
    delete_keypair_in(&dir, private_path)
}

/// [`delete_keypair`] 的可注入目录版本（测试与通用实现共用）。
fn delete_keypair_in(dir: &Path, private_path: &str) -> Result<usize, String> {
    let path = PathBuf::from(private_path.trim());
    if !path.is_absolute() {
        return Err("路径必须是绝对路径".to_string());
    }
    // 路径必须位于指定目录内（防误删任意位置的文件）。
    let canonical_dir = dir
        .canonicalize()
        .map_err(|error| format!("定位目录失败: {error}"))?;
    let canonical = path.canonicalize().map_err(|_| "文件不存在".to_string())?;
    if !canonical.starts_with(&canonical_dir) {
        return Err("只能删除 ~/.ssh 目录内的密钥文件".to_string());
    }
    // 内容校验：必须能被识别为私钥（防误删 config / known_hosts 等）。
    let (parsed, _) = inspect_private(&canonical);
    if !parsed {
        return Err("目标文件不是可识别的私钥，拒绝删除".to_string());
    }

    let mut removed = 0;
    if std::fs::remove_file(&canonical).is_ok() {
        removed += 1;
    }
    let public_path = PathBuf::from(format!("{}.pub", canonical.to_string_lossy()));
    if public_path.exists() && std::fs::remove_file(&public_path).is_ok() {
        removed += 1;
    }
    Ok(removed)
}

/// 读取公钥单行内容（传入私钥路径时自动找同名 `.pub`）。仅允许 `~/.ssh` 内的文件。
pub fn read_public_key(private_path: &str) -> Result<String, String> {
    let dir = ssh_dir()?;
    let canonical_dir = dir
        .canonicalize()
        .map_err(|error| format!("定位 .ssh 目录失败: {error}"))?;
    let path = PathBuf::from(private_path.trim());
    if !path.is_absolute() {
        return Err("路径必须是绝对路径".to_string());
    }
    let canonical = path.canonicalize().map_err(|_| "文件不存在".to_string())?;
    if !canonical.starts_with(&canonical_dir) {
        return Err("只能读取 ~/.ssh 目录内的公钥文件".to_string());
    }
    let public_path = if canonical
        .extension()
        .map(|ext| ext == "pub")
        .unwrap_or(false)
    {
        canonical
    } else {
        PathBuf::from(format!("{}.pub", canonical.to_string_lossy()))
    };
    let text = std::fs::read_to_string(&public_path)
        .map_err(|_| "未找到对应的 .pub 公钥文件".to_string())?;
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "公钥文件为空".to_string())
}

#[cfg(test)]
mod tests {
    use super::{delete_keypair_in, fingerprint_of, generate_keypair};
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "catshell-keys-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn generates_keypair_that_roundtrips() {
        let dir = temp_dir("roundtrip");
        let private = dir.join("id_test");
        let generated =
            generate_keypair(private.to_str().unwrap(), None, "catshell-test", false).unwrap();

        assert_eq!(generated.key_type, "ssh-ed25519");
        assert!(generated.fingerprint.starts_with("SHA256:"));
        assert!(private.exists());
        let public_path = dir.join("id_test.pub");
        assert!(public_path.exists());

        // 公钥行能被解析且指纹一致。
        let text = std::fs::read_to_string(&public_path).unwrap();
        let public = russh::keys::ssh_key::PublicKey::from_openssh(text.trim()).unwrap();
        assert_eq!(fingerprint_of(&public), generated.fingerprint);
        assert_eq!(public.comment().to_string(), "catshell-test");

        // russh 认证加载器能加载该私钥。
        let loaded =
            russh::keys::load_secret_key(private.to_string_lossy().as_ref(), None).unwrap();
        assert_eq!(fingerprint_of(loaded.public_key()), generated.fingerprint);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn encrypted_keypair_requires_passphrase() {
        let dir = temp_dir("encrypted");
        let private = dir.join("id_enc");
        let generated =
            generate_keypair(private.to_str().unwrap(), Some("secret-pass"), "", false).unwrap();

        let text = std::fs::read_to_string(&private).unwrap();
        let parsed = russh::keys::ssh_key::PrivateKey::from_openssh(&text).unwrap();
        assert!(parsed.is_encrypted());

        // 无口令加载失败，正确口令加载成功且指纹一致。
        assert!(russh::keys::load_secret_key(private.to_string_lossy().as_ref(), None).is_err());
        let loaded =
            russh::keys::load_secret_key(private.to_string_lossy().as_ref(), Some("secret-pass"))
                .unwrap();
        assert_eq!(fingerprint_of(loaded.public_key()), generated.fingerprint);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_overwrite_without_flag_and_retries_with_flag() {
        let dir = temp_dir("overwrite");
        let private = dir.join("id_dup");
        generate_keypair(private.to_str().unwrap(), None, "", false).unwrap();
        assert!(generate_keypair(private.to_str().unwrap(), None, "", false).is_err());
        assert!(generate_keypair(private.to_str().unwrap(), None, "", true).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deletes_keypair_but_refuses_non_key_files() {
        let dir = temp_dir("delete");
        // 真密钥：私钥 + .pub 一起删。
        let private = dir.join("id_del");
        generate_keypair(private.to_str().unwrap(), None, "", false).unwrap();
        let removed = delete_keypair_in(&dir, private.to_str().unwrap()).unwrap();
        assert_eq!(removed, 2);
        assert!(!private.exists());
        assert!(!dir.join("id_del.pub").exists());

        // 伪装成密钥名的普通文件（如 config）必须拒绝。
        let fake = dir.join("config");
        std::fs::write(&fake, "Host web\n  HostName web.example.com\n").unwrap();
        assert!(delete_keypair_in(&dir, fake.to_str().unwrap()).is_err());
        assert!(fake.exists());

        // 不在允许目录内的路径拒绝。
        let other = temp_dir("delete-other");
        let outside = other.join("id_outside");
        generate_keypair(outside.to_str().unwrap(), None, "", false).unwrap();
        assert!(delete_keypair_in(&dir, outside.to_str().unwrap()).is_err());
        assert!(outside.exists());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }
}
