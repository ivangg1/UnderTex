# Technical Specification: Local-First P2P LaTeX Desktop Editor (MVP)

## 1. Project Overview

Build a cross-platform desktop LaTeX editor that operates by default as a fast, private, single-player local editor (**Solo Mode**), and seamlessly upgrades on-demand to real-time collaboration (Google Docs style with live cursors) over Peer-to-Peer (WebRTC) without a paid central server (**Collaborative Mode**). Each user compiles the PDF locally on their own CPU using Tectonic, while files can reside in a local folder or a shared cloud folder (Google Drive / iCloud / OneDrive). To prevent cloud sync file conflicts during collaborative sessions, a dynamic Leader Election algorithm ensures only one active peer (the "Host") writes to the `.tex` file on disk at any given time, with automatic failover if the Host disconnects.

## 2. Strict Tech Stack & Versions (CRITICAL FOR AI)

* **Desktop Framework:** Tauri v2 (`@tauri-apps/api` v2, `@tauri-apps/cli` v2).
  * *Rule:* NEVER use Tauri v1 imports (`@tauri-apps/api/tauri`). Always use Tauri v2 syntax (`import { invoke } from '@tauri-apps/api/core'`).
* **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS.
* **Code Editor:** CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `codemirror-lang-latex`).
* **CRDT & Real-Time Collaboration:**
  * `yjs` (Core CRDT state)
  * `y-webrtc` (P2P synchronization over WebRTC)
  * `y-codemirror.next` (Binds Yjs `Y.Text` and `Awareness` live cursors directly to CodeMirror 6)
* **Local LaTeX Compiler (Backend):** `tectonic` CLI invoked as a child process from the Rust backend (`src-tauri`), falling back to `pdflatex` if specified.
* **PDF Viewer:** Native HTML `<iframe src={pdfBlobUrl} />` or `pdfjs-dist` reading the compiled `main.pdf` bytes from the Rust backend.

## 3. Project Architecture

```text
latex-p2p-editor/
├── src/                          # React + TypeScript Frontend
│   ├── components/
│   │   ├── Toolbar.tsx           # Open folder, Solo/Collab toggle, Room ID, Host Badge, Compile button, User color/name
│   │   ├── LatexEditor.tsx       # CodeMirror 6 + Yjs + y-codemirror.next binding
│   │   └── PdfPreview.tsx        # Renders compiled PDF bytes and compilation logs
│   ├── services/
│   │   ├── collabManager.ts      # Dual-mode (Solo/Collab) Y.Doc, WebrtcProvider, Awareness, and Leader Election logic
│   │   └── tauriBridge.ts        # Wrapper for Tauri v2 invoke() calls to Rust
│   ├── App.tsx
│   └── main.tsx
├── signaling-server/             # Optional self-hosted y-webrtc signaling server
│   ├── server.js
│   ├── package.json
│   └── Dockerfile
└── src-tauri/                    # Rust Backend (Tauri v2)
    ├── src/
    │   ├── main.rs
    │   └── lib.rs                # Tauri commands: read_project, init_collab_project, save_tex_atomic, save_project_state, compile_latex
    ├── Cargo.toml
    └── tauri.conf.json
```

## 4. Core Engineering Mechanisms

### A. Dynamic Host Election (Leader Election without Server)

1. In **Solo Mode**, `isHost` is permanently `true` and no network connections are made.
2. In **Collaborative Mode**, every peer connected to the `WebrtcProvider` room has a unique numerical `doc.clientID` and broadcasts its presence via `provider.awareness`.
3. Whenever `awareness` changes (`change` event), every connected client collects the array of active `clientID`s from `Array.from(awareness.getStates().keys())`.
4. Sort the active `clientID`s in ascending order.
5. **Rule:** If `myClientID === Math.min(...activeClientIDs)`, the current user is the **Active Host** (`isHost = true`). Otherwise, the user is a **Guest** (`isHost = false`).
6. If the current Host closes the app or loses Wi-Fi, `y-webrtc` removes their awareness state automatically, and the peer with the next lowest `clientID` immediately becomes the new Host with zero data loss.

