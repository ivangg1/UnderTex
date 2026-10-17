// New project panel: name, template and parent folder.

import { useState, type FormEvent } from "react";
import { FolderOpen, FilePlus } from "lucide-react";
import { useI18n } from "../i18n";
import { TEMPLATES } from "../services/templates";
import { folderName } from "../services/recents";

interface NewProjectPanelProps {
  defaultParent: string | null;
  onPickParent: () => Promise<string | null>;
  onCreate: (parentDir: string, name: string, templateId: string) => void;
}

const SECTION = "px-4 py-3 border-b border-mk-bg3 flex flex-col gap-2";
const LABEL = "text-[10px] uppercase tracking-widest text-mk-fg4 font-semibold";
const INPUT = "w-full bg-mk-bg border border-mk-bg3 focus:border-mk-yellow px-2 py-1.5 text-mk-fg focus:outline-none";

export default function NewProjectPanel({ defaultParent, onPickParent, onCreate }: NewProjectPanelProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(TEMPLATES[1]?.id ?? TEMPLATES[0].id);
  const [parent, setParent] = useState<string | null>(defaultParent);

  const canCreate = name.trim().length > 0 && parent !== null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canCreate || !parent) return;
    onCreate(parent, name.trim(), templateId);
  };

  return (
    <form onSubmit={submit} className="flex flex-col">
      <div className={SECTION}>
        <span className={LABEL}>{t("new.name")}</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("new.name.placeholder")}
          spellCheck={false}
          className={INPUT}
          maxLength={120}
        />
      </div>

      <div className={SECTION}>
        <span className={LABEL}>{t("new.template")}</span>
        <ul className="flex flex-col gap-1">
          {TEMPLATES.map((tpl) => (
            <li key={tpl.id}>
              <button
                type="button"
                onClick={() => setTemplateId(tpl.id)}
                className={`w-full text-left px-2 py-1.5 border cursor-pointer transition-colors ${
                  templateId === tpl.id
                    ? "border-mk-yellow bg-mk-bg text-mk-fg"
                    : "border-mk-bg3 bg-mk-bg/40 text-mk-fg2 hover:border-mk-fg4"
                }`}
              >
                <span className="block font-medium">{t(tpl.nameKey)}</span>
                <span className="block text-[10px] text-mk-fg3 leading-snug">{t(tpl.descriptionKey)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className={SECTION}>
        <span className={LABEL}>{t("new.location")}</span>
        <button
          type="button"
          onClick={() => void onPickParent().then((p) => p && setParent(p))}
          className="flex items-center gap-2 px-2 py-1.5 bg-mk-bg border border-mk-bg3 hover:border-mk-fg4 text-left cursor-pointer"
          title={parent ?? undefined}
        >
          <FolderOpen size={13} className="shrink-0 text-mk-fg3" />
          <span className={`truncate ${parent ? "text-mk-fg" : "text-mk-fg4"}`}>
            {parent ? folderName(parent) : t("new.location.pick")}
          </span>
        </button>
        {parent && <p className="text-[10px] text-mk-fg4 truncate" title={parent}>{parent}</p>}
        <p className="text-[10px] text-mk-fg4">{t("new.location.help")}</p>
      </div>

      <div className="px-4 py-3">
        <button
          type="submit"
          disabled={!canCreate}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 bg-mk-yellow hover:bg-mk-orange disabled:opacity-40 text-mk-bg2 font-semibold cursor-pointer transition-colors"
        >
          <FilePlus size={13} />
          {t("new.create")}
        </button>
      </div>
    </form>
  );
}
