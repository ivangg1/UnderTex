import { describe, it, expect } from "vitest";
import {
  DEFAULT_BUILD_SETTINGS,
  PLAIN_BUILD,
  buildKey,
  chapterScope,
  effectiveScope,
  isExportable,
  resolveBuildOptions,
  scopeChapter,
} from "../services/buildMode";

const CHAPTERS = ["chapters/intro", "chapters/methods"];

describe("build scopes", () => {
  it("round-trips chapter scopes", () => {
    expect(chapterScope("chapters/intro")).toBe("chapter:chapters/intro");
    expect(scopeChapter("chapter:chapters/intro")).toBe("chapters/intro");
    expect(scopeChapter("full")).toBeNull();
    expect(scopeChapter("cursor")).toBeNull();
  });

  it("falls back to the full document without chapters or with a vanished chapter", () => {
    expect(effectiveScope("cursor", [])).toBe("full");
    expect(effectiveScope("chapter:chapters/intro", [])).toBe("full");
    expect(effectiveScope("chapter:chapters/old", CHAPTERS)).toBe("full");
    expect(effectiveScope("chapter:chapters/intro", CHAPTERS)).toBe("chapter:chapters/intro");
    expect(effectiveScope("cursor", CHAPTERS)).toBe("cursor");
  });
});

describe("resolveBuildOptions", () => {
  it("builds the whole document by default", () => {
    expect(resolveBuildOptions(DEFAULT_BUILD_SETTINGS, CHAPTERS, "chapters/intro")).toEqual(PLAIN_BUILD);
  });

  it("uses the chapter at the cursor for the cursor scope, only when it is a real chapter", () => {
    const settings = { ...DEFAULT_BUILD_SETTINGS, scope: "cursor" as const };
    expect(resolveBuildOptions(settings, CHAPTERS, "chapters/methods").includeOnly).toBe("chapters/methods");
    expect(resolveBuildOptions(settings, CHAPTERS, null).includeOnly).toBeNull();
    expect(resolveBuildOptions(settings, CHAPTERS, "chapters/other").includeOnly).toBeNull();
    expect(resolveBuildOptions(settings, [], "chapters/intro").includeOnly).toBeNull();
  });

  it("uses the picked chapter and carries draft and preamble flags", () => {
    const settings = { scope: chapterScope("chapters/intro"), draft: true, precompiledPreamble: true };
    expect(resolveBuildOptions(settings, CHAPTERS, "chapters/methods")).toEqual({
      includeOnly: "chapters/intro",
      draft: true,
      precompiledPreamble: true,
    });
  });
});

describe("buildKey / isExportable", () => {
  it("changes when the text or any option changes", () => {
    const base = buildKey("abc", PLAIN_BUILD);
    expect(buildKey("abc", PLAIN_BUILD)).toBe(base);
    expect(buildKey("abd", PLAIN_BUILD)).not.toBe(base);
    expect(buildKey("abc", { ...PLAIN_BUILD, draft: true })).not.toBe(base);
    expect(buildKey("abc", { ...PLAIN_BUILD, precompiledPreamble: true })).not.toBe(base);
    expect(buildKey("abc", { ...PLAIN_BUILD, includeOnly: "x" })).not.toBe(base);
  });

  it("only full, non-draft results can be exported directly", () => {
    expect(isExportable(null)).toBe(false);
    expect(isExportable({ mode: "full", draft: false })).toBe(true);
    expect(isExportable({ mode: "full", draft: true })).toBe(false);
    expect(isExportable({ mode: "chapter", draft: false })).toBe(false);
  });
});
