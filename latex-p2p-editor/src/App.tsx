import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { documentDir } from "@tauri-apps/api/path";

import Sidebar, { type PanelId } from "./components/Sidebar";
import TopBar from "./components/TopBar";
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
  type BuildOptions,
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
import {
  CollabManager,
  type CollabUser,
  type PeerInfo,
  type ConnectionStatus,
  type ConnectionDiagnostics,
  type CollabMode,
  type SaveState,
} from "./services/collabManager";
import { parseLatexLog, type LatexDiagnostic } from "./services/latexLog";
import { addRecent, readRecents, removeRecent, type RecentProject } from "./services/recents";
import { findTemplate } from "./services/templates";
import { useI18n, type MessageKey } from "./i18n";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

const AUTO_COMPILE_KEY = "latex_auto_compile";
const BUILD_DRAFT_KEY = "latex_build_draft";
const BUILD_PREAMBLE_KEY = "latex_build_preamble";
const AUTO_COMPILE_DEBOUNCE_MS = 2500;
const AUTO_SNAPSHOT_INTERVAL_MS = 2 * 60 * 1000;
const UI_ZOOM_KEY = "latex_ui_zoom";
const UI_ZOOM_MIN = 0.6;
const UI_ZOOM_MAX = 1.8;
const UI_ZOOM_STEP = 0.1;

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

