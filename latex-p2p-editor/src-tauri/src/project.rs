//! Project folder handling: root-file detection, `.texcollab/` metadata and
//! atomic persistence of the TeX source and the CRDT state.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::cloud::{self, CloudLocation};
use crate::fsutil::{resolve_inside, write_atomic};

pub const COLLAB_DIR: &str = ".texcollab";
pub const ROOM_FILE: &str = "room.json";
pub const CRDT_FILE: &str = "crdt_state.bin";
pub const DEFAULT_MAIN_FILE: &str = "main.tex";

const STARTER_TEX: &str =
    "\\documentclass{article}\n\\begin{document}\nHello, world!\n\\end{document}\n";

/// Directories never scanned for `.tex` files.
const SKIPPED_DIRS: &[&str] = &["node_modules", "target", "build", "dist"];

/// Maximum depth when listing `.tex` files (root = 0).
const MAX_SCAN_DEPTH: usize = 3;

/// Metadata stored in `.texcollab/room.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RoomMeta {
    pub room_id: String,
    /// Root `.tex` file the room collaborates on (relative to the project).
    /// Optional for backwards compatibility with rooms created before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_file: Option<String>,
}

/// Result returned when opening/reading a project.
#[derive(Serialize, Clone, Debug)]
pub struct ProjectData {
    /// Absolute path of the project folder.
    pub project_path: String,
    /// Root `.tex` file, relative to the project (e.g. `main.tex` or `thesis/main.tex`).
    pub main_file: String,
    /// All `.tex` files found in the project (relative paths, `/` separated, sorted).
    pub tex_files: Vec<String>,
    /// Contents of `main_file`.
    pub tex_content: String,
    /// Whether this project is configured for collaborative editing (`.texcollab/room.json` exists).
    pub is_collab: bool,
    /// The deterministic WebRTC room ID for this project folder (collab mode only).
    pub room_id: Option<String>,
    /// Raw bytes of `.texcollab/crdt_state.bin`, if any.
    pub crdt_state: Option<Vec<u8>>,
    /// Desktop sync client keeping the folder in the cloud (Google Drive, iCloud, …) or `local`.
    pub cloud: CloudLocation,
}

/// Reads `.texcollab/room.json` if present. `Ok(None)` when the project is in solo mode.
pub fn read_room_meta(project_path: &Path) -> Result<Option<RoomMeta>, String> {
    let room_file = project_path.join(COLLAB_DIR).join(ROOM_FILE);
    if !room_file.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&room_file).map_err(|e| format!("Failed to read room.json: {e}"))?;
    let meta: RoomMeta = serde_json::from_str(&data).map_err(|e| format!("Invalid room.json: {e}"))?;
    Ok(Some(meta))
}

fn write_room_meta(project_path: &Path, meta: &RoomMeta) -> Result<(), String> {
    let collab_dir = project_path.join(COLLAB_DIR);
    fs::create_dir_all(&collab_dir).map_err(|e| format!("Failed to create .texcollab dir: {e}"))?;
    let json = serde_json::to_string_pretty(meta).map_err(|e| format!("JSON serialize: {e}"))?;
    write_atomic(&collab_dir.join(ROOM_FILE), json.as_bytes())
        .map_err(|e| format!("Failed to write room.json: {e}"))?;
    Ok(())
}

/// Ensure `.texcollab/room.json` exists and return its metadata.
///
/// * If the file exists and no room is requested, it wins (a folder shared through the
///   cloud must keep its room). A legacy file without `main_file` is upgraded in place.
/// * An explicit Join (`requested_room_id`) into a folder of *another* room switches the
///   folder to the requested room and drops the old room's CRDT state.
/// * Otherwise a new room is written using `requested_room_id` (joining an existing
///   remote room) or a fresh UUID (hosting a new one).
pub fn ensure_room_meta(
    project_path: &Path,
    requested_room_id: Option<&str>,
    main_file: &str,
) -> Result<RoomMeta, String> {
    let requested = match requested_room_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => {
            Uuid::parse_str(id).map_err(|_| format!("'{id}' is not a valid room ID (expected a UUID)"))?;
            Some(id.to_lowercase())
        }
        None => None,
    };

    if let Some(mut existing) = read_room_meta(project_path)? {
        match &requested {
            // An explicit Join into a folder that belonged to another room switches
            // it to the requested room. The old room's CRDT state is dropped: merging
            // it into an unrelated document would duplicate the text.
            Some(id) if *id != existing.room_id => {
                let _ = fs::remove_file(project_path.join(COLLAB_DIR).join(CRDT_FILE));
                existing.room_id = id.clone();
                if existing.main_file.is_none() {
                    existing.main_file = Some(main_file.to_string());
                }
                write_room_meta(project_path, &existing)?;
            }
            _ => {
                if existing.main_file.is_none() {
                    existing.main_file = Some(main_file.to_string());
                    write_room_meta(project_path, &existing)?;
                }
            }
        }
        return Ok(existing);
    }

    let room_id = requested.unwrap_or_else(|| Uuid::new_v4().to_string());
    let meta = RoomMeta {
        room_id,
        main_file: Some(main_file.to_string()),
    };
    write_room_meta(project_path, &meta)?;
    Ok(meta)
}

