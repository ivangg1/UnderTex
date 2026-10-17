import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as sha256 from "lib0/hash/sha256";
import * as buffer from "lib0/buffer";
import {
  ASSETS_KEY,
  ASSET_CHUNKS_KEY,
  ASSET_REQUESTS_KEY,
  ASSET_CHUNK_BYTES,
  ASSET_WINDOW,
  ASSET_ORIGIN,
  explainMissingAsset,
  isAssetOnlyTransaction,
  missingFilesInLog,
  type AssetEntry,
  type AssetIO,
  type AssetSyncStatus,
  type ManifestEntry,
} from "../services/assetSync";
import {
  CollabManager,
  computeConnectionStatus,
  connectedPeerIds,
  getSignalingServers,
  DEFAULT_SIGNALING_SERVERS,
  SIGNALING_OVERRIDE_KEY,
  deriveRoomPassword,
  buildIceServers,
  parseTurnConfig,
  parseTurnUrls,
  getIceServers,
  hasTurnServer,
  DEFAULT_STUN_SERVERS,
  TURN_OVERRIDE_KEY,
  type SaveState,
  type ConnectionStatus,
} from "../services/collabManager";
import * as tauriBridge from "../services/tauriBridge";

// ─── Mocks ──────────────────────────────────────────────────────────

vi.mock("../services/tauriBridge", () => ({
  saveTexAtomic: vi.fn().mockResolvedValue(true),
  saveProjectState: vi.fn().mockResolvedValue(true),
  initCollabProject: vi.fn().mockResolvedValue({ room_id: "room-uuid-abc-123", main_file: "main.tex" }),
  assetList: vi.fn().mockResolvedValue([]),
  assetCacheList: vi.fn().mockResolvedValue([]),
  assetReadChunk: vi.fn().mockResolvedValue(new Uint8Array()),
  assetCacheStore: vi.fn(),
  assetCachePrune: vi.fn().mockResolvedValue(0),
}));

const { MockWebrtcProvider, MockSignalingConn } = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;

  class MockObservable {
  private listeners = new Map<string, Set<Handler>>();
  on(event: string, handler: Handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }
  off(event: string, handler: Handler) {
    this.listeners.get(event)?.delete(handler);
  }
  emit(event: string, args: unknown[]) {
    Array.from(this.listeners.get(event) ?? []).forEach((h) => h(...args));
  }
  listenerCount(event: string) {
    return this.listeners.get(event)?.size ?? 0;
  }
}

  class MockSignalingConn extends MockObservable {
  connected = false;
  constructor(public url: string) {
    super();
  }
  setConnected(value: boolean) {
    this.connected = value;
    this.emit(value ? "connect" : "disconnect", [{}]);
  }
}

  /** simple-peer stand-in: node-style events, destroy() closes asynchronously. */
  class MockPeer {
    private handlers = new Map<string, Set<() => void>>();
    destroyed = false;
    on(event: string, handler: () => void) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    }
    removeListener(event: string, handler: () => void) {
      this.handlers.get(event)?.delete(handler);
    }
    emit(event: string) {
      Array.from(this.handlers.get(event) ?? []).forEach((h) => h());
    }
    destroy = vi.fn(() => {
      if (this.destroyed) return;
      this.destroyed = true;
      queueMicrotask(() => this.emit("close"));
    });
  }

  /** y-webrtc WebrtcConn stand-in, including its close handler. */
  class MockWebrtcConn {
    connected = false;
    closed = false;
    peer = new MockPeer();
    constructor(provider: MockWebrtcProvider, remotePeerId: string) {
      this.peer.on("connect", () => {
        this.connected = true;
      });
      this.peer.on("close", () => {
        this.connected = false;
        this.closed = true;
        if (provider.room.webrtcConns.get(remotePeerId) === this) {
          provider.room.webrtcConns.delete(remotePeerId);
          provider.emitPeers([], [remotePeerId]);
        }
      });
    }
  }

  let providerSeq = 0;

  class MockWebrtcProvider extends MockObservable {
  static instances: MockWebrtcProvider[] = [];
  public room: { peerId: string; webrtcConns: Map<string, MockWebrtcConn>; bcConns: Set<string> };
  public signalingConns: MockSignalingConn[];
  public destroyed = false;
  public destroy = vi.fn(() => {
    this.destroyed = true;
  });

  constructor(
    public roomName: string,
    public doc: Y.Doc,
    public opts: {
      signaling: string[];
      awareness: Awareness;
      password?: string;
      peerOpts?: { config?: { iceServers?: RTCIceServer[] } };
    }
  ) {
    super();
    this.room = { peerId: `peer-${++providerSeq}`, webrtcConns: new Map(), bcConns: new Set() };
    this.signalingConns = (opts.signaling ?? []).map((url) => new MockSignalingConn(url));
    MockWebrtcProvider.instances.push(this);
  }

  get awareness() {
    return this.opts.awareness;
  }

  emitPeers(added: string[], removed: string[]) {
    this.emit("peers", [
      {
        added,
        removed,
        webrtcPeers: Array.from(this.room.webrtcConns.keys()),
        bcPeers: Array.from(this.room.bcConns),
      },
    ]);
  }

  /**
   * Simulates y-webrtc receiving an "announce": a conn is created and listed in
   * the 'peers' event before any handshake happened.
   */
  announcePeer(peerId: string): MockWebrtcConn {
    const conn = new MockWebrtcConn(this, peerId);
    this.room.webrtcConns.set(peerId, conn);
    this.emitPeers([peerId], []);
    return conn;
  }

  /** The handshake of an announced peer completes (simple-peer 'connect'). */
  completeHandshake(peerId: string) {
    this.room.webrtcConns.get(peerId)!.peer.emit("connect");
  }

  /** Simulates y-webrtc: a remote peer announces itself and connects. */
  connectPeer(peerId: string) {
    this.announcePeer(peerId);
    this.completeHandshake(peerId);
    this.emit("status", [{ connected: true }]);
  }

  disconnectPeer(peerId: string) {
    this.room.webrtcConns.get(peerId)?.peer.emit("close");
  }

  markSynced(synced = true) {
    this.emit("synced", [{ synced }]);
  }
}

  return { MockWebrtcProvider, MockSignalingConn };
});
type MockWebrtcProvider = InstanceType<typeof MockWebrtcProvider>;
type MockSignalingConn = InstanceType<typeof MockSignalingConn>;

vi.mock("y-webrtc", () => ({
  WebrtcProvider: MockWebrtcProvider,
}));

// ─── Helpers ────────────────────────────────────────────────────────

const TEX = "\\documentclass{article}\n\\begin{document}\nShared project\n\\end{document}";

