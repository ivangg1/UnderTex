// Version history panel: save a named version, browse snapshots, compare/restore.

import { useState, type FormEvent } from "react";
import { Bookmark, Clock, RotateCcw, Trash2, Tag } from "lucide-react";
import { useI18n } from "../i18n";
import type { SnapshotMeta } from "../services/tauriBridge";

interface HistoryPanelProps {
  snapshots: SnapshotMeta[];
  selectedId: string | null;
  onSaveVersion: (label: string) => void;
  onSelect: (snapshot: SnapshotMeta | null) => void;
  onRestore: (snapshot: SnapshotMeta) => void;
  onDelete: (snapshot: SnapshotMeta) => void;
}

const LABEL = "text-[10px] uppercase tracking-widest text-mk-fg4 font-semibold";

export function formatSnapshotTime(ts: number, locale: string): string {
  return new Date(ts).toLocaleString(locale === "es" ? "es-ES" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayKey(ts: number): string {
  return new Date(ts).toDateString();
}

export default function HistoryPanel({ snapshots, selectedId, onSaveVersion, onSelect, onRestore, onDelete }: HistoryPanelProps) {
  const { t, locale } = useI18n();
  const [label, setLabel] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSaveVersion(label.trim());
    setLabel("");
  };

  let lastDay = "";

  return (
    <div className="flex flex-col h-full">
      <form onSubmit={submit} className="px-4 py-3 border-b border-mk-bg3 flex flex-col gap-2">
        <span className={LABEL}>{t("history.saveVersion")}</span>
        <div className="flex gap-1">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("history.label.placeholder")}
            maxLength={80}
            className="flex-1 min-w-0 bg-mk-bg border border-mk-bg3 focus:border-mk-yellow px-2 py-1.5 text-mk-fg focus:outline-none"
          />
          <button
            type="submit"
            className="px-2.5 py-1.5 bg-mk-yellow hover:bg-mk-orange text-mk-bg2 font-semibold cursor-pointer transition-colors"
            title={t("history.saveVersion")}
          >
            <Bookmark size={13} />
          </button>
        </div>
        <p className="text-[10px] text-mk-fg4 leading-relaxed">{t("history.help")}</p>
      </form>

      <ul className="flex-1 min-h-0 overflow-auto">
        {snapshots.length === 0 && <li className="px-4 py-3 text-mk-fg4">{t("history.empty")}</li>}
        {snapshots.map((snap) => {
          const day = dayKey(snap.created_at_ms);
          const showDay = day !== lastDay;
          lastDay = day;
          const selected = snap.id === selectedId;
          return (
            <li key={snap.id}>
              {showDay && (
                <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-mk-fg4 font-semibold">
                  {new Date(snap.created_at_ms).toLocaleDateString(locale === "es" ? "es-ES" : "en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                </div>
              )}
              <div
                className={`group flex items-center gap-2 px-4 py-1.5 cursor-pointer border-l-2 ${
                  selected ? "border-mk-yellow bg-mk-bg" : "border-transparent hover:bg-mk-bg/60"
                }`}
                onClick={() => onSelect(selected ? null : snap)}
                title={t("history.compare")}
              >
                {snap.kind === "manual" ? (
                  <Tag size={12} className="shrink-0 text-mk-yellow" />
                ) : (
                  <Clock size={12} className="shrink-0 text-mk-fg4" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className={`truncate ${snap.kind === "manual" ? "text-mk-fg font-medium" : "text-mk-fg2"}`}>
                      {snap.label ?? t("history.auto")}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-mk-fg4">
                      {new Date(snap.created_at_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <div className="text-[10px] text-mk-fg4 truncate">
                    {snap.author ? `${snap.author} · ` : ""}
                    {t("history.bytes", { kb: (snap.bytes / 1024).toFixed(1) })}
                  </div>
                </div>
                <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRestore(snap);
                    }}
                    className="p-1 text-mk-fg3 hover:text-mk-green cursor-pointer"
                    title={t("history.restore")}
                  >
                    <RotateCcw size={12} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(snap);
                    }}
                    className="p-1 text-mk-fg3 hover:text-mk-red cursor-pointer"
                    title={t("history.delete")}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
