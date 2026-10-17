// Tabs of the open project files, above the editor. Each tab shows who else in
// the room has that file open (colored dots), the root file mark, and closes
// with × or a middle click.

import { Crown, X } from "lucide-react";
import { useI18n } from "../i18n";
import type { PeerInfo } from "../services/collabManager";
import { getFileIcon } from "./FileTree";

interface EditorTabsProps {
  tabs: string[];
  active: string | null;
  rootFile: string | null;
  peers: PeerInfo[];
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

const baseName = (path: string) => path.split("/").pop() ?? path;

export default function EditorTabs({ tabs, active, rootFile, peers, onSelect, onClose }: EditorTabsProps) {
  const { t } = useI18n();
  if (tabs.length === 0) return null;
  // Same file name in two folders: show the folder too.
  const counts = new Map<string, number>();
  tabs.forEach((p) => counts.set(baseName(p), (counts.get(baseName(p)) ?? 0) + 1));

  return (
    <div role="tablist" className="h-8 shrink-0 flex items-stretch bg-mk-bg2 border-b border-mk-bg3 overflow-x-auto overflow-y-hidden select-none">
      {tabs.map((path) => {
        const isActive = path === active;
        const name = baseName(path);
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const here = peers.filter((p) => !p.isSelf && p.file === path);
        return (
          <div
            key={path}
            role="tab"
            aria-selected={isActive}
            title={path}
            onClick={() => onSelect(path)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(path);
              }
            }}
            className={`group relative flex items-center gap-1.5 pl-3 pr-1.5 text-[11.5px] border-r border-mk-bg3 cursor-pointer whitespace-nowrap ${
              isActive ? "bg-mk-bg text-mk-fg" : "text-mk-fg3 hover:text-mk-fg2 hover:bg-mk-bg/50"
            }`}
          >
            {isActive && <span className="absolute left-0 right-0 top-0 h-0.5 bg-mk-yellow" />}
            {getFileIcon(name)}
            <span className="font-mono">{name}</span>
            {dir && (counts.get(name) ?? 0) > 1 && <span className="text-mk-fg4 font-mono">{dir}</span>}
            {path === rootFile && (
              <span title={t("files.mainBadge")}>
                <Crown size={10} className="text-mk-yellow" />
              </span>
            )}
            {here.length > 0 && (
              <span className="flex -space-x-0.5" title={here.map((p) => p.name).join(", ")}>
                {here.slice(0, 3).map((p) => (
                  <span key={p.clientID} className="w-1.5 h-1.5 rounded-full ring-1 ring-mk-bg2" style={{ backgroundColor: p.color }} />
                ))}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
              }}
              className={`p-0.5 rounded hover:bg-mk-bg3 hover:text-mk-fg cursor-pointer ${isActive ? "text-mk-fg3" : "text-transparent group-hover:text-mk-fg3"}`}
              title={t("tabs.close")}
              aria-label={t("tabs.close")}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
