import { describe, it, expect } from "vitest";
import { addRecent, readRecents, removeRecent, folderName, MAX_RECENTS, RECENTS_KEY, type Storage } from "../services/recents";

function memoryStore(initial: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("recent projects", () => {
  it("adds newest first, dedupes by path and keeps the latest mainFile", () => {
    const store = memoryStore();
    addRecent({ path: "/a", mainFile: "main.tex" }, 1, store);
    addRecent({ path: "/b", mainFile: "main.tex" }, 2, store);
    const list = addRecent({ path: "/a", mainFile: "thesis.tex" }, 3, store);
    expect(list.map((r) => r.path)).toEqual(["/a", "/b"]);
    expect(list[0]).toEqual({ path: "/a", mainFile: "thesis.tex", openedAt: 3 });
    expect(readRecents(store)).toEqual(list);
  });

  it("caps the list and drops the oldest entries", () => {
    const store = memoryStore();
    for (let i = 0; i < MAX_RECENTS + 3; i++) {
      addRecent({ path: `/p${i}`, mainFile: "main.tex" }, i, store);
    }
    const list = readRecents(store);
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0].path).toBe(`/p${MAX_RECENTS + 2}`);
    expect(list.at(-1)?.path).toBe("/p3");
  });

  it("removes entries and survives corrupted storage", () => {
    const store = memoryStore({ [RECENTS_KEY]: "{not json" });
    expect(readRecents(store)).toEqual([]);
    store.setItem(RECENTS_KEY, JSON.stringify([{ path: "/x", mainFile: "m.tex", openedAt: 1 }, { bogus: true }, 42]));
    expect(readRecents(store).map((r) => r.path)).toEqual(["/x"]);
    expect(removeRecent("/x", store)).toEqual([]);
    expect(readRecents(null)).toEqual([]);
  });

  it("folderName handles both path separators", () => {
    expect(folderName("/Users/me/thesis")).toBe("thesis");
    expect(folderName("C:\\Users\\me\\thesis\\")).toBe("thesis");
  });
});
