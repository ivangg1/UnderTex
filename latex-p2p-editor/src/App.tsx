import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

import Sidebar, { type PanelId } from "./components/Sidebar";
import TopBar from "./components/TopBar";
import Welcome from "./components/Welcome";
import SplitPane from "./components/SplitPane";
import CollabPanel from "./components/CollabPanel";
import JoinPanel from "./components/JoinPanel";
import ProfilePanel, { PRESET_COLORS } from "./components/ProfilePanel";
import LatexEditor, { type LatexEditorHandle } from "./components/LatexEditor";
import PdfPreview, { type CompileSummary } from "./components/PdfPreview";
import {
  pickProjectFolder,
  readProject,
  initCollabProject,
  compileLatex,
  readBuildFile,
  detectCompiler,
  exportPdf,
  openNewWindow,
  onCloseRequested,
  closeWindow,
  type CompilerInfo,
} from "./services/tauriBridge";
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
import { useI18n, type MessageKey } from "./i18n";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

const AUTO_COMPILE_KEY = "latex_auto_compile";
const AUTO_COMPILE_DEBOUNCE_MS = 1500;

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
  logs: string | null;
  diagnostics: LatexDiagnostic[];
  summary: CompileSummary | null;
  fatalError: string | null;
}

const EMPTY_COMPILE: CompileState = {
  pdfData: null,
  pdfVersion: 0,
  pdfPath: null,
  logs: null,
  diagnostics: [],
  summary: null,
  fatalError: null,
};

const IDLE_SAVE: SaveState = { status: "idle", lastSavedAt: null, error: null };

