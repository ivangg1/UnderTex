// Chapter detection for "active chapter" builds.
//
// A root file that splits a long document into `\include{chapters/…}` lines can be
// built one chapter at a time (`\includeonly`, applied by the backend to the
// build copy only). These helpers find the chapters of the root file and the one
// the cursor is "in". They mirror `find_includes` in `compiler.rs`: comments are
// ignored, `\includeonly` / `\includegraphics` do not count, and the chapter name
// is the argument exactly as written.

export interface IncludedChapter {
  /** Argument of `\include{…}` (e.g. `chapters/intro`). */
  name: string;
  /** 1-based line of the `\include`. */
  line: number;
}

/** The code part of a TeX line: everything before a `%` that is not escaped. */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") i++;
    else if (ch === "%") return line.slice(0, i);
  }
  return line;
}

const INCLUDE_RE = /\\include[ \t]*\{([^}]*)\}/g;

/** Every `\include{…}` of the root file, in document order. */
export function findIncludes(text: string): IncludedChapter[] {
  const out: IncludedChapter[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const code = stripComment(lines[i]);
    for (const match of code.matchAll(INCLUDE_RE)) {
      const name = match[1].trim();
      if (name) out.push({ name, line: i + 1 });
    }
  }
  return out;
}

/**
 * The chapter the cursor is in: the `\include` on the cursor line or the nearest
 * one above it (what a reader would call the "current" chapter), else the first
 * one below. `null` when the file has no `\include`.
 */
export function chapterAtLine(chapters: IncludedChapter[], cursorLine: number): string | null {
  if (chapters.length === 0) return null;
  let current: IncludedChapter | null = null;
  for (const chapter of chapters) {
    if (chapter.line <= cursorLine) current = chapter;
    else break;
  }
  return (current ?? chapters[0]).name;
}

/** Convenience: `chapterAtLine(findIncludes(text), cursorLine)`. */
export function activeChapter(text: string, cursorLine: number): string | null {
  return chapterAtLine(findIncludes(text), cursorLine);
}
