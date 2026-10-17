// Collaboration Manager: dual mode (Solo/Local vs Collab/P2P).
//
// Owns the Y.Doc, the awareness instance, the optional WebrtcProvider, the
// dynamic host election and the host-only debounced persistence.
//
// Design notes (see README "Architecture"):
// * Initial content is seeded deterministically (crdtSeed.ts) so peers that
//   bootstrap from the same main.tex never end up with duplicated text.
// * In collab mode, seeding is deferred until the first sync (or a short
//   timeout) so a joining peer adopts the swarm's document instead of its own
//   stale copy.
// * Every peer publishes its y-webrtc peerId in awareness. When a WebRTC
//   connection drops, the matching awareness state is removed immediately,
//   so host failover happens in milliseconds instead of waiting for the 30 s
//   awareness timeout.
// * Saves are serialized (never two concurrent writes of main.tex), tracked by
//   a dirty flag (no rewrite when nothing changed), flushed immediately on
//   host promotion, and blocked while a freshly joined host is not synced yet.

import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import { saveTexAtomic, saveProjectState, initCollabProject } from "./tauriBridge";
import { seedDocFromText, TEXT_KEY } from "./crdtSeed";
import { applyTextDiff } from "./textDiff";

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

/**
 * - `disconnected`: solo mode, no provider.
 * - `connecting`: no signaling server reachable yet (within the grace period).
 * - `unreachable`: no signaling server could be reached within the grace period.
 * - `waiting`: signaling reachable, no peer in the room yet.
 * - `connected`: at least one peer connected (WebRTC or BroadcastChannel).
 */
export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "unreachable"
  | "waiting"
  | "connected";

export interface SignalingState {
  url: string;
  connected: boolean;
}

export interface ConnectionDiagnostics {
  status: ConnectionStatus;
  signaling: SignalingState[];
  webrtcPeers: number;
  bcPeers: number;
  synced: boolean;
}

/**
 * - `guest`: not the host; this peer never writes to disk.
 * - `dirty`: unsaved local changes (debounce pending or blocked until synced).
 * - `saving` / `saved` / `error`: state of the last write.
 * - `idle`: nothing has changed since the project was opened.
 */
export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error" | "guest";

export interface SaveState {
  status: SaveStatus;
  lastSavedAt: number | null;
  error: string | null;
}

export interface CollabCallbacks {
  onModeChange?: (mode: CollabMode) => void;
  onHostChange?: (isHost: boolean) => void;
  onPeersChange?: (peers: PeerInfo[]) => void;
  onStatusChange?: (status: ConnectionStatus, diagnostics: ConnectionDiagnostics) => void;
  onRoomIdChange?: (roomId: string | null) => void;
  onSaveStateChange?: (state: SaveState) => void;
}

export interface CollabOptions {
  /** Debounce for host writes to disk. Default 1500 ms. */
  saveDebounceMs?: number;
  /** How long a joining peer waits for the swarm before seeding from main.tex. Default 4000 ms. */
  seedWaitMs?: number;
  /** Grace period before reporting signaling servers as unreachable. Default 10000 ms. */
  signalingTimeoutMs?: number;
  /** Override the signaling server list (tests / advanced users). */
  signaling?: string[];
}

export interface CollabSessionConfig {
  projectPath: string;
  mainFile: string;
  isCollab: boolean;
  roomId?: string | null;
  initialTexContent: string;
  initialCrdtState: number[] | null;
  currentUser: CollabUser;
  callbacks?: CollabCallbacks;
  options?: CollabOptions;
}

/** localStorage key holding a user-configured signaling server (comma separated). */
export const SIGNALING_OVERRIDE_KEY = "latex_signaling_servers";

/** Public y-webrtc signaling servers that are known to be up. */
export const DEFAULT_SIGNALING_SERVERS = [
  "wss://y-webrtc-eu.fly.dev",
  "wss://y-webrtc.fly.dev",
];

/** Signaling server started with `signaling-server/` (dev convenience). */
export const LOCAL_SIGNALING_SERVER = "ws://127.0.0.1:4444";

function readSignalingOverride(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(SIGNALING_OVERRIDE_KEY) ?? "";
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^wss?:\/\//.test(s));
  } catch {
    return [];
  }
}

/**
 * Returns the ordered list of signaling servers:
 * 1. user override from localStorage (settings UI),
 * 2. `VITE_SIGNALING_SERVER` build-time variable,
 * 3. public servers, plus the local dev server in development builds.
 * Dead legacy hosts (herokuapp, signaling.yjs.dev) are intentionally not listed:
 * y-webrtc keeps reconnecting to every entry forever.
 */
