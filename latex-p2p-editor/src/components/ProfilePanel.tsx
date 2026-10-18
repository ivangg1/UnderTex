// Profile panel: identity (name, cursor color), language, custom signaling
// server, optional TURN relay and the extra-window helper.

import { useEffect, useState } from "react";
import { Check, Download, Loader2, Monitor, Moon, PlusSquare, RefreshCw, Sun } from "lucide-react";
import type { UpdateState } from "../services/updater";
import { LOCALES, useI18n } from "../i18n";
import { setThemePref, useTheme, type ThemePref } from "../services/theme";
import {
  SIGNALING_OVERRIDE_KEY,
  TURN_OVERRIDE_KEY,
  parseTurnConfig,
  readTurnOverride,
  type CollabUser,
  type TurnConfig,
} from "../services/collabManager";

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
  /** Installed app version (null while loading or in a browser preview). */
  appVersion: string | null;
  updateState: UpdateState;
  onCheckUpdates: () => void;
  onInstallUpdate: () => void;
}

const SECTION = "px-4 py-3 border-b border-mk-bg3 flex flex-col gap-2";
const LABEL = "text-[10px] uppercase tracking-widest text-mk-fg4 font-semibold";
const INPUT = "w-full bg-mk-bg border border-mk-bg3 focus:border-mk-yellow px-2 py-1.5 text-mk-fg focus:outline-none";

export default function ProfilePanel({
  currentUser,
  onUserChange,
  onNewWindow,
  appVersion,
  updateState,
  onCheckUpdates,
  onInstallUpdate,
}: ProfilePanelProps) {
  const { t, locale, setLocale } = useI18n();
  const [themePref] = useTheme();
  const [name, setName] = useState(currentUser.name);
  const [signaling, setSignaling] = useState(() => {
    try {
      return localStorage.getItem(SIGNALING_OVERRIDE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [turn, setTurn] = useState<TurnConfig>(
    () => readTurnOverride() ?? { url: "", username: "", credential: "" }
  );

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

  /** Persists the TURN entry when it has a valid turn:/turns: URL, clears it otherwise. */
  const commitTurn = () => {
    try {
      const parsed = parseTurnConfig(turn);
      if (parsed) localStorage.setItem(TURN_OVERRIDE_KEY, JSON.stringify(parsed));
      else localStorage.removeItem(TURN_OVERRIDE_KEY);
    } catch {
      // ignore
    }
  };
  const turnInvalid = turn.url.trim() !== "" && parseTurnConfig(turn) === null;

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
        <span className={LABEL}>{t("theme.title")}</span>
        <div className="flex">
          {(
            [
              ["system", <Monitor size={13} key="s" />],
              ["dark", <Moon size={13} key="d" />],
              ["light", <Sun size={13} key="l" />],
            ] as [ThemePref, React.ReactNode][]
          ).map(([value, icon]) => (
            <button
              key={value}
              onClick={() => setThemePref(value)}
              aria-pressed={themePref === value}
              className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 border border-mk-bg3 cursor-pointer transition-colors ${
                themePref === value ? "bg-mk-bg3 text-mk-fg" : "bg-mk-bg text-mk-fg3 hover:text-mk-fg"
              }`}
            >
              {icon}
              {t(`theme.${value}`)}
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

      <div className={SECTION}>
        <span className={LABEL}>{t("profile.turn")}</span>
        <input
          type="text"
          value={turn.url}
          onChange={(e) => setTurn({ ...turn, url: e.target.value })}
          onBlur={commitTurn}
          spellCheck={false}
          className={`${INPUT} font-mono text-[11px] ${turnInvalid ? "border-mk-red" : ""}`}
          placeholder="turn:turn.example.com:3478"
          aria-label={t("profile.turn.url")}
        />
        <div className="flex gap-1.5">
          <input
            type="text"
            value={turn.username}
            onChange={(e) => setTurn({ ...turn, username: e.target.value })}
            onBlur={commitTurn}
            spellCheck={false}
            autoComplete="off"
            className={`${INPUT} font-mono text-[11px]`}
            placeholder={t("profile.turn.username")}
            aria-label={t("profile.turn.username")}
          />
          <input
            type="password"
            value={turn.credential}
            onChange={(e) => setTurn({ ...turn, credential: e.target.value })}
            onBlur={commitTurn}
            autoComplete="new-password"
            className={`${INPUT} font-mono text-[11px]`}
            placeholder={t("profile.turn.credential")}
            aria-label={t("profile.turn.credential")}
          />
        </div>
        <p className={`text-[10px] ${turnInvalid ? "text-mk-red" : "text-mk-fg4"}`}>
          {turnInvalid ? t("profile.turn.invalid") : t("profile.turn.help")}
        </p>
      </div>

      <div className={SECTION}>
        <div className="flex items-center justify-between">
          <span className={LABEL}>{t("update.section")}</span>
          {appVersion && <span className="font-mono text-[10px] text-mk-fg3">v{appVersion}</span>}
        </div>
        {updateState.status === "ready" ? (
          <button
            onClick={onInstallUpdate}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 bg-mk-green text-mk-bg2 font-semibold hover:bg-mk-yellow cursor-pointer transition-colors"
          >
            <Download size={13} />
            {t("update.installVersion", { version: updateState.version })}
          </button>
        ) : (
          <button
            onClick={onCheckUpdates}
            disabled={updateState.status === "checking" || updateState.status === "downloading"}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 bg-mk-bg border border-mk-bg3 hover:border-mk-fg4 text-mk-fg2 hover:text-mk-fg disabled:opacity-60 cursor-pointer disabled:cursor-default transition-colors"
          >
            {updateState.status === "checking" || updateState.status === "downloading" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            {updateState.status === "checking" ? t("update.checking") : t("update.check")}
          </button>
        )}
        <p className="text-[10px] text-mk-fg4" aria-live="polite">
          {updateState.status === "uptodate" && t("update.upToDate")}
          {updateState.status === "downloading" &&
            t("update.downloadingShort", {
              version: updateState.version,
              percent: updateState.progress === null ? "…" : `${Math.round(updateState.progress * 100)}%`,
            })}
          {updateState.status === "error" && <span className="text-mk-red">{t("update.error", { message: updateState.message })}</span>}
          {(updateState.status === "idle" || updateState.status === "checking") && t("update.auto")}
        </p>
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
