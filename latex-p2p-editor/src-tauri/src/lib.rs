use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

// ─── Data structures ────────────────────────────────────────────────

/// Metadata stored in `.texcollab/room.json`
#[derive(Serialize, Deserialize, Clone)]
struct RoomMeta {
    room_id: String,
}

/// Result returned when opening/reading a project
#[derive(Serialize, Clone)]
struct ProjectData {
    /// Absolute path of the project folder
    project_path: String,
    /// Contents of `main.tex` (empty string if the file doesn't exist yet)
    tex_content: String,
    /// The deterministic WebRTC room ID for this project folder
    room_id: String,
    /// Raw bytes of `.texcollab/crdt_state.bin`, if any
    crdt_state: Option<Vec<u8>>,
}

/// Result returned after compiling LaTeX
#[derive(Serialize, Clone, Debug)]
pub struct CompileResult {
    /// Raw bytes of the generated PDF
    pub pdf_bytes: Vec<u8>,
    /// Combined standard output and error from the compiler
    pub logs: String,
}

// ─── Helpers ────────────────────────────────────────────────────────

/// Ensure `.texcollab/` directory and `room.json` exist.
/// Returns the room_id (creating a new UUID if `room.json` is absent).
fn ensure_room_meta(project_path: &Path) -> Result<String, String> {
    let collab_dir = project_path.join(".texcollab");
    fs::create_dir_all(&collab_dir).map_err(|e| format!("Failed to create .texcollab dir: {e}"))?;

    let room_file = collab_dir.join("room.json");
    if room_file.exists() {
        let data = fs::read_to_string(&room_file)
            .map_err(|e| format!("Failed to read room.json: {e}"))?;
        let meta: RoomMeta =
            serde_json::from_str(&data).map_err(|e| format!("Invalid room.json: {e}"))?;
        Ok(meta.room_id)
    } else {
        let meta = RoomMeta {
            room_id: Uuid::new_v4().to_string(),
        };
        let json =
            serde_json::to_string_pretty(&meta).map_err(|e| format!("JSON serialize: {e}"))?;
        fs::write(&room_file, json).map_err(|e| format!("Failed to write room.json: {e}"))?;
        Ok(meta.room_id)
    }
}

/// Recursively copy all project assets into destination directory,
/// omitting hidden dirs, git, .texcollab, intermediate files, and main.tex.
fn copy_project_assets(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.exists() || !src.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let file_name_str = file_name.to_string_lossy();

        // Skip hidden files/folders and build caches
        if file_name_str.starts_with('.')
            || file_name_str == "target"
            || file_name_str.ends_with(".tmp")
            || file_name_str.ends_with(".log")
            || file_name_str.ends_with(".aux")
        {
            continue;
        }

        // Do not copy existing main.tex since current in-memory content is used
        if file_name_str == "main.tex" {
            continue;
        }

        let src_path = entry.path();
        let dst_path = dst.join(&file_name);
        if src_path.is_dir() {
            fs::create_dir_all(&dst_path)?;
            copy_project_assets(&src_path, &dst_path)?;
        } else if src_path.is_file() {
            let _ = fs::copy(&src_path, &dst_path);
        }
    }
    Ok(())
}

/// Build an augmented PATH environment variable so Tauri desktop can find
/// CLI tools installed via Homebrew, Cargo, MacTeX, etc.
fn get_augmented_path() -> String {
    let current_path = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    format!(
        "/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin:{}/.cargo/bin:{}",
        home, current_path
    )
}

