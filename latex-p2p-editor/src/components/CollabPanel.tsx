// Room panel: room ID, invite, peers, connection diagnostics, disconnect.

import { useState } from "react";
import { Check, Cloud, Copy, Crown, HardDrive, Info, Share2, User, WifiOff, AlertTriangle, Files, Upload } from "lucide-react";
import { useI18n } from "../i18n";
import type { ConnectionDiagnostics, ConnectionStatus, PeerInfo } from "../services/collabManager";
import type { AssetSyncStatus } from "../services/assetSync";
import { connectionLabel } from "./ConnectionBadge";
import type { CloudLocation } from "../services/tauriBridge";
import { cloudLabel, isCloud } from "../services/cloud";

interface CollabPanelProps {
  roomId: string;
  isHost: boolean;
  peers: PeerInfo[];
  status: ConnectionStatus;
  diagnostics: ConnectionDiagnostics | null;
  assets: AssetSyncStatus;
  /** Where the open project folder lives (null when unknown). */
  cloud: CloudLocation | null;
  /** Cloud location published by the host (what guests should sync). */
  roomCloud: CloudLocation | null;
  /** The open project is an app-managed workspace (joined without a folder). */
  isWorkspace?: boolean;
  onStopCollab: () => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error("Clipboard write failed:", err);
    return false;
  }
}

const SECTION = "px-4 py-3 border-b border-mk-bg3 flex flex-col gap-2";
const LABEL = "text-[10px] uppercase tracking-widest text-mk-fg4 font-semibold";

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** Shared project files: how many are here, what is on its way, what cannot come. */
function AssetsSection({ assets }: { assets: AssetSyncStatus }) {
  const { t } = useI18n();
  const missing = assets.items.filter((i) => i.state !== "local" && i.state !== "cached");
  const dl = assets.downloading;
  const percent = dl && dl.size > 0 ? Math.floor((dl.received / dl.size) * 100) : 0;
  return (
    <div className={SECTION}>
      <div className="flex items-center justify-between">
        <span className={LABEL}>{t("assets.title")}</span>
        {assets.total > 0 && (
          <span className={`text-[10px] font-medium ${assets.missing === 0 ? "text-mk-green" : "text-mk-fg3"}`}>
            {t("assets.summary", { synced: assets.synced, total: assets.total })}
          </span>
        )}
      </div>
      {assets.total === 0 ? (
        <p className="text-[11px] text-mk-fg4">{t("assets.none")}</p>
      ) : (
        <div className="h-1 bg-mk-bg3">
          <div className="h-full bg-mk-green transition-all" style={{ width: `${(assets.synced / assets.total) * 100}%` }} />
        </div>
      )}
      {dl && (
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[11px] text-mk-fg2 truncate" title={dl.path}>
            <Files size={12} className="shrink-0 text-mk-blue" />
            {t("assets.receiving", { path: dl.path, percent })}
          </span>
          <div className="h-1 bg-mk-bg3">
            <div className="h-full bg-mk-blue transition-all" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
      {assets.uploading > 0 && (
        <span className="flex items-center gap-1.5 text-[11px] text-mk-fg3">
          <Upload size={12} className="shrink-0" />
          {t("assets.sending", { count: assets.uploading })}
        </span>
      )}
      {assets.unavailable > 0 && (
        <p className="flex gap-1.5 text-[11px] text-mk-orange leading-relaxed">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          {t("assets.unavailable", { count: assets.unavailable })}
        </p>
      )}
      {assets.tooLarge > 0 && (
        <p className="flex gap-1.5 text-[11px] text-mk-orange leading-relaxed">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          {t("assets.tooLarge", { count: assets.tooLarge, mb: mb(assets.maxBytes) })}
        </p>
      )}
      {missing.length > 0 && (
        <ul className="font-mono text-[10px] text-mk-fg3 flex flex-col gap-0.5 max-h-28 overflow-y-auto">
          {missing.map((item) => (
            <li key={item.path} className="flex gap-2">
              <span className="truncate" title={item.path}>
                {item.path}
              </span>
              <span className="ml-auto shrink-0 text-mk-fg4">{t(`assets.state.${item.state as "queued"}`)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-mk-fg4 leading-relaxed">{t("assets.help")}</p>
    </div>
  );
}

export default function CollabPanel({
  roomId,
  isHost,
  peers,
  status,
  diagnostics,
  assets,
  cloud,
  roomCloud,
  isWorkspace = false,
  onStopCollab,
}: CollabPanelProps) {
  const { t, locale } = useI18n();
  const [copied, setCopied] = useState<"id" | "invite" | null>(null);

  const flash = (what: "id" | "invite") => {
    setCopied(what);
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
  };

  const inviteMessage =
    locale === "es"
      ? `Únete a mi documento LaTeX en tiempo real: abre UnderTeX, pulsa "Unirse" y pega este ID de sala:\n${roomId}`
      : `Join my LaTeX document in real time: open UnderTeX, press "Join" and paste this room ID:\n${roomId}`;

  const label = connectionLabel(status, t);

  return (
    <div className="flex flex-col">
      <div className={SECTION}>
        <div className="flex items-center justify-between">
          <span className={LABEL}>{t("collab.roomId")}</span>
          <span className={`flex items-center gap-1 text-[10px] font-medium ${isHost ? "text-mk-yellow" : "text-mk-blue"}`}>
            {isHost ? <Crown size={11} /> : <User size={11} />}
            {isHost ? t("mode.host") : t("mode.guest")}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <code className="flex-1 truncate px-2 py-1.5 bg-mk-bg border border-mk-bg3 font-mono text-[11px] text-mk-fg2" title={roomId}>
            {roomId}
          </code>
          <button
            onClick={() => void copyText(roomId).then((ok) => ok && flash("id"))}
            className="px-2 py-1.5 bg-mk-bg border border-mk-bg3 hover:border-mk-fg4 text-mk-fg2 hover:text-mk-fg cursor-pointer"
            title={t("collab.copyId")}
          >
            {copied === "id" ? <Check size={13} className="text-mk-green" /> : <Copy size={13} />}
          </button>
        </div>
        <button
          onClick={() => void copyText(inviteMessage).then((ok) => ok && flash("invite"))}
          className="flex items-center justify-center gap-1.5 px-2 py-1.5 bg-mk-yellow hover:bg-mk-orange text-mk-bg2 font-semibold cursor-pointer transition-colors"
        >
          {copied === "invite" ? <Check size={13} /> : <Share2 size={13} />}
          {copied === "invite" ? t("action.copied") : t("collab.inviteButton")}
        </button>
        <p className="text-[11px] text-mk-fg3 leading-relaxed">{t("collab.invite")}</p>
      </div>

      <div className={SECTION}>
        <span className={LABEL}>{t("collab.peers", { count: peers.length })}</span>
        <ul className="flex flex-col gap-1.5">
          {peers.map((peer) => (
            <li key={peer.clientID} className="flex items-center gap-2">
              <span
                className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-mk-bg2"
                style={{ backgroundColor: peer.color }}
              >
                {(peer.name || "?").charAt(0).toUpperCase()}
              </span>
              <span className="text-mk-fg truncate">
                {peer.name || t("common.peer", { id: peer.clientID.toString().slice(-4) })}
                {peer.isSelf && <span className="text-mk-fg4"> · {t("common.you")}</span>}
              </span>
              <span className={`ml-auto flex items-center gap-1 text-[10px] ${peer.isHost ? "text-mk-yellow" : "text-mk-fg4"}`}>
                {peer.isHost ? <Crown size={11} /> : <User size={11} />}
                {peer.isHost ? t("collab.hostWrites") : t("collab.guestRam")}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className={SECTION}>
        <span className={LABEL}>{t("collab.connection")}</span>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${label.dot}`} />
          <span className={`${label.textColor} font-medium`}>{label.text}</span>
        </div>
        {status === "unreachable" && (
          <p className="flex gap-1.5 text-[11px] text-mk-red leading-relaxed">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            {t("conn.unreachable.help")}
          </p>
        )}
        {status === "waiting" && <p className="text-[11px] text-mk-fg3 leading-relaxed">{t("conn.waiting.help")}</p>}
        {diagnostics && (
          <ul className="font-mono text-[10px] text-mk-fg3 flex flex-col gap-0.5">
            {diagnostics.signaling.map((s) => (
              <li key={s.url} className="truncate">
                <span className={s.connected ? "text-mk-green" : "text-mk-red"}>{s.connected ? "✓" : "✗"}</span> {s.url}
              </li>
            ))}
            <li>{t("conn.peersLine", { webrtc: diagnostics.webrtcPeers, bc: diagnostics.bcPeers })}</li>
            <li>{t("conn.synced", { value: diagnostics.synced ? t("conn.yes") : t("conn.no") })}</li>
            <li>{t("conn.turn", { value: diagnostics.turnConfigured ? t("conn.yes") : t("conn.no") })}</li>
          </ul>
        )}
      </div>

      <AssetsSection assets={assets} />
      {cloud && (
        <div className={SECTION}>
          <span className={LABEL}>{t("collab.files")}</span>
          {!isHost && roomCloud && isCloud(roomCloud) && roomCloud.provider !== cloud.provider && (
            <p className="flex gap-1.5 text-[11px] text-mk-blue leading-relaxed">
              <Cloud size={12} className="shrink-0 mt-0.5" />
              {t("collab.files.hostCloud", { provider: cloudLabel(roomCloud, t) })}
            </p>
          )}
          <div
            className="flex items-center gap-2 min-w-0"
            title={isCloud(cloud) ? t("collab.files.cloudTip", { provider: t(`cloud.provider.${cloud.provider}`) }) : undefined}
          >
            {isCloud(cloud) ? <Cloud size={13} className="shrink-0 text-mk-blue" /> : <HardDrive size={13} className="shrink-0 text-mk-fg3" />}
            <span className="text-mk-fg truncate">{cloudLabel(cloud, t)}</span>
          </div>
          {!isCloud(cloud) && isHost && !isWorkspace && (
            <p className="flex gap-1.5 text-[11px] text-mk-fg3 leading-relaxed">
              <Info size={12} className="shrink-0 mt-0.5" />
              {t("collab.files.localHint")}
            </p>
          )}
        </div>
      )}

      <div className="px-4 py-3">
        <button
          onClick={onStopCollab}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 bg-mk-bg border border-mk-bg3 hover:border-mk-red text-mk-fg2 hover:text-mk-red font-medium cursor-pointer transition-colors"
          title={t("collab.disconnect.tip")}
        >
          <WifiOff size={13} />
          {t("collab.disconnect")}
        </button>
      </div>
    </div>
  );
}