function makeManager(overrides: Partial<ConstructorParameters<typeof CollabManager>[0]> = {}) {
  const saveStates: SaveState[] = [];
  const statuses: ConnectionStatus[] = [];
  const hostChanges: boolean[] = [];
  const manager = new CollabManager({
    projectPath: "/path/to/project",
    mainFile: "main.tex",
    isCollab: false,
    roomId: null,
    initialTexContent: TEX,
    initialCrdtState: null,
    currentUser: { name: "Alice", color: "#ef4444" },
    options: { signaling: ["wss://sig-a.test", "wss://sig-b.test"] },
    callbacks: {
      onSaveStateChange: (s) => saveStates.push(s),
      onStatusChange: (s) => statuses.push(s),
      onHostChange: (h) => hostChanges.push(h),
    },
    ...overrides,
  });
  return { manager, saveStates, statuses, hostChanges };
}

/** Exchanges document updates and awareness states between two managers (what WebRTC would do). */
function sync(a: CollabManager, b: CollabManager) {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), "remote");
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), "remote");
  applyAwarenessUpdate(b.awareness, encodeAwarenessUpdate(a.awareness, [a.doc.clientID]), "remote");
  applyAwarenessUpdate(a.awareness, encodeAwarenessUpdate(b.awareness, [b.doc.clientID]), "remote");
}

