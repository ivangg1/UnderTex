import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { documentDir } from "@tauri-apps/api/path";

import Sidebar, { type PanelId } from "./components/Sidebar";
import TopBar from "./components/TopBar";
import StatusBar from "./components/StatusBar";
import Welcome from "./components/Welcome";
import SplitPane from "./components/SplitPane";
import CollabPanel from "./components/CollabPanel";
import JoinPanel from "./components/JoinPanel";
import ProfilePanel, { PRESET_COLORS } from "./components/ProfilePanel";
import NewProjectPanel from "./components/NewProjectPanel";
import HistoryPanel from "./components/HistoryPanel";
import DiffView from "./components/DiffView";
import LatexEditor, { type LatexEditorHandle } from "./components/LatexEditor";
import PdfPreview, { type CompileSummary } from "./components/PdfPreview";
import FileTree, { isEditableFile, isPreviewableFile } from "./components/FileTree";
import EditorTabs from "./components/EditorTabs";
import OutlinePanel from "./components/OutlinePanel";
import QuickOpen, { type QuickOpenMode } from "./components/QuickOpen";
import AssetPreview from "./components/AssetPreview";
import {
  pickProjectFolder,
  pickParentFolder,
  readProject,
  createProject,
  initCollabProject,
  compileLatex,
  readBuildFile,
  detectCompiler,
  exportPdf,
  openNewWindow,
  onCloseRequested,
  closeWindow,
  historyList,
  historySave,
  historyRead,
  historyDelete,
  cloudClients,
  locateRoomInCloud,
  roomWorkspacesDir,
  ensureRoomWorkspace,
  openExternalUrl,
  listProjectFiles,
  readProjectFile,
  createProjectNode,
  deleteProjectNode,
  renameProjectNode,
  type BuildOptions,
  type CloudLocation,
  type CloudProvider,
  type CompileOutput,
  type CompilerInfo,
  type SnapshotMeta,
} from "./services/tauriBridge";
import { findIncludes } from "./services/chapters";
import {
  DEFAULT_BUILD_SETTINGS,
  PLAIN_BUILD,
  buildKey,
  effectiveScope,
  isExportable,
  resolveBuildOptions,
  scopeChapter,
  type BuildScope,
  type BuildSettings,
} from "./services/buildMode";
import { decideCloudAssist, providerDownloadUrl, isRoomWorkspace, seedTextFor, type CloudAssist } from "./services/cloudAssist";
import { cloudLabel } from "./services/cloud";
import {
  checkAndStageUpdate,
  installStagedUpdateAndRelaunch,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  type UpdateState,
} from "./services/updater";
import UpdateBanner from "./components/UpdateBanner";
import { Cloud, Download, FilePlus, FolderPlus, Loader2, RefreshCw } from "lucide-react";
import {
  CollabManager,
  type RoomInfo,
  type CollabUser,
  type PeerInfo,
  type ConnectionStatus,
  type ConnectionDiagnostics,
  type CollabMode,
  type SaveState,
} from "./services/collabManager";
import { parseLatexLog, type LatexDiagnostic } from "./services/latexLog";
import { EMPTY_ASSET_STATUS, explainMissingAsset, type AssetSyncStatus } from "./services/assetSync";
import { addRecent, readRecents, removeRecent, type RecentProject } from "./services/recents";
import { findTemplate } from "./services/templates";
import { chapterOfFile, parseOutline, type OutlineItem } from "./services/outline";
import {
  flattenFiles,
  isSameOrInside,
  mergeSharedFiles,
  renamePath,
  resolveDiagnosticFile,
  type TreeNode,
} from "./services/projectFiles";
import { isMac, matchShortcut, shortcutLabel } from "./services/shortcuts";
import { buildIndex, EMPTY_INDEX, type ProjectIndex } from "./services/references";
import { useTheme } from "./services/theme";
import { useI18n, type MessageKey } from "./i18n";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

const AUTO_COMPILE_KEY = "latex_auto_compile";
const BUILD_DRAFT_KEY = "latex_build_draft";
const BUILD_PREAMBLE_KEY = "latex_build_preamble";
const SIDEBAR_KEY = "latex_sidebar_view";
const AUTO_COMPILE_DEBOUNCE_MS = 2500;
const AUTO_SNAPSHOT_INTERVAL_MS = 2 * 60 * 1000;
const OUTLINE_DEBOUNCE_MS = 250;
const UI_ZOOM_KEY = "latex_ui_zoom";
const UI_ZOOM_MIN = 0.6;
const UI_ZOOM_MAX = 1.8;
const UI_ZOOM_STEP = 0.1;
const MAC = isMac();

function getSavedUser(): CollabUser {
  // sessionStorage: each window/instance gets its own identity.
  const savedName = sessionStorage.getItem("latex_user_name");
  const savedColor = sessionStorage.getItem("latex_user_color");
  if (savedName && savedColor) {
    return { name: savedName, color: savedColor };
  }
  const name = `User_${Math.floor(1000 + Math.random() * 9000)}`;
  const color = PRESET_COLORS[Math.floor(Math.random() * (PRESET_COLORS.length - 2))];
  sessionStorage.setItem("latex_user_name", name);
  sessionStorage.setItem("latex_user_color", color);
  return { name, color };
}

function readZoom(): number {
  try {
    const z = Number(localStorage.getItem(UI_ZOOM_KEY));
    if (z >= UI_ZOOM_MIN && z <= UI_ZOOM_MAX) return z;
  } catch {
    // ignore
  }
  return 1;
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore
  }
}

/** Side view shown when a project opens (the last one used, Files by default). */
function readSidebarView(): PanelId | null {
  try {
    const v = localStorage.getItem(SIDEBAR_KEY);
    if (v === "none") return null;
    if (v === "files" || v === "outline" || v === "history") return v;
  } catch {
    // ignore
  }
  return "files";
}

