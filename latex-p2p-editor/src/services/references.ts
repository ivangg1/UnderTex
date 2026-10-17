// Project-wide reference index for smart completion and "go to definition":
// every \label in every .tex file (open, shared by peers or only on disk), every
// entry of every .bib file, and the project's files for \input / \include /
// \includegraphics / \bibliography paths. Pure functions, so the editor can
// rebuild the index whenever a file changes.

import { stripComment } from "./chapters";
import { cleanTitle } from "./outline";

export interface LabelRef {
  name: string;
  file: string;
  /** 1-based line of the \label. */
  line: number;
  /** What the label points at: the nearest heading / caption, for the completion list. */
  context: string;
}

export interface BibEntry {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
  file: string;
  line: number;
}

export interface ProjectIndex {
  labels: LabelRef[];
  bib: BibEntry[];
  /** Every project file (relative paths). */
  files: string[];
}

export const EMPTY_INDEX: ProjectIndex = { labels: [], bib: [], files: [] };

const LABEL_RE = /\\label\s*\{([^{}]+)\}/g;
const CONTEXT_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph|caption)\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/;
const BEGIN_RE = /\\begin\{(figure|table|equation|align|theorem|lemma|definition|proposition|corollary|listing)\*?\}/;

/** Every `\label{…}` of a .tex file, with a short description of what it labels. */
export function extractLabels(text: string, file: string): LabelRef[] {
  const out: LabelRef[] = [];
  const lines = text.split("\n");
  let context = "";
  for (let i = 0; i < lines.length; i++) {
    const code = stripComment(lines[i]);
    const heading = CONTEXT_RE.exec(code);
    if (heading) context = `${heading[1]}: ${cleanTitle(heading[2])}`;
    const env = BEGIN_RE.exec(code);
    if (env && !heading) context = env[1];
    for (const match of code.matchAll(LABEL_RE)) {
      const name = match[1].trim();
      if (name) out.push({ name, file, line: i + 1, context });
    }
  }
  return out;
}

function bibField(body: string, field: string): string | undefined {
  const re = new RegExp(`\\b${field}\\s*=\\s*(?:\\{((?:[^{}]|\\{[^{}]*\\})*)\\}|"([^"]*)"|(\\d+))`, "i");
  const m = re.exec(body);
  const value = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  return value ? value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim() : undefined;
}

