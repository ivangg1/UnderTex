// Room panel: room ID, invite, peers, connection diagnostics, disconnect.

import { useState } from "react";
import { Check, Copy, Crown, Share2, User, WifiOff, AlertTriangle } from "lucide-react";
import { useI18n } from "../i18n";
import type { ConnectionDiagnostics, ConnectionStatus, PeerInfo } from "../services/collabManager";
import { connectionLabel } from "./ConnectionBadge";

interface CollabPanelProps {
  roomId: string;
  isHost: boolean;
  peers: PeerInfo[];
  status: ConnectionStatus;
  diagnostics: ConnectionDiagnostics | null;
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

export default function CollabPanel({ roomId, isHost, peers, status, diagnostics, onStopCollab }: CollabPanelProps) {
  const { t, locale } = useI18n();
  const [copied, setCopied] = useState<"id" | "invite" | null>(null);

  const flash = (what: "id" | "invite") => {
    setCopied(what);
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
  };

  const inviteMessage =
    locale === "es"
      ? `Únete a mi documento LaTeX en tiempo real: abre LaTeX P2P, pulsa "Unirse" y pega este ID de sala:\n${roomId}`
      : `Join my LaTeX document in real time: open LaTeX P2P, press "Join" and paste this room ID:\n${roomId}`;

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
