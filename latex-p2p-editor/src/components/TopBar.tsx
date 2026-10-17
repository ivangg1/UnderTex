// Top bar: where you are and what you do next.
// Left: project menu (new / open / join / recent / new window) and the root
// file. Right: the build options and the three primary actions — Build (with
// the auto-build switch), Share and Export. Live status lives in StatusBar.

import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  Cloud,
  Crown,
  Download,
  Feather,
  FilePlus,
  FolderOpen,
  Layers,
  Loader2,
  LogIn,
  AppWindow,
  Search,
  Share2,
  Users,
  Zap,
  ZapOff,
} from "lucide-react";
import { useI18n } from "../i18n";
import type { CollabMode, ConnectionStatus } from "../services/collabManager";
import type { CloudLocation } from "../services/tauriBridge";
import { cloudLabel, isCloud } from "../services/cloud";
import { chapterScope, scopeChapter, type BuildScope, type BuildSettings } from "../services/buildMode";
import { folderName, type RecentProject } from "../services/recents";
import { shortcutLabel } from "../services/shortcuts";
import { connectionLabel } from "./ConnectionBadge";

interface TopBarProps {
  mac: boolean;
  projectPath: string | null;
  cloud: CloudLocation | null;
  rootFile: string | null;
  recents: RecentProject[];
  mode: CollabMode;
  isHost: boolean;
  peerCount: number;
  connectionStatus: ConnectionStatus;
  isCompiling: boolean;
  autoCompile: boolean;
  compilerName: string | null;
  /** Chapters the root file `\include`s (the scope control is hidden without them). */
  chapters: string[];
  buildSettings: BuildSettings;
  canExport: boolean;
  onChangeScope: (scope: BuildScope) => void;
  onToggleDraft: () => void;
  onTogglePreamble: () => void;
  onToggleAuto: () => void;
  onExport: () => void;
  onShare: () => void;
  onOpenRoot: () => void;
  onQuickOpen: () => void;
  onNewProject: () => void;
  onOpenFolder: () => void;
  onJoin: () => void;
  onOpenRecent: (recent: RecentProject) => void;
  onNewWindow: () => void;
}

const SEP = "w-px self-stretch my-2 bg-mk-bg3";

