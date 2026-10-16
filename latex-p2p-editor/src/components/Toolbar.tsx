// Toolbar component: Open folder, Room ID with copy, Host badge,
// WebRTC status indicator, connected peers list/avatars, user profile selector, and compile button.

import { useState, useRef, useEffect } from "react";
import {
  FolderOpen,
  Play,
  Loader2,
  Crown,
  Copy,
  Check,
  User,
  Users,
  ChevronDown,
} from "lucide-react";
import type { PeerInfo, ConnectionStatus, CollabUser } from "../services/collabManager";

export const PRESET_COLORS = [
  "#ef4444", // Red
  "#f97316", // Orange
  "#eab308", // Yellow
  "#10b981", // Green
  "#06b6d4", // Cyan
  "#3b82f6", // Blue
  "#8b5cf6", // Purple
  "#ec4899", // Pink
];

interface ToolbarProps {
  projectPath: string | null;
  roomId: string | null;
  isHost: boolean;
  isCompiling: boolean;
  connectionStatus: ConnectionStatus;
  peers: PeerInfo[];
  currentUser: CollabUser;
  onUserChange: (user: CollabUser) => void;
  onOpenFolder: () => void;
  onCompile: () => void;
}

export default function Toolbar({
  projectPath,
  roomId,
  isHost,
  isCompiling,
  connectionStatus,
  peers,
  currentUser,
  onUserChange,
  onOpenFolder,
  onCompile,
}: ToolbarProps) {
  const [copied, setCopied] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [userNameInput, setUserNameInput] = useState(currentUser.name);
  const profileRef = useRef<HTMLDivElement>(null);

  // Sync internal name state if currentUser updates
  useEffect(() => {
    setUserNameInput(currentUser.name);
  }, [currentUser.name]);

  // Close profile dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        profileRef.current &&
        !profileRef.current.contains(e.target as Node)
      ) {
        setIsProfileOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleCopyRoom = async () => {
    if (!roomId) return;
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy room ID:", err);
    }
  };

  const handleNameBlur = () => {
    const trimmed = userNameInput.trim();
    if (trimmed && trimmed !== currentUser.name) {
      onUserChange({ ...currentUser, name: trimmed });
    } else {
      setUserNameInput(currentUser.name);
    }
  };

  const handleColorSelect = (color: string) => {
    onUserChange({ ...currentUser, color });
  };

  const folderName = projectPath
    ? projectPath.split("/").pop() ?? projectPath
    : null;

  return (
    <header className="flex items-center gap-2.5 px-4 py-2 bg-gray-800 border-b border-gray-700 select-none text-xs">
      {/* ─── Open Folder ─── */}
      <button
        onClick={onOpenFolder}
        disabled={isCompiling}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors cursor-pointer"
        title="Abrir carpeta del proyecto LaTeX"
      >
        <FolderOpen size={15} />
        <span>Abrir</span>
      </button>

      {/* Project name */}
      {folderName && (
        <span
          className="text-gray-300 font-medium truncate max-w-40 px-1.5 py-0.5 rounded bg-gray-700/60"
          title={projectPath || ""}
        >
          {folderName}
        </span>
      )}

      {/* ─── WebRTC Room & Copy Button ─── */}
      {roomId && (
        <div className="flex items-center gap-1 bg-gray-700/70 border border-gray-600/60 rounded px-2 py-1">
          <span className="text-gray-400 font-mono text-[11px] truncate max-w-28">
            Sala: {roomId.slice(0, 8)}…
          </span>
          <button
            onClick={handleCopyRoom}
            className="flex items-center gap-1 text-[11px] font-medium text-gray-300 hover:text-white transition-colors cursor-pointer ml-1 pl-1.5 border-l border-gray-600"
            title="Copiar UUID de la sala para invitar compañeros"
          >
            {copied ? (
              <>
                <Check size={13} className="text-green-400" />
                <span className="text-green-400 font-semibold">¡Copiado!</span>
              </>
            ) : (
              <>
                <Copy size={13} />
                <span>Copiar</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* ─── WebRTC Connection Status ─── */}
      {roomId && (
        <div
          className="flex items-center gap-1.5 px-2 py-1 rounded bg-gray-700/50 border border-gray-600/40 text-[11px]"
          title={`Estado de sincronización WebRTC: ${connectionStatus}`}
        >
          {connectionStatus === "connected" ? (
            <>
              <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
              <span className="text-emerald-300 font-medium">Conectado</span>
            </>
          ) : connectionStatus === "connecting" ? (
            <>
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-amber-300 font-medium">Conectando…</span>
            </>
          ) : (
            <>
              <span className="w-2 h-2 rounded-full bg-rose-500" />
              <span className="text-rose-300 font-medium">Desconectado</span>
            </>
          )}
        </div>
      )}

      {/* ─── Host / Guest Badge (Leader Election) ─── */}
      {projectPath && (
        <span
          className={`flex items-center gap-1 px-2 py-1 rounded font-medium text-[11px] ${
            isHost
              ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
              : "bg-gray-700/70 text-gray-300 border border-gray-600/50"
          }`}
          title={
            isHost
              ? "Eres el Host: tu cliente escribe atómicamente a disco para evitar conflictos en la nube."
              : "Eres Invitado: sincronizas en memoria con el enjambre P2P."
          }
        >
          <Crown size={12} className={isHost ? "text-amber-400" : "opacity-60"} />
          {isHost ? "Host Activo" : "Invitado"}
        </span>
      )}

      {/* ─── Connected Peers Avatars ─── */}
      {roomId && peers.length > 0 && (
        <div className="flex items-center gap-1.5 ml-1 pl-2 border-l border-gray-700">
          <div className="flex items-center gap-1 text-gray-400 text-[11px] mr-1">
            <Users size={13} />
            <span>{peers.length}</span>
          </div>

          <div className="flex items-center -space-x-1.5 overflow-visible">
            {peers.map((peer) => {
              const initial = (peer.name || "U").charAt(0).toUpperCase();
              return (
                <div
                  key={peer.clientID}
                  className="relative group cursor-pointer"
                >
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center font-bold text-[11px] text-white ring-2 ring-gray-800 shadow"
                    style={{ backgroundColor: peer.color }}
                  >
                    {initial}
                  </div>

                  {peer.isHost && (
                    <div className="absolute -top-1 -right-1 bg-amber-400 text-gray-950 rounded-full p-0.5 ring-1 ring-gray-900 shadow">
                      <Crown size={8} />
                    </div>
                  )}

                  {/* Tooltip */}
                  <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 hidden group-hover:flex flex-col items-center bg-gray-950 text-white text-[10px] px-2 py-1 rounded shadow-lg border border-gray-800 whitespace-nowrap z-50 pointer-events-none">
                    <span className="font-semibold">
                      {peer.name} {peer.isSelf && "(Tú)"}
                    </span>
                    <span className="text-gray-400 text-[9px]">
                      {peer.isHost ? "👑 Host Activo" : "👤 Invitado"} • ID:{" "}
                      {peer.clientID.toString().slice(-4)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* ─── User Profile & Collaborative Cursor Settings ─── */}
      <div className="relative" ref={profileRef}>
        <button
          onClick={() => setIsProfileOpen((prev) => !prev)}
          className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-gray-700/80 transition-colors border border-gray-700 cursor-pointer"
          title="Configurar tu nombre y color de cursor colaborativo"
        >
          <span
            className="w-3.5 h-3.5 rounded-full border border-white/40"
            style={{ backgroundColor: currentUser.color }}
          />
          <span className="font-medium text-gray-200 truncate max-w-24">
            {currentUser.name}
          </span>
          <ChevronDown size={12} className="text-gray-400" />
        </button>

        {isProfileOpen && (
          <div className="absolute right-0 top-full mt-2 w-56 bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-3 z-50 text-gray-200">
            <div className="flex items-center gap-1.5 mb-2 font-semibold text-xs text-gray-300">
              <User size={14} />
              <span>Perfil Colaborativo</span>
            </div>

            {/* Name Input */}
            <div className="mb-3">
              <label className="block text-[11px] text-gray-400 mb-1">
                Tu Nombre:
              </label>
              <input
                type="text"
                value={userNameInput}
                onChange={(e) => setUserNameInput(e.target.value)}
                onBlur={handleNameBlur}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleNameBlur();
                    setIsProfileOpen(false);
                  }
                }}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                placeholder="Escribe tu nombre…"
                maxLength={24}
              />
            </div>

            {/* Color Swatches */}
            <div>
              <label className="block text-[11px] text-gray-400 mb-1.5">
                Color de tu Cursor:
              </label>
              <div className="grid grid-cols-4 gap-2">
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color}
                    onClick={() => handleColorSelect(color)}
                    className={`w-7 h-7 rounded-md cursor-pointer transition-transform hover:scale-110 flex items-center justify-center ${
                      currentUser.color === color
                        ? "ring-2 ring-white scale-105"
                        : "opacity-80 hover:opacity-100"
                    }`}
                    style={{ backgroundColor: color }}
                    title={color}
                  >
                    {currentUser.color === color && (
                      <Check size={14} className="text-white drop-shadow" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ─── Compile Button ─── */}
      <button
        onClick={onCompile}
        disabled={!projectPath || isCompiling}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors cursor-pointer ml-1"
        title="Compilar LaTeX localmente (Cmd+S / Ctrl+S)"
      >
        {isCompiling ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            <span>Compilando…</span>
          </>
        ) : (
          <>
            <Play size={14} />
            <span>Compilar</span>
            <span className="text-[10px] opacity-80 bg-green-700/70 px-1 py-0.5 rounded font-mono">
              ⌘S
            </span>
          </>
        )}
      </button>
    </header>
  );
}