/// Lists `.tex` files below `root` (relative, `/`-separated, sorted), skipping hidden
/// folders and common build/dependency directories.
pub fn list_tex_files(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    walk_tex_files(root, root, 0, &mut found);
    found.sort();
    found
}

fn walk_tex_files(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            if depth < MAX_SCAN_DEPTH && !SKIPPED_DIRS.contains(&name.as_str()) {
                walk_tex_files(root, &path, depth + 1, out);
            }
        } else if name.to_lowercase().ends_with(".tex") {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// Picks the root `.tex` file of a project.
///
/// Priority: explicit `preferred` → `room.json` → `main.tex` → the first `.tex` that
/// declares a `\documentclass` → the first `.tex` at all. Returns `None` for an
/// empty project.
pub fn detect_main_file(
    project_path: &Path,
    preferred: Option<&str>,
    room_meta: Option<&RoomMeta>,
    tex_files: &[String],
) -> Option<String> {
    let exists = |rel: &str| resolve_inside(project_path, rel).map(|p| p.is_file()).unwrap_or(false);

    if let Some(p) = preferred.filter(|p| exists(p)) {
        return Some(p.to_string());
    }
    if let Some(p) = room_meta.and_then(|m| m.main_file.as_deref()).filter(|p| exists(p)) {
        return Some(p.to_string());
    }
    if exists(DEFAULT_MAIN_FILE) {
        return Some(DEFAULT_MAIN_FILE.to_string());
    }
    for rel in tex_files {
        if let Ok(content) = fs::read_to_string(project_path.join(rel)) {
            if content.contains("\\documentclass") {
                return Some(rel.clone());
            }
        }
    }
    tex_files.first().cloned()
}

/// Open a project folder. Does NOT create `.texcollab/`; creates a starter `main.tex`
/// only when the folder has no `.tex` file at all.
pub fn read_project(project_path: &str, preferred_main: Option<&str>) -> Result<ProjectData, String> {
    let path = PathBuf::from(project_path);
    if !path.is_dir() {
        return Err(format!("Not a directory: {project_path}"));
    }

    let room_meta = read_room_meta(&path)?;
    let mut tex_files = list_tex_files(&path);
    let main_file = match detect_main_file(&path, preferred_main, room_meta.as_ref(), &tex_files) {
        Some(m) => m,
        None => {
            write_atomic(&path.join(DEFAULT_MAIN_FILE), STARTER_TEX.as_bytes())
                .map_err(|e| format!("Failed to create main.tex: {e}"))?;
            tex_files = vec![DEFAULT_MAIN_FILE.to_string()];
            DEFAULT_MAIN_FILE.to_string()
        }
    };

    let main_path = resolve_inside(&path, &main_file)?;
    let tex_content =
        fs::read_to_string(&main_path).map_err(|e| format!("Failed to read {main_file}: {e}"))?;

    let crdt_state = if room_meta.is_some() {
        let crdt_path = path.join(COLLAB_DIR).join(CRDT_FILE);
        if crdt_path.exists() {
            Some(fs::read(&crdt_path).map_err(|e| format!("Failed to read crdt_state.bin: {e}"))?)
        } else {
            None
        }
    } else {
        None
    };

    Ok(ProjectData {
        project_path: project_path.to_string(),
        main_file,
        tex_files,
        tex_content,
        is_collab: room_meta.is_some(),
        room_id: room_meta.map(|m| m.room_id),
        crdt_state,
        cloud: cloud::detect(&path),
    })
}

/// A file to write when scaffolding a new project (path relative to the project).
#[derive(Deserialize, Clone, Debug)]
pub struct ProjectFile {
    pub path: String,
    pub content: String,
}

fn valid_project_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 120
        && !trimmed.starts_with('.')
        && !trimmed.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control())
}