export default function TopBar(props: TopBarProps) {
  const { t } = useI18n();
  const { projectPath, cloud, rootFile, mode, buildSettings, chapters, isCompiling, mac } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const conn = connectionLabel(props.connectionStatus, t);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menuOpen]);

  const scopeActive = chapters.length > 0 && buildSettings.scope !== "full";
  const picked = scopeChapter(buildSettings.scope);
  const scopeValue: BuildScope = picked !== null && !chapters.includes(picked) ? "full" : buildSettings.scope;
  const run = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };
  const menuItem = "w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-mk-fg2 hover:bg-mk-bg3 hover:text-mk-fg cursor-pointer";

  return (
    <header className="h-10 shrink-0 flex items-center gap-1 px-1.5 bg-mk-bg2 border-b border-mk-bg3 text-[11.5px] text-mk-fg3 select-none">
      {/* Project menu */}
      <div ref={menuRef} className="relative min-w-0">
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="flex items-center gap-1.5 h-7 px-2 rounded hover:bg-mk-bg3 cursor-pointer min-w-0"
          title={projectPath ? (cloud ? `${cloudLabel(cloud, t)}\n${projectPath}` : projectPath) : t("project.menu")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          {isCloud(cloud) ? <Cloud size={14} className="shrink-0 text-mk-blue" /> : <FolderOpen size={14} className="shrink-0 text-mk-yellow" />}
          <span className="text-mk-fg font-semibold truncate max-w-52">{projectPath ? folderName(projectPath) : t("app.name")}</span>
          <ChevronDown size={12} className="shrink-0" />
        </button>
        {menuOpen && (
          <div role="menu" className="absolute left-0 top-8 z-40 w-72 py-1 bg-mk-bg2 border border-mk-bg3 shadow-2xl text-xs">
            <button role="menuitem" className={menuItem} onClick={run(props.onNewProject)}>
              <FilePlus size={14} /> {t("new.title")}
            </button>
            <button role="menuitem" className={menuItem} onClick={run(props.onOpenFolder)}>
              <FolderOpen size={14} /> {t("project.openFolder")}
              <span className="ml-auto text-mk-fg4">{shortcutLabel("open", mac)}</span>
            </button>
            <button role="menuitem" className={menuItem} onClick={run(props.onJoin)}>
              <LogIn size={14} /> {t("join.title")}
            </button>
            <button role="menuitem" className={menuItem} onClick={run(props.onNewWindow)}>
              <AppWindow size={14} /> {t("profile.newWindow")}
            </button>
            {props.recents.length > 0 && (
              <>
                <div className="mx-3 my-1 border-t border-mk-bg3" />
                <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-widest text-mk-fg4">{t("welcome.recent")}</div>
                {props.recents.slice(0, 6).map((r) => (
                  <button key={r.path} role="menuitem" className={menuItem} onClick={run(() => props.onOpenRecent(r))} title={r.path}>
                    <FolderOpen size={13} className="text-mk-fg4" />
                    <span className="truncate">{folderName(r.path)}</span>
                    <span className="ml-auto text-mk-fg4 font-mono truncate max-w-28">{r.mainFile ?? ""}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Root file + quick open */}
      {projectPath && rootFile && (
        <>
          <button
            onClick={props.onOpenRoot}
            className="flex items-center gap-1 h-7 px-2 rounded hover:bg-mk-bg3 hover:text-mk-fg cursor-pointer min-w-0"
            title={t("topbar.root.tip")}
          >
            <Crown size={11} className="text-mk-yellow shrink-0" />
            <span className="font-mono truncate max-w-48">{rootFile}</span>
          </button>
          <button
            onClick={props.onQuickOpen}
            className="hidden md:flex items-center gap-2 h-7 ml-2 px-2.5 min-w-40 rounded border border-mk-bg3 bg-mk-bg/60 text-mk-fg4 hover:text-mk-fg2 hover:border-mk-bg4 cursor-pointer"
            title={t("quick.title")}
          >
            <Search size={12} />
            <span>{t("topbar.search")}</span>
            <span className="ml-auto font-mono text-[10px]">{shortcutLabel("quickOpen", mac)}</span>
          </button>
        </>
      )}

      <div className="flex-1" />

      {projectPath && (
        <>
          {/* Build options */}
          {chapters.length > 0 && (
            <label className={`flex items-center gap-1 h-7 px-2 rounded hover:bg-mk-bg3 ${scopeActive ? "text-mk-blue" : ""}`} title={t("build.scope.tip")}>
              <BookOpen size={12} className="shrink-0" />
              <select
                value={scopeValue}
                onChange={(e) => props.onChangeScope(e.target.value as BuildScope)}
                disabled={isCompiling}
                className="bg-transparent text-[11px] focus:outline-none cursor-pointer disabled:cursor-not-allowed max-w-40 truncate"
              >
                <option value="full">{t("build.scope.full")}</option>
                <option value="cursor">{t("build.scope.cursor")}</option>
                {chapters.map((c) => (
                  <option key={c} value={chapterScope(c)}>
                    {t("build.scope.chapter", { name: c })}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            onClick={props.onToggleDraft}
            className={`flex items-center gap-1 h-7 px-2 rounded cursor-pointer hover:bg-mk-bg3 hover:text-mk-fg ${buildSettings.draft ? "text-mk-orange" : ""}`}
            title={buildSettings.draft ? t("build.draft.on") : t("build.draft.off")}
            aria-pressed={buildSettings.draft}
          >
            <Feather size={12} />
            {t("build.draft")}
          </button>
          {props.compilerName === "pdflatex" && (
            <button
              onClick={props.onTogglePreamble}
              className={`flex items-center gap-1 h-7 px-2 rounded cursor-pointer hover:bg-mk-bg3 hover:text-mk-fg ${buildSettings.precompiledPreamble ? "text-mk-green" : ""}`}
              title={buildSettings.precompiledPreamble ? t("build.preamble.on") : t("build.preamble.off")}
              aria-pressed={buildSettings.precompiledPreamble}
            >
              <Layers size={12} />
              {t("build.preamble")}
            </button>
          )}

          <span className={SEP} />

          {/* Auto / manual build (building itself is Recompile in the preview, or ⌘S) */}
          <button
            onClick={props.onToggleAuto}
            className={`flex items-center gap-1.5 h-7 px-2.5 rounded border cursor-pointer ${
              props.autoCompile
                ? "border-mk-green/60 bg-mk-green/15 text-mk-green hover:bg-mk-green/25"
                : "border-mk-bg4 text-mk-fg3 hover:text-mk-fg hover:bg-mk-bg3"
            }`}
            title={props.autoCompile ? t("rail.auto.on") : t("rail.auto.off")}
            aria-pressed={props.autoCompile}
          >
            {isCompiling ? (
              <Loader2 size={13} className="animate-spin" />
            ) : props.autoCompile ? (
              <Zap size={13} fill="currentColor" />
            ) : (
              <ZapOff size={13} />
            )}
            {props.autoCompile ? t("topbar.autoBuild") : t("topbar.manualBuild")}
          </button>

          {/* Primary: Share / Room */}
          {mode === "collab" ? (
            <button
              onClick={props.onShare}
              className={`flex items-center gap-1.5 h-7 px-2.5 rounded border cursor-pointer hover:bg-mk-bg3 ${
                props.isHost ? "border-mk-yellow/50 text-mk-yellow" : "border-mk-blue/50 text-mk-blue"
              }`}
              title={`${t("toolbar.room.tip")}\n${conn.text}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${conn.dot}`} />
              <Users size={13} />
              {t("rail.room")} · {props.peerCount}
            </button>
          ) : (
            <button
              onClick={props.onShare}
              disabled={isCompiling}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded border border-mk-blue/50 text-mk-blue hover:bg-mk-blue/10 cursor-pointer disabled:opacity-50"
              title={t("toolbar.collaborate.tip")}
            >
              <Share2 size={13} />
              {t("rail.share")}
            </button>
          )}

          {/* Primary: Export */}
          <button
            onClick={props.onExport}
            disabled={!props.canExport}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded border border-mk-bg4 text-mk-fg2 hover:text-mk-fg hover:bg-mk-bg3 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title={`${t("preview.export.tip")} (${shortcutLabel("export", mac)})`}
          >
            <Download size={13} />
            {t("rail.export")}
          </button>
        </>
      )}
    </header>
  );
}
