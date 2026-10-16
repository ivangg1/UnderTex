// Collaboration Manager: Y.Doc, WebrtcProvider, Awareness, and Dynamic Leader Election
// Following SPEC.md Sections 4.A and 4.B

import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { saveTexAtomic, saveCrdtState } from "./tauriBridge";

export interface CollabUser {
  name: string;
  color: string;
  colorLight?: string;
}

export interface PeerInfo {
  clientID: number;
  name: string;
  color: string;
  isHost: boolean;
  isSelf: boolean;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface CollabCallbacks {
  onHostChange?: (isHost: boolean) => void;
  onPeersChange?: (peers: PeerInfo[]) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onContentChange?: (content: string) => void;
}

export interface CollabSessionConfig {
  projectPath: string;
  roomId: string;
  initialTexContent: string;
  initialCrdtState: number[] | null;
  currentUser: CollabUser;
  callbacks?: CollabCallbacks;
}

/**
 * Returns the list of signaling servers.
 * Prioritizes VITE_SIGNALING_SERVER if defined, followed by official public fallbacks.
 */
export function getSignalingServers(): string[] {
  const envServer = import.meta.env.VITE_SIGNALING_SERVER;
  const defaults = [
    "wss://signaling.yjs.dev",
    "wss://y-webrtc-signaling-eu.herokuapp.com",
  ];

  if (envServer && typeof envServer === "string" && envServer.trim() !== "") {
    return [envServer.trim(), ...defaults];
  }
  return defaults;
}

/**
 * Manages the Yjs CRDT document, WebRTC P2P sync, awareness, dynamic host election,
 * and conflict-free cloud persistence.
 */
export class CollabManager {
  public doc: Y.Doc;
  public ytext: Y.Text;
  public provider: WebrtcProvider;
  public isHost: boolean = false;
  public peers: PeerInfo[] = [];
  public status: ConnectionStatus = "connecting";

  private projectPath: string;
  private callbacks?: CollabCallbacks;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private isDestroyed: boolean = false;

  constructor(config: CollabSessionConfig) {
    this.projectPath = config.projectPath;
    this.callbacks = config.callbacks;

    // 1. Initialize Y.Doc and Y.Text
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText("codemirror");

    // 2. Conflict-free initial state restoration (SPEC 4.B.2)
    if (config.initialCrdtState && config.initialCrdtState.length > 0) {
      try {
        Y.applyUpdate(this.doc, new Uint8Array(config.initialCrdtState));
      } catch (err) {
        console.error("CollabManager: Failed to apply initial CRDT state:", err);
      }
    }

    // If ytext is empty after loading CRDT, populate from main.tex
    if (this.ytext.length === 0 && config.initialTexContent) {
      this.ytext.insert(0, config.initialTexContent);
    }

    // 3. Connect WebrtcProvider with fallback signaling servers
    const signaling = getSignalingServers();
    this.provider = new WebrtcProvider(config.roomId, this.doc, {
      signaling,
      maxConns: 25,
      filterBcConns: true,
      peerOpts: {},
    });

    // 4. Set current user awareness
    this.updateLocalUser(config.currentUser);

    // 5. Connection status handlers
    this.provider.on("status", (event: { connected: boolean }) => {
      if (this.isDestroyed) return;
      this.status = event.connected ? "connected" : "connecting";
      this.callbacks?.onStatusChange?.(this.status);
    });

    this.provider.on("synced", (event: { synced: boolean }) => {
      if (this.isDestroyed) return;
      if (event.synced) {
        this.status = "connected";
        this.callbacks?.onStatusChange?.(this.status);
        this.handleAwarenessChange();
      }
    });

    // 6. Dynamic Leader Election (SPEC 4.A)
    this.provider.awareness.on("change", () => {
      if (this.isDestroyed) return;
      this.handleAwarenessChange();
    });

    // Initial election check
    this.handleAwarenessChange();

    // 7. Observe document content changes
    this.ytext.observe(() => {
      if (this.isDestroyed) return;
      this.callbacks?.onContentChange?.(this.ytext.toString());
    });

    // 8. Debounced cloud persistence on doc update (SPEC 4.B.3)
    this.doc.on("update", () => {
      if (this.isDestroyed) return;
      if (this.isHost) {
        this.scheduleSave();
      }
    });
  }

  /**
   * Updates local awareness state with user's name and color.
   */
  public updateLocalUser(user: CollabUser) {
    const colorLight = user.colorLight || `${user.color}33`;
    this.provider.awareness.setLocalStateField("user", {
      name: user.name,
      color: user.color,
      colorLight,
    });
    this.handleAwarenessChange();
  }

  /**
   * Dynamic Host Election algorithm (SPEC 4.A):
   * 1. Collect active clientIDs from provider.awareness.
   * 2. Sort active clientIDs ascending.
   * 3. Lowest clientID is the Active Host. Automatic failover on disconnect.
   */
  private handleAwarenessChange() {
    const activeClientIDs = Array.from(
      this.provider.awareness.getStates().keys()
    );

    if (!activeClientIDs.includes(this.doc.clientID)) {
      activeClientIDs.push(this.doc.clientID);
    }

    activeClientIDs.sort((a, b) => a - b);
    const minClientID = activeClientIDs[0];
    const newIsHost = this.doc.clientID === minClientID;

    if (newIsHost !== this.isHost) {
      this.isHost = newIsHost;
      this.callbacks?.onHostChange?.(this.isHost);
      // When becoming the new host, flush/schedule save
      if (this.isHost) {
        this.scheduleSave();
      }
    }

    // Build peer info list
    const states = this.provider.awareness.getStates();
    this.peers = activeClientIDs.map((cid) => {
      const state = states.get(cid);
      const user = state?.user || {};
      return {
        clientID: cid,
        name:
          user.name ||
          (cid === this.doc.clientID
            ? "Tú"
            : `Peer ${cid.toString().slice(-4)}`),
        color: user.color || "#3b82f6",
        isHost: cid === minClientID,
        isSelf: cid === this.doc.clientID,
      };
    });

    this.callbacks?.onPeersChange?.(this.peers);
  }

  /**
   * Debounced save to disk (SPEC 4.B.3):
   * Only the Active Host writes to main.tex and crdt_state.bin.
   */
  private scheduleSave() {
    if (!this.isHost || this.isDestroyed) return;

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(async () => {
      if (!this.isHost || this.isDestroyed) return;
      try {
        const text = this.ytext.toString();
        const crdtState = Array.from(Y.encodeStateAsUpdate(this.doc));
        await saveTexAtomic(this.projectPath, text);
        await saveCrdtState(this.projectPath, crdtState);
      } catch (err) {
        console.error("CollabManager: Auto-save to disk failed:", err);
      }
    }, 1500);
  }

  /**
   * Forces an immediate save of current project state (used e.g. before manual compile).
   */
  public async flushSave() {
    if (!this.isHost || this.isDestroyed) return;
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    try {
      const text = this.ytext.toString();
      const crdtState = Array.from(Y.encodeStateAsUpdate(this.doc));
      await saveTexAtomic(this.projectPath, text);
      await saveCrdtState(this.projectPath, crdtState);
    } catch (err) {
      console.error("CollabManager: Flush save failed:", err);
    }
  }

  /**
   * Cleanly disconnects and tears down provider and document.
   */
  public destroy() {
    this.isDestroyed = true;
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    try {
      this.provider.disconnect();
      this.provider.destroy();
      this.doc.destroy();
    } catch (err) {
      console.error("CollabManager: Error during destroy:", err);
    }
  }
}
