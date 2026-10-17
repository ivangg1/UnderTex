// Parser for LaTeX engine output (tectonic and pdflatex) into structured
// diagnostics the UI can list and the editor can jump to.

export type DiagnosticSeverity = "error" | "warning";

export interface LatexDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
  /** File as reported by the engine (relative to the build dir), if known. */
  file?: string;
  /** 1-based line in `file`, if known. */
  line?: number;
}

// tectonic:  "error: main.tex:3: Undefined control sequence."
// pdflatex (-file-line-error):  "./main.tex:3: Undefined control sequence."
const FILE_LINE_RE =
  /^(?:(error|warning):\s*)?(?:\.\/)?([^\s:]+\.(?:tex|sty|cls|bib|bbl|ltx)):(\d+):\s*(.+)$/i;
// tectonic without location: "error: something"  /  "warning: something"
const PLAIN_RE = /^(error|warning):\s*(.+)$/i;
// classic TeX error: "! Undefined control sequence."
const BANG_RE = /^!\s*(.+)$/;
// classic TeX location after a "!" error: "l.12 \foo"
const LINE_HINT_RE = /^l\.(\d+)\b/;
// LaTeX package / class warnings: "LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 12."
const LATEX_WARNING_RE = /^(?:LaTeX|Package \w+|Class \w+)\s+Warning:\s*(.+)$/;
const INPUT_LINE_RE = /on input line (\d+)/;
// Lines that are noise rather than diagnostics.
const IGNORED_PREFIXES = ["note:", "Compiler:", "Status:", "Build cache:", "Assets:", "Passes:", "Duration:"];

function normalizeFile(file: string): string {
  return file.replace(/^\.\//, "");
}

/**
 * Extracts errors and warnings from raw compiler logs. Duplicate diagnostics
 * (same severity, file, line and message) are collapsed; errors come first.
 */
export function parseLatexLog(logs: string): LatexDiagnostic[] {
  const lines = logs.split(/\r?\n/);
  const found: LatexDiagnostic[] = [];
  let pendingBang: LatexDiagnostic | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line || IGNORED_PREFIXES.some((p) => line.startsWith(p))) {
      continue;
    }

    // A "!" error is completed by the next "l.N" hint, if any.
    if (pendingBang) {
      const hint = LINE_HINT_RE.exec(line);
      if (hint) {
        pendingBang.line = Number(hint[1]);
        found.push(pendingBang);
        pendingBang = null;
        continue;
      }
      const isDiagnostic =
        BANG_RE.test(line) || FILE_LINE_RE.test(line) || PLAIN_RE.test(line) || LATEX_WARNING_RE.test(line);
      if (isDiagnostic) {
        found.push(pendingBang);
        pendingBang = null;
        // fall through: parse the current line normally
      } else {
        continue;
      }
    }

    const fileLine = FILE_LINE_RE.exec(line);
    if (fileLine) {
      const [, sev, file, lineNo, message] = fileLine;
      const severity: DiagnosticSeverity =
        sev?.toLowerCase() === "warning" ? "warning" : "error";
      found.push({ severity, file: normalizeFile(file), line: Number(lineNo), message: message.trim() });
      continue;
    }

    const plain = PLAIN_RE.exec(line);
    if (plain) {
      const severity = plain[1].toLowerCase() as DiagnosticSeverity;
      found.push({ severity, message: plain[2].trim() });
      continue;
    }

    const bang = BANG_RE.exec(line);
    if (bang) {
      pendingBang = { severity: "error", message: bang[1].trim() };
      continue;
    }

    const latexWarning = LATEX_WARNING_RE.exec(line);
    if (latexWarning) {
      const message = latexWarning[1].trim();
      const inputLine = INPUT_LINE_RE.exec(message);
      found.push({
        severity: "warning",
        message,
        line: inputLine ? Number(inputLine[1]) : undefined,
      });
    }
  }
  if (pendingBang) {
    found.push(pendingBang);
  }

  const seen = new Set<string>();
  const unique = found.filter((d) => {
    const key = `${d.severity}|${d.file ?? ""}|${d.line ?? ""}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const errors = unique.filter((d) => d.severity === "error");
  const warnings = unique.filter((d) => d.severity === "warning");
  return [...errors, ...warnings];
}
