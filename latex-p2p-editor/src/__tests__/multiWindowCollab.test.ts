import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { CollabManager } from "../services/collabManager";
import * as tauriBridge from "../services/tauriBridge";

// Mock Tauri bridge commands
vi.mock("../services/tauriBridge", () => ({
  saveTexAtomic: vi.fn().mockResolvedValue(undefined),
  saveProjectState: vi.fn().mockResolvedValue(undefined),
  initCollabProject: vi.fn().mockResolvedValue("room-uuid-abc-123"),
}));

// Mock WebrtcProvider to avoid real network sockets and room collisions within the same Node process
vi.mock("y-webrtc", () => {
  class MockWebrtcProvider {
    public roomId: string;
    public doc: any;
    public awareness: Awareness;
    private listeners: Record<string, Function[]> = {};

    constructor(roomId: string, doc: any, opts: any) {
      this.roomId = roomId;
      this.doc = doc;
      this.awareness = opts?.awareness || new Awareness(doc);
    }

    on(event: string, handler: Function) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
    }

    emit(event: string, ...args: any[]) {
      (this.listeners[event] || []).forEach((h) => h(...args));
    }

    disconnect = vi.fn();
    destroy = vi.fn();
  }

  return { WebrtcProvider: MockWebrtcProvider };
});

describe("End-to-End Multi-Window Simulation: Solo vs Collab lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Scenario 1: Window 1 opens a fresh folder in Solo mode and writes without creating .texcollab/", async () => {
    const window1 = new CollabManager({
      projectPath: "/path/to/my_latex_project",
      isCollab: false,
      roomId: null,
      initialTexContent: "\\documentclass{article}\n\\begin{document}\nSolo mode\n\\end{document}",
      initialCrdtState: null,
      currentUser: { name: "User 1", color: "#3b82f6" },
    });

    // 1. Must be initialized strictly in Solo mode
    expect(window1.mode).toBe("solo");
    expect(window1.isHost).toBe(true);
    expect(window1.provider).toBeNull(); // ZERO network traffic
    expect(window1.peers).toEqual([]);
    expect(window1.status).toBe("disconnected");

    // 2. User edits document in Solo mode
    window1.ytext.insert(window1.ytext.length - 15, "\n\\section{Draft}\n");

    // 3. Fast-forward timer by 1500ms
    vi.advanceTimersByTime(1500);

    // 4. Must save ONLY via saveTexAtomic (never saveProjectState which touches .texcollab/)
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledTimes(1);
    expect(tauriBridge.saveTexAtomic).toHaveBeenCalledWith(
      "/path/to/my_latex_project",
      expect.stringContaining("\\section{Draft}")
    );
    expect(tauriBridge.saveProjectState).not.toHaveBeenCalled();

    window1.destroy();
  });

  it("Scenario 2: Window 1 activates collaboration in hot mode, Window 2 joins, concurrent edits sync, Host saves to disk, Guest does not", async () => {
    // ─── Step A: Window 1 starts in Solo mode ──────────────────────
    const window1 = new CollabManager({
      projectPath: "/path/to/shared_project",
      isCollab: false,
      roomId: null,
      initialTexContent: "\\documentclass{article}\n\\begin{document}\nShared project\n\\end{document}",
      initialCrdtState: null,
      currentUser: { name: "Alice (Host)", color: "#ef4444" },
    });

    expect(window1.mode).toBe("solo");
    expect(window1.provider).toBeNull();

    // ─── Step B: Window 1 clicks 'Colaborar en vivo' ───────────────
    const assignedRoomId = await window1.startCollaboration();
    expect(assignedRoomId).toBe("room-uuid-abc-123");
    expect(window1.mode).toBe("collab");
    expect(window1.roomId).toBe("room-uuid-abc-123");
    expect(window1.provider).not.toBeNull();
    // Initial CRDT state must have been saved on startCollaboration
    expect(tauriBridge.saveProjectState).toHaveBeenCalledTimes(1);

    // ─── Step C: Window 2 opens the shared folder (is_collab = true) ─
    const window2 = new CollabManager({
      projectPath: "/path/to/shared_project",
      isCollab: true,
      roomId: "room-uuid-abc-123",
      initialTexContent: window1.ytext.toString(),
      initialCrdtState: Array.from(Y.encodeStateAsUpdate(window1.doc)),
      currentUser: { name: "Bob (Guest)", color: "#10b981" },
    });

    expect(window2.mode).toBe("collab");
    expect(window2.roomId).toBe("room-uuid-abc-123");
    expect(window2.provider).not.toBeNull();

    // ─── Step D: Awareness & Leader Election ────────────────────────
    const cid1 = window1.doc.clientID;
    const cid2 = window2.doc.clientID;

    // Simulate awareness update with both peers
    const minCid = Math.min(cid1, cid2);
    const hostWindow = cid1 === minCid ? window1 : window2;
    const guestWindow = cid1 === minCid ? window2 : window1;

    expect(CollabManager.computeIsHost([cid1, cid2], hostWindow.doc.clientID)).toBe(true);
    expect(CollabManager.computeIsHost([cid1, cid2], guestWindow.doc.clientID)).toBe(false);

    hostWindow.isHost = true;
    guestWindow.isHost = false;

    // Reset call counts before testing edit synchronization
    vi.mocked(tauriBridge.saveTexAtomic).mockClear();
    vi.mocked(tauriBridge.saveProjectState).mockClear();

    // ─── Step E: Guest edits text ──────────────────────────────────
    guestWindow.ytext.insert(30, "\n% Guest added this note\n");

    // Fast forward 1500ms
    vi.advanceTimersByTime(1500);

    // The guest must NEVER write to disk!
    expect(tauriBridge.saveTexAtomic).not.toHaveBeenCalled();
    expect(tauriBridge.saveProjectState).not.toHaveBeenCalled();

    // ─── Step F: Propagate CRDT update from Guest to Host ───────────
    const guestUpdate = Y.encodeStateAsUpdate(guestWindow.doc);
    Y.applyUpdate(hostWindow.doc, guestUpdate);

    // Content has converged in memory
    expect(hostWindow.ytext.toString()).toBe(guestWindow.ytext.toString());
    expect(hostWindow.ytext.toString()).toContain("% Guest added this note");

    // The Host's doc update listener fires scheduleSave()
    vi.advanceTimersByTime(1500);

    // Host writes both main.tex and crdt_state.bin via saveProjectState
    expect(tauriBridge.saveProjectState).toHaveBeenCalledTimes(1);
    expect(tauriBridge.saveProjectState).toHaveBeenCalledWith(
      "/path/to/shared_project",
      expect.stringContaining("% Guest added this note"),
      expect.any(Array)
    );

    // ─── Step G: Automatic Failover when Host disconnects ──────────
    hostWindow.destroy();

    // Guest window awareness re-evaluates leader
    const remainingPeers = [guestWindow.doc.clientID];
    const newHostCheck = CollabManager.computeIsHost(remainingPeers, guestWindow.doc.clientID);
    expect(newHostCheck).toBe(true);

    // Promote guestWindow to Host
    guestWindow.isHost = true;
    guestWindow.ytext.insert(0, "% New host edit\n");
    vi.advanceTimersByTime(1500);

    // New host now saves to disk!
    expect(tauriBridge.saveProjectState).toHaveBeenCalledTimes(2);

    // ─── Step H: Disconnecting back to Solo mode ───────────────────
    await guestWindow.stopCollaboration();
    expect(guestWindow.mode).toBe("solo");
    expect(guestWindow.provider).toBeNull();
    expect(guestWindow.isHost).toBe(true);

    guestWindow.destroy();
  });
});
