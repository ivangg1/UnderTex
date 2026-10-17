// Profile panel: identity (name, cursor color), language, custom signaling
// server and the extra-window helper.

import { useEffect, useState } from "react";
import { Check, PlusSquare } from "lucide-react";
import { LOCALES, useI18n } from "../i18n";
import { SIGNALING_OVERRIDE_KEY, type CollabUser } from "../services/collabManager";

export const PRESET_COLORS = [
  "#ff6188", // red
  "#fc9867", // orange
  "#ffd866", // yellow
  "#a9dc76", // green
  "#78dce8", // blue
  "#ab9df2", // purple
  "#f8f8f2", // white
  "#c1c0c0", // gray
];

interface ProfilePanelProps {
  currentUser: CollabUser;
  onUserChange: (user: CollabUser) => void;
  onNewWindow: () => void;
}

const SECTION = "px-4 py-3 border-b border-mk-bg3 flex flex-col gap-2";
const LABEL = "text-[10px] uppercase tracking-widest text-mk-fg4 font-semibold";
const INPUT = "w-full bg-mk-bg border border-mk-bg3 focus:border-mk-yellow px-2 py-1.5 text-mk-fg focus:outline-none";

export default function ProfilePanel({ currentUser, onUserChange, onNewWindow }: ProfilePanelProps) {
  const { t, locale, setLocale } = useI18n();
  const [name, setName] = useState(currentUser.name);
  const [signaling, setSignaling] = useState(() => {
    try {
      return localStorage.getItem(SIGNALING_OVERRIDE_KEY) ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => setName(currentUser.name), [currentUser.name]);

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== currentUser.name) onUserChange({ ...currentUser, name: trimmed });
    else setName(currentUser.name);
  };

  const commitSignaling = () => {
    try {
      const value = signaling.trim();
      if (value) localStorage.setItem(SIGNALING_OVERRIDE_KEY, value);
      else localStorage.removeItem(SIGNALING_OVERRIDE_KEY);
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex flex-col">
      <div className={SECTION}>
        <span className={LABEL}>{t("profile.name")}</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => e.key === "Enter" && commitName()}
          className={INPUT}
          placeholder={t("profile.name.placeholder")}
          maxLength={24}
        />
        <span className={`${LABEL} mt-1`}>{t("profile.color")}</span>
        <div className="flex gap-1.5">
          {PRESET_COLORS.map((color) => (
            <button
              key={color}
              onClick={() => onUserChange({ ...currentUser, color })}
              className={`w-6 h-6 cursor-pointer flex items-center justify-center transition-transform hover:scale-110 ${
                currentUser.color === color ? "ring-2 ring-mk-fg" : "opacity-80 hover:opacity-100"
              }`}
              style={{ backgroundColor: color }}
              title={color}
            >
              {currentUser.color === color && <Check size={12} className="text-mk-bg2" />}
            </button>
          ))}
        </div>
      </div>

      <div className={SECTION}>
        <span className={LABEL}>{t("toolbar.language")}</span>
        <div className="flex">
          {LOCALES.map((l) => (
            <button
              key={l.code}
              onClick={() => setLocale(l.code)}
              className={`flex-1 px-2 py-1.5 border border-mk-bg3 cursor-pointer transition-colors ${
                locale === l.code ? "bg-mk-bg3 text-mk-fg" : "bg-mk-bg text-mk-fg3 hover:text-mk-fg"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className={SECTION}>
        <span className={LABEL}>{t("profile.signaling")}</span>
        <input
          type="text"
          value={signaling}
          onChange={(e) => setSignaling(e.target.value)}
          onBlur={commitSignaling}
          spellCheck={false}
          className={`${INPUT} font-mono text-[11px]`}
          placeholder="wss://my-server:4444"
        />
        <p className="text-[10px] text-mk-fg4">{t("profile.signaling.help")}</p>
      </div>

      <div className="px-4 py-3">
        <button
          onClick={onNewWindow}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 bg-mk-bg border border-mk-bg3 hover:border-mk-fg4 text-mk-fg2 hover:text-mk-fg cursor-pointer transition-colors"
          title={t("profile.newWindow.tip")}
        >
          <PlusSquare size={13} />
          {t("profile.newWindow")}
        </button>
      </div>
    </div>
  );
}