/// Creates `<parent_dir>/<name>` with the given files (e.g. from a template) and
/// returns the new project path. Refuses to touch an existing, non-empty folder.
pub fn create_project(parent_dir: &str, name: &str, files: &[ProjectFile]) -> Result<String, String> {
    let parent = PathBuf::from(parent_dir);
    if !parent.is_dir() {
        return Err(format!("Not a directory: {parent_dir}"));
    }
    if !valid_project_name(name) {
        return Err(format!("Invalid project name: '{name}'"));
    }
    let name = name.trim();
    let dir = parent.join(name);
    if dir.exists() {
        let non_empty = fs::read_dir(&dir).map(|mut d| d.next().is_some()).unwrap_or(true);
        if non_empty {
            return Err(format!("A non-empty folder named '{name}' already exists here"));
        }
    }
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create project folder: {e}"))?;
    if !files.iter().any(|f| f.path.to_lowercase().ends_with(".tex")) {
        return Err("A project needs at least one .tex file".to_string());
    }
    for file in files {
        let path = resolve_inside(&dir, &file.path)?;
        write_atomic(&path, file.content.as_bytes()).map_err(|e| format!("Failed to write {}: {e}", file.path))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Atomically save the root TeX file. Returns whether bytes were actually written.
pub fn save_tex(project_path: &str, main_file: &str, content: &str) -> Result<bool, String> {
    let dir = PathBuf::from(project_path);
    let tex_path = resolve_inside(&dir, main_file)?;
    write_atomic(&tex_path, content.as_bytes()).map_err(|e| format!("Failed to save {main_file}: {e}"))
}

/// Atomically persist the binary CRDT state to `.texcollab/crdt_state.bin`.
pub fn save_crdt(project_path: &str, crdt_binary: &[u8]) -> Result<bool, String> {
    let state_path = PathBuf::from(project_path).join(COLLAB_DIR).join(CRDT_FILE);
    write_atomic(&state_path, crdt_binary).map_err(|e| format!("Failed to save crdt_state.bin: {e}"))
}

/// A node in the project file tree.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ProjectNode {
    pub name: String,
    /// Path relative to the project root, using forward slashes (`/`).
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<ProjectNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// File extensions that are intermediate/build artifacts, not user project files.
const BUILD_ARTIFACT_EXTENSIONS: &[&str] = &[
    "aux", "log", "tmp", "out", "toc", "lof", "lot", "fls", "fdb_latexmk", "synctex.gz",
    "xdv", "nav", "snm", "bcf", "run.xml", "blg", "idx", "ilg", "ind",
];

pub fn is_artifact_or_ignored(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    let lower = name.to_lowercase();
    for ext in BUILD_ARTIFACT_EXTENSIONS {
        if lower.ends_with(&format!(".{ext}")) {
            return true;
        }
    }
    false
}

/// Recursively builds the file tree for `project_path`, skipping hidden files/directories,
/// ignored build directories (`node_modules`, `target`, etc.), and intermediate build artifacts.
pub fn list_project_files(project_path: &str) -> Result<Vec<ProjectNode>, String> {
    let root = PathBuf::from(project_path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {project_path}"));
    }
    walk_tree(&root, &root, 0)
}

fn walk_tree(root: &Path, current_dir: &Path, depth: usize) -> Result<Vec<ProjectNode>, String> {
    if depth > 10 {
        return Ok(Vec::new());
    }
    let mut nodes = Vec::new();
    let entries = fs::read_dir(current_dir)
        .map_err(|e| format!("Failed to read directory {}: {e}", current_dir.display()))?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let rel_path = match path.strip_prefix(root) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        if path.is_dir() {
            if SKIPPED_DIRS.contains(&name.as_str()) {
                continue;
            }
            let children = walk_tree(root, &path, depth + 1)?;
            nodes.push(ProjectNode {
                name,
                path: rel_path,
                is_dir: true,
                children: Some(children),
                size: None,
            });
        } else if path.is_file() {
            if is_artifact_or_ignored(&name) {
                continue;
            }
            let size = entry.metadata().ok().map(|m| m.len());
            nodes.push(ProjectNode {
                name,
                path: rel_path,
                is_dir: false,
                children: None,
                size,
            });
        }
    }

    // Folders first (alphabetical), then files (alphabetical)
    nodes.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(nodes)
}

/// Safely read an arbitrary text file within the project.
pub fn read_project_file(project_path: &str, rel_path: &str) -> Result<String, String> {
    let dir = PathBuf::from(project_path);
    let target = resolve_inside(&dir, rel_path)?;
    fs::read_to_string(&target).map_err(|e| format!("Failed to read {rel_path}: {e}"))
}

/// Safely write/save an arbitrary file within the project atomically.
pub fn save_project_file(project_path: &str, rel_path: &str, content: &str) -> Result<bool, String> {
    let dir = PathBuf::from(project_path);
    let target = resolve_inside(&dir, rel_path)?;
    write_atomic(&target, content.as_bytes()).map_err(|e| format!("Failed to save {rel_path}: {e}"))
}

/// Safely create a new file or directory inside the project.
pub fn create_project_node(project_path: &str, rel_path: &str, is_dir: bool) -> Result<(), String> {
    let dir = PathBuf::from(project_path);
    let target = resolve_inside(&dir, rel_path)?;
    if target.exists() {
        return Err(format!("'{rel_path}' already exists"));
    }
    if is_dir {
        fs::create_dir_all(&target).map_err(|e| format!("Failed to create folder {rel_path}: {e}"))?;
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directory: {e}"))?;
        }
        let initial_content = if rel_path.to_lowercase().ends_with(".tex") {
            "\\section{}\n"
        } else {
            ""
        };
        write_atomic(&target, initial_content.as_bytes())
            .map_err(|e| format!("Failed to create file {rel_path}: {e}"))?;
    }
    Ok(())
}

