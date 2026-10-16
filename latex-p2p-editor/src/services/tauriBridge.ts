// Tauri Bridge: Wrapper for Tauri v2 invoke() calls to Rust
// Rule: NEVER use Tauri v1 imports. Always use Tauri v2 syntax.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

// ─── Types matching Rust structs ────────────────────────────────────

export interface ProjectData {
  project_path: string;
  tex_content: string;
  room_id: string;
  crdt_state: number[] | null; // Vec<u8> arrives as number[]
}

export interface CompileResult {
  pdf_bytes: number[]; // Vec<u8> arrives as number[]
  logs: string;
}

// ─── Bridge functions ───────────────────────────────────────────────

/**
 * Opens the native folder picker and returns the selected path, or null.
 */
export async function pickProjectFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open LaTeX project folder",
  });
  return selected;
}

/**
 * Read a project folder: loads main.tex, initializes room.json, loads CRDT state.
 */
export async function readProject(projectPath: string): Promise<ProjectData> {
  return invoke<ProjectData>("read_project", { projectPath });
}

/**
 * Atomically save main.tex content to disk.
 */
export async function saveTexAtomic(
  projectPath: string,
  content: string
): Promise<void> {
  return invoke("save_tex_atomic", { projectPath, content });
}

/**
 * Persist CRDT binary state to .texcollab/crdt_state.bin.
 */
export async function saveCrdtState(
  projectPath: string,
  crdtBinary: number[]
): Promise<void> {
  return invoke("save_crdt_state", { projectPath, crdtBinary });
}

/**
 * Compile LaTeX with Tectonic (or pdflatex) in a temporary OS folder
 * using in-memory TeX content and project assets.
 */
export async function compileLatex(
  projectPath: string,
  texContent: string
): Promise<CompileResult> {
  return invoke<CompileResult>("compile_latex", { projectPath, texContent });
}
