//! Tauri v2 backend for the LaTeX P2P Desktop Editor.
//!
//! Modules:
//! * [`project`]  – project folder, root-file detection, `.texcollab/` metadata, atomic saves.
//! * [`compiler`] – cross-platform engine discovery and the cached local compile pipeline.
//! * [`fsutil`]   – atomic writes and path validation.

mod compiler;
mod fsutil;
mod history;
mod project;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Emitter, Manager, WindowEvent};

use compiler::{CompileOutput, CompilerInfo};
use history::{HistoryStore, SaveOutcome, SnapshotMeta};
use project::{ProjectData, ProjectFile, RoomMeta};

/// Event sent to a window when the user asks to close it. The frontend flushes
/// pending saves and then calls `close_window`.
pub const CLOSE_REQUESTED_EVENT: &str = "app://close-requested";

/// Labels of windows that already flushed and may now close for real.
#[derive(Default)]
struct ClosingWindows(Mutex<HashSet<String>>);

// ─── Tauri commands ─────────────────────────────────────────────────

/// Open a project folder: detects the root `.tex` file, lists the project's `.tex`
/// files, reads the root file and `.texcollab/` metadata if present. Never creates
/// `.texcollab/` by itself.
#[tauri::command]
fn read_project(project_path: String, main_file: Option<String>) -> Result<ProjectData, String> {
    project::read_project(&project_path, main_file.as_deref())
}

/// Scaffolds a new project folder from template files and returns its path.
#[tauri::command]
fn create_project(parent_dir: String, name: String, files: Vec<ProjectFile>) -> Result<String, String> {
    project::create_project(&parent_dir, &name, &files)
}

// ─── Version history (stored in the app data dir, never in the project) ──

fn history_store(app: &tauri::AppHandle) -> Result<HistoryStore, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("App data directory unavailable: {e}"))?
        .join("history");
    Ok(HistoryStore::new(root))
}

#[tauri::command]
async fn history_list(app: tauri::AppHandle, project_path: String) -> Result<Vec<SnapshotMeta>, String> {
    let store = history_store(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.list(&project_path))
        .await
        .map_err(|e| format!("History task panicked: {e}"))
}

#[tauri::command]
async fn history_save(
    app: tauri::AppHandle,
    project_path: String,
    main_file: String,
    content: String,
    label: Option<String>,
    author: Option<String>,
) -> Result<SaveOutcome, String> {
    let store = history_store(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        store.save(&project_path, &main_file, &content, label.as_deref(), author.as_deref())
    })
    .await
    .map_err(|e| format!("History task panicked: {e}"))?
}

#[tauri::command]
async fn history_read(app: tauri::AppHandle, project_path: String, id: String) -> Result<String, String> {
    let store = history_store(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.read(&project_path, &id))
        .await
        .map_err(|e| format!("History task panicked: {e}"))?
}

#[tauri::command]
async fn history_delete(app: tauri::AppHandle, project_path: String, id: String) -> Result<Vec<SnapshotMeta>, String> {
    let store = history_store(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.delete(&project_path, &id))
        .await
        .map_err(|e| format!("History task panicked: {e}"))?
}

/// Initialize collaboration on demand. `room_id` joins an existing room (shared by a
/// peer); `None` hosts a new one. Returns the room metadata.
#[tauri::command]
fn init_collab_project(
    project_path: String,
    main_file: String,
    room_id: Option<String>,
) -> Result<RoomMeta, String> {
    let path = PathBuf::from(&project_path);
    if !path.is_dir() {
        return Err(format!("Not a directory: {project_path}"));
    }
    project::ensure_room_meta(&path, room_id.as_deref(), &main_file)
}

/// Atomically save the root TeX file (write temp + fsync + rename).
#[tauri::command]
fn save_tex_atomic(project_path: String, main_file: String, content: String) -> Result<bool, String> {
    project::save_tex(&project_path, &main_file, &content)
}

