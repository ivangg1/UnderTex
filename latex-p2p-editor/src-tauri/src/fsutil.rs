//! Small filesystem helpers shared by the project and compiler modules.

use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` to `path` atomically: the data goes to a hidden sibling temp file,
/// is fsynced, and is then renamed over the destination. A crash or power loss
/// mid-write therefore never leaves a truncated target file behind.
///
/// Returns `Ok(false)` when the file already holds exactly `bytes` and nothing was
/// written. Skipping identical writes matters on cloud-synced folders: every rewrite
/// of `main.tex` is a new upload for Drive/iCloud and a new chance for a conflict copy.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<bool> {
    if let Ok(existing) = fs::read(path) {
        if existing == bytes {
            return Ok(false);
        }
    }

    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&parent)?;

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let nonce = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = parent.join(format!(
        ".{file_name}.{}.{nanos}.{nonce}.tmp",
        std::process::id()
    ));

    let result = (|| -> io::Result<()> {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp_path, path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    result.map(|_| true)
}

/// Resolve a user-supplied relative path inside `root`, rejecting absolute paths and
/// any `..` component so IPC callers can never escape the project folder.
pub fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if relative.trim().is_empty() {
        return Err("Path must not be empty".to_string());
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => return Err(format!("Invalid path '{relative}': must be relative to the project")),
        }
    }
    Ok(root.join(rel))
}

/// FNV-1a 64-bit hash, used to derive stable per-project cache directory names
/// without pulling in a hashing crate.
pub fn fnv1a64(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fsutil_{name}_{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_atomic_creates_file_and_leaves_no_temp_behind() {
        let dir = temp_dir("create");
        let target = dir.join("main.tex");

        assert!(write_atomic(&target, b"hello").unwrap());
        assert_eq!(fs::read(&target).unwrap(), b"hello");

        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_skips_identical_content_but_replaces_different_content() {
        let dir = temp_dir("skip");
        let target = dir.join("main.tex");

        assert!(write_atomic(&target, b"v1").unwrap());
        let mtime_before = fs::metadata(&target).unwrap().modified().unwrap();

        // Same bytes: must report "not written" and must not touch the file.
        assert!(!write_atomic(&target, b"v1").unwrap());
        assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), mtime_before);

        // Different bytes: replaced in full even when shorter.
        assert!(write_atomic(&target, b"v").unwrap());
        assert_eq!(fs::read(&target).unwrap(), b"v");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_creates_missing_parent_directories() {
        let dir = temp_dir("parents");
        let target = dir.join("chapters").join("intro.tex");
        assert!(write_atomic(&target, b"x").unwrap());
        assert!(target.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_inside_rejects_escapes_and_accepts_nested_relative_paths() {
        let root = Path::new("/proj");
        assert_eq!(resolve_inside(root, "main.tex").unwrap(), root.join("main.tex"));
        assert_eq!(
            resolve_inside(root, "chapters/one.tex").unwrap(),
            root.join("chapters/one.tex")
        );
        assert!(resolve_inside(root, "../secret.tex").is_err());
        assert!(resolve_inside(root, "chapters/../../x.tex").is_err());
        assert!(resolve_inside(root, "/etc/passwd").is_err());
        assert!(resolve_inside(root, "").is_err());
    }

    #[test]
    fn fnv1a64_is_stable_and_distinguishes_inputs() {
        assert_eq!(fnv1a64(""), 0xcbf29ce484222325);
        assert_eq!(fnv1a64("a"), 0xaf63dc4c8601ec8c);
        assert_ne!(fnv1a64("/proj/a"), fnv1a64("/proj/b"));
    }
}
