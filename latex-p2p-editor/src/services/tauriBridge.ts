// Tauri Bridge: thin typed wrappers around Tauri v2 `invoke()` calls.
// Rule: NEVER use Tauri v1 imports. Always use Tauri v2 syntax.

import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { SynctexSource, SynctexTarget } from "./synctex";

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
  /** Root file recorded in room.json: the file the room's legacy shared text belongs to. */
  room_main_file?: string | null;
  crdt_state: number[] | null; // Vec<u8> arrives as number[]
  /** Desktop sync client that keeps the folder in the cloud, detected from its path. */
  cloud: CloudLocation;
}

export type CloudProvider = "google_drive" | "onedrive" | "dropbox" | "icloud" | "box" | "local";

export interface CloudLocation {
  provider: CloudProvider;
  /** Account from the sync folder name (email, "Personal", company), when present. */
  account: string | null;
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
  /** True when the engine is the Tectonic shipped inside the app. */
  bundled?: boolean;
  install_hint: string;
}

/**
 * Shortcuts for large documents. They only change the build copy of the root file;
 * the project is never modified. All off = a plain full build (what Export uses).
 */
export interface BuildOptions {
  /** Typeset only this `\include`d chapter (argument exactly as in `\include{…}`). */
  includeOnly?: string | null;
  /** Add `draft` to the `\documentclass` options. */
  draft?: boolean;
  /** Reuse a precompiled preamble (`.fmt`); pdflatex only, ignored elsewhere. */
  precompiledPreamble?: boolean;
}

export type PreambleStatus = "off" | "unsupported" | "reused" | "created" | "failed";

export interface CompileOutput {
  success: boolean;
  compiler: string;
  logs: string;
  /** Absolute path of the PDF inside the build cache, if one was produced. */
  pdf_path: string | null;
  duration_ms: number;
  timed_out: boolean;
  /** What was typeset: a requested chapter the root does not `\include` falls back to "full". */
  mode: "full" | "chapter";
  chapter: string | null;
  draft: boolean;
  preamble: PreambleStatus;
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

/** A file to scaffold when creating a project. */
export interface ProjectFile {
  path: string;
  content: string;
}

/** Creates `<parentDir>/<name>` with the given files and returns the project path. */
export async function createProject(parentDir: string, name: string, files: ProjectFile[]): Promise<string> {
  return invoke<string>("create_project", { parentDir, name, files });
}

// ─── Cloud sync clients & room lookup ───────────────────────────────

export interface CloudClient {
  provider: CloudProvider;
  roots: string[];
}

/** Sync clients configured on this machine (by their local sync folders). */
export async function cloudClients(): Promise<CloudClient[]> {
  return invoke<CloudClient[]>("cloud_clients");
}

/** Finds the local folder of a room under this machine's cloud sync folders. */
export async function locateRoomInCloud(roomId: string): Promise<string | null> {
  return invoke<string | null>("locate_room_in_cloud", { roomId });
}

/** Base folder of app-managed room workspaces. */
export async function roomWorkspacesDir(): Promise<string> {
  return invoke<string>("room_workspaces_dir");
}

/** Creates/returns the workspace used when joining a room without a shared folder. */
export async function ensureRoomWorkspace(roomId: string): Promise<string> {
  return invoke<string>("ensure_room_workspace", { roomId });
}

/** Opens an https URL in the system browser. */
export async function openExternalUrl(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

// ─── File Tree Operations ──────────────────────────────────────────

export interface ProjectNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: ProjectNode[];
  size?: number;
}

/** Lists the recursive file tree of a project. */
export async function listProjectFiles(projectPath: string): Promise<ProjectNode[]> {
  return invoke<ProjectNode[]>("list_project_files", { projectPath });
}

/** Reads any text file inside a project. */
export async function readProjectFile(projectPath: string, relPath: string): Promise<string> {
  return invoke<string>("read_project_file", { projectPath, relPath });
}

/** Raw bytes of a project file (image and PDF previews), via binary IPC. */
export async function readProjectFileBytes(projectPath: string, relPath: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_project_file_bytes", { projectPath, relPath });
  return new Uint8Array(buffer);
}

/** Saves any file inside a project atomically. */
export async function saveProjectFile(
  projectPath: string,
  relPath: string,
  content: string
): Promise<boolean> {
  return invoke<boolean>("save_project_file", { projectPath, relPath, content });
}

/** Creates a file or directory inside a project. */
export async function createProjectNode(
  projectPath: string,
  relPath: string,
  isDir: boolean
): Promise<void> {
  return invoke<void>("create_project_node", { projectPath, relPath, isDir });
}

/** Deletes a file or directory inside a project. */
export async function deleteProjectNode(projectPath: string, relPath: string): Promise<void> {
  return invoke<void>("delete_project_node", { projectPath, relPath });
}

/** Renames a file or directory inside a project. */
export async function renameProjectNode(
  projectPath: string,
  oldRelPath: string,
  newRelPath: string
): Promise<void> {
  return invoke<void>("rename_project_node", { projectPath, oldRelPath, newRelPath });
}

// ─── Version history (app data dir, per project) ────────────────────

export type SnapshotKind = "auto" | "manual";

export interface SnapshotMeta {
  id: string;
  created_at_ms: number;
  kind: SnapshotKind;
  label?: string;
  author?: string;
  main_file: string;
  bytes: number;
  hash: string;
}

export interface SaveSnapshotOutcome {
  snapshot: SnapshotMeta;
  created: boolean;
}

export async function historyList(projectPath: string): Promise<SnapshotMeta[]> {
  return invoke<SnapshotMeta[]>("history_list", { projectPath });
}

/** Stores a snapshot; `label` makes it a named (never pruned) version. */
export async function historySave(
  projectPath: string,
  mainFile: string,
  content: string,
  label?: string | null,
  author?: string | null
): Promise<SaveSnapshotOutcome> {
  return invoke<SaveSnapshotOutcome>("history_save", {
    projectPath,
    mainFile,
    content,
    label: label ?? null,
    author: author ?? null,
  });
}

export async function historyRead(projectPath: string, id: string): Promise<string> {
  return invoke<string>("history_read", { projectPath, id });
}

export async function historyDelete(projectPath: string, id: string): Promise<SnapshotMeta[]> {
  return invoke<SnapshotMeta[]>("history_delete", { projectPath, id });
}

/** Opens the native folder picker for a parent directory. */
export async function pickParentFolder(): Promise<string | null> {
  return open({ directory: true, multiple: false, title: "Parent folder for the new project" });
}

// ─── Compiler ───────────────────────────────────────────────────────

/** Reports the available LaTeX engine (or installation instructions). */
export async function detectCompiler(): Promise<CompilerInfo> {
  return invoke<CompilerInfo>("detect_compiler");
}

/**
 * Compiles in the per-project build cache. LaTeX errors come back as `success: false`.
 * With a `roomId`, files received from peers (the room's asset cache) fill in what
 * the project folder lacks. `openFiles` (path → text) is the editor's content of
 * other project files; it replaces their disk copies for this build.
 */
export async function compileLatex(
  projectPath: string,
  mainFile: string,
  texContent: string,
  options: BuildOptions = {},
  timeoutSecs?: number,
  roomId?: string | null,
  openFiles?: Record<string, string>
): Promise<CompileOutput> {
  return invoke<CompileOutput>("compile_latex", {
    roomId: roomId ?? null,
    openFiles: openFiles ?? null,
    projectPath,
    mainFile,
    texContent,
    timeoutSecs: timeoutSecs ?? null,
    options: {
      includeOnly: options.includeOnly ?? null,
      draft: options.draft ?? false,
      precompiledPreamble: options.precompiledPreamble ?? false,
    },
  });
}

// ─── Project assets shared with peers ─────────────────────────────

/** A shareable project file: `/`-separated relative path, size and SHA-256 (hex). */
export interface AssetEntry {
  path: string;
  size: number;
  hash: string;
}

/** Lists the project's shareable files (everything a build may need but the root file). */
export async function assetList(projectPath: string, mainFile: string): Promise<AssetEntry[]> {
  return invoke<AssetEntry[]>("asset_list", { projectPath, mainFile });
}

/** Reads a byte range of an asset from the project folder, or from the room cache. */
export async function assetReadChunk(
  projectPath: string,
  roomId: string | null,
  path: string,
  offset: number,
  length: number
): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("asset_read_chunk", { projectPath, roomId, path, offset, length });
  return new Uint8Array(buffer);
}

