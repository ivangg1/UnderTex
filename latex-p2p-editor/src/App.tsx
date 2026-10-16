import { useState, useCallback, useEffect, useRef } from "react";
import "./App.css";

import Toolbar, { PRESET_COLORS } from "./components/Toolbar";
import LatexEditor from "./components/LatexEditor";
import PdfPreview from "./components/PdfPreview";
import {
  pickProjectFolder,
  readProject,
  compileLatex,
} from "./services/tauriBridge";
import {
  CollabManager,
  type CollabUser,
  type PeerInfo,
  type ConnectionStatus,
} from "./services/collabManager";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

function getSavedUser(): CollabUser {
  const savedName = localStorage.getItem("latex_user_name");
  const savedColor = localStorage.getItem("latex_user_color");

  const name =
    savedName || `Usuario_${Math.floor(1000 + Math.random() * 9000)}`;
  const color =
    savedColor ||
    PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];

  return { name, color };
}

function App() {
  // ─── State ──────────────────────────────────────────────────────
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [texContent, setTexContent] = useState<string>("");
  const [isProjectLoaded, setIsProjectLoaded] = useState(false);

  // Collaboration State
  const [currentUser, setCurrentUser] = useState<CollabUser>(getSavedUser);
  const [isHost, setIsHost] = useState(true);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [collabYText, setCollabYText] = useState<Y.Text | null>(null);
  const [collabAwareness, setCollabAwareness] = useState<Awareness | null>(null);

  // PDF Preview & Compiler State
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);

  const collabManagerRef = useRef<CollabManager | null>(null);
  const texContentRef = useRef(texContent);
  texContentRef.current = texContent;

  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;

  const prevPdfUrlRef = useRef<string | null>(null);

  // ─── Compile Handler ─────────────────────────────────────────────

  const handleCompile = useCallback(async () => {
    const currentPath = projectPathRef.current;
    const currentContent = texContentRef.current;

    if (!currentPath) {
      setLogs("Por favor abre una carpeta de proyecto antes de compilar.");
      return;
    }

    setIsCompiling(true);
    setCompileError(null);

    try {
      // Flush save to disk if currently Host
      if (collabManagerRef.current?.isHost) {
        await collabManagerRef.current.flushSave();
      }

      const result = await compileLatex(currentPath, currentContent);

      // Create PDF blob URL from raw bytes
      const uint8Array = new Uint8Array(result.pdf_bytes);
      const blob = new Blob([uint8Array], { type: "application/pdf" });
      const newUrl = URL.createObjectURL(blob);

      // Revoke old URL if existing to free memory
      if (prevPdfUrlRef.current) {
        URL.revokeObjectURL(prevPdfUrlRef.current);
      }
      prevPdfUrlRef.current = newUrl;

      setPdfUrl(newUrl);
      setLogs(result.logs);
      setCompileError(null);
    } catch (err: unknown) {
      console.error("Compilation error:", err);
      const errMsg = typeof err === "string" ? err : String(err);
      setCompileError(errMsg);
      setLogs(errMsg);
    } finally {
      setIsCompiling(false);
    }
  }, []);

  // ─── Global Cmd+S / Ctrl+S shortcut ──────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleCompile();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCompile]);

  // ─── User Profile Handler ─────────────────────────────────────────

  const handleUserChange = useCallback((updatedUser: CollabUser) => {
    setCurrentUser(updatedUser);
    localStorage.setItem("latex_user_name", updatedUser.name);
    localStorage.setItem("latex_user_color", updatedUser.color);
    if (collabManagerRef.current) {
      collabManagerRef.current.updateLocalUser(updatedUser);
    }
  }, []);

  // ─── Open Project Folder Handler ──────────────────────────────────

  const handleOpenFolder = useCallback(async () => {
    try {
      const folder = await pickProjectFolder();
      if (!folder) return;

      const project = await readProject(folder);

      // Clean up previous collab session if any
      if (collabManagerRef.current) {
        collabManagerRef.current.destroy();
        collabManagerRef.current = null;
      }

      // Initialize new P2P Collaboration Session
      const manager = new CollabManager({
        projectPath: project.project_path,
        roomId: project.room_id,
        initialTexContent: project.tex_content,
        initialCrdtState: project.crdt_state,
        currentUser,
        callbacks: {
          onHostChange: (newHost) => setIsHost(newHost),
          onPeersChange: (newPeers) => setPeers(newPeers),
          onStatusChange: (newStatus) => setConnectionStatus(newStatus),
          onContentChange: (newContent) => setTexContent(newContent),
        },
      });

      collabManagerRef.current = manager;

      setProjectPath(project.project_path);
      setRoomId(project.room_id);
      setTexContent(manager.ytext.toString());
      setCollabYText(manager.ytext);
      setCollabAwareness(manager.provider.awareness);
      setIsHost(manager.isHost);
      setPeers(manager.peers);
      setConnectionStatus(manager.status);

      setIsProjectLoaded(true);
      setPdfUrl(null);
      setLogs(null);
      setCompileError(null);
    } catch (err) {
      console.error("Failed to open project:", err);
    }
  }, [currentUser]);

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      collabManagerRef.current?.destroy();
    };
  }, []);

  // ─── Render ─────────────────────────────────────────────────────

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-white overflow-hidden font-sans">
      {/* Top Toolbar */}
      <Toolbar
        projectPath={projectPath}
        roomId={roomId}
        isHost={isHost}
        isCompiling={isCompiling}
        connectionStatus={connectionStatus}
        peers={peers}
        currentUser={currentUser}
        onUserChange={handleUserChange}
        onOpenFolder={handleOpenFolder}
        onCompile={handleCompile}
      />

      {/* Main split pane: Editor 50% | Preview 50% */}
      <div className="flex-1 flex min-h-0">
        {/* Left: CodeMirror 6 Editor with Yjs Collaboration */}
        <div className="w-1/2 min-h-0 border-r border-gray-700">
          {isProjectLoaded ? (
            <LatexEditor
              key={`${projectPath}_${roomId}`}
              initialContent={texContent}
              ytext={collabYText}
              awareness={collabAwareness}
              onChange={setTexContent}
              onCompile={handleCompile}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-gray-500 text-sm gap-2 select-none">
              <p>Abre una carpeta de proyecto para comenzar a colaborar y editar.</p>
              <button
                onClick={handleOpenFolder}
                className="mt-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium text-xs transition-colors cursor-pointer"
              >
                Abrir Carpeta
              </button>
            </div>
          )}
        </div>

        {/* Right: PDF Preview */}
        <div className="w-1/2 min-h-0 bg-gray-850">
          <PdfPreview
            pdfUrl={pdfUrl}
            logs={logs}
            isCompiling={isCompiling}
            compileError={compileError}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
