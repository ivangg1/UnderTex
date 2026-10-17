# LaTeX P2P Desktop Editor

A **local-first** desktop LaTeX editor: it compiles on your own CPU (no server
timeouts) and collaborates in real time over **P2P (WebRTC + CRDT)** without a
paid central server. Built for people who use free Overleaf and hit its
compile limits.

```
┌──────────────────────────┐      WebRTC (yjs + y-webrtc)      ┌──────────────────────────┐
│  Peer A  (Host 👑)        │ ◄──────────────────────────────► │  Peer B  (Guest)          │
│  CodeMirror 6 ⇄ Y.Doc    │  self-hosted signaling (encrypted) │  CodeMirror 6 ⇄ Y.Doc    │
│  tectonic (local)        │                                   │  tectonic (local)        │
│  writes main.tex + CRDT  │                                   │  memory only             │
└───────────┬──────────────┘                                   └──────────────────────────┘
            ▼
   local folder or cloud folder (Drive / iCloud / OneDrive / Dropbox)
```

## What it does

- **100 % local compilation** with `tectonic` (recommended) or `pdflatex`,
  inside a per-project build cache in the OS temp directory: the project folder
  never gets `.aux`, `.log` or PDF files, and assets (figures, `.sty`, `.bib`,
  chapters) are synced incrementally.
- **Solo mode** by default: no network, no hidden files, atomic saves of your
  `.tex`.
- **On-demand P2P collaboration** (Google-Docs style, live cursors): press
  *Share* and either share the folder through your cloud **or** send the room ID
  (a teammate joins with *Join*, no shared folder needed).
- **Dynamic host election**: in a room only the peer with the lowest `clientID`
  writes to disk (this is what avoids Drive/iCloud *conflicted copies*). If the
  host drops, the next peer takes over within milliseconds and consolidates the
  state.
- **Internet collaboration without third parties**: your own signaling server
  deployable in one click (`render.yaml`, Fly), end-to-end encrypted signaling
  with a key derived from the room ID, public STUN and an optional TURN relay
  for strict NATs. The public y-webrtc servers remain only as a fallback.
- **Project management**: create projects from templates (blank, article,
  report/thesis, beamer), recent projects, flexible root file (`main.tex` →
  first `.tex` with `\documentclass` → first `.tex`; the room remembers it).
- **Version history**: automatic snapshots as you save plus named versions,
  stored on your computer outside the project folder; compare with the current
  document and restore with minimal edits (peers merge it like any edit).
- **PDF preview** with pdf.js: keeps scroll and zoom across builds, lazy page
  rendering, export.
- **Clickable errors**: compiler output is parsed into an error/warning list; a
  click jumps to the line in the editor.
- **IDE layout**: action rail on the left (New, Open, Join, Share/Room, Build,
  Auto, Export, History, profile, language), top bar with project › root file
  and live status (mode, connection, save state, compiler, last build),
  draggable editor | PDF split, Monokai Pro palette. English and Spanish UI
  (auto-detected, switchable in the profile). UI zoom with `⌥`/`⌘` `+` `−` `0`.

## Install and run

Requirements: Node 22+, stable Rust, and a LaTeX engine on the system:

| OS      | Recommended                                   | Alternative                     |
| ------- | --------------------------------------------- | ------------------------------- |
| macOS   | `brew install tectonic`                       | MacTeX                          |
| Linux   | `cargo install tectonic` / distro package     | TeX Live (`texlive-latex-base`) |
| Windows | `winget install TectonicTypesetting.Tectonic` | MiKTeX                          |

The app looks for the engine in the usual locations (Homebrew, Cargo, MacTeX,
TeX Live, MiKTeX) even when launched from Finder/Explorer with a minimal PATH.
If none is found, the top bar shows it in red with instructions for your OS.

```bash
cd latex-p2p-editor
npm install
npm run tauri dev        # development
npm run tauri build      # production binary
```

## Two-minute demo

