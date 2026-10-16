# Technical Specification: Local-First P2P LaTeX Desktop Editor (MVP)

## 1. Project Overview
Build a cross-platform desktop LaTeX editor where users collaborate in real-time (Google Docs style with live cursors) over Peer-to-Peer (WebRTC) without a paid central server. Each user compiles the PDF locally on their own CPU using Tectonic, while files reside in a shared local cloud folder (Google Drive / iCloud / OneDrive). To prevent cloud sync file conflicts, a dynamic Leader Election algorithm ensures only one active peer (the "Host") writes to the `.tex` file on disk at any given time, with automatic failover if the Host disconnects.

## 2. Strict Tech Stack & Versions (CRITICAL FOR AI)
- **Desktop Framework:** Tauri v2 (`@tauri-apps/api` v2, `@tauri-apps/cli` v2).
  - *Rule:* NEVER use Tauri v1 imports (`@tauri-apps/api/tauri`). Always use Tauri v2 syntax (`import { invoke } from '@tauri-apps/api/core'`).
- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS.
- **Code Editor:** CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `codemirror-lang-latex`).
- **CRDT & Real-Time Collaboration:**
  - `yjs` (Core CRDT state)
  - `y-webrtc` (P2P synchronization over WebRTC)
  - `y-codemirror.next` (Binds Yjs `Y.Text` and `Awareness` live cursors directly to CodeMirror 6)
- **Local LaTeX Compiler (Backend):** `tectonic` CLI invoked as a child process from the Rust backend (`src-tauri`), falling back to `pdflatex` if specified.
- **PDF Viewer:** Native HTML `<iframe src={pdfBlobUrl} />` or `pdfjs-dist` reading the compiled `main.pdf` bytes from the Rust backend.

## 3. Project Architecture
```text
latex-p2p-editor/
├── src/                          # React + TypeScript Frontend
│   ├── components/
│   │   ├── Toolbar.tsx           # Open folder, Room ID, Host Badge, Compile button, User color/name
│   │   ├── LatexEditor.tsx       # CodeMirror 6 + Yjs + y-codemirror.next binding
│   │   └── PdfPreview.tsx        # Renders compiled PDF bytes and compilation logs
│   ├── services/
│   │   ├── collabManager.ts      # Y.Doc, WebrtcProvider, Awareness, and Leader Election logic
│   │   └── tauriBridge.ts        # Wrapper for Tauri v2 invoke() calls to Rust
│   ├── App.tsx
│   └── main.tsx
└── src-tauri/                    # Rust Backend (Tauri v2)
    ├── src/
    │   ├── main.rs
    │   └── lib.rs                # Tauri commands: read_project, save_tex_atomic, save_crdt_state, compile_latex
    ├── Cargo.toml
    └── tauri.conf.json
```

## 4. Core Engineering Mechanisms

### A. Dynamic Host Election (Leader Election without Server)
1. Every peer connected to the `WebrtcProvider` room has a unique numerical `doc.clientID` and broadcasts its presence via `provider.awareness`.
2. Whenever `awareness` changes (`change` event), every connected client collects the array of active `clientID`s from `Array.from(awareness.getStates().keys())`.
3. Sort the active `clientID`s in ascending order.
4. **Rule:** If `myClientID === Math.min(...activeClientIDs)`, the current user is the **Active Host** (`isHost = true`). Otherwise, the user is a **Guest** (`isHost = false`).
5. If the current Host closes the app or loses Wi-Fi, `y-webrtc` removes their awareness state automatically, and the peer with the next lowest `clientID` immediately becomes the new Host with zero data loss.

### B. Conflict-Free Cloud Persistence Strategy
When working inside a shared Google Drive or iCloud folder:
1. Every project folder contains a hidden metadata file `.texcollab/room.json` (stores a deterministic UUID for the WebRTC room name so peers opening the same cloud folder join the same room automatically) and `.texcollab/crdt_state.bin` (binary Yjs state vector using `Y.encodeStateAsUpdate(ydoc)`).
2. On project open:
   - Read `.texcollab/crdt_state.bin` if it exists and apply it via `Y.applyUpdate(ydoc, binaryData)`.
   - If it does not exist yet, initialize `Y.Text` with the plain text content of `main.tex`.
3. On document edit (debounced every 1500ms):
   - **ONLY if `isHost === true`**, invoke the Rust command `save_project_state(projectPath, texContent, crdtBinaryUpdate)` which atomically writes `main.tex` and `.texcollab/crdt_state.bin` to disk.
   - Guests (`isHost === false`) NEVER write to `main.tex` during a live multi-peer session to prevent Google Drive / iCloud from creating conflicted copies.

### C. Local Compilation Pipeline (Rust Backend)
1. When ANY user clicks "Compile" (Host or Guest):
   - If the user is a Guest (`isHost === false`), compile inside a temporary OS directory (`std::env::temp_dir()`) or copy project assets + current in-memory `Y.Text` string to a local cache folder so compiling never triggers cloud file conflicts on `main.pdf` or `.aux`/`.log` files.
   - Execute `tectonic -X compile <path_to_tex>` via `std::process::Command`.
   - Return `Result<{ pdf_bytes: Vec<u8>, logs: String }, String>` to the React frontend.
2. Convert `pdf_bytes` into a `Blob` (`application/pdf`) and render via `URL.createObjectURL(blob)` in the right-hand preview pane.