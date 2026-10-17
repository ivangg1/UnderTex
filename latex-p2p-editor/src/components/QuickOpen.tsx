// Command palette for navigation: fuzzy file search (⌘P), "@" for the sections
// of the open file (⌘⇧O) and ":" for a line number (⌃G).

import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, ListTree } from "lucide-react";
import { useI18n } from "../i18n";
import { rankFiles } from "../services/projectFiles";
import type { OutlineItem } from "../services/outline";
import { getFileIcon } from "./FileTree";

export type QuickOpenMode = "files" | "symbols" | "line";

interface QuickOpenProps {
  initialMode: QuickOpenMode;
  files: string[];
  /** Recently used files first when the query is empty. */
  recent: string[];
  outline: OutlineItem[];
  onOpenFile: (path: string) => void;
  onGoToLine: (line: number) => void;
  onClose: () => void;
}

type Entry =
  | { kind: "file"; path: string }
  | { kind: "symbol"; item: OutlineItem }
  | { kind: "line"; line: number };

const PREFIX: Record<QuickOpenMode, string> = { files: "", symbols: "@", line: ":" };

export default function QuickOpen({ initialMode, files, recent, outline, onOpenFile, onGoToLine, onClose }: QuickOpenProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState(PREFIX[initialMode]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const entries: Entry[] = useMemo(() => {
    if (query.startsWith(":")) {
      const n = Number.parseInt(query.slice(1), 10);
      return Number.isFinite(n) && n > 0 ? [{ kind: "line", line: n }] : [];
    }
    if (query.startsWith("@")) {
      const q = query.slice(1).trim().toLowerCase();
      return outline
        .filter((i) => i.kind !== "input" && (!q || i.title.toLowerCase().includes(q)))
        .map((item) => ({ kind: "symbol", item }));
    }
    const ordered = [...recent.filter((p) => files.includes(p)), ...files.filter((p) => !recent.includes(p))];
    return rankFiles(query, query.trim() ? files : ordered, 60).map((path) => ({ kind: "file", path }));
  }, [query, files, recent, outline]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    if (entry.kind === "file") onOpenFile(entry.path);
    else if (entry.kind === "symbol") onGoToLine(entry.item.line);
    else onGoToLine(entry.line);
  };

  const placeholder = query.startsWith("@")
    ? t("quick.symbols.placeholder")
    : query.startsWith(":")
      ? t("quick.line.placeholder")
      : t("quick.files.placeholder");

  return (
    <div className="fixed inset-0 z-50 flex justify-center pt-[12vh] bg-black/40" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={t("quick.title")}
        className="w-[min(560px,90vw)] max-h-[60vh] flex flex-col bg-mk-bg2 border border-mk-bg3 shadow-2xl text-xs"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(entries.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(entries[index]);
            }
          }}
          className="h-10 px-3 bg-mk-bg text-mk-fg font-mono text-[12.5px] outline-none border-b border-mk-bg3 placeholder:text-mk-fg4"
        />
        <div ref={listRef} className="overflow-y-auto py-1">
          {entries.length === 0 && <div className="px-3 py-2 text-mk-fg4">{t("quick.empty")}</div>}
          {entries.map((entry, i) => {
            const selected = i === index;
            const cls = `flex items-center gap-2 px-3 py-1.5 cursor-pointer ${selected ? "bg-mk-bg3 text-mk-fg" : "text-mk-fg2 hover:bg-mk-bg3/60"}`;
            if (entry.kind === "file") {
              const name = entry.path.split("/").pop() ?? entry.path;
              const dir = entry.path.slice(0, Math.max(0, entry.path.length - name.length - 1));
              return (
                <div key={entry.path} data-index={i} className={cls} onMouseEnter={() => setIndex(i)} onClick={() => choose(entry)}>
                  {getFileIcon(name)}
                  <span className="font-mono">{name}</span>
                  <span className="text-mk-fg4 font-mono truncate">{dir}</span>
                </div>
              );
            }
            if (entry.kind === "symbol") {
              const { item } = entry;
              return (
                <div key={`${item.line}-${item.title}`} data-index={i} className={cls} onMouseEnter={() => setIndex(i)} onClick={() => choose(entry)}>
                  <ListTree size={13} className="text-mk-purple shrink-0" />
                  <span style={{ paddingLeft: `${Math.max(0, item.level - 1) * 10}px` }}>{item.title}</span>
                  <span className="ml-auto text-mk-fg4 font-mono">{item.kind} · {item.line}</span>
                </div>
              );
            }
            return (
              <div key="line" data-index={i} className={cls} onClick={() => choose(entry)}>
                <Hash size={13} className="text-mk-blue shrink-0" />
                {t("quick.line.go", { line: entry.line })}
              </div>
            );
          })}
        </div>
        <div className="px-3 py-1.5 border-t border-mk-bg3 text-[10.5px] text-mk-fg4">{t("quick.hint")}</div>
      </div>
    </div>
  );
}