A ready-made example lives in [`examples/demo-project`](examples/demo-project)
(root `thesis.tex`, an included chapter via `\input`, a figure).

1. **Open** → pick a folder (for example `examples/demo-project`, or an empty
   one), or **New** → pick a template. The project opens in *Solo* mode; with
   **Auto** on, the PDF appears when you stop typing, and `⌘S`/`Ctrl+S` builds
   right away.
2. Press **Share**. `.texcollab/room.json` is created with the room ID and the
   room panel opens (*Host · Waiting for peers*).
3. On another computer (or *Profile → Open another window* on the same one),
   press **Join**, paste the ID and pick a local folder. Cursors and text sync
   live; the other peer shows up as *Guest*.
4. Close the host window: the guest becomes host and writes to its folder.
5. **Disconnect and work solo** (room panel) returns to solo mode without
   losing anything.

**History**: open the *History* rail item, type a label and save a version;
click a version to compare it with the current document and *Restore* it.

## Architecture

```
latex-p2p-editor/
├── src/
│   ├── components/
│   │   ├── Sidebar.tsx         # action rail (new, open, join, share, build, auto, export, history) + flyout panel
│   │   ├── TopBar.tsx          # project › root file, mode, connection, save state, compiler, last build, zoom
│   │   ├── CollabPanel.tsx     # room: ID, invite, peers, connection diagnostics
│   │   ├── JoinPanel.tsx       # join a room by ID
│   │   ├── NewProjectPanel.tsx # name, template, location
│   │   ├── HistoryPanel.tsx    # named versions + automatic snapshots
│   │   ├── DiffView.tsx        # version vs current document, restore
│   │   ├── ProfilePanel.tsx    # name, cursor color, language, signaling server, TURN relay
│   │   ├── Welcome.tsx         # start, recent projects, how it works
│   │   ├── SplitPane.tsx       # draggable editor | PDF divider
│   │   ├── LatexEditor.tsx     # CodeMirror 6 + y-codemirror.next (collaborative undo), Monokai theme
│   │   └── PdfPreview.tsx      # pdf.js viewer + clickable error list
│   ├── i18n/                   # en/es dictionaries and the useI18n hook
│   ├── services/
│   │   ├── collabManager.ts    # Y.Doc, WebrtcProvider (encrypted signaling, STUN/TURN), host election, persistence
│   │   ├── crdtSeed.ts         # deterministic document seeding (prevents duplicated text)
│   │   ├── latexLog.ts         # tectonic / pdflatex log parser
│   │   ├── textDiff.ts         # minimal-edit replacement (restore) and line diffs
│   │   ├── templates.ts        # project templates
│   │   ├── recents.ts          # recent projects (localStorage)
│   │   └── tauriBridge.ts      # typed invoke() wrappers
│   └── __tests__/              # vitest
├── src-tauri/src/
│   ├── lib.rs                  # Tauri commands, window close with flush
│   ├── project.rs              # root .tex detection, .texcollab/, atomic saves, project scaffolding
│   ├── history.rs              # version history store (app data dir)
│   ├── compiler.rs             # engine discovery, build cache, timeout
│   └── fsutil.rs               # write_atomic, path validation
├── examples/demo-project/      # sample project
├── signaling-server/           # self-hosted y-webrtc signaling server (Dockerfile, fly.toml)
└── render.yaml                 # Render Blueprint: one-click deploy of signaling-server
```

### Key decisions

- **Deterministic CRDT seeding** (`crdtSeed.ts`). Two peers that initialise
  their `Y.Doc` from the same `main.tex` with random `clientID`s produce
  different operations and the first sync **duplicates** the text. Seeding uses
  a `clientID` derived from the text hash, so identical seeds produce identical
  operations that Yjs deduplicates. When joining a room, seeding is also deferred
  until the first sync (or 4 s with nobody around) so the swarm's document wins
  over a stale local copy.
