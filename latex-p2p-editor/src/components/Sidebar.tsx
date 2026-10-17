// Activity rail (left) with the app's actions, plus the flyout panel that opens
// next to it (room, join, profile). IDE-style: icon + short label, no chrome.

import type { ReactNode } from "react";
import {
  Crown,
  Download,
  FilePlus,
  FolderOpen,
  FolderTree,
  History,
  Languages,
  Loader2,
  LogIn,
  Play,
  Share2,
  Users,
  X,
  Zap,
  ZapOff,
} from "lucide-react";
import { useI18n } from "../i18n";
import type { CollabMode, CollabUser, ConnectionStatus } from "../services/collabManager";
import { connectionLabel } from "./ConnectionBadge";

export type PanelId = "room" | "join" | "profile" | "new" | "history";

interface SidebarProps {
  hasProject: boolean;
  mode: CollabMode;
  isHost: boolean;
  peerCount: number;
  connectionStatus: ConnectionStatus;
  isCompiling: boolean;
  autoCompile: boolean;
  /** Tooltip text for the Build button (reflects the current build mode). */
  buildTitle: string;
  canExport: boolean;
  currentUser: CollabUser;
  activePanel: PanelId | null;
  showFileTree?: boolean;
  onToggleFileTree?: () => void;
  onOpenFolder: () => void;
  onTogglePanel: (panel: PanelId) => void;
  onStartCollab: () => void;
  onCompile: () => void;
  onToggleAuto: () => void;
  onExport: () => void;
  panel: ReactNode;
  panelTitle: string;
  onClosePanel: () => void;
}

interface RailButtonProps {
  icon: ReactNode;
  label: string;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  accent?: string; // tailwind text color for the icon when active/highlighted
  badge?: ReactNode;
}

function RailButton({ icon, label, title, onClick, active, disabled, accent, badge }: RailButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`relative w-full flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium tracking-wide cursor-pointer transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${
        active ? "text-mk-fg bg-mk-bg" : "text-mk-fg3 hover:text-mk-fg hover:bg-mk-bg/60"
      }`}
    >
      {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-mk-yellow" />}
      <span className={accent && !disabled ? accent : ""}>{icon}</span>
      <span>{label}</span>
      {badge}
    </button>
  );
}

