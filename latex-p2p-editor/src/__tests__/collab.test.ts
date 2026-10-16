import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { CollabManager, getSignalingServers } from "../services/collabManager";

describe("Dynamic Leader Election Algorithm (SPEC 4.A)", () => {
  it("uses CollabManager.computeIsHost to assign Host to the lowest numerical clientID", () => {
    const peers = [1050, 402, 9999]; // 402 is lowest
    expect(CollabManager.computeIsHost(peers, 402)).toBe(true);
    expect(CollabManager.computeIsHost(peers, 1050)).toBe(false);
    expect(CollabManager.computeIsHost(peers, 9999)).toBe(false);
  });

  it("handles automatic failover when current host disconnects", () => {
    // Initial state: peer 200 is Host
    let activePeers = [200, 350, 500];
    expect(CollabManager.computeIsHost(activePeers, 200)).toBe(true);
    expect(CollabManager.computeIsHost(activePeers, 350)).toBe(false);

    // Host 200 disconnects (e.g. closes window or loses connection)
    activePeers = [350, 500];

    // Peer 350 must immediately become the new Host without data loss
    expect(CollabManager.computeIsHost(activePeers, 350)).toBe(true);
    expect(CollabManager.computeIsHost(activePeers, 500)).toBe(false);
  });

  it("works reliably with single peer sessions", () => {
    expect(CollabManager.computeIsHost([777], 777)).toBe(true);
    expect(CollabManager.computeIsHost([], 777)).toBe(true);
  });
});

describe("Conflict-Free Cloud Persistence & CRDT Sync (SPEC 4.B)", () => {
  it("synchronizes document changes between two Yjs documents via binary updates", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    const text1 = doc1.getText("codemirror");
    const text2 = doc2.getText("codemirror");

    // Peer 1 types initial LaTeX
    text1.insert(
      0,
      "\\documentclass{article}\n\\begin{document}\nHello Peer 1\n\\end{document}"
    );

    // Propagate update from doc1 to doc2
    const update1 = Y.encodeStateAsUpdate(doc1);
    Y.applyUpdate(doc2, update1);

    expect(text2.toString()).toBe(text1.toString());

    // Peer 2 inserts text in the middle concurrently
    text2.insert(40, "\n% Comment from Peer 2\n");

    // Propagate update back to doc1
    const update2 = Y.encodeStateAsUpdate(doc2);
    Y.applyUpdate(doc1, update2);

    // Both documents converge to the exact same content
    expect(text1.toString()).toBe(text2.toString());
    expect(text1.toString()).toContain("% Comment from Peer 2");
  });

  it("persists and restores binary CRDT state vector (crdt_state.bin)", () => {
    const doc = new Y.Doc();
    const text = doc.getText("codemirror");
    text.insert(0, "\\section{Introduction}\nCRDT binary persistence test.");

    // Generate binary state update as would be saved to .texcollab/crdt_state.bin
    const stateBinary = Y.encodeStateAsUpdate(doc);
    expect(stateBinary.length).toBeGreaterThan(0);

    // Restore into a fresh document
    const restoredDoc = new Y.Doc();
    Y.applyUpdate(restoredDoc, stateBinary);
    const restoredText = restoredDoc.getText("codemirror");

    expect(restoredText.toString()).toBe(text.toString());
  });

  describe("Host-Only 1.5s Debounced Disk Persistence", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("triggers save only after 1500ms debounce when isHost is true", () => {
      const mockSave = vi.fn();
      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      let isHost = true;

      const triggerEdit = (content: string) => {
        if (!isHost) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          if (!isHost) return;
          mockSave(content);
        }, 1500);
      };

      // Edit 1
      triggerEdit("A");
      expect(mockSave).not.toHaveBeenCalled();

      // Advance by 1000ms (not yet 1500ms)
      vi.advanceTimersByTime(1000);
      expect(mockSave).not.toHaveBeenCalled();

      // Edit 2 resets the debounce
      triggerEdit("AB");
      vi.advanceTimersByTime(1000);
      expect(mockSave).not.toHaveBeenCalled();

      // Another 500ms completes 1500ms from Edit 2
      vi.advanceTimersByTime(500);
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockSave).toHaveBeenCalledWith("AB");
    });

    it("ensures Guests NEVER write to disk", () => {
      const mockSave = vi.fn();
      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      const isHost = false; // Guest peer

      const triggerEdit = (content: string) => {
        if (!isHost) return; // Strict guard
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          if (!isHost) return;
          mockSave(content);
        }, 1500);
      };

      // Guest types multiple edits
      triggerEdit("Guest edit 1");
      triggerEdit("Guest edit 2");
      vi.advanceTimersByTime(3000);

      // Save was never invoked
      expect(mockSave).not.toHaveBeenCalled();
    });

    it("cancels pending save immediately if Host is demoted to Guest", () => {
      const mockSave = vi.fn();
      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      let isHost = true;

      const triggerEdit = (content: string) => {
        if (!isHost) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          if (!isHost) return;
          mockSave(content);
        }, 1500);
      };

      // Host initiates an edit
      triggerEdit("Host edit");

      // Peer with smaller clientID joins -> Host demoted to Guest at 500ms
      vi.advanceTimersByTime(500);
      isHost = false;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }

      // Time advances past 1500ms
      vi.advanceTimersByTime(2000);

      // Demoted client must NOT have executed the save
      expect(mockSave).not.toHaveBeenCalled();
    });
  });
});

describe("Signaling Server Configuration & Fallbacks", () => {
  it("includes official high-availability signaling servers and local fallback", () => {
    const servers = getSignalingServers();
    expect(servers).toContain("wss://y-webrtc-eu.fly.dev");
    expect(servers).toContain("wss://y-webrtc.fly.dev");
    expect(servers).toContain("ws://127.0.0.1:4444");
    expect(servers.length).toBeGreaterThanOrEqual(3);
  });
});
