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
}

type Manifest = BTreeMap<String, AssetRecord>;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SyncStats {
    pub copied: usize,
    pub unchanged: usize,
    pub removed: usize,
}

fn is_artifact(name: &str) -> bool {
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
    AssetRecord { len: meta.len(), mtime_ms }
}

fn walk_assets(root: &Path, dir: &Path, exclude: &Path, out: &mut Vec<(String, PathBuf, fs::Metadata)>) -> io::Result<()> {
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
pub fn sync_assets(src: &Path, dst: &Path, exclude_main: &Path) -> io::Result<SyncStats> {
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

    let mut stats = SyncStats::default();
    let mut next: Manifest = BTreeMap::new();
    for (rel, path, meta) in assets {
        let record = record_for(&meta);
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

/// Compiles `tex_content` as `main_file` of the project at `project_path`.
///
/// Returns `Err` only for infrastructure problems (no engine installed, I/O errors).
/// LaTeX errors are reported through `CompileOutput { success: false, logs, .. }`.
pub fn compile(
    project_path: &str,
    main_file: &str,
    tex_content: &str,
    timeout: Duration,
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
    let stats = sync_assets(&project_dir, &build_dir, &project_main)
        .map_err(|e| format!("Failed to sync project assets into build cache: {e}"))?;
    fs::create_dir_all(&main_dir).map_err(|e| format!("Failed to create build directory: {e}"))?;
    fs::write(&build_main, tex_content).map_err(|e| format!("Failed to write TeX source to build cache: {e}"))?;
    // A stale PDF from a previous successful build must never be mistaken for this run's output.
    let _ = fs::remove_file(&pdf_path);

    let mut passes: Vec<RunResult> = Vec::new();
    let max_passes = if engine == Engine::PdfLatex { 2 } else { 1 };
    for pass in 0..max_passes {
        let remaining = timeout.saturating_sub(started.elapsed());
        let cmd = engine_command(engine, &exe, &file_name, &main_dir);
        let result = run_with_timeout(cmd, remaining).map_err(|e| format!("Failed to execute {}: {e}", engine.binary()))?;
        let rerun = result.success && pass + 1 < max_passes && needs_rerun(&result.stdout);
        passes.push(result);
        if !rerun {
            break;
        }
    }

    let last = passes.last().expect("at least one pass");
    let duration_ms = started.elapsed().as_millis() as u64;
    let mut logs = format!(
        "Compiler: {} ({})\nStatus: {}{}\nBuild cache: {}\nAssets: {} copied, {} unchanged, {} removed\nPasses: {}\nDuration: {} ms\n",
        engine.binary(),
        exe.display(),
        last.status,
        if last.timed_out { " (TIMED OUT)" } else { "" },
        build_dir.display(),
        stats.copied,
        stats.unchanged,
        stats.removed,
        passes.len(),
        duration_ms
    );
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

        let first = sync_assets(&src, &dst, &src.join("main.tex")).unwrap();
        assert_eq!(first, SyncStats { copied: 3, unchanged: 0, removed: 0 });
        assert!(dst.join("figures/plot.png").exists());
        assert!(dst.join("macros.sty").exists());
        assert!(dst.join("refs.bib").exists());
        for excluded in ["main.tex", "main.aux", "main.log", "main.synctex.gz", "scratch.tmp", ".git", "node_modules"] {
            assert!(!dst.join(excluded).exists(), "{excluded} must not be synced");
        }

        // Second run with nothing changed: zero copies.
        let second = sync_assets(&src, &dst, &src.join("main.tex")).unwrap();
        assert_eq!(second, SyncStats { copied: 0, unchanged: 3, removed: 0 });

        // Artifacts produced by the engine inside the cache must survive a sync.
        fs::write(dst.join("main.aux"), b"engine output").unwrap();
        fs::write(dst.join("main.pdf"), b"%PDF-").unwrap();

        // Change one asset (content + size) and delete another.
        fs::write(src.join("macros.sty"), b"sty v2 longer").unwrap();
        fs::remove_file(src.join("refs.bib")).unwrap();
        let third = sync_assets(&src, &dst, &src.join("main.tex")).unwrap();
        assert_eq!(third, SyncStats { copied: 1, unchanged: 1, removed: 1 });
        assert_eq!(fs::read(dst.join("macros.sty")).unwrap(), b"sty v2 longer");
        assert!(!dst.join("refs.bib").exists(), "deleted asset must be removed from the cache");
        assert!(dst.join("main.aux").exists());
        assert!(dst.join("main.pdf").exists());

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
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

        let out = compile(dir.to_str().unwrap(), "main.tex", tex, DEFAULT_TIMEOUT).unwrap();
        assert!(out.success, "logs: {}", out.logs);
        let pdf = out.pdf_path.as_deref().expect("pdf path");
        assert!(fs::read(pdf).unwrap().starts_with(b"%PDF-"));
        assert!(pdf.starts_with(build_dir_for(dir.to_str().unwrap()).to_str().unwrap()));
        for polluted in ["main.aux", "main.log", "main.pdf", "main.tex"] {
            assert!(!dir.join(polluted).exists(), "{polluted} must not appear in the project folder");
        }
        assert!(out.logs.contains("Assets: 1 copied, 0 unchanged"));

        // Second compile: the included chapter is unchanged, nothing is copied again.
        let again = compile(dir.to_str().unwrap(), "main.tex", tex, DEFAULT_TIMEOUT).unwrap();
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
        let out = compile(dir.to_str().unwrap(), "main.tex", broken, DEFAULT_TIMEOUT).unwrap();
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

    #[test]
    fn compile_honours_nested_main_file() {
        if !engine_available() {
            return;
        }
        let dir = temp_dir("compile_nested");
        fs::create_dir_all(dir.join("paper")).unwrap();
        let tex = "\\documentclass{article}\n\\begin{document}\nNested root\n\\end{document}";
        fs::write(dir.join("paper/thesis.tex"), tex).unwrap();
        let out = compile(dir.to_str().unwrap(), "paper/thesis.tex", tex, DEFAULT_TIMEOUT).unwrap();
        assert!(out.success, "logs: {}", out.logs);
        assert!(out.pdf_path.unwrap().ends_with("thesis.pdf"));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(build_dir_for(dir.to_str().unwrap()));
    }
}
