import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { fnv1a32, seedClientID, seedDocFromText, TEXT_KEY } from "../services/crdtSeed";

const TEX = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n";

describe("deterministic CRDT seeding", () => {
  it("fnv1a32 is stable, uint32 and sensitive to every character", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32(TEX)).toBe(fnv1a32(TEX));
    expect(fnv1a32(TEX)).not.toBe(fnv1a32(TEX + " "));
    expect(seedClientID("x")).toBeGreaterThan(0);
    expect(seedClientID("x")).toBeLessThanOrEqual(0xffffffff);
  });

  it("two peers seeding the same main.tex independently converge to ONE copy", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seedDocFromText(a, TEX);
    seedDocFromText(b, TEX);

    // First sync in both directions (what y-webrtc does on connect).
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));

    expect(a.getText(TEXT_KEY).toString()).toBe(TEX);
    expect(b.getText(TEXT_KEY).toString()).toBe(TEX);
  });

  it("naive seeding (the bug being fixed) duplicates the content on sync", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText(TEXT_KEY).insert(0, TEX);
    b.getText(TEXT_KEY).insert(0, TEX);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(b.getText(TEXT_KEY).toString()).toBe(TEX + TEX);
  });

  it("different seeds are both kept (visible, never corrupt) and later edits merge", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seedDocFromText(a, "A version\n");
    seedDocFromText(b, "B version\n");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const merged = a.getText(TEXT_KEY).toString();
    expect(merged).toContain("A version");
    expect(merged).toContain("B version");
    expect(b.getText(TEXT_KEY).toString()).toBe(merged);

    // Edits made with the docs' own (random) clientIDs still converge.
    a.getText(TEXT_KEY).insert(0, "% a\n");
    b.getText(TEXT_KEY).insert(merged.length, "% b\n");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(a.getText(TEXT_KEY).toString()).toBe(b.getText(TEXT_KEY).toString());
  });

  it("seeding does not change the doc's own clientID and returns the applied update", () => {
    const doc = new Y.Doc();
    const own = doc.clientID;
    const update = seedDocFromText(doc, TEX);
    expect(doc.clientID).toBe(own);
    expect(update.length).toBeGreaterThan(0);
    expect(seedDocFromText(new Y.Doc(), "")).toHaveLength(0);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, update);
    expect(restored.getText(TEXT_KEY).toString()).toBe(TEX);
  });
});