export function getSignalingServers(): string[] {
  const servers: string[] = [...readSignalingOverride()];
  const envServer = import.meta.env.VITE_SIGNALING_SERVER;
  if (typeof envServer === "string" && envServer.trim() !== "") {
    servers.push(envServer.trim());
  }
  servers.push(...DEFAULT_SIGNALING_SERVERS);
  if (import.meta.env.DEV) {
    servers.push(LOCAL_SIGNALING_SERVER);
  }
  return Array.from(new Set(servers));
}

/** Pure status derivation, kept separate so it can be unit-tested. */
export function computeConnectionStatus(input: {
  hasProvider: boolean;
  signalingConnected: boolean;
  peerCount: number;
  elapsedMs: number;
  signalingTimeoutMs: number;
}): ConnectionStatus {
  if (!input.hasProvider) return "disconnected";
  if (input.peerCount > 0) return "connected";
  if (input.signalingConnected) return "waiting";
  return input.elapsedMs >= input.signalingTimeoutMs ? "unreachable" : "connecting";
}

interface AwarenessUserState {
  name?: string;
  color?: string;
  colorLight?: string;
}

interface AwarenessState {
  user?: AwarenessUserState;
  peerId?: string;
}

type Unsubscribe = () => void;

/**
 * Manages the Yjs CRDT document, WebRTC P2P sync, awareness, dynamic host election
 * and conflict-free cloud persistence with dual-mode operation (Solo vs Collab).
 */
export class CollabManager {
  public readonly doc: Y.Doc;
  public readonly ytext: Y.Text;
  public readonly awareness: Awareness;
  public provider: WebrtcProvider | null = null;
  public mode: CollabMode = "solo";
  public roomId: string | null = null;
  public isHost = true;
  public peers: PeerInfo[] = [];
  public status: ConnectionStatus = "disconnected";
  public diagnostics: ConnectionDiagnostics = {
    status: "disconnected",
    signaling: [],
    webrtcPeers: 0,
    bcPeers: 0,
    synced: false,
  };
  public saveState: SaveState = { status: "idle", lastSavedAt: null, error: null };

  private readonly projectPath: string;
  private readonly mainFile: string;
  private currentUser: CollabUser;
  private readonly callbacks?: CollabCallbacks;
  private readonly saveDebounceMs: number;
  private readonly seedWaitMs: number;
  private readonly signalingTimeoutMs: number;
  private readonly signalingOverride?: string[];

  private isDestroyed = false;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveInFlight: Promise<void> | null = null;
  private synced = false;
  private remotePeerIds = new Set<string>();
  private pendingSeed: string | null = null;
  private seedTimer: ReturnType<typeof setTimeout> | null = null;
  private connectStartedAt = 0;
  private signalingTimer: ReturnType<typeof setTimeout> | null = null;
  private providerCleanups: Unsubscribe[] = [];

  constructor(config: CollabSessionConfig) {
    this.projectPath = config.projectPath;
    this.mainFile = config.mainFile;
    this.currentUser = config.currentUser;
    this.callbacks = config.callbacks;
    this.roomId = config.roomId ?? null;
    this.saveDebounceMs = config.options?.saveDebounceMs ?? 1500;
    this.seedWaitMs = config.options?.seedWaitMs ?? 4000;
    this.signalingTimeoutMs = config.options?.signalingTimeoutMs ?? 10000;
    this.signalingOverride = config.options?.signaling;

    this.doc = new Y.Doc();
    this.ytext = this.doc.getText(TEXT_KEY);
    this.awareness = new Awareness(this.doc);

    if (config.initialCrdtState && config.initialCrdtState.length > 0) {
      try {
        Y.applyUpdate(this.doc, new Uint8Array(config.initialCrdtState), "load");
      } catch (err) {
        console.error("CollabManager: failed to apply persisted CRDT state:", err);
      }
    }

    const startCollab = config.isCollab && Boolean(config.roomId);
    if (this.ytext.length === 0 && config.initialTexContent) {
      if (startCollab) {
        // Joining a room: prefer the swarm's document over our (possibly stale) file.
        this.pendingSeed = config.initialTexContent;
      } else {
        seedDocFromText(this.doc, config.initialTexContent);
      }
    }

    this.setAwarenessUser(config.currentUser);

    this.doc.on("update", this.handleDocUpdate);
    this.awareness.on("change", this.handleAwarenessChange);

    if (startCollab) {
      this.mode = "collab";
      void this.connectWebRTC(config.roomId as string);
    } else {
      this.enterSoloState();
    }
  }

  // ─── Public API ───────────────────────────────────────────────────