function errorMessage(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

interface ProjectInfo {
  path: string;
  mainFile: string;
  texFiles: string[];
}

/** The editor binds to these; a new object means a new editor instance. */
interface EditorSession {
  key: string;
  ytext: Y.Text;
  awareness: Awareness;
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

function App() {
  const { t } = useI18n();

  // ─── Project & session ──────────────────────────────────────────
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [session, setSession] = useState<EditorSession | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [recents, setRecents] = useState<RecentProject[]>(() => readRecents());
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);
  const [defaultParent, setDefaultParent] = useState<string | null>(null);

  // ─── Collaboration ──────────────────────────────────────────────
  const [currentUser, setCurrentUser] = useState<CollabUser>(getSavedUser);
  const [mode, setMode] = useState<CollabMode>("solo");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(true);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [diagnostics, setDiagnostics] = useState<ConnectionDiagnostics | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(IDLE_SAVE);

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
    const text = manager.getText();
    // The build mode only touches the build copy of the root file; Export asks for a plain build.
    const options: BuildOptions = opts.plain
      ? PLAIN_BUILD
      : resolveBuildOptions(
          opts.settings ?? buildSettingsRef.current,
          findIncludes(text).map((c) => c.name),
          editorRef.current?.getActiveChapter() ?? null
        );
    const key = buildKey(text, options);
    // Automatic builds skip unchanged input (text + mode); a manual build always runs.
    if (auto && lastCompiledRef.current && lastCompiledRef.current.key === key && lastCompiledRef.current.success) {
      return null;
    }
    compilingRef.current = true;
    setIsCompiling(true);
    setCompileQuiet(auto);
    try {
      await manager.flushSave();
      const result = await compileLatex(current.path, current.mainFile, text, options);
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
  }, []);

  // Chapters (`\include`) of the root file, kept current for the scope control.
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !session) {
      setChapters([]);
      return;
    }
    const update = () => {
      const names = Array.from(new Set(findIncludes(manager.getText()).map((c) => c.name)));
      setChapters((prev) => (prev.length === names.length && prev.every((n, i) => n === names[i]) ? prev : names));
    };
    update();
    manager.doc.on("update", update);
    return () => manager.doc.off("update", update);
  }, [session]);

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

  // Auto-compile: debounce document updates.
  useEffect(() => {
    const manager = managerRef.current;
    if (!autoCompile || !manager || !session) return;
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
  }, [autoCompile, session, runCompile]);

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

  // ─── History ────────────────────────────────────────────────────
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
        await historySave(current.path, current.mainFile, manager.getText(), label || null, currentUserRef.current.name);
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

      const manager = new CollabManager({
        projectPath: data.project_path,
        mainFile: data.main_file,
        isCollab: data.is_collab,
        roomId: data.room_id,
        initialTexContent: data.tex_content,
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
        },
      });
      managerRef.current = manager;

      const info = { path: data.project_path, mainFile: data.main_file, texFiles: data.tex_files };
      projectRef.current = info;
      setProject(info);
      setSession({
        key: `${data.project_path}::${data.main_file}::${Date.now()}`,
        ytext: manager.ytext,
        awareness: manager.awareness,
      });
      setMode(manager.mode);
      setRoomId(manager.roomId);
      setIsHost(manager.isHost);
      setPeers(manager.peers);
      setConnectionStatus(manager.status);
      setDiagnostics(manager.diagnostics);
      setSaveState(manager.saveState);
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
      setActivePanel((p) => (p === "join" || p === "new" ? null : p));
      setRecents(addRecent({ path: data.project_path, mainFile: data.main_file }));
      void refreshSnapshots(data.project_path);
    },
    [recordSnapshot, refreshSnapshots]
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

  const handleOpenFolderRef = useRef(handleOpenFolder);
  handleOpenFolderRef.current = handleOpenFolder;

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

  // Global shortcuts: ⌘S build, ⌘O open, ⌥/⌘ +/−/0 UI zoom.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const primary = e.metaKey || e.ctrlKey;
      if (primary || e.altKey) {
        // Match by physical key (US layout) and by produced character, so the
        // shortcut works on Spanish/ISO layouts and with Option dead keys.
        const zoomIn =
          e.code === "Equal" ||
          e.code === "NumpadAdd" ||
          (e.altKey && e.code === "BracketRight") || // "+" key on ISO (Spanish) layouts
          ["+", "=", "≠", "±"].includes(e.key);
        const zoomOut = e.code === "Minus" || e.code === "NumpadSubtract" || ["-", "_", "–", "—"].includes(e.key);
        const zoomReset = e.code === "Digit0" || e.code === "Numpad0" || e.key === "0";
        if (zoomIn || zoomOut || zoomReset) {
          e.preventDefault();
          if (zoomReset) setZoom(() => 1);
          else setZoom((z) => z + (zoomIn ? UI_ZOOM_STEP : -UI_ZOOM_STEP));
          return;
        }
      }
      if (!primary || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        void runCompile();
      } else if (key === "o") {
        e.preventDefault();
        void handleOpenFolderRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [runCompile, setZoom]);

  const handleSelectMainFile = useCallback(
    async (file: string) => {
      if (!project || file === project.mainFile) return;
      try {
        await openProject(project.path, file);
      } catch (err) {
        console.error("Failed to switch root file:", err);
        setBanner({ kind: "error", text: t("error.openProject", { message: errorMessage(err) }) });
      }
    },
    [project, openProject, t]
  );

  // ─── Collaboration handlers ─────────────────────────────────────
  const handleStartCollab = useCallback(async () => {
    const manager = managerRef.current;
    if (!manager) return;
    try {
      await manager.startCollaboration();
      setActivePanel("room");
    } catch (err) {
      console.error("Failed to start collaboration:", err);
      setBanner({ kind: "error", text: t("error.collab", { message: errorMessage(err) }) });
    }
  }, [t]);

  const handleJoinRoom = useCallback(
    async (id: string) => {
      try {
        const folder = await pickProjectFolder();
        if (!folder) return;
        const data = await readProject(folder);
        await initCollabProject(folder, data.main_file, id);
        await openProject(folder);
        setActivePanel("room");
      } catch (err) {
        console.error("Failed to join room:", err);
        setBanner({ kind: "error", text: t("error.join", { message: errorMessage(err) }) });
      }
    },
    [openProject, t]
  );

  const handleStopCollab = useCallback(async () => {
    try {
      await managerRef.current?.stopCollaboration();
      setActivePanel(null);
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
      const stem = project.mainFile.split("/").pop()?.replace(/\.tex$/i, "") ?? "main";
      await exportPdf(pdfPath, `${stem}.pdf`);
    } catch (err) {
      console.error("Failed to export PDF:", err);
      setBanner({ kind: "error", text: t("error.export", { message: errorMessage(err) }) });
    }
  }, [compile.pdfPath, compile.pdfPlain, project, runCompile, t]);

  const handleJumpToLine = useCallback((line: number) => {
    editorRef.current?.goToLine(line);
  }, []);

  const togglePanel = useCallback(
    (panel: PanelId) => {
      setActivePanel((current) => (current === panel ? null : panel));
      if (panel === "history" && projectRef.current) void refreshSnapshots(projectRef.current.path);
    },
    [refreshSnapshots]
  );

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
            projectRef.current.mainFile,
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

  // ─── Panels ─────────────────────────────────────────────────────
  let panelTitle = "";
  let panelContent: React.ReactNode = null;
  if (activePanel === "room" && mode === "collab" && roomId) {
    panelTitle = t("collab.title");
    panelContent = (
      <CollabPanel
        roomId={roomId}
        isHost={isHost}
        peers={peers}
        status={connectionStatus}
        diagnostics={diagnostics}
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
    panelTitle = t("history.title");
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

  // ─── Render ─────────────────────────────────────────────────────
  const zoomed = Math.abs(uiZoom - 1) > 0.001;
  return (
    <div
      className="flex bg-mk-bg text-mk-fg overflow-hidden"
      style={
        zoomed
          ? { width: `${100 / uiZoom}vw`, height: `${100 / uiZoom}vh`, transform: `scale(${uiZoom})`, transformOrigin: "0 0" }
          : { width: "100vw", height: "100vh" }
      }
    >
      <Sidebar
        hasProject={project !== null}
        mode={mode}
        isHost={isHost}
        peerCount={peers.length}
        connectionStatus={connectionStatus}
        isCompiling={isCompiling}
        autoCompile={autoCompile}
        buildTitle={buildTitle}
        canExport={canExport}
        currentUser={currentUser}
        activePanel={effectivePanel}
        onOpenFolder={handleOpenFolder}
        onTogglePanel={togglePanel}
        onStartCollab={handleStartCollab}
        onCompile={() => void runCompile()}
        onToggleAuto={toggleAutoCompile}
        onExport={handleExport}
        panel={panelContent}
        panelTitle={panelTitle}
        onClosePanel={() => setActivePanel(null)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          projectPath={project?.path ?? null}
          mainFile={project?.mainFile ?? null}
          texFiles={project?.texFiles ?? []}
          mode={mode}
          isHost={isHost}
          peers={peers}
          connectionStatus={connectionStatus}
          saveState={saveState}
          compilerInfo={compilerInfo}
          compilerHint={compilerHint}
          summary={compile.summary}
          pageCount={pageCount}
          autoCompile={autoCompile}
          isCompiling={isCompiling}
          chapters={chapters}
          buildSettings={buildSettings}
          onChangeScope={handleChangeScope}
          onToggleDraft={handleToggleDraft}
          onTogglePreamble={handleTogglePreamble}
          uiZoom={uiZoom}
          onResetZoom={() => setZoom(() => 1)}
          onSelectMainFile={handleSelectMainFile}
        />

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

        {session ? (
          <SplitPane
            left={<LatexEditor key={session.key} ref={editorRef} ytext={session.ytext} awareness={session.awareness} />}
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
                  isCompiling={isCompiling}
                  quietCompile={compileQuiet}
                  canExport={canExport}
                  mainFile={project?.mainFile ?? null}
                  onJumpToLine={handleJumpToLine}
                  onExport={handleExport}
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
  );
}

export default App;