/// Safely delete a file or directory within the project. Rejects deleting the project root itself.
pub fn delete_project_node(project_path: &str, rel_path: &str) -> Result<(), String> {
    let dir = PathBuf::from(project_path);
    let target = resolve_inside(&dir, rel_path)?;
    // Protection: never delete the root project directory itself
    if target == dir {
        return Err("Cannot delete the project root directory".to_string());
    }
    if !target.exists() {
        return Err(format!("'{rel_path}' does not exist"));
    }
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("Failed to delete folder {rel_path}: {e}"))?;
    } else {
        fs::remove_file(&target).map_err(|e| format!("Failed to delete file {rel_path}: {e}"))?;
    }
    Ok(())
}

/// Safely rename a file or directory within the project.
pub fn rename_project_node(project_path: &str, old_rel_path: &str, new_rel_path: &str) -> Result<(), String> {
    let dir = PathBuf::from(project_path);
    let old_target = resolve_inside(&dir, old_rel_path)?;
    let new_target = resolve_inside(&dir, new_rel_path)?;
    if old_target == dir || new_target == dir {
        return Err("Cannot rename the project root directory".to_string());
    }
    if !old_target.exists() {
        return Err(format!("'{old_rel_path}' does not exist"));
    }
    if new_target.exists() {
        return Err(format!("'{new_rel_path}' already exists"));
    }
    if let Some(parent) = new_target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directory: {e}"))?;
    }
    fs::rename(&old_target, &new_target).map_err(|e| format!("Failed to rename {old_rel_path} to {new_rel_path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("project_{name}_{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ensure_room_meta_generates_uuid_once_and_keeps_it() {
        let dir = temp_project("room_meta");
        let first = ensure_room_meta(&dir, None, "main.tex").unwrap();
        assert!(Uuid::parse_str(&first.room_id).is_ok());
        assert_eq!(first.main_file.as_deref(), Some("main.tex"));
        assert!(dir.join(COLLAB_DIR).join(ROOM_FILE).exists());

        // Opening it again (no requested room, other main file) keeps the existing room.
        let second = ensure_room_meta(&dir, None, "other.tex").unwrap();
        assert_eq!(first, second);
        // Re-joining the same room is a no-op.
        let same = ensure_room_meta(&dir, Some(&first.room_id.to_uppercase()), "other.tex").unwrap();
        assert_eq!(first, same);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn explicit_join_switches_a_folder_from_another_room_and_drops_its_crdt_state() {
        let dir = temp_project("rejoin");
        let old = ensure_room_meta(&dir, None, "thesis.tex").unwrap();
        fs::write(dir.join(COLLAB_DIR).join(CRDT_FILE), b"old room state").unwrap();

        let wanted = "4a3d7332-2a79-4643-8050-f75def979876";
        let joined = ensure_room_meta(&dir, Some(wanted), "main.tex").unwrap();
        assert_ne!(joined.room_id, old.room_id);
        assert_eq!(joined.room_id, wanted);
        assert_eq!(joined.main_file.as_deref(), Some("thesis.tex"), "root file of the folder is kept");
        assert_eq!(read_room_meta(&dir).unwrap().unwrap(), joined);
        assert!(!dir.join(COLLAB_DIR).join(CRDT_FILE).exists(), "stale CRDT state must be dropped");

        // A bad ID never touches the existing room.
        assert!(ensure_room_meta(&dir, Some("nope"), "main.tex").is_err());
        assert_eq!(read_room_meta(&dir).unwrap().unwrap().room_id, wanted);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_room_meta_joins_requested_room_and_rejects_garbage() {
        let dir = temp_project("join");
        let wanted = "3B241101-E2BB-4255-8CAF-4136C566A962";
        let meta = ensure_room_meta(&dir, Some(wanted), "main.tex").unwrap();
        assert_eq!(meta.room_id, wanted.to_lowercase());

        let bad = temp_project("join_bad");
        assert!(ensure_room_meta(&bad, Some("not-a-uuid"), "main.tex").is_err());
        assert!(!bad.join(COLLAB_DIR).exists(), "no .texcollab must be created on failure");

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&bad);
    }

    #[test]
    fn ensure_room_meta_upgrades_legacy_room_json_without_main_file() {
        let dir = temp_project("legacy");
        fs::create_dir_all(dir.join(COLLAB_DIR)).unwrap();
        fs::write(
            dir.join(COLLAB_DIR).join(ROOM_FILE),
            r#"{"room_id":"11111111-2222-3333-4444-555555555555"}"#,
        )
        .unwrap();

        let meta = ensure_room_meta(&dir, None, "thesis.tex").unwrap();
        assert_eq!(meta.room_id, "11111111-2222-3333-4444-555555555555");
        assert_eq!(meta.main_file.as_deref(), Some("thesis.tex"));
        let reread = read_room_meta(&dir).unwrap().unwrap();
        assert_eq!(reread, meta);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_project_creates_starter_only_for_empty_folder_and_stays_solo() {
        let dir = temp_project("solo");
        let proj = read_project(dir.to_str().unwrap(), None).unwrap();

        assert_eq!(proj.main_file, "main.tex");
        assert_eq!(proj.tex_files, vec!["main.tex".to_string()]);
        assert!(proj.tex_content.contains("\\documentclass{article}"));
        assert!(!dir.join(COLLAB_DIR).exists());
        assert!(!proj.is_collab);
        assert!(proj.room_id.is_none());
        assert!(proj.crdt_state.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_main_file_prefers_documentclass_when_main_tex_is_absent() {
        let dir = temp_project("detect");
        fs::create_dir_all(dir.join("chapters")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("chapters/intro.tex"), "\\section{Intro}").unwrap();
        fs::write(dir.join("thesis.tex"), "\\documentclass{book}").unwrap();
        fs::write(dir.join("abstract.tex"), "plain text").unwrap();
        fs::write(dir.join(".git/hidden.tex"), "\\documentclass{x}").unwrap();
        fs::write(dir.join("node_modules/pkg/dep.tex"), "\\documentclass{x}").unwrap();

        let proj = read_project(dir.to_str().unwrap(), None).unwrap();
        assert_eq!(proj.tex_files, vec!["abstract.tex", "chapters/intro.tex", "thesis.tex"]);
        assert_eq!(proj.main_file, "thesis.tex");
        assert!(!dir.join("main.tex").exists(), "no starter when .tex files exist");

        // An explicit preference wins, a bogus one is ignored.
        let proj2 = read_project(dir.to_str().unwrap(), Some("chapters/intro.tex")).unwrap();
        assert_eq!(proj2.main_file, "chapters/intro.tex");
        assert_eq!(proj2.tex_content, "\\section{Intro}");
        let proj3 = read_project(dir.to_str().unwrap(), Some("missing.tex")).unwrap();
        assert_eq!(proj3.main_file, "thesis.tex");
        assert!(read_project(dir.to_str().unwrap(), Some("../etc/passwd")).map(|p| p.main_file == "thesis.tex").unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn room_json_main_file_is_honoured_when_opening_collab_project() {
        let dir = temp_project("room_main");
        fs::write(dir.join("main.tex"), "\\documentclass{article}").unwrap();
        fs::write(dir.join("paper.tex"), "\\documentclass{article}\npaper").unwrap();
        ensure_room_meta(&dir, None, "paper.tex").unwrap();

        let proj = read_project(dir.to_str().unwrap(), None).unwrap();
        assert!(proj.is_collab);
        assert_eq!(proj.main_file, "paper.tex", "room.json must override the main.tex default");
        assert!(proj.tex_content.ends_with("paper"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_project_scaffolds_files_and_rejects_bad_input() {
        let parent = temp_project("create_parent");
        let files = vec![
            ProjectFile { path: "main.tex".into(), content: "\\documentclass{article}\\begin{document}x\\end{document}".into() },
            ProjectFile { path: "chapters/intro.tex".into(), content: "intro".into() },
            ProjectFile { path: "refs.bib".into(), content: "@book{k, title={T}}".into() },
        ];
        let path = create_project(parent.to_str().unwrap(), "  My Thesis ", &files).unwrap();
        let dir = PathBuf::from(&path);
        assert_eq!(dir.file_name().unwrap(), "My Thesis");
        assert_eq!(fs::read_to_string(dir.join("chapters/intro.tex")).unwrap(), "intro");
        let opened = read_project(&path, None).unwrap();
        assert_eq!(opened.main_file, "main.tex");
        assert_eq!(opened.tex_files, vec!["chapters/intro.tex", "main.tex"]);

        // Existing non-empty folder, bad names, escaping paths, no .tex file.
        assert!(create_project(parent.to_str().unwrap(), "My Thesis", &files).is_err());
        for bad in ["", "   ", ".hidden", "a/b", "a\\b", "x:y"] {
            assert!(create_project(parent.to_str().unwrap(), bad, &files).is_err(), "{bad:?} must be rejected");
        }
        let escaping = vec![ProjectFile { path: "../evil.tex".into(), content: "x".into() }];
        assert!(create_project(parent.to_str().unwrap(), "Evil", &escaping).is_err());
        let no_tex = vec![ProjectFile { path: "notes.txt".into(), content: "x".into() }];
        assert!(create_project(parent.to_str().unwrap(), "NoTex", &no_tex).is_err());
        assert!(create_project("/definitely/missing/dir", "X", &files).is_err());
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn save_tex_and_crdt_roundtrip_and_skip_identical_writes() {
        let dir = temp_project("save");
        let dir_str = dir.to_str().unwrap();
        read_project(dir_str, None).unwrap();

        let content = "\\documentclass{article}\n\\begin{document}\nModified\n\\end{document}";
        assert!(save_tex(dir_str, "main.tex", content).unwrap());
        assert!(!save_tex(dir_str, "main.tex", content).unwrap(), "identical content is not rewritten");
        assert_eq!(fs::read_to_string(dir.join("main.tex")).unwrap(), content);
        assert!(!dir.join(COLLAB_DIR).exists(), "solo save must not create .texcollab");
        assert!(save_tex(dir_str, "../escape.tex", "x").is_err());

        let room = ensure_room_meta(&dir, None, "main.tex").unwrap();
        let crdt = vec![0x00, 0x01, 0xFF, 0xFE];
        assert!(save_crdt(dir_str, &crdt).unwrap());
        assert!(!save_crdt(dir_str, &crdt).unwrap());

        let reloaded = read_project(dir_str, None).unwrap();
        assert!(reloaded.is_collab);
        assert_eq!(reloaded.room_id, Some(room.room_id));
        assert_eq!(reloaded.tex_content, content);
        assert_eq!(reloaded.crdt_state, Some(crdt));

        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .chain(fs::read_dir(dir.join(COLLAB_DIR)).unwrap())
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_project_files_recurses_and_filters_artifacts_and_hidden() {
        let dir = temp_project("tree");
        let dir_str = dir.to_str().unwrap();

        // Create structure:
        // main.tex
        // chapters/
        //   ch1.tex
        //   sub/
        //     deep.tex
        // figures/
        //   plot.png
        // references.bib
        // .git/ (should be ignored)
        // .texcollab/ (should be ignored)
        // build.log (should be ignored)
        // temp.aux (should be ignored)
        fs::write(dir.join("main.tex"), "\\documentclass{article}").unwrap();
        fs::create_dir_all(dir.join("chapters").join("sub")).unwrap();
        fs::write(dir.join("chapters").join("ch1.tex"), "\\section{1}").unwrap();
        fs::write(dir.join("chapters").join("sub").join("deep.tex"), "\\subsection{Deep}").unwrap();
        fs::create_dir_all(dir.join("figures")).unwrap();
        fs::write(dir.join("figures").join("plot.png"), b"pngdata").unwrap();
        fs::write(dir.join("references.bib"), "@article{...}").unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git").join("config"), "git config").unwrap();
        fs::create_dir_all(dir.join(".texcollab")).unwrap();
        fs::write(dir.join(".texcollab").join("room.json"), "{}").unwrap();
        fs::write(dir.join("build.log"), "latex log").unwrap();
        fs::write(dir.join("main.aux"), "aux").unwrap();

        let tree = list_project_files(dir_str).unwrap();

        // Verify root level: folders chapters, figures first, then main.tex, references.bib
        let names: Vec<_> = tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["chapters", "figures", "main.tex", "references.bib"]);

        // Verify chapters directory
        let chapters_node = tree.iter().find(|n| n.name == "chapters").unwrap();
        assert!(chapters_node.is_dir);
        let ch_children = chapters_node.children.as_ref().unwrap();
        let ch_names: Vec<_> = ch_children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(ch_names, vec!["sub", "ch1.tex"]);

        let sub_node = ch_children.iter().find(|n| n.name == "sub").unwrap();
        let sub_children = sub_node.children.as_ref().unwrap();
        assert_eq!(sub_children.len(), 1);
        assert_eq!(sub_children[0].name, "deep.tex");
        assert_eq!(sub_children[0].path, "chapters/sub/deep.tex");

        // Verify figures
        let figures_node = tree.iter().find(|n| n.name == "figures").unwrap();
        let fig_children = figures_node.children.as_ref().unwrap();
        assert_eq!(fig_children.len(), 1);
        assert_eq!(fig_children[0].name, "plot.png");
        assert_eq!(fig_children[0].path, "figures/plot.png");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_file_read_write_create_rename_delete() {
        let dir = temp_project("file_ops");
        let dir_str = dir.to_str().unwrap();

        // Create directory
        create_project_node(dir_str, "notes", true).unwrap();
        assert!(dir.join("notes").is_dir());

        // Create file inside notes
        create_project_node(dir_str, "notes/todo.txt", false).unwrap();
        assert!(dir.join("notes/todo.txt").is_file());

        // Save content
        assert!(save_project_file(dir_str, "notes/todo.txt", "task 1").unwrap());
        // Read content
        assert_eq!(read_project_file(dir_str, "notes/todo.txt").unwrap(), "task 1");

        // Rename file
        rename_project_node(dir_str, "notes/todo.txt", "notes/done.txt").unwrap();
        assert!(!dir.join("notes/todo.txt").exists());
        assert!(dir.join("notes/done.txt").exists());
        assert_eq!(read_project_file(dir_str, "notes/done.txt").unwrap(), "task 1");

        // Delete file
        delete_project_node(dir_str, "notes/done.txt").unwrap();
        assert!(!dir.join("notes/done.txt").exists());

        // Delete folder
        delete_project_node(dir_str, "notes").unwrap();
        assert!(!dir.join("notes").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_file_operations_reject_traversal_and_root_destruction() {
        let dir = temp_project("security");
        let dir_str = dir.to_str().unwrap();

        assert!(create_project_node(dir_str, "../outside.txt", false).is_err());
        assert!(read_project_file(dir_str, "../outside.txt").is_err());
        assert!(save_project_file(dir_str, "../outside.txt", "x").is_err());
        assert!(rename_project_node(dir_str, "a.tex", "../b.tex").is_err());
        assert!(delete_project_node(dir_str, "../outside.txt").is_err());

        // Cannot delete root
        assert!(delete_project_node(dir_str, ".").is_err());

        let _ = fs::remove_dir_all(&dir);
    }
}
