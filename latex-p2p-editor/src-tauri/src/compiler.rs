//! Local LaTeX compilation pipeline.
//!
//! * Compiler discovery works on macOS, Linux and Windows: the process PATH is
//!   augmented with the usual install locations of Homebrew, Cargo, MacTeX,
//!   TeX Live and MiKTeX, and the first available engine (tectonic, then pdflatex)
//!   is used.
//! * Every project compiles inside a stable per-project cache directory under the
//!   OS temp dir. Assets are synced incrementally (size + mtime), so compiling a
//!   project with hundreds of megabytes of figures copies them once, not on every
//!   keystroke, and the engine can reuse its own intermediates (`.aux`, `.bbl`…).
//! * The engine runs with a hard timeout so a hung process never freezes the app.
//! * TeX cannot typeset incrementally, so large documents get three shortcuts that
//!   only touch the *build copy* of the root file (never the project): an
//!   "active chapter" build (`\includeonly`, the other chapters' `.aux` files in
//!   the cache keep numbering right), a precompiled preamble (`.fmt` dumped with
//!   `mylatexformat.ltx`, pdflatex only) and draft mode (`\documentclass[draft]`).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crate::fsutil::{fnv1a64, resolve_inside};

/// Name of the per-project asset manifest kept inside the build directory.
const MANIFEST_FILE: &str = ".assets-manifest.json";
/// Top-level folder for all build directories inside the OS temp dir.
const BUILD_ROOT_NAME: &str = "latex-p2p-editor";
/// Default hard limit for one compiler run.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);

/// Precompiled preambles are named `<PREAMBLE_FORMAT_PREFIX><hash>.fmt`.
const PREAMBLE_FORMAT_PREFIX: &str = "preamble-";
/// How many precompiled preambles (per root file) survive a new dump. A `.fmt`
/// weighs 10-30 MB, so the cache must not keep one per preamble edit forever.
const PREAMBLE_FORMATS_KEPT: usize = 3;

/// Directories that are never copied into the build cache.
const SKIPPED_DIRS: &[&str] = &["node_modules", "target", "__pycache__"];
/// File extensions that are build artifacts, never project assets.
const ARTIFACT_EXTENSIONS: &[&str] = &[
    "aux", "log", "tmp", "out", "toc", "lof", "lot", "fls", "fdb_latexmk", "synctex.gz", "xdv",
    "nav", "snm", "bcf", "run.xml", "blg", "idx", "ilg", "ind",
];

// ─── Compiler discovery ─────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Tectonic,
    PdfLatex,
}

impl Engine {
    pub fn binary(self) -> &'static str {
        match self {
            Engine::Tectonic => "tectonic",
            Engine::PdfLatex => "pdflatex",
        }
    }
}

/// What the frontend needs to know about the available compiler.
#[derive(Serialize, Clone, Debug)]
pub struct CompilerInfo {
    /// `"macos"`, `"windows"` or `"linux"` (lets the UI localize install instructions).
    pub os: &'static str,
    /// `"tectonic"`, `"pdflatex"` or `null` when nothing was found.
    pub name: Option<String>,
    pub path: Option<String>,
    pub version: Option<String>,
    /// Human-readable, OS-specific installation instructions.
    pub install_hint: String,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Enumerates `<root>/<year>/bin/<arch>` style TeX Live layouts.
fn texlive_bin_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let Ok(years) = fs::read_dir(root) else { return dirs };
    let mut years: Vec<PathBuf> = years.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    years.sort();
    years.reverse(); // newest release first
    for year in years {
        if let Ok(archs) = fs::read_dir(year.join("bin")) {
            for arch in archs.flatten() {
                if arch.path().is_dir() {
                    dirs.push(arch.path());
                }
            }
        }
    }
    dirs
}

/// Well-known tool locations for the current OS, most specific first.
pub fn candidate_tool_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let home = home_dir();

    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/Library/TeX/texbin"));
        dirs.push(PathBuf::from("/opt/local/bin"));
        dirs.extend(texlive_bin_dirs(Path::new("/usr/local/texlive")));
    } else if cfg!(target_os = "windows") {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&local).join("Programs/MiKTeX/miktex/bin/x64"));
            dirs.push(PathBuf::from(&local).join("Programs/MiKTeX/miktex/bin"));
        }
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(pf) = std::env::var_os(var) {
                dirs.push(PathBuf::from(&pf).join("MiKTeX/miktex/bin/x64"));
                dirs.push(PathBuf::from(&pf).join("MiKTeX/miktex/bin"));
            }
        }
        dirs.extend(texlive_bin_dirs(Path::new("C:\\texlive")));
        if let Some(choco) = std::env::var_os("ChocolateyInstall") {
            dirs.push(PathBuf::from(choco).join("bin"));
        }
        if let Some(h) = &home {
            dirs.push(h.join("scoop/shims"));
        }
    } else {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/snap/bin"));
        dirs.extend(texlive_bin_dirs(Path::new("/usr/local/texlive")));
        dirs.extend(texlive_bin_dirs(Path::new("/opt/texlive")));
        if let Some(h) = &home {
            dirs.push(h.join(".TinyTeX/bin/x86_64-linux"));
        }
    }

    if let Some(h) = &home {
        dirs.push(h.join(".cargo/bin"));
        dirs.push(h.join(".local/bin"));
    }

    dirs.retain(|d| d.is_dir());
    dirs
}

