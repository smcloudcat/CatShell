//! 录制文件存储（asciicast v2 / `.cast` 文件）。
//!
//! 录制数据由前端在输出流上采集，停止时把完整的 asciicast JSONL 文本交给
//! 这里落盘；列表、读取、删除供前端「录制库」使用。所有对外的文件名都
//! 经过 [`sanitize_base_name`] 清洗，杜绝路径穿越。

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use ts_rs::TS;

/// 单个录制文件的最大字节数（读与写共用），防内存炸弹。
pub const MAX_RECORDING_BYTES: u64 = 64 * 1024 * 1024;
/// 清洗后的文件名基名最大字符数。
const MAX_BASE_CHARS: usize = 80;

#[derive(Clone, Debug, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecordingMeta {
    pub name: String,
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub modified_at: u64,
}

/// 清洗文件名基名：保留字母数字、CJK、`_` `-` 与空格，其余（含点号与
/// 路径分隔符）折叠为单个 `_`；折叠后只剩下划线视同空结果回落 `recording`。
/// 返回值不含扩展名，也不会包含路径分隔符，可安全用于 `dir.join(...)`。
pub fn sanitize_base_name(raw: &str) -> String {
    let mut cleaned = String::with_capacity(raw.len().min(MAX_BASE_CHARS * 3));
    for ch in raw.chars() {
        let keep = ch.is_alphanumeric()
            || matches!(ch, '_' | '-' | ' ')
            || ('\u{4E00}'..='\u{9FFF}').contains(&ch);
        if keep {
            cleaned.push(ch);
        } else if !cleaned.ends_with('_') {
            cleaned.push('_');
        }
        if cleaned.chars().count() >= MAX_BASE_CHARS {
            break;
        }
    }
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '_') {
        "recording".to_string()
    } else {
        trimmed.to_string()
    }
}

fn recordings_dir(dir: &Path) -> PathBuf {
    dir.join("recordings")
}

/// 录制目录（应用数据目录下的 `recordings/`）。调用方负责目录存在性。
pub fn ensure_recordings_dir(app_dir: &Path) -> Result<PathBuf, String> {
    let dir = recordings_dir(app_dir);
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建录制目录失败: {error}"))?;
    Ok(dir)
}

/// 保存一条录制，返回元信息。同名覆盖（前端用时间戳命名，正常不冲突）。
pub fn save_recording(dir: &Path, base: &str, content: &str) -> Result<RecordingMeta, String> {
    let name = format!("{}.cast", sanitize_base_name(base));
    let content_bytes = content.as_bytes();
    if content_bytes.len() as u64 > MAX_RECORDING_BYTES {
        return Err("录制文件过大".to_string());
    }
    let target_dir = recordings_dir(dir);
    // 保存是唯一写入方，目录不存在时就地创建，调用方无需预建
    std::fs::create_dir_all(&target_dir).map_err(|error| format!("创建录制目录失败: {error}"))?;
    let path = target_dir.join(&name);
    // 先写临时文件再原子替换（审计 X-11）：直接写目标时断电/崩溃会留下半截 `.cast`，
    // 它仍会被 `list_recordings` 列出来且读取失败。临时名不以 `.cast` 结尾，
    // 即使意外残留也不会出现在列表里。
    // 临时名带进程内唯一序号（审计待验证项-3）：同名录制并发保存时互不覆盖半成品。
    let tmp = target_dir.join(format!(
        "{name}.catshell-tmp-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&tmp, content_bytes).map_err(|error| format!("写入录制文件失败: {error}"))?;
    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换录制文件失败: {error}"));
    }
    Ok(meta_of(&name, content_bytes.len() as u64))
}

/// 列出全部录制，按修改时间倒序。
pub fn list_recordings(dir: &Path) -> Vec<RecordingMeta> {
    let Ok(entries) = std::fs::read_dir(recordings_dir(dir)) else {
        return Vec::new();
    };
    let mut items: Vec<RecordingMeta> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".cast") {
                return None;
            }
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs())
                .unwrap_or_default();
            Some(RecordingMeta {
                name,
                size: metadata.len(),
                modified_at,
            })
        })
        .collect();
    items.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(a.name.cmp(&b.name)));
    items
}

/// 读取一条录制内容。文件名必须是清洗后的形态，防路径穿越。
pub fn read_recording(dir: &Path, name: &str) -> Result<String, String> {
    let expected = format!(
        "{}.cast",
        sanitize_base_name(name.trim_end_matches(".cast"))
    );
    if name != expected {
        return Err("录制文件名无效".to_string());
    }
    let path = recordings_dir(dir).join(&expected);
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("读取录制文件失败: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_RECORDING_BYTES {
        return Err("录制文件无效或过大".to_string());
    }
    std::fs::read_to_string(&path).map_err(|error| format!("读取录制文件失败: {error}"))
}

/// 删除一条录制。文件名必须是清洗后的形态。
pub fn delete_recording(dir: &Path, name: &str) -> Result<(), String> {
    let expected = format!(
        "{}.cast",
        sanitize_base_name(name.trim_end_matches(".cast"))
    );
    if name != expected {
        return Err("录制文件名无效".to_string());
    }
    std::fs::remove_file(recordings_dir(dir).join(expected))
        .map_err(|error| format!("删除录制文件失败: {error}"))
}

fn meta_of(name: &str, size: u64) -> RecordingMeta {
    RecordingMeta {
        name: name.to_string(),
        size,
        modified_at: std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_safe_chars_and_drops_separators() {
        assert_eq!(sanitize_base_name("web-01 /root"), "web-01 _root");
        assert_eq!(sanitize_base_name("生产机:22"), "生产机_22");
        assert_eq!(sanitize_base_name("..\\..\\evil"), "_evil");
    }

    #[test]
    fn sanitize_falls_back_for_empty_or_odd_input() {
        assert_eq!(sanitize_base_name("   "), "recording");
        assert_eq!(sanitize_base_name("///"), "recording");
        assert_eq!(sanitize_base_name("..."), "recording");
    }

    #[test]
    fn sanitize_truncates_long_names() {
        let long = "x".repeat(500);
        assert_eq!(sanitize_base_name(&long).chars().count(), MAX_BASE_CHARS);
    }

    #[test]
    fn save_list_read_delete_roundtrip() {
        let dir = std::env::temp_dir().join(format!("catshell-rec-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let meta = save_recording(&dir, "web 01/prod", "{\"version\":2}\n").unwrap();
        assert_eq!(meta.name, "web 01_prod.cast");
        assert_eq!(list_recordings(&dir).len(), 1);

        let content = read_recording(&dir, "web 01_prod.cast").unwrap();
        assert_eq!(content, "{\"version\":2}\n");

        // 穿越尝试必须被拒绝
        assert!(read_recording(&dir, "../web 01_prod.cast").is_err());
        assert!(delete_recording(&dir, "../web 01_prod.cast").is_err());

        delete_recording(&dir, "web 01_prod.cast").unwrap();
        assert!(list_recordings(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