export default function Sidebar({
  hasProject,
  mode,
  isHost,
  peerCount,
  connectionStatus,
  isCompiling,
  autoCompile,
  buildTitle,
  canExport,
  currentUser,
  activePanel,
  showFileTree = true,
  onToggleFileTree,
  onOpenFolder,
  onTogglePanel,
  onStartCollab,
  onCompile,
  onToggleAuto,
  onExport,
  panel,
  panelTitle,
  onClosePanel,
}: SidebarProps) {
  const { t, locale } = useI18n();
  const conn = connectionLabel(connectionStatus, t);

  return (
    <div className="flex h-full shrink-0">
      {/* Rail */}
      <nav className="w-16 shrink-0 flex flex-col bg-mk-bg2 border-r border-mk-bg3 select-none">
        <RailButton
          icon={<FilePlus size={20} strokeWidth={1.75} />}
          label={t("rail.new")}
          title={t("new.title")}
          onClick={() => onTogglePanel("new")}
          active={activePanel === "new"}
          disabled={isCompiling}
        />
        <RailButton
          icon={<FolderOpen size={20} strokeWidth={1.75} />}
          label={t("rail.open")}
          title={t("toolbar.open.tip")}
          onClick={onOpenFolder}
          disabled={isCompiling}
        />
        {hasProject && onToggleFileTree && (
          <RailButton
            icon={<FolderTree size={20} strokeWidth={1.75} />}
            label={t("files.title")}
            title={t("files.togglePanel")}
            onClick={onToggleFileTree}
            active={showFileTree}
            disabled={isCompiling}
          />
        )}
        <RailButton
          icon={<LogIn size={20} strokeWidth={1.75} />}
          label={t("rail.join")}
          title={t("toolbar.join.tip")}
          onClick={() => onTogglePanel("join")}
          active={activePanel === "join"}
          disabled={isCompiling}
        />
        {mode === "collab" ? (
          <RailButton
            icon={
              <span className="relative">
                <Users size={20} strokeWidth={1.75} />
                <span className={`absolute -right-1.5 -top-1 w-2 h-2 rounded-full ring-2 ring-mk-bg2 ${conn.dot}`} />
              </span>
            }
            label={t("rail.room")}
            title={t("toolbar.room.tip")}
            onClick={() => onTogglePanel("room")}
            active={activePanel === "room"}
            accent={isHost ? "text-mk-yellow" : "text-mk-blue"}
            badge={
              <span className="absolute right-2 top-1.5 flex items-center gap-0.5 text-[9px] font-mono text-mk-fg2">
                {isHost && <Crown size={9} className="text-mk-yellow" />}
                {peerCount}
              </span>
            }
          />
        ) : (
          <RailButton
            icon={<Share2 size={20} strokeWidth={1.75} />}
            label={t("rail.share")}
            title={t("toolbar.collaborate.tip")}
            onClick={onStartCollab}
            disabled={!hasProject || isCompiling}
            accent="text-mk-green"
          />
        )}

        <div className="my-1 mx-3 border-t border-mk-bg3" />

        <RailButton
          icon={isCompiling ? <Loader2 size={20} className="animate-spin" /> : <Play size={20} strokeWidth={1.75} />}
          label={t("rail.build")}
          title={buildTitle}
          onClick={onCompile}
          disabled={!hasProject || isCompiling}
          accent="text-mk-green"
        />
        <RailButton
          icon={autoCompile ? <Zap size={20} strokeWidth={1.75} /> : <ZapOff size={20} strokeWidth={1.75} />}
          label={t("rail.auto")}
          title={autoCompile ? t("rail.auto.on") : t("rail.auto.off")}
          onClick={onToggleAuto}
          accent={autoCompile ? "text-mk-yellow" : undefined}
        />
        <RailButton
          icon={<Download size={20} strokeWidth={1.75} />}
          label={t("rail.export")}
          title={t("preview.export.tip")}
          onClick={onExport}
          disabled={!canExport}
        />
        <RailButton
          icon={<History size={20} strokeWidth={1.75} />}
          label={t("rail.history")}
          title={t("history.title")}
          onClick={() => onTogglePanel("history")}
          active={activePanel === "history"}
          disabled={!hasProject}
        />

        <div className="flex-1" />

        <RailButton
          icon={
            <span
              className="w-5 h-5 rounded-full border-2 border-mk-bg2 ring-1 ring-mk-bg4 flex items-center justify-center text-[10px] font-bold text-mk-bg2"
              style={{ backgroundColor: currentUser.color }}
            >
              {currentUser.name.charAt(0).toUpperCase()}
            </span>
          }
          label={t("rail.you")}
          title={t("toolbar.profile.tip")}
          onClick={() => onTogglePanel("profile")}
          active={activePanel === "profile"}
        />
        <RailButton
          icon={<Languages size={20} strokeWidth={1.75} />}
          label={locale.toUpperCase()}
          title={t("toolbar.language")}
          onClick={() => onTogglePanel("profile")}
          active={false}
        />
      </nav>

      {/* Flyout panel */}
      {activePanel && (
        <aside className="w-80 shrink-0 flex flex-col bg-mk-bg2 border-r border-mk-bg3 text-xs">
          <div className="h-9 shrink-0 flex items-center justify-between pl-4 pr-2 border-b border-mk-bg3">
            <span className="text-[11px] uppercase tracking-widest text-mk-fg3 font-semibold">{panelTitle}</span>
            <button
              onClick={onClosePanel}
              className="p-1 rounded text-mk-fg3 hover:text-mk-fg hover:bg-mk-bg3 cursor-pointer"
              title={t("panel.close")}
            >
              <X size={14} />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">{panel}</div>
        </aside>
      )}
    </div>
  );
}