const latestProvider = () => MockWebrtcProvider.instances[MockWebrtcProvider.instances.length - 1];
/** Reference SHA-256 (Web Crypto) to cross-check the synchronous lib0 implementation. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  MockWebrtcProvider.instances = [];
  vi.mocked(tauriBridge.saveTexAtomic).mockResolvedValue(true);
  vi.mocked(tauriBridge.saveProjectState).mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("Solo mode persistence", () => {
  it("opens in solo mode with zero network, seeds from main.tex and saves only after the debounce", async () => {
    const { manager, saveStates } = makeManager();
    expect(manager.mode).toBe("solo");
    expect(manager.isHost).toBe(true);
    expect(manager.provider).toBeNull();
    expect(MockWebrtcProvider.instances).toHaveLength(0);
    expect(manager.getText()).toBe(TEX);

    manager.ytext.insert(TEX.indexOf("\\end"), "\\section{Draft}\n");
    await vi.advanceTimersByTimeAsync(1000);
    expect(tauriBridge.saveTexAtomic).not.toHaveBeenCalled();
    expect(saveStates.at(-1)?.status).toBe("dirty");

    manager.ytext.insert(0, "% more\n"); // resets the debounce
    await vi.advanceTimersByTimeAsync(1000);
    expect(tauriBridge.saveTexAtomic).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledTimes(1);
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledWith(
      "/path/to/project",
      "main.tex",
      expect.stringContaining("\\section{Draft}")
    );
    expect(tauriBridge.saveProjectState).not.toHaveBeenCalled();
    expect(saveStates.at(-1)?.status).toBe("saved");
    expect(saveStates.at(-1)?.lastSavedAt).not.toBeNull();

    // Nothing changed since: no further writes, ever.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledTimes(1);
    manager.destroy();
  });

  it("never runs two writes concurrently and re-saves edits made during an in-flight write", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    vi.mocked(tauriBridge.saveTexAtomic).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          resolvers.push(() => {
            inFlight -= 1;
            resolve(true);
          });
        })
    );
    const { manager } = makeManager();

    manager.ytext.insert(0, "a");
    await vi.advanceTimersByTimeAsync(1500);
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledTimes(1);

    // Edit while the first write is still pending, and force a flush on top.
    manager.ytext.insert(0, "b");
    const flush = manager.flushSave();
    await vi.advanceTimersByTimeAsync(1500);
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledTimes(1); // still queued behind the first

    resolvers.shift()!(); // first write completes → the queued write starts
    await tick();
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledTimes(2);
    expect(vi.mocked(tauriBridge.saveTexAtomic).mock.calls[1][2]).toMatch(/^ba/);
    expect(maxInFlight).toBe(1);
    resolvers.shift()!();
    await flush;
    await vi.advanceTimersByTimeAsync(3000);
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledTimes(2); // nothing left to save
    manager.destroy();
  });

  it("dispose() flushes the pending debounced save before tearing down (switching projects)", async () => {
    const { manager } = makeManager();
    manager.ytext.insert(0, "% last-second edit\n");
    await vi.advanceTimersByTimeAsync(200); // well inside the 1.5 s window

    await manager.dispose();
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledTimes(1);
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledWith(
      "/path/to/project",
      "main.tex",
      expect.stringContaining("% last-second edit")
    );

    // destroy() alone is the fast path and must not write afterwards.
    const second = makeManager().manager;
    second.ytext.insert(0, "x");
    second.destroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledTimes(1);
  });

  it("keeps the document dirty and retries when a write fails", async () => {
    vi.mocked(tauriBridge.saveTexAtomic).mockRejectedValueOnce("disk full");
    const { manager, saveStates } = makeManager();
    manager.ytext.insert(0, "x");
    await vi.advanceTimersByTimeAsync(1500);
    expect(saveStates.at(-1)?.status).toBe("error");
    expect(saveStates.at(-1)?.error).toBe("disk full");

    await vi.advanceTimersByTimeAsync(1500); // automatic retry
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledTimes(2);
    expect(saveStates.at(-1)?.status).toBe("saved");
    manager.destroy();
  });
});

describe("Room info (cloud location) replication", () => {
  it("replicates the host's cloud location to guests and never lets a local workspace overwrite it", () => {
    const host = makeManager({ isCollab: true, roomId: "room-cloud" });
    const guest = makeManager({ isCollab: true, roomId: "room-cloud" });
    const seen: unknown[] = [];
    guest.manager.destroy(); // rebuild with a callback
    const guestWithCb = new CollabManager({
      projectPath: "/tmp/rooms/room-cloud",
      mainFile: "main.tex",
      isCollab: true,
      roomId: "room-cloud",
      initialTexContent: "",
      initialCrdtState: null,
      currentUser: { name: "G", color: "#000" },
      options: { signaling: [] },
      callbacks: { onRoomInfoChange: (info) => seen.push(info) },
    });

    host.manager.setRoomInfo({ cloud: { provider: "google_drive", account: "ana@gmail.com" }, hostName: "Ana" });
    sync(host.manager, guestWithCb);
    expect(guestWithCb.getRoomInfo()).toEqual({ cloud: { provider: "google_drive", account: "ana@gmail.com" }, hostName: "Ana" });
    expect(seen.at(-1)).toEqual({ cloud: { provider: "google_drive", account: "ana@gmail.com" }, hostName: "Ana" });

    // A guest in a local workspace (promoted or not) cannot replace the cloud entry.
    guestWithCb.setRoomInfo({ cloud: { provider: "local", account: null } });
    sync(host.manager, guestWithCb);
    expect(host.manager.getRoomInfo().cloud?.provider).toBe("google_drive");
    // Another cloud location does not override the first either.
    guestWithCb.setRoomInfo({ cloud: { provider: "dropbox", account: null } });
    sync(host.manager, guestWithCb);
    expect(host.manager.getRoomInfo().cloud?.provider).toBe("google_drive");

    host.manager.destroy();
    guestWithCb.destroy();
  });
});

describe("Restoring a version", () => {
  it("replaceText applies minimal edits, marks the doc dirty and saves like a normal edit", async () => {
    const { manager, saveStates } = makeManager();
    const restored = TEX.replace("Shared project", "Restored content");
    const ops = manager.replaceText(restored);
    expect(ops).toBeGreaterThan(0);
    expect(manager.getText()).toBe(restored);
    expect(saveStates.at(-1)?.status).toBe("dirty");
    await vi.advanceTimersByTimeAsync(1500);
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledWith("/path/to/project", "main.tex", restored);
    expect(manager.replaceText(restored)).toBe(0);
    manager.destroy();
  });
});

describe("Solo ⇄ Collab transitions", () => {
  it("hot-attaches a provider without losing the document and tears it down cleanly", async () => {
    const { manager } = makeManager();
    manager.ytext.insert(0, "% edited before collab\n");

    const roomId = await manager.startCollaboration();
    expect(roomId).toBe("room-uuid-abc-123");
    expect(tauriBridge.initCollabProject).toHaveBeenCalledWith("/path/to/project", "main.tex", null);
    expect(tauriBridge.saveProjectState).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tauriBridge.saveProjectState).mock.calls[0][2]).toContain("% edited before collab");
    expect(manager.mode).toBe("collab");
    expect(manager.provider).not.toBeNull();
    expect(latestProvider().roomName).toBe("room-uuid-abc-123");
    expect(latestProvider().opts.awareness).toBe(manager.awareness);
    expect(manager.getText()).toContain("% edited before collab");
    expect(manager.getText()).toContain("Shared project");

    const provider = latestProvider();
    await manager.stopCollaboration();
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(manager.mode).toBe("solo");
    expect(manager.provider).toBeNull();
    expect(manager.isHost).toBe(true);
    expect(manager.status).toBe("disconnected");
    expect(manager.getText()).toContain("% edited before collab");
    manager.destroy();
  });

  it("does not leak awareness listeners or stale remote states across start/stop cycles", async () => {
    const { manager } = makeManager();
    const observers = () =>
      ((manager.awareness as unknown as { _observers: Map<string, Set<unknown>> })._observers.get("change")?.size ?? 0);
    const baseline = observers();

    for (let i = 0; i < 3; i++) {
      await manager.startCollaboration();
      // A (different) remote peer shows up in awareness.
      const remoteID = manager.doc.clientID - 1 - i;
      const remote = new Y.Doc();
      remote.clientID = remoteID;
      const remoteAwareness = new Awareness(remote);
      remoteAwareness.setLocalStateField("user", { name: "Remote", color: "#000" });
      applyAwarenessUpdate(manager.awareness, encodeAwarenessUpdate(remoteAwareness, [remoteID]), "remote");
      expect(manager.isHost).toBe(false);
      expect(manager.awareness.getStates().size).toBe(2);

      await manager.stopCollaboration();
      expect(manager.awareness.getStates().size).toBe(1);
      expect(manager.isHost).toBe(true);
      expect(observers()).toBe(baseline);
      remoteAwareness.destroy();
      remote.destroy();
    }
    manager.destroy();
  });
});

describe("Host election and failover (SPEC 4.A)", () => {
  it("computeIsHost picks the lowest clientID and survives host departure", () => {
    expect(CollabManager.computeIsHost([1050, 402, 9999], 402)).toBe(true);
    expect(CollabManager.computeIsHost([1050, 402, 9999], 1050)).toBe(false);
    expect(CollabManager.computeIsHost([350, 500], 350)).toBe(true);
    expect(CollabManager.computeIsHost([777], 777)).toBe(true);
    expect(CollabManager.computeIsHost([], 777)).toBe(true);
  });

  it("elects the host from awareness alone: guests never write, the host writes both files", async () => {
    const a = makeManager({ isCollab: true, roomId: "room-1", currentUser: { name: "A", color: "#111" } });
    const b = makeManager({ isCollab: true, roomId: "room-1", currentUser: { name: "B", color: "#222" } });
    await tick();
    const [pa, pb] = MockWebrtcProvider.instances;
    pa.connectPeer(pb.room.peerId);
    pb.connectPeer(pa.room.peerId);
    sync(a.manager, b.manager);
    pa.markSynced();
    pb.markSynced();
    await tick();

    const host = a.manager.doc.clientID < b.manager.doc.clientID ? a : b;
    const guest = host === a ? b : a;
    expect(host.manager.isHost).toBe(true);
    expect(guest.manager.isHost).toBe(false);
    expect(host.manager.peers.map((p) => [p.name, p.isHost])).toEqual(
      expect.arrayContaining([
        [host.manager === a.manager ? "A" : "B", true],
        [guest.manager === a.manager ? "A" : "B", false],
      ])
    );
    expect(guest.saveStates.at(-1)?.status).toBe("guest");
    // Both seeded deterministically on sync; only the host persisted the seed.
    await vi.advanceTimersByTimeAsync(1500);
    expect(tauriBridge.saveProjectState).toHaveBeenCalledTimes(1);
    expect(host.manager.getText()).toBe(TEX);
    expect(guest.manager.getText()).toBe(TEX);
    vi.mocked(tauriBridge.saveProjectState).mockClear();

    guest.manager.ytext.insert(0, "% guest edit\n");
    await vi.advanceTimersByTimeAsync(2000);
    expect(tauriBridge.saveProjectState).not.toHaveBeenCalled();
    expect(tauriBridge.saveTexAtomic).not.toHaveBeenCalled();

    sync(a.manager, b.manager);
    await vi.advanceTimersByTimeAsync(1500);
    expect(tauriBridge.saveProjectState).toHaveBeenCalledTimes(1);
    expect(tauriBridge.saveProjectState).toHaveBeenCalledWith(
      "/path/to/project",
      "main.tex",
      expect.stringContaining("% guest edit"),
      expect.any(Array)
    );
    a.manager.destroy();
    b.manager.destroy();
  });

  it("promotes the guest immediately when the host's connection closes and flushes without waiting for the debounce", async () => {
    const a = makeManager({ isCollab: true, roomId: "room-2" });
    const b = makeManager({ isCollab: true, roomId: "room-2" });
    await tick();
    const [pa, pb] = MockWebrtcProvider.instances;
    pa.connectPeer(pb.room.peerId);
    pb.connectPeer(pa.room.peerId);
    sync(a.manager, b.manager);
    pa.markSynced();
    pb.markSynced();
    await tick();

    const host = a.manager.doc.clientID < b.manager.doc.clientID ? a : b;
    const guest = host === a ? b : a;
    const hostProvider = host === a ? pa : pb;
    const guestProvider = guest === a ? pa : pb;
    expect(guest.manager.isHost).toBe(false);
    vi.mocked(tauriBridge.saveProjectState).mockClear();

    // Host's WebRTC connection drops (no clean awareness removal, as in a crash).
    guestProvider.disconnectPeer(hostProvider.room.peerId);
    await tick();

    expect(guest.manager.isHost).toBe(true);
    expect(guest.hostChanges.at(-1)).toBe(true);
    expect(guest.manager.awareness.getStates().has(host.manager.doc.clientID)).toBe(false);
    // Consolidation happened right away (flush), not after 1.5 s.
    expect(tauriBridge.saveProjectState).toHaveBeenCalledTimes(1);
    a.manager.destroy();
    b.manager.destroy();
  });

  it("demotes a host when a lower clientID appears and cancels its pending save", async () => {
    const { manager } = makeManager({ isCollab: true, roomId: "room-3" });
    await tick();
    const provider = latestProvider();
    expect(manager.isHost).toBe(true);
    vi.mocked(tauriBridge.saveProjectState).mockClear();

    manager.ytext.insert(0, "% host edit\n");
    await vi.advanceTimersByTimeAsync(500);

    const lower = new Y.Doc();
    lower.clientID = manager.doc.clientID - 1;
    const lowerAwareness = new Awareness(lower);
    lowerAwareness.setLocalStateField("user", { name: "Lower", color: "#333" });
    lowerAwareness.setLocalStateField("peerId", "peer-lower");
    provider.connectPeer("peer-lower");
    applyAwarenessUpdate(manager.awareness, encodeAwarenessUpdate(lowerAwareness, [lower.clientID]), "remote");
    expect(manager.isHost).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(tauriBridge.saveProjectState).not.toHaveBeenCalled();

    lowerAwareness.destroy();
    lower.destroy();
    manager.destroy();
  });

  it("a freshly joined low-ID host does not write until it is synced with the swarm", async () => {
    const { manager } = makeManager({ isCollab: true, roomId: "room-4", initialCrdtState: null });
    await tick();
    const provider = latestProvider();
    provider.connectPeer("peer-x"); // someone is there, but we have not synced yet
    vi.mocked(tauriBridge.saveProjectState).mockClear();

    expect(manager.isHost).toBe(true); // alone in awareness → host by election
    manager.ytext.insert(0, "% local\n");
    await vi.advanceTimersByTimeAsync(3000);
    expect(tauriBridge.saveProjectState).not.toHaveBeenCalled();

    provider.markSynced();
    await vi.advanceTimersByTimeAsync(1500);
    expect(tauriBridge.saveProjectState).toHaveBeenCalledTimes(1);
    manager.destroy();
  });
});

describe("Joining a room: seeding without duplication (SPEC 4.B)", () => {
  it("adopts the swarm's document instead of seeding its own stale main.tex", async () => {
    const hostDoc = new Y.Doc();
    hostDoc.getText("codemirror").insert(0, "% swarm version\n");

    const { manager } = makeManager({
      isCollab: true,
      roomId: "room-5",
      initialTexContent: "% stale local version\n",
      initialCrdtState: null,
    });
    await tick();
    expect(manager.getText()).toBe(""); // waiting for the swarm

    const provider = latestProvider();
    provider.connectPeer("peer-host");
    Y.applyUpdate(manager.doc, Y.encodeStateAsUpdate(hostDoc), "remote");
    provider.markSynced();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(manager.getText()).toBe("% swarm version\n");
    manager.destroy();
    hostDoc.destroy();
  });

  it("seeds from main.tex after the wait when nobody else is in the room", async () => {
    const { manager } = makeManager({
      isCollab: true,
      roomId: "room-6",
      initialCrdtState: null,
      options: { signaling: [], seedWaitMs: 1000 },
    });
    await tick();
    expect(manager.getText()).toBe("");
    await vi.advanceTimersByTimeAsync(999);
    expect(manager.getText()).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.getText()).toBe(TEX);
    manager.destroy();
  });

  it("two peers that both seed from the same main.tex converge to a single copy", async () => {
    const a = makeManager({ isCollab: true, roomId: "room-7", options: { signaling: [], seedWaitMs: 100 } });
    const b = makeManager({ isCollab: true, roomId: "room-7", options: { signaling: [], seedWaitMs: 100 } });
    await vi.advanceTimersByTimeAsync(100);
    expect(a.manager.getText()).toBe(TEX);
    expect(b.manager.getText()).toBe(TEX);

    sync(a.manager, b.manager);
    expect(a.manager.getText()).toBe(TEX);
    expect(b.manager.getText()).toBe(TEX);
    a.manager.destroy();
    b.manager.destroy();
  });

  it("restores persisted crdt_state.bin and ignores main.tex when the state is non-empty", () => {
    const persisted = new Y.Doc();
    persisted.getText("codemirror").insert(0, "% from crdt_state.bin\n");
    const { manager } = makeManager({
      isCollab: true,
      roomId: "room-8",
      initialTexContent: "% from main.tex (older)\n",
      initialCrdtState: Array.from(Y.encodeStateAsUpdate(persisted)),
    });
    expect(manager.getText()).toBe("% from crdt_state.bin\n");
    manager.destroy();
    persisted.destroy();
  });
});

describe("Connection diagnostics", () => {
  it("computeConnectionStatus covers every state", () => {
    const base = { hasProvider: true, signalingConnected: false, peerCount: 0, elapsedMs: 0, signalingTimeoutMs: 10_000 };
    expect(computeConnectionStatus({ ...base, hasProvider: false })).toBe("disconnected");
    expect(computeConnectionStatus(base)).toBe("connecting");
    expect(computeConnectionStatus({ ...base, elapsedMs: 10_000 })).toBe("unreachable");
    expect(computeConnectionStatus({ ...base, signalingConnected: true, elapsedMs: 99_999 })).toBe("waiting");
    expect(computeConnectionStatus({ ...base, peerCount: 1 })).toBe("connected");
  });

  it("reports connecting → unreachable → waiting → connected from real provider signals", async () => {
    const { manager, statuses } = makeManager({
      isCollab: true,
      roomId: "room-9",
      options: { signaling: ["wss://sig-a.test", "wss://sig-b.test"], signalingTimeoutMs: 2000 },
    });
    await tick();
    expect(manager.status).toBe("connecting");
    expect(manager.diagnostics.signaling).toEqual([
      { url: "wss://sig-a.test", connected: false },
      { url: "wss://sig-b.test", connected: false },
    ]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(manager.status).toBe("unreachable");

    const provider = latestProvider();
    provider.signalingConns[1].setConnected(true);
    expect(manager.status).toBe("waiting");
    expect(manager.diagnostics.signaling[1].connected).toBe(true);

    provider.connectPeer("peer-z");
    expect(manager.status).toBe("connected");
    expect(manager.diagnostics.webrtcPeers).toBe(1);

    provider.disconnectPeer("peer-z");
    expect(manager.status).toBe("waiting");
    expect(statuses).toEqual(expect.arrayContaining(["connecting", "unreachable", "waiting", "connected"]));

    await manager.stopCollaboration();
    expect(manager.status).toBe("disconnected");
    manager.destroy();
  });
});

describe("Half-open WebRTC peers (announce without handshake)", () => {
  it("counts only connected WebRTC conns and BroadcastChannel peers", () => {
    const room = {
      webrtcConns: new Map([
        ["open", { connected: true }],
        ["pending", { connected: false }],
      ]),
      bcConns: new Set(["bc"]),
    };
    expect(connectedPeerIds(room)).toEqual(new Set(["open", "bc"]));
  });

  it("an announce-only peer does not make the status connected", async () => {
    const { manager } = makeManager({ isCollab: true, roomId: "room-ho-1" });
    await tick();
    const provider = latestProvider();
    provider.signalingConns[0].setConnected(true);
    expect(manager.status).toBe("waiting");

    provider.announcePeer("peer-ghost");
    expect(provider.room.webrtcConns.size).toBe(1);
    expect(manager.status).toBe("waiting");
    expect(manager.diagnostics.webrtcPeers).toBe(0);
    manager.destroy();
  });

  it("an announce-only peer does not stop a lone host from saving", async () => {
    const { manager } = makeManager({ isCollab: true, roomId: "room-ho-2" });
    await tick();
    const provider = latestProvider();
    provider.announcePeer("peer-ghost");
    vi.mocked(tauriBridge.saveProjectState).mockClear();

    manager.ytext.insert(0, "% lone host edit\n");
    await vi.advanceTimersByTimeAsync(1500);
    expect(tauriBridge.saveProjectState).toHaveBeenCalledTimes(1);
    expect(manager.saveState.status).toBe("saved");
    manager.destroy();
  });

  it("drops a peer that never completes the handshake after the timeout", async () => {
    const { manager } = makeManager({
      isCollab: true,
      roomId: "room-ho-3",
      options: { signaling: ["wss://sig-a.test"], handshakeTimeoutMs: 20000 },
    });
    await tick();
    const provider = latestProvider();
    const conn = provider.announcePeer("peer-ghost");

    await vi.advanceTimersByTimeAsync(19_999);
    expect(conn.peer.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(conn.peer.destroy).toHaveBeenCalledTimes(1);
    expect(provider.room.webrtcConns.size).toBe(0);
    expect(conn.closed).toBe(true);
    manager.destroy();
  });

  it("a peer that completes the handshake counts, blocks unsynced saves and is never timed out", async () => {
    const { manager } = makeManager({
      isCollab: true,
      roomId: "room-ho-4",
      options: { signaling: ["wss://sig-a.test"], handshakeTimeoutMs: 20000 },
    });
    await tick();
    const provider = latestProvider();
    const conn = provider.announcePeer("peer-real");
    expect(manager.status).not.toBe("connected");

    await vi.advanceTimersByTimeAsync(5000);
    provider.completeHandshake("peer-real");
    expect(manager.status).toBe("connected");
    expect(manager.diagnostics.webrtcPeers).toBe(1);

    vi.mocked(tauriBridge.saveProjectState).mockClear();
    manager.ytext.insert(0, "% not synced yet\n");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(conn.peer.destroy).not.toHaveBeenCalled();
    expect(tauriBridge.saveProjectState).not.toHaveBeenCalled();

    provider.disconnectPeer("peer-real");
    expect(manager.status).not.toBe("connected");
    expect(manager.diagnostics.webrtcPeers).toBe(0);
    manager.destroy();
  });

  it("clears pending handshake timers when collaboration stops", async () => {
    const { manager } = makeManager({ isCollab: true, roomId: "room-ho-5" });
    await tick();
    const conn = latestProvider().announcePeer("peer-ghost");
    await manager.stopCollaboration();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(conn.peer.destroy).not.toHaveBeenCalled();
    manager.destroy();
  });
});

describe("Signaling server configuration", () => {
  // vitest runs in node: provide a minimal localStorage.
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the live public servers first and no dead legacy hosts", () => {
    const servers = getSignalingServers();
    expect(servers.slice(0, 2)).toEqual(DEFAULT_SIGNALING_SERVERS);
    expect(servers.join(" ")).not.toMatch(/herokuapp|signaling\.yjs\.dev/);
    expect(new Set(servers).size).toBe(servers.length);
  });

  it("puts a user-configured server (localStorage) before the public ones and ignores garbage", () => {
    localStorage.setItem(SIGNALING_OVERRIDE_KEY, " wss://my.server.example , not-a-url, ws://10.0.0.5:4444");
    const servers = getSignalingServers();
    expect(servers.slice(0, 2)).toEqual(["wss://my.server.example", "ws://10.0.0.5:4444"]);
    expect(servers).toEqual(expect.arrayContaining(DEFAULT_SIGNALING_SERVERS));
    expect(servers).not.toContain("not-a-url");
  });
});

describe("Encrypted signaling (room password)", () => {
  it("derives a deterministic SHA-256 password from the room id without exposing the id", async () => {
    expect(deriveRoomPassword("room-1")).toBe(await sha256Hex("latexp2p:room-1"));
    expect(deriveRoomPassword("room-1")).toBe(deriveRoomPassword("room-1"));
    expect(deriveRoomPassword("room-1")).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveRoomPassword("room-1")).not.toBe(deriveRoomPassword("room-2"));
    expect(deriveRoomPassword("room-1")).not.toContain("room-1");
    expect(deriveRoomPassword("sala-ñ-ü")).toBe(await sha256Hex("latexp2p:sala-ñ-ü"));
  });

  it("passes the derived password to every WebrtcProvider (open with room and hot-attach)", async () => {
    const joined = makeManager({ isCollab: true, roomId: "room-10" });
    await tick();
    expect(latestProvider().roomName).toBe("room-10");
    expect(latestProvider().opts.password).toBe(deriveRoomPassword("room-10"));
    joined.manager.destroy();

    const { manager } = makeManager();
    const roomId = await manager.startCollaboration();
    expect(latestProvider().opts.password).toBe(deriveRoomPassword(roomId));
    expect(latestProvider().opts.password).not.toBe(roomId);
    manager.destroy();
  });
});

describe("ICE servers (STUN / TURN)", () => {
  const store = new Map<string, string>();
  const TURN = { url: "turn:turn.example.com:3478", username: "alice", credential: "s3cret" };
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("defaults to Google STUN only", () => {
    const servers = buildIceServers();
    expect(servers).toEqual([{ urls: DEFAULT_STUN_SERVERS }]);
    expect(DEFAULT_STUN_SERVERS.every((u) => u.startsWith("stun:stun") && u.includes("google"))).toBe(true);
    expect(hasTurnServer(servers)).toBe(false);
    expect(buildIceServers({ turn: null })).toEqual(servers);
  });

  it("appends the TURN relay with its credentials after STUN", () => {
    const servers = buildIceServers({ turn: TURN });
    expect(servers).toEqual([
      { urls: DEFAULT_STUN_SERVERS },
      { urls: "turn:turn.example.com:3478", username: "alice", credential: "s3cret" },
    ]);
    expect(hasTurnServer(servers)).toBe(true);

    const multi = buildIceServers({
      stun: ["stun:custom.example.com:3478"],
      turn: { ...TURN, url: "turn:a.example.com:3478?transport=udp, turns:a.example.com:5349" },
    });
    expect(multi).toEqual([
      { urls: ["stun:custom.example.com:3478"] },
      {
        urls: ["turn:a.example.com:3478?transport=udp", "turns:a.example.com:5349"],
        username: "alice",
        credential: "s3cret",
      },
    ]);
  });

  it("validates TURN entries: only turn:/turns: URLs are accepted", () => {
    expect(parseTurnConfig(null)).toBeNull();
    expect(parseTurnConfig("turn:x")).toBeNull();
    expect(parseTurnConfig({})).toBeNull();
    expect(parseTurnConfig({ url: "" })).toBeNull();
    expect(parseTurnConfig({ url: "stun:stun.l.google.com:19302" })).toBeNull();
    expect(parseTurnConfig({ url: "https://turn.example.com" })).toBeNull();
    expect(parseTurnConfig({ url: " TURNS:relay.example.com:5349 ", username: " bob ", credential: "pw" })).toEqual({
      url: "TURNS:relay.example.com:5349",
      username: "bob",
      credential: "pw",
    });
    expect(parseTurnConfig({ url: "turn:a:3478, junk, turns:b:5349" })).toEqual({
      url: "turn:a:3478,turns:b:5349",
      username: "",
      credential: "",
    });
    expect(parseTurnUrls("turn:a, nope ,turns:b")).toEqual(["turn:a", "turns:b"]);
    expect(buildIceServers({ turn: { url: "garbage", username: "u", credential: "c" } })).toEqual([
      { urls: DEFAULT_STUN_SERVERS },
    ]);
  });

  it("prefers the TURN relay configured in the UI over the build-time one", () => {
    expect(getIceServers()).toEqual([{ urls: DEFAULT_STUN_SERVERS }]);

    vi.stubEnv("VITE_TURN_URL", "turns:env.example.com:5349");
    vi.stubEnv("VITE_TURN_USERNAME", "env-user");
    vi.stubEnv("VITE_TURN_CREDENTIAL", "env-pass");
    expect(getIceServers()[1]).toEqual({ urls: "turns:env.example.com:5349", username: "env-user", credential: "env-pass" });

    localStorage.setItem(TURN_OVERRIDE_KEY, JSON.stringify(TURN));
    expect(getIceServers()).toEqual([
      { urls: DEFAULT_STUN_SERVERS },
      { urls: TURN.url, username: "alice", credential: "s3cret" },
    ]);

    localStorage.setItem(TURN_OVERRIDE_KEY, "{not json");
    expect(getIceServers()[1]?.urls).toBe("turns:env.example.com:5349"); // corrupt entry ignored → env
    localStorage.setItem(TURN_OVERRIDE_KEY, JSON.stringify({ url: "stun:only" }));
    expect(getIceServers()[1]?.urls).toBe("turns:env.example.com:5349"); // invalid entry ignored → env
  });

  it("hands the ICE configuration to the WebrtcProvider and reports TURN in the diagnostics", async () => {
    const plain = makeManager({ isCollab: true, roomId: "room-11" });
    await tick();
    expect(latestProvider().opts.peerOpts).toEqual({ config: { iceServers: [{ urls: DEFAULT_STUN_SERVERS }] } });
    expect(plain.manager.diagnostics.turnConfigured).toBe(false);
    plain.manager.destroy();

    localStorage.setItem(TURN_OVERRIDE_KEY, JSON.stringify(TURN));
    const relayed = makeManager({ isCollab: true, roomId: "room-12" });
    await tick();
    expect(latestProvider().opts.peerOpts?.config?.iceServers).toEqual([
      { urls: DEFAULT_STUN_SERVERS },
      { urls: TURN.url, username: "alice", credential: "s3cret" },
    ]);
    expect(relayed.manager.diagnostics.turnConfigured).toBe(true);
    await relayed.manager.stopCollaboration();
    expect(relayed.manager.diagnostics.turnConfigured).toBe(false);
    relayed.manager.destroy();

    const custom: RTCIceServer[] = [{ urls: "stun:custom:3478" }, { urls: "turn:custom:3478", username: "u", credential: "c" }];
    const overridden = makeManager({
      isCollab: true,
      roomId: "room-13",
      options: { signaling: [], iceServers: custom },
    });
    await tick();
    expect(latestProvider().opts.peerOpts?.config?.iceServers).toBe(custom);
    expect(overridden.manager.diagnostics.turnConfigured).toBe(true);
    overridden.manager.destroy();
  });
});

// ─── Project assets shared peer-to-peer ───────────────────────────

const hex = (bytes: Uint8Array) => buffer.toHexString(sha256.digest(bytes));
const enc = (text: string) => new TextEncoder().encode(text);

/** In-memory project folder + room cache implementing the Rust commands' contract. */
function fakeAssetIo(files: Record<string, Uint8Array>) {
  const folder = new Map(Object.entries(files));
  const cache = new Map<string, { entry: AssetEntry; bytes: Uint8Array }>();
  const entry = (path: string, bytes: Uint8Array): AssetEntry => ({ path, size: bytes.length, hash: hex(bytes) });
  const io: AssetIO = {
    listLocal: vi.fn(async () => Array.from(folder, ([p, b]) => entry(p, b))),
    listCache: vi.fn(async () => Array.from(cache.values(), (c) => c.entry)),
    readChunk: vi.fn(async (path: string, offset: number, length: number) => {
      const bytes = folder.get(path) ?? cache.get(path)?.bytes;
      if (!bytes) throw new Error(`not found: ${path}`);
      return bytes.slice(offset, offset + length);
    }),
    storeCache: vi.fn(async (e: AssetEntry, bytes: Uint8Array) => {
      if (hex(bytes) !== e.hash) throw new Error("hash mismatch");
      cache.set(e.path, { entry: entry(e.path, bytes), bytes: bytes.slice() });
      return entry(e.path, bytes);
    }),
    pruneCache: vi.fn(async (keep: AssetEntry[]) => {
      let removed = 0;
      for (const [path, c] of Array.from(cache)) {
        if (!keep.some((k) => k.path === path && k.hash === c.entry.hash)) {
          cache.delete(path);
          removed++;
        }
      }
      return removed;
    }),
  };
  return { io, folder, cache };
}

