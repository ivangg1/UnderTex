// Banner shown while an update downloads and once it is ready to install.

import { Download, Loader2, RefreshCw, X } from "lucide-react";
import { useI18n } from "../i18n";
import type { UpdateState } from "../services/updater";

interface UpdateBannerProps {
  state: UpdateState;
  onInstall: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

export default function UpdateBanner({ state, onInstall, onRetry, onDismiss }: UpdateBannerProps) {
  const { t } = useI18n();
  if (state.status === "idle" || state.status === "checking") return null;

  const base = "flex items-center gap-3 px-4 py-1.5 text-xs shrink-0 border-b";
  if (state.status === "downloading") {
    const pct = state.progress === null ? null : Math.round(state.progress * 100);
    return (
      <div className={`${base} bg-mk-bg2 border-mk-bg3 text-mk-fg2`}>
        <Loader2 size={13} className="animate-spin text-mk-blue" />
        <span>{t("update.downloading", { version: state.version })}</span>
        {pct !== null && <span className="font-mono text-mk-fg4">{pct}%</span>}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className={`${base} bg-mk-bg2 border-mk-bg3 text-mk-fg3`}>
        <span className="truncate">{t("update.error", { message: state.message })}</span>
        <button onClick={onRetry} className="ml-auto flex items-center gap-1 text-mk-fg2 hover:text-mk-fg cursor-pointer">
          <RefreshCw size={12} /> {t("update.retry")}
        </button>
        <button onClick={onDismiss} className="text-mk-fg4 hover:text-mk-fg cursor-pointer" title={t("action.close")}>
          <X size={13} />
        </button>
      </div>
    );
  }
  return (
    <div className={`${base} bg-mk-green/10 border-mk-green/40 text-mk-fg`}>
      <Download size={13} className="text-mk-green" />
      <span>{t("update.ready", { version: state.version })}</span>
      <button
        onClick={onInstall}
        className="ml-auto flex items-center gap-1 px-2 py-1 bg-mk-green text-mk-bg2 font-semibold hover:bg-mk-yellow cursor-pointer"
      >
        <RefreshCw size={12} /> {t("update.install")}
      </button>
      <button onClick={onDismiss} className="text-mk-fg4 hover:text-mk-fg cursor-pointer" title={t("update.later")}>
        <X size={13} />
      </button>
    </div>
  );
}
