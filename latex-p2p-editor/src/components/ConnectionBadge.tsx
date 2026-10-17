// Shared connection status presentation (rail badge, top bar, room panel).

import type { ConnectionStatus } from "../services/collabManager";
import type { MessageKey } from "../i18n";

export interface StatusLabel {
  text: string;
  dot: string;
  textColor: string;
}

const KEYS: Record<ConnectionStatus, MessageKey> = {
  disconnected: "conn.disconnected",
  connecting: "conn.connecting",
  unreachable: "conn.unreachable",
  waiting: "conn.waiting",
  connected: "conn.connected",
};

const STYLE: Record<ConnectionStatus, { dot: string; textColor: string }> = {
  disconnected: { dot: "bg-mk-fg4", textColor: "text-mk-fg3" },
  connecting: { dot: "bg-mk-orange animate-pulse", textColor: "text-mk-orange" },
  unreachable: { dot: "bg-mk-red", textColor: "text-mk-red" },
  waiting: { dot: "bg-mk-blue", textColor: "text-mk-blue" },
  connected: { dot: "bg-mk-green shadow-[0_0_6px_rgba(169,220,118,0.8)]", textColor: "text-mk-green" },
};

export function connectionLabel(status: ConnectionStatus, t: (key: MessageKey) => string): StatusLabel {
  return { text: t(KEYS[status]), ...STYLE[status] };
}