/// Run either tectonic or fallback to pdflatex in the specified directory.
fn run_compiler(temp_dir: &Path) -> Result<(std::process::Output, &'static str), String> {
    let augmented_path = get_augmented_path();

    // 1. Attempt tectonic
    match Command::new("tectonic")
        .args(["-X", "compile", "main.tex"])
        .current_dir(temp_dir)
        .env("PATH", &augmented_path)
        .output()
    {
        Ok(output) => return Ok((output, "tectonic")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // Tectonic not in PATH, try fallback
        }
        Err(err) => return Err(format!("Failed to execute tectonic: {err}")),
    }

    // 2. Fallback to pdflatex
    match Command::new("pdflatex")
        .args(["-interaction=nonstopmode", "main.tex"])
        .current_dir(temp_dir)
        .env("PATH", &augmented_path)
        .output()
    {
        Ok(output) => Ok((output, "pdflatex")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(
            "Neither 'tectonic' nor 'pdflatex' was found in PATH. Please install Tectonic (e.g. 'brew install tectonic') or MacTeX/TeX Live.".to_string()
        ),
        Err(err) => Err(format!("Failed to execute pdflatex: {err}")),
    }
}

// ─── Tauri commands ─────────────────────────────────────────────────

/// Open a project folder: reads `main.tex`, initialises `.texcollab/room.json`,
/// and optionally loads the persisted CRDT state.
#[tauri::command]
fn read_project(project_path: String) -> Result<ProjectData, String> {
    let path = PathBuf::from(&project_path);
    if !path.is_dir() {
        return Err(format!("Not a directory: {project_path}"));
    }

    // Read main.tex (create a starter file if it doesn't exist)
    let tex_path = path.join("main.tex");
    let tex_content = if tex_path.exists() {
        fs::read_to_string(&tex_path)
            .map_err(|e| format!("Failed to read main.tex: {e}"))?
    } else {
        let starter = "\\documentclass{article}\n\\begin{document}\nHello, world!\n\\end{document}\n";
        fs::write(&tex_path, starter)
            .map_err(|e| format!("Failed to create main.tex: {e}"))?;
        starter.to_string()
    };

    // Ensure .texcollab/room.json
    let room_id = ensure_room_meta(&path)?;

    // Try to load CRDT state
    let crdt_state_path = path.join(".texcollab").join("crdt_state.bin");
    let crdt_state = if crdt_state_path.exists() {
        Some(
            fs::read(&crdt_state_path)
                .map_err(|e| format!("Failed to read crdt_state.bin: {e}"))?,
        )
    } else {
        None
    };

    Ok(ProjectData {
        project_path,
        tex_content,
        room_id,
        crdt_state,
    })
}

/// Atomically save `main.tex` content (write to tmp then rename).
#[tauri::command]
fn save_tex_atomic(project_path: String, content: String) -> Result<(), String> {
    let dir = PathBuf::from(&project_path);
    let tex_path = dir.join("main.tex");
    let tmp_path = dir.join("main.tex.tmp");

    fs::write(&tmp_path, &content).map_err(|e| format!("Failed to write tmp: {e}"))?;
    fs::rename(&tmp_path, &tex_path).map_err(|e| format!("Atomic rename failed: {e}"))?;
    Ok(())
}

/// Persist the binary CRDT state vector to `.texcollab/crdt_state.bin`.
#[tauri::command]
fn save_crdt_state(project_path: String, crdt_binary: Vec<u8>) -> Result<(), String> {
    let dir = PathBuf::from(&project_path);
    let collab_dir = dir.join(".texcollab");
    fs::create_dir_all(&collab_dir)
        .map_err(|e| format!("Failed to create .texcollab dir: {e}"))?;

    let state_path = collab_dir.join("crdt_state.bin");
    let tmp_path = collab_dir.join("crdt_state.bin.tmp");

    fs::write(&tmp_path, &crdt_binary).map_err(|e| format!("Failed to write crdt tmp: {e}"))?;
    fs::rename(&tmp_path, &state_path).map_err(|e| format!("Atomic rename crdt failed: {e}"))?;
    Ok(())
}

/// Compile LaTeX in a temporary OS directory so cloud folders are never polluted
/// with .aux, .log, or conflicting .pdf files.
#[tauri::command]
fn compile_latex(project_path: String, tex_content: String) -> Result<CompileResult, String> {
    let proj_dir = PathBuf::from(&project_path);
    let temp_dir = std::env::temp_dir().join(format!("latex_build_{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temporary build directory: {e}"))?;

    // Copy project assets (images, stylesheets, subfiles)
    if let Err(e) = copy_project_assets(&proj_dir, &temp_dir) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(format!("Failed to copy project assets: {e}"));
    }

    // Write the in-memory tex content
    let temp_tex = temp_dir.join("main.tex");
    if let Err(e) = fs::write(&temp_tex, &tex_content) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(format!("Failed to write in-memory TeX to temp directory: {e}"));
    }

    // Run tectonic or fallback to pdflatex
    let compile_attempt = run_compiler(&temp_dir);

    match compile_attempt {
        Ok((output, compiler_name)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let logs = format!(
                "Compiler: {}\nStatus: {}\n--- OUTPUT ---\n{}{}",
                compiler_name,
                output.status,
                stdout.trim(),
                if !stderr.trim().is_empty() {
                    format!("\n--- ERRORS ---\n{}", stderr.trim())
                } else {
                    String::new()
                }
            );

            let pdf_path = temp_dir.join("main.pdf");
            if pdf_path.exists() {
                match fs::read(&pdf_path) {
                    Ok(pdf_bytes) => {
                        let _ = fs::remove_dir_all(&temp_dir);
                        Ok(CompileResult { pdf_bytes, logs })
                    }
                    Err(e) => {
                        let _ = fs::remove_dir_all(&temp_dir);
                        Err(format!("PDF generated but failed to read: {e}\n\nLogs:\n{logs}"))
                    }
                }
            } else {
                let _ = fs::remove_dir_all(&temp_dir);
                Err(format!("Compilation did not produce main.pdf.\n\nLogs:\n{logs}"))
            }
        }
        Err(err) => {
            let _ = fs::remove_dir_all(&temp_dir);
            Err(err)
        }
    }
}

