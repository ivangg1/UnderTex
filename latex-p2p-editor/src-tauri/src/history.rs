//! Local version history.
//!
//! Snapshots of the root TeX file are stored per project under the app data
//! directory (never inside the project folder, so cloud-synced projects and
//! solo-mode folders stay clean): `<app-data>/history/<project-hash>/`
//! holds `index.json` plus one `<id>.tex` per snapshot.
//!
//! * `auto` snapshots are taken by the app (after saves, before restores) and
//!   pruned beyond [`MAX_AUTO_SNAPSHOTS`]; identical content is never stored
//!   twice in a row.
//! * `manual` snapshots carry a user label and are kept forever.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::fsutil::{fnv1a64, write_atomic};

pub const MAX_AUTO_SNAPSHOTS: usize = 200;
const INDEX_FILE: &str = "index.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotKind {
    Auto,
    Manual,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SnapshotMeta {
    /// `<created_at_ms>-<hash prefix>`; also the file stem on disk.
    pub id: String,
    pub created_at_ms: u64,
    pub kind: SnapshotKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub main_file: String,
    pub bytes: u64,
    /// SHA-256 of the content, hex.
    pub hash: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct SaveOutcome {
    pub snapshot: SnapshotMeta,
    /// `false` when the content matched the latest snapshot (which may have been relabelled).
    pub created: bool,
}

pub struct HistoryStore {
    root: PathBuf,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn content_hash(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

impl HistoryStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn project_dir(&self, project_path: &str) -> PathBuf {
        self.root.join(format!("{:016x}", fnv1a64(project_path)))
    }

    fn read_index(&self, dir: &Path) -> Vec<SnapshotMeta> {
        fs::read_to_string(dir.join(INDEX_FILE))
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<SnapshotMeta>>(&s).ok())
            .unwrap_or_default()
    }

    fn write_index(&self, dir: &Path, index: &[SnapshotMeta]) -> Result<(), String> {
        let json = serde_json::to_string(index).map_err(|e| format!("Failed to serialize history index: {e}"))?;
        write_atomic(&dir.join(INDEX_FILE), json.as_bytes())
            .map(|_| ())
            .map_err(|e| format!("Failed to write history index: {e}"))
    }

    /// Snapshots of a project, newest first.
    pub fn list(&self, project_path: &str) -> Vec<SnapshotMeta> {
        let mut index = self.read_index(&self.project_dir(project_path));
        index.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms).then_with(|| b.id.cmp(&a.id)));
        index
    }

    /// Stores a snapshot. With `label == None` the snapshot is `auto` and skipped
    /// when the content equals the latest one; with a label it is `manual`, and
    /// identical content promotes the latest snapshot instead of duplicating it.
    pub fn save(
        &self,
        project_path: &str,
        main_file: &str,
        content: &str,
        label: Option<&str>,
        author: Option<&str>,
    ) -> Result<SaveOutcome, String> {
        let dir = self.project_dir(project_path);
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create history directory: {e}"))?;
        let mut index = self.list(project_path);
        let hash = content_hash(content);
        let label = label.map(str::trim).filter(|l| !l.is_empty()).map(str::to_string);
        let author = author.map(str::trim).filter(|a| !a.is_empty()).map(str::to_string);

        if let Some(latest) = index.first_mut() {
            if latest.hash == hash && latest.main_file == main_file {
                if let Some(label) = label {
                    latest.kind = SnapshotKind::Manual;
                    latest.label = Some(label);
                    if author.is_some() {
                        latest.author = author;
                    }
                    self.write_index(&dir, &index)?;
                    return Ok(SaveOutcome { snapshot: index[0].clone(), created: false });
                }
                return Ok(SaveOutcome { snapshot: latest.clone(), created: false });
            }
        }

        let created_at_ms = now_ms().max(index.first().map(|s| s.created_at_ms + 1).unwrap_or(0));
        let id = format!("{created_at_ms}-{}", &hash[..12]);
        write_atomic(&dir.join(format!("{id}.tex")), content.as_bytes())
            .map_err(|e| format!("Failed to write snapshot: {e}"))?;
        let snapshot = SnapshotMeta {
            id,
            created_at_ms,
            kind: if label.is_some() { SnapshotKind::Manual } else { SnapshotKind::Auto },
            label,
            author,
            main_file: main_file.to_string(),
            bytes: content.len() as u64,
            hash,
        };
        index.insert(0, snapshot.clone());

        // Prune old automatic snapshots; labelled ones are kept.
        let mut auto_seen = 0usize;
        let mut keep = Vec::with_capacity(index.len());
        for meta in index {
            if meta.kind == SnapshotKind::Auto {
                auto_seen += 1;
                if auto_seen > MAX_AUTO_SNAPSHOTS {
                    let _ = fs::remove_file(dir.join(format!("{}.tex", meta.id)));
                    continue;
                }
            }
            keep.push(meta);
        }
        self.write_index(&dir, &keep)?;
        Ok(SaveOutcome { snapshot, created: true })
    }

    pub fn read(&self, project_path: &str, id: &str) -> Result<String, String> {
        if !valid_id(id) {
            return Err(format!("Invalid snapshot id: {id}"));
        }
        let path = self.project_dir(project_path).join(format!("{id}.tex"));
        fs::read_to_string(&path).map_err(|e| format!("Snapshot not found: {e}"))
    }

    pub fn delete(&self, project_path: &str, id: &str) -> Result<Vec<SnapshotMeta>, String> {
        if !valid_id(id) {
            return Err(format!("Invalid snapshot id: {id}"));
        }
        let dir = self.project_dir(project_path);
        let index: Vec<SnapshotMeta> = self.list(project_path).into_iter().filter(|s| s.id != id).collect();
        let _ = fs::remove_file(dir.join(format!("{id}.tex")));
        self.write_index(&dir, &index)?;
        Ok(index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn store() -> (HistoryStore, PathBuf) {
        let root = std::env::temp_dir().join(format!("history_{}", Uuid::new_v4()));
        (HistoryStore::new(&root), root)
    }

    #[test]
    fn auto_snapshots_dedupe_consecutive_identical_content() {
        let (store, root) = store();
        let a = store.save("/p", "main.tex", "v1", None, Some("Ana")).unwrap();
        assert!(a.created);
        assert_eq!(a.snapshot.kind, SnapshotKind::Auto);
        assert_eq!(a.snapshot.author.as_deref(), Some("Ana"));

        let again = store.save("/p", "main.tex", "v1", None, None).unwrap();
        assert!(!again.created);
        assert_eq!(again.snapshot.id, a.snapshot.id);
        assert_eq!(store.list("/p").len(), 1);

        let b = store.save("/p", "main.tex", "v2", None, None).unwrap();
        assert!(b.created);
        let list = store.list("/p");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, b.snapshot.id, "newest first");
        assert_eq!(store.read("/p", &a.snapshot.id).unwrap(), "v1");
        assert_eq!(store.read("/p", &b.snapshot.id).unwrap(), "v2");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn labelling_identical_content_promotes_latest_instead_of_duplicating() {
        let (store, root) = store();
        let auto = store.save("/p", "main.tex", "same", None, None).unwrap();
        let labelled = store.save("/p", "main.tex", "same", Some("  Submitted  "), Some("Bo")).unwrap();
        assert!(!labelled.created);
        assert_eq!(labelled.snapshot.id, auto.snapshot.id);
        assert_eq!(labelled.snapshot.kind, SnapshotKind::Manual);
        assert_eq!(labelled.snapshot.label.as_deref(), Some("Submitted"));
        assert_eq!(labelled.snapshot.author.as_deref(), Some("Bo"));
        assert_eq!(store.list("/p").len(), 1);

        // Different content with a label creates a manual snapshot.
        let v2 = store.save("/p", "main.tex", "other", Some("v2"), None).unwrap();
        assert!(v2.created);
        assert_eq!(v2.snapshot.kind, SnapshotKind::Manual);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pruning_keeps_labelled_snapshots_and_the_newest_autos() {
        let (store, root) = store();
        let keep = store.save("/p", "main.tex", "labelled", Some("keep me"), None).unwrap();
        for i in 0..(MAX_AUTO_SNAPSHOTS + 5) {
            store.save("/p", "main.tex", &format!("auto {i}"), None, None).unwrap();
        }
        let list = store.list("/p");
        let autos = list.iter().filter(|s| s.kind == SnapshotKind::Auto).count();
        assert_eq!(autos, MAX_AUTO_SNAPSHOTS);
        assert!(list.iter().any(|s| s.id == keep.snapshot.id), "labelled snapshot must survive pruning");
        assert_eq!(store.read("/p", &keep.snapshot.id).unwrap(), "labelled");
        // The oldest autos are gone from disk too.
        let files = fs::read_dir(root.join(format!("{:016x}", fnv1a64("/p")))).unwrap().count();
        assert_eq!(files, list.len() + 1, "one .tex per snapshot plus index.json");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_removes_file_and_entry_and_ids_are_validated() {
        let (store, root) = store();
        let a = store.save("/p", "main.tex", "a", None, None).unwrap();
        let b = store.save("/p", "main.tex", "b", None, None).unwrap();
        let left = store.delete("/p", &a.snapshot.id).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, b.snapshot.id);
        assert!(store.read("/p", &a.snapshot.id).is_err());
        assert!(store.read("/p", "../../etc/passwd").is_err());
        assert!(store.delete("/p", "nope!").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn projects_are_isolated_from_each_other() {
        let (store, root) = store();
        store.save("/one", "main.tex", "x", None, None).unwrap();
        store.save("/two", "thesis.tex", "y", None, None).unwrap();
        assert_eq!(store.list("/one").len(), 1);
        assert_eq!(store.list("/two").len(), 1);
        assert_eq!(store.list("/two")[0].main_file, "thesis.tex");
        assert!(store.list("/three").is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
