// Build mode chosen in the top bar, and how it turns into backend `BuildOptions`.
//
// "Scope" says what to typeset: the whole document, the `\include`d chapter the
// cursor is in, or one chapter picked explicitly. Draft and the precompiled
// preamble are independent switches. Export never uses any of this: it always
// asks for a plain full build (`PLAIN_BUILD`).

import type { BuildOptions } from "./tauriBridge";

export type BuildScope = "full" | "cursor" | `chapter:${string}`;

export interface BuildSettings {
  scope: BuildScope;
  draft: boolean;
  precompiledPreamble: boolean;
}

export const DEFAULT_BUILD_SETTINGS: BuildSettings = { scope: "full", draft: false, precompiledPreamble: false };

/** A plain full build: no chapter filter, no draft, no format. What Export uses. */
export const PLAIN_BUILD: BuildOptions = { includeOnly: null, draft: false, precompiledPreamble: false };

export function chapterScope(name: string): BuildScope {
  return `chapter:${name}`;
}

/** The chapter named by a `chapter:` scope, or `null`. */
export function scopeChapter(scope: BuildScope): string | null {
  return scope.startsWith("chapter:") ? scope.slice("chapter:".length) : null;
}

/**
 * The scope that actually applies given the chapters the root file `\include`s:
 * without chapters there is nothing to filter, and a picked chapter that no longer
 * exists falls back to the full document.
 */
export function effectiveScope(scope: BuildScope, chapters: string[]): BuildScope {
  if (chapters.length === 0) return "full";
  const picked = scopeChapter(scope);
  if (picked !== null && !chapters.includes(picked)) return "full";
  return scope;
}

/**
 * Backend options for one build. `cursorChapter` is what the editor reports as
 * the chapter at the cursor (used for the "cursor" scope).
 */
export function resolveBuildOptions(
  settings: BuildSettings,
  chapters: string[],
  cursorChapter: string | null
): BuildOptions {
  const scope = effectiveScope(settings.scope, chapters);
  let includeOnly: string | null = null;
  if (scope === "cursor") {
    includeOnly = cursorChapter !== null && chapters.includes(cursorChapter) ? cursorChapter : null;
  } else {
    includeOnly = scopeChapter(scope);
  }
  return { includeOnly, draft: settings.draft, precompiledPreamble: settings.precompiledPreamble };
}

/** Stable key of a build request, used to skip automatic rebuilds of identical input. */
export function buildKey(text: string, options: BuildOptions): string {
  return `${options.includeOnly ?? ""}\u0000${options.draft ? 1 : 0}${options.precompiledPreamble ? 1 : 0}\u0000${text}`;
}

/** `true` when a build result can be exported as-is (whole document, no draft). */
export function isExportable(result: { mode: "full" | "chapter"; draft: boolean } | null): boolean {
  return result !== null && result.mode === "full" && !result.draft;
}
