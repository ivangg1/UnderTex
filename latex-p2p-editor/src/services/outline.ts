// Document outline: the sectioning commands of a .tex file, plus the files it
// pulls in with \input / \include, so the side panel can show (and jump to) the
// structure of whatever file is open. Parsed from the live text on every edit;
// comments and verbatim-like environments are ignored.

import { stripComment } from "./chapters";

export type OutlineKind =
  | "part"
  | "chapter"
  | "section"
  | "subsection"
  | "subsubsection"
  | "paragraph"
  | "subparagraph"
  | "input";

export interface OutlineItem {
  kind: OutlineKind;
  /** Depth: part 0 … subparagraph 6; an input sits one below the last heading. */
  level: number;
  /** Heading text with LaTeX markup removed, or the argument of \input/\include. */
  title: string;
  /** 1-based line of the command. */
  line: number;
  starred: boolean;
  /** For `input`: the project file it refers to (relative path, with extension). */
  target?: string;
}

const LEVELS: Record<Exclude<OutlineKind, "input">, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

const HEADING_RE =
  /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|input|include|subfile)\b(\*)?[ \t]*(?:\[[^\]]*\][ \t]*)?\{/g;
const VERBATIM_BEGIN_RE = /\\begin\{(verbatim\*?|lstlisting|minted|comment|Verbatim)\}/;

/** Text inside the braces that open right before `start`, possibly spanning lines. */
function readGroup(text: string, start: number): string {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i);
    else if (ch === "\n" && i - start > 400) break; // runaway argument
  }
  return text.slice(start, text.indexOf("\n", start) === -1 ? text.length : text.indexOf("\n", start));
}

/** Heading argument → plain text (drops \label, unwraps \emph{…} and friends). */
export function cleanTitle(raw: string): string {
  let s = raw.replace(/\\label\s*\{[^{}]*\}/g, "");
  // Unwrap one-argument commands from the inside out.
  for (let i = 0; i < 8 && /\\[a-zA-Z]+\*?\s*\{[^{}]*\}/.test(s); i++) {
    s = s.replace(/\\[a-zA-Z]+\*?\s*\{([^{}]*)\}/g, "$1");
  }
  return s
    .replace(/\\[a-zA-Z]+\*?/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/[{}$]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Project path of an `\input{name}` / `\include{name}`: TeX resolves it from
 * the directory of the root file, adding `.tex` when no extension is given.
 */
export function resolveTexInput(name: string, rootFile: string): string {
  const slash = rootFile.lastIndexOf("/");
  const base = slash === -1 ? "" : rootFile.slice(0, slash + 1);
  const withExt = /\.[a-z0-9]+$/i.test(name.split("/").pop() ?? "") ? name : `${name}.tex`;
  return normalize(base + withExt.trim());
}

/** Sectioning commands and inputs of `text`, in document order. */
export function parseOutline(text: string, rootFile = "main.tex"): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = text.split("\n");
  // Offsets of each line start, so a multi-line heading argument can be read.
  const offsets: number[] = [];
  let pos = 0;
  for (const line of lines) {
    offsets.push(pos);
    pos += line.length + 1;
  }
  let verbatimEnd: string | null = null;
  let lastLevel = 1;
  for (let i = 0; i < lines.length; i++) {
    const code = stripComment(lines[i]);
    if (verbatimEnd) {
      if (code.includes(verbatimEnd)) verbatimEnd = null;
      continue;
    }
    const verb = VERBATIM_BEGIN_RE.exec(code);
    if (verb) {
      verbatimEnd = `\\end{${verb[1]}}`;
      if (!code.slice(verb.index).includes(verbatimEnd)) continue;
      verbatimEnd = null;
    }
    for (const match of code.matchAll(HEADING_RE)) {
      const cmd = match[1];
      const argStart = offsets[i] + (match.index ?? 0) + match[0].length;
      const arg = readGroup(text, argStart);
      if (cmd === "input" || cmd === "include" || cmd === "subfile") {
        const name = arg.trim();
        if (!name) continue;
        items.push({
          kind: "input",
          level: lastLevel + 1,
          title: name,
          line: i + 1,
          starred: false,
          target: resolveTexInput(name, rootFile),
        });
        continue;
      }
      const kind = cmd as Exclude<OutlineKind, "input">;
      lastLevel = LEVELS[kind];
      items.push({ kind, level: lastLevel, title: cleanTitle(arg) || "…", line: i + 1, starred: match[2] === "*" });
    }
  }
  return items;
}

/** The heading the given line belongs to (last one at or above it), for highlighting. */
export function currentOutlineIndex(items: OutlineItem[], line: number): number {
  let found = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === "input") continue;
    if (items[i].line <= line) found = i;
    else break;
  }
  return found;
}

/**
 * The `\include` chapter of the root file that `file` is, when editing a
 * chapter in its own tab (so "build the chapter at the cursor" builds it).
 */
export function chapterOfFile(file: string, rootFile: string, includes: { name: string }[]): string | null {
  const hit = includes.find((c) => resolveTexInput(c.name, rootFile) === file);
  return hit ? hit.name : null;
}
