//! Detects which desktop sync client (Google Drive, OneDrive, Dropbox, iCloud Drive,
//! Box) keeps a project folder in the cloud, from the folder path alone.
//!
//! Detection is a pure function over the path string so it can be tested for every
//! OS on any OS: `\` and `/` are both separators and names compare case-insensitively.

use serde::Serialize;
use std::path::Path;

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

    #[test]
    fn empty_and_relative_paths_are_local() {
        assert_eq!(classify_path(""), CloudLocation::local());
        assert_eq!(classify_path("thesis"), CloudLocation::local());
    }
}
