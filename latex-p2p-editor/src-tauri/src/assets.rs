//! Project assets shared with the peers of a room.
//!
//! Collaboration only syncs the root `.tex` text. Everything else the build needs
//! (images, `.bib`, `.sty`, `\input`/`\include` chapters) is listed here with a
//! SHA-256 content hash, published by the frontend in the shared Y.Doc and sent
//! on demand to peers that miss it. A guest stores what it receives in a per-room
//! [`AssetCache`] inside the app data dir (never in its project folder), and
//! [`crate::compiler::compile_with_assets`] merges that cache into the build directory with
//! the guest's own local files taking precedence.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use crate::compiler::{is_artifact, is_skipped_dir, walk_assets};
use crate::fsutil::{fnv1a64, resolve_inside, write_atomic};

/// Largest chunk a single `read_chunk` call returns.
pub const MAX_CHUNK_BYTES: u64 = 1024 * 1024;

/// Extensions shared with peers. Anything else in the folder stays private: a guest
/// may join a room from a folder that also holds unrelated documents.
const SHAREABLE_EXTENSIONS: &[&str] = &[
    // TeX sources, packages, bibliography, fonts
    "tex", "ltx", "sty", "cls", "clo", "def", "cfg", "fd", "bib", "bst", "bbx", "cbx", "lbx", "dbx", "ist", "tikz", "pgf",
    "otf", "ttf", "pfb", "tfm", "vf", "afm", "map", "enc", "lua",
    // figures
    "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "eps", "ps", "pdf", "svg", "webp",
    // data and listings pulled in by \input, pgfplots, listings, minted…
    "csv", "tsv", "dat", "txt", "json", "yaml", "yml", "xml", "py", "r", "m", "jl", "c", "h", "cpp", "hpp", "java", "js",
    "ts", "rs", "go", "sql", "sh",
];

/// Most files a project listing returns; the rest is not shared.
pub const MAX_LISTED_ASSETS: usize = 2000;

const INDEX_FILE: &str = "index.json";
const FILES_DIR: &str = "files";

/// One shareable file of a project: path relative to the project root (always
/// `/`-separated), size in bytes and lowercase hex SHA-256 of the content.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AssetEntry {
    pub path: String,
    pub size: u64,
    pub hash: String,
}

/// `(len, mtime)` → hash memo, so periodic rescans only hash files that changed.
type HashMemo = HashMap<PathBuf, (u64, u128, String)>;

fn hash_memo() -> &'static Mutex<HashMemo> {
    static MEMO: OnceLock<Mutex<HashMemo>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_shareable(name: &str) -> bool {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .is_some_and(|ext| SHAREABLE_EXTENSIONS.contains(&ext.as_str()))
}