/// PATH for child processes: the inherited PATH plus every existing candidate dir.
/// Desktop apps launched from Finder/Explorer inherit a minimal PATH, which is why
/// this cannot rely on the user's shell configuration.
pub fn augmented_path() -> OsString {
    let inherited: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let mut entries: Vec<PathBuf> = Vec::new();
    for dir in inherited.into_iter().chain(candidate_tool_dirs()) {
        if !dir.as_os_str().is_empty() && !entries.iter().any(|e| e == &dir) {
            entries.push(dir);
        }
    }
    std::env::join_paths(entries).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

/// Finds an executable by name in the augmented PATH (handles `.exe`/`.cmd`/`.bat` on Windows).
pub fn find_executable(name: &str) -> Option<PathBuf> {
    let path = augmented_path();
    let candidates: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd"), format!("{name}.bat"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&path) {
        for candidate in &candidates {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

pub fn current_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

pub fn install_hint() -> String {
    match current_os() {
        "macos" => "No LaTeX engine found. Install Tectonic with `brew install tectonic` (recommended) \
                    or MacTeX from https://tug.org/mactex/, then restart the app."
            .to_string(),
        "windows" => "No LaTeX engine found. Install Tectonic (`winget install TectonicTypesetting.Tectonic`) \
                      or MiKTeX from https://miktex.org/download, then restart the app."
            .to_string(),
        _ => "No LaTeX engine found. Install Tectonic (`cargo install tectonic` or your distribution's package) \
              or TeX Live (`sudo apt install texlive-latex-base`), then restart the app."
            .to_string(),
    }
}

fn configure_command(cmd: &mut Command) {
    cmd.env("PATH", augmented_path())
        .env("max_print_line", "10000")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Returns the first available engine, if any.
pub fn find_engine() -> Option<(Engine, PathBuf)> {
    [Engine::Tectonic, Engine::PdfLatex]
        .into_iter()
        .find_map(|engine| find_executable(engine.binary()).map(|p| (engine, p)))
}

pub fn detect_compiler() -> CompilerInfo {
    match find_engine() {
        Some((engine, path)) => {
            let mut cmd = Command::new(&path);
            cmd.arg("--version");
            configure_command(&mut cmd);
            let version = run_with_timeout(cmd, Duration::from_secs(10))
                .ok()
                .map(|r| r.stdout)
                .and_then(|out| out.lines().next().map(|l| l.trim().to_string()))
                .filter(|v| !v.is_empty());
            CompilerInfo {
                os: current_os(),
                name: Some(engine.binary().to_string()),
                path: Some(path.to_string_lossy().into_owned()),
                version,
                install_hint: install_hint(),
            }
        }
        None => CompilerInfo {
            os: current_os(),
            name: None,
            path: None,
            version: None,
            install_hint: install_hint(),
        },
    }
}

// ─── Process execution with timeout ─────────────────────────────────

#[derive(Debug)]
pub struct RunResult {
    pub success: bool,
    pub status: String,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Runs a command, draining stdout/stderr concurrently (no pipe deadlocks), and
/// kills it — together with any child it spawned — once `timeout` elapses.
/// Output captured before a kill is preserved.
pub fn run_with_timeout(mut cmd: Command, timeout: Duration) -> io::Result<RunResult> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group so a timeout can take down grandchildren too.
        cmd.process_group(0);
    }
    let mut child = cmd.spawn()?;

    enum Chunk {
        Out(Vec<u8>),
        Err(Vec<u8>),
    }
    let (tx, rx) = std::sync::mpsc::channel::<Chunk>();
    if let Some(mut pipe) = child.stdout.take() {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 || tx.send(Chunk::Out(buf[..n].to_vec())).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(mut pipe) = child.stderr.take() {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 || tx.send(Chunk::Err(buf[..n].to_vec())).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut drain = |chunk: Chunk| match chunk {
        Chunk::Out(b) => stdout.extend_from_slice(&b),
        Chunk::Err(b) => stderr.extend_from_slice(&b),
    };

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        while let Ok(chunk) = rx.try_recv() {
            drain(chunk);
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            kill_process_tree(&mut child);
            break child.wait()?;
        }
        thread::sleep(Duration::from_millis(25));
    };

    // The engine has exited; give the pipes a moment to deliver the tail of the
    // output. A grandchild still holding the pipe (after a kill) must not block us.
    let grace = if timed_out { Duration::from_millis(500) } else { Duration::from_secs(5) };
    let deadline = Instant::now() + grace;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(chunk) => drain(chunk),
            Err(_) => break, // disconnected (both readers done) or grace elapsed
        }
    }

    Ok(RunResult {
        success: status.success() && !timed_out,
        status: status.to_string(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        timed_out,
    })
}

fn kill_process_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // SAFETY: killpg on the child's own process group (set via process_group(0)).
        unsafe {
            libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
        }
    }
    let _ = child.kill();
}

// ─── Build directory & incremental asset sync ───────────────────────

/// Root folder holding every per-project build directory.
pub fn build_root() -> PathBuf {
    std::env::temp_dir().join(BUILD_ROOT_NAME)
}

/// Stable build directory for a project path (same project → same cache).
pub fn build_dir_for(project_path: &str) -> PathBuf {
    build_root().join(format!("build-{:016x}", fnv1a64(project_path)))
}

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq, Eq)]
struct AssetRecord {
    len: u64,
    mtime_ms: u128,
    /// Copied from the room's asset cache rather than the project folder.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    cached: bool,
}

type Manifest = BTreeMap<String, AssetRecord>;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SyncStats {
    pub copied: usize,
    pub unchanged: usize,
    pub removed: usize,
    /// Assets taken from the room cache (received from peers) because the project
    /// folder does not have them.
    pub from_cache: usize,
}

pub(crate) fn is_skipped_dir(name: &str) -> bool {
    SKIPPED_DIRS.contains(&name)
}

pub(crate) fn is_artifact(name: &str) -> bool {
    let lower = name.to_lowercase();
    ARTIFACT_EXTENSIONS.iter().any(|ext| lower.ends_with(&format!(".{ext}")))
}

fn record_for(meta: &fs::Metadata) -> AssetRecord {
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    AssetRecord { len: meta.len(), mtime_ms, cached: false }
}

pub(crate) fn walk_assets(root: &Path, dir: &Path, exclude: &Path, out: &mut Vec<(String, PathBuf, fs::Metadata)>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIPPED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let meta = entry.metadata()?;
        if meta.is_dir() {
            walk_assets(root, &path, exclude, out)?;
        } else if meta.is_file() {
            if path == exclude || is_artifact(&name) {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or(name);
            out.push((rel, path, meta));
        }
    }
    Ok(())
}

/// Mirrors project assets into `dst`, copying only new/changed files and deleting
/// files that were previously synced but no longer exist in the project. Build
/// artifacts already in `dst` are left alone so the engine can reuse them.
/// `exclude_main` is the root TeX file, which is written from memory instead.
/// `overlay` is the room's asset cache: its files fill in whatever the project
/// folder lacks; a local file with the same path always wins.
pub fn sync_assets(src: &Path, dst: &Path, exclude_main: &Path, overlay: Option<&Path>) -> io::Result<SyncStats> {
    fs::create_dir_all(dst)?;
    let manifest_path = dst.join(MANIFEST_FILE);
    let previous: Manifest = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let mut assets = Vec::new();
    if src.is_dir() {
        walk_assets(src, src, exclude_main, &mut assets)?;
    }

    let mut sources: Vec<(String, PathBuf, fs::Metadata, bool)> =
        assets.into_iter().map(|(rel, path, meta)| (rel, path, meta, false)).collect();
    if let Some(cache) = overlay.filter(|c| c.is_dir()) {
        let local: std::collections::HashSet<String> = sources.iter().map(|(rel, ..)| rel.clone()).collect();
        let main_rel = exclude_main.strip_prefix(src).unwrap_or(exclude_main);
        let mut cached = Vec::new();
        walk_assets(cache, cache, &cache.join(main_rel), &mut cached)?;
        sources.extend(
            cached
                .into_iter()
                .filter(|(rel, ..)| !local.contains(rel))
                .map(|(rel, path, meta)| (rel, path, meta, true)),
        );
    }

    let mut stats = SyncStats::default();
    let mut next: Manifest = BTreeMap::new();
    for (rel, path, meta, from_cache) in sources {
        let record = AssetRecord { cached: from_cache, ..record_for(&meta) };
        if from_cache {
            stats.from_cache += 1;
        }
        let target = dst.join(&rel);
        let unchanged = previous.get(&rel) == Some(&record) && target.is_file();
        if unchanged {
            stats.unchanged += 1;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&path, &target)?;
            stats.copied += 1;
        }
        next.insert(rel, record);
    }

    for stale in previous.keys().filter(|k| !next.contains_key(*k)) {
        if fs::remove_file(dst.join(stale)).is_ok() {
            stats.removed += 1;
        }
    }

    let json = serde_json::to_string(&next).map_err(io::Error::other)?;
    fs::write(&manifest_path, json)?;
    Ok(stats)
}

// ─── Build options & root-file rewriting ────────────────────────────
//
// Every rewrite below keeps the line numbers of the original file: the engine's
// `file:line` error locations must still point at the right line in the editor.

/// Per-build switches chosen in the UI. They only affect the copy of the root
/// file written into the build cache; the project folder is never modified.
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct BuildOptions {
    /// Typeset only this `\include`d chapter (the path exactly as written in
    /// `\include{…}`). The other chapters' `.aux` files left in the cache by the
    /// last full build keep numbering, page numbers and cross-references right.
    pub include_only: Option<String>,
    /// Add `draft` to the `\documentclass` options: figures become frames,
    /// overfull boxes are marked, many packages skip expensive work.
    pub draft: bool,
    /// Reuse a precompiled preamble (`.fmt`). pdflatex only; ignored (with a note
    /// in the logs) for engines that cannot load custom formats, such as tectonic.
    pub precompiled_preamble: bool,
}