  /** Current document text. */
  public getText(): string {
    return this.ytext.toString();
  }

  /**
   * Replaces the whole document (e.g. restoring a version) with minimal edit
   * operations in one transaction, so peers merge it like any other edit.
   * Returns the number of operations applied.
   */
  public replaceText(next: string): number {
    return applyTextDiff(this.ytext, next, "restore");
  }

  /** Updates local awareness state with the user's name and color. */
  public updateLocalUser(user: CollabUser): void {
    this.currentUser = user;
    this.setAwarenessUser(user);
  }

  /**
   * Activates collaboration on demand (hot-attach): persists the current state,
   * creates `.texcollab/room.json` and attaches a WebrtcProvider to the live doc.
   */
  public async startCollaboration(): Promise<string> {
    if (this.mode === "collab" && this.roomId) {
      return this.roomId;
    }
    const meta = await initCollabProject(this.projectPath, this.mainFile, null);
    this.roomId = meta.room_id;
    this.mode = "collab";
    this.dirty = true;
    await this.flushSave();
    this.callbacks?.onModeChange?.("collab");
    this.callbacks?.onRoomIdChange?.(this.roomId);
    await this.connectWebRTC(this.roomId);
    return this.roomId;
  }

  /** Disconnects WebRTC and returns to solo mode. Pending host changes are flushed. */
  public async stopCollaboration(): Promise<void> {
    if (this.mode === "solo") return;
    this.teardownProvider();
    this.enterSoloState();
    this.callbacks?.onModeChange?.("solo");
    this.callbacks?.onRoomIdChange?.(null);
    this.dirty = true;
    await this.flushSave();
  }