/// Persist the binary CRDT state to `.texcollab/crdt_state.bin`.
#[tauri::command]
fn save_crdt_state(project_path: String, crdt_binary: Vec<u8>) -> Result<bool, String> {
    project::save_crdt(&project_path, &crdt_binary)
}

/// Persist both the root TeX file and the CRDT state (collab mode, host only).
#[tauri::command]
fn save_project_state(
    project_path: String,
    main_file: String,
    tex_content: String,
    crdt_binary: Vec<u8>,
) -> Result<bool, String> {
    let wrote_tex = project::save_tex(&project_path, &main_file, &tex_content)?;
    let wrote_crdt = project::save_crdt(&project_path, &crdt_binary)?;
    Ok(wrote_tex || wrote_crdt)
}

/// Reports which LaTeX engine is available (and how to install one if none is).
#[tauri::command]
async fn detect_compiler() -> CompilerInfo {
    tauri::async_runtime::spawn_blocking(compiler::detect_compiler)
        .await
        .unwrap_or_else(|_| compiler::CompilerInfo {
            os: compiler::current_os(),
            name: None,
            path: None,
            version: None,
            install_hint: compiler::install_hint(),
        })
}

/// Compile the in-memory TeX source inside the per-project build cache. Runs on a
/// blocking thread so the UI stays responsive during long builds.
#[tauri::command]
async fn compile_latex(
    project_path: String,
    main_file: String,
    tex_content: String,
    timeout_secs: Option<u64>,
) -> Result<CompileOutput, String> {
    let timeout = timeout_secs.map(Duration::from_secs).unwrap_or(compiler::DEFAULT_TIMEOUT);
    tauri::async_runtime::spawn_blocking(move || {
        compiler::compile(&project_path, &main_file, &tex_content, timeout)
    })
    .await
    .map_err(|e| format!("Compile task panicked: {e}"))?
}

/// Returns the raw bytes of a file inside the build cache (e.g. the compiled PDF)
/// as a binary IPC response, avoiding JSON-encoding megabytes of numbers.
#[tauri::command]
async fn read_build_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || compiler::read_build_file(&path))
        .await
        .map_err(|e| format!("Read task panicked: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Copies a compiled PDF from the build cache to a user-chosen destination.
#[tauri::command]
fn export_pdf(source: String, destination: String) -> Result<(), String> {
    let bytes = compiler::read_build_file(&source)?;
    fsutil::write_atomic(std::path::Path::new(&destination), &bytes)
        .map(|_| ())
        .map_err(|e| format!("Failed to export PDF: {e}"))
}

/// Open a new desktop window (useful to test collaboration side by side).
#[tauri::command]
async fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    let window_id = format!("win_{}", uuid::Uuid::new_v4());
    tauri::WebviewWindowBuilder::new(&app, &window_id, tauri::WebviewUrl::default())
        .title("LaTeX P2P Editor")
        .inner_size(1280.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Called by the frontend once pending saves are flushed; closes the window for real.
#[tauri::command]
fn close_window(window: tauri::WebviewWindow, closing: tauri::State<'_, ClosingWindows>) -> Result<(), String> {
    closing
        .0
        .lock()
        .map_err(|_| "close state poisoned".to_string())?
        .insert(window.label().to_string());
    window.destroy().map_err(|e| e.to_string())
}

// ─── App bootstrap ──────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ClosingWindows::default())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<ClosingWindows>();
                let already_flushed = state
                    .0
                    .lock()
                    .map(|set| set.contains(window.label()))
                    .unwrap_or(true);
                if !already_flushed {
                    // Give the frontend a chance to flush the debounced save first.
                    api.prevent_close();
                    let _ = window.emit_to(window.label(), CLOSE_REQUESTED_EVENT, ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_project,
            create_project,
            history_list,
            history_save,
            history_read,
            history_delete,
            init_collab_project,
            save_tex_atomic,
            save_crdt_state,
            save_project_state,
            detect_compiler,
            compile_latex,
            read_build_file,
            export_pdf,
            open_new_window,
            close_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
