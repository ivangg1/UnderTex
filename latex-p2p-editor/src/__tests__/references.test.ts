import { describe, it, expect } from "vitest";
import {
  buildIndex,
  candidatesFor,
  duplicateLabels,
  extractBibEntries,
  extractLabels,
  findDefinition,
  refContext,
  relativeToRoot,
} from "../services/references";
import { nextThemePref, parseThemePref, resolveTheme } from "../services/theme";

const CHAPTER = [
  "\\section{Results \\emph{so far}}\\label{sec:results}",
  "% \\label{commented}",
  "\\begin{figure}",
  "  \\includegraphics{figures/plot}",
  "  \\caption{A plot}\\label{fig:plot}",
  "\\end{figure}",
  "\\begin{equation}\\label{eq:main}",
].join("\n");

const BIB = `@book{knuth1984,
  title = {The {\\TeX}book},
  author = {Donald E. Knuth and Duane Bibby},
  year = 1984
}
@comment{ignored}
@article{lamport94, author = "Leslie Lamport", title = "LaTeX", year = {1994}}
`;

describe("Reference index", () => {
  it("extracts labels with what they label, ignoring comments", () => {
    expect(extractLabels(CHAPTER, "ch/results.tex").map((l) => [l.name, l.line, l.context])).toEqual([
      ["sec:results", 1, "section: Results so far"],
      ["fig:plot", 5, "caption: A plot"],
      ["eq:main", 7, "equation"],
    ]);
  });

  it("extracts .bib entries with title, first author and year", () => {
    const entries = extractBibEntries(BIB, "refs.bib");
    expect(entries.map((e) => [e.key, e.type, e.title, e.year, e.line])).toEqual([
      ["knuth1984", "book", "The \\TeXbook", "1984", 1],
      ["lamport94", "article", "LaTeX", "1994", 7],
    ]);
    expect(entries[0].author).toBe("Donald E. Knuth and Duane Bibby");
  });

  it("finds duplicated labels across files", () => {
    const index = buildIndex({ "a.tex": "\\label{x}", "b.tex": "\\label{x}\\label{y}" }, []);
    expect(Array.from(duplicateLabels(index).keys())).toEqual(["x"]);
  });
});

describe("Completion contexts", () => {
  it("recognises refs, citations (after commas) and paths", () => {
    expect(refContext("see \\ref{fig:")).toMatchObject({ kind: "ref", prefix: "fig:", from: 9 });
    expect(refContext("\\cref{a,b")).toMatchObject({ kind: "ref", prefix: "b" });
    expect(refContext("as in \\citep[p.~3]{knuth1984, lam")).toMatchObject({ kind: "cite", prefix: "lam" });
    expect(refContext("\\input{chap")).toMatchObject({ kind: "input", prefix: "chap" });
    expect(refContext("\\includegraphics[width=3cm]{fig")).toMatchObject({ kind: "graphics", prefix: "fig" });
    expect(refContext("\\addbibresource{")).toMatchObject({ kind: "bib", command: "addbibresource" });
    expect(refContext("\\ref{done} more text")).toBeNull();
    expect(refContext("plain text")).toBeNull();
  });

  it("offers candidates relative to the root file's folder", () => {
    const index = buildIndex(
      { "thesis/ch/results.tex": CHAPTER, "thesis/refs.bib": BIB },
      ["thesis/main.tex", "thesis/ch/results.tex", "thesis/figures/plot.pdf", "thesis/refs.bib", "shared/logo.png"]
    );
    const root = "thesis/main.tex";
    expect(candidatesFor(refContext("\\ref{")!, index, root).map((c) => c.label)).toEqual(["eq:main", "fig:plot", "sec:results"]);
    const cites = candidatesFor(refContext("\\cite{")!, index, root);
    expect(cites[0]).toMatchObject({ label: "knuth1984", detail: "Donald E. Knuth, 1984" });
    expect(candidatesFor(refContext("\\input{")!, index, root).map((c) => c.label)).toEqual(["ch/results"]);
    expect(candidatesFor(refContext("\\includegraphics{")!, index, root).map((c) => c.label)).toEqual(["figures/plot.pdf", "../shared/logo.png"]);
    expect(candidatesFor(refContext("\\bibliography{")!, index, root).map((c) => c.label)).toEqual(["refs"]);
    expect(relativeToRoot("a/b.tex", "main.tex")).toBe("a/b.tex");
  });
});

describe("Go to definition", () => {
  const index = buildIndex({ "ch/results.tex": CHAPTER, "refs.bib": BIB }, ["main.tex", "ch/results.tex", "figures/plot.pdf", "refs.bib"]);

  it("jumps from a reference to its label and from a citation key to its entry", () => {
    const line = "See \\ref{fig:plot} and \\cite{knuth1984,lamport94}.";
    expect(findDefinition(line, 10, index, "main.tex")).toEqual({ file: "ch/results.tex", line: 5 });
    expect(findDefinition(line, line.indexOf("lamport94") + 2, index, "main.tex")).toEqual({ file: "refs.bib", line: 7 });
    expect(findDefinition(line, line.indexOf("knuth") + 1, index, "main.tex")).toEqual({ file: "refs.bib", line: 1 });
    expect(findDefinition(line, 0, index, "main.tex")).toBeNull();
    expect(findDefinition("\\ref{missing}", 6, index, "main.tex")).toBeNull();
  });

  it("opens included files and graphics", () => {
    expect(findDefinition("\\input{ch/results}", 9, index, "main.tex")).toEqual({ file: "ch/results.tex", line: 1 });
    expect(findDefinition("\\includegraphics[w=1]{figures/plot}", 25, index, "main.tex")).toEqual({ file: "figures/plot.pdf", line: 1 });
    expect(findDefinition("\\bibliography{refs}", 15, index, "main.tex")).toEqual({ file: "refs.bib", line: 1 });
  });
});

describe("Theme preference", () => {
  it("parses, resolves against the system and cycles", () => {
    expect(parseThemePref("light")).toBe("light");
    expect(parseThemePref("bogus")).toBe("system");
    expect(parseThemePref(null)).toBe("system");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect([nextThemePref("dark"), nextThemePref("light"), nextThemePref("system")]).toEqual(["light", "system", "dark"]);
  });
});

describe("Editor completion source", () => {
  it("returns project labels inside \\ref{…} through a real CodeMirror state", async () => {
    const { EditorState } = await import("@codemirror/state");
    const { CompletionContext } = await import("@codemirror/autocomplete");
    const { referenceCompletionSource } = await import("../services/referenceCompletion");
    const index = buildIndex({ "ch/results.tex": CHAPTER }, ["main.tex", "ch/results.tex"]);
    const source = referenceCompletionSource(() => index, () => "main.tex");
    const doc = "see \\ref{sec}";
    const state = EditorState.create({ doc });
    const result = source(new CompletionContext(state, doc.length - 1, false));
    expect(result?.from).toBe(9);
    expect(result?.options.map((o) => o.label)).toContain("sec:results");
    expect(source(new CompletionContext(EditorState.create({ doc: "plain" }), 3, false))).toBeNull();
  });
});