fn mtime_ms(meta: &fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn memoized_hash(path: &Path, meta: &fs::Metadata) -> io::Result<String> {
    let key = (meta.len(), mtime_ms(meta));
    if let Ok(memo) = hash_memo().lock() {
        if let Some((len, mtime, hash)) = memo.get(path) {
            if (*len, *mtime) == key {
                return Ok(hash.clone());
            }
        }
    }
    let hash = hash_file(path)?;
    if let Ok(mut memo) = hash_memo().lock() {
        memo.insert(path.to_path_buf(), (key.0, key.1, hash.clone()));
    }
    Ok(hash)
}

/// Lists the files of a project that a build may need: the set the compiler mirrors
/// into its build cache (hidden entries, `node_modules`/`target` and build artifacts
/// are skipped), restricted to TeX/figure/data extensions and minus the root file,
/// which travels as CRDT text.
pub fn list_project_assets(project_dir: &Path, main_file: &str) -> Result<Vec<AssetEntry>, String> {
    let main_rel = resolve_inside(Path::new(""), main_file)?;
    let mut found = Vec::new();
    if project_dir.is_dir() {
        walk_assets(project_dir, project_dir, &project_dir.join(main_rel), &mut found)
            .map_err(|e| format!("Failed to list project assets: {e}"))?;
    }
    let mut entries = Vec::with_capacity(found.len());
    found.retain(|(rel, ..)| is_shareable(rel));
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found.truncate(MAX_LISTED_ASSETS);
    for (rel, path, meta) in found {
        // A file that vanishes or cannot be read mid-scan is simply not shared.
        if let Ok(hash) = memoized_hash(&path, &meta) {
            entries.push(AssetEntry { path: rel, size: meta.len(), hash });
        }
    }
    Ok(entries)
}

/// Validates a peer-supplied asset path: relative, no `..`, nothing hidden, no
/// skipped directory, no build artifact and a shareable extension. The result is
/// relative.
pub fn validate_asset_path(rel: &str) -> Result<PathBuf, String> {
    let path = resolve_inside(Path::new(""), rel)?;
    let mut last = None;
    for component in path.components() {
        if let Component::Normal(name) = component {
            let name = name.to_string_lossy();
            if name.starts_with('.') || is_skipped_dir(&name) {
                return Err(format!("Refusing to share '{rel}'"));
            }
            last = Some(name.into_owned());
        }
    }
    match last {
        Some(name) if !is_artifact(&name) && is_shareable(&name) => Ok(path),
        _ => Err(format!("Refusing to share '{rel}'")),
    }
}

fn read_range(path: &Path, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open asset: {e}"))?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| format!("Failed to read asset: {e}"))?;
    let mut buf = Vec::new();
    file.take(length.min(MAX_CHUNK_BYTES))
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read asset: {e}"))?;
    Ok(buf)
}

/// Reads `length` bytes at `offset` of an asset, from the project folder or, when
/// the project does not have it, from the room cache (a guest can relay what it
/// downloaded to a third peer).
pub fn read_chunk(
    project_dir: &Path,
    cache: Option<&AssetCache>,
    rel: &str,
    offset: u64,
    length: u64,
) -> Result<Vec<u8>, String> {
    let rel_path = validate_asset_path(rel)?;
    let local = project_dir.join(&rel_path);
    if local.is_file() {
        return read_range(&local, offset, length);
    }
    if let Some(cached) = cache.map(|c| c.files_dir().join(&rel_path)).filter(|p| p.is_file()) {
        return read_range(&cached, offset, length);
    }
    Err(format!("Asset not found: {rel}"))
}

// ─── Per-room asset cache (app data dir) ────────────────────────────

/// Index updates are read-modify-write; several downloads may finish at once.
fn index_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

type CacheIndex = BTreeMap<String, AssetEntry>;

/// Files received from peers for one room and one local project folder:
/// `<base>/room-<fnv(room, project)>/files/<path>` plus an `index.json` with the
/// hash of every stored file. Keying by the folder too keeps two windows of the
/// same app (host and guest on one machine) from sharing, and pruning, one cache.
#[derive(Clone, Debug)]
pub struct AssetCache {
    root: PathBuf,
}

impl AssetCache {
    pub fn for_room(base: &Path, room_id: &str, project_path: &str) -> Self {
        Self { root: base.join(format!("room-{:016x}", fnv1a64(&format!("{room_id}\n{project_path}")))) }
    }

    /// Directory mirrored into the build cache by the compiler.
    pub fn files_dir(&self) -> PathBuf {
        self.root.join(FILES_DIR)
    }

    fn read_index(&self) -> CacheIndex {
        fs::read_to_string(self.root.join(INDEX_FILE))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write_index(&self, index: &CacheIndex) -> Result<(), String> {
        let json = serde_json::to_string(index).map_err(|e| e.to_string())?;
        write_atomic(&self.root.join(INDEX_FILE), json.as_bytes())
            .map(|_| ())
            .map_err(|e| format!("Failed to write asset cache index: {e}"))
    }

    /// Entries whose file is still present.
    pub fn list(&self) -> Vec<AssetEntry> {
        let files = self.files_dir();
        self.read_index()
            .into_values()
            .filter(|e| files.join(&e.path).is_file())
            .collect()
    }

    /// Stores a downloaded asset after checking its SHA-256 against `hash`.
    pub fn store(&self, rel: &str, hash: &str, bytes: &[u8]) -> Result<AssetEntry, String> {
        let rel_path = validate_asset_path(rel)?;
        let actual = sha256_hex(bytes);
        if !actual.eq_ignore_ascii_case(hash) {
            return Err(format!("Hash mismatch for '{rel}': expected {hash}, got {actual}"));
        }
        let _guard = index_lock().lock().map_err(|_| "asset cache lock poisoned".to_string())?;
        write_atomic(&self.files_dir().join(&rel_path), bytes).map_err(|e| format!("Failed to store asset '{rel}': {e}"))?;
        let entry = AssetEntry { path: rel.to_string(), size: bytes.len() as u64, hash: actual };
        let mut index = self.read_index();
        index.insert(entry.path.clone(), entry.clone());
        self.write_index(&index)?;
        Ok(entry)
    }

    /// Deletes cached files that are not in `keep` (same path and hash), e.g. assets
    /// the room no longer has or older versions. Returns how many were removed.
    pub fn prune(&self, keep: &[AssetEntry]) -> Result<usize, String> {
        let _guard = index_lock().lock().map_err(|_| "asset cache lock poisoned".to_string())?;
        let wanted: HashMap<&str, &str> = keep.iter().map(|e| (e.path.as_str(), e.hash.as_str())).collect();
        let mut index = self.read_index();
        let stale: Vec<String> = index
            .values()
            .filter(|e| wanted.get(e.path.as_str()) != Some(&e.hash.as_str()))
            .map(|e| e.path.clone())
            .collect();
        for path in &stale {
            index.remove(path);
            if validate_asset_path(path).is_ok() {
                let _ = fs::remove_file(self.files_dir().join(path));
            }
        }
        if !stale.is_empty() {
            self.write_index(&index)?;
        }
        Ok(stale.len())
    }
}

/// Decodes a `%XX`-escaped header value (paths travel URI-encoded in IPC headers).
pub fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = input.get(i + 1..i + 3).ok_or("Bad percent-encoding")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "Bad percent-encoding")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Header is not UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("latex_p2p_assets_{name}_{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_shareable_files_with_size_and_sha256_and_skips_root_hidden_and_artifacts() {
        let dir = temp_dir("list");
        fs::create_dir_all(dir.join("imagenes")).unwrap();
        fs::create_dir_all(dir.join("chapters")).unwrap();
        fs::create_dir_all(dir.join(".texcollab")).unwrap();
        fs::write(dir.join("main.tex"), b"root").unwrap();
        fs::write(dir.join("imagenes/logoUMA.png"), b"png-bytes").unwrap();
        fs::write(dir.join("chapters/intro.tex"), b"\\chapter{Intro}").unwrap();
        fs::write(dir.join("refs.bib"), b"@book{x}").unwrap();
        fs::write(dir.join("main.aux"), b"aux").unwrap();
        fs::write(dir.join(".texcollab/crdt_state.bin"), b"crdt").unwrap();
        fs::write(dir.join("tax-return.docx"), b"private").unwrap();
        fs::write(dir.join("Makefile"), b"all:").unwrap();

        let list = list_project_assets(&dir, "main.tex").unwrap();
        let paths: Vec<&str> = list.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["chapters/intro.tex", "imagenes/logoUMA.png", "refs.bib"]);
        let png = &list[1];
        assert_eq!(png.size, 9);
        assert_eq!(png.hash, sha256_hex(b"png-bytes"));
        assert_eq!(png.hash.len(), 64);

        // Rescans pick up changes (the memo is keyed by size + mtime).
        fs::write(dir.join("imagenes/logoUMA.png"), b"png-bytes-v2").unwrap();
        let again = list_project_assets(&dir, "main.tex").unwrap();
        assert_eq!(again[1].hash, sha256_hex(b"png-bytes-v2"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn asset_paths_from_peers_are_validated() {
        assert!(validate_asset_path("imagenes/logo.png").is_ok());
        assert!(validate_asset_path("chapters/intro.tex").is_ok());
        for bad in ["../etc/passwd", "/etc/passwd", ".texcollab/room.json", "a/.git/config", "node_modules/x.js", "main.aux", "notes.docx", "Makefile", ""] {
            assert!(validate_asset_path(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn read_chunk_serves_ranges_from_the_project_then_from_the_cache() {
        let project = temp_dir("chunk_project");
        let base = temp_dir("chunk_cache");
        fs::write(project.join("data.dat"), b"0123456789").unwrap();
        assert_eq!(read_chunk(&project, None, "data.dat", 3, 4).unwrap(), b"3456");
        assert_eq!(read_chunk(&project, None, "data.dat", 8, 100).unwrap(), b"89");
        assert!(read_chunk(&project, None, "missing.png", 0, 4).is_err());
        assert!(read_chunk(&project, None, "../data.dat", 0, 4).is_err());

        let cache = AssetCache::for_room(&base, "room-1", "/p");
        cache.store("fig/relay.png", &sha256_hex(b"relay"), b"relay").unwrap();
        assert_eq!(read_chunk(&project, Some(&cache), "fig/relay.png", 0, 64).unwrap(), b"relay");
        let _ = fs::remove_dir_all(&project);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn cache_verifies_hashes_is_isolated_per_room_and_prunes_stale_entries() {
        let base = temp_dir("cache");
        let cache = AssetCache::for_room(&base, "room-a", "/guest");
        let other = AssetCache::for_room(&base, "room-b", "/guest");
        assert_ne!(cache.files_dir(), other.files_dir());
        assert_ne!(cache.files_dir(), AssetCache::for_room(&base, "room-a", "/host").files_dir());
        assert_eq!(cache.files_dir(), AssetCache::for_room(&base, "room-a", "/guest").files_dir());

        assert!(cache.store("img/a.png", &sha256_hex(b"other"), b"aaa").is_err(), "hash mismatch must be refused");
        assert!(cache.store("../escape.png", &sha256_hex(b"x"), b"x").is_err());

        let a = cache.store("img/a.png", &sha256_hex(b"aaa"), b"aaa").unwrap();
        let b = cache.store("refs.bib", &sha256_hex(b"bib"), b"bib").unwrap();
        assert_eq!(fs::read(cache.files_dir().join("img/a.png")).unwrap(), b"aaa");
        let mut listed = cache.list();
        listed.sort_by(|x, y| x.path.cmp(&y.path));
        assert_eq!(listed, vec![a.clone(), b.clone()]);
        assert!(other.list().is_empty());

        // a.png changed upstream (new hash), refs.bib was deleted upstream.
        let a2 = AssetEntry { hash: sha256_hex(b"aaa2"), size: 4, ..a.clone() };
        assert_eq!(cache.prune(&[a2]).unwrap(), 2);
        assert!(cache.list().is_empty());
        assert!(!cache.files_dir().join("refs.bib").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn percent_decoding_handles_utf8_paths() {
        assert_eq!(percent_decode("im%C3%A1genes/logo%20UMA.png").unwrap(), "imágenes/logo UMA.png");
        assert!(percent_decode("bad%2").is_err());
    }
}
