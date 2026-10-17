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
// * Signaling is end-to-end encrypted: y-webrtc derives an AES-GCM key from a
//   room password (here: SHA-256 of the room id, the shared secret), so the
//   signaling server, public or ours, only relays opaque blobs.
// * ICE: public STUN by default, plus an optional TURN relay (user setting or
//   build-time env) for peers behind symmetric NATs.
// * Only peers with an open data channel (or a BroadcastChannel) count as
//   connected. y-webrtc lists a peer as soon as it announces itself, before
//   any handshake; a peer that never answers would otherwise show
//   "Connected" and block the host's saves. Such half-open connections are
//   destroyed after a handshake timeout.

import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import * as sha256 from "lib0/hash/sha256";
import * as buffer from "lib0/buffer";
import * as string from "lib0/string";
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
  /** Whether a TURN relay is part of the ICE configuration of this session. */
  turnConfigured: boolean;
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
  /** Room-wide info published by the host (cloud location of the project folder…). */
  onRoomInfoChange?: (info: RoomInfo) => void;
}

/** Shared, CRDT-replicated metadata about the room (a Y.Map named "meta"). */
export interface RoomInfo {
  cloud?: { provider: string; account: string | null };
  hostName?: string;
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
  /** Override the ICE server list (tests / advanced users). */
  iceServers?: RTCIceServer[];
  /** How long a WebRTC connection may stay half-open before it is dropped. Default 20000 ms. */
  handshakeTimeoutMs?: number;
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

// ─── Encrypted signaling ──────────────────────────────────────────

/**
 * Password handed to y-webrtc so every signaling message (SDP offers, ICE
 * candidates, awareness announcements) is AES-GCM encrypted between peers.
 * The room id is already the shared secret, so the password is derived from it
 * instead of asking the user for a second one. Hashing (synchronous, lib0)
 * keeps the raw id out of the key derivation input; y-webrtc then runs PBKDF2
 * over it with the room name as salt.
 */
export function deriveRoomPassword(roomId: string): string {
  return buffer.toHexString(sha256.digest(string.encodeUtf8(`latexp2p:${roomId}`)));
}

// ─── ICE (STUN / TURN) configuration ─────────────────────────────

export interface TurnConfig {
  /** One or more `turn:` / `turns:` URLs, comma separated. */
  url: string;
  username: string;
  credential: string;
}

/** localStorage key holding the user-configured TURN server (JSON `TurnConfig`). */
export const TURN_OVERRIDE_KEY = "latex_turn_server";

/** Public STUN servers. Enough for peers behind ordinary (non-symmetric) NATs. */
export const DEFAULT_STUN_SERVERS = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];

const TURN_URL_RE = /^turns?:/i;

/** Splits a comma separated URL list and keeps only `turn:` / `turns:` entries. */
export function parseTurnUrls(raw: string): string[] {
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => TURN_URL_RE.test(u));
}

/** Validates a TURN entry (from localStorage JSON, env or UI). Returns null when unusable. */
export function parseTurnConfig(raw: unknown): TurnConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === "string" ? parseTurnUrls(r.url).join(",") : "";
  if (!url) return null;
  return {
    url,
    username: typeof r.username === "string" ? r.username.trim() : "",
    credential: typeof r.credential === "string" ? r.credential : "",
  };
}

export function readTurnOverride(): TurnConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(TURN_OVERRIDE_KEY);
    return raw ? parseTurnConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Build-time TURN relay: `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`. */
export function readTurnFromEnv(): TurnConfig | null {
  return parseTurnConfig({
    url: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USERNAME,
    credential: import.meta.env.VITE_TURN_CREDENTIAL,
  });
}

/** Pure builder, kept separate so it can be unit-tested. */
export function buildIceServers(input: { stun?: string[]; turn?: TurnConfig | null } = {}): RTCIceServer[] {
  const stun = (input.stun ?? DEFAULT_STUN_SERVERS).filter((u) => /^stuns?:/i.test(u));
  const servers: RTCIceServer[] = stun.length > 0 ? [{ urls: stun }] : [];
  if (input.turn) {
    const urls = parseTurnUrls(input.turn.url);
    if (urls.length > 0) {
      servers.push({
        urls: urls.length === 1 ? urls[0] : urls,
        username: input.turn.username,
        credential: input.turn.credential,
      });
    }
  }
  return servers;
}

