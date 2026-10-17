// Top status bar: project breadcrumb + root file, and live status on the right
// (mode, connection, save state, compiler, last build).

import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronRight,
  Cloud,
  Crown,
  Feather,
  FolderOpen,
  Laptop,
  Layers,
  Loader2,
  Save,
  User,
  Users,
  Zap,
  ZapOff,
} from "lucide-react";
import { useI18n } from "../i18n";
import type { CollabMode, ConnectionStatus, PeerInfo, SaveState } from "../services/collabManager";
import type { CloudLocation, CompilerInfo } from "../services/tauriBridge";
import { cloudLabel, isCloud } from "../services/cloud";
import { chapterScope, scopeChapter, type BuildScope, type BuildSettings } from "../services/buildMode";
import type { CompileSummary } from "./PdfPreview";
import { connectionLabel } from "./ConnectionBadge";
import { folderName } from "../services/recents";

interface TopBarProps {
  projectPath: string | null;
  /** Cloud sync client of the project folder, shown in the breadcrumb tooltip. */
  cloud: CloudLocation | null;
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
  /** Chapters the root file `\include`s (the scope control is hidden without them). */
  chapters: string[];
  buildSettings: BuildSettings;
  onChangeScope: (scope: BuildScope) => void;
  onToggleDraft: () => void;
  onTogglePreamble: () => void;
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
  cloud,
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
  chapters,
  buildSettings,
  onChangeScope,
  onToggleDraft,
  onTogglePreamble,
  uiZoom,
  onResetZoom,
  onSelectMainFile,
}: TopBarProps) {
  const { t } = useI18n();
  const conn = connectionLabel(connectionStatus, t);
  const compilerMissing = compilerInfo !== null && compilerInfo.name === null;
  const scopeActive = chapters.length > 0 && buildSettings.scope !== "full";
  // A picked chapter that vanished from the root file shows as "full" in the control.
  const picked = scopeChapter(buildSettings.scope);
  const scopeValue: BuildScope = picked !== null && !chapters.includes(picked) ? "full" : buildSettings.scope;

  let lastBuildBadge: string | null = null;
  if (summary) {
    const parts: string[] = [];
    if (summary.mode === "chapter") parts.push(t("build.summary.chapter", { name: summary.chapter ?? "?" }));
    else parts.push(t("build.summary.full"));
    if (summary.draft) parts.push(t("build.badge.draft"));
    if (summary.preamble === "reused" || summary.preamble === "created" || summary.preamble === "failed") {
      parts.push(t(`build.badge.preamble.${summary.preamble}`));
    }
    lastBuildBadge = parts.join(" · ");
  }

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
      <div
        className="flex items-center gap-1.5 px-3 h-full min-w-0"
        title={projectPath ? (cloud ? `${cloudLabel(cloud, t)}\n${projectPath}` : projectPath) : undefined}
      >
        {isCloud(cloud) ? <Cloud size={13} className="shrink-0 text-mk-blue" /> : <FolderOpen size={13} className="shrink-0" />}
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

      {/* Build scope: only for documents split with \include */}
      {projectPath && chapters.length > 0 && (
        <span className={`${ITEM} ${scopeActive ? "text-mk-blue" : ""}`} title={t("build.scope.tip")}>
          <BookOpen size={12} className="shrink-0" />
          <select
            value={scopeValue}
            onChange={(e) => onChangeScope(e.target.value as BuildScope)}
            disabled={isCompiling}
            className="bg-transparent text-[11px] focus:outline-none cursor-pointer disabled:cursor-not-allowed max-w-48 truncate"
          >
            <option value="full">{t("build.scope.full")}</option>
            <option value="cursor">{t("build.scope.cursor")}</option>
            {chapters.map((c) => (
              <option key={c} value={chapterScope(c)}>
                {t("build.scope.chapter", { name: c })}
              </option>
            ))}
          </select>
        </span>
      )}

      {/* Draft mode */}
      {projectPath && (
        <button
          onClick={onToggleDraft}
          className={`${ITEM} cursor-pointer hover:text-mk-fg ${buildSettings.draft ? "text-mk-orange" : ""}`}
          title={buildSettings.draft ? t("build.draft.on") : t("build.draft.off")}
          aria-pressed={buildSettings.draft}
        >
          <Feather size={12} />
          {t("build.draft")}
        </button>
      )}

      {/* Precompiled preamble (pdflatex only) */}
      {projectPath && compilerInfo?.name === "pdflatex" && (
        <button
          onClick={onTogglePreamble}
          className={`${ITEM} cursor-pointer hover:text-mk-fg ${buildSettings.precompiledPreamble ? "text-mk-green" : ""}`}
          title={buildSettings.precompiledPreamble ? t("build.preamble.on") : t("build.preamble.off")}
          aria-pressed={buildSettings.precompiledPreamble}
        >
          <Layers size={12} />
          {t("build.preamble")}
        </button>
      )}

      {/* Compiler + auto/manual */}
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
        <span
          className={`${ITEM} ${summary.success ? "" : "text-mk-red"}`}
          title={lastBuildBadge ? t("build.badge.tip", { mode: lastBuildBadge }) : t("topbar.lastBuild")}
        >
          <span className="font-mono">{(summary.durationMs / 1000).toFixed(1)}s</span>
          {pageCount !== null && <span className="text-mk-fg4">· {pageCount === 1 ? t("preview.page") : t("preview.pages", { count: pageCount })}</span>}
          {summary.mode === "chapter" && <span className="text-mk-blue">· {t("build.badge.chapter")}</span>}
          {summary.draft && <span className="text-mk-orange">· {t("build.badge.draft")}</span>}
        </span>
      )}
    </header>
  );
}
