//! Detects which desktop sync client (Google Drive, OneDrive, Dropbox, iCloud Drive,
//! Box) keeps a project folder in the cloud, from the folder path alone.
//!
//! Detection is a pure function over the path string so it can be tested for every
//! OS on any OS: `\` and `/` are both separators and names compare case-insensitively.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Where a project folder lives. `provider` is `"local"` when no sync client was recognised.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct CloudLocation {
    /// `google_drive`, `onedrive`, `dropbox`, `icloud`, `box` or `local`.
    pub provider: String,
    /// Account shown in the sync folder name (an email, `Personal`, a company name), when present.
    pub account: Option<String>,
}

impl CloudLocation {
    fn new(provider: &str, account: Option<&str>) -> Self {
        let account = account.map(str::trim).filter(|a| !a.is_empty()).map(str::to_string);
        Self { provider: provider.to_string(), account }
    }

    pub fn local() -> Self {
        Self::new("local", None)
    }
}

/// Google Drive for desktop's root folder names on Windows ("G:\My Drive"), per UI language.
const GOOGLE_DRIVE_ROOTS: &[&str] = &[
    "my drive",
    "mi unidad",
    "meine ablage",
    "mon drive",
    "il mio drive",
    "meu drive",
    "o meu disco",
    "shared drives",
    "unidades compartidas",
    "geteilte ablagen",
    "drives partagés",
    "drive condivisi",
    "drives compartilhados",
];