  /** Forces an immediate write of any unsaved change (host only). */
  public async flushSave(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saveInFlight) {
      await this.saveInFlight;
    }
    if (this.dirty && this.canSave()) {
      await this.performSave();
    }
  }

  /** Pure leader election: the lowest numerical clientID among active peers is the host. */
  public static computeIsHost(activeClientIDs: number[], myClientID: number): boolean {
    if (activeClientIDs.length === 0) return true;
    let min = activeClientIDs[0];
    for (const id of activeClientIDs) {
      if (id < min) min = id;
    }
    return myClientID === min;
  }

  /**
   * Flushes pending host changes and then destroys the session. Use this when
   * switching projects or closing the window so the last edits inside the
   * debounce window are never lost.
   */
  public async dispose(): Promise<void> {
    if (this.isDestroyed) return;
    try {
      await this.flushSave();
    } finally {
      this.destroy();
    }
  }

  /** Immediately tears down provider, awareness and document (no flush). */
  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.clearSeedTimer();
    try {
      this.teardownProvider();
      this.doc.off("update", this.handleDocUpdate);
      this.awareness.off("change", this.handleAwarenessChange);
      this.awareness.destroy();
      this.doc.destroy();
    } catch (err) {
      console.error("CollabManager: error during destroy:", err);
    }
  }

  // ─── Mode transitions ─────────────────────────────────────────────

  private enterSoloState(): void {
    this.mode = "solo";
    this.synced = true;
    this.remotePeerIds.clear();
    this.setHost(true, { flush: false });
    this.peers = [];
    this.applySeedIfPending();
    this.updateDiagnostics();
    this.callbacks?.onPeersChange?.([]);
    this.emitSaveState();
  }

  private async connectWebRTC(roomId: string): Promise<void> {
    if (this.isDestroyed) return;
    this.teardownProvider();
    // y-webrtc unregisters a destroyed room asynchronously; let that settle.
    await Promise.resolve();
    await Promise.resolve();
    if (this.isDestroyed || this.mode !== "collab") return;

    this.synced = false;
    this.remotePeerIds.clear();
    this.connectStartedAt = Date.now();

    const provider = new WebrtcProvider(roomId, this.doc, {
      signaling: this.signalingOverride ?? getSignalingServers(),
      awareness: this.awareness,
      maxConns: 30,
      filterBcConns: false, // instant sync across windows of the same app
      peerOpts: {},
    });
    this.provider = provider;

    const onStatus = () => {
      if (this.provider !== provider) return;
      this.publishPeerId();
      this.updateDiagnostics();
    };
    const onSynced = (event: { synced: boolean }) => {
      if (this.provider !== provider) return;
      this.synced = event.synced;
      if (event.synced) {
        this.clearSeedTimer();
        if (this.ytext.length > 0) {
          this.pendingSeed = null;
        } else {
          this.applySeedIfPending();
        }
        if (this.dirty) this.scheduleSave();
      }
      this.updateDiagnostics();
      this.handleAwarenessChange();
    };
    const onPeers = (event: {
      added: string[];
      removed: string[];
      webrtcPeers: string[];
      bcPeers: string[];
    }) => {
      if (this.provider !== provider) return;
      this.publishPeerId();
      this.remotePeerIds = new Set([...event.webrtcPeers, ...event.bcPeers]);
      const gone = event.removed.filter((id) => !this.remotePeerIds.has(id));
      if (gone.length > 0) {
        this.dropAwarenessOfPeers(gone);
      }
      this.updateDiagnostics();
      this.handleAwarenessChange();
    };
    provider.on("status", onStatus);
    provider.on("synced", onSynced);
    provider.on("peers", onPeers);
    this.providerCleanups.push(() => {
      provider.off("status", onStatus);
      provider.off("synced", onSynced);
      provider.off("peers", onPeers);
    });

    const onSignaling = () => {
      if (this.provider === provider) this.updateDiagnostics();
    };
    for (const conn of provider.signalingConns ?? []) {
      conn.on("connect", onSignaling);
      conn.on("disconnect", onSignaling);
      this.providerCleanups.push(() => {
        conn.off("connect", onSignaling);
        conn.off("disconnect", onSignaling);
      });
    }

    this.signalingTimer = setTimeout(() => {
      this.signalingTimer = null;
      this.updateDiagnostics();
    }, this.signalingTimeoutMs);
    if (this.pendingSeed !== null) {
      this.seedTimer = setTimeout(() => {
        this.seedTimer = null;
        if (this.ytext.length === 0) {
          this.applySeedIfPending();
        } else {
          this.pendingSeed = null;
        }
      }, this.seedWaitMs);
    }

    this.updateDiagnostics();
    this.handleAwarenessChange();
  }

  private teardownProvider(): void {
    for (const cleanup of this.providerCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // listener already gone
      }
    }
    if (this.signalingTimer) {
      clearTimeout(this.signalingTimer);
      this.signalingTimer = null;
    }
    this.clearSeedTimer();
    if (this.provider) {
      try {
        this.provider.destroy();
      } catch (err) {
        console.error("CollabManager: error destroying provider:", err);
      }
      this.provider = null;
    }
    // Forget every remote peer: their states must not influence the next election.
    const remote = Array.from(this.awareness.getStates().keys()).filter(
      (id) => id !== this.doc.clientID
    );
    if (remote.length > 0) {
      removeAwarenessStates(this.awareness, remote, "provider teardown");
    }
    this.remotePeerIds.clear();
  }

  // ─── Seeding ──────────────────────────────────────────────────────

  private applySeedIfPending(): void {
    if (this.pendingSeed === null) return;
    const text = this.pendingSeed;
    this.pendingSeed = null;
    if (this.ytext.length === 0 && text.length > 0) {
      seedDocFromText(this.doc, text);
    }
  }

  private clearSeedTimer(): void {
    if (this.seedTimer) {
      clearTimeout(this.seedTimer);
      this.seedTimer = null;
    }
  }

  // ─── Awareness & host election ────────────────────────────────────

  private setAwarenessUser(user: CollabUser): void {
    this.awareness.setLocalStateField("user", {
      name: user.name,
      color: user.color,
      colorLight: user.colorLight || `${user.color}33`,
    });
  }

  private publishPeerId(): void {
    const peerId = this.provider?.room?.peerId;
    if (peerId && this.awareness.getLocalState()?.peerId !== peerId) {
      this.awareness.setLocalStateField("peerId", peerId);
    }
  }

  /** Removes awareness entries that belonged to peers whose connection just closed. */
  private dropAwarenessOfPeers(peerIds: string[]): void {
    const gone = new Set(peerIds);
    const stale: number[] = [];
    this.awareness.getStates().forEach((state, clientID) => {
      const s = state as AwarenessState;
      if (clientID !== this.doc.clientID && s.peerId && gone.has(s.peerId)) {
        stale.push(clientID);
      }
    });
    if (stale.length > 0) {
      removeAwarenessStates(this.awareness, stale, "peer disconnected");
    }
  }

  private readonly handleAwarenessChange = (): void => {
    if (this.isDestroyed) return;
    if (this.mode !== "collab") {
      return;
    }

    const states = this.awareness.getStates();
    const active: number[] = [];
    states.forEach((state, clientID) => {
      if (clientID === this.doc.clientID || (state && Object.keys(state).length > 0)) {
        active.push(clientID);
      }
    });
    if (!active.includes(this.doc.clientID)) {
      active.push(this.doc.clientID);
    }
    active.sort((a, b) => a - b);
    const hostID = active[0];

    this.setHost(CollabManager.computeIsHost(active, this.doc.clientID), { flush: true });

    this.peers = active.map((clientID) => {
      const user = (states.get(clientID) as AwarenessState | undefined)?.user ?? {};
      return {
        clientID,
        name: user.name || "",
        color: user.color || "#3b82f6",
        isHost: clientID === hostID,
        isSelf: clientID === this.doc.clientID,
      };
    });
    this.callbacks?.onPeersChange?.(this.peers);
  };

  private setHost(next: boolean, opts: { flush: boolean }): void {
    if (next === this.isHost) return;
    this.isHost = next;
    this.callbacks?.onHostChange?.(next);
    if (next) {
      // Promoted: consolidate the CRDT on disk right away, the old host may have
      // died with unsaved changes queued.
      this.dirty = true;
      if (opts.flush) {
        void this.flushSave();
      }
    } else if (this.saveTimer) {
      // Demoted: a guest never writes.
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.emitSaveState();
  }

  // ─── Connection diagnostics ───────────────────────────────────────

  private updateDiagnostics(): void {
    if (this.isDestroyed) return;
    const provider = this.provider;
    const signaling: SignalingState[] = (provider?.signalingConns ?? []).map((conn) => ({
      url: conn.url,
      connected: Boolean(conn.connected),
    }));
    const webrtcPeers = provider?.room ? provider.room.webrtcConns.size : 0;
    const bcPeers = provider?.room ? provider.room.bcConns.size : 0;
    const status = computeConnectionStatus({
      hasProvider: provider !== null,
      signalingConnected: signaling.some((s) => s.connected),
      peerCount: webrtcPeers + bcPeers,
      elapsedMs: Date.now() - this.connectStartedAt,
      signalingTimeoutMs: this.signalingTimeoutMs,
    });
    this.diagnostics = { status, signaling, webrtcPeers, bcPeers, synced: this.synced };
    this.status = status;
    this.callbacks?.onStatusChange?.(status, this.diagnostics);
  }

  // ─── Persistence ──────────────────────────────────────────────────

  private readonly handleDocUpdate = (): void => {
    if (this.isDestroyed) return;
    this.dirty = true;
    if (this.canSave()) {
      this.scheduleSave();
    }
    this.emitSaveState();
  };

  /**
   * Only the host writes, and in collab mode only once it holds the swarm's
   * state (synced, or alone in the room). This prevents a freshly joined peer
   * with a low clientID from overwriting main.tex with its stale copy.
   */
  private canSave(): boolean {
    if (this.isDestroyed || !this.isHost) return false;
    if (this.mode === "solo") return true;
    return this.synced || this.remotePeerIds.size === 0;
  }

  private scheduleSave(): void {
    if (!this.canSave()) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.performSave();
    }, this.saveDebounceMs);
  }

  /** Serialized write: a second call while one is in flight waits for it, then re-checks `dirty`. */
  private performSave(): Promise<void> {
    if (this.saveInFlight) {
      return this.saveInFlight.then(() => (this.dirty ? this.performSave() : undefined));
    }
    if (!this.dirty || !this.canSave()) {
      return Promise.resolve();
    }
    this.dirty = false;
    this.saveState = { ...this.saveState, status: "saving", error: null };
    this.emitSaveState();

    const text = this.ytext.toString();
    const write =
      this.mode === "solo"
        ? saveTexAtomic(this.projectPath, this.mainFile, text)
        : saveProjectState(
            this.projectPath,
            this.mainFile,
            text,
            Array.from(Y.encodeStateAsUpdate(this.doc))
          );

    this.saveInFlight = write
      .then(() => {
        this.saveState = { status: "saved", lastSavedAt: Date.now(), error: null };
      })
      .catch((err: unknown) => {
        console.error("CollabManager: save failed:", err);
        this.dirty = true;
        this.saveState = {
          ...this.saveState,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      })
      .then(() => {
        this.saveInFlight = null;
        this.emitSaveState();
        if (this.dirty && this.canSave() && !this.isDestroyed) {
          this.scheduleSave();
        }
      });
    return this.saveInFlight;
  }

  private emitSaveState(): void {
    if (this.isDestroyed) return;
    let status: SaveStatus;
    if (this.mode === "collab" && !this.isHost) {
      status = "guest";
    } else if (this.saveInFlight) {
      status = "saving";
    } else if (this.saveState.error) {
      status = "error";
    } else if (this.dirty) {
      status = "dirty";
    } else {
      status = this.saveState.lastSavedAt ? "saved" : "idle";
    }
    const next: SaveState = { ...this.saveState, status };
    this.saveState = next;
    this.callbacks?.onSaveStateChange?.(next);
  }
}