### B. Conflict-Free Cloud Persistence Strategy

1. **Standard Local Folders (Solo Mode):**
   * Opening a folder that does NOT contain `.texcollab/room.json` opens in **Solo Mode**.
   * Do NOT create `.texcollab/` automatically. Initialize `Y.Text` directly from `main.tex`.
   * On document edit (debounced every 1500ms), write directly and atomically only to `main.tex` via `save_tex_atomic(projectPath, texContent)`.
2. **Shared Cloud Folders (Collaborative Mode):**
   * Every collaborative project folder contains `.texcollab/room.json` (stores a deterministic UUID for the WebRTC room name so peers opening the same cloud folder join the same room automatically) and `.texcollab/crdt_state.bin` (binary Yjs state vector using `Y.encodeStateAsUpdate(ydoc)`).
   * On project open (when `.texcollab/room.json` exists):
     * Read `.texcollab/crdt_state.bin` if it exists and apply it via `Y.applyUpdate(ydoc, binaryData)`.
     * If `crdt_state.bin` does not exist yet, initialize `Y.Text` with the plain text content of `main.tex`.
   * On document edit (debounced every 1500ms):
     * **ONLY if `isHost === true`**, invoke the Rust command `save_project_state(projectPath, texContent, crdtBinaryUpdate)` which atomically writes both `main.tex` and `.texcollab/crdt_state.bin` to disk.
     * Guests (`isHost === false`) NEVER write to `main.tex` during a live multi-peer session to prevent Google Drive / iCloud from creating conflicted copies.

### C. Local Compilation Pipeline (Rust Backend)

1. When ANY user clicks "Compile" (Solo, Host, or Guest):
   * Compile inside a temporary OS directory (`std::env::temp_dir()`) by copying project assets + the current in-memory `Y.Text` string to a local cache folder so compiling never pollutes the user's folder or triggers cloud file conflicts on `main.pdf`, `.aux`, or `.log` files.
   * Execute `tectonic -X compile <path_to_tex>` via `std::process::Command` (falling back to `pdflatex` if `tectonic` is not in PATH).
   * Return `Result<{ pdf_bytes: Vec<u8>, logs: String }, String>` to the React frontend.
2. Convert `pdf_bytes` into a `Blob` (`application/pdf`) and render via `URL.createObjectURL(blob)` in the right-hand preview pane.

### D. Dual-Mode Operation: Solo (Local-Only) vs. Collaborative (P2P)

The editor MUST support users who just want a fast, private, single-player desktop LaTeX editor without network overhead or extra hidden files:

1. **Solo Mode (`mode = 'solo'`, Default for standard folders):**
   * Triggered automatically when opening a folder without `.texcollab/room.json`.
   * Do NOT create `.texcollab/` and do NOT instantiate `WebrtcProvider` (zero network traffic).
   * `Y.Doc` still runs locally in memory bound to CodeMirror 6, and `isHost` is permanently `true`, saving directly to `main.tex`.
2. **Activating Collaboration On-Demand (`mode = 'collab'`):**
   * The Toolbar includes a "Start Collaboration" button when in Solo Mode.
   * When clicked, the app invokes the Rust command `init_collab_project(projectPath)` to create `.texcollab/room.json` (and initial `crdt_state.bin`), dynamically attaches `WebrtcProvider` to the active in-memory `Y.Doc` without losing editor state or cursor position, and switches to **Collaborative Mode** (`mode = 'collab'`).
   * Opening a folder that already contains `.texcollab/room.json` starts directly in **Collaborative Mode**.
3. **Disconnecting / Returning to Solo Offline Mode:**
   * While in Collaborative Mode, the user can click "Disconnect P2P / Work Offline" in the Toolbar to destroy the `WebrtcProvider` instance and work locally without network traffic.