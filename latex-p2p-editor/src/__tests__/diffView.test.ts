import { describe, it, expect } from "vitest";
import { collapseUnchanged } from "../components/DiffView";
import type { DiffHunkLine } from "../services/textDiff";

const same = (n: number): DiffHunkLine[] => Array.from({ length: n }, (_, i) => ({ kind: "same", text: `s${i}` }));

describe("collapseUnchanged", () => {
  it("keeps context lines around changes and collapses the rest into gaps", () => {
    const lines: DiffHunkLine[] = [...same(10), { kind: "added", text: "new" }, ...same(10)];
    const rows = collapseUnchanged(lines, 2);
    expect(rows[0]).toEqual({ kind: "gap", count: 8 });
    expect(rows.slice(1, 6).map((r) => r.kind)).toEqual(["same", "same", "added", "same", "same"]);
    expect(rows.at(-1)).toEqual({ kind: "gap", count: 8 });
    expect(rows).toHaveLength(7);
  });

  it("does not create gaps when everything is near a change, and collapses an all-equal diff", () => {
    const lines: DiffHunkLine[] = [{ kind: "removed", text: "a" }, ...same(2), { kind: "added", text: "b" }];
    expect(collapseUnchanged(lines, 3)).toEqual(lines);
    expect(collapseUnchanged(same(5), 3)).toEqual([{ kind: "gap", count: 5 }]);
    expect(collapseUnchanged([], 3)).toEqual([]);
  });
});
