// Join panel: paste a room ID shared by a teammate.

import { useState, type FormEvent } from "react";
import { LogIn } from "lucide-react";
import { useI18n } from "../i18n";

interface JoinPanelProps {
  onJoin: (roomId: string) => void;
}

export default function JoinPanel({ onJoin }: JoinPanelProps) {
  const { t } = useI18n();
  const [value, setValue] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = value.trim();
    if (!id) return;
    setValue("");
    onJoin(id);
  };

  return (
    <form onSubmit={submit} className="px-4 py-3 flex flex-col gap-3">
      <p className="text-[11px] text-mk-fg3 leading-relaxed">{t("join.help.cloud")}</p>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("join.placeholder")}
        spellCheck={false}
        className="w-full bg-mk-bg border border-mk-bg3 focus:border-mk-yellow px-2 py-1.5 font-mono text-[11px] text-mk-fg focus:outline-none"
      />
      <button
        type="submit"
        disabled={!value.trim()}
        className="flex items-center justify-center gap-1.5 px-2 py-1.5 bg-mk-yellow hover:bg-mk-orange disabled:opacity-40 text-mk-bg2 font-semibold cursor-pointer transition-colors"
      >
        <LogIn size={13} />
        {t("join.submit")}
      </button>
    </form>
  );
}