/// How the precompiled preamble was handled in a build (reported to the UI).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PreambleStatus {
    /// Not requested.
    Off,
    /// Requested, but the engine cannot load custom formats (tectonic).
    Unsupported,
    /// A format for this exact preamble already existed and was loaded.
    Reused,
    /// The format was dumped during this build (first build after a preamble change).
    Created,
    /// Dumping or loading the format failed; the document was built normally.
    Failed,
}

/// Returns `line` without its TeX comment (a `%` not escaped by a backslash).
fn code_part(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'%' => return &line[..i],
            _ => i += 1,
        }
    }
    line
}

/// Byte offset of the first `needle` that is real code (not inside a comment).
fn find_in_code(tex: &str, needle: &str) -> Option<usize> {
    let mut offset = 0;
    for line in tex.split_inclusive('\n') {
        if let Some(pos) = code_part(line).find(needle) {
            return Some(offset + pos);
        }
        offset += line.len();
    }
    None
}

/// Every `\include{…}` argument of a root file, in document order. Comments are
/// ignored and `\includeonly` / `\includegraphics` do not count.
pub fn find_includes(tex: &str) -> Vec<String> {
    const CMD: &str = "\\include";
    let mut out = Vec::new();
    for line in tex.lines() {
        let mut rest = code_part(line);
        while let Some(pos) = rest.find(CMD) {
            rest = &rest[pos + CMD.len()..];
            let arg = rest.trim_start_matches([' ', '\t']);
            if let Some(body) = arg.strip_prefix('{') {
                if let Some(end) = body.find('}') {
                    let name = body[..end].trim();
                    if !name.is_empty() {
                        out.push(name.to_string());
                    }
                    rest = &body[end + 1..];
                }
            }
        }
    }
    out
}

/// Build copy for an "active chapter" build: `\includeonly{chapter}` is placed in
/// the preamble (on the `\begin{document}` line, so no line shifts). Existing
/// `\includeonly` commands are redirected to `chapter` instead, so ours wins.
/// Returns `None` when `chapter` is not `\include`d or there is no `\begin{document}`.
pub fn apply_include_only(tex: &str, chapter: &str) -> Option<String> {
    const CMD: &str = "\\includeonly{";
    if !find_includes(tex).iter().any(|c| c == chapter) {
        return None;
    }
    let directive = format!("\\includeonly{{{chapter}}}");
    let mut out = String::with_capacity(tex.len() + directive.len());
    let mut redirected = false;
    for line in tex.split_inclusive('\n') {
        let code = code_part(line);
        let mut rest = code;
        while let Some(pos) = rest.find(CMD) {
            let Some(end) = rest[pos..].find('}') else { break };
            out.push_str(&rest[..pos]);
            out.push_str(&directive);
            rest = &rest[pos + end + 1..];
            redirected = true;
        }
        out.push_str(rest);
        out.push_str(&line[code.len()..]); // the comment, untouched
    }
    if redirected {
        return Some(out);
    }
    let at = find_in_code(&out, "\\begin{document}")?;
    out.insert_str(at, &directive);
    Some(out)
}

/// Build copy with `draft` added to the `\documentclass` options. A `final`
/// option is turned into `draft` (classes let `final` win otherwise). Returns the
/// text unchanged when `draft` is already there and `None` without `\documentclass`.
pub fn apply_draft(tex: &str) -> Option<String> {
    const CMD: &str = "\\documentclass";
    let at = find_in_code(tex, CMD)?;
    let after = at + CMD.len();
    let rest = &tex[after..];
    let trimmed = rest.trim_start();
    let mut out = String::with_capacity(tex.len() + 8);
    if let Some(options) = trimmed.strip_prefix('[') {
        let open = after + (rest.len() - trimmed.len()) + 1;
        let close = open + options.find(']')?;
        let list = &tex[open..close];
        let has = |opt: &str| list.split(',').any(|o| o.trim() == opt);
        if has("draft") {
            return Some(tex.to_string());
        }
        out.push_str(&tex[..open]);
        if has("final") {
            let swapped: Vec<String> = list
                .split(',')
                .map(|o| if o.trim() == "final" { o.replace("final", "draft") } else { o.to_string() })
                .collect();
            out.push_str(&swapped.join(","));
        } else {
            out.push_str("draft,");
            out.push_str(list);
        }
        out.push_str(&tex[close..]);
    } else {
        out.push_str(&tex[..after]);
        out.push_str("[draft]");
        out.push_str(rest);
    }
    Some(out)
}

/// Splits a root file at its first real `\begin{document}`: `(preamble, rest)`,
/// where `rest` starts with `\begin{document}`.
pub fn split_preamble(tex: &str) -> Option<(&str, &str)> {
    let at = find_in_code(tex, "\\begin{document}")?;
    Some((&tex[..at], &tex[at..]))
}

/// Identifies the engine binary (path, size, mtime): formats dumped by one TeX
/// release must not be loaded by another.
fn engine_stamp(exe: &Path) -> String {
    let meta = fs::metadata(exe).ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}|{len}|{mtime}", exe.display())
}

/// Name (without extension) of the format caching `preamble` for one engine build:
/// same preamble + same engine → same name, so the `.fmt` is found and reused.
pub fn preamble_format_name(preamble: &str, engine_stamp: &str) -> String {
    format!("{PREAMBLE_FORMAT_PREFIX}{:016x}", fnv1a64(&format!("{engine_stamp}\n{preamble}")))
}

/// Root file as pdflatex must see it to load a precompiled preamble: the first
/// line becomes the `%&<format>` directive. The format skips the preamble anyway
/// (mylatexformat scans up to the `\begin{document}` line and executes that line),
/// and *replacing* a line keeps every line number intact. `None` when
/// `\begin{document}` is on the first line: there is nothing worth precompiling.
pub fn apply_preamble_format(tex: &str, fmt_name: &str) -> Option<String> {
    let at = find_in_code(tex, "\\begin{document}")?;
    let first_line_end = tex.find('\n')?;
    if first_line_end > at {
        return None;
    }
    Some(format!("%&{fmt_name}{}", &tex[first_line_end..]))
}

/// Dumps `<fmt_name>.fmt` in `main_dir` from `preamble` with `mylatexformat.ltx`
/// (shipped with TeX Live and MiKTeX). The source given to the ini run is the
/// bare preamble plus `\begin{document}`, so neither `\includeonly` nor anything
/// else from the body can leak into the format. The run uses the document's job
/// name (`stem`), so preamble code that expands `\jobname` eagerly (tikz
/// externalize prefixes, minted cache dirs…) sees the same value as a normal
/// build; the resulting files are then renamed after the preamble hash.
fn dump_preamble_format(
    exe: &Path,
    main_dir: &Path,
    stem: &str,
    fmt_name: &str,
    preamble: &str,
    timeout: Duration,
) -> io::Result<RunResult> {
    let src_name = format!("{fmt_name}.tex");
    fs::write(main_dir.join(&src_name), format!("{preamble}\\begin{{document}}\n"))?;
    let mut cmd = Command::new(exe);
    cmd.args(["-ini", "-interaction=nonstopmode", "-file-line-error"])
        .arg(format!("-jobname={stem}"))
        .args(["&pdflatex", "mylatexformat.ltx", &src_name])
        .current_dir(main_dir);
    configure_command(&mut cmd);
    let result = run_with_timeout(cmd, timeout);
    let _ = fs::remove_file(main_dir.join(&src_name));
    let _ = fs::rename(main_dir.join(format!("{stem}.log")), main_dir.join(format!("{fmt_name}.log")));
    let dumped = main_dir.join(format!("{stem}.fmt"));
    if dumped.is_file() {
        fs::rename(&dumped, main_dir.join(format!("{fmt_name}.fmt")))?;
    }
    result
}

/// The engine refused the `%&` format: stale after a TeX upgrade, truncated, or
/// not found by the distribution. The caller discards it and builds normally.
fn format_load_failed(output: &str) -> bool {
    output.contains("Fatal format file error") || output.contains("I can't find the format file")
}

