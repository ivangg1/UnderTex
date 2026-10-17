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
  saveProjectFile: vi.fn().mockResolvedValue(true),
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


// ─── Multi-file collaboration ───────────────────────────────────────

const INTRO = "\\section{Intro}\nHello from the intro.\n";
const REFS = "@book{knuth, title={TAOCP}}\n";

async function makeRoomPair() {
  const a = makeManager({ isCollab: true, roomId: "room-files", currentUser: { name: "A", color: "#111" } });
  const b = makeManager({ isCollab: true, roomId: "room-files", currentUser: { name: "B", color: "#222" } });
  await tick();
  const [pa, pb] = MockWebrtcProvider.instances;
  pa.connectPeer(pb.room.peerId);
  pb.connectPeer(pa.room.peerId);
  const unlink = link(a.manager, b.manager);
  pa.markSynced();
  pb.markSynced();
  await tick();
  const host = a.manager.isHost ? a : b;
  const guest = host === a ? b : a;
  return { host, guest, unlink };
}

describe("Multi-file editing", () => {
  it("keeps the root file under the legacy key and every other file under its own text", async () => {
    const { manager } = makeManager();
    expect(manager.primaryFile).toBe("main.tex");
    expect(manager.textKeyFor("main.tex")).toBe("codemirror");
    expect(manager.textKeyFor("chapters/intro.tex")).toBe("file:chapters/intro.tex");
    const intro = await manager.openFile("chapters/intro.tex", INTRO);
    expect(intro.toString()).toBe(INTRO);
    expect(manager.fileText("chapters/intro.tex")).toBe(intro);
    expect(manager.sharedFiles()).toEqual(["main.tex", "chapters/intro.tex"]);
    expect(manager.fileContents()).toEqual({ "main.tex": TEX, "chapters/intro.tex": INTRO });
    // Opening again never seeds twice.
    await manager.openFile("chapters/intro.tex", INTRO);
    expect(intro.toString()).toBe(INTRO);
    manager.destroy();
  });

  it("solo: saves each changed file atomically and leaves the others alone", async () => {
    const { manager } = makeManager();
    const intro = await manager.openFile("chapters/intro.tex", INTRO);
    await manager.openFile("refs.bib", REFS);
    await manager.flushSave();
    vi.mocked(tauriBridge.saveProjectFile).mockClear();
    vi.mocked(tauriBridge.saveTexAtomic).mockClear();

    intro.insert(intro.length, "More.\n");
    await vi.advanceTimersByTimeAsync(1500);
    expect(tauriBridge.saveProjectFile).toHaveBeenCalledTimes(1);
    expect(tauriBridge.saveProjectFile).toHaveBeenCalledWith("/path/to/project", "chapters/intro.tex", INTRO + "More.\n");
    expect(tauriBridge.saveTexAtomic).not.toHaveBeenCalled();

    manager.ytext.insert(0, "% root\n");
    await vi.advanceTimersByTimeAsync(1500);
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledWith("/path/to/project", "main.tex", "% root\n" + TEX);
    expect(tauriBridge.saveProjectFile).toHaveBeenCalledTimes(1);
    manager.destroy();
  });

  it("each file keeps its own undo history across tab switches", async () => {
    const { manager } = makeManager();
    const intro = await manager.openFile("chapters/intro.tex", INTRO);
    const undo = manager.undoManagerFor("chapters/intro.tex");
    expect(manager.undoManagerFor("chapters/intro.tex")).toBe(undo);
    expect(manager.undoManagerFor("main.tex")).not.toBe(undo);
    intro.insert(0, "X");
    undo.stopCapturing();
    undo.undo();
    expect(intro.toString()).toBe(INTRO);
    manager.destroy();
  });

  it("collab: peers edit a non-root file live and only the host writes it", async () => {
    const { host, guest, unlink } = await makeRoomPair();
    // The guest opens a chapter first: it is seeded and shared with the room.
    const guestIntro = await guest.manager.openFile("chapters/intro.tex", INTRO);
    expect(host.manager.isShared("chapters/intro.tex")).toBe(true);
    const hostIntro = await host.manager.openFile("chapters/intro.tex", INTRO);
    expect(hostIntro.toString()).toBe(INTRO); // no duplicated seed

    guestIntro.insert(0, "% from guest\n");
    expect(hostIntro.toString()).toBe("% from guest\n" + INTRO);
    hostIntro.insert(hostIntro.length, "% from host\n");
    expect(guestIntro.toString()).toBe("% from guest\n" + INTRO + "% from host\n");

    vi.mocked(tauriBridge.saveProjectFile).mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    // Only the host persisted, and the guest's copy never hit a disk.
    const calls = vi.mocked(tauriBridge.saveProjectFile).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)).toEqual(["/path/to/project", "chapters/intro.tex", "% from guest\n" + INTRO + "% from host\n"]);
    expect(guest.saveStates.at(-1)?.status).toBe("guest");
    // The CRDT state (covering every file) is saved with the root file.
    expect(tauriBridge.saveProjectState).toHaveBeenCalled();
    unlink();
    host.manager.destroy();
    guest.manager.destroy();
  });

  it("collab: a joining peer waits for the room before seeding a file, so it never duplicates it", async () => {
    const { manager: alone } = makeManager({ isCollab: true, roomId: "room-wait", currentUser: { name: "A", color: "#111" } });
    await tick();
    let resolved = false;
    const pending = alone.openFile("chapters/intro.tex", INTRO).then((t) => {
      resolved = true;
      return t;
    });
    await tick();
    expect(resolved).toBe(false); // not synced yet
    latestProvider().markSynced();
    const text = await pending;
    expect(text.toString()).toBe(INTRO);
    alone.destroy();
  });

  it("two peers that seed the same file content concurrently converge to one copy", async () => {
    const { manager: a } = makeManager();
    const { manager: b } = makeManager();
    await a.openFile("chapters/intro.tex", INTRO);
    await b.openFile("chapters/intro.tex", INTRO);
    // Same content in two files must not collide either.
    await a.openFile("chapters/copy.tex", INTRO);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), "remote");
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), "remote");
    expect(a.fileText("chapters/intro.tex").toString()).toBe(INTRO);
    expect(b.fileText("chapters/intro.tex").toString()).toBe(INTRO);
    expect(b.fileText("chapters/copy.tex").toString()).toBe(INTRO);
    a.destroy();
    b.destroy();
  });

  it("rename moves the shared text, delete stops the host from writing the file back", async () => {
    const { manager } = makeManager();
    const intro = await manager.openFile("chapters/intro.tex", INTRO);
    manager.renameFile("chapters/intro.tex", "chapters/start.tex");
    expect(manager.isShared("chapters/intro.tex")).toBe(false);
    expect(manager.getFileText("chapters/start.tex")).toBe(INTRO);
    await manager.flushSave();

    vi.mocked(tauriBridge.saveProjectFile).mockClear();
    manager.removeFile("chapters/start.tex");
    intro.insert(0, "stale tab edit");
    manager.fileText("chapters/start.tex").insert(0, "edit after delete");
    await vi.advanceTimersByTimeAsync(2000);
    expect(tauriBridge.saveProjectFile).not.toHaveBeenCalled();

    // Re-creating a file with the old name takes the disk content, not the stale text.
    const again = await manager.openFile("chapters/start.tex", "fresh\n");
    expect(again.toString()).toBe("fresh\n");
    manager.destroy();
  });

  it("publishes the open file in awareness and keeps the primary file of a persisted room", async () => {
    const { host, guest, unlink } = await makeRoomPair();
    guest.manager.setActiveFile("refs.bib");
    const seen = host.manager.peers.find((p) => !p.isSelf);
    expect(seen?.file).toBe("refs.bib");

    // The root choice is shared through the room metadata.
    host.manager.setRootFile("thesis.tex");
    expect(guest.manager.getRoomInfo().rootFile).toBe("thesis.tex");

    // A collab save records which file the legacy text belongs to: reopening
    // with another root file never maps that text onto the wrong file.
    await vi.advanceTimersByTimeAsync(2000);
    const state = Y.encodeStateAsUpdate(host.manager.doc);
    unlink();
    host.manager.destroy();
    guest.manager.destroy();
    const { manager: reopened } = makeManager({ mainFile: "thesis.tex", initialCrdtState: Array.from(state) });
    expect(reopened.primaryFile).toBe("main.tex");
    expect(reopened.textKeyFor("thesis.tex")).toBe("file:thesis.tex");
    reopened.destroy();
  });
});