fn eq(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// `prefix` stripped case-insensitively, or `None`.
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s.is_char_boundary(prefix.len()) && eq(&s[..prefix.len()], prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

/// "Dropbox (Acme)" → "Acme"; "Dropbox" → None.
fn parenthesised(s: &str) -> Option<&str> {
    let open = s.find('(')?;
    let close = s.rfind(')')?;
    (close > open).then(|| &s[open + 1..close])
}

/// `~/Library/CloudStorage/<Provider>-<account>` (macOS File Provider, all current clients).
fn classify_cloud_storage(name: &str) -> Option<CloudLocation> {
    let (provider, account) = if let Some(rest) = strip_prefix_ci(name, "GoogleDrive") {
        ("google_drive", rest)
    } else if let Some(rest) = strip_prefix_ci(name, "OneDrive") {
        ("onedrive", rest)
    } else if let Some(rest) = strip_prefix_ci(name, "Dropbox") {
        ("dropbox", rest)
    } else if let Some(rest) = strip_prefix_ci(name, "Box") {
        ("box", rest)
    } else if strip_prefix_ci(name, "iCloud").is_some() {
        ("icloud", "")
    } else {
        return None;
    };
    // "Dropbox", "OneDrive-Personal", "Dropbox-Acme", "Dropbox (Acme)", "Box-Box";
    // anything else ("Boxcryptor") is another product.
    let account = if account.is_empty() {
        None
    } else if let Some(a) = account.strip_prefix('-') {
        Some(a)
    } else if account.trim_start().starts_with('(') {
        parenthesised(account)
    } else {
        return None;
    };
    let account = account.filter(|a| !(provider == "box" && eq(a, "Box")));
    Some(CloudLocation::new(provider, account))
}

/// A sync folder directly under the home folder (`~/Dropbox`, `%USERPROFILE%\OneDrive - Acme`).
fn classify_home_child(name: &str) -> Option<CloudLocation> {
    if eq(name, "Google Drive") {
        return Some(CloudLocation::new("google_drive", None));
    }
    if eq(name, "iCloudDrive") || eq(name, "iCloud Drive") {
        return Some(CloudLocation::new("icloud", None));
    }
    if let Some(rest) = strip_prefix_ci(name, "OneDrive") {
        // "OneDrive", "OneDrive - Acme Corp", "OneDrive - Personal".
        let rest = rest.trim_start();
        if rest.is_empty() {
            return Some(CloudLocation::new("onedrive", None));
        }
        return rest.strip_prefix('-').map(|acct| CloudLocation::new("onedrive", Some(acct)));
    }
    for (prefix, provider) in [("Dropbox", "dropbox"), ("Box", "box")] {
        if let Some(rest) = strip_prefix_ci(name, prefix) {
            let rest = rest.trim();
            if rest.is_empty() {
                return Some(CloudLocation::new(provider, None));
            }
            if let Some(acct) = parenthesised(rest).filter(|_| rest.starts_with('(')) {
                return Some(CloudLocation::new(provider, Some(acct)));
            }
        }
    }
    None
}

/// GNOME Online Accounts mount: `/run/user/1000/gvfs/google-drive:host=gmail.com,user=alice`.
fn classify_gvfs(name: &str) -> Option<CloudLocation> {
    let params = strip_prefix_ci(name, "google-drive:")?;
    let mut host = None;
    let mut user = None;
    for kv in params.split(',') {
        match kv.split_once('=') {
            Some(("host", v)) => host = Some(v),
            Some(("user", v)) => user = Some(v),
            _ => {}
        }
    }
    let account = match (user, host) {
        (Some(u), Some(h)) => Some(format!("{u}@{h}")),
        (Some(u), None) => Some(u.to_string()),
        _ => None,
    };
    Some(CloudLocation::new("google_drive", account.as_deref()))
}

/// Classifies a project path. Works on macOS, Windows and Linux paths regardless of the
/// OS it runs on; returns `local` when no known sync folder is part of the path.
pub fn classify_path(path: &str) -> CloudLocation {
    let segs: Vec<&str> = path.split(['/', '\\']).filter(|s| !s.is_empty()).collect();

    for (i, seg) in segs.iter().enumerate() {
        let next = segs.get(i + 1).copied();
        let prev = i.checked_sub(1).map(|p| segs[p]);

        // macOS: ~/Library/CloudStorage/<Provider>-<account>/…
        if eq(seg, "CloudStorage") && prev.is_some_and(|p| eq(p, "Library")) {
            if let Some(loc) = next.and_then(classify_cloud_storage) {
                return loc;
            }
        }
        // macOS iCloud Drive: ~/Library/Mobile Documents/com~apple~CloudDocs/… (and app folders).
        if eq(seg, "Mobile Documents") && prev.is_some_and(|p| eq(p, "Library")) && next.is_some() {
            return CloudLocation::new("icloud", None);
        }
        // macOS, older Google Drive File Stream: /Volumes/GoogleDrive[-<id>]/My Drive/…
        if i == 0 && eq(seg, "Volumes") && next.is_some_and(|n| strip_prefix_ci(n, "GoogleDrive").is_some()) {
            return CloudLocation::new("google_drive", None);
        }
        // Windows: Google Drive for desktop mounts a drive letter, "G:\My Drive\…".
        if i == 0 && seg.len() == 2 && seg.ends_with(':') && next.is_some_and(|n| GOOGLE_DRIVE_ROOTS.iter().any(|r| eq(n, r))) {
            return CloudLocation::new("google_drive", None);
        }
        // Linux: GNOME Online Accounts' gvfs mount.
        if eq(seg, "gvfs") {
            if let Some(loc) = next.and_then(classify_gvfs) {
                return loc;
            }
        }
        // Linux, Insync: ~/Insync/<account>/Google Drive|OneDrive/…
        if eq(seg, "Insync") {
            if let (Some(acct), Some(kind)) = (next, segs.get(i + 2)) {
                if eq(kind, "Google Drive") || eq(kind, "My Drive") {
                    return CloudLocation::new("google_drive", Some(acct));
                }
                if eq(kind, "OneDrive") {
                    return CloudLocation::new("onedrive", Some(acct));
                }
            }
        }
        // Home folder children: /Users/<me>/…, /home/<me>/…, C:\Users\<me>\…
        let after_drive = i == 1 && segs[0].len() == 2 && segs[0].ends_with(':');
        let is_home_root = (eq(seg, "Users") || eq(seg, "home")) && (i == 0 || after_drive);
        if is_home_root {
            if let Some(loc) = segs.get(i + 2).and_then(|child| classify_home_child(child)) {
                return loc;
            }
        }
    }
    CloudLocation::local()
}

/// Classifies `path` as given and, if that finds nothing, its canonical form (a sync
/// folder reached through a symlink such as `~/Google Drive` → `CloudStorage/…`).
pub fn detect(path: &Path) -> CloudLocation {
    let direct = classify_path(&path.to_string_lossy());
    if direct.provider != "local" {
        return direct;
    }
    match path.canonicalize() {
        Ok(real) => classify_path(&real.to_string_lossy()),
        Err(_) => direct,
    }
}


// ─── Installed sync clients & room lookup ───────────────────────────

/// A sync client configured on this machine: the provider and its local root folder(s).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct CloudClient {
    pub provider: String,
    pub roots: Vec<String>,
}

/// Env override for tests and unusual setups: `provider=/path[;provider=/path…]`
/// (`;` or the platform path-list separator). Entries without `provider=` are classified by path.
pub const ROOTS_ENV: &str = "LATEXP2P_CLOUD_ROOTS";

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn children_starting_with(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.file_name().map(|n| strip_prefix_ci(&n.to_string_lossy(), prefix).is_some()).unwrap_or(false))
        .collect();
    out.sort();
    out
}