/// Keeps the newest `PREAMBLE_FORMATS_KEPT` formats (always including `keep`),
/// deleting older `.fmt` files and their `.log`.
fn prune_formats(main_dir: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(main_dir) else { return };
    let mut formats: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|e| e == "fmt")
                && p.file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.starts_with(PREAMBLE_FORMAT_PREFIX) && s != keep)
        })
        .map(|p| {
            let mtime = fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            (mtime, p)
        })
        .collect();
    formats.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    for (_, path) in formats.into_iter().skip(PREAMBLE_FORMATS_KEPT.saturating_sub(1)) {
        let _ = fs::remove_file(path.with_extension("log"));
        let _ = fs::remove_file(path);
    }
}

// ─── Compilation ────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct CompileOutput {
    /// `true` when the engine exited successfully.
    pub success: bool,
    /// `"tectonic"` or `"pdflatex"`.
    pub compiler: String,
    /// Combined, trimmed stdout + stderr of the engine (plus pipeline notes).
    pub logs: String,
    /// Absolute path of the produced PDF inside the build cache, if one exists
    /// (pdflatex can emit a PDF even when it reports errors).
    pub pdf_path: Option<String>,
    pub duration_ms: u64,
    pub timed_out: bool,
    /// `"full"` or `"chapter"`: what was actually typeset (a requested chapter that
    /// the root file does not `\include` falls back to `"full"`, with a note).
    pub mode: String,
    /// The chapter typeset in `"chapter"` mode.
    pub chapter: Option<String>,
    /// `true` when `draft` was injected into the build copy.
    pub draft: bool,
    pub preamble: PreambleStatus,
}

fn engine_command(engine: Engine, exe: &Path, file_name: &str, cwd: &Path) -> Command {
    let mut cmd = Command::new(exe);
    match engine {
        Engine::Tectonic => {
            cmd.args(["-X", "compile", "--keep-intermediates", "--keep-logs", file_name]);
        }
        Engine::PdfLatex => {
            cmd.args(["-interaction=nonstopmode", "-file-line-error", "-synctex=0", file_name]);
        }
    }
    cmd.current_dir(cwd);
    configure_command(&mut cmd);
    cmd
}

fn needs_rerun(log: &str) -> bool {
    log.contains("Rerun to get") || log.contains("Rerun LaTeX") || log.contains("There were undefined references")
}

/// Writes `text` as the root file of the build and runs the engine (pdflatex gets a
/// second pass when the first one asks for it).
fn run_engine_passes(
    engine: Engine,
    exe: &Path,
    build_main: &Path,
    pdf_path: &Path,
    file_name: &str,
    main_dir: &Path,
    text: &str,
    started: Instant,
    timeout: Duration,
) -> Result<Vec<RunResult>, String> {
    fs::write(build_main, text).map_err(|e| format!("Failed to write TeX source to build cache: {e}"))?;
    // A stale PDF from a previous successful build must never be mistaken for this run's output.
    let _ = fs::remove_file(pdf_path);

    let mut passes: Vec<RunResult> = Vec::new();
    let max_passes = if engine == Engine::PdfLatex { 2 } else { 1 };
    for pass in 0..max_passes {
        let remaining = timeout.saturating_sub(started.elapsed());
        let cmd = engine_command(engine, exe, file_name, main_dir);
        let result = run_with_timeout(cmd, remaining).map_err(|e| format!("Failed to execute {}: {e}", engine.binary()))?;
        let rerun = result.success && pass + 1 < max_passes && needs_rerun(&result.stdout);
        passes.push(result);
        if !rerun {
            break;
        }
    }
    Ok(passes)
}

/// [`compile_with_assets`] without a room asset cache.
#[cfg(test)]
pub fn compile(
    project_path: &str,
    main_file: &str,
    tex_content: &str,
    options: &BuildOptions,
    timeout: Duration,
) -> Result<CompileOutput, String> {
    compile_with_assets(project_path, main_file, tex_content, options, timeout, None)
}

