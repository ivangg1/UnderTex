// Activity rail (left) + side panel. The rail only switches views — Files,
// Outline, History, Room — plus your profile and language at the bottom; the
// primary actions (Build, Share, Export) live in the top bar. One view is open
// at a time; clicking the active view (or ⌘B) collapses the panel.

import type { ReactNode } from "react";
import { Crown, FolderTree, History, Languages, ListTree, Monitor, Moon, Sun, Users, X } from "lucide-react";
import { useI18n, type MessageKey } from "../i18n";
import type { CollabMode, ConnectionStatus } from "../services/collabManager";
import type { CollabUser } from "../services/collabManager";
import { shortcutLabel } from "../services/shortcuts";
import { nextThemePref, setThemePref, useTheme } from "../services/theme";
import { connectionLabel } from "./ConnectionBadge";

export type PanelId = "files" | "outline" | "history" | "room" | "join" | "profile" | "new";

interface SidebarProps {
  mac: boolean;
  hasProject: boolean;
  mode: CollabMode;
  isHost: boolean;
  peerCount: number;
  connectionStatus: ConnectionStatus;
  currentUser: CollabUser;
  activePanel: PanelId | null;
  onTogglePanel: (panel: PanelId) => void;
  panel: ReactNode;
  panelTitle: string;
  /** Extra buttons in the panel header (e.g. new file / new folder). */
  panelActions?: ReactNode;
  onClosePanel: () => void;
}

interface RailButtonProps {
  icon: ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  badge?: ReactNode;
}

function RailButton({ icon, title, onClick, active, disabled, badge }: RailButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`relative w-full h-11 flex items-center justify-center cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        active ? "text-mk-fg" : "text-mk-fg4 hover:text-mk-fg2"
      }`}
    >
      {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 bg-mk-yellow" />}
      {icon}
      {badge}
    </button>
  );
}

export default function Sidebar({
  mac,
  hasProject,
  mode,
  isHost,
  peerCount,
  connectionStatus,
  currentUser,
  activePanel,
  onTogglePanel,
  panel,
  panelTitle,
  panelActions,
  onClosePanel,
}: SidebarProps) {
  const { t, locale } = useI18n();
  const conn = connectionLabel(connectionStatus, t);
  const [themePref] = useTheme();
  const icon = { size: 20, strokeWidth: 1.6 };

  return (
    <div className="flex h-full shrink-0">
      <nav className="w-12 shrink-0 flex flex-col bg-mk-bg2 border-r border-mk-bg3 select-none" aria-label={t("rail.views")}>
        <RailButton
          icon={<FolderTree {...icon} />}
          title={`${t("files.title")} (${shortcutLabel("viewFiles", mac)})`}
          onClick={() => onTogglePanel("files")}
          active={activePanel === "files"}
          disabled={!hasProject}
        />
        <RailButton
          icon={<ListTree {...icon} />}
          title={`${t("outline.title")} (${shortcutLabel("viewOutline", mac)})`}
          onClick={() => onTogglePanel("outline")}
          active={activePanel === "outline"}
          disabled={!hasProject}
        />
        <RailButton
          icon={<History {...icon} />}
          title={`${t("history.title")} (${shortcutLabel("viewHistory", mac)})`}
          onClick={() => onTogglePanel("history")}
          active={activePanel === "history"}
          disabled={!hasProject}
        />
        {mode === "collab" && (
          <RailButton
            icon={
              <span className={`relative ${isHost ? "text-mk-yellow" : "text-mk-blue"}`}>
                <Users {...icon} />
                <span className={`absolute -right-1 -top-0.5 w-2 h-2 rounded-full ring-2 ring-mk-bg2 ${conn.dot}`} />
              </span>
            }
            title={`${t("toolbar.room.tip")} · ${conn.text}`}
            onClick={() => onTogglePanel("room")}
            active={activePanel === "room"}
            badge={
              <span className="absolute right-1 bottom-1 flex items-center gap-0.5 text-[9px] font-mono text-mk-fg2">
                {isHost && <Crown size={8} className="text-mk-yellow" />}
                {peerCount}
              </span>
            }
          />
        )}

        <div className="flex-1" />

        <RailButton
          icon={
            <span
              className="w-6 h-6 rounded-full ring-1 ring-mk-bg4 flex items-center justify-center text-[11px] font-bold text-mk-bg2"
              style={{ backgroundColor: currentUser.color }}
            >
              {currentUser.name.charAt(0).toUpperCase()}
            </span>
          }
          title={t("toolbar.profile.tip")}
          onClick={() => onTogglePanel("profile")}
          active={activePanel === "profile"}
        />
        <RailButton
          icon={themePref === "dark" ? <Moon size={18} strokeWidth={1.6} /> : themePref === "light" ? <Sun size={18} strokeWidth={1.6} /> : <Monitor size={18} strokeWidth={1.6} />}
          title={t("theme.toggle", { theme: t(`theme.${themePref}` as MessageKey) })}
          onClick={() => setThemePref(nextThemePref(themePref))}
        />
        <RailButton
          icon={
            <span className="flex flex-col items-center text-[9px] font-semibold gap-0.5">
              <Languages size={16} strokeWidth={1.6} />
              {locale.toUpperCase()}
            </span>
          }
          title={t("toolbar.language")}
          onClick={() => onTogglePanel("profile")}
        />
      </nav>

      {activePanel && (
        <aside className="w-72 shrink-0 flex flex-col bg-mk-bg2 border-r border-mk-bg3 text-xs">
          <div className="h-9 shrink-0 flex items-center justify-between pl-4 pr-1.5 border-b border-mk-bg3">
            <span className="text-[11px] uppercase tracking-widest text-mk-fg3 font-semibold truncate">{panelTitle}</span>
            <div className="flex items-center gap-0.5">
              {panelActions}
              <button
                onClick={onClosePanel}
                className="p-1.5 rounded text-mk-fg3 hover:text-mk-fg hover:bg-mk-bg3 cursor-pointer"
                title={`${t("panel.close")} (${shortcutLabel("toggleSidebar", mac)})`}
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">{panel}</div>
        </aside>
      )}
    </div>
  );
}
