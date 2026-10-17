import { describe, it, expect } from "vitest";
import { parseLatexLog } from "../services/latexLog";

describe("parseLatexLog", () => {
  it("parses tectonic diagnostics with file and line", () => {
    const logs = [
      "Compiler: tectonic (/opt/homebrew/bin/tectonic)",
      "Status: exit status: 1",
      "--- OUTPUT ---",
      "note: connecting to https://relay.fullyjustified.net/default_bundle.tar",
      "Running TeX ...",
      "error: main.tex:3: Undefined control sequence.",
      "warning: main.tex:7: Overfull \\hbox (12.3pt too wide) in paragraph",
      "error: halted on potentially-recoverable error as specified",
    ].join("\n");

    expect(parseLatexLog(logs)).toEqual([
      { severity: "error", file: "main.tex", line: 3, message: "Undefined control sequence." },
      { severity: "error", message: "halted on potentially-recoverable error as specified" },
      {
        severity: "warning",
        file: "main.tex",
        line: 7,
        message: "Overfull \\hbox (12.3pt too wide) in paragraph",
      },
    ]);
  });

  it("parses pdflatex -file-line-error output and classic '!' errors with l.N hints", () => {
    const logs = [
      "This is pdfTeX, Version 3.141592653",
      "./main.tex:5: Undefined control sequence.",
      "l.5 \\foo",
      "",
      "! Missing $ inserted.",
      "<inserted text>",
      "                $",
      "l.9 a_b",
      "? ",
      "! Emergency stop.",
      "LaTeX Warning: Reference `fig:plot' on page 1 undefined on input line 12.",
      "Package hyperref Warning: Token not allowed in a PDF string on input line 20.",
      "LaTeX Warning: There were undefined references.",
    ].join("\n");

    expect(parseLatexLog(logs)).toEqual([
      { severity: "error", file: "main.tex", line: 5, message: "Undefined control sequence." },
      { severity: "error", line: 9, message: "Missing $ inserted." },
      { severity: "error", message: "Emergency stop." },
      {
        severity: "warning",
        line: 12,
        message: "Reference `fig:plot' on page 1 undefined on input line 12.",
      },
      {
        severity: "warning",
        line: 20,
        message: "Token not allowed in a PDF string on input line 20.",
      },
      { severity: "warning", message: "There were undefined references.", line: undefined },
    ]);
  });

  it("collapses duplicates (two passes) and reports nested include files", () => {
    const pass = [
      "error: chapters/intro.tex:2: Undefined control sequence.",
      "warning: chapters/intro.tex:4: Underfull \\hbox",
    ].join("\n");
    const logs = `=== Pass 1 ===\n${pass}\n=== Pass 2 ===\n${pass}`;
    const result = parseLatexLog(logs);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ severity: "error", file: "chapters/intro.tex", line: 2 });
    expect(result[1]).toMatchObject({ severity: "warning", file: "chapters/intro.tex", line: 4 });
  });

  it("returns an empty list for a clean build", () => {
    const logs = [
      "Compiler: tectonic",
      "Status: exit status: 0",
      "--- OUTPUT ---",
      "note: writing `main.pdf` (18.47 KiB)",
      "note: skipped writing 1 intermediate files",
    ].join("\n");
    expect(parseLatexLog(logs)).toEqual([]);
  });
});
