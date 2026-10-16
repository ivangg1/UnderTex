// Toolbar component: Open folder, Room ID, Host Badge, Compile button, User color/name

import { FolderOpen, Play, Loader2, Crown } from "lucide-react";

interface ToolbarProps {
  projectPath: string | null;
  roomId: string | null;
  isHost: boolean;
  isCompiling: boolean;
  onOpenFolder: () => void;
  onCompile: () => void;
}

export default function Toolbar({
  projectPath,
  roomId,
  isHost,
  isCompiling,
  onOpenFolder,
  onCompile,
}: ToolbarProps) {
  const folderName = projectPath
    ? projectPath.split("/").pop() ?? projectPath
    : null;

  return (
    <header className="flex items-center gap-3 px-4 py-2 bg-gray-800 border-b border-gray-700 select-none">
      {/* Open folder */}
      <button
        onClick={onOpenFolder}
        disabled={isCompiling}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm font-medium transition-colors"
        title="Open LaTeX project folder"
      >
        <FolderOpen size={16} />
        Open Folder
      </button>

      {/* Project name */}
      {folderName && (
        <span className="text-sm text-gray-300 truncate max-w-48">
          {folderName}
        </span>
      )}

      {/* Room ID badge */}
      {roomId && (
        <span
          className="text-xs text-gray-400 bg-gray-700 px-2 py-1 rounded font-mono truncate max-w-36"
          title={`Room: ${roomId}`}
        >
          Room: {roomId.slice(0, 8)}…
        </span>
      )}

      {/* Host badge */}
      {projectPath && (
        <span
          className={`flex items-center gap-1 text-xs px-2 py-1 rounded font-medium ${
            isHost
              ? "bg-yellow-600/30 text-yellow-300"
              : "bg-gray-700 text-gray-400"
          }`}
        >
          <Crown size={12} />
          {isHost ? "Host" : "Guest"}
        </span>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Compile button with shortcut hint and spinner */}
      <button
        onClick={onCompile}
        disabled={!projectPath || isCompiling}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-colors cursor-pointer"
        title="Compile LaTeX (Cmd+S / Ctrl+S)"
      >
        {isCompiling ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            <span>Compiling…</span>
          </>
        ) : (
          <>
            <Play size={16} />
            <span>Compile</span>
            <span className="text-xs opacity-75 bg-green-700/60 px-1 py-0.5 rounded font-mono">
              ⌘S
            </span>
          </>
        )}
      </button>
    </header>
  );
}
