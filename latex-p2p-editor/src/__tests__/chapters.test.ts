import { describe, it, expect } from "vitest";
import { activeChapter, chapterAtLine, findIncludes, stripComment } from "../services/chapters";

const BOOK = [
  "\\documentclass[a4paper]{report}", // 1
  "\\usepackage{graphicx} % \\include{commented/out}", // 2
  "%\\includeonly{chapters/old}", // 3
  "\\begin{document}", // 4
  "\\tableofcontents", // 5
  "\\include{chapters/intro}", // 6
  "", // 7
  "\\part{Core}", // 8
  "\\include {chapters/methods}", // 9
  "\\includegraphics{figures/plot}", // 10
  "\\include{chapters/results}\\include{appendix/data}", // 11
  "\\end{document}", // 12
].join("\n");

describe("stripComment", () => {
  it("drops unescaped comments and keeps escaped percent signs", () => {
    expect(stripComment("a % b")).toBe("a ");
    expect(stripComment("50\\% off % really")).toBe("50\\% off ");
    expect(stripComment("no comment")).toBe("no comment");
    expect(stripComment("% whole line")).toBe("");
  });
});

describe("findIncludes", () => {
  it("lists real \\include commands with their lines, ignoring comments and look-alikes", () => {
    expect(findIncludes(BOOK)).toEqual([
      { name: "chapters/intro", line: 6 },
      { name: "chapters/methods", line: 9 },
      { name: "chapters/results", line: 11 },
      { name: "appendix/data", line: 11 },
    ]);
  });

  it("returns nothing for documents that use \\input only", () => {
    expect(findIncludes("\\documentclass{article}\n\\begin{document}\n\\input{a}\n\\end{document}")).toEqual([]);
    expect(findIncludes("")).toEqual([]);
  });

  it("skips empty arguments and trims names", () => {
    expect(findIncludes("\\include{}\\include{ x }")).toEqual([{ name: "x", line: 1 }]);
  });
});

describe("chapterAtLine / activeChapter", () => {
  const chapters = findIncludes(BOOK);

  it("picks the \\include on the cursor line", () => {
    expect(chapterAtLine(chapters, 6)).toBe("chapters/intro");
    expect(chapterAtLine(chapters, 9)).toBe("chapters/methods");
  });

  it("picks the nearest \\include above the cursor between chapters", () => {
    expect(chapterAtLine(chapters, 7)).toBe("chapters/intro");
    expect(chapterAtLine(chapters, 8)).toBe("chapters/intro");
    expect(chapterAtLine(chapters, 10)).toBe("chapters/methods");
  });

  it("uses the last \\include of a line with several, and after the last chapter", () => {
    expect(chapterAtLine(chapters, 11)).toBe("appendix/data");
    expect(chapterAtLine(chapters, 12)).toBe("appendix/data");
    expect(chapterAtLine(chapters, 999)).toBe("appendix/data");
  });

  it("falls back to the first chapter while the cursor is still in the preamble", () => {
    expect(chapterAtLine(chapters, 1)).toBe("chapters/intro");
    expect(chapterAtLine(chapters, 5)).toBe("chapters/intro");
  });

  it("returns null without \\include and works end to end", () => {
    expect(chapterAtLine([], 3)).toBeNull();
    expect(activeChapter("\\input{a}", 1)).toBeNull();
    expect(activeChapter(BOOK, 9)).toBe("chapters/methods");
  });
});