/// Compiles `tex_content` as `main_file` of the project at `project_path`.
/// `asset_cache` is the room's cache of files received from peers; it is merged
/// into the build directory underneath the project's own files.
///
/// Returns `Err` only for infrastructure problems (no engine installed, I/O errors).
/// LaTeX errors are reported through `CompileOutput { success: false, logs, .. }`.
pub fn compile_with_assets(
    project_path: &str,
    main_file: &str,
    tex_content: &str,
    options: &BuildOptions,
    timeout: Duration,
    asset_cache: Option<&Path>,
) -> Result<CompileOutput, String> {
    let (engine, exe) = find_engine().ok_or_else(install_hint)?;

    let project_dir = PathBuf::from(project_path);
    let build_dir = build_dir_for(project_path);
    fs::create_dir_all(&build_dir).map_err(|e| format!("Failed to create build directory: {e}"))?;

    let main_rel = resolve_inside(Path::new(""), main_file)?; // validates the relative path
    let project_main = project_dir.join(&main_rel);
    let build_main = build_dir.join(&main_rel);
    let main_dir = build_main.parent().map(Path::to_path_buf).unwrap_or_else(|| build_dir.clone());
    let file_name = build_main
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("Invalid main file: {main_file}"))?;
    let stem = Path::new(&file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "main".to_string());
    let pdf_path = main_dir.join(format!("{stem}.pdf"));

    let started = Instant::now();
    let stats = sync_assets(&project_dir, &build_dir, &project_main, asset_cache)
        .map_err(|e| format!("Failed to sync project assets into build cache: {e}"))?;
    fs::create_dir_all(&main_dir).map_err(|e| format!("Failed to create build directory: {e}"))?;

    // ── Build copy of the root file (the project file itself is never touched) ──
    let mut notes: Vec<String> = Vec::new();
    let mut build_text = tex_content.to_string();
    let mut draft = false;
    if options.draft {
        match apply_draft(&build_text) {
            Some(text) => {
                build_text = text;
                draft = true;
            }
            None => notes.push("Draft mode requested but no \\documentclass was found; built without it.".to_string()),
        }
    }
    let mut chapter: Option<String> = None;
    if let Some(wanted) = options.include_only.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        match apply_include_only(&build_text, wanted) {
            Some(text) => {
                build_text = text;
                chapter = Some(wanted.to_string());
            }
            None => notes.push(format!(
                "Chapter \"{wanted}\" is not \\include'd by the root file; the whole document was built."
            )),
        }
    }

    // ── Precompiled preamble (pdflatex only) ──
    let mut preamble = PreambleStatus::Off;
    let mut format: Option<(String, String)> = None; // (format name, root file with the %& line)
    if options.precompiled_preamble {
        if engine != Engine::PdfLatex {
            preamble = PreambleStatus::Unsupported;
            notes.push(format!(
                "Precompiled preamble: {} cannot load custom formats; built normally.",
                engine.binary()
            ));
        } else if let Some((preamble_src, _)) = split_preamble(&build_text) {
            let fmt_name = preamble_format_name(preamble_src, &engine_stamp(&exe));
            let fmt_path = main_dir.join(format!("{fmt_name}.fmt"));
            if fmt_path.is_file() {
                preamble = PreambleStatus::Reused;
            } else {
                let remaining = timeout.saturating_sub(started.elapsed());
                match dump_preamble_format(&exe, &main_dir, &stem, &fmt_name, preamble_src, remaining) {
                    Ok(run) if run.success && fmt_path.is_file() => {
                        preamble = PreambleStatus::Created;
                        prune_formats(&main_dir, &fmt_name);
                        notes.push(format!("Precompiled preamble: dumped {fmt_name}.fmt for this preamble."));
                    }
                    Ok(run) => {
                        let _ = fs::remove_file(&fmt_path);
                        preamble = PreambleStatus::Failed;
                        let tail: String = run.stdout.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | ");
                        notes.push(format!(
                            "Precompiled preamble: format creation failed ({}); built normally. {fmt_name}.log is in the build cache. {tail}",
                            if run.timed_out { "timed out".to_string() } else { run.status.clone() }
                        ));
                    }
                    Err(e) => {
                        preamble = PreambleStatus::Failed;
                        notes.push(format!("Precompiled preamble: could not run the format dump ({e}); built normally."));
                    }
                }
            }
            if matches!(preamble, PreambleStatus::Reused | PreambleStatus::Created) {
                match apply_preamble_format(&build_text, &fmt_name) {
                    Some(text) => format = Some((fmt_name, text)),
                    None => {
                        preamble = PreambleStatus::Off;
                        notes.push("Precompiled preamble: the preamble fits on the first line; nothing to precompile.".to_string());
                    }
                }
            }
        } else {
            preamble = PreambleStatus::Failed;
            notes.push("Precompiled preamble: no \\begin{document} found; built normally.".to_string());
        }
    }

    let mut passes = run_engine_passes(
        engine,
        &exe,
        &build_main,
        &pdf_path,
        &file_name,
        &main_dir,
        format.as_ref().map(|(_, text)| text.as_str()).unwrap_or(&build_text),
        started,
        timeout,
    )?;
    if let Some((fmt_name, _)) = &format {
        if passes.iter().any(|p| format_load_failed(&p.stdout) || format_load_failed(&p.stderr)) {
            let _ = fs::remove_file(main_dir.join(format!("{fmt_name}.fmt")));
            preamble = PreambleStatus::Failed;
            notes.push(format!(
                "Precompiled preamble: {fmt_name}.fmt could not be loaded (stale or incompatible); it was discarded and the document built normally."
            ));
            passes = run_engine_passes(engine, &exe, &build_main, &pdf_path, &file_name, &main_dir, &build_text, started, timeout)?;
        }
    }

    let last = passes.last().expect("at least one pass");
    let duration_ms = started.elapsed().as_millis() as u64;
    let mode = if chapter.is_some() { "chapter" } else { "full" };
    let mut logs = format!(
        "Compiler: {} ({})\nStatus: {}{}\nBuild cache: {}\nAssets: {} copied, {} unchanged, {} removed, {} from peers\nMode: {}{}\nDraft: {}\nPreamble: {}\nPasses: {}\nDuration: {} ms\n",
        engine.binary(),
        exe.display(),
        last.status,
        if last.timed_out { " (TIMED OUT)" } else { "" },
        build_dir.display(),
        stats.copied,
        stats.unchanged,
        stats.removed,
        stats.from_cache,
        mode,
        chapter.as_deref().map(|c| format!(" ({c})")).unwrap_or_default(),
        if draft { "on" } else { "off" },
        serde_json::to_value(preamble).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
        passes.len(),
        duration_ms
    );
    for note in &notes {
        logs.push_str("note: ");
        logs.push_str(note);
        logs.push('\n');
    }
    for (i, pass) in passes.iter().enumerate() {
        if passes.len() > 1 {
            logs.push_str(&format!("\n=== Pass {} ===\n", i + 1));
        }
        logs.push_str("--- OUTPUT ---\n");
        logs.push_str(pass.stdout.trim());
        logs.push('\n');
        if !pass.stderr.trim().is_empty() {
            logs.push_str("--- ERRORS ---\n");
            logs.push_str(pass.stderr.trim());
            logs.push('\n');
        }
    }
    if last.timed_out {
        logs.push_str(&format!(
            "\nThe compilation exceeded the {} s limit and was cancelled.\n",
            timeout.as_secs()
        ));
    }

    Ok(CompileOutput {
        success: last.success,
        compiler: engine.binary().to_string(),
        logs,
        pdf_path: pdf_path.is_file().then(|| pdf_path.to_string_lossy().into_owned()),
        duration_ms,
        timed_out: last.timed_out,
        mode: mode.to_string(),
        chapter,
        draft,
        preamble,
    })
}

