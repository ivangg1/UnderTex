// Outline of the open file: its sections (click to jump) and the files it
// \input / \include (click to open). The heading the cursor is in is marked.

import { CornerDownRight, ListTree } from "lucide-react";
import { useI18n } from "../i18n";
import { currentOutlineIndex, type OutlineItem } from "../services/outline";

interface OutlinePanelProps {
  file: string | null;
  items: OutlineItem[];
  cursorLine: number;
  /** Project files, to tell an \input that exists from one that does not. */
  knownFiles: Set<string>;
  onGoToLine: (line: number) => void;
  onOpenFile: (path: string) => void;
}

export default function OutlinePanel({ file, items, cursorLine, knownFiles, onGoToLine, onOpenFile }: OutlinePanelProps) {
  const { t } = useI18n();
  if (!file) return <div className="p-4 text-mk-fg4 italic">{t("outline.noFile")}</div>;
  if (items.length === 0) return <div className="p-4 text-mk-fg4 italic">{t("outline.empty")}</div>;
  const current = currentOutlineIndex(items, cursorLine);
  const minLevel = Math.min(...items.filter((i) => i.kind !== "input").map((i) => i.level), 2);

  return (
    <nav aria-label={t("outline.title")} className="py-1">
      {items.map((item, i) => {
        const indent = Math.max(0, item.level - minLevel) * 12 + 10;
        if (item.kind === "input") {
          const exists = item.target ? knownFiles.has(item.target) : false;
          return (
            <button
              key={`${item.line}-${i}`}
              onClick={() => (exists && item.target ? onOpenFile(item.target) : onGoToLine(item.line))}
              className="w-full flex items-center gap-1.5 py-1 pr-2 text-left text-mk-fg3 hover:text-mk-fg hover:bg-mk-bg3/60 cursor-pointer"
              style={{ paddingLeft: `${indent}px` }}
              title={exists ? t("outline.openInput", { file: item.target ?? "" }) : t("outline.missingInput", { file: item.target ?? item.title })}
            >
              <CornerDownRight size={12} className={exists ? "text-mk-blue shrink-0" : "text-mk-red shrink-0"} />
              <span className="font-mono text-[11px] truncate">{item.title}</span>
            </button>
          );
        }
        const isCurrent = i === current;
        return (
          <button
            key={`${item.line}-${i}`}
            onClick={() => onGoToLine(item.line)}
            className={`relative w-full flex items-center gap-1.5 py-1 pr-2 text-left cursor-pointer ${
              isCurrent ? "bg-mk-bg text-mk-fg" : "text-mk-fg2 hover:text-mk-fg hover:bg-mk-bg3/60"
            } ${item.level <= 1 ? "font-semibold" : ""}`}
            style={{ paddingLeft: `${indent}px` }}
            title={`${item.kind}${item.starred ? "*" : ""} · ${t("outline.line", { line: item.line })}`}
          >
            {isCurrent && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-mk-yellow" />}
            <ListTree size={12} className={`shrink-0 ${item.level <= 1 ? "text-mk-yellow" : "text-mk-purple"}`} />
            <span className="truncate">{item.title}</span>
            <span className="ml-auto text-[10px] text-mk-fg4 font-mono">{item.line}</span>
          </button>
        );
      })}
    </nav>
  );
}