/** Files of a room's asset cache (received from peers) for this project folder. */
export async function assetCacheList(projectPath: string, roomId: string): Promise<AssetEntry[]> {
  return invoke<AssetEntry[]>("asset_cache_list", { projectPath, roomId });
}

/** Stores a downloaded asset in the room cache; the backend checks the hash. */
export async function assetCacheStore(
  projectPath: string,
  roomId: string,
  entry: AssetEntry,
  bytes: Uint8Array
): Promise<AssetEntry> {
  return invoke<AssetEntry>("asset_cache_store", bytes, {
    headers: {
      "x-project-path": encodeURIComponent(projectPath),
      "x-room-id": encodeURIComponent(roomId),
      "x-asset-path": encodeURIComponent(entry.path),
      "x-asset-hash": encodeURIComponent(entry.hash),
    },
  });
}

/** Deletes cached files that are not in `keep`. Returns how many were removed. */
export async function assetCachePrune(projectPath: string, roomId: string, keep: AssetEntry[]): Promise<number> {
  return invoke<number>("asset_cache_prune", { projectPath, roomId, keep });
}

// ─── SyncTeX navigation ──────────────────────────────────────────

/**
 * Inverse search: the project file and line typeset at `(x, y)` (PDF points from
 * the page's top-left corner) of `page` in the last build of `mainFile`.
 * `null` when nothing from the project is there.
 */
export async function synctexEdit(
  projectPath: string,
  mainFile: string,
  page: number,
  x: number,
  y: number
): Promise<SynctexSource | null> {
  return invoke<SynctexSource | null>("synctex_edit", { projectPath, mainFile, page, x, y });
}

/** Forward search: where `file:line` (project-relative) was typeset; `null` if nowhere. */
export async function synctexView(
  projectPath: string,
  mainFile: string,
  file: string,
  line: number
): Promise<SynctexTarget | null> {
  return invoke<SynctexTarget | null>("synctex_view", { projectPath, mainFile, file, line });
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
