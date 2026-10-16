// Collaboration Manager: Dual Mode (Solo/Local vs Collab/P2P)
// Following SPEC.md Section 4.A, 4.B, and 4.D

import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { Awareness } from "y-protocols/awareness";
import {
  saveTexAtomic,
  saveProjectState,
  initCollabProject,
} from "./tauriBridge";

export type CollabMode = "solo" | "collab";

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
  onModeChange?: (mode: CollabMode) => void;
  onHostChange?: (isHost: boolean) => void;
  onPeersChange?: (peers: PeerInfo[]) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onContentChange?: (content: string) => void;
  onRoomIdChange?: (roomId: string | null) => void;
}

export interface CollabSessionConfig {
  projectPath: string;
  isCollab: boolean;
  roomId?: string | null;
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
  const activeServers = [
    // Official high-availability y-webrtc signaling servers
    "wss://y-webrtc-eu.fly.dev",
    "wss://y-webrtc.fly.dev",
    // Local signaling server (0ms latency if running signaling-server/)
    "ws://127.0.0.1:4444",
    // Legacy public fallbacks
    "wss://signaling.yjs.dev",
    "wss://y-webrtc-signaling-eu.herokuapp.com",
  ];

  if (envServer && typeof envServer === "string" && envServer.trim() !== "") {
    return [envServer.trim(), ...activeServers];
  }
  return activeServers;
}

/**
 * Manages the Yjs CRDT document, WebRTC P2P sync, awareness, dynamic host election,
 * and conflict-free cloud persistence with dual-mode operation (Solo vs Collab).
 */
export class CollabManager {
  public doc: Y.Doc;
  public ytext: Y.Text;
  public awareness: Awareness;
  public provider: WebrtcProvider | null = null;
  public mode: CollabMode = "solo";
  public roomId: string | null = null;
  public isHost: boolean = true;
  public peers: PeerInfo[] = [];
  public status: ConnectionStatus = "disconnected";

  private projectPath: string;
  private currentUser: CollabUser;
  private callbacks?: CollabCallbacks;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private isDestroyed: boolean = false;

  constructor(config: CollabSessionConfig) {
    this.projectPath = config.projectPath;
    this.currentUser = config.currentUser;
    this.callbacks = config.callbacks;
    this.roomId = config.roomId ?? null;

    // 1. Initialize Y.Doc, Y.Text, and local Awareness
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText("codemirror");
    this.awareness = new Awareness(this.doc);

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

    // Set user profile on local awareness
    this.setAwarenessUser(config.currentUser);

    // Observe document content changes
    this.ytext.observe(() => {
      if (this.isDestroyed) return;
      this.callbacks?.onContentChange?.(this.ytext.toString());
    });

    // Observe document updates for debounced auto-save
    this.doc.on("update", () => {
      if (this.isDestroyed) return;
      if (this.isHost) {
        this.scheduleSave();
      }
    });

    // 3. Initialize in requested mode (SPEC 4.D)
    if (config.isCollab && config.roomId) {
      this.mode = "collab";
      this.connectWebRTC(config.roomId);
    } else {
      // Solo Mode: zero network traffic, permanent Host, clean local editing
      this.mode = "solo";
      this.isHost = true;
      this.status = "disconnected";
      this.peers = [];
      this.callbacks?.onModeChange?.("solo");
      this.callbacks?.onHostChange?.(true);
      this.callbacks?.onPeersChange?.([]);
      this.callbacks?.onStatusChange?.("disconnected");
    }
  }

  /**
   * Helper to set user metadata on awareness.
   */
  private setAwarenessUser(user: CollabUser) {
    const colorLight = user.colorLight || `${user.color}33`;
    this.awareness.setLocalStateField("user", {
      name: user.name,
      color: user.color,
      colorLight,
    });
  }

  /**
   * Updates local awareness state with user's name and color.
   */
  public updateLocalUser(user: CollabUser) {
    this.currentUser = user;
    this.setAwarenessUser(user);
    if (this.mode === "collab") {
      this.handleAwarenessChange();
    }
  }

  /**
   * Connects WebrtcProvider to the existing in-memory document and awareness.
   */
  private connectWebRTC(roomId: string) {
    if (this.provider) {
      try {
        this.provider.destroy();
      } catch (e) {
        // ignore
      }
    }

    const signaling = getSignalingServers();
    this.provider = new WebrtcProvider(roomId, this.doc, {
      signaling,
      awareness: this.awareness,
      maxConns: 30,
      filterBcConns: false, // Enable instant local sync across windows
      peerOpts: {},
    });

    this.setAwarenessUser(this.currentUser);

    this.provider.on("status", (event: { connected: boolean }) => {
      if (this.isDestroyed || this.mode !== "collab") return;
      this.status = event.connected ? "connected" : "connecting";
      this.callbacks?.onStatusChange?.(this.status);
    });

    this.provider.on("synced", (event: { synced: boolean }) => {
      if (this.isDestroyed || this.mode !== "collab") return;
      if (event.synced) {
        this.status = "connected";
        this.callbacks?.onStatusChange?.(this.status);
        this.handleAwarenessChange();
      }
    });

    this.provider.on("peers", () => {
      if (this.isDestroyed || this.mode !== "collab") return;
      this.handleAwarenessChange();
    });

    this.awareness.on("change", () => {
      if (this.isDestroyed || this.mode !== "collab") return;
      this.handleAwarenessChange();
    });

    this.handleAwarenessChange();
  }

