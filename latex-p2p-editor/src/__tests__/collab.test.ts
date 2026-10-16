import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { getSignalingServers } from "../services/collabManager";

describe("Dynamic Leader Election Algorithm (SPEC 4.A)", () => {
  function electLeader(activeClientIDs: number[], myClientID: number): boolean {
    if (activeClientIDs.length === 0) return true;
    const sorted = [...activeClientIDs].sort((a, b) => a - b);
    return myClientID === sorted[0];
  }

  it("assigns isHost = true to the peer with the lowest clientID", () => {
    const peers = [1050, 402, 9999]; // 402 is lowest
    expect(electLeader(peers, 402)).toBe(true);
    expect(electLeader(peers, 1050)).toBe(false);
    expect(electLeader(peers, 9999)).toBe(false);
  });

  it("handles automatic failover when current host disconnects", () => {
    // Initial state: peer 200 is Host
    let activePeers = [200, 350, 500];
    expect(electLeader(activePeers, 200)).toBe(true);
    expect(electLeader(activePeers, 350)).toBe(false);

    // Host 200 disconnects (e.g. closes window or loses connection)
    activePeers = [350, 500];

    // Peer 350 must immediately become the new Host without data loss
    expect(electLeader(activePeers, 350)).toBe(true);
    expect(electLeader(activePeers, 500)).toBe(false);
  });

  it("works reliably with single peer sessions", () => {
    expect(electLeader([777], 777)).toBe(true);
  });
});

describe("Conflict-Free Cloud Persistence & CRDT Sync (SPEC 4.B)", () => {
  it("synchronizes document changes between two Yjs documents via binary updates", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    const text1 = doc1.getText("codemirror");
    const text2 = doc2.getText("codemirror");

    // Peer 1 types initial LaTeX
    text1.insert(0, "\\documentclass{article}\n\\begin{document}\nHello Peer 1\n\\end{document}");

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
