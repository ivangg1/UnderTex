// Top status bar: project breadcrumb + root file, and live status on the right
// (mode, connection, save state, compiler, last build).

import { AlertTriangle, Check, ChevronRight, Cloud, Crown, FolderOpen, Laptop, Loader2, Save, User, Users, Zap, ZapOff } from "lucide-react";
import { useI18n } from "../i18n";
import type { CollabMode, ConnectionStatus, PeerInfo, SaveState } from "../services/collabManager";
import type { CompilerInfo } from "../services/tauriBridge";
import type { CompileSummary } from "./PdfPreview";
import { connectionLabel } from "./ConnectionBadge";
import { folderName } from "../services/recents";

interface TopBarProps {
  projectPath: string | null;
  mainFile: string | null;
  texFiles: string[];
  mode: CollabMode;
  isHost: boolean;
  peers: PeerInfo[];
  connectionStatus: ConnectionStatus;
  saveState: SaveState;
  compilerInfo: CompilerInfo | null;
  compilerHint: string | null;
  summary: CompileSummary | null;
  pageCount: number | null;
  autoCompile: boolean;
  isCompiling: boolean;
  uiZoom: number;
  onResetZoom: () => void;
  onSelectMainFile: (file: string) => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const ITEM = "flex items-center gap-1.5 px-2.5 h-full border-l border-mk-bg3";

export default function TopBar({
  projectPath,
  mainFile,
  texFiles,
  mode,
  isHost,
  peers,
  connectionStatus,
  saveState,
  compilerInfo,
  compilerHint,
  summary,
  pageCount,
  autoCompile,
  isCompiling,
  uiZoom,
  onResetZoom,
  onSelectMainFile,
}: TopBarProps) {
  const { t } = useI18n();
  const conn = connectionLabel(connectionStatus, t);
  const compilerMissing = compilerInfo !== null && compilerInfo.name === null;

  let save: { icon: React.ReactNode; text: string; cls: string; tip?: string } | null = null;
  switch (saveState.status) {
    case "guest":
      save = { icon: <Cloud size={12} />, text: t("save.guest"), cls: "text-mk-fg3", tip: t("save.guest.tip") };
      break;
    case "saving":
      save = { icon: <Loader2 size={12} className="animate-spin" />, text: t("save.saving"), cls: "text-mk-fg2" };
      break;
    case "dirty":
      save = { icon: <Save size={12} />, text: t("save.dirty"), cls: "text-mk-orange", tip: t("save.dirty.tip") };
      break;
    case "error":
      save = { icon: <AlertTriangle size={12} />, text: t("save.error"), cls: "text-mk-red", tip: saveState.error ?? undefined };
      break;
    case "saved": {
      const time = saveState.lastSavedAt ? formatTime(saveState.lastSavedAt) : "";
      save = { icon: <Check size={12} className="text-mk-green" />, text: t("save.saved", { time }), cls: "text-mk-fg3", tip: t("save.saved.tip", { time }) };
      break;
    }
    default:
      save = null;
  }

  return (
    <header className="h-9 shrink-0 flex items-center bg-mk-bg2 border-b border-mk-bg3 text-[11px] text-mk-fg3 select-none">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 px-3 h-full min-w-0" title={projectPath ?? undefined}>
        <FolderOpen size={13} className="shrink-0" />
        {projectPath ? (
          <>
            <span className="text-mk-fg2 font-medium truncate max-w-48">{folderName(projectPath)}</span>
            <ChevronRight size={12} className="shrink-0 text-mk-fg4" />
            {texFiles.length > 1 ? (
              <select
                value={mainFile ?? ""}
                onChange={(e) => onSelectMainFile(e.target.value)}
                disabled={mode === "collab" || isCompiling}
                className="bg-transparent text-mk-fg font-mono text-[11px] focus:outline-none cursor-pointer disabled:cursor-not-allowed max-w-56 truncate"
                title={mode === "collab" ? t("toolbar.rootFile.lockedTip") : t("toolbar.rootFile.tip")}
              >
                {texFiles.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-mk-fg font-mono truncate">{mainFile}</span>
            )}
          </>
        ) : (
          <span>{t("status.noProject")}</span>
        )}
      </div>

      <div className="flex-1" />

      {/* Mode */}
      {projectPath && (
        <span
          className={`${ITEM} ${mode === "collab" ? (isHost ? "text-mk-yellow" : "text-mk-blue") : ""}`}
          title={mode === "collab" ? (isHost ? t("mode.host.tip") : t("mode.guest.tip")) : t("mode.solo.tip")}
        >
          {mode === "collab" ? (isHost ? <Crown size={12} /> : <User size={12} />) : <Laptop size={12} />}
          {mode === "collab" ? (isHost ? t("mode.host") : t("mode.guest")) : t("mode.solo")}
        </span>
      )}

      {/* Connection + peers */}
      {mode === "collab" && (
        <span className={`${ITEM} ${conn.textColor}`} title={conn.text}>
          <span className={`w-2 h-2 rounded-full ${conn.dot}`} />
          {conn.text}
          <span className="flex items-center gap-0.5 text-mk-fg3 ml-1">
            <Users size={12} />
            {peers.length}
          </span>
        </span>
      )}

      {/* Save */}
      {save && projectPath && (
        <span className={`${ITEM} ${save.cls}`} title={save.tip}>
          {save.icon}
          {save.text}
        </span>
      )}

      {/* Compiler + build mode */}
      {compilerInfo && (
        <span
          className={`${ITEM} ${compilerMissing ? "text-mk-red" : ""}`}
          title={compilerMissing ? (compilerHint ?? undefined) : `${compilerInfo.version ?? compilerInfo.name}\n${compilerInfo.path ?? ""}`}
        >
          {compilerMissing ? <ZapOff size={12} /> : <Zap size={12} className={autoCompile ? "text-mk-yellow" : "text-mk-fg4"} />}
          {compilerMissing ? t("compiler.missing") : compilerInfo.name}
          {!compilerMissing && <span className="text-mk-fg4">· {autoCompile ? t("topbar.autoOn") : t("topbar.manual")}</span>}
        </span>
      )}

      {/* Zoom (only when not 100 %) */}
      {Math.abs(uiZoom - 1) > 0.001 && (
        <button
          onClick={onResetZoom}
          className={`${ITEM} text-mk-fg3 hover:text-mk-fg cursor-pointer`}
          title={t("zoom.level", { percent: Math.round(uiZoom * 100) })}
        >
          <span className="font-mono">{Math.round(uiZoom * 100)}%</span>
        </button>
      )}

      {/* Last build */}
      {isCompiling && (
        <span className={`${ITEM} text-mk-fg3`}>
          <Loader2 size={12} className="animate-spin" />
        </span>
      )}
      {summary && (
        <span className={`${ITEM} ${summary.success ? "" : "text-mk-red"}`} title={t("topbar.lastBuild")}>
          <span className="font-mono">{(summary.durationMs / 1000).toFixed(1)}s</span>
          {pageCount !== null && <span className="text-mk-fg4">· {pageCount === 1 ? t("preview.page") : t("preview.pages", { count: pageCount })}</span>}
        </span>
      )}
    </header>
  );
}
