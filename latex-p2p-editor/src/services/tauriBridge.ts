// Tauri Bridge: thin typed wrappers around Tauri v2 `invoke()` calls.
// Rule: NEVER use Tauri v1 imports. Always use Tauri v2 syntax.

import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open, save } from "@tauri-apps/plugin-dialog";

// ─── Types matching Rust structs ────────────────────────────────────

export interface ProjectData {
  project_path: string;
  /** Root .tex file, relative to the project (e.g. "main.tex", "paper/thesis.tex"). */
  main_file: string;
  /** All .tex files found in the project (relative, sorted). */
  tex_files: string[];
  tex_content: string;
  is_collab: boolean;
  room_id: string | null;
  crdt_state: number[] | null; // Vec<u8> arrives as number[]
}

export interface RoomMeta {
  room_id: string;
  main_file: string | null;
}

export interface CompilerInfo {
  os: "macos" | "windows" | "linux";
  name: string | null;
  path: string | null;
  version: string | null;
  install_hint: string;
}

export interface CompileOutput {
  success: boolean;
  compiler: string;
  logs: string;
  /** Absolute path of the PDF inside the build cache, if one was produced. */
  pdf_path: string | null;
  duration_ms: number;
  timed_out: boolean;
}

/** Event emitted by the backend when the OS asks to close the window. */
export const CLOSE_REQUESTED_EVENT = "app://close-requested";

// ─── Project ────────────────────────────────────────────────────────

/** Opens the native folder picker and returns the selected path, or null. */
export async function pickProjectFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "LaTeX project folder",
  });
  return selected;
}

/** Reads a project folder. `mainFile` forces a specific root file. */
export async function readProject(
  projectPath: string,
  mainFile?: string | null
): Promise<ProjectData> {
  return invoke<ProjectData>("read_project", {
    projectPath,
    mainFile: mainFile ?? null,
  });
}

/**
 * Initializes collaboration: creates `.texcollab/room.json`. Pass `roomId` to join
 * a room shared by a peer, omit it to host a new one.
 */
export async function initCollabProject(
  projectPath: string,
  mainFile: string,
  roomId?: string | null
): Promise<RoomMeta> {
  return invoke<RoomMeta>("init_collab_project", {
    projectPath,
    mainFile,
    roomId: roomId ?? null,
  });
}

/** Atomically saves the root TeX file. Resolves to `true` when bytes were written. */
export async function saveTexAtomic(
  projectPath: string,
  mainFile: string,
  content: string
): Promise<boolean> {
  return invoke<boolean>("save_tex_atomic", { projectPath, mainFile, content });
}

/** Persists the CRDT binary state to `.texcollab/crdt_state.bin`. */
export async function saveCrdtState(
  projectPath: string,
  crdtBinary: number[]
): Promise<boolean> {
  return invoke<boolean>("save_crdt_state", { projectPath, crdtBinary });
}

/** Saves both the root TeX file and the CRDT state in a single IPC call. */
export async function saveProjectState(
  projectPath: string,
  mainFile: string,
  texContent: string,
  crdtBinary: number[]
): Promise<boolean> {
  return invoke<boolean>("save_project_state", {
    projectPath,
    mainFile,
    texContent,
    crdtBinary,
  });
}

// ─── Compiler ───────────────────────────────────────────────────────

/** Reports the available LaTeX engine (or installation instructions). */
export async function detectCompiler(): Promise<CompilerInfo> {
  return invoke<CompilerInfo>("detect_compiler");
}

/** Compiles in the per-project build cache. LaTeX errors come back as `success: false`. */
export async function compileLatex(
  projectPath: string,
  mainFile: string,
  texContent: string,
  timeoutSecs?: number
): Promise<CompileOutput> {
  return invoke<CompileOutput>("compile_latex", {
    projectPath,
    mainFile,
    texContent,
    timeoutSecs: timeoutSecs ?? null,
  });
}

/** Reads a file from the build cache as raw bytes (binary IPC, no JSON arrays). */
export async function readBuildFile(path: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_build_file", { path });
  return new Uint8Array(buffer);
}

/** Asks for a destination and copies the compiled PDF there. Returns the chosen path. */
export async function exportPdf(
  pdfPath: string,
  suggestedName: string
): Promise<string | null> {
  const destination = await save({
    title: "Export PDF",
    defaultPath: suggestedName,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!destination) return null;
  await invoke("export_pdf", { source: pdfPath, destination });
  return destination;
}

// ─── Windows ────────────────────────────────────────────────────────

/** Opens a new application window for side-by-side collaborative testing. */
export async function openNewWindow(): Promise<void> {
  return invoke("open_new_window");
}

/**
 * Subscribes to the backend's close request for THIS window only. A plain
 * `listen()` would receive the event of every window (target "Any"), making
 * each window close itself whenever any other one closes.
 * The handler must call `closeWindow()` when done.
 */
export async function onCloseRequested(handler: () => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen(CLOSE_REQUESTED_EVENT, () => handler());
}

/** Closes the current window for real (after pending saves were flushed). */
export async function closeWindow(): Promise<void> {
  return invoke("close_window");
}
