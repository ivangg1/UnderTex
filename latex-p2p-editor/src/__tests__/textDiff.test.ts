import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { applyTextDiff, lineDiff, diffStats } from "../services/textDiff";
import { TEXT_KEY } from "../services/crdtSeed";

function doc(text: string) {
  const d = new Y.Doc();
  const t = d.getText(TEXT_KEY);
  t.insert(0, text);
  return { d, t };
}

describe("applyTextDiff", () => {
  it("transforms the text with minimal operations and leaves untouched regions alone", () => {
    const before = "\\section{A}\nline 1\nline 2\nline 3\n\\section{B}\nend\n";
    const after = "\\section{A}\nline 1\nline two\nline 3\n\\section{B}\nend\n";
    const { d, t } = doc(before);
    const ops = applyTextDiff(t, after);
    expect(t.toString()).toBe(after);
    expect(ops).toBe(2); // one delete + one insert, not a full rewrite
    expect(applyTextDiff(t, after)).toBe(0);
    d.destroy();
  });

  it("handles insertions at the start, deletions at the end and empty targets", () => {
    const { d, t } = doc("b\nc\n");
    applyTextDiff(t, "a\nb\nc\n");
    expect(t.toString()).toBe("a\nb\nc\n");
    applyTextDiff(t, "a\nb\n");
    expect(t.toString()).toBe("a\nb\n");
    applyTextDiff(t, "");
    expect(t.toString()).toBe("");
    applyTextDiff(t, "fresh\n");
    expect(t.toString()).toBe("fresh\n");
    d.destroy();
  });

  it("converges for random edits and syncs the result to a peer as one transaction", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const randomDoc = () =>
      Array.from({ length: Math.floor(rnd() * 30) }, () => `l${Math.floor(rnd() * 8)}`).join("\n") + (rnd() > 0.5 ? "\n" : "");

    const { d: a, t: ta } = doc("");
    const b = new Y.Doc();
    const tb = b.getText(TEXT_KEY);
    for (let i = 0; i < 50; i++) {
      const target = randomDoc();
      let updates = 0;
      const onUpdate = () => updates++;
      a.on("update", onUpdate);
      applyTextDiff(ta, target);
      a.off("update", onUpdate);
      expect(ta.toString()).toBe(target);
      expect(updates).toBeLessThanOrEqual(1); // single transaction
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      expect(tb.toString()).toBe(target);
    }
    a.destroy();
    b.destroy();
  });

  it("tags the transaction with the given origin", () => {
    const { d, t } = doc("x\n");
    const origins: unknown[] = [];
    d.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));
    applyTextDiff(t, "y\n", "restore");
    expect(origins).toEqual(["restore"]);
    d.destroy();
  });
});

describe("lineDiff", () => {
  it("flattens changes to one entry per line with stats", () => {
    const lines = lineDiff("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(lines).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
    expect(lineDiff("same\n", "same\n")).toEqual([{ kind: "same", text: "same" }]);
  });
});