function App() {
  const { t } = useI18n();

  // ─── Project & session ──────────────────────────────────────────
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [session, setSession] = useState<EditorSession | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentProject[]>(() => readRecents());
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);

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
  const [compile, setCompile] = useState<CompileState>(EMPTY_COMPILE);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [autoCompile, setAutoCompileState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_COMPILE_KEY) !== "0"; // default: on
    } catch {
      return true;
    }
  });

  const managerRef = useRef<CollabManager | null>(null);
  const editorRef = useRef<LatexEditorHandle | null>(null);
  const compilingRef = useRef(false);
  const compileQueuedRef = useRef(false);
  const autoCompileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;

  const compilerHint =
    compilerInfo && compilerInfo.name === null ? t(`compiler.hint.${compilerInfo.os}` as MessageKey) : null;

  // ─── Compiler detection ─────────────────────────────────────────
  useEffect(() => {
    detectCompiler()
      .then(setCompilerInfo)
      .catch((err) => console.error("detect_compiler failed:", err));
  }, []);

  // ─── Compile ────────────────────────────────────────────────────
  const runCompile = useCallback(async () => {
    const manager = managerRef.current;
    const current = project;
    if (!manager || !current) return;
    if (compilingRef.current) {
      compileQueuedRef.current = true;
      return;
    }
    compilingRef.current = true;
    setIsCompiling(true);
    try {
      await manager.flushSave();
      const text = manager.getText();
      const result = await compileLatex(current.path, current.mainFile, text);
      const parsed = parseLatexLog(result.logs);
      let pdfData: Uint8Array | null = null;
      if (result.pdf_path) {
        try {
          pdfData = await readBuildFile(result.pdf_path);
        } catch (err) {
          console.error("Failed to read compiled PDF:", err);
        }
      }
      setCompile((prev) => ({
        pdfData: pdfData ?? prev.pdfData, // keep the last good PDF visible on failure
        pdfVersion: pdfData ? prev.pdfVersion + 1 : prev.pdfVersion,
        pdfPath: result.pdf_path ?? prev.pdfPath,
        logs: result.logs,
        diagnostics: parsed,
        summary: {
          success: result.success,
          compiler: result.compiler,
          durationMs: result.duration_ms,
          timedOut: result.timed_out,
        },
        fatalError: null,
      }));
    } catch (err: unknown) {
      const message = errorMessage(err);
      console.error("Compilation error:", err);
      setCompile((prev) => ({ ...prev, logs: message, diagnostics: [], summary: null, fatalError: message }));
    } finally {
      compilingRef.current = false;
      setIsCompiling(false);
      if (compileQueuedRef.current) {
        compileQueuedRef.current = false;
        setTimeout(() => void runCompile(), 0);
      }
    }
  }, [project]);

  const runCompileRef = useRef(runCompile);
  runCompileRef.current = runCompile;

  // Auto-compile: debounce document updates.
  useEffect(() => {
    const manager = managerRef.current;
    if (!autoCompile || !manager || !session) return;
    const onUpdate = () => {
      if (autoCompileTimer.current) clearTimeout(autoCompileTimer.current);
      autoCompileTimer.current = setTimeout(() => {
        autoCompileTimer.current = null;
        void runCompileRef.current();
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
  }, [autoCompile, session]);

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

  // ─── Open project ───────────────────────────────────────────────
  const openProject = useCallback(async (folder: string, mainFile?: string | null) => {
    const data = await readProject(folder, mainFile);

    // Flush pending host writes of the previous session before tearing it down.
    if (managerRef.current) {
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

    setProject({ path: data.project_path, mainFile: data.main_file, texFiles: data.tex_files });
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
    setPageCount(null);
    setBanner(null);
    setActivePanel((p) => (p === "join" ? null : p));
    setRecents(addRecent({ path: data.project_path, mainFile: data.main_file }));
  }, []);

  const handleOpenFolder = useCallback(async () => {
    try {
      const folder = await pickProjectFolder();
      if (!folder) return;
      await openProject(folder);
    } catch (err) {
      console.error("Failed to open project:", err);
      setBanner(t("error.openProject", { message: errorMessage(err) }));
    }
  }, [openProject, t]);

  const handleOpenRecent = useCallback(
    async (recent: RecentProject) => {
      try {
        await openProject(recent.path, recent.mainFile);
      } catch (err) {
        console.error("Failed to open recent project:", err);
        setBanner(t("error.openProject", { message: errorMessage(err) }));
        setRecents(removeRecent(recent.path));
      }
    },
    [openProject, t]
  );

  const handleOpenFolderRef = useRef(handleOpenFolder);
  handleOpenFolderRef.current = handleOpenFolder;

  // Global shortcuts: ⌘S / Ctrl+S build, ⌘O / Ctrl+O open.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        void runCompileRef.current();
      } else if (key === "o") {
        e.preventDefault();
        void handleOpenFolderRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSelectMainFile = useCallback(
    async (file: string) => {
      if (!project || file === project.mainFile) return;
      try {
        await openProject(project.path, file);
      } catch (err) {
        console.error("Failed to switch root file:", err);
        setBanner(t("error.openProject", { message: errorMessage(err) }));
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
      setBanner(t("error.collab", { message: errorMessage(err) }));
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
        setBanner(t("error.join", { message: errorMessage(err) }));
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

  const handleExport = useCallback(async () => {
    if (!compile.pdfPath || !project) return;
    try {
      const stem = project.mainFile.split("/").pop()?.replace(/\.tex$/i, "") ?? "main";
      await exportPdf(compile.pdfPath, `${stem}.pdf`);
    } catch (err) {
      console.error("Failed to export PDF:", err);
      setBanner(t("error.export", { message: errorMessage(err) }));
    }
  }, [compile.pdfPath, project, t]);

  const handleJumpToLine = useCallback((line: number) => {
    editorRef.current?.goToLine(line);
  }, []);

  const togglePanel = useCallback((panel: PanelId) => {
    setActivePanel((current) => (current === panel ? null : panel));
  }, []);

  // ─── Window lifecycle: flush before close, cleanup on unmount ──
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let closing = false;
    onCloseRequested(async () => {
      if (closing) return;
      closing = true;
      try {
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
  } else if (activePanel === "profile") {
    panelTitle = t("profile.title");
    panelContent = <ProfilePanel currentUser={currentUser} onUserChange={handleUserChange} onNewWindow={handleNewWindow} />;
  }
  const effectivePanel: PanelId | null = panelContent ? activePanel : null;

  // ─── Render ─────────────────────────────────────────────────────
  return (
    <div className="h-screen flex bg-mk-bg text-mk-fg overflow-hidden">
      <Sidebar
        hasProject={project !== null}
        mode={mode}
        isHost={isHost}
        peerCount={peers.length}
        connectionStatus={connectionStatus}
        isCompiling={isCompiling}
        autoCompile={autoCompile}
        canExport={Boolean(compile.pdfPath)}
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
          onSelectMainFile={handleSelectMainFile}
        />

        {banner && (
          <div className="flex items-center justify-between px-4 py-1.5 bg-mk-red/15 border-b border-mk-red/40 text-xs text-mk-fg shrink-0">
            <span className="truncate">{banner}</span>
            <button onClick={() => setBanner(null)} className="ml-3 text-mk-fg3 hover:text-mk-fg cursor-pointer">
              {t("action.close")}
            </button>
          </div>
        )}

        {session ? (
          <SplitPane
            left={<LatexEditor key={session.key} ref={editorRef} ytext={session.ytext} awareness={session.awareness} />}
            right={
              <PdfPreview
                pdfData={compile.pdfData}
                pdfVersion={compile.pdfVersion}
                logs={compile.logs}
                diagnostics={compile.diagnostics}
                summary={compile.summary}
                fatalError={compile.fatalError}
                isCompiling={isCompiling}
                canExport={Boolean(compile.pdfPath)}
                mainFile={project?.mainFile ?? null}
                onJumpToLine={handleJumpToLine}
                onExport={handleExport}
                onPageCount={setPageCount}
              />
            }
          />
        ) : (
          <div className="flex-1 min-h-0">
            <Welcome
              recents={recents}
              compilerMissing={compilerInfo !== null && compilerInfo.name === null}
              compilerHint={compilerHint}
              onOpenFolder={handleOpenFolder}
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
