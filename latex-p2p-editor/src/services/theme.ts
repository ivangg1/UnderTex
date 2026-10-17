// Color theme: Monokai Pro dark (default) or Monokai Pro light, or follow the
// system. Every color of the UI is a CSS variable (`--color-mk-*`, see App.css);
// the theme only sets `data-theme` on <html>, and the editor reads the same
// variables, so switching is instant and needs no reload.

import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

export const THEME_KEY = "latex_theme";

export function parseThemePref(raw: string | null | undefined): ThemePref {
  return raw === "dark" || raw === "light" || raw === "system" ? raw : "system";
}

export function resolveTheme(pref: ThemePref, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === "system") return systemPrefersDark ? "dark" : "light";
  return pref;
}

/** Next preference for the one-click toggle: dark → light → system → dark. */
export function nextThemePref(pref: ThemePref): ThemePref {
  return pref === "dark" ? "light" : pref === "light" ? "system" : "dark";
}

const media = (): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function readPref(): ThemePref {
  try {
    return parseThemePref(globalThis.localStorage?.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

let pref: ThemePref = readPref();
let resolved: ResolvedTheme = resolveTheme(pref, media()?.matches ?? true);
const listeners = new Set<() => void>();

function apply(): void {
  resolved = resolveTheme(pref, media()?.matches ?? true);
  if (typeof document !== "undefined") document.documentElement.dataset.theme = resolved;
  listeners.forEach((l) => l());
}

export function getThemePref(): ThemePref {
  return pref;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved;
}

export function setThemePref(next: ThemePref): void {
  pref = next;
  try {
    globalThis.localStorage?.setItem(THEME_KEY, next);
  } catch {
    // storage unavailable
  }
  apply();
}

/** Applies the stored theme and follows system changes. Call once at startup. */
export function initTheme(): void {
  apply();
  media()?.addEventListener("change", () => {
    if (pref === "system") apply();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `[preference, resolved theme]`, re-rendering on change. */
export function useTheme(): [ThemePref, ResolvedTheme] {
  const p = useSyncExternalStore(subscribe, getThemePref, getThemePref);
  const r = useSyncExternalStore(subscribe, getResolvedTheme, getResolvedTheme);
  return [p, r];
}