/** Entries of a .bib file (key, type, title, author, year, line). */
export function extractBibEntries(text: string, file: string): BibEntry[] {
  const out: BibEntry[] = [];
  const re = /@(\w+)\s*[{(]\s*([^,\s{}()]+)\s*,/g;
  const starts: { index: number; type: string; key: string }[] = [];
  for (const m of text.matchAll(re)) {
    const type = m[1].toLowerCase();
    if (type === "comment" || type === "string" || type === "preamble") continue;
    starts.push({ index: m.index ?? 0, type, key: m[2] });
  }
  for (let i = 0; i < starts.length; i++) {
    const { index, type, key } = starts[i];
    const body = text.slice(index, i + 1 < starts.length ? starts[i + 1].index : text.length);
    const line = text.slice(0, index).split("\n").length;
    out.push({ key, type, title: bibField(body, "title"), author: bibField(body, "author"), year: bibField(body, "year"), file, line });
  }
  return out;
}

/** Index of the given file texts (path → content); `files` lists every project file. */
export function buildIndex(texts: Record<string, string>, files: string[]): ProjectIndex {
  const labels: LabelRef[] = [];
  const bib: BibEntry[] = [];
  for (const [path, text] of Object.entries(texts)) {
    const lower = path.toLowerCase();
    if (lower.endsWith(".tex") || lower.endsWith(".sty") || lower.endsWith(".cls")) labels.push(...extractLabels(text, path));
    else if (lower.endsWith(".bib")) bib.push(...extractBibEntries(text, path));
  }
  labels.sort((a, b) => a.name.localeCompare(b.name));
  bib.sort((a, b) => a.key.localeCompare(b.key));
  const all = Array.from(new Set([...files, ...Object.keys(texts)])).sort();
  return { labels, bib, files: all };
}

// ─── Completion contexts ────────────────────────────────────────────

export type RefKind = "ref" | "cite" | "input" | "graphics" | "bib";

export interface RefContext {
  kind: RefKind;
  /** The command, e.g. `cite`, `includegraphics`, `addbibresource`. */
  command: string;
  /** Text typed for the current item (after the last comma for citations). */
  prefix: string;
  /** Offset of `prefix` within the analysed text. */
  from: number;
}

const REF_CMDS = "ref|eqref|pageref|autoref|cref|Cref|crefrange|nameref|vref|labelcref";
const CITE_CMDS = "cite|citep|citet|citealp|citeauthor|citeyear|parencite|textcite|autocite|footcite|fullcite|smartcite|nocite|Cite|Textcite|Parencite";
const CONTEXT_PATTERNS: { kind: RefKind; re: RegExp }[] = [
  { kind: "ref", re: new RegExp(`\\\\(${REF_CMDS})\\*?\\{([^{}]*)$`) },
  { kind: "cite", re: new RegExp(`\\\\(${CITE_CMDS})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^{}]*)$`) },
  { kind: "input", re: /\\(input|include|subfile|includeonly)\{([^{}]*)$/ },
  { kind: "graphics", re: /\\(includegraphics|includesvg|includepdf)\*?(?:\[[^\]]*\])?\{([^{}]*)$/ },
  { kind: "bib", re: /\\(bibliography|addbibresource)(?:\[[^\]]*\])?\{([^{}]*)$/ },
];

/** What is being completed at the end of `before` (the line up to the cursor), if anything. */
export function refContext(before: string): RefContext | null {
  for (const { kind, re } of CONTEXT_PATTERNS) {
    const m = re.exec(before);
    if (!m) continue;
    const arg = m[2];
    const lastComma = kind === "cite" || kind === "ref" ? arg.lastIndexOf(",") : -1;
    const prefixRaw = arg.slice(lastComma + 1);
    const prefix = prefixRaw.trimStart();
    return { kind, command: m[1], prefix, from: before.length - prefix.length };
  }
  return null;
}

/** `path` relative to the folder of the root file (how TeX resolves it), or `null` if outside. */
export function relativeToRoot(path: string, rootFile: string): string | null {
  const slash = rootFile.lastIndexOf("/");
  if (slash === -1) return path;
  const base = rootFile.slice(0, slash + 1);
  if (path.startsWith(base)) return path.slice(base.length);
  // Outside the root's folder: climb with "../".
  const up = rootFile.slice(0, slash).split("/").length;
  return `${"../".repeat(up)}${path}`;
}

export interface RefCandidate {
  label: string;
  detail?: string;
  info?: string;
  type: "label" | "cite" | "file";
}

const IMAGE_RE = /\.(png|jpe?g|pdf|eps|svg|gif|bmp|webp)$/i;

/** Completion candidates for a context, best first (filtering by prefix is left to the editor). */
export function candidatesFor(ctx: RefContext, index: ProjectIndex, rootFile: string): RefCandidate[] {
  const list = rawCandidates(ctx, index, rootFile);
  // Files next to the root first, then the ones reached with "../".
  return ctx.kind === "input" || ctx.kind === "graphics" || ctx.kind === "bib"
    ? list.sort((a, b) => Number(a.label.startsWith("../")) - Number(b.label.startsWith("../")) || a.label.localeCompare(b.label))
    : list;
}

function rawCandidates(ctx: RefContext, index: ProjectIndex, rootFile: string): RefCandidate[] {
  switch (ctx.kind) {
    case "ref": {
      const seen = new Set<string>();
      return index.labels
        .filter((l) => !seen.has(l.name) && seen.add(l.name))
        .map((l) => ({ label: l.name, detail: l.context, info: `${l.file}:${l.line}`, type: "label" as const }));
    }
    case "cite":
      return index.bib.map((b) => ({
        label: b.key,
        detail: [b.author?.split(/\s+and\s+/i)[0], b.year].filter(Boolean).join(", "),
        info: b.title ? `${b.title} — ${b.file}:${b.line}` : `${b.file}:${b.line}`,
        type: "cite" as const,
      }));
    case "input":
      return index.files
        .filter((f) => f.toLowerCase().endsWith(".tex") && f !== rootFile)
        .map((f) => relativeToRoot(f, rootFile))
        .filter((f): f is string => f !== null)
        .map((f) => ({ label: f.replace(/\.tex$/i, ""), detail: ".tex", type: "file" as const }));
    case "graphics":
      return index.files
        .filter((f) => IMAGE_RE.test(f))
        .map((f) => relativeToRoot(f, rootFile))
        .filter((f): f is string => f !== null)
        .map((f) => ({ label: f, type: "file" as const }));
    case "bib":
      return index.files
        .filter((f) => f.toLowerCase().endsWith(".bib"))
        .map((f) => relativeToRoot(f, rootFile))
        .filter((f): f is string => f !== null)
        .map((f) => ({ label: ctx.command === "bibliography" ? f.replace(/\.bib$/i, "") : f, type: "file" as const }));
  }
}

// ─── Go to definition ───────────────────────────────────────────────

export interface Definition {
  file: string;
  line: number;
}

const DEF_RE = new RegExp(
  `\\\\(${REF_CMDS}|${CITE_CMDS}|input|include|subfile|includegraphics|bibliography|addbibresource)\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^{}]*)\\}`,
  "g"
);

function resolveFromRoot(name: string, rootFile: string, files: string[], exts: string[]): string | null {
  const slash = rootFile.lastIndexOf("/");
  const base = slash === -1 ? "" : rootFile.slice(0, slash + 1);
  const parts: string[] = [];
  for (const part of `${base}${name.trim()}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const joined = parts.join("/");
  for (const candidate of [joined, ...exts.map((e) => `${joined}${e}`)]) {
    if (files.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * Where the reference under the cursor is defined: the \label of a \ref, the
 * .bib entry of a \cite (the key under the cursor), or the file of an
 * \input / \includegraphics. `col` is the 0-based cursor column in `line`.
 */
export function findDefinition(line: string, col: number, index: ProjectIndex, rootFile: string): Definition | null {
  for (const m of line.matchAll(DEF_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (col < start || col > end) continue;
    const cmd = m[1];
    const arg = m[2];
    const argStart = end - 1 - arg.length;
    if (new RegExp(`^(${REF_CMDS}|${CITE_CMDS})$`).test(cmd)) {
      // The comma-separated key under the cursor (or the first one).
      let key = arg.split(",")[0];
      let offset = argStart;
      for (const part of arg.split(",")) {
        if (col >= offset && col <= offset + part.length) key = part;
        offset += part.length + 1;
      }
      key = key.trim();
      if (new RegExp(`^(${REF_CMDS})$`).test(cmd)) {
        const label = index.labels.find((l) => l.name === key);
        return label ? { file: label.file, line: label.line } : null;
      }
      const entry = index.bib.find((b) => b.key === key);
      return entry ? { file: entry.file, line: entry.line } : null;
    }
    const exts =
      cmd === "includegraphics" ? [".pdf", ".png", ".jpg", ".jpeg", ".eps"] : cmd === "bibliography" || cmd === "addbibresource" ? [".bib"] : [".tex"];
    const file = resolveFromRoot(arg.split(",")[0], rootFile, index.files, exts);
    return file ? { file, line: 1 } : null;
  }
  return null;
}

/** Labels defined more than once (a common source of wrong references), name → places. */
export function duplicateLabels(index: ProjectIndex): Map<string, LabelRef[]> {
  const byName = new Map<string, LabelRef[]>();
  for (const l of index.labels) byName.set(l.name, [...(byName.get(l.name) ?? []), l]);
  for (const [name, list] of byName) if (list.length < 2) byName.delete(name);
  return byName;
}
