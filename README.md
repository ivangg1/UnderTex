# LaTeX P2P Desktop Editor

A **local-first** desktop LaTeX editor: it compiles on your own CPU (no server
timeouts) and collaborates in real time over **P2P (WebRTC + CRDT)** without a
paid central server. Built for people who use free Overleaf and hit its
compile limits.

```text
┌──────────────────────────┐      WebRTC (yjs + y-webrtc)      ┌──────────────────────────┐
│  Peer A  (Host 👑)        │ ◄──────────────────────────────► │  Peer B  (Guest)          │
│  CodeMirror 6 ⇄ Y.Doc    │  encrypted signaling / STUN/TURN  │  CodeMirror 6 ⇄ Y.Doc    │
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
- **Fast builds for long documents**: an *Active chapter* scope typesets only
  the `\include`d chapter at the cursor (numbering and references come from the
  cached full build), a *Draft* switch adds `[draft]` to the build copy, and
  with `pdflatex` the preamble can be precompiled into a `.fmt` and reused.
  None of this touches your files, and *Export* always builds the whole document.
- **Solo mode** by default: no network, no hidden files, atomic saves of your
  `.tex`.
- **On-demand P2P collaboration** (Google-Docs style, live cursors): press
  *Share* and either share the folder through your cloud **or** send the room ID
  (a teammate joins with *Join*, no shared folder needed).
- **Dynamic host election**: in a room only the peer with the lowest `clientID`
  writes to disk (this is what avoids Drive/iCloud *conflicted copies*). If the
  host drops, the next peer takes over within milliseconds and consolidates the
  state.
- **Internet collaboration without third-party dependencies**: self-hosted
  signaling server with 1-click deploy (`render.yaml`, Fly.io), end-to-end
  encrypted signaling derived from room ID (AES-GCM), public Google STUN and
  optional TURN relay for strict/symmetric NATs. Public y-webrtc servers serve as fallback.
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
git clone https://github.com/ivangg1/editor-p2p-latex.git
cd editor-p2p-latex/latex-p2p-editor
npm install
npm run tauri dev
```

Try opening `examples/demo-project/` (single-file article with figure) or `examples/book-project/`
(root `book.tex`, three `\include`d chapters). Build it once, then pick
*Active chapter (cursor)* in the top bar and put the cursor on an `\include`
line: only that chapter is typeset, with the right chapter and page numbers.
*Draft* speeds things up further; *Export* still ships the whole document.

## Architecture

```text
latex-p2p-editor/
├── src/
│   ├── components/
│   │   ├── Sidebar.tsx         # action rail (new, open, join, share, build, auto, export, history) + flyout panel
│   │   ├── TopBar.tsx          # project › root file, build scope / draft / preamble, mode, connection, save, compiler, last build
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
│   │   ├── collabManager.ts    # Y.Doc, WebrtcProvider (encrypted signaling, STUN/TURN), awareness, host election, persistence
│   │   ├── crdtSeed.ts         # deterministic document seeding (prevents duplicated text)
│   │   ├── latexLog.ts         # tectonic / pdflatex log parser
│   │   ├── chapters.ts         # \include detection, chapter at the cursor
│   │   ├── buildMode.ts        # build scope / draft / preamble → BuildOptions
│   │   ├── textDiff.ts         # minimal-edit replacement (restore) and line diffs
│   │   ├── templates.ts        # project templates
│   │   ├── recents.ts          # recent projects (localStorage)
│   │   └── tauriBridge.ts      # typed invoke() wrappers
│   └── __tests__/              # vitest
├── src-tauri/src/
│   ├── lib.rs                  # Tauri commands, window close with flush
│   ├── project.rs              # root .tex detection, .texcollab/, atomic saves, project scaffolding
│   ├── history.rs              # version history store (app data dir)
│   ├── compiler.rs             # engine discovery, build cache, timeout, chapter/draft/preamble rewrites
│   └── fsutil.rs               # write_atomic, path validation
├── examples/demo-project/      # sample project
├── examples/book-project/      # sample report with \include'd chapters (try "Active chapter")
├── signaling-server/           # self-hosted y-webrtc signaling server (Dockerfile, fly.toml)
└── render.yaml                 # 1-click Render blueprint deploy for signaling-server
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
  Rust `write_atomic` writes to a unique temporary file, calls `fsync`, and
  renames over the target.
- **Encrypted signaling & configurable STUN/TURN.** WebRTC signaling messages
  are end-to-end encrypted with an AES-GCM key derived from `SHA-256("latexp2p:<roomID>")`.
  No third-party signaling relay can inspect document offers or candidates. For NAT traversal,
  Google STUN is used by default with optional TURN relay settings in the profile.
- **Self-contained build cache.** The user's folder is copied incrementally
  into the OS temp directory (`build-<fnv64(canonical_path)>`), intermediates
  stay there across builds, and the PDF is read back into RAM. The project
  folder remains untouched.

### Known limitations (honest)

- **Network partitions.** Host election assumes every peer sees every other
  peer. If the swarm splits, each side elects a host and, if they share a cloud
  folder, both write. When they reunite the CRDT merges in memory without loss
  and the host rewrites the result; the cloud may leave a *conflicted copy* that
  can be deleted. There is no "zero conflicts" guarantee without a server.
- **Signaling.** Peers need a rendezvous point to find each other over the
  Internet; the public y-webrtc servers are third-party. You can deploy your own
  with `render.yaml` or `signaling-server/fly.toml` and configure it in *Profile* or with
  `VITE_SIGNALING_SERVER`. Symmetric NATs additionally need a TURN relay.
- **Single editable file.** The whole project is compiled (`\input`, `.bib`,
  figures) but the editor opens only the root file. The backend already handles
  arbitrary paths; multi-file tabbed editing is the next step.
- **No incremental typesetting.** Every build re-typesets what it is asked to;
  auto build is debounced (2.5 s) and skipped when nothing changed. The
  shortcuts have limits of their own:
  - *Active chapter* needs chapters pulled in with `\include` (not `\input`)
    and a previous full build so the other chapters' `.aux` files exist.
  - *Draft* changes the output (frames instead of figures, marked overfull boxes).
  - The *precompiled preamble* is `pdflatex` only and requires `mylatexformat.ltx`.

## Tests

```bash
cd latex-p2p-editor
npm test                 # vitest: CRDT seed, parser, CollabManager, encrypted signaling, STUN/TURN, i18n, templates, diffs, chapters, build modes
npm run build            # tsc + vite

cd src-tauri
cargo test               # project, history, fsutil, compiler: includeonly/draft/preamble rewrites, format cache, and real chapter build
```