/// Sync roots that exist on this machine, in a stable order.
pub fn candidate_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(h) = home() {
        if cfg!(target_os = "macos") {
            roots.extend(children_starting_with(&h.join("Library/CloudStorage"), ""));
            roots.push(h.join("Library/Mobile Documents/com~apple~CloudDocs"));
            roots.extend(children_starting_with(Path::new("/Volumes"), "GoogleDrive"));
        }
        if cfg!(target_os = "windows") {
            roots.push(h.join("iCloudDrive"));
            for letter in b'D'..=b'Z' {
                for name in ["My Drive", "Mi unidad", "Shared drives", "Unidades compartidas"] {
                    roots.push(PathBuf::from(format!("{}:\\{}", letter as char, name)));
                }
            }
        }
        roots.extend(children_starting_with(&h, "OneDrive"));
        roots.extend(children_starting_with(&h, "Dropbox"));
        roots.push(h.join("Google Drive"));
        roots.extend(children_starting_with(&h, "Box"));
        if cfg!(target_os = "linux") {
            if let Ok(entries) = fs::read_dir(h.join("Insync")) {
                for acct in entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
                    roots.extend(children_starting_with(&acct, ""));
                }
            }
            if let Ok(uid) = std::env::var("UID") {
                roots.extend(children_starting_with(Path::new(&format!("/run/user/{uid}/gvfs")), "google-drive:"));
            }
        }
    }
    roots.retain(|r| r.is_dir());
    roots.dedup();
    roots
}

/// Parses [`ROOTS_ENV`]: explicit `provider=path` pairs or bare paths classified by name.
pub fn parse_roots_override(value: &str) -> Vec<(String, PathBuf)> {
    value
        .split([';', if cfg!(windows) { ';' } else { ':' }])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|entry| match entry.split_once('=') {
            Some((provider, path)) if !provider.is_empty() && !path.is_empty() => {
                (provider.trim().to_string(), PathBuf::from(path.trim()))
            }
            _ => (classify_path(entry).provider, PathBuf::from(entry)),
        })
        .collect()
}

/// Installed clients = existing sync roots grouped by provider (plus the env override).
pub fn installed_clients() -> Vec<CloudClient> {
    let mut pairs: Vec<(String, PathBuf)> = candidate_roots()
        .into_iter()
        .map(|root| {
            // Classify a child path so home-folder roots (`~/Dropbox`) resolve like project paths.
            let probe = root.join("x");
            (classify_path(&probe.to_string_lossy()).provider, root)
        })
        .collect();
    if let Ok(value) = std::env::var(ROOTS_ENV) {
        pairs.extend(parse_roots_override(&value).into_iter().filter(|(_, p)| p.is_dir()));
    }
    let mut clients: Vec<CloudClient> = Vec::new();
    for (provider, root) in pairs {
        if provider == "local" {
            continue;
        }
        let root = root.to_string_lossy().into_owned();
        match clients.iter_mut().find(|c| c.provider == provider) {
            Some(c) => {
                if !c.roots.contains(&root) {
                    c.roots.push(root);
                }
            }
            None => clients.push(CloudClient { provider, roots: vec![root] }),
        }
    }
    clients
}

/// Folders never descended into while looking for a room.
const SKIP_DIRS: &[&str] = &["node_modules", "target", "Library", "Applications", ".git", "Photos Library.photoslibrary"];

/// Breadth-first search for the folder whose `.texcollab/room.json` has `room_id`.
/// Bounded by depth and by the number of directories visited so a huge Drive never
/// stalls the app. Hidden folders are skipped (except `.texcollab` itself, read directly).
pub fn locate_room(room_id: &str, roots: &[PathBuf], max_depth: usize, max_dirs: usize) -> Option<PathBuf> {
    use std::collections::VecDeque;
    let wanted = room_id.trim().to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    let mut queue: VecDeque<(PathBuf, usize)> = roots.iter().map(|r| (r.clone(), 0)).collect();
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        if visited >= max_dirs {
            break;
        }
        visited += 1;
        let room_file = dir.join(crate::project::COLLAB_DIR).join(crate::project::ROOM_FILE);
        if let Ok(text) = fs::read_to_string(&room_file) {
            if let Ok(meta) = serde_json::from_str::<crate::project::RoomMeta>(&text) {
                if meta.room_id.to_lowercase() == wanted {
                    return Some(dir);
                }
            }
        }
        if depth >= max_depth {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        let mut children: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| {
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str())
            })
            .collect();
        children.sort();
        for child in children {
            queue.push_back((child, depth + 1));
        }
    }
    None
}

