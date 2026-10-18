// Bottom status bar (IDE style): live state only, no primary actions.
// Left: collaboration (mode, connection, peers) and save state.
// Right: cursor position, compiler and auto build, last build, UI zoom.

import { AlertTriangle, Check, Cloud, Crown, Laptop, Loader2, Save, User, Users, Zap, ZapOff } from "lucide-react";
import { useI18n } from "../i18n";
import type { CollabMode, ConnectionStatus, PeerInfo, SaveState } from "../services/collabManager";
import type { CompilerInfo } from "../services/tauriBridge";
import type { CompileSummary } from "./PdfPreview";
import { connectionLabel } from "./ConnectionBadge";
import BrandLogo from "./BrandLogo";

interface StatusBarProps {
  hasProject: boolean;
  mode: CollabMode;
  isHost: boolean;
  peers: PeerInfo[];
  connectionStatus: ConnectionStatus;
  saveState: SaveState;
  cursorLine: number | null;
  compilerInfo: CompilerInfo | null;
  compilerHint: string | null;
  autoCompile: boolean;
  isCompiling: boolean;
  summary: CompileSummary | null;
  pageCount: number | null;
  errorCount: number;
  warningCount: number;
  uiZoom: number;
  onResetZoom: () => void;
  onOpenRoom: () => void;
  onToggleAuto: () => void;
  onShowProblems: () => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const ITEM = "flex items-center gap-1 px-2 h-full whitespace-nowrap";
const BUTTON = `${ITEM} hover:bg-mk-bg3 hover:text-mk-fg cursor-pointer`;

export default function StatusBar(props: StatusBarProps) {
  const { t } = useI18n();
  const { mode, isHost, peers, saveState, compilerInfo, summary } = props;
  const conn = connectionLabel(props.connectionStatus, t);
  const compilerMissing = compilerInfo !== null && compilerInfo.name === null;

  let save: { icon: React.ReactNode; text: string; cls: string; tip?: string } | null = null;
  switch (saveState.status) {
    case "guest":
      save = { icon: <Cloud size={11} />, text: t("save.guest"), cls: "", tip: t("save.guest.tip") };
      break;
    case "saving":
      save = { icon: <Loader2 size={11} className="animate-spin" />, text: t("save.saving"), cls: "" };
      break;
    case "dirty":
      save = { icon: <Save size={11} />, text: t("save.dirty"), cls: "text-mk-orange", tip: t("save.dirty.tip") };
      break;
    case "error":
      save = { icon: <AlertTriangle size={11} />, text: t("save.error"), cls: "text-mk-red", tip: saveState.error ?? undefined };
      break;
    case "saved": {
      const time = saveState.lastSavedAt ? formatTime(saveState.lastSavedAt) : "";
      save = { icon: <Check size={11} className="text-mk-green" />, text: t("save.saved", { time }), cls: "", tip: t("save.saved.tip", { time }) };
      break;
    }
    default:
      save = null;
  }

  return (
    <footer className="h-6 shrink-0 flex items-stretch bg-mk-bg2 border-t border-mk-bg3 text-[10.5px] text-mk-fg3 select-none">
      <span className="flex items-center pl-2 pr-2.5 border-r border-mk-bg3">
        <BrandLogo className="h-3.5 opacity-90" />
      </span>
      {props.hasProject && (
        <button
          onClick={props.onOpenRoom}
          className={`${BUTTON} ${mode === "collab" ? (isHost ? "text-mk-yellow" : "text-mk-blue") : ""}`}
          title={mode === "collab" ? (isHost ? t("mode.host.tip") : t("mode.guest.tip")) : t("mode.solo.tip")}
        >
          {mode === "collab" ? (isHost ? <Crown size={11} /> : <User size={11} />) : <Laptop size={11} />}
          {mode === "collab" ? (isHost ? t("mode.host") : t("mode.guest")) : t("mode.solo")}
        </button>
      )}
      {mode === "collab" && (
        <button onClick={props.onOpenRoom} className={`${BUTTON} ${conn.textColor}`} title={conn.text}>
          <span className={`w-1.5 h-1.5 rounded-full ${conn.dot}`} />
          {conn.text}
          <span className="flex items-center gap-0.5 ml-1 text-mk-fg3">
            <Users size={11} />
            {peers.length}
          </span>
        </button>
      )}
      {save && props.hasProject && (
        <span className={`${ITEM} ${save.cls}`} title={save.tip}>
          {save.icon}
          {save.text}
        </span>
      )}
      {(props.errorCount > 0 || props.warningCount > 0) && (
        <button onClick={props.onShowProblems} className={BUTTON} title={t("status.problems.tip")}>
          <span className={props.errorCount > 0 ? "text-mk-red" : ""}>⨯ {props.errorCount}</span>
          <span className={props.warningCount > 0 ? "text-mk-yellow" : ""}>⚠ {props.warningCount}</span>
        </button>
      )}

      <div className="flex-1" />

      {props.cursorLine !== null && <span className={ITEM}>{t("status.line", { line: props.cursorLine })}</span>}
      {compilerInfo && (
        <button
          onClick={props.onToggleAuto}
          className={`${BUTTON} ${compilerMissing ? "text-mk-red" : ""}`}
          title={
            compilerMissing
              ? (props.compilerHint ?? undefined)
              : `${compilerInfo.version ?? compilerInfo.name}\n${compilerInfo.path ?? ""}\n\n${props.autoCompile ? t("rail.auto.on") : t("rail.auto.off")}`
          }
        >
          {compilerMissing ? <ZapOff size={11} /> : <Zap size={11} className={props.autoCompile ? "text-mk-yellow" : "text-mk-fg4"} />}
          {compilerMissing ? t("compiler.missing") : compilerInfo.name}
          {!compilerMissing && <span className="text-mk-fg4">· {props.autoCompile ? t("topbar.autoOn") : t("topbar.manual")}</span>}
        </button>
      )}
      {props.isCompiling && (
        <span className={ITEM}>
          <Loader2 size={11} className="animate-spin" />
        </span>
      )}
      {summary && (
        <span className={`${ITEM} ${summary.success ? "" : "text-mk-red"}`} title={t("topbar.lastBuild")}>
          <span className="font-mono">{(summary.durationMs / 1000).toFixed(1)}s</span>
          {props.pageCount !== null && (
            <span className="text-mk-fg4">· {props.pageCount === 1 ? t("preview.page") : t("preview.pages", { count: props.pageCount })}</span>
          )}
          {summary.mode === "chapter" && <span className="text-mk-blue">· {t("build.badge.chapter")}</span>}
          {summary.draft && <span className="text-mk-orange">· {t("build.badge.draft")}</span>}
        </span>
      )}
      {Math.abs(props.uiZoom - 1) > 0.001 && (
        <button onClick={props.onResetZoom} className={BUTTON} title={t("zoom.level", { percent: Math.round(props.uiZoom * 100) })}>
          <span className="font-mono">{Math.round(props.uiZoom * 100)}%</span>
        </button>
      )}
    </footer>
  );
}
