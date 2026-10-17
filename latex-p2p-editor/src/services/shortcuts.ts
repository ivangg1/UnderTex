// Global keyboard shortcuts, as a pure key → action mapping so the bindings can
// be unit-tested and listed in the UI. "Mod" is ⌘ on macOS and Ctrl elsewhere.
// Keys are matched by produced character and by physical key, so the bindings
// also work on Spanish/ISO layouts and with Option dead keys.

export type ShortcutAction =
  | "build"
  | "open"
  | "export"
  | "quickOpen"
  | "gotoSymbol"
  | "gotoLine"
  | "toggleSidebar"
  | "viewFiles"
  | "viewOutline"
  | "viewHistory"
  | "nextTab"
  | "prevTab"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset";

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The action bound to a key event, or `null`. `mac` picks ⌘ (true) or Ctrl as Mod. */
export function matchShortcut(e: KeyLike, mac: boolean): ShortcutAction | null {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();

  // Tabs: Ctrl+Tab / Ctrl+Shift+Tab on every platform.
  if (e.ctrlKey && !e.metaKey && !e.altKey && key === "tab") return e.shiftKey ? "prevTab" : "nextTab";
  // Go to line: Ctrl+G everywhere (⌘G stays "find next" in the editor).
  if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && (key === "g" || e.code === "KeyG")) return "gotoLine";

  if (mod || e.altKey) {
    const zoomIn =
      e.code === "Equal" ||
      e.code === "NumpadAdd" ||
      (e.altKey && e.code === "BracketRight") || // "+" key on ISO (Spanish) layouts
      ["+", "=", "≠", "±"].includes(e.key);
    const zoomOut = e.code === "Minus" || e.code === "NumpadSubtract" || ["-", "_", "–", "—"].includes(e.key);
    const zoomReset = e.code === "Digit0" || e.code === "Numpad0" || e.key === "0";
    if (zoomIn) return "zoomIn";
    if (zoomOut) return "zoomOut";
    if (zoomReset) return "zoomReset";
  }
  if (!mod || e.altKey) return null;

  const letter = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : key;
  if (e.shiftKey) {
    switch (letter) {
      case "o":
        return "gotoSymbol";
      case "e":
        return "viewFiles";
      case "h":
        return "viewHistory";
      case "l":
        return "viewOutline";
      default:
        return null;
    }
  }
  switch (letter) {
    case "s":
      return "build";
    case "enter":
      return "build";
    case "o":
      return "open";
    case "e":
      return "export";
    case "p":
      return "quickOpen";
    case "b":
      return "toggleSidebar";
    default:
      return key === "enter" ? "build" : null;
  }
}

/** Human-readable binding for tooltips and the shortcut list. */
export function shortcutLabel(action: ShortcutAction, mac: boolean): string {
  const mod = mac ? "⌘" : "Ctrl+";
  const shift = mac ? "⇧" : "Shift+";
  const ctrl = mac ? "⌃" : "Ctrl+";
  const map: Record<ShortcutAction, string> = {
    build: `${mod}S`,
    open: `${mod}O`,
    export: `${mod}E`,
    quickOpen: `${mod}P`,
    gotoSymbol: `${mod}${shift}O`,
    gotoLine: `${ctrl}G`,
    toggleSidebar: `${mod}B`,
    viewFiles: `${mod}${shift}E`,
    viewOutline: `${mod}${shift}L`,
    viewHistory: `${mod}${shift}H`,
    nextTab: `${ctrl}Tab`,
    prevTab: `${ctrl}${shift}Tab`,
    zoomIn: `${mod}+`,
    zoomOut: `${mod}−`,
    zoomReset: `${mod}0`,
  };
  return map[action];
}

export const isMac = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