/**
 * ICE servers for the next connection: Google STUN plus, in order of
 * precedence, the TURN relay configured in the UI (localStorage) or the one
 * baked in at build time. Without a TURN relay two peers behind symmetric NATs
 * cannot connect.
 */
export function getIceServers(): RTCIceServer[] {
  return buildIceServers({ turn: readTurnOverride() ?? readTurnFromEnv() });
}

/** True when at least one `turn:`/`turns:` URL is present in the list. */
export function hasTurnServer(servers: RTCIceServer[]): boolean {
  return servers.some((s) => {
    const urls = typeof s.urls === "string" ? [s.urls] : s.urls;
    return urls.some((u) => TURN_URL_RE.test(u));
  });
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

/** The parts of y-webrtc's WebrtcConn (and its simple-peer instance) used here. */
interface WebrtcConnLike {
  connected: boolean;
  closed: boolean;
  peer?: {
    on(event: string, handler: () => void): void;
    removeListener(event: string, handler: () => void): void;
    destroy(): void;
  };
}

interface ConnWatch {
  timer: ReturnType<typeof setTimeout> | null;
  cleanup: Unsubscribe;
}

/** Remote peers with an open WebRTC data channel, plus BroadcastChannel peers. */
export function connectedPeerIds(room: {
  webrtcConns: Map<string, { connected: boolean }>;
  bcConns: Set<string>;
}): Set<string> {
  const ids = new Set<string>(room.bcConns);
  room.webrtcConns.forEach((conn, id) => {
    if (conn.connected) ids.add(id);
  });
  return ids;
}

/**
 * Manages the Yjs CRDT document, WebRTC P2P sync, awareness, dynamic host election
 * and conflict-free cloud persistence with dual-mode operation (Solo vs Collab).
 */
export class CollabManager {
  public readonly doc: Y.Doc;
  /** Replicated room metadata; see [`RoomInfo`]. */
  public readonly meta: Y.Map<RoomInfo[keyof RoomInfo]>;
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
    turnConfigured: false,
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
  private readonly iceServersOverride?: RTCIceServer[];
  private readonly handshakeTimeoutMs: number;
  private turnConfigured = false;

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
  private connWatches = new Map<WebrtcConnLike, ConnWatch>();

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
    this.iceServersOverride = config.options?.iceServers;
    this.handshakeTimeoutMs = config.options?.handshakeTimeoutMs ?? 20000;

    this.doc = new Y.Doc();
    this.ytext = this.doc.getText(TEXT_KEY);
    this.meta = this.doc.getMap<RoomInfo[keyof RoomInfo]>("meta");
    this.meta.observe(this.handleMetaChange);
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

  /** Room metadata as currently replicated. */
  public getRoomInfo(): RoomInfo {
    const info: RoomInfo = {};
    const cloud = this.meta.get("cloud") as RoomInfo["cloud"] | undefined;
    const hostName = this.meta.get("hostName") as string | undefined;
    if (cloud) info.cloud = cloud;
    if (hostName) info.hostName = hostName;
    return info;
  }

  /**
   * Publishes room metadata to every peer. Any peer whose folder is in a cloud
   * may call it; only a cloud location (not "local") is written, and never over
   * an existing one, so a peer in a temporary workspace cannot erase it.
   */
  public setRoomInfo(info: RoomInfo): void {
    this.doc.transact(() => {
      if (info.cloud && info.cloud.provider !== "local") {
        const current = this.meta.get("cloud") as RoomInfo["cloud"] | undefined;
        if (!current || current.provider === "local") this.meta.set("cloud", info.cloud);
      }
      if (info.hostName) this.meta.set("hostName", info.hostName);
    }, "room-info");
  }

  private readonly handleMetaChange = (): void => {
    if (this.isDestroyed) return;
    this.callbacks?.onRoomInfoChange?.(this.getRoomInfo());
  };

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
      this.meta.unobserve(this.handleMetaChange);
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

    const iceServers = this.iceServersOverride ?? getIceServers();
    this.turnConfigured = hasTurnServer(iceServers);
    const provider = new WebrtcProvider(roomId, this.doc, {
      signaling: this.signalingOverride ?? getSignalingServers(),
      // End-to-end encrypted signaling (see deriveRoomPassword).
      password: deriveRoomPassword(roomId),
      awareness: this.awareness,
      maxConns: 30,
      filterBcConns: false, // instant sync across windows of the same app
      // simple-peer options: STUN/TURN for the RTCPeerConnection.
      peerOpts: { config: { iceServers } },
    });
    this.provider = provider;

    const onStatus = () => {
      if (this.provider !== provider) return;
      this.publishPeerId();
      this.watchWebrtcConns(provider);
      this.refreshRemotePeers(provider, []);
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
      this.watchWebrtcConns(provider);
      this.refreshRemotePeers(provider, event.removed);
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
    this.unwatchConns(Array.from(this.connWatches.keys()));
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

  // ─── WebRTC connection tracking ───────────────────────────────────

  /**
   * Recomputes the connected remote peers. Awareness entries of peers that just
   * left (`removed`) or whose connection is no longer open are dropped.
   */
  private refreshRemotePeers(provider: WebrtcProvider, removed: string[]): void {
    const next = provider.room ? connectedPeerIds(provider.room) : new Set<string>();
    const gone = new Set(removed.filter((id) => !next.has(id)));
    this.remotePeerIds.forEach((id) => {
      if (!next.has(id)) gone.add(id);
    });
    this.remotePeerIds = next;
    if (gone.size > 0) {
      this.dropAwarenessOfPeers(Array.from(gone));
    }
    this.updateDiagnostics();
    this.handleAwarenessChange();
  }

  /**
   * Follows every WebrtcConn of the room: y-webrtc emits "peers" when a conn is
   * created or closed but not when its handshake completes, so the connect
   * event is observed here. A conn still half-open after the handshake timeout
   * is destroyed; y-webrtc's own close handler then removes it from the room.
   */
  private watchWebrtcConns(provider: WebrtcProvider): void {
    const conns = new Set<WebrtcConnLike>(
      provider.room ? (Array.from(provider.room.webrtcConns.values()) as WebrtcConnLike[]) : []
    );
    this.unwatchConns(Array.from(this.connWatches.keys()).filter((conn) => !conns.has(conn)));
    conns.forEach((conn) => {
      if (this.connWatches.has(conn) || conn.closed) return;
      const peer = conn.peer;
      const onChange = () => {
        if (this.provider !== provider) return;
        if (conn.connected) this.clearConnTimer(conn);
        this.refreshRemotePeers(provider, []);
      };
      peer?.on("connect", onChange);
      peer?.on("close", onChange);
      const watch: ConnWatch = {
        timer: null,
        cleanup: () => {
          peer?.removeListener("connect", onChange);
          peer?.removeListener("close", onChange);
        },
      };
      if (!conn.connected) {
        watch.timer = setTimeout(() => {
          watch.timer = null;
          if (this.provider !== provider || conn.connected || conn.closed) return;
          console.warn("CollabManager: dropping a WebRTC peer that never completed its handshake");
          try {
            peer?.destroy();
          } catch (err) {
            console.error("CollabManager: error destroying half-open connection:", err);
          }
        }, this.handshakeTimeoutMs);
      }
      this.connWatches.set(conn, watch);
    });
  }

  private clearConnTimer(conn: WebrtcConnLike): void {
    const watch = this.connWatches.get(conn);
    if (watch?.timer) {
      clearTimeout(watch.timer);
      watch.timer = null;
    }
  }

  private unwatchConns(conns: WebrtcConnLike[]): void {
    for (const conn of conns) {
      this.clearConnTimer(conn);
      try {
        this.connWatches.get(conn)?.cleanup();
      } catch {
        // peer already gone
      }
      this.connWatches.delete(conn);
    }
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
    // Only open connections count: a peer that announced itself but never
    // completed the handshake is not "connected".
    let webrtcPeers = 0;
    provider?.room?.webrtcConns.forEach((conn) => {
      if (conn.connected) webrtcPeers++;
    });
    const bcPeers = provider?.room ? provider.room.bcConns.size : 0;
    const status = computeConnectionStatus({
      hasProvider: provider !== null,
      signalingConnected: signaling.some((s) => s.connected),
      peerCount: webrtcPeers + bcPeers,
      elapsedMs: Date.now() - this.connectStartedAt,
      signalingTimeoutMs: this.signalingTimeoutMs,
    });
    this.diagnostics = {
      status,
      signaling,
      webrtcPeers,
      bcPeers,
      synced: this.synced,
      turnConfigured: provider !== null && this.turnConfigured,
    };
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
