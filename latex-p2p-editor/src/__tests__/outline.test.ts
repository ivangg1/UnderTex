import { describe, it, expect } from "vitest";
import { chapterOfFile, cleanTitle, currentOutlineIndex, parseOutline, resolveTexInput } from "../services/outline";
import {
  flattenFiles,
  fuzzyScore,
  isSameOrInside,
  mergeSharedFiles,
  rankFiles,
  renamePath,
  resolveDiagnosticFile,
  type TreeNode,
} from "../services/projectFiles";

const DOC = [
  "\\documentclass{book}",
  "\\begin{document}",
  "\\part{Theory}",
  "\\chapter{Getting \\emph{started}}\\label{ch:start}",
  "% \\section{Commented out}",
  "\\section*{Why~\\LaTeX?}",
  "\\input{chapters/intro}",
  "\\begin{verbatim}",
  "\\section{Inside verbatim}",
  "\\end{verbatim}",
  "\\subsection[Short]{A long",
  "  title over two lines}",
  "\\include{appendix.tex}",
  "\\end{document}",
].join("\n");

describe("Outline", () => {
  it("lists headings with levels and lines, skipping comments and verbatim", () => {
    const items = parseOutline(DOC, "main.tex");
    expect(items.map((i) => [i.kind, i.level, i.title, i.line])).toEqual([
      ["part", 0, "Theory", 3],
      ["chapter", 1, "Getting started", 4],
      ["section", 2, "Why ?", 6],
      ["input", 3, "chapters/intro", 7],
      ["subsection", 3, "A long title over two lines", 11],
      ["input", 4, "appendix.tex", 13],
    ]);
    expect(items[2].starred).toBe(true);
    expect(items[3].target).toBe("chapters/intro.tex");
    expect(items[5].target).toBe("appendix.tex");
  });

  it("resolves inputs from the root file's folder", () => {
    expect(resolveTexInput("chapters/a", "thesis/main.tex")).toBe("thesis/chapters/a.tex");
    expect(resolveTexInput("../shared/b.tex", "thesis/main.tex")).toBe("shared/b.tex");
    expect(resolveTexInput("c", "main.tex")).toBe("c.tex");
  });

  it("tells which \\include chapter a file is", () => {
    const includes = [{ name: "chapters/intro" }, { name: "chapters/end.tex" }];
    expect(chapterOfFile("thesis/chapters/intro.tex", "thesis/main.tex", includes)).toBe("chapters/intro");
    expect(chapterOfFile("chapters/end.tex", "main.tex", includes)).toBe("chapters/end.tex");
    expect(chapterOfFile("other.tex", "main.tex", includes)).toBeNull();
  });

  it("cleans markup from titles", () => {
    expect(cleanTitle("The \\textbf{bold} and \\emph{\\textit{nested}} \\label{x}")).toBe("The bold and nested");
    expect(cleanTitle("100\\% sure")).toBe("100% sure");
  });

  it("finds the heading a line belongs to", () => {
    const items = parseOutline(DOC);
    expect(currentOutlineIndex(items, 1)).toBe(-1);
    expect(currentOutlineIndex(items, 5)).toBe(1);
    expect(currentOutlineIndex(items, 8)).toBe(2);
    expect(currentOutlineIndex(items, 99)).toBe(4);
  });
});

const TREE: TreeNode[] = [
  { name: "chapters", path: "chapters", is_dir: true, children: [{ name: "intro.tex", path: "chapters/intro.tex", is_dir: false }] },
  { name: "main.tex", path: "main.tex", is_dir: false },
  { name: "refs.bib", path: "refs.bib", is_dir: false },
];

describe("Project file helpers", () => {
  it("flattens the tree in order", () => {
    expect(flattenFiles(TREE)).toEqual(["chapters/intro.tex", "main.tex", "refs.bib"]);
  });

  it("merges files shared in the room without touching the input tree", () => {
    const merged = mergeSharedFiles(TREE, ["main.tex", "chapters/methods.tex", "appendix/a.tex"]);
    expect(flattenFiles(merged)).toEqual(["appendix/a.tex", "chapters/intro.tex", "chapters/methods.tex", "main.tex", "refs.bib"]);
    const appendix = merged.find((n) => n.path === "appendix");
    expect(appendix?.remote).toBe(true);
    expect(merged.find((n) => n.path === "chapters")?.children?.find((n) => n.path === "chapters/methods.tex")?.remote).toBe(true);
    expect(flattenFiles(TREE)).toHaveLength(3);
    expect(mergeSharedFiles(TREE, ["main.tex"])).toEqual(TREE);
  });

  it("renames paths inside a renamed folder", () => {
    expect(renamePath("chapters/intro.tex", "chapters", "parts")).toBe("parts/intro.tex");
    expect(renamePath("chapters2/x.tex", "chapters", "parts")).toBe("chapters2/x.tex");
    expect(renamePath("a.tex", "a.tex", "b.tex")).toBe("b.tex");
    expect(isSameOrInside("chapters", "chapters/intro.tex")).toBe(true);
    expect(isSameOrInside("chapters", "chapters2/intro.tex")).toBe(false);
  });

  it("fuzzy-ranks file names above path noise", () => {
    const paths = ["chapters/introduction.tex", "figures/intro.png", "main.tex", "notes/in-progress/todo.tex"];
    expect(fuzzyScore("xyz", "main.tex")).toBeNull();
    expect(rankFiles("intro", paths)[0]).toBe("figures/intro.png");
    expect(rankFiles("chint", paths)[0]).toBe("chapters/introduction.tex");
    expect(rankFiles("mn", paths)).toEqual(["main.tex"]);
    expect(rankFiles("", paths, 2)).toEqual(paths.slice(0, 2));
  });

  it("maps compiler diagnostics to project files", () => {
    const files = ["main.tex", "chapters/intro.tex", "thesis/main.tex", "thesis/ch/a.tex"];
    expect(resolveDiagnosticFile(undefined, "main.tex", files)).toBe("main.tex");
    expect(resolveDiagnosticFile("./chapters/intro.tex", "main.tex", files)).toBe("chapters/intro.tex");
    expect(resolveDiagnosticFile("ch/a.tex", "thesis/main.tex", files)).toBe("thesis/ch/a.tex");
    expect(resolveDiagnosticFile("/Users/x/Library/Caches/build/abc/thesis/ch/a.tex", "thesis/main.tex", files)).toBe("thesis/ch/a.tex");
    expect(resolveDiagnosticFile("article.cls", "main.tex", files)).toBeNull();
  });
});