- **Robust host election.** Every peer publishes its y-webrtc `peerId` in
  awareness; when a WebRTC connection closes, its state is removed at once
  (instead of waiting for the 30 s awareness timeout). A promoted host flushes
  immediately. A freshly joined peer with a low `clientID` **does not write**
  until it is synced, so it never overwrites `main.tex` with an old copy.
- **Serialized, idempotent saves.** Never two concurrent writes of `main.tex`; a
  dirty flag avoids rewrites when nothing changed (fewer cloud uploads); closing
  the window and switching projects flush before tearing the session down. In
  Rust, `write_atomic` writes a hidden temp file, `fsync`s and renames.
- **Compile pipeline.** Async command (never blocks the UI), per-project cache
  with a manifest (copies only what changed, removes deleted assets, keeps engine
  intermediates), timeout that kills the process group, PDF returned as binary
  IPC bytes (not a JSON array). Automatic builds skip unchanged content; TeX
  itself is never incremental, so large documents benefit from `\include` +
  `\includeonly` and draft mode (see Known limitations).
- **Version history lives outside the project** (`<app data>/history/<project hash>/`):
  solo folders stay free of hidden files and cloud-synced folders do not get
  extra churn. Automatic snapshots are deduplicated and pruned; named versions
  are kept forever. Restoring applies a line diff in one transaction, so remote
  cursors and the CRDT history stay sane.
- **Network: self-hosted, encrypted signaling and configurable STUN/TURN.** The
  signaling server only introduces peers; the app hands y-webrtc a `password`
  (SHA-256 of `latexp2p:<room ID>`; the ID is already the shared secret) with
  which every signaling message is AES-GCM encrypted, so neither our server nor
  the public ones see SDP offers or ICE candidates. Server order: the one set
  in *Profile* → `VITE_SIGNALING_SERVER` → public y-webrtc servers (fallback
  only). NAT traversal uses Google STUN by default plus an optional TURN relay
  (*Profile* or `VITE_TURN_URL/USERNAME/CREDENTIAL`), passed to simple-peer as
  `peerOpts.config.iceServers`.

### Known limitations (honest)

- **Network partitions.** Host election assumes every peer sees every other
  peer. If the swarm splits, each side elects a host and, if they share a cloud
  folder, both write. When they reunite the CRDT merges in memory without loss
  and the host rewrites the result; the cloud may leave a *conflicted copy* that
  can be deleted. There is no "zero conflicts" guarantee without a server.
- **Signaling.** Peers need a rendezvous point to find each other over the
  Internet (never for the content). Deploy your own with
  [`render.yaml`](render.yaml) or [`signaling-server/fly.toml`](signaling-server/fly.toml)
  and set it in *Profile* or with `VITE_SIGNALING_SERVER`; the public y-webrtc
  servers are third-party and only a fallback. If none answers, the top bar
  says so (*No signaling*). On Render's free plan the first connection after
  idle time takes 30-60 s while the instance wakes up.
- **Symmetric NATs.** With STUN alone, two peers behind symmetric NATs
  (corporate networks, 4G/5G) cannot connect: a **TURN** relay is required
  (*Profile → TURN relay* or `VITE_TURN_*`; coturn or a managed provider). The
  app ships none by default. The room panel shows whether TURN is configured.
- **Single editable file.** The whole project is compiled (`\input`, `.bib`,
  figures) but the editor opens only the root file. The backend already handles
  arbitrary paths; multi-file editing is the next step.
- **No incremental typesetting.** Every build re-typesets the document; auto
  build is debounced (2.5 s) and skipped when nothing changed.
- **Collaboration tests use a simulated `WebrtcProvider`**: they exercise the
  real manager (election, failover, seeding, saves) through the events y-webrtc
  emits, but they do not replace a test between two real machines.

## Tests

```bash
cd latex-p2p-editor
npm test                 # vitest: CRDT seeding, log parser, CollabManager, encrypted signaling, STUN/TURN, i18n, recents, templates, diffs
npm run build            # tsc + vite

cd src-tauri
cargo test               # project, history, fsutil, compiler (compile tests are skipped without an engine)
```
