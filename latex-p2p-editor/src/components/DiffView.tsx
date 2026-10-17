// Side view comparing a stored version with the current document.

import { useMemo } from "react";
import { RotateCcw, X } from "lucide-react";
import { useI18n } from "../i18n";
import type { SnapshotMeta } from "../services/tauriBridge";
import { diffStats, lineDiff, type DiffHunkLine } from "../services/textDiff";
import { formatSnapshotTime } from "./HistoryPanel";

interface DiffViewProps {
  snapshot: SnapshotMeta;
  snapshotText: string | null; // null while loading
  currentText: string;
  onRestore: () => void;
  onClose: () => void;
}

const CONTEXT = 3;

type Row = DiffHunkLine | { kind: "gap"; count: number };

/** Collapses long unchanged stretches, keeping `CONTEXT` lines around changes. */
export function collapseUnchanged(lines: DiffHunkLine[], context = CONTEXT): Row[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind !== "same") {
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
    }
  });
  const rows: Row[] = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap > 0) {
        rows.push({ kind: "gap", count: gap });
        gap = 0;
      }
      rows.push(l);
    } else {
      gap++;
    }
  });
  if (gap > 0) rows.push({ kind: "gap", count: gap });
  return rows;
}

export default function DiffView({ snapshot, snapshotText, currentText, onRestore, onClose }: DiffViewProps) {
  const { t, locale } = useI18n();
  const lines = useMemo(() => (snapshotText === null ? [] : lineDiff(currentText, snapshotText)), [snapshotText, currentText]);
  const stats = diffStats(lines);
  const rows = useMemo(() => collapseUnchanged(lines), [lines]);
  const identical = snapshotText !== null && stats.added === 0 && stats.removed === 0;

  return (
    <div className="h-full flex flex-col bg-mk-bg">
      <div className="h-8 shrink-0 flex items-center gap-3 px-3 border-b border-mk-bg3 bg-mk-bg2 text-[11px] select-none">
        <span className="text-mk-fg font-medium truncate">
          {t("history.diff.title", {
            label: snapshot.label ?? t("history.auto"),
            time: formatSnapshotTime(snapshot.created_at_ms, locale),
          })}
        </span>
        {snapshotText !== null && !identical && (
          <span className="font-mono text-mk-fg3">
            <span className="text-mk-green">+{stats.removed}</span> / <span className="text-mk-red">−{stats.added}</span>
          </span>
        )}
        <span className="flex-1" />
        <button
          onClick={onRestore}
          className="flex items-center gap-1 px-2 py-1 bg-mk-yellow hover:bg-mk-orange text-mk-bg2 font-semibold cursor-pointer"
        >
          <RotateCcw size={12} />
          {t("history.restore")}
        </button>
        <button onClick={onClose} className="p-1 text-mk-fg3 hover:text-mk-fg cursor-pointer" title={t("panel.close")}>
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto font-mono text-[12px] leading-5">
        {identical ? (
          <p className="px-4 py-3 text-mk-fg4">{t("history.diff.identical")}</p>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {rows.map((row, i) =>
                row.kind === "gap" ? (
                  <tr key={i} className="text-mk-fg4 bg-mk-bg2/60">
                    <td className="px-3 py-0.5 text-center select-none" colSpan={2}>
                      ⋯ {row.count}
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={i}
                    className={
                      // The diff is "current → snapshot": lines only in the snapshot
                      // (added) are what restoring would bring back.
                      row.kind === "added"
                        ? "bg-mk-green/15 text-mk-green"
                        : row.kind === "removed"
                          ? "bg-mk-red/15 text-mk-red"
                          : "text-mk-fg2"
                    }
                  >
                    <td className="w-6 px-2 text-center select-none text-mk-fg4">
                      {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""}
                    </td>
                    <td className="pr-3 whitespace-pre-wrap break-words">{row.text || " "}</td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