/** Live link between two peers: every doc and awareness update is forwarded (what y-webrtc does). */
function link(a: CollabManager, b: CollabManager) {
  const LINK = "link";
  sync(a, b);
  const forwardDoc = (to: CollabManager) => (update: Uint8Array, origin: unknown) => {
    if (origin !== LINK) Y.applyUpdate(to.doc, update, LINK);
  };
  const forwardAwareness =
    (from: CollabManager, to: CollabManager) =>
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === LINK) return;
      const changed = [...added, ...updated, ...removed];
      applyAwarenessUpdate(to.awareness, encodeAwarenessUpdate(from.awareness, changed), LINK);
    };
  const ab = forwardDoc(b);
  const ba = forwardDoc(a);
  const awAB = forwardAwareness(a, b);
  const awBA = forwardAwareness(b, a);
  a.doc.on("update", ab);
  b.doc.on("update", ba);
  a.awareness.on("update", awAB);
  b.awareness.on("update", awBA);
  return () => {
    a.doc.off("update", ab);
    b.doc.off("update", ba);
    a.awareness.off("update", awAB);
    b.awareness.off("update", awBA);
  };
}

async function until(cond: () => boolean, steps = 400) {
  for (let i = 0; i < steps && !cond(); i++) await vi.advanceTimersByTimeAsync(5);
  expect(cond()).toBe(true);
}