function errorMessage(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

interface ProjectInfo {
  path: string;
  /** File compiled as the document root (can be changed with "Set as main file"). */
  rootFile: string;
  /** File whose text is the room's legacy shared text; snapshots cover it. */
  primaryFile: string;
  cloud: CloudLocation;
}

/** The editor binds to these; a new object means a new editor instance. */
interface EditorSession {
  key: string;
  path: string;
  ytext: Y.Text;
  awareness: Awareness;
  undoManager: Y.UndoManager;
}

interface CompileState {
  pdfData: Uint8Array | null;
  pdfVersion: number;
  pdfPath: string | null;
  /** `true` when the PDF at `pdfPath` comes from a full, non-draft build (exportable as is). */
  pdfPlain: boolean;
  logs: string | null;
  diagnostics: LatexDiagnostic[];
  summary: CompileSummary | null;
  fatalError: string | null;
}

const EMPTY_COMPILE: CompileState = {
  pdfData: null,
  pdfVersion: 0,
  pdfPath: null,
  pdfPlain: false,
  logs: null,
  diagnostics: [],
  summary: null,
  fatalError: null,
};

interface CompileRequest {
  /** Automatic (debounced) build: quiet, and skipped when nothing changed. */
  auto?: boolean;
  /** Ignore the build mode: full document, no draft, no format (Export). */
  plain?: boolean;
  /** Settings to use instead of the current ones (right after a toggle). */
  settings?: BuildSettings;
}

const IDLE_SAVE: SaveState = { status: "idle", lastSavedAt: null, error: null };

interface Banner {
  kind: "error" | "info";
  text: string;
}

/** Text files read for the reference index (labels, .bib entries). */
const INDEXED_RE = /\.(tex|bib|sty|cls)$/i;
const MAX_INDEXED_FILES = 500;

function App() {
  const { t } = useI18n();
  const [, resolvedTheme] = useTheme();

  // ─── Project & session ──────────────────────────────────────────
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [fileTree, setFileTree] = useState<TreeNode[]>([]);
  const [sharedFiles, setSharedFiles] = useState<string[]>([]);
  const [tabs, setTabs] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [session, setSession] = useState<EditorSession | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [quickOpen, setQuickOpen] = useState<QuickOpenMode | null>(null);
  const [createRequest, setCreateRequest] = useState<{ isDir: boolean; seq: number } | null>(null);
  const [problemsRequest, setProblemsRequest] = useState(0);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [recents, setRecents] = useState<RecentProject[]>(() => readRecents());
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);
  const [defaultParent, setDefaultParent] = useState<string | null>(null);

  // ─── Cloud assist (guest joining a room kept in the host's cloud) ──
  const [roomInfo, setRoomInfo] = useState<RoomInfo>({});
  const [workspacesDir, setWorkspacesDir] = useState<string | null>(null);
  const workspacesDirRef = useRef<string | null>(null);
  workspacesDirRef.current = workspacesDir;
  const [installedProviders, setInstalledProviders] = useState<string[]>([]);
  const [cloudAssist, setCloudAssist] = useState<CloudAssist>({ kind: "none" });
  const [assistDismissedFor, setAssistDismissedFor] = useState<string | null>(null);

  // ─── Auto-update ────────────────────────────────────────────────
  const [updateState, setUpdateState] = useState<UpdateState>({ status: "idle" });

  // ─── Collaboration ──────────────────────────────────────────────
  const [currentUser, setCurrentUser] = useState<CollabUser>(getSavedUser);
  const [mode, setMode] = useState<CollabMode>("solo");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(true);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [diagnostics, setDiagnostics] = useState<ConnectionDiagnostics | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(IDLE_SAVE);
  const [assets, setAssets] = useState<AssetSyncStatus>(EMPTY_ASSET_STATUS);

  // ─── Compiler ───────────────────────────────────────────────────
  const [compilerInfo, setCompilerInfo] = useState<CompilerInfo | null>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [compileQuiet, setCompileQuiet] = useState(false);
  const [compile, setCompile] = useState<CompileState>(EMPTY_COMPILE);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [autoCompile, setAutoCompileState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_COMPILE_KEY) !== "0"; // default: on
    } catch {
      return true;
    }
  });
  // Build mode for large documents: scope is per project (reset on open), the
  // draft and precompiled-preamble switches are remembered.
  const [buildSettings, setBuildSettings] = useState<BuildSettings>(() => ({
    ...DEFAULT_BUILD_SETTINGS,
    draft: readFlag(BUILD_DRAFT_KEY, false),
    precompiledPreamble: readFlag(BUILD_PREAMBLE_KEY, false),
  }));
  /** Chapters the root file currently `\include`s (drives the scope control). */
  const [chapters, setChapters] = useState<string[]>([]);

  // ─── History ────────────────────────────────────────────────────
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState<SnapshotMeta | null>(null);
  const [snapshotText, setSnapshotText] = useState<string | null>(null);
  const [currentText, setCurrentText] = useState("");

  // ─── UI zoom ────────────────────────────────────────────────────
  const [uiZoom, setUiZoom] = useState<number>(readZoom);

  const managerRef = useRef<CollabManager | null>(null);
  const editorRef = useRef<LatexEditorHandle | null>(null);
  const compilingRef = useRef(false);
  const compileQueuedRef = useRef<null | { auto: boolean }>(null);
  const lastCompiledRef = useRef<{ key: string; success: boolean } | null>(null);
  const buildSettingsRef = useRef(buildSettings);
  buildSettingsRef.current = buildSettings;
  const autoCompileRef = useRef(autoCompile);
  autoCompileRef.current = autoCompile;
  const autoCompileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoSnapshotRef = useRef(0);
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;
  const projectRef = useRef(project);
  projectRef.current = project;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  /** Root file text read from disk when the room does not hold it as text. */
  const rootDiskTextRef = useRef<string>("");
  /** Cursor offset per file, restored when coming back to a tab. */
  const anchorsRef = useRef(new Map<string, number>());
  /** Most recently used files first (quick open). */
  const recentFilesRef = useRef<string[]>([]);
  /** Guards against an older, slower file open finishing after a newer one. */
  const openSeqRef = useRef(0);
  /** A line to jump to once the editor of that file is mounted. */
  const pendingJumpRef = useRef<{ path: string; line: number } | null>(null);

  const compilerHint =
    compilerInfo && compilerInfo.name === null ? t(`compiler.hint.${compilerInfo.os}` as MessageKey) : null;

  // ─── Startup: compiler, default project location ────────────────
  useEffect(() => {
    detectCompiler()
      .then(setCompilerInfo)
      .catch((err) => console.error("detect_compiler failed:", err));
    documentDir()
      .then((dir) => setDefaultParent(dir))
      .catch(() => setDefaultParent(null));
    roomWorkspacesDir()
      .then(setWorkspacesDir)
      .catch((err) => console.error("room_workspaces_dir failed:", err));
    cloudClients()
      .then((clients) => setInstalledProviders(clients.map((c) => c.provider)))
      .catch((err) => console.error("cloud_clients failed:", err));
  }, []);

  // Periodic update check: the new version downloads in the background and a
  // banner offers the restart. Skipped in development (no release endpoint).
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let cancelled = false;
    const run = () => {
      if (!cancelled) void checkAndStageUpdate({ onState: (st) => !cancelled && setUpdateState(st) });
    };
    const first = setTimeout(run, FIRST_CHECK_DELAY_MS);
    const interval = setInterval(run, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(interval);
    };
  }, []);

  /** Text of the root file: the room's (or editor's) copy, else what is on disk. */
  const rootText = useCallback((): string => {
    const manager = managerRef.current;
    const current = projectRef.current;
    if (!manager || !current) return "";
    return manager.getFileText(current.rootFile) ?? rootDiskTextRef.current;
  }, []);

  // ─── Compile ────────────────────────────────────────────────────
  /** Runs one build; resolves to the backend result, or `null` when skipped/queued/failed. */
  const runCompile = useCallback(async (opts: CompileRequest = {}): Promise<CompileOutput | null> => {
    const manager = managerRef.current;
    const current = projectRef.current;
    if (!manager || !current) return null;
    const auto = opts.auto ?? false;
    if (compilingRef.current) {
      compileQueuedRef.current = { auto: auto && (compileQueuedRef.current?.auto ?? true) };
      return null;
    }
    const root = current.rootFile;
    const text = rootText();
    // Every other file the editor holds (open tabs, files peers edit) replaces
    // its disk copy for this build: what you see is what compiles.
    const openFiles = manager.fileContents();
    delete openFiles[root];
    const includes = findIncludes(text);
    const active = activeFileRef.current;
    const cursorChapter =
      active === root ? (editorRef.current?.getActiveChapter() ?? null) : active ? chapterOfFile(active, root, includes) : null;
    // The build mode only touches the build copy of the root file; Export asks for a plain build.
    const options: BuildOptions = opts.plain
      ? PLAIN_BUILD
      : resolveBuildOptions(
          opts.settings ?? buildSettingsRef.current,
          includes.map((c) => c.name),
          cursorChapter
        );
    const key = buildKey(`${root}\u0000${text}\u0000${JSON.stringify(openFiles)}`, options);
    // Automatic builds skip unchanged input (text + mode); a manual build always runs.
    if (auto && lastCompiledRef.current && lastCompiledRef.current.key === key && lastCompiledRef.current.success) {
      return null;
    }
    compilingRef.current = true;
    setIsCompiling(true);
    setCompileQuiet(auto);
    try {
      await manager.flushSave();
      // In a room, files received from peers fill in what the project folder lacks.
      const roomId = manager.mode === "collab" ? manager.roomId : null;
      const result = await compileLatex(current.path, root, text, options, undefined, roomId, openFiles);
      const parsed = parseLatexLog(result.logs);
      let pdfData: Uint8Array | null = null;
      if (result.pdf_path) {
        try {
          pdfData = await readBuildFile(result.pdf_path);
        } catch (err) {
          console.error("Failed to read compiled PDF:", err);
        }
      }
      lastCompiledRef.current = { key, success: result.success };
      setCompile((prev) => ({
        pdfData: pdfData ?? prev.pdfData, // keep the last good PDF visible on failure
        pdfVersion: pdfData ? prev.pdfVersion + 1 : prev.pdfVersion,
        pdfPath: result.pdf_path ?? prev.pdfPath,
        pdfPlain: result.pdf_path ? isExportable(result) : prev.pdfPlain,
        logs: result.logs,
        diagnostics: parsed,
        summary: {
          success: result.success,
          compiler: result.compiler,
          durationMs: result.duration_ms,
          timedOut: result.timed_out,
          mode: result.mode,
          chapter: result.chapter,
          draft: result.draft,
          preamble: result.preamble,
        },
        fatalError: null,
      }));
      return result;
    } catch (err: unknown) {
      const message = errorMessage(err);
      console.error("Compilation error:", err);
      setCompile((prev) => ({ ...prev, logs: message, diagnostics: [], summary: null, fatalError: message }));
      return null;
    } finally {
      compilingRef.current = false;
      setIsCompiling(false);
      const queued = compileQueuedRef.current;
      if (queued) {
        compileQueuedRef.current = null;
        setTimeout(() => void runCompile(queued), 0);
      }
    }
  }, [rootText]);

  const handleCompile = useCallback(() => void runCompile(), [runCompile]);

  // Chapters (`\include`) of the root file, kept current for the scope control.
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !project) {
      setChapters([]);
      return;
    }
    const update = () => {
      const names = Array.from(new Set(findIncludes(rootText()).map((c) => c.name)));
      setChapters((prev) => (prev.length === names.length && prev.every((n, i) => n === names[i]) ? prev : names));
    };
    update();
    manager.doc.on("update", update);
    return () => manager.doc.off("update", update);
  }, [project?.path, project?.rootFile, session?.key, rootText]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Applies a build-mode change and, with auto build on, rebuilds right away. */
  const updateBuildSettings = useCallback(
    (patch: Partial<BuildSettings>) => {
      const next = { ...buildSettingsRef.current, ...patch };
      buildSettingsRef.current = next;
      setBuildSettings(next);
      writeFlag(BUILD_DRAFT_KEY, next.draft);
      writeFlag(BUILD_PREAMBLE_KEY, next.precompiledPreamble);
      if (autoCompileRef.current && projectRef.current) void runCompile({ auto: true, settings: next });
    },
    [runCompile]
  );
  const handleChangeScope = useCallback((scope: BuildScope) => updateBuildSettings({ scope }), [updateBuildSettings]);
  const handleToggleDraft = useCallback(
    () => updateBuildSettings({ draft: !buildSettingsRef.current.draft }),
    [updateBuildSettings]
  );
  const handleTogglePreamble = useCallback(
    () => updateBuildSettings({ precompiledPreamble: !buildSettingsRef.current.precompiledPreamble }),
    [updateBuildSettings]
  );

  // Auto-compile: debounce document updates (any file).
  const managerKey = project?.path ?? null;
  useEffect(() => {
    const manager = managerRef.current;
    if (!autoCompile || !manager || !managerKey) return;
    const onUpdate = () => {
      if (autoCompileTimer.current) clearTimeout(autoCompileTimer.current);
      autoCompileTimer.current = setTimeout(() => {
        autoCompileTimer.current = null;
        void runCompile({ auto: true });
      }, AUTO_COMPILE_DEBOUNCE_MS);
    };
    manager.doc.on("update", onUpdate);
    return () => {
      manager.doc.off("update", onUpdate);
      if (autoCompileTimer.current) {
        clearTimeout(autoCompileTimer.current);
        autoCompileTimer.current = null;
      }
    };
  }, [autoCompile, managerKey, session?.key, runCompile]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleAutoCompile = useCallback(() => {
    setAutoCompileState((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(AUTO_COMPILE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  // ─── History (snapshots of the primary file) ────────────────────
  const refreshSnapshots = useCallback(async (path: string) => {
    try {
      setSnapshots(await historyList(path));
    } catch (err) {
      console.error("history_list failed:", err);
    }
  }, []);

  /** Stores the current text as a snapshot (auto, or named when `label` is given). */
  const recordSnapshot = useCallback(
    async (label?: string) => {
      const manager = managerRef.current;
      const current = projectRef.current;
      if (!manager || !current) return;
      try {
        await historySave(current.path, manager.primaryFile, manager.getText(), label || null, currentUserRef.current.name);
        lastAutoSnapshotRef.current = Date.now();
        await refreshSnapshots(current.path);
      } catch (err) {
        console.error("history_save failed:", err);
        setBanner({ kind: "error", text: t("error.history", { message: errorMessage(err) }) });
      }
    },
    [refreshSnapshots, t]
  );

  // Automatic snapshot after a save, at most every AUTO_SNAPSHOT_INTERVAL_MS.
  useEffect(() => {
    if (saveState.status !== "saved" || !project) return;
    if (Date.now() - lastAutoSnapshotRef.current < AUTO_SNAPSHOT_INTERVAL_MS) return;
    void recordSnapshot();
  }, [saveState, project, recordSnapshot]);

  // Keep the current text for the diff view while a snapshot is selected.
  useEffect(() => {
    const manager = managerRef.current;
    if (!selectedSnapshot || !manager) return;
    setCurrentText(manager.getText());
    const onUpdate = () => setCurrentText(manager.getText());
    manager.doc.on("update", onUpdate);
    return () => manager.doc.off("update", onUpdate);
  }, [selectedSnapshot, session]);

  const handleSelectSnapshot = useCallback(
    async (snapshot: SnapshotMeta | null) => {
      setSelectedSnapshot(snapshot);
      setSnapshotText(null);
      if (!snapshot || !projectRef.current) return;
      try {
        setSnapshotText(await historyRead(projectRef.current.path, snapshot.id));
      } catch (err) {
        setBanner({ kind: "error", text: t("error.history", { message: errorMessage(err) }) });
      }
    },
    [t]
  );

  const handleRestoreSnapshot = useCallback(
    async (snapshot: SnapshotMeta) => {
      const manager = managerRef.current;
      const current = projectRef.current;
      if (!manager || !current) return;
      try {
        const text = await historyRead(current.path, snapshot.id);
        lastAutoSnapshotRef.current = 0; // force a safety snapshot of what we are replacing
        await recordSnapshot();
        manager.replaceText(text);
        setSelectedSnapshot(null);
        setSnapshotText(null);
        setBanner({ kind: "info", text: t("history.restored") });
      } catch (err) {
        setBanner({ kind: "error", text: t("error.history", { message: errorMessage(err) }) });
      }
    },
    [recordSnapshot, t]
  );

  const handleDeleteSnapshot = useCallback(
    async (snapshot: SnapshotMeta) => {
      const current = projectRef.current;
      if (!current) return;
      try {
        setSnapshots(await historyDelete(current.path, snapshot.id));
        if (selectedSnapshot?.id === snapshot.id) {
          setSelectedSnapshot(null);
          setSnapshotText(null);
        }
      } catch (err) {
        setBanner({ kind: "error", text: t("error.history", { message: errorMessage(err) }) });
      }
    },
    [selectedSnapshot, t]
  );

  // ─── Files & tabs ───────────────────────────────────────────────
  const refreshTree = useCallback(async (projectPath: string) => {
    try {
      const nodes = await listProjectFiles(projectPath);
      if (projectRef.current?.path === projectPath) setFileTree(nodes);
    } catch (err) {
      console.error("Failed to list project files:", err);
    }
  }, []);

  const touchRecentFile = (path: string) => {
    recentFilesRef.current = [path, ...recentFilesRef.current.filter((p) => p !== path)].slice(0, 30);
  };

  /** Opens `path` in a tab (editor for text, preview for images/PDFs) and focuses it. */
  const openFile = useCallback(
    async (path: string, line?: number) => {
      const manager = managerRef.current;
      const current = projectRef.current;
      if (!manager || !current) return;
      const editable = isEditableFile(path);
      if (!editable && !isPreviewableFile(path)) {
        setBanner({ kind: "info", text: t("files.cannotOpen", { name: path }) });
        return;
      }
      if (!tabsRef.current.includes(path)) {
        const next = [...tabsRef.current, path];
        tabsRef.current = next;
        setTabs(next);
      }
      touchRecentFile(path);
      setActiveFile(path);
      activeFileRef.current = path;
      setSelectedSnapshot(null);
      manager.setActiveFile(path);
      if (!editable) {
        setSession(null);
        return;
      }
      if (line !== undefined) pendingJumpRef.current = { path, line };
      if (session?.path === path) {
        if (line !== undefined) {
          editorRef.current?.goToLine(line);
          pendingJumpRef.current = null;
        }
        return;
      }
      const seq = ++openSeqRef.current;
      setOpening(path);
      try {
        let disk: string | null = null;
        if (!(manager.isShared(path) && manager.getFileText(path) !== null)) {
          disk = await readProjectFile(current.path, path).catch(() => null);
        }
        const ytext = await manager.openFile(path, disk);
        if (seq !== openSeqRef.current || managerRef.current !== manager) return;
        setSession({
          key: `${current.path}::${path}::${seq}`,
          path,
          ytext,
          awareness: manager.awareness,
          undoManager: manager.undoManagerFor(path),
        });
      } catch (err) {
        console.error("Failed to open file:", err);
        setBanner({ kind: "error", text: t("files.error.open", { message: errorMessage(err) }) });
      } finally {
        if (seq === openSeqRef.current) setOpening(null);
      }
    },
    [session?.path, t]
  );
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  const closeTab = useCallback((path: string) => {
    const list = tabsRef.current;
    const index = list.indexOf(path);
    if (index === -1) return;
    const next = list.filter((p) => p !== path);
    tabsRef.current = next;
    setTabs(next);
    if (activeFileRef.current === path) {
      const neighbour = next[Math.min(index, next.length - 1)] ?? null;
      if (neighbour) void openFileRef.current(neighbour);
      else {
        setActiveFile(null);
        activeFileRef.current = null;
        setSession(null);
        managerRef.current?.setActiveFile(null);
      }
    }
  }, []);

  const cycleTab = useCallback((delta: number) => {
    const list = tabsRef.current;
    if (list.length < 2) return;
    const index = Math.max(0, list.indexOf(activeFileRef.current ?? ""));
    void openFileRef.current(list[(index + delta + list.length) % list.length]);
  }, []);

  /** Jumps to a line: in the open editor, or opening `path` first. */
  const goTo = useCallback((path: string | null, line: number) => {
    const target = path ?? activeFileRef.current;
    if (!target) return;
    if (target === activeFileRef.current && editorRef.current) editorRef.current.goToLine(line);
    else void openFileRef.current(target, line);
  }, []);

  // The editor of a freshly opened file is mounted: apply a pending jump.
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!session || !pending || pending.path !== session.path) return;
    pendingJumpRef.current = null;
    const id = setTimeout(() => editorRef.current?.goToLine(pending.line), 0);
    return () => clearTimeout(id);
  }, [session]);

  // Outline of the open text file, recomputed shortly after edits.
  useEffect(() => {
    if (!session || !project) {
      setOutline([]);
      return;
    }
    const { ytext } = session;
    const update = () => setOutline(parseOutline(ytext.toString(), project.rootFile));
    update();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(update, OUTLINE_DEBOUNCE_MS);
    };
    ytext.observe(onChange);
    return () => {
      ytext.unobserve(onChange);
      if (timer) clearTimeout(timer);
    };
  }, [session, project?.rootFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Open / create project ──────────────────────────────────────
  const openProject = useCallback(
    async (folder: string, mainFile?: string | null) => {
      const data = await readProject(folder, mainFile);

      // Snapshot + flush the previous session before tearing it down.
      if (managerRef.current) {
        lastAutoSnapshotRef.current = 0;
        await recordSnapshot();
        await managerRef.current.dispose();
        managerRef.current = null;
      }

      // In a room, the legacy shared text belongs to the root recorded in
      // room.json, whatever root is opened now.
      let primary = data.main_file;
      let primaryText = data.tex_content;
      if (data.is_collab && data.room_main_file && data.room_main_file !== data.main_file) {
        try {
          primaryText = await readProjectFile(data.project_path, data.room_main_file);
          primary = data.room_main_file;
        } catch {
          // The recorded root is gone: fall back to the opened one.
        }
      }

      const manager = new CollabManager({
        projectPath: data.project_path,
        mainFile: primary,
        isCollab: data.is_collab,
        roomId: data.room_id,
        initialTexContent: seedTextFor(data.project_path, workspacesDirRef.current, primaryText),
        initialCrdtState: data.crdt_state,
        currentUser: currentUserRef.current,
        callbacks: {
          onModeChange: setMode,
          onHostChange: setIsHost,
          onPeersChange: setPeers,
          onStatusChange: (status, diag) => {
            setConnectionStatus(status);
            setDiagnostics(diag);
          },
          onRoomIdChange: setRoomId,
          onSaveStateChange: setSaveState,
          onAssetsChange: setAssets,
          onRoomInfoChange: setRoomInfo,
        },
      });
      managerRef.current = manager;
      // A peer whose folder lives in a cloud tells the others where the files are
      // (first writer wins; "local" is never published).
      if (manager.mode === "collab" && data.cloud.provider !== "local") {
        manager.setRoomInfo({ cloud: data.cloud, hostName: currentUserRef.current.name });
      }

      const info: ProjectInfo = {
        path: data.project_path,
        rootFile: data.main_file,
        primaryFile: manager.primaryFile,
        cloud: data.cloud,
      };
      rootDiskTextRef.current = data.tex_content;
      projectRef.current = info;
      setProject(info);
      tabsRef.current = [];
      setTabs([]);
      setActiveFile(null);
      activeFileRef.current = null;
      setSession(null);
      setFileTree([]);
      anchorsRef.current.clear();
      recentFilesRef.current = [];
      setSharedFiles(manager.sharedFiles());
      setMode(manager.mode);
      setRoomId(manager.roomId);
      setIsHost(manager.isHost);
      setPeers(manager.peers);
      setConnectionStatus(manager.status);
      setDiagnostics(manager.diagnostics);
      setSaveState(manager.saveState);
      setAssets(manager.assets);
      setRoomInfo(manager.getRoomInfo());
      setCloudAssist({ kind: "none" });
      setCompile(EMPTY_COMPILE);
      lastCompiledRef.current = null;
      // Chapter names belong to a project: back to the full document.
      buildSettingsRef.current = { ...buildSettingsRef.current, scope: "full" };
      setBuildSettings(buildSettingsRef.current);
      setPageCount(null);
      setBanner(null);
      setSelectedSnapshot(null);
      setSnapshotText(null);
      lastAutoSnapshotRef.current = Date.now();
      setActivePanel((p) => (p === "join" || p === "new" || p === null ? readSidebarView() : p));
      setRecents(addRecent({ path: data.project_path, mainFile: data.main_file }));
      void refreshSnapshots(data.project_path);
      void refreshTree(data.project_path);
      void openFileRef.current(data.main_file);
    },
    [recordSnapshot, refreshSnapshots, refreshTree]
  );

  // Files shared in the room (registry), for the tree of a guest.
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !project) return;
    const update = () => setSharedFiles(manager.sharedFiles());
    update();
    manager.files.observe(update);
    return () => manager.files.unobserve(update);
  }, [project?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh the tree when the window regains focus (files added in Finder…).
  useEffect(() => {
    const onFocus = () => {
      if (projectRef.current) void refreshTree(projectRef.current.path);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshTree]);

  const tree = useMemo(
    () => (mode === "collab" ? mergeSharedFiles(fileTree, sharedFiles) : fileTree),
    [fileTree, sharedFiles, mode]
  );
  const allFiles = useMemo(() => flattenFiles(tree), [tree]);
  const knownFiles = useMemo(() => new Set(allFiles), [allFiles]);

  // ─── Reference index (smart completion, go to definition) ───────
  // Disk copies of the project's .tex/.bib files, overlaid with the live text
  // of every shared file; rebuilt lazily when something changed.
  const diskTextsRef = useRef<Record<string, string>>({});
  const indexVersionRef = useRef(0);
  const indexCacheRef = useRef<{ version: number; index: ProjectIndex }>({ version: -1, index: EMPTY_INDEX });
  const allFilesRef = useRef(allFiles);
  allFilesRef.current = allFiles;
  useEffect(() => {
    const current = projectRef.current;
    if (!current) {
      diskTextsRef.current = {};
      return;
    }
    let cancelled = false;
    const wanted = allFiles.filter((f) => INDEXED_RE.test(f)).slice(0, MAX_INDEXED_FILES);
    void Promise.all(
      wanted.map((f) =>
        readProjectFile(current.path, f)
          .then((text) => [f, text] as const)
          .catch(() => null)
      )
    ).then((entries) => {
      if (cancelled || projectRef.current?.path !== current.path) return;
      const next: Record<string, string> = {};
      for (const e of entries) if (e) next[e[0]] = e[1];
      diskTextsRef.current = next;
      indexVersionRef.current++;
    });
    return () => {
      cancelled = true;
    };
  }, [allFiles]);
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !project) return;
    const bump = () => {
      indexVersionRef.current++;
    };
    manager.doc.on("update", bump);
    return () => manager.doc.off("update", bump);
  }, [project?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const getIndex = useCallback((): ProjectIndex => {
    const cache = indexCacheRef.current;
    if (cache.version === indexVersionRef.current) return cache.index;
    const live = managerRef.current?.fileContents() ?? {};
    const index = buildIndex({ ...diskTextsRef.current, ...live }, allFilesRef.current);
    indexCacheRef.current = { version: indexVersionRef.current, index };
    return index;
  }, []);

  /** Changes the compiled root; in a room every peer follows. */
  const applyRootFile = useCallback(async (file: string, share: boolean) => {
    const current = projectRef.current;
    const manager = managerRef.current;
    if (!current || !manager || file === current.rootFile) return;
    const next = { ...current, rootFile: file };
    projectRef.current = next;
    setProject(next);
    rootDiskTextRef.current = manager.getFileText(file) ?? (await readProjectFile(current.path, file).catch(() => ""));
    lastCompiledRef.current = null;
    buildSettingsRef.current = { ...buildSettingsRef.current, scope: "full" };
    setBuildSettings(buildSettingsRef.current);
    setRecents(addRecent({ path: current.path, mainFile: file }));
    if (share && manager.mode === "collab") manager.setRootFile(file);
    if (autoCompileRef.current) void runCompile({ auto: true });
  }, [runCompile]);

  const handleSetRootFile = useCallback((file: string) => void applyRootFile(file, true), [applyRootFile]);

  // A peer changed the room's root file.
  useEffect(() => {
    const wanted = roomInfo.rootFile;
    if (mode === "collab" && wanted && project && wanted !== project.rootFile) void applyRootFile(wanted, false);
  }, [roomInfo.rootFile, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateNode = useCallback(
    async (relPath: string, isDir: boolean) => {
      const current = projectRef.current;
      if (!current) return;
      try {
        await createProjectNode(current.path, relPath, isDir);
        await refreshTree(current.path);
        if (!isDir && (isEditableFile(relPath) || isPreviewableFile(relPath))) await openFileRef.current(relPath);
      } catch (err) {
        console.error("Failed to create file/folder:", err);
        setBanner({ kind: "error", text: t("files.error.create", { message: errorMessage(err) }) });
        throw err;
      }
    },
    [refreshTree, t]
  );

  const handleRenameNode = useCallback(
    async (oldPath: string, newPath: string) => {
      const current = projectRef.current;
      const manager = managerRef.current;
      if (!current || !manager) return;
      // The room's legacy text is bound to the primary file's path.
      if (isSameOrInside(oldPath, current.primaryFile) && manager.mode === "collab") {
        setBanner({ kind: "error", text: t("files.error.primaryLocked") });
        throw new Error("primary file");
      }
      try {
        await manager.flushSave();
        await renameProjectNode(current.path, oldPath, newPath);
        if (isSameOrInside(oldPath, current.primaryFile)) {
          // Solo: reopen with the renamed root so the editor follows it.
          await openProject(current.path, renamePath(current.rootFile, oldPath, newPath));
          return;
        }
        for (const shared of manager.sharedFiles()) {
          if (isSameOrInside(oldPath, shared)) manager.renameFile(shared, renamePath(shared, oldPath, newPath));
        }
        const nextTabs = tabsRef.current.map((p) => renamePath(p, oldPath, newPath));
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        const wasActive = activeFileRef.current;
        if (isSameOrInside(oldPath, current.rootFile)) {
          await applyRootFile(renamePath(current.rootFile, oldPath, newPath), true);
        }
        await refreshTree(current.path);
        if (wasActive && isSameOrInside(oldPath, wasActive)) {
          setSession(null);
          await openFileRef.current(renamePath(wasActive, oldPath, newPath));
        }
      } catch (err) {
        console.error("Failed to rename file/folder:", err);
        setBanner({ kind: "error", text: t("files.error.rename", { message: errorMessage(err) }) });
        throw err;
      }
    },
    [applyRootFile, openProject, refreshTree, t]
  );

  const handleDeleteNode = useCallback(
    async (relPath: string) => {
      const current = projectRef.current;
      const manager = managerRef.current;
      if (!current || !manager) return;
      if (isSameOrInside(relPath, current.primaryFile)) {
        setBanner({ kind: "error", text: t("files.error.primaryDelete") });
        throw new Error("primary file");
      }
      try {
        for (const shared of manager.sharedFiles()) {
          if (isSameOrInside(relPath, shared)) manager.removeFile(shared);
        }
        await deleteProjectNode(current.path, relPath);
        for (const tab of [...tabsRef.current]) {
          if (isSameOrInside(relPath, tab)) closeTab(tab);
        }
        if (isSameOrInside(relPath, current.rootFile)) await applyRootFile(current.primaryFile, true);
        await refreshTree(current.path);
      } catch (err) {
        console.error("Failed to delete file/folder:", err);
        setBanner({ kind: "error", text: t("files.error.delete", { message: errorMessage(err) }) });
        throw err;
      }
    },
    [applyRootFile, closeTab, refreshTree, t]
  );

  const handleOpenFolder = useCallback(async () => {
    try {
      const folder = await pickProjectFolder();
      if (!folder) return;
      await openProject(folder);
    } catch (err) {
      console.error("Failed to open project:", err);
      setBanner({ kind: "error", text: t("error.openProject", { message: errorMessage(err) }) });
    }
  }, [openProject, t]);

  const handleOpenRecent = useCallback(
    async (recent: RecentProject) => {
      try {
        await openProject(recent.path, recent.mainFile);
      } catch (err) {
        console.error("Failed to open recent project:", err);
        setBanner({ kind: "error", text: t("error.openProject", { message: errorMessage(err) }) });
        setRecents(removeRecent(recent.path));
      }
    },
    [openProject, t]
  );

  const handleCreateProject = useCallback(
    async (parentDir: string, name: string, templateId: string) => {
      const template = findTemplate(templateId);
      if (!template) return;
      try {
        const path = await createProject(parentDir, name, template.files);
        await openProject(path);
      } catch (err) {
        console.error("Failed to create project:", err);
        setBanner({ kind: "error", text: t("error.createProject", { message: errorMessage(err) }) });
      }
    },
    [openProject, t]
  );

  // ─── UI zoom ────────────────────────────────────────────────────
  const setZoom = useCallback((updater: (z: number) => number) => {
    setUiZoom((z) => {
      const next = Math.round(Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, updater(z))) * 100) / 100;
      try {
        localStorage.setItem(UI_ZOOM_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  // ─── Side panel ─────────────────────────────────────────────────
  const togglePanel = useCallback(
    (panel: PanelId) => {
      setActivePanel((current) => {
        const next = current === panel ? null : panel;
        if (next === null || next === "files" || next === "outline" || next === "history") {
          try {
            localStorage.setItem(SIDEBAR_KEY, next ?? "none");
          } catch {
            // ignore
          }
        }
        return next;
      });
      if (panel === "history" && projectRef.current) void refreshSnapshots(projectRef.current.path);
    },
    [refreshSnapshots]
  );
  const showPanel = useCallback(
    (panel: PanelId) => {
      setActivePanel(panel);
      if (panel === "history" && projectRef.current) void refreshSnapshots(projectRef.current.path);
    },
    [refreshSnapshots]
  );
  const lastViewRef = useRef<PanelId>("files");
  if (activePanel === "files" || activePanel === "outline" || activePanel === "history") lastViewRef.current = activePanel;

  // ─── Collaboration handlers ─────────────────────────────────────
  const handleStartCollab = useCallback(async () => {
    const manager = managerRef.current;
    if (!manager) return;
    try {
      await manager.startCollaboration();
      const cur = projectRef.current;
      if (cur && cur.cloud.provider !== "local") {
        manager.setRoomInfo({ cloud: cur.cloud, hostName: currentUserRef.current.name });
      }
      if (cur && cur.rootFile !== manager.primaryFile) manager.setRootFile(cur.rootFile);
      setActivePanel("room");
    } catch (err) {
      console.error("Failed to start collaboration:", err);
      setBanner({ kind: "error", text: t("error.collab", { message: errorMessage(err) }) });
    }
  }, [t]);

  const handleShare = useCallback(() => {
    if (managerRef.current?.mode === "collab") showPanel("room");
    else void handleStartCollab();
  }, [handleStartCollab, showPanel]);

  /**
   * Join by room ID without asking for a folder:
   * 1. if the host's shared cloud folder is already synced here, open it;
   * 2. otherwise work in an app-managed workspace and switch to the cloud
   *    folder automatically once it appears (see the cloud-assist effect).
   */
  const handleJoinRoom = useCallback(
    async (id: string) => {
      const roomIdClean = id.trim().toLowerCase();
      try {
        const found = await locateRoomInCloud(roomIdClean);
        if (found) {
          await openProject(found);
          setActivePanel("room");
          setBanner({ kind: "info", text: t("join.foundInCloud", { path: found }) });
          return;
        }
        const workspace = await ensureRoomWorkspace(roomIdClean);
        if (!workspacesDirRef.current) workspacesDirRef.current = await roomWorkspacesDir();
        const data = await readProject(workspace);
        await initCollabProject(workspace, data.main_file, roomIdClean);
        await openProject(workspace);
        setAssistDismissedFor(null);
        setActivePanel("room");
        setBanner({ kind: "info", text: t("join.workspace") });
      } catch (err) {
        console.error("Failed to join room:", err);
        setBanner({ kind: "error", text: t("error.join", { message: errorMessage(err) }) });
      }
    },
    [openProject, t]
  );

  // Any peer whose folder is in a cloud publishes it once collaboration is on.
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || mode !== "collab" || !project || project.cloud.provider === "local") return;
    manager.setRoomInfo({ cloud: project.cloud, hostName: currentUserRef.current.name });
  }, [mode, project]);

  const inWorkspace = isRoomWorkspace(project?.path ?? null, workspacesDir);
  const roomCloud: CloudLocation | null = roomInfo.cloud
    ? { provider: roomInfo.cloud.provider as CloudProvider, account: roomInfo.cloud.account }
    : null;

  // Decide what to tell a guest about the host's cloud folder.
  useEffect(() => {
    if (mode !== "collab" || !project) {
      setCloudAssist({ kind: "none" });
      return;
    }
    setCloudAssist(
      decideCloudAssist({ roomCloud, installedProviders, isWorkspace: inWorkspace, localCloud: project.cloud })
    );
  }, [mode, project, roomCloud?.provider, roomCloud?.account, installedProviders, inWorkspace]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Looks for the host's folder locally; switches the session to it when found. */
  const tryLocateRoomFolder = useCallback(async (): Promise<boolean> => {
    const id = roomId;
    const provider = roomCloud?.provider;
    if (!id || !provider) return false;
    try {
      const clients = await cloudClients();
      setInstalledProviders(clients.map((c) => c.provider));
      const found = await locateRoomInCloud(id);
      if (!found) return false;
      await openProject(found);
      setActivePanel("room");
      setBanner({ kind: "info", text: t("cloud.assist.switched", { provider: t(`cloud.provider.${provider}` as MessageKey), path: found }) });
      return true;
    } catch (err) {
      console.error("locate_room_in_cloud failed:", err);
      return false;
    }
  }, [roomId, roomCloud?.provider, openProject, t]);

  // While waiting for the shared folder, poll every 15 s.
  useEffect(() => {
    if (cloudAssist.kind !== "locate") return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void tryLocateRoomFolder();
    };
    tick();
    const interval = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cloudAssist.kind, tryLocateRoomFolder]);

  const handleInstallUpdate = useCallback(async () => {
    try {
      if (managerRef.current && projectRef.current) {
        await historySave(projectRef.current.path, managerRef.current.primaryFile, managerRef.current.getText(), null, currentUserRef.current.name).catch(() => undefined);
        await managerRef.current.dispose();
        managerRef.current = null;
      }
      await installStagedUpdateAndRelaunch();
    } catch (err) {
      setUpdateState({ status: "error", message: errorMessage(err) });
    }
  }, []);

  const handleStopCollab = useCallback(async () => {
    try {
      await managerRef.current?.stopCollaboration();
      setActivePanel(lastViewRef.current);
    } catch (err) {
      console.error("Failed to stop collaboration:", err);
    }
  }, []);

  const handleUserChange = useCallback((updatedUser: CollabUser) => {
    setCurrentUser(updatedUser);
    sessionStorage.setItem("latex_user_name", updatedUser.name);
    sessionStorage.setItem("latex_user_color", updatedUser.color);
    managerRef.current?.updateLocalUser(updatedUser);
  }, []);

  const handleNewWindow = useCallback(async () => {
    try {
      await openNewWindow();
    } catch (err) {
      console.error("Failed to open new window:", err);
    }
  }, []);

  // Export always ships the whole document without draft: when the PDF on screen
  // came from a chapter or draft build, a plain full build runs first.
  const handleExport = useCallback(async () => {
    if (!compile.pdfPath || !project || compilingRef.current) return;
    try {
      let pdfPath = compile.pdfPath;
      if (!compile.pdfPlain) {
        setBanner({ kind: "info", text: t("build.exporting") });
        const result = await runCompile({ plain: true });
        setBanner(null);
        if (!result?.pdf_path) return; // errors are shown in the preview
        pdfPath = result.pdf_path;
      }
      const stem = project.rootFile.split("/").pop()?.replace(/\.tex$/i, "") ?? "main";
      await exportPdf(pdfPath, `${stem}.pdf`);
    } catch (err) {
      console.error("Failed to export PDF:", err);
      setBanner({ kind: "error", text: t("error.export", { message: errorMessage(err) }) });
    }
  }, [compile.pdfPath, compile.pdfPlain, project, runCompile, t]);
  const handleExportRef = useRef(handleExport);
  handleExportRef.current = handleExport;
  const handleOpenFolderRef = useRef(handleOpenFolder);
  handleOpenFolderRef.current = handleOpenFolder;

  // ─── Global shortcuts ───────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const action = matchShortcut(e, MAC);
      if (!action) return;
      const hasProject = projectRef.current !== null;
      switch (action) {
        case "zoomIn":
          setZoom((z) => z + UI_ZOOM_STEP);
          break;
        case "zoomOut":
          setZoom((z) => z - UI_ZOOM_STEP);
          break;
        case "zoomReset":
          setZoom(() => 1);
          break;
        case "build":
          void runCompile();
          break;
        case "open":
          void handleOpenFolderRef.current();
          break;
        case "export":
          if (!hasProject) return;
          void handleExportRef.current();
          break;
        case "quickOpen":
          if (!hasProject) return;
          setQuickOpen("files");
          break;
        case "gotoSymbol":
          if (!hasProject) return;
          setQuickOpen("symbols");
          break;
        case "gotoLine":
          if (!hasProject) return;
          setQuickOpen("line");
          break;
        case "toggleSidebar":
          setActivePanel((p) => (p ? null : hasProject ? lastViewRef.current : null));
          break;
        case "viewFiles":
          if (hasProject) showPanel("files");
          break;
        case "viewOutline":
          if (hasProject) showPanel("outline");
          break;
        case "viewHistory":
          if (hasProject) showPanel("history");
          break;
        case "nextTab":
          cycleTab(1);
          break;
        case "prevTab":
          cycleTab(-1);
          break;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [runCompile, setZoom, showPanel, cycleTab]);

  // ─── Window lifecycle: snapshot + flush before close, cleanup on unmount ──
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let closing = false;
    onCloseRequested(async () => {
      if (closing) return;
      closing = true;
      try {
        if (managerRef.current && projectRef.current) {
          await historySave(
            projectRef.current.path,
            managerRef.current.primaryFile,
            managerRef.current.getText(),
            null,
            currentUserRef.current.name
          ).catch((err) => console.error("history_save on close failed:", err));
        }
        await managerRef.current?.dispose();
        managerRef.current = null;
      } finally {
        await closeWindow().catch((err) => console.error("close_window failed:", err));
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => console.error("Failed to listen for close requests:", err));
    return () => {
      unlisten?.();
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, []);

  // ─── Room assets & build errors ─────────────────────────────────
  // A failed build whose missing file is shared in the room but not here yet.
  const assetHint = useMemo(
    () => (compile.summary && !compile.summary.success && compile.logs ? explainMissingAsset(compile.logs, assets) : null),
    [compile.summary, compile.logs, assets]
  );
  const assetNotice = assetHint
    ? t(`assets.hint.${assetHint.state}` as MessageKey, {
        path: assetHint.path,
        mb: Math.round(assets.maxBytes / (1024 * 1024)),
      })
    : null;

  // Build again (quietly) once files arrive after a failed build.
  const prevSyncedRef = useRef(assets.synced);
  const assetRebuildTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const grew = assets.synced > prevSyncedRef.current;
    prevSyncedRef.current = assets.synced;
    if (!grew || !lastCompiledRef.current || lastCompiledRef.current.success) return;
    if (assetRebuildTimer.current) clearTimeout(assetRebuildTimer.current);
    assetRebuildTimer.current = setTimeout(() => {
      assetRebuildTimer.current = null;
      void runCompile({ auto: true });
    }, 600);
  }, [assets.synced, runCompile]);
  useEffect(
    () => () => {
      if (assetRebuildTimer.current) clearTimeout(assetRebuildTimer.current);
    },
    []
  );

  const resolveFile = useCallback(
    (d: LatexDiagnostic) => (project ? resolveDiagnosticFile(d.file, project.rootFile, allFiles) : null),
    [project, allFiles]
  );
  const errorCount = compile.diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = compile.diagnostics.length - errorCount;

  // ─── Panels ─────────────────────────────────────────────────────
  let panelTitle = "";
  let panelContent: React.ReactNode = null;
  let panelActions: React.ReactNode = null;
  const headerButton = "p-1.5 rounded text-mk-fg3 hover:text-mk-fg hover:bg-mk-bg3 cursor-pointer";
  if (activePanel === "files" && project) {
    panelTitle = t("files.title");
    panelActions = (
      <>
        <button className={headerButton} title={t("files.newFile")} onClick={() => setCreateRequest((r) => ({ isDir: false, seq: (r?.seq ?? 0) + 1 }))}>
          <FilePlus size={14} />
        </button>
        <button className={headerButton} title={t("files.newFolder")} onClick={() => setCreateRequest((r) => ({ isDir: true, seq: (r?.seq ?? 0) + 1 }))}>
          <FolderPlus size={14} />
        </button>
        <button className={headerButton} title={t("files.refresh")} onClick={() => void refreshTree(project.path)}>
          <RefreshCw size={13} />
        </button>
      </>
    );
    panelContent = (
      <FileTree
        nodes={tree}
        activeFile={activeFile}
        rootFile={project.rootFile}
        openFiles={tabs}
        peers={peers}
        onSelectFile={(path) => void openFile(path)}
        onSetRootFile={handleSetRootFile}
        onCreateNode={handleCreateNode}
        onRenameNode={handleRenameNode}
        onDeleteNode={handleDeleteNode}
        createRequest={createRequest}
      />
    );
  } else if (activePanel === "outline" && project) {
    panelTitle = activeFile ? t("outline.titleOf", { file: activeFile.split("/").pop() ?? activeFile }) : t("outline.title");
    panelContent = (
      <OutlinePanel
        file={session?.path ?? null}
        items={outline}
        cursorLine={cursorLine}
        knownFiles={knownFiles}
        onGoToLine={(line) => goTo(null, line)}
        onOpenFile={(path) => void openFile(path)}
      />
    );
  } else if (activePanel === "room" && mode === "collab" && roomId) {
    panelTitle = t("collab.title");
    panelContent = (
      <CollabPanel
        roomId={roomId}
        isHost={isHost}
        peers={peers}
        status={connectionStatus}
        diagnostics={diagnostics}
        assets={assets}
        cloud={project?.cloud ?? null}
        roomCloud={roomCloud}
        isWorkspace={inWorkspace}
        onStopCollab={handleStopCollab}
      />
    );
  } else if (activePanel === "join") {
    panelTitle = t("join.title");
    panelContent = <JoinPanel onJoin={handleJoinRoom} />;
  } else if (activePanel === "new") {
    panelTitle = t("new.title");
    panelContent = <NewProjectPanel defaultParent={defaultParent} onPickParent={pickParentFolder} onCreate={handleCreateProject} />;
  } else if (activePanel === "history" && project) {
    panelTitle = t("history.titleOf", { file: project.primaryFile });
    panelContent = (
      <HistoryPanel
        snapshots={snapshots}
        selectedId={selectedSnapshot?.id ?? null}
        onSaveVersion={(label) => void recordSnapshot(label)}
        onSelect={(s) => void handleSelectSnapshot(s)}
        onRestore={(s) => void handleRestoreSnapshot(s)}
        onDelete={(s) => void handleDeleteSnapshot(s)}
      />
    );
  } else if (activePanel === "profile") {
    panelTitle = t("profile.title");
    panelContent = <ProfilePanel currentUser={currentUser} onUserChange={handleUserChange} onNewWindow={handleNewWindow} />;
  }
  const effectivePanel: PanelId | null = panelContent ? activePanel : null;

  // Build button tooltip reflects the mode that ⌘S / Build will use.
  const scopeNow = effectiveScope(buildSettings.scope, chapters);
  const scopeLabel =
    scopeNow === "full"
      ? t("build.summary.full")
      : scopeNow === "cursor"
        ? t("build.scope.cursor")
        : t("build.summary.chapter", { name: scopeChapter(scopeNow) ?? "" });
  const buildTitle = t("rail.build.mode", { mode: `${scopeLabel}${buildSettings.draft ? t("rail.build.draftSuffix") : ""}` });
  const canExport = Boolean(compile.pdfPath) && !isCompiling;

  // ─── Editor area ────────────────────────────────────────────────
  let editorArea: React.ReactNode;
  if (project && activeFile && isPreviewableFile(activeFile)) {
    editorArea = <AssetPreview projectPath={project.path} path={activeFile} />;
  } else if (session && session.path === activeFile) {
    editorArea = (
      <LatexEditor
        key={session.key}
        ref={editorRef}
        ytext={session.ytext}
        awareness={session.awareness}
        undoManager={session.undoManager}
        initialAnchor={anchorsRef.current.get(session.path)}
        onCursorLine={setCursorLine}
        onLeave={(anchor) => anchorsRef.current.set(session.path, anchor)}
        theme={resolvedTheme}
        getIndex={getIndex}
        rootFile={project?.rootFile}
        onGoToDefinition={(def) => goTo(def.file, def.line)}
      />
    );
  } else if (opening) {
    editorArea = (
      <div className="h-full flex items-center justify-center gap-2 text-xs text-mk-fg3">
        <Loader2 size={14} className="animate-spin" /> {t("files.opening", { name: opening })}
      </div>
    );
  } else {
    editorArea = (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-xs text-mk-fg4 select-none">
        <span>{t("tabs.empty")}</span>
        <span className="font-mono">
          {shortcutLabel("quickOpen", MAC)} · {t("quick.title")}
        </span>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────
  const zoomed = Math.abs(uiZoom - 1) > 0.001;
  return (
    <div
      className="flex flex-col bg-mk-bg text-mk-fg overflow-hidden"
      style={
        zoomed
          ? { width: `${100 / uiZoom}vw`, height: `${100 / uiZoom}vh`, transform: `scale(${uiZoom})`, transformOrigin: "0 0" }
          : { width: "100vw", height: "100vh" }
      }
    >
      <TopBar
        mac={MAC}
        projectPath={project?.path ?? null}
        cloud={project?.cloud ?? null}
        rootFile={project?.rootFile ?? null}
        recents={recents}
        mode={mode}
        isHost={isHost}
        peerCount={peers.length}
        connectionStatus={connectionStatus}
        isCompiling={isCompiling}
        autoCompile={autoCompile}
        compilerName={compilerInfo?.name ?? null}
        chapters={chapters}
        buildSettings={buildSettings}
        buildTitle={buildTitle}
        canExport={canExport}
        onChangeScope={handleChangeScope}
        onToggleDraft={handleToggleDraft}
        onTogglePreamble={handleTogglePreamble}
        onCompile={handleCompile}
        onToggleAuto={toggleAutoCompile}
        onExport={() => void handleExport()}
        onShare={handleShare}
        onOpenRoot={() => project && void openFile(project.rootFile)}
        onQuickOpen={() => setQuickOpen("files")}
        onNewProject={() => showPanel("new")}
        onOpenFolder={() => void handleOpenFolder()}
        onJoin={() => showPanel("join")}
        onOpenRecent={(r) => void handleOpenRecent(r)}
        onNewWindow={() => void handleNewWindow()}
      />

      <div className="flex-1 min-h-0 flex">
        <Sidebar
          mac={MAC}
          hasProject={project !== null}
          mode={mode}
          isHost={isHost}
          peerCount={peers.length}
          connectionStatus={connectionStatus}
          currentUser={currentUser}
          activePanel={effectivePanel}
          onTogglePanel={togglePanel}
          panel={panelContent}
          panelTitle={panelTitle}
          panelActions={panelActions}
          onClosePanel={() => setActivePanel(null)}
        />

        <div className="flex-1 min-w-0 flex flex-col">
          {banner && (
            <div
              className={`flex items-center justify-between px-4 py-1.5 text-xs text-mk-fg shrink-0 border-b ${
                banner.kind === "error" ? "bg-mk-red/15 border-mk-red/40" : "bg-mk-green/15 border-mk-green/40"
              }`}
            >
              <span className="truncate">{banner.text}</span>
              <button onClick={() => setBanner(null)} className="ml-3 text-mk-fg3 hover:text-mk-fg cursor-pointer">
                {t("action.close")}
              </button>
            </div>
          )}

          <UpdateBanner
            state={updateState}
            onInstall={() => void handleInstallUpdate()}
            onRetry={() => void checkAndStageUpdate({ onState: setUpdateState })}
            onDismiss={() => setUpdateState({ status: "idle" })}
          />

          {(cloudAssist.kind === "install" || cloudAssist.kind === "locate") && assistDismissedFor !== roomId && roomCloud && (
            <div className="flex items-center gap-3 px-4 py-1.5 text-xs text-mk-fg shrink-0 border-b bg-mk-blue/10 border-mk-blue/40">
              <Cloud size={13} className="shrink-0 text-mk-blue" />
              <span className="truncate">
                {cloudAssist.kind === "install"
                  ? t("cloud.assist.install", { provider: cloudLabel(roomCloud, t) })
                  : t("cloud.assist.locate", { provider: cloudLabel(roomCloud, t) })}
              </span>
              <span className="flex-1" />
              {cloudAssist.kind === "install" && compilerInfo && providerDownloadUrl(roomCloud.provider, compilerInfo.os) && (
                <button
                  onClick={() => void openExternalUrl(providerDownloadUrl(roomCloud.provider, compilerInfo.os) as string)}
                  className="flex items-center gap-1 px-2 py-1 bg-mk-blue text-mk-bg2 font-semibold hover:bg-mk-yellow cursor-pointer"
                >
                  <Download size={12} /> {t("cloud.assist.download", { provider: t(`cloud.provider.${roomCloud.provider}` as MessageKey) })}
                </button>
              )}
              <button
                onClick={() => void tryLocateRoomFolder()}
                className="flex items-center gap-1 text-mk-fg2 hover:text-mk-fg cursor-pointer"
                title={t("cloud.assist.retry")}
              >
                <RefreshCw size={12} /> {t("cloud.assist.retry")}
              </button>
              <button onClick={() => setAssistDismissedFor(roomId)} className="text-mk-fg4 hover:text-mk-fg cursor-pointer" title={t("cloud.assist.dismiss")}>
                ×
              </button>
            </div>
          )}

          {project ? (
            <SplitPane
              left={
                <div className="h-full flex flex-col">
                  <EditorTabs
                    tabs={tabs}
                    active={activeFile}
                    rootFile={project.rootFile}
                    peers={peers}
                    onSelect={(path) => void openFile(path)}
                    onClose={closeTab}
                  />
                  <div className="flex-1 min-h-0">{editorArea}</div>
                </div>
              }
              right={
                selectedSnapshot ? (
                  <DiffView
                    snapshot={selectedSnapshot}
                    snapshotText={snapshotText}
                    currentText={currentText}
                    onRestore={() => void handleRestoreSnapshot(selectedSnapshot)}
                    onClose={() => void handleSelectSnapshot(null)}
                  />
                ) : (
                  <PdfPreview
                    pdfData={compile.pdfData}
                    pdfVersion={compile.pdfVersion}
                    logs={compile.logs}
                    diagnostics={compile.diagnostics}
                    summary={compile.summary}
                    fatalError={compile.fatalError}
                    notice={assetNotice}
                    isCompiling={isCompiling}
                    quietCompile={compileQuiet}
                    canExport={canExport}
                    hasProject={project !== null}
                    onCompile={handleCompile}
                    resolveFile={resolveFile}
                    onJump={(file, line) => goTo(file, line)}
                    problemsRequest={problemsRequest}
                    onExport={() => void handleExport()}
                    onPageCount={setPageCount}
                  />
                )
              }
            />
          ) : (
            <div className="flex-1 min-h-0">
              <Welcome
                recents={recents}
                compilerMissing={compilerInfo !== null && compilerInfo.name === null}
                compilerHint={compilerHint}
                onOpenFolder={handleOpenFolder}
                onNew={() => setActivePanel("new")}
                onJoin={() => setActivePanel("join")}
                onOpenRecent={handleOpenRecent}
                onRemoveRecent={(path) => setRecents(removeRecent(path))}
              />
            </div>
          )}
        </div>
      </div>

      <StatusBar
        hasProject={project !== null}
        mode={mode}
        isHost={isHost}
        peers={peers}
        connectionStatus={connectionStatus}
        saveState={saveState}
        cursorLine={session && session.path === activeFile ? cursorLine : null}
        compilerInfo={compilerInfo}
        compilerHint={compilerHint}
        autoCompile={autoCompile}
        isCompiling={isCompiling}
        summary={compile.summary}
        pageCount={pageCount}
        errorCount={errorCount}
        warningCount={warningCount}
        uiZoom={uiZoom}
        onResetZoom={() => setZoom(() => 1)}
        onOpenRoom={() => mode === "collab" && showPanel("room")}
        onToggleAuto={toggleAutoCompile}
        onShowProblems={() => setProblemsRequest((n) => n + 1)}
      />

      {quickOpen && project && (
        <QuickOpen
          initialMode={quickOpen}
          files={allFiles}
          recent={recentFilesRef.current}
          outline={outline}
          onOpenFile={(path) => void openFile(path)}
          onGoToLine={(line) => goTo(null, line)}
          onClose={() => {
            setQuickOpen(null);
            setTimeout(() => editorRef.current?.focus(), 0);
          }}
        />
      )}
    </div>
  );
}

export default App;