  /**
   * Activate collaboration on demand (SPEC 4.D.2):
   * 1. Invokes init_collab_project in Rust to create .texcollab/room.json.
   * 2. Saves initial CRDT state vector to .texcollab/crdt_state.bin.
   * 3. Hot-attaches WebrtcProvider to the existing in-memory Y.Doc without reload.
   */
  public async startCollaboration(): Promise<string> {
    if (this.mode === "collab" && this.roomId) {
      return this.roomId;
    }

    // 1. Create .texcollab/room.json with a UUID
    const roomId = await initCollabProject(this.projectPath);
    this.roomId = roomId;

    // 2. Persist initial CRDT binary state and main.tex
    const text = this.ytext.toString();
    const crdtState = Array.from(Y.encodeStateAsUpdate(this.doc));
    await saveProjectState(this.projectPath, text, crdtState);

    // 3. Switch mode to collab and hot-attach WebrtcProvider
    this.mode = "collab";
    this.callbacks?.onModeChange?.("collab");
    this.callbacks?.onRoomIdChange?.(roomId);

    this.connectWebRTC(roomId);

    return roomId;
  }

  /**
   * Disconnects WebRTC collaboration and returns to Solo / Local Mode (SPEC 4.D.3).
   */
  public async stopCollaboration(): Promise<void> {
    if (this.mode === "solo") return;

    // 1. Disconnect and destroy WebrtcProvider
    if (this.provider) {
      try {
        this.provider.disconnect();
        this.provider.destroy();
      } catch (err) {
        console.error("CollabManager: Error disconnecting provider:", err);
      }
      this.provider = null;
    }

    // 2. Switch mode to solo, set Host = true, clear peers
    this.mode = "solo";
    this.isHost = true;
    this.peers = [];
    this.status = "disconnected";

    this.callbacks?.onModeChange?.("solo");
    this.callbacks?.onHostChange?.(true);
    this.callbacks?.onPeersChange?.([]);
    this.callbacks?.onStatusChange?.("disconnected");

    // 3. Flush save to main.tex
    await this.flushSave();
  }

  /**
   * Pure leader election logic (SPEC 4.A):
   * Lowest numerical clientID among active peers is the Host.
   */
  public static computeIsHost(
    activeClientIDs: number[],
    myClientID: number
  ): boolean {
    if (activeClientIDs.length === 0) return true;
    const sorted = [...activeClientIDs].sort((a, b) => a - b);
    return myClientID === sorted[0];
  }

  /**
   * Dynamic Host Election algorithm (SPEC 4.A):
   * 1. Collect active clientIDs from awareness.
   * 2. Sort active clientIDs ascending.
   * 3. Lowest clientID is the Active Host. Automatic failover on disconnect.
   */
  private handleAwarenessChange() {
    if (this.mode !== "collab") return;

    const states = this.awareness.getStates();
    const activeClientIDs = Array.from(states.keys()).filter((cid) => {
      if (cid === this.doc.clientID) return true;
      const state = states.get(cid);
      return (
        state !== null && state !== undefined && Object.keys(state).length > 0
      );
    });

    if (!activeClientIDs.includes(this.doc.clientID)) {
      activeClientIDs.push(this.doc.clientID);
    }

    activeClientIDs.sort((a, b) => a - b);
    const minClientID = activeClientIDs[0];
    const newIsHost = CollabManager.computeIsHost(
      activeClientIDs,
      this.doc.clientID
    );

    if (newIsHost !== this.isHost) {
      this.isHost = newIsHost;
      this.callbacks?.onHostChange?.(this.isHost);
      // When becoming the new host, flush/schedule save
      if (this.isHost) {
        this.scheduleSave();
      } else if (this.saveTimeout) {
        // Demoted to guest: cancel any pending save immediately
        clearTimeout(this.saveTimeout);
        this.saveTimeout = null;
      }
    }

    // Build peer info list
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
   * Debounced save to disk (SPEC 4.B.1 & 4.B.3):
   * - In Solo Mode: saves ONLY to main.tex via saveTexAtomic (never touches .texcollab/).
   * - In Collab Mode: only the Host saves both main.tex and .texcollab/crdt_state.bin.
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
        if (this.mode === "solo") {
          await saveTexAtomic(this.projectPath, text);
        } else {
          const crdtState = Array.from(Y.encodeStateAsUpdate(this.doc));
          await saveProjectState(this.projectPath, text, crdtState);
        }
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
      if (this.mode === "solo") {
        await saveTexAtomic(this.projectPath, text);
      } else {
        const crdtState = Array.from(Y.encodeStateAsUpdate(this.doc));
        await saveProjectState(this.projectPath, text, crdtState);
      }
    } catch (err) {
      console.error("CollabManager: Flush save failed:", err);
    }
  }

  /**
   * Cleanly disconnects and tears down provider, awareness, and document.
   */
  public destroy() {
    this.isDestroyed = true;
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    try {
      if (this.provider) {
        this.provider.disconnect();
        this.provider.destroy();
        this.provider = null;
      }
      this.awareness.destroy();
      this.doc.destroy();
    } catch (err) {
      console.error("CollabManager: Error during destroy:", err);
    }
  }
}
