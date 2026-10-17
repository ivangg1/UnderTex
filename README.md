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
- **Project files travel with the room**: images, `.bib`, `.sty` and
  `\input`/`\include` chapters are sent peer-to-peer over the same connection,
  so a guest who joins by room ID with an empty folder can compile right away.
  Received files live in a per-room cache in the app data dir (never in the
  guest's folder); the guest's own files always win. The *Room* panel shows how
  many files are available, what is being received and what only an offline
  peer has, and a build that fails on such a file says so in plain words and
  runs again when it arrives.
- **Cloud folder detection**: the room panel and the top-bar tooltip show which
  sync client keeps the project (Google Drive, iCloud Drive, OneDrive, Dropbox,
  Box) and the account from its folder name, e.g. *Google Drive ·
  ana@gmail.com*. Detection is path-based only (macOS `~/Library/CloudStorage`,
  `G:\My Drive`, `%USERPROFILE%\OneDrive`, `~/Dropbox`, …), no cloud API or
  sign-in. When a host's project is local, the panel reminds them that guests
  only get files from peers who are online (open text files live, the rest as
  copies), and suggests a shared cloud folder.
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
- **Multi-file editing**: a project file tree (folders, per-type icons for
  `.tex`, `.bib`, `.sty`/`.cls`, images and PDFs, the root file marked with a
  crown) with create / rename / delete and *Set as main file*. Text files open
  in tabs; images and PDFs open in a read-only preview. Every open file keeps
  its own cursor and undo history across tab switches.
- **Every file is collaborative**: in a room each text file gets its own shared
  text, so peers edit chapters, `.bib` and `.sty` files live, see who has which
  file open (colored dots in the tree and tabs), and a guest who joined by room
  ID sees the host's files in the tree even when they are not on its disk. The
  root file choice is shared with the room.
- **What you see is what compiles**: a build uses the editor's content of every
  file the session holds (unsaved edits and edits from peers included), written
  over their copies in the build cache only.
- **Clickable errors across files**: compiler output is parsed into an
  error/warning list; a click opens the right file at the right line (paths are
  resolved from the root file's folder, also for nested roots). The status bar
  shows the error / warning count.
- **Outline and quick navigation**: an *Outline* view lists the sections of the
  open file (the one at the cursor highlighted) and its `\input`/`\include`d
  files (click to open; missing ones flagged). `⌘P` fuzzy-finds any file, `@`
  in the same box jumps to a section, `:` to a line.
- **Smart references**: typing `\ref{`, `\cref{`, `\eqref{`… lists every
  `\label` of the project (open files, files shared by peers and files only on
  disk) with what it labels; `\cite{` lists the `.bib` keys with author, year
  and title; `\input{`, `\include{`, `\includegraphics{` and
  `\bibliography{` complete project paths relative to the root file. `F12` on
  a reference, citation or path opens its definition in the right file.
- **Dark and light themes**: Monokai Pro and Monokai Pro Light, or follow the
  system; switch from the rail (sun / moon) or the profile panel. Every color is
  a CSS variable, so the editor, panels and previews switch instantly.
- **IDE layout**: the top bar holds the project menu (new, open, join, recent,
  new window), the root file, *Go to file…* and the primary actions — **Build**
  (with the auto-build switch), **Share** / Room and **Export** — plus the
  build options (scope, draft, preamble). The left rail switches views (Files,
  Outline, History, Room) with one side panel at a time; a bottom status bar
  shows mode, connection, save state, problems, cursor line, compiler and the
  last build. Draggable editor | PDF split, Monokai Pro palette. English and
  Spanish UI (auto-detected, switchable in the profile).

#### Keyboard shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Build | `⌘S` or `⌘↵` | `Ctrl+S` or `Ctrl+Enter` |
| Go to file | `⌘P` | `Ctrl+P` |
| Go to section of the open file | `⌘⇧O` | `Ctrl+Shift+O` |
| Go to line | `⌃G` | `Ctrl+G` |
| Toggle side panel | `⌘B` | `Ctrl+B` |
| Files / Outline / History view | `⌘⇧E` / `⌘⇧L` / `⌘⇧H` | `Ctrl+Shift+E` / `L` / `H` |
| Next / previous tab | `⌃Tab` / `⌃⇧Tab` | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Export PDF | `⌘E` | `Ctrl+E` |
| Go to definition (`\ref`, `\cite`, `\input`, figure) | `F12` | `F12` |
| Open folder | `⌘O` | `Ctrl+O` |
| UI zoom | `⌘`/`⌥` `+` `−` `0` | `Ctrl`/`Alt` `+` `−` `0` |

Tabs close with `×` or a middle click (`⌘W` is left to the window).

#### Compared with Overleaf

The layout borrows the familiar parts (tree, editor, PDF) but differs where it
matters for a local, serverless editor: builds run on your machine (no queue,
incremental build cache, chapter-only and draft builds), collaboration is
peer-to-peer with no account or server, errors open the right file directly,
and navigation is keyboard-first (fuzzy file search, section and line jumps).

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
│   │   ├── CollabPanel.tsx     # room: ID, invite, peers, connection diagnostics, shared project files
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
│   │   ├── assetSync.ts        # project files over the room: manifest, chunked transfer, missing-file hints
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
│   ├── compiler.rs             # engine discovery, build cache (+ room asset cache), timeout, chapter/draft/preamble rewrites
│   ├── assets.rs               # shareable file listing (SHA-256), chunk reads, per-room asset cache
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
- **Project files over the room** (`assetSync.ts`, `assets.rs`). Rust lists
  the files a build may need (the build-cache set minus the root file, limited
  to TeX, figure, font and data extensions so unrelated documents in a guest's
  folder are never shared) with their SHA-256. Every peer publishes its own
  files in a `Y.Map` manifest (`path → {hash, size, by}`); an entry whose
  publisher is online is only replaced when the file changes locally during the
  session, so a guest's stale copy never overrides the host's version. Peers
  advertise in awareness which hashes they can send; a guest requests one file
  at a time (`assetRequests`) and the lowest-`clientID` peer that has it writes
  16 KiB chunks into `assetChunks`, keeping at most 8 per file in the document
  and deleting them as the guest acknowledges. Every update stays far below
  WebRTC's message size limit and a late joiner's initial sync stays small.
  Received files are verified against their hash in Rust and stored under
  `<app data>/asset-cache/room-<fnv64(room, folder)>/`; `compile` merges that
  cache under the project folder in the build directory. Transfers are not
  edits: they never trigger a `main.tex` save. The per-file limit is 20 MB
  (`localStorage["latex_asset_max_mb"]` changes it).
- **One shared text per file** (`collabManager.ts`). The root file keeps the
  legacy `codemirror` Y.Text, so peers on older versions still meet in the same
  text; every other file is a top-level `file:<relative path>` Y.Text, created
  when a peer opens it and listed in a `files` Y.Map registry. Opening a file
  waits for the room's initial sync (or the seed wait) and seeds from disk only
  when nobody shared it yet; seeds are deterministic per key and content, so two
  peers seeding the same file converge. The doc records which file the legacy
  text belongs to (`meta.primaryFile`, falling back to `room.json`), so choosing
  another root never maps that text onto the wrong file. The host tracks which
  texts each transaction changed and writes only those files (`write_atomic`,
  serialized with the root file and `crdt_state.bin`); files that left the
  registry (deleted, renamed) are never written back. A rename moves the text to
  the new path; a deleted path re-created later takes the disk content.
- **Builds from memory** (`compiler.rs::apply_file_overrides`). After the
  incremental asset sync, the editor's text of every shared file is written over
  its copy in the build cache (identical content is not rewritten, so engine
  caches stay warm) and its manifest entry is invalidated, so the next build
  restores the disk version when the file is no longer overridden.
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
- **Files nobody opened travel as files.** A chapter or `.bib` becomes
  collaborative text once someone opens it; until then it reaches guests as a
  file (rescanned every 4 s, last writer wins). Images and PDFs always travel as
  files. Version history covers the room's primary (original root) file only,
  and in a room that file cannot be renamed or deleted. Files above the transfer
  limit, and files only an offline peer has, must be copied by hand. The
  transfer runs over the CRDT connection, so it is meant for typical thesis
  assets (megabytes), not gigabytes.
- **No incremental typesetting.** Every build re-typesets what it is asked to;
  auto build is debounced (2.5 s) and skipped when nothing changed. The
  shortcuts have limits of their own:
  - *Active chapter* needs chapters pulled in with `\include` (not `\input`)
    and a previous full build so the other chapters' `.aux` files exist.
  - *Draft* changes the output (frames instead of figures, marked overfull boxes).
  - The *precompiled preamble* is `pdflatex` only and requires `mylatexformat.ltx`.

## Joining through a shared cloud folder

When the host's project lives in Google Drive, OneDrive, Dropbox, iCloud Drive or
Box, the app publishes that in the room. A teammate who presses **Join** with the
room ID never has to pick a folder:

1. If the shared folder is already synced on their computer, it is found by its
   room ID under the local sync folders and opened directly.
2. Otherwise they start in a temporary workspace (text syncs live) and the app
   checks whether the provider's client is installed: if not, it offers the
   download page; if it is, it keeps looking for the folder and switches to it
   automatically once the share has synced.

The app cannot grant access: the host still shares the folder in the provider.

## Releases and auto-update

Pushing a tag `vX.Y.Z` (matching `latex-p2p-editor/src-tauri/tauri.conf.json`)
runs [`release.yml`](.github/workflows/release.yml): it builds macOS (Apple
Silicon and Intel), Windows and Linux bundles, signs the updater artifacts and
publishes a GitHub Release with `latest.json`. Installed apps check that file on
start-up and every six hours, download the new version in the background and
show a *Restart and update* banner.

Required repository secrets (Settings → Secrets → Actions):

| Secret                               | Value                                                     |
| ------------------------------------ | --------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | contents of the updater private key (`tauri signer generate`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the key's password (empty if none)                        |

The matching public key is in `tauri.conf.json` (`plugins.updater.pubkey`).
Losing the private key means future updates cannot be signed for existing
installs. [`ci.yml`](.github/workflows/ci.yml) runs vitest, the build and
`cargo test` on every push and pull request.

## Tests

```bash
cd latex-p2p-editor
npm test                 # vitest: CRDT seed, parser, CollabManager, multi-file collaboration, outline, quick open, shortcuts, file tree, reference index and completion, themes, asset sync protocol, encrypted signaling, STUN/TURN, i18n, templates, diffs, chapters, build modes
npm run build            # tsc + vite

cd src-tauri
cargo test               # project (tree, file ops, binary previews), history, fsutil, assets (listing, cache), compiler: editor overrides, room-cache merge, includeonly/draft/preamble rewrites, format cache, real chapter builds
```