/// Reads a file that lives inside the build cache. Any other path is refused so the
/// IPC surface cannot be used to read arbitrary files.
pub fn read_build_file(path: &str) -> Result<Vec<u8>, String> {
    let root = build_root();
    let root_canon = root.canonicalize().map_err(|e| format!("Build cache unavailable: {e}"))?;
    let file_canon = Path::new(path).canonicalize().map_err(|e| format!("File not found: {e}"))?;
    if !file_canon.starts_with(&root_canon) {
        return Err("Refusing to read a file outside the build cache".to_string());
    }
    fs::read(&file_canon).map_err(|e| format!("Failed to read file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("compiler_{name}_{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn augmented_path_keeps_inherited_entries_and_adds_existing_tool_dirs() {
        let path = augmented_path();
        let entries: Vec<PathBuf> = std::env::split_paths(&path).collect();
        for inherited in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
            assert!(entries.contains(&inherited), "inherited PATH entry dropped: {inherited:?}");
        }
        for dir in candidate_tool_dirs() {
            assert!(dir.is_dir());
            assert_eq!(entries.iter().filter(|e| **e == dir).count(), 1, "duplicated entry {dir:?}");
        }
    }

    #[test]
    fn find_executable_locates_a_known_binary_and_rejects_unknown_ones() {
        let known = if cfg!(windows) { "cmd" } else { "sh" };
        let found = find_executable(known).expect("a shell must exist on PATH");
        assert!(found.is_file());
        assert!(find_executable("definitely-not-a-real-binary-xyz").is_none());
    }

    #[test]
    fn run_with_timeout_kills_hung_processes_and_reports_it() {
        if cfg!(windows) {
            return;
        }
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo started; sleep 30 & wait"]);
        let started = Instant::now();
        let result = run_with_timeout(cmd, Duration::from_millis(300)).unwrap();
        assert!(result.timed_out);
        assert!(!result.success);
        assert!(result.stdout.contains("started"));
        assert!(started.elapsed() < Duration::from_secs(5), "process (and its children) were not killed promptly");
    }

    #[test]
    fn sync_assets_is_incremental_filters_artifacts_and_removes_deleted_files() {
        let src = temp_dir("assets_src");
        let dst = temp_dir("assets_dst");
        fs::create_dir_all(src.join("figures")).unwrap();
        fs::create_dir_all(src.join(".git")).unwrap();
        fs::create_dir_all(src.join("node_modules/x")).unwrap();
        fs::write(src.join("figures/plot.png"), b"png").unwrap();
        fs::write(src.join("macros.sty"), b"sty").unwrap();
        fs::write(src.join("refs.bib"), b"bib").unwrap();
        fs::write(src.join("main.tex"), b"root").unwrap();
        fs::write(src.join("main.aux"), b"aux").unwrap();
        fs::write(src.join("main.log"), b"log").unwrap();
        fs::write(src.join("main.synctex.gz"), b"gz").unwrap();
        fs::write(src.join("scratch.tmp"), b"tmp").unwrap();
        fs::write(src.join(".git/secret"), b"s").unwrap();
        fs::write(src.join("node_modules/x/index.js"), b"js").unwrap();

        let first = sync_assets(&src, &dst, &src.join("main.tex"), None).unwrap();
        assert_eq!(first, SyncStats { copied: 3, unchanged: 0, removed: 0, from_cache: 0 });
        assert!(dst.join("figures/plot.png").exists());
        assert!(dst.join("macros.sty").exists());
        assert!(dst.join("refs.bib").exists());
        for excluded in ["main.tex", "main.aux", "main.log", "main.synctex.gz", "scratch.tmp", ".git", "node_modules"] {
            assert!(!dst.join(excluded).exists(), "{excluded} must not be synced");
        }

        // Second run with nothing changed: zero copies.
        let second = sync_assets(&src, &dst, &src.join("main.tex"), None).unwrap();
        assert_eq!(second, SyncStats { copied: 0, unchanged: 3, removed: 0, from_cache: 0 });

        // Artifacts produced by the engine inside the cache must survive a sync.
        fs::write(dst.join("main.aux"), b"engine output").unwrap();
        fs::write(dst.join("main.pdf"), b"%PDF-").unwrap();

        // Change one asset (content + size) and delete another.
        fs::write(src.join("macros.sty"), b"sty v2 longer").unwrap();
        fs::remove_file(src.join("refs.bib")).unwrap();
        let third = sync_assets(&src, &dst, &src.join("main.tex"), None).unwrap();
        assert_eq!(third, SyncStats { copied: 1, unchanged: 1, removed: 1, from_cache: 0 });
        assert_eq!(fs::read(dst.join("macros.sty")).unwrap(), b"sty v2 longer");
        assert!(!dst.join("refs.bib").exists(), "deleted asset must be removed from the cache");
        assert!(dst.join("main.aux").exists());
        assert!(dst.join("main.pdf").exists());

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn sync_assets_merges_the_room_cache_under_local_files() {
        let src = temp_dir("overlay_src");
        let cache = temp_dir("overlay_cache");
        let dst = temp_dir("overlay_dst");
        fs::write(src.join("main.tex"), b"root").unwrap();
        fs::write(src.join("refs.bib"), b"local bib").unwrap();
        fs::create_dir_all(cache.join("imagenes")).unwrap();
        fs::write(cache.join("imagenes/logoUMA.png"), b"from peer").unwrap();
        fs::write(cache.join("refs.bib"), b"peer bib").unwrap();
        fs::write(cache.join("main.tex"), b"never used").unwrap();

        let first = sync_assets(&src, &dst, &src.join("main.tex"), Some(&cache)).unwrap();
        assert_eq!(first, SyncStats { copied: 2, unchanged: 0, removed: 0, from_cache: 1 });
        assert_eq!(fs::read(dst.join("imagenes/logoUMA.png")).unwrap(), b"from peer");
        assert_eq!(fs::read(dst.join("refs.bib")).unwrap(), b"local bib", "local files take precedence");
        assert!(!dst.join("main.tex").exists(), "the root file is never taken from the cache");

        // Unchanged second run; then the user drops their own copy of the logo in the project.
        let second = sync_assets(&src, &dst, &src.join("main.tex"), Some(&cache)).unwrap();
        assert_eq!(second, SyncStats { copied: 0, unchanged: 2, removed: 0, from_cache: 1 });
        fs::create_dir_all(src.join("imagenes")).unwrap();
        fs::write(src.join("imagenes/logoUMA.png"), b"mine").unwrap();
        let third = sync_assets(&src, &dst, &src.join("main.tex"), Some(&cache)).unwrap();
        assert_eq!(third, SyncStats { copied: 1, unchanged: 1, removed: 0, from_cache: 0 });
        assert_eq!(fs::read(dst.join("imagenes/logoUMA.png")).unwrap(), b"mine");

        // Leaving the room (no overlay) drops the files that only came from peers.
        fs::remove_file(src.join("imagenes/logoUMA.png")).unwrap();
        let fourth = sync_assets(&src, &dst, &src.join("main.tex"), None).unwrap();
        assert_eq!(fourth.removed, 1);
        assert!(!dst.join("imagenes/logoUMA.png").exists());

        for d in [&src, &cache, &dst] {
            let _ = fs::remove_dir_all(d);
        }
    }

    #[test]
    fn build_dir_is_stable_per_project_and_distinct_between_projects() {
        assert_eq!(build_dir_for("/a/proj"), build_dir_for("/a/proj"));
        assert_ne!(build_dir_for("/a/proj"), build_dir_for("/a/proj2"));
        assert!(build_dir_for("/a/proj").starts_with(build_root()));
    }

    #[test]
    fn read_build_file_refuses_paths_outside_the_cache() {
        let outside = temp_dir("outside");
        let secret = outside.join("secret.txt");
        fs::write(&secret, b"nope").unwrap();
        assert!(read_build_file(secret.to_str().unwrap()).is_err());

        fs::create_dir_all(build_root()).unwrap();
        let inside = build_root().join(format!("probe-{}.txt", Uuid::new_v4()));
        fs::write(&inside, b"ok").unwrap();
        assert_eq!(read_build_file(inside.to_str().unwrap()).unwrap(), b"ok");

        let _ = fs::remove_file(&inside);
        let _ = fs::remove_dir_all(&outside);
    }

    // ── Root-file rewriting (pure, no engine needed) ──

    const BOOK: &str = "\\documentclass[a4paper,12pt]{report}\n\
                        \\usepackage{graphicx} % \\include{commented/out}\n\
                        %\\includeonly{chapters/old}\n\
                        \\begin{document}\n\
                        \\tableofcontents\n\
                        \\include{chapters/intro}\n\
                        \\include {chapters/methods}\n\
                        \\includegraphics{figures/plot}\n\
                        \\include{chapters/results}\\include{appendix/data}\n\
                        \\end{document}\n";

    #[test]
    fn find_includes_lists_real_includes_in_order_and_ignores_comments_and_lookalikes() {
        assert_eq!(
            find_includes(BOOK),
            vec!["chapters/intro", "chapters/methods", "chapters/results", "appendix/data"]
        );
        assert!(find_includes("\\documentclass{article}\n\\begin{document}\n\\input{a}\n\\end{document}").is_empty());
        assert_eq!(find_includes("\\include{}\\include{ x }"), vec!["x"]);
    }

    #[test]
    fn apply_include_only_targets_the_chapter_without_shifting_lines() {
        let out = apply_include_only(BOOK, "chapters/methods").expect("chapter is included");
        assert_eq!(out.lines().count(), BOOK.lines().count(), "line numbers must stay aligned with the editor");
        assert_eq!(
            out.lines().nth(3).unwrap(),
            "\\includeonly{chapters/methods}\\begin{document}",
            "directive goes on the \\begin{{document}} line"
        );
        // Comments (including the commented-out \includeonly) are untouched.
        assert_eq!(out.lines().nth(2).unwrap(), "%\\includeonly{chapters/old}");
        assert_eq!(out.lines().nth(1).unwrap(), "\\usepackage{graphicx} % \\include{commented/out}");
        assert_eq!(out.matches("\\includeonly{").count(), 2); // ours + the commented one

        // Unknown chapter or no \begin{document}: no chapter build.
        assert!(apply_include_only(BOOK, "chapters/nope").is_none());
        assert!(apply_include_only(BOOK, "commented/out").is_none());
        assert!(apply_include_only("\\include{a}", "a").is_none());
    }

    #[test]
    fn apply_include_only_redirects_an_existing_includeonly() {
        let tex = "\\documentclass{book}\n\\includeonly{ch1,ch2} % keep\n\\begin{document}\n\\include{ch1}\\include{ch2}\\include{ch3}\n\\end{document}\n";
        let out = apply_include_only(tex, "ch3").unwrap();
        assert_eq!(out.lines().nth(1).unwrap(), "\\includeonly{ch3} % keep");
        assert_eq!(out.lines().nth(2).unwrap(), "\\begin{document}", "no second directive is added");
        assert_eq!(out.lines().count(), tex.lines().count());
    }

    #[test]
    fn apply_draft_covers_options_no_options_existing_draft_and_final() {
        assert_eq!(
            apply_draft("\\documentclass[a4paper,12pt]{report}\nx").unwrap(),
            "\\documentclass[draft,a4paper,12pt]{report}\nx"
        );
        assert_eq!(apply_draft("\\documentclass{article}\nx").unwrap(), "\\documentclass[draft]{article}\nx");
        // Multi-line option lists keep their line structure.
        let multi = "\\documentclass[\n  a4paper,\n  final\n]{book}\n\\begin{document}\n\\end{document}\n";
        let out = apply_draft(multi).unwrap();
        assert_eq!(out, "\\documentclass[\n  a4paper,\n  draft\n]{book}\n\\begin{document}\n\\end{document}\n");
        assert_eq!(out.lines().count(), multi.lines().count());
        // Already draft: unchanged. Only a commented \documentclass: not applicable.
        let already = "\\documentclass[draft]{article}\n";
        assert_eq!(apply_draft(already).unwrap(), already);
        assert!(apply_draft("% \\documentclass{article}\nhello").is_none());
        assert!(apply_draft("\\documentclass[a4paper{article}").is_none(), "unterminated option list");
    }

    #[test]
    fn preamble_split_hash_and_format_directive_behave() {
        let (pre, rest) = split_preamble(BOOK).unwrap();
        assert!(pre.ends_with("%\\includeonly{chapters/old}\n"));
        assert!(rest.starts_with("\\begin{document}\n\\tableofcontents"));
        assert!(split_preamble("\\documentclass{article}\n% \\begin{document}\n").is_none());

        let a = preamble_format_name(pre, "pdflatex|1|2");
        assert_eq!(a, preamble_format_name(pre, "pdflatex|1|2"), "deterministic");
        assert!(a.starts_with(PREAMBLE_FORMAT_PREFIX) && a.len() == PREAMBLE_FORMAT_PREFIX.len() + 16);
        assert_ne!(a, preamble_format_name(&format!("{pre}\\usepackage{{amsmath}}\n"), "pdflatex|1|2"), "preamble change");
        assert_ne!(a, preamble_format_name(pre, "pdflatex|1|3"), "engine change");

        let out = apply_preamble_format(BOOK, &a).unwrap();
        assert_eq!(out.lines().count(), BOOK.lines().count());
        assert_eq!(out.lines().next().unwrap(), format!("%&{a}"));
        assert_eq!(out.lines().nth(3).unwrap(), "\\begin{document}");
        assert!(apply_preamble_format("\\documentclass{article}\\begin{document}\nx\n\\end{document}\n", &a).is_none());
        assert!(apply_preamble_format("no document here\n", &a).is_none());

        assert!(format_load_failed("(Fatal format file error; I'm stymied)"));
        assert!(format_load_failed("! I can't find the format file `preamble-1.fmt'!"));
        assert!(!format_load_failed("Output written on main.pdf (3 pages)."));
    }

    #[test]
    fn prune_formats_keeps_the_newest_ones_and_the_current_format() {
        let dir = temp_dir("fmts");
        for (i, name) in ["preamble-a", "preamble-b", "preamble-c", "preamble-d", "preamble-e"].iter().enumerate() {
            fs::write(dir.join(format!("{name}.fmt")), b"fmt").unwrap();
            fs::write(dir.join(format!("{name}.log")), b"log").unwrap();
            let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000 + i as u64 * 60);
            fs::File::open(dir.join(format!("{name}.fmt"))).unwrap().set_modified(t).unwrap();
        }
        fs::write(dir.join("main.fmt"), b"unrelated").unwrap();
        prune_formats(&dir, "preamble-a");
        let mut left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".fmt"))
            .collect();
        left.sort();
        // Current (a) + the two newest others (d, e); unrelated formats untouched.
        assert_eq!(left, vec!["main.fmt", "preamble-a.fmt", "preamble-d.fmt", "preamble-e.fmt"]);
        assert!(!dir.join("preamble-b.log").exists(), "logs of pruned formats go too");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The compile tests need a real engine. They are skipped (with a notice) when
    /// none is installed so the suite stays green on machines without TeX.
    fn engine_available() -> bool {
        if find_engine().is_none() {
            eprintln!("SKIP: no LaTeX engine (tectonic/pdflatex) found on this machine");
            return false;
        }
        true
    }

    #[test]
    fn compile_produces_pdf_without_polluting_the_project_and_reuses_the_cache() {
        if !engine_available() {
            return;
        }
        let dir = temp_dir("compile_ok");
        fs::create_dir_all(dir.join("chapters")).unwrap();
        fs::write(dir.join("chapters/intro.tex"), "Included chapter text.").unwrap();
        let tex = "\\documentclass{article}\n\\begin{document}\nAutomated Compilation Test\n\\input{chapters/intro}\n\\end{document}";

        let out = compile(dir.to_str().unwrap(), "main.tex", tex, &BuildOptions::default(), DEFAULT_TIMEOUT).unwrap();
        assert!(out.success, "logs: {}", out.logs);
        let pdf = out.pdf_path.as_deref().expect("pdf path");
        assert!(fs::read(pdf).unwrap().starts_with(b"%PDF-"));
        assert!(pdf.starts_with(build_dir_for(dir.to_str().unwrap()).to_str().unwrap()));
        for polluted in ["main.aux", "main.log", "main.pdf", "main.tex"] {
            assert!(!dir.join(polluted).exists(), "{polluted} must not appear in the project folder");
        }
        assert!(out.logs.contains("Assets: 1 copied, 0 unchanged"));

        // Second compile: the included chapter is unchanged, nothing is copied again.
        let again = compile(dir.to_str().unwrap(), "main.tex", tex, &BuildOptions::default(), DEFAULT_TIMEOUT).unwrap();
        assert!(again.success);
        assert!(again.logs.contains("Assets: 0 copied, 1 unchanged"));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(build_dir_for(dir.to_str().unwrap()));
    }

    #[test]
    fn compile_reports_latex_errors_as_unsuccessful_output_with_logs() {
        if !engine_available() {
            return;
        }
        let dir = temp_dir("compile_err");
        let broken = "\\documentclass{article}\n\\begin{document}\n\\undefinedMacroDoesNotExistNowhere\n\\end{document}";
        let out = compile(dir.to_str().unwrap(), "main.tex", broken, &BuildOptions::default(), DEFAULT_TIMEOUT).unwrap();
        assert!(!out.success);
        assert!(!out.timed_out);
        assert!(
            out.logs.to_lowercase().contains("undefined control sequence"),
            "logs must surface the LaTeX error: {}",
            out.logs
        );
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(build_dir_for(dir.to_str().unwrap()));
    }

    fn chapter_project(name: &str) -> (PathBuf, &'static str) {
        let dir = temp_dir(name);
        fs::create_dir_all(dir.join("chapters")).unwrap();
        fs::write(dir.join("chapters/one.tex"), "\\chapter{One}\\label{ch:one}\nText one.\n").unwrap();
        fs::write(dir.join("chapters/two.tex"), "\\chapter{Two}\\label{ch:two}\nSee \\ref{ch:one} and \\ref{ch:three}.\n").unwrap();
        fs::write(dir.join("chapters/three.tex"), "\\chapter{Three}\\label{ch:three}\nText three.\n").unwrap();
        let tex = "\\documentclass{report}\n\\begin{document}\n\\tableofcontents\n\\include{chapters/one}\n\\include{chapters/two}\n\\include{chapters/three}\n\\end{document}\n";
        (dir, tex)
    }

    #[test]
    fn compile_active_chapter_typesets_one_chapter_with_numbering_from_the_cached_aux_files() {
        if !engine_available() {
            return;
        }
        let (dir, tex) = chapter_project("compile_chapter");
        let project = dir.to_str().unwrap();
        let build = build_dir_for(project);

        // Full build first: every chapter leaves its .aux in the cache.
        let full = compile(project, "main.tex", tex, &BuildOptions::default(), DEFAULT_TIMEOUT).unwrap();
        assert!(full.success, "logs: {}", full.logs);
        assert_eq!(full.mode, "full");
        assert!(full.chapter.is_none() && !full.draft);
        assert_eq!(full.preamble, PreambleStatus::Off);
        assert!(build.join("chapters/one.aux").is_file() && build.join("chapters/three.aux").is_file());
        let full_pdf = fs::read(full.pdf_path.as_deref().unwrap()).unwrap();

        // Active chapter: only chapters/two is read, numbering continues from chapter one.
        let opts = BuildOptions { include_only: Some("chapters/two".into()), ..Default::default() };
        let part = compile(project, "main.tex", tex, &opts, DEFAULT_TIMEOUT).unwrap();
        assert!(part.success, "logs: {}", part.logs);
        assert_eq!(part.mode, "chapter");
        assert_eq!(part.chapter.as_deref(), Some("chapters/two"));
        assert!(part.logs.contains("Mode: chapter (chapters/two)"));
        let build_main = fs::read_to_string(build.join("main.tex")).unwrap();
        assert_eq!(build_main.lines().nth(1).unwrap(), "\\includeonly{chapters/two}\\begin{document}");
        assert_eq!(build_main.lines().count(), tex.lines().count());
        let two_aux = fs::read_to_string(build.join("chapters/two.aux")).unwrap();
        assert!(two_aux.contains("\\numberline {2}Two"), "chapter numbering must come from one.aux: {two_aux}");
        assert!(two_aux.contains("\\setcounter{chapter}{2}"));
        let log = fs::read_to_string(build.join("main.log")).unwrap();
        assert!(log.contains("chapters/two.tex"), "log: {log}");
        assert!(!log.contains("chapters/one.tex") && !log.contains("chapters/three.tex"), "other chapters must not be typeset");
        let part_pdf = fs::read(part.pdf_path.as_deref().unwrap()).unwrap();
        assert!(part_pdf.starts_with(b"%PDF-") && part_pdf.len() < full_pdf.len());
        // The project folder is untouched.
        assert!(!dir.join("main.tex").exists() && !dir.join("chapters/two.aux").exists());

        // A chapter the root does not include falls back to a full build, with a note.
        let bogus = BuildOptions { include_only: Some("chapters/nope".into()), ..Default::default() };
        let back = compile(project, "main.tex", tex, &bogus, DEFAULT_TIMEOUT).unwrap();
        assert!(back.success);
        assert_eq!(back.mode, "full");
        assert!(back.logs.contains("not \\include'd"));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&build);
    }

    #[test]
    fn compile_draft_mode_changes_only_the_build_copy() {
        if !engine_available() {
            return;
        }
        let dir = temp_dir("compile_draft");
        fs::write(dir.join("main.tex"), "project copy").unwrap();
        let tex = "\\documentclass[a4paper]{article}\n\\begin{document}\nDraft build\n\\end{document}\n";
        let opts = BuildOptions { draft: true, ..Default::default() };
        let out = compile(dir.to_str().unwrap(), "main.tex", tex, &opts, DEFAULT_TIMEOUT).unwrap();
        assert!(out.success, "logs: {}", out.logs);
        assert!(out.draft);
        assert!(out.logs.contains("Draft: on"));
        let build_main = fs::read_to_string(build_dir_for(dir.to_str().unwrap()).join("main.tex")).unwrap();
        assert!(build_main.starts_with("\\documentclass[draft,a4paper]{article}"));
        assert_eq!(fs::read_to_string(dir.join("main.tex")).unwrap(), "project copy");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(build_dir_for(dir.to_str().unwrap()));
    }

    #[test]
    fn compile_precompiled_preamble_is_created_then_reused_or_reported_unsupported() {
        if !engine_available() {
            return;
        }
        let dir = temp_dir("compile_fmt");
        let tex = "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n$a^2$\n\\end{document}\n";
        let opts = BuildOptions { precompiled_preamble: true, ..Default::default() };
        let project = dir.to_str().unwrap();
        let first = compile(project, "main.tex", tex, &opts, DEFAULT_TIMEOUT).unwrap();
        assert!(first.success, "logs: {}", first.logs);
        assert!(first.pdf_path.is_some());
        match find_engine().map(|(e, _)| e) {
            Some(Engine::PdfLatex) => {
                assert!(
                    matches!(first.preamble, PreambleStatus::Created | PreambleStatus::Failed),
                    "logs: {}",
                    first.logs
                );
                if first.preamble == PreambleStatus::Created {
                    let fmts: Vec<_> = fs::read_dir(build_dir_for(project))
                        .unwrap()
                        .flatten()
                        .filter(|e| e.path().extension().is_some_and(|x| x == "fmt"))
                        .collect();
                    assert_eq!(fmts.len(), 1);
                    let build_main = fs::read_to_string(build_dir_for(project).join("main.tex")).unwrap();
                    assert!(build_main.starts_with(&format!("%&{PREAMBLE_FORMAT_PREFIX}")));
                    assert_eq!(build_main.lines().count(), tex.lines().count());
                    let second = compile(project, "main.tex", tex, &opts, DEFAULT_TIMEOUT).unwrap();
                    assert!(second.success, "logs: {}", second.logs);
                    assert_eq!(second.preamble, PreambleStatus::Reused);
                    // A preamble edit means a new format.
                    let edited = tex.replace("amsmath", "amsmath,amssymb");
                    let third = compile(project, "main.tex", &edited, &opts, DEFAULT_TIMEOUT).unwrap();
                    assert!(third.success, "logs: {}", third.logs);
                    assert_eq!(third.preamble, PreambleStatus::Created);
                }
            }
            _ => {
                assert_eq!(first.preamble, PreambleStatus::Unsupported);
                assert!(first.logs.contains("cannot load custom formats"));
            }
        }
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(build_dir_for(project));
    }

    #[test]
    fn compile_uses_chapters_received_from_peers_when_the_project_folder_lacks_them() {
        if !engine_available() {
            eprintln!("skipping: no LaTeX engine installed");
            return;
        }
        let project = temp_dir("guest_project");
        let cache = temp_dir("guest_cache");
        let tex = "\\documentclass{article}\n\\begin{document}\n\\input{chapters/shared}\n\\end{document}\n";
        fs::write(project.join("main.tex"), tex).unwrap();

        let missing = compile(project.to_str().unwrap(), "main.tex", tex, &BuildOptions::default(), DEFAULT_TIMEOUT).unwrap();
        assert!(!missing.success, "without the chapter the build must fail");

        fs::create_dir_all(cache.join("chapters")).unwrap();
        fs::write(cache.join("chapters/shared.tex"), "Text that only the host had.\n").unwrap();
        let out = compile_with_assets(project.to_str().unwrap(), "main.tex", tex, &BuildOptions::default(), DEFAULT_TIMEOUT, Some(&cache)).unwrap();
        assert!(out.success, "{}", out.logs);
        assert!(out.logs.contains("1 from peers"), "{}", out.logs);
        assert!(!project.join("chapters").exists(), "the project folder must stay untouched");

        let _ = fs::remove_dir_all(build_dir_for(project.to_str().unwrap()));
        let _ = fs::remove_dir_all(&project);
        let _ = fs::remove_dir_all(&cache);
    }

    #[test]
    fn compile_honours_nested_main_file() {
        if !engine_available() {
            return;
        }
        let dir = temp_dir("compile_nested");
        fs::create_dir_all(dir.join("paper")).unwrap();
        let tex = "\\documentclass{article}\n\\begin{document}\nNested root\n\\end{document}";
        fs::write(dir.join("paper/thesis.tex"), tex).unwrap();
        let out = compile(dir.to_str().unwrap(), "paper/thesis.tex", tex, &BuildOptions::default(), DEFAULT_TIMEOUT).unwrap();
        assert!(out.success, "logs: {}", out.logs);
        assert!(out.pdf_path.unwrap().ends_with("thesis.pdf"));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(build_dir_for(dir.to_str().unwrap()));
    }
}