async function makeAssetPeer(name: string, io: AssetIO, extra: { assetMaxBytes?: number } = {}) {
  const statuses: AssetSyncStatus[] = [];
  const { manager } = makeManager({
    isCollab: true,
    roomId: "room-assets",
    initialTexContent: "", // no seeding: any save would come from asset traffic
    currentUser: { name, color: "#22c55e" },
    options: { signaling: [], assetIo: io, assetScanMs: 1000, ...extra },
    callbacks: { onAssetsChange: (s) => statuses.push(s) },
  });
  await tick(); // the provider is attached asynchronously
  return { manager, statuses, provider: latestProvider() };
}

/** 200 KB "image": more chunks than the window. */
const LOGO = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 31 + 7) % 251);

describe("Project assets shared through the room", () => {
  it("publishes the host's asset list and streams a chunked file into the guest's cache", async () => {
    const hostFiles = fakeAssetIo({
      "imagenes/logoUMA.png": LOGO,
      "chapters/intro.tex": enc("\\chapter{Intro}"),
      "refs.bib": enc("@book{knuth}"),
    });
    const guestFiles = fakeAssetIo({});
    const host = await makeAssetPeer("Host", hostFiles.io);
    const guest = await makeAssetPeer("Guest", guestFiles.io);
    // Never more than a window of chunks of one file in the document.
    let maxChunks = 0;
    const chunks = guest.manager.doc.getMap(ASSET_CHUNKS_KEY);
    chunks.observe(() => (maxChunks = Math.max(maxChunks, chunks.size)));
    const unlink = link(host.manager, guest.manager);
    host.provider.markSynced();
    guest.provider.markSynced();

    // The manifest is in the shared doc: path → {hash, size, by}.
    await until(() => guest.manager.doc.getMap<ManifestEntry>(ASSETS_KEY).size === 3);
    expect(guest.manager.doc.getMap<ManifestEntry>(ASSETS_KEY).get("imagenes/logoUMA.png")).toEqual({
      hash: hex(LOGO),
      size: LOGO.length,
      by: host.manager.doc.clientID,
    });

    await until(() => guest.manager.assets.synced === 3);
    expect(guest.manager.assets).toMatchObject({ total: 3, synced: 3, missing: 0, downloading: null });
    expect(guestFiles.cache.get("imagenes/logoUMA.png")?.bytes).toEqual(LOGO);
    expect(new TextDecoder().decode(guestFiles.cache.get("chapters/intro.tex")?.bytes)).toBe("\\chapter{Intro}");
    expect(hostFiles.io.readChunk).toHaveBeenCalledWith("imagenes/logoUMA.png", ASSET_CHUNK_BYTES, ASSET_CHUNK_BYTES);
    expect(maxChunks).toBeGreaterThan(0);
    expect(maxChunks).toBeLessThanOrEqual(ASSET_WINDOW);
    // Progress was reported while the image was on its way.
    expect(guest.statuses.some((s) => s.downloading?.path === "imagenes/logoUMA.png" && s.downloading.received > 0)).toBe(true);

    // Transfers leave nothing behind and are not edits: no main.tex rewrite.
    await vi.advanceTimersByTimeAsync(50);
    expect(host.manager.doc.getMap(ASSET_CHUNKS_KEY).size).toBe(0);
    expect(host.manager.doc.getMap(ASSET_REQUESTS_KEY).size).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(tauriBridge.saveProjectState).not.toHaveBeenCalled();
    expect(host.manager.assets).toMatchObject({ total: 3, synced: 3, uploading: 0 });

    unlink();
    host.manager.destroy();
    guest.manager.destroy();
  });

  it("keeps the guest's own files, skips files above the size cap and never overwrites the host's version", async () => {
    const hostFiles = fakeAssetIo({ "refs.bib": enc("host bib"), "big.pdf": new Uint8Array(4096), "fig.png": enc("png") });
    const guestFiles = fakeAssetIo({ "refs.bib": enc("guest's older bib") });
    const host = await makeAssetPeer("Host", hostFiles.io);
    const guest = await makeAssetPeer("Guest", guestFiles.io, { assetMaxBytes: 1024 });
    const unlink = link(host.manager, guest.manager);
    host.provider.markSynced();
    // The guest's first scan happens after the room's manifest arrived.
    await until(() => host.manager.doc.getMap(ASSETS_KEY).size === 3);
    guest.provider.markSynced();

    await until(() => guest.manager.assets.items.some((i) => i.path === "fig.png" && i.state === "cached"));
    await vi.advanceTimersByTimeAsync(1500); // a rescan on both sides
    const items = Object.fromEntries(guest.manager.assets.items.map((i) => [i.path, i.state]));
    expect(items).toEqual({ "big.pdf": "tooLarge", "fig.png": "cached", "refs.bib": "local" });
    expect(guest.manager.assets).toMatchObject({ total: 3, synced: 2, missing: 1, tooLarge: 1 });
    expect(guestFiles.cache.has("refs.bib")).toBe(false);
    expect(guestFiles.cache.has("big.pdf")).toBe(false);
    // The room still advertises the host's bib, not the guest's stale copy.
    expect(host.manager.doc.getMap<ManifestEntry>(ASSETS_KEY).get("refs.bib")?.hash).toBe(hex(enc("host bib")));

    unlink();
    host.manager.destroy();
    guest.manager.destroy();
  });

  it("re-downloads a file the host changed and prunes one the host deleted", async () => {
    const hostFiles = fakeAssetIo({ "fig.png": enc("v1"), "old.tex": enc("old") });
    const guestFiles = fakeAssetIo({});
    const host = await makeAssetPeer("Host", hostFiles.io);
    const guest = await makeAssetPeer("Guest", guestFiles.io);
    const unlink = link(host.manager, guest.manager);
    host.provider.markSynced();
    guest.provider.markSynced();
    await until(() => guest.manager.assets.synced === 2);

    hostFiles.folder.set("fig.png", enc("v2, edited by the host"));
    hostFiles.folder.delete("old.tex");
    await until(() => new TextDecoder().decode(guestFiles.cache.get("fig.png")?.bytes) === "v2, edited by the host");
    await until(() => !guestFiles.cache.has("old.tex"));
    expect(guest.manager.assets).toMatchObject({ total: 1, synced: 1 });
    expect(guestFiles.io.pruneCache).toHaveBeenCalled();

    unlink();
    host.manager.destroy();
    guest.manager.destroy();
  });

  it("reports files nobody online can send, and resumes when a peer that has them comes back", async () => {
    const hostFiles = fakeAssetIo({ "imagenes/logoUMA.png": LOGO });
    const guestFiles = fakeAssetIo({});
    const host = await makeAssetPeer("Host", hostFiles.io);
    const guest = await makeAssetPeer("Guest", guestFiles.io);
    host.provider.markSynced();
    await vi.advanceTimersByTimeAsync(10);

    // The guest got the manifest, then the host left before sending anything.
    sync(host.manager, guest.manager);
    removeAwarenessStates(guest.manager.awareness, [host.manager.doc.clientID], "left");
    guest.provider.markSynced();
    await until(() => guest.manager.assets.unavailable === 1);
    expect(guest.manager.assets.items).toEqual([{ path: "imagenes/logoUMA.png", size: LOGO.length, state: "unavailable" }]);

    const log = "error: main.tex:3: Unable to load picture or PDF file 'imagenes/logoUMA.png'";
    expect(explainMissingAsset(log, guest.manager.assets)).toEqual({ path: "imagenes/logoUMA.png", state: "unavailable" });

    // The host comes back online.
    const unlink = link(host.manager, guest.manager);
    host.manager.awareness.setLocalStateField("user", { name: "Host", color: "#22c55e" });
    await until(() => guest.manager.assets.synced === 1);
    expect(explainMissingAsset(log, guest.manager.assets)).toBeNull();

    unlink();
    host.manager.destroy();
    guest.manager.destroy();
  });

  it("a sender that leaves mid-transfer turns the file unavailable, and the download restarts when it is back", async () => {
    const hostFiles = fakeAssetIo({ "imagenes/logoUMA.png": LOGO });
    // A slow disk/link: every chunk takes 20 ms, so the transfer can be interrupted.
    const read = hostFiles.io.readChunk;
    hostFiles.io.readChunk = (path, offset, length) =>
      new Promise((resolve) => setTimeout(resolve, 20)).then(() => read(path, offset, length));
    const guestFiles = fakeAssetIo({});
    const host = await makeAssetPeer("Host", hostFiles.io);
    const guest = await makeAssetPeer("Guest", guestFiles.io);
    let unlink = link(host.manager, guest.manager);
    host.provider.markSynced();
    guest.provider.markSynced();
    await until(() => (guest.manager.assets.downloading?.received ?? 0) > 0);

    unlink();
    removeAwarenessStates(guest.manager.awareness, [host.manager.doc.clientID], "left");
    await until(() => guest.manager.assets.unavailable === 1);
    expect(guest.manager.assets.downloading).toBeNull();

    unlink = link(host.manager, guest.manager);
    host.manager.awareness.setLocalStateField("user", { name: "Host", color: "#22c55e" });
    await until(() => guest.manager.assets.synced === 1);
    expect(guestFiles.cache.get("imagenes/logoUMA.png")?.bytes).toEqual(LOGO);

    unlink();
    host.manager.destroy();
    guest.manager.destroy();
  });

  it("explains missing-file errors from tectonic and pdflatex logs only for room assets", () => {
    const status: AssetSyncStatus = {
      total: 3,
      synced: 1,
      missing: 2,
      unavailable: 0,
      tooLarge: 1,
      downloading: { path: "chapters/intro.tex", size: 10, received: 4 },
      uploading: 0,
      maxBytes: 1,
      items: [
        { path: "chapters/intro.tex", size: 10, state: "downloading" },
        { path: "figures/scan.pdf", size: 9e9, state: "tooLarge" },
        { path: "refs.bib", size: 3, state: "cached" },
      ],
    };
    const latex = "! LaTeX Error: File `chapters/intro.tex' not found.\n";
    expect(missingFilesInLog(latex)).toEqual(["chapters/intro.tex"]);
    expect(explainMissingAsset(latex, status)).toEqual({ path: "chapters/intro.tex", state: "downloading" });
    // \includegraphics{figures/scan} → reported without the extension.
    expect(explainMissingAsset("LaTeX Error: File `figures/scan' not found", status)).toEqual({
      path: "figures/scan.pdf",
      state: "tooLarge",
    });
    expect(explainMissingAsset("File `refs.bib' not found", status)).toBeNull();
    expect(explainMissingAsset("File `nowhere.png' not found", status)).toBeNull();
    expect(explainMissingAsset("Undefined control sequence", status)).toBeNull();
  });

  it("isAssetOnlyTransaction tells transfers apart from edits", () => {
    const doc = new Y.Doc();
    const seen: boolean[] = [];
    doc.on("afterTransaction", (tr: Y.Transaction) => seen.push(isAssetOnlyTransaction(doc, tr)));
    doc.transact(() => doc.getMap(ASSET_CHUNKS_KEY).set("h:0", new Uint8Array([1])), ASSET_ORIGIN);
    doc.getText("t").insert(0, "edit");
    doc.transact(() => {
      doc.getMap(ASSETS_KEY).set("a.png", { hash: "h", size: 1, by: 1 });
      doc.getText("t").insert(0, "x");
    });
    expect(seen).toEqual([true, false, false]);
  });
});