/// Default lookup across every installed client (and the env override).
pub fn locate_room_anywhere(room_id: &str) -> Option<PathBuf> {
    let roots: Vec<PathBuf> = installed_clients()
        .into_iter()
        .flat_map(|c| c.roots.into_iter().map(PathBuf::from))
        .collect();
    locate_room(room_id, &roots, 6, 20_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(provider: &str, account: Option<&str>) -> CloudLocation {
        CloudLocation::new(provider, account)
    }

    #[test]
    fn macos_cloud_storage_providers_with_accounts() {
        assert_eq!(
            classify_path("/Users/ana/Library/CloudStorage/GoogleDrive-ana@gmail.com/My Drive/thesis"),
            at("google_drive", Some("ana@gmail.com"))
        );
        assert_eq!(
            classify_path("/Users/ana/Library/CloudStorage/GoogleDrive-ana@uni.edu/Shared drives/Lab/paper"),
            at("google_drive", Some("ana@uni.edu"))
        );
        assert_eq!(
            classify_path("/Users/ana/Library/CloudStorage/OneDrive-Personal/Docs"),
            at("onedrive", Some("Personal"))
        );
        assert_eq!(
            classify_path("/Users/ana/Library/CloudStorage/OneDrive-AcmeCorp/Docs"),
            at("onedrive", Some("AcmeCorp"))
        );
        assert_eq!(classify_path("/Users/ana/Library/CloudStorage/Dropbox/paper"), at("dropbox", None));
        assert_eq!(
            classify_path("/Users/ana/Library/CloudStorage/Dropbox-Acme/paper"),
            at("dropbox", Some("Acme"))
        );
        assert_eq!(
            classify_path("/Users/ana/Library/CloudStorage/Dropbox (Personal)/paper"),
            at("dropbox", Some("Personal"))
        );
        assert_eq!(classify_path("/Users/ana/Library/CloudStorage/Box-Box/paper"), at("box", None));
        assert_eq!(classify_path("/Users/ana/Library/CloudStorage/Boxcryptor/paper"), CloudLocation::local());
    }

    #[test]
    fn macos_icloud_and_legacy_locations() {
        assert_eq!(
            classify_path("/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/Papers/thesis"),
            at("icloud", None)
        );
        assert_eq!(classify_path("/Users/ana/Dropbox/paper"), at("dropbox", None));
        assert_eq!(classify_path("/Users/ana/Google Drive/paper"), at("google_drive", None));
        assert_eq!(classify_path("/Volumes/GoogleDrive/My Drive/paper"), at("google_drive", None));
    }

    #[test]
    fn macos_local_folders() {
        assert_eq!(classify_path("/Users/ana/Documents/thesis"), CloudLocation::local());
        assert_eq!(classify_path("/Users/ana/Library/CloudStorage"), CloudLocation::local());
        assert_eq!(classify_path("/Users/ana/Documents/Dropbox notes"), CloudLocation::local());
        // A folder merely *named* like a provider deeper in the tree is not a sync root.
        assert_eq!(classify_path("/Users/ana/Documents/OneDrive/backup"), CloudLocation::local());
        assert_eq!(classify_path("/Users/ana/Boxes/paper"), CloudLocation::local());
    }

    #[test]
    fn windows_locations() {
        assert_eq!(classify_path(r"G:\My Drive\thesis"), at("google_drive", None));
        assert_eq!(classify_path(r"G:\Mi unidad\tesis"), at("google_drive", None));
        assert_eq!(classify_path(r"H:\Shared drives\Lab\paper"), at("google_drive", None));
        assert_eq!(classify_path(r"C:\Users\ana\OneDrive\Documents\thesis"), at("onedrive", None));
        assert_eq!(
            classify_path(r"C:\Users\ana\OneDrive - Acme Corp\Documents"),
            at("onedrive", Some("Acme Corp"))
        );
        assert_eq!(classify_path(r"C:\Users\ana\Dropbox\paper"), at("dropbox", None));
        assert_eq!(classify_path(r"C:\Users\ana\Dropbox (Acme)\paper"), at("dropbox", Some("Acme")));
        assert_eq!(classify_path(r"C:\Users\ana\iCloudDrive\paper"), at("icloud", None));
        assert_eq!(classify_path(r"C:\Users\ana\Google Drive\paper"), at("google_drive", None));
        assert_eq!(classify_path(r"c:\users\ana\onedrive\x"), at("onedrive", None));
    }

    #[test]
    fn windows_local_folders() {
        assert_eq!(classify_path(r"C:\Users\ana\Documents\thesis"), CloudLocation::local());
        assert_eq!(classify_path(r"D:\Projects\My Drive\x"), CloudLocation::local());
        assert_eq!(classify_path(r"G:\thesis"), CloudLocation::local());
    }

    #[test]
    fn linux_locations() {
        assert_eq!(classify_path("/home/ana/Dropbox/paper"), at("dropbox", None));
        assert_eq!(classify_path("/home/ana/OneDrive/paper"), at("onedrive", None));
        assert_eq!(
            classify_path("/home/ana/Insync/ana@gmail.com/Google Drive/paper"),
            at("google_drive", Some("ana@gmail.com"))
        );
        assert_eq!(
            classify_path("/run/user/1000/gvfs/google-drive:host=gmail.com,user=ana/0AB/paper"),
            at("google_drive", Some("ana@gmail.com"))
        );
        assert_eq!(classify_path("/home/ana/projects/thesis"), CloudLocation::local());
        assert_eq!(classify_path("/srv/home/x/Dropbox"), CloudLocation::local());
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cloud_{name}_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_room(dir: &Path, room_id: &str) {
        let collab = dir.join(crate::project::COLLAB_DIR);
        fs::create_dir_all(&collab).unwrap();
        fs::write(collab.join(crate::project::ROOM_FILE), format!(r#"{{"room_id":"{room_id}","main_file":"main.tex"}}"#)).unwrap();
    }

    #[test]
    fn locate_room_finds_the_matching_folder_and_respects_bounds() {
        let root = temp_root("locate");
        let target = root.join("Shared drives/Lab/thesis");
        fs::create_dir_all(&target).unwrap();
        write_room(&target, "AAAAAAAA-0000-4000-8000-000000000001");
        let decoy = root.join("My Drive/other");
        fs::create_dir_all(&decoy).unwrap();
        write_room(&decoy, "bbbbbbbb-0000-4000-8000-000000000002");
        let hidden = root.join(".Trash/thesis");
        fs::create_dir_all(&hidden).unwrap();
        write_room(&hidden, "cccccccc-0000-4000-8000-000000000003");
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        write_room(&root.join("node_modules/pkg"), "dddddddd-0000-4000-8000-000000000004");

        let roots = vec![root.clone()];
        // Case-insensitive match, depth 3.
        assert_eq!(locate_room("aaaaaaaa-0000-4000-8000-000000000001", &roots, 6, 10_000), Some(target.clone()));
        assert_eq!(locate_room("bbbbbbbb-0000-4000-8000-000000000002", &roots, 6, 10_000), Some(decoy));
        // Hidden and skipped folders are never searched.
        assert_eq!(locate_room("cccccccc-0000-4000-8000-000000000003", &roots, 6, 10_000), None);
        assert_eq!(locate_room("dddddddd-0000-4000-8000-000000000004", &roots, 6, 10_000), None);
        // Depth and directory budgets bound the search.
        assert_eq!(locate_room("aaaaaaaa-0000-4000-8000-000000000001", &roots, 2, 10_000), None);
        assert_eq!(locate_room("aaaaaaaa-0000-4000-8000-000000000001", &roots, 6, 2), None);
        assert_eq!(locate_room("", &roots, 6, 10_000), None);
        assert_eq!(locate_room("nope", &[PathBuf::from("/definitely/missing")], 6, 10_000), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn roots_override_parses_pairs_and_bare_paths() {
        let parsed = parse_roots_override("google_drive=/tmp/gd; /Users/ana/Dropbox ;dropbox= ;=x");
        assert_eq!(parsed[0], ("google_drive".to_string(), PathBuf::from("/tmp/gd")));
        assert_eq!(parsed[1], ("dropbox".to_string(), PathBuf::from("/Users/ana/Dropbox")));
        // Malformed pairs fall back to classification of the raw entry (local → ignored later).
        assert_eq!(parsed[2].0, "local");
        assert_eq!(parsed[3].0, "local");
    }

    #[test]
    fn empty_and_relative_paths_are_local() {
        assert_eq!(classify_path(""), CloudLocation::local());
        assert_eq!(classify_path("thesis"), CloudLocation::local());
    }
}
