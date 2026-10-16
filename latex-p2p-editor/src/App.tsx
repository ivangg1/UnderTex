import { useState, useCallback, useEffect, useRef } from "react";
import "./App.css";

import Toolbar from "./components/Toolbar";
import LatexEditor from "./components/LatexEditor";
import PdfPreview from "./components/PdfPreview";
import {
  pickProjectFolder,
  readProject,
  saveTexAtomic,
  compileLatex,
} from "./services/tauriBridge";

function App() {
  // ─── State ──────────────────────────────────────────────────────
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [texContent, setTexContent] = useState<string>("");
  const [isProjectLoaded, setIsProjectLoaded] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);

  // Keep a ref to current texContent and projectPath for shortcut handlers
  const texContentRef = useRef(texContent);
  texContentRef.current = texContent;

  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;

  const prevPdfUrlRef = useRef<string | null>(null);

  // Phase 1: single user is always Host
  const isHost = true;

  // ─── Compile Handler ─────────────────────────────────────────────

  const handleCompile = useCallback(async () => {
    const currentPath = projectPathRef.current;
    const currentContent = texContentRef.current;

    if (!currentPath) {
      setLogs("Please open a project folder first before compiling.");
      return;
    }

    setIsCompiling(true);
    setCompileError(null);

    try {
      // If host, also ensure the main.tex is saved to disk
      if (isHost) {
        saveTexAtomic(currentPath, currentContent).catch(console.error);
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
  }, [isHost]);

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

  // ─── Folder & Editor Handlers ────────────────────────────────────

  const handleOpenFolder = useCallback(async () => {
    try {
      const folder = await pickProjectFolder();
      if (!folder) return;

      const project = await readProject(folder);
      setProjectPath(project.project_path);
      setRoomId(project.room_id);
      setTexContent(project.tex_content);
      setIsProjectLoaded(true);
      setPdfUrl(null);
      setLogs(null);
      setCompileError(null);
    } catch (err) {
      console.error("Failed to open project:", err);
    }
  }, []);

  const handleChange = useCallback(
    (content: string) => {
      setTexContent(content);
      // Auto-save for Host
      if (isHost && projectPath) {
        saveTexAtomic(projectPath, content).catch(console.error);
      }
    },
    [isHost, projectPath]
  );

  // ─── Render ─────────────────────────────────────────────────────

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-white overflow-hidden">
      {/* Top toolbar */}
      <Toolbar
        projectPath={projectPath}
        roomId={roomId}
        isHost={isHost}
        isCompiling={isCompiling}
        onOpenFolder={handleOpenFolder}
        onCompile={handleCompile}
      />

      {/* Main split pane: editor 50% | preview 50% */}
      <div className="flex-1 flex min-h-0">
        {/* Left: Editor */}
        <div className="w-1/2 min-h-0 border-r border-gray-700">
          {isProjectLoaded ? (
            <LatexEditor
              key={projectPath}
              initialContent={texContent}
              onChange={handleChange}
              onCompile={handleCompile}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-gray-500 text-sm">
              Open a project folder to start editing
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