/// Open a new desktop window for testing collaboration or multi-project editing.
#[tauri::command]
async fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    let window_id = format!("win_{}", Uuid::new_v4());
    tauri::WebviewWindowBuilder::new(&app, &window_id, tauri::WebviewUrl::default())
        .title("LaTeX P2P Editor")
        .inner_size(1280.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── App bootstrap ──────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_project,
            save_tex_atomic,
            save_crdt_state,
            compile_latex,
            open_new_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn create_temp_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("test_latex_{}_{}", name, Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("Failed to create test temp dir");
        dir
    }

    #[test]
    fn test_ensure_room_meta_generates_and_persists_uuid() {
        let dir = create_temp_test_dir("room_meta");
        let room_id_1 = ensure_room_meta(&dir).expect("First room_id generation failed");

        // Verify room_id is a valid UUID
        assert!(Uuid::parse_str(&room_id_1).is_ok());

        // Verify room.json file exists
        let room_file = dir.join(".texcollab").join("room.json");
        assert!(room_file.exists());

        // Verify subsequent calls return the exact same deterministic UUID
        let room_id_2 = ensure_room_meta(&dir).expect("Second room_id read failed");
        assert_eq!(room_id_1, room_id_2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_project_creates_starter_tex_if_missing() {
        let dir = create_temp_test_dir("read_proj");
        let dir_str = dir.to_str().unwrap().to_string();

        let proj = read_project(dir_str).expect("Failed to read project");

        // Must create main.tex with standard starter document
        assert!(proj.tex_content.contains("\\documentclass{article}"));
        assert!(proj.tex_content.contains("\\begin{document}"));
        assert!(dir.join("main.tex").exists());

        // Room ID must be valid and crdt_state must be None initially
        assert!(Uuid::parse_str(&proj.room_id).is_ok());
        assert!(proj.crdt_state.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_atomic_save_tex_and_crdt_persistence() {
        let dir = create_temp_test_dir("atomic_save");
        let dir_str = dir.to_str().unwrap().to_string();

        // 1. Initial read
        let _ = read_project(dir_str.clone()).expect("Initial read failed");

        // 2. Save modified TeX atomically
        let new_content = "\\documentclass{article}\n\\begin{document}\nModified Content\n\\end{document}";
        save_tex_atomic(dir_str.clone(), new_content.to_string())
            .expect("Atomic TeX save failed");

        assert_eq!(
            fs::read_to_string(dir.join("main.tex")).unwrap(),
            new_content
        );
        // Ensure no temporary file left behind
        assert!(!dir.join("main.tex.tmp").exists());

        // 3. Save binary CRDT state
        let dummy_crdt = vec![0x00, 0x01, 0x02, 0xFF, 0xFE];
        save_crdt_state(dir_str.clone(), dummy_crdt.clone())
            .expect("CRDT state save failed");

        // Ensure no temporary CRDT file left behind
        assert!(!dir.join(".texcollab").join("crdt_state.bin.tmp").exists());

        // 4. Re-read project and verify CRDT state is restored
        let reloaded = read_project(dir_str).expect("Reload project failed");
        assert_eq!(reloaded.tex_content, new_content);
        assert_eq!(reloaded.crdt_state, Some(dummy_crdt));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_copy_project_assets_filters_auxiliary_and_hidden_files() {
        let src = create_temp_test_dir("assets_src");
        let dst = create_temp_test_dir("assets_dst");

        // Create assets and intermediate files
        fs::write(src.join("figure.png"), b"dummy_png").unwrap();
        fs::write(src.join("macros.sty"), b"dummy_sty").unwrap();
        fs::write(src.join("main.tex"), b"original_tex").unwrap();
        fs::write(src.join("main.aux"), b"aux_data").unwrap();
        fs::write(src.join("main.log"), b"log_data").unwrap();
        fs::write(src.join("test.tmp"), b"tmp_data").unwrap();

        let hidden_dir = src.join(".texcollab");
        fs::create_dir_all(&hidden_dir).unwrap();
        fs::write(hidden_dir.join("room.json"), b"{}").unwrap();

        // Run asset copy
        copy_project_assets(&src, &dst).expect("copy_project_assets failed");

        // Assets should be copied
        assert!(dst.join("figure.png").exists());
        assert!(dst.join("macros.sty").exists());

        // main.tex, aux, log, tmp, and hidden files must NOT be copied
        assert!(!dst.join("main.tex").exists());
        assert!(!dst.join("main.aux").exists());
        assert!(!dst.join("main.log").exists());
        assert!(!dst.join("test.tmp").exists());
        assert!(!dst.join(".texcollab").exists());

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn test_compile_latex_generates_pdf_without_polluting_project_folder() {
        let dir = create_temp_test_dir("compile_test");
        let dir_str = dir.to_str().unwrap().to_string();

        let valid_tex = "\\documentclass{article}\n\\begin{document}\nAutomated Compilation Test\n\\end{document}";

        let result = compile_latex(dir_str, valid_tex.to_string());
        assert!(result.is_ok(), "Compilation should succeed: {:?}", result.err());

        let output = result.unwrap();
        // Check valid PDF header (%PDF-)
        assert!(output.pdf_bytes.starts_with(b"%PDF-"));
        assert!(!output.logs.is_empty());

        // Verify project directory was NOT polluted with build files
        assert!(!dir.join("main.aux").exists());
        assert!(!dir.join("main.log").exists());
        assert!(!dir.join("main.pdf").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_compile_latex_reports_syntax_error() {
        let dir = create_temp_test_dir("compile_error");
        let dir_str = dir.to_str().unwrap().to_string();

        // Deliberately broken LaTeX syntax
        let broken_tex = "\\documentclass{article}\n\\begin{document}\n\\undefinedMacroDoesNotExistNowhere\n\\end{document}";

        let result = compile_latex(dir_str, broken_tex.to_string());
        assert!(result.is_err(), "Compilation with undefined macro must fail");

        let err_msg = result.unwrap_err();
        assert!(err_msg.contains("Compilation did not produce main.pdf") || err_msg.contains("error"));

        let _ = fs::remove_dir_all(&dir);
    }
}

