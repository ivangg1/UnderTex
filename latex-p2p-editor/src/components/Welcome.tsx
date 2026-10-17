// Welcome view (no project open): start actions, recent projects, how it works.

import { AlertTriangle, FilePlus, FolderOpen, LogIn, X } from "lucide-react";
import { useI18n } from "../i18n";
import { folderName, type RecentProject } from "../services/recents";

interface WelcomeProps {
  recents: RecentProject[];
  compilerMissing: boolean;
  compilerHint: string | null;
  onOpenFolder: () => void;
  onNew: () => void;
  onJoin: () => void;
  onOpenRecent: (project: RecentProject) => void;
  onRemoveRecent: (path: string) => void;
}

const HEADING = "text-[10px] uppercase tracking-widest text-mk-fg4 font-semibold mb-3";

export default function Welcome({
  recents,
  compilerMissing,
  compilerHint,
  onOpenFolder,
  onNew,
  onJoin,
  onOpenRecent,
  onRemoveRecent,
}: WelcomeProps) {
  const { t } = useI18n();

  return (
    <div className="h-full overflow-auto bg-mk-bg">
      <div className="max-w-3xl mx-auto px-10 py-14 select-none">
        <div className="mb-10">
          <h1 className="text-2xl font-semibold text-mk-fg tracking-tight">{t("app.name")}</h1>
          <p className="text-sm text-mk-fg3 mt-1">{t("app.tagline")}</p>
        </div>

        {compilerMissing && (
          <div className="flex gap-3 mb-8 px-3 py-2.5 border-l-2 border-mk-red bg-mk-red/10 text-xs text-mk-fg2">
            <AlertTriangle size={15} className="shrink-0 mt-0.5 text-mk-red" />
            <div>
              <p className="font-medium text-mk-fg">{t("empty.compilerMissing")}</p>
              {compilerHint && <p className="mt-1 text-mk-fg3 whitespace-pre-wrap leading-relaxed">{compilerHint}</p>}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-12">
          {/* Start */}
          <section>
            <h2 className={HEADING}>{t("welcome.start")}</h2>
            <ul className="flex flex-col gap-1 text-sm">
              <li>
                <button
                  onClick={onNew}
                  className="w-full flex items-center gap-2.5 px-2 py-1.5 -mx-2 text-mk-blue hover:bg-mk-bg3/60 cursor-pointer"
                >
                  <FilePlus size={15} />
                  <span>{t("new.title")}</span>
                </button>
              </li>
              <li>
                <button
                  onClick={onOpenFolder}
                  className="group w-full flex items-center gap-2.5 px-2 py-1.5 -mx-2 text-mk-blue hover:bg-mk-bg3/60 cursor-pointer"
                >
                  <FolderOpen size={15} />
                  <span>{t("empty.open")}</span>
                  <kbd className="ml-auto font-mono text-[10px] text-mk-fg4 group-hover:text-mk-fg3">{t("welcome.shortcut.open")}</kbd>
                </button>
              </li>
              <li>
                <button
                  onClick={onJoin}
                  className="w-full flex items-center gap-2.5 px-2 py-1.5 -mx-2 text-mk-blue hover:bg-mk-bg3/60 cursor-pointer"
                >
                  <LogIn size={15} />
                  <span>{t("empty.join")}</span>
                </button>
              </li>
            </ul>

            <h2 className={`${HEADING} mt-10`}>{t("welcome.how")}</h2>
            <ol className="flex flex-col gap-2.5 text-xs text-mk-fg3 leading-relaxed">
              {[t("welcome.how1"), t("welcome.how2"), t("welcome.how3")].map((text, i) => (
                <li key={i} className="flex gap-3">
                  <span className="font-mono text-mk-yellow">{i + 1}</span>
                  <span>{text}</span>
                </li>
              ))}
            </ol>
          </section>

          {/* Recent */}
          <section>
            <h2 className={HEADING}>{t("welcome.recent")}</h2>
            {recents.length === 0 ? (
              <p className="text-xs text-mk-fg4">{t("welcome.noRecent")}</p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-sm">
                {recents.map((r) => (
                  <li key={r.path} className="group flex items-center -mx-2">
                    <button
                      onClick={() => onOpenRecent(r)}
                      className="flex-1 min-w-0 flex items-baseline gap-2 px-2 py-1.5 text-left hover:bg-mk-bg3/60 cursor-pointer"
                      title={r.path}
                    >
                      <span className="text-mk-blue truncate">{folderName(r.path)}</span>
                      <span className="text-[11px] font-mono text-mk-fg4 truncate">{r.mainFile}</span>
                    </button>
                    <button
                      onClick={() => onRemoveRecent(r.path)}
                      className="px-2 py-1.5 text-mk-fg4 hover:text-mk-red opacity-0 group-hover:opacity-100 cursor-pointer"
                      title={t("welcome.remove")}
                    >
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
