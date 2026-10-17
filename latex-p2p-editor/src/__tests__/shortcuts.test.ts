import { describe, it, expect } from "vitest";
import { matchShortcut, shortcutLabel, type KeyLike } from "../services/shortcuts";

const k = (key: string, mods: Partial<KeyLike> = {}, code?: string): KeyLike => ({
  key,
  code: code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key),
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("Keyboard shortcuts", () => {
  it("maps ⌘ bindings on macOS and Ctrl elsewhere", () => {
    expect(matchShortcut(k("s", { metaKey: true }), true)).toBe("build");
    expect(matchShortcut(k("s", { ctrlKey: true }), false)).toBe("build");
    expect(matchShortcut(k("s", { ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(k("p", { metaKey: true }), true)).toBe("quickOpen");
    expect(matchShortcut(k("b", { metaKey: true }), true)).toBe("toggleSidebar");
    expect(matchShortcut(k("e", { metaKey: true }), true)).toBe("export");
    expect(matchShortcut(k("Enter", { metaKey: true }), true)).toBe("build");
    expect(matchShortcut(k("o", { metaKey: true }), true)).toBe("open");
  });

  it("handles shifted views and symbol search", () => {
    expect(matchShortcut(k("O", { metaKey: true, shiftKey: true }), true)).toBe("gotoSymbol");
    expect(matchShortcut(k("E", { metaKey: true, shiftKey: true }), true)).toBe("viewFiles");
    expect(matchShortcut(k("L", { ctrlKey: true, shiftKey: true }), false)).toBe("viewOutline");
    expect(matchShortcut(k("H", { metaKey: true, shiftKey: true }), true)).toBe("viewHistory");
  });

  it("uses the physical key so layouts and Option dead keys still match", () => {
    // ⌘P on a layout where the key produces another character.
    expect(matchShortcut(k("π", { metaKey: true }, "KeyP"), true)).toBe("quickOpen");
    expect(matchShortcut(k("+", { altKey: true }, "BracketRight"), true)).toBe("zoomIn");
    expect(matchShortcut(k("-", { metaKey: true }, "Minus"), true)).toBe("zoomOut");
    expect(matchShortcut(k("0", { metaKey: true }, "Digit0"), true)).toBe("zoomReset");
  });

  it("cycles tabs and goes to a line with Ctrl on every platform", () => {
    expect(matchShortcut(k("Tab", { ctrlKey: true }, "Tab"), true)).toBe("nextTab");
    expect(matchShortcut(k("Tab", { ctrlKey: true, shiftKey: true }, "Tab"), false)).toBe("prevTab");
    expect(matchShortcut(k("g", { ctrlKey: true }), true)).toBe("gotoLine");
    expect(matchShortcut(k("g", { metaKey: true }), true)).toBeNull(); // find next stays in the editor
  });

  it("ignores plain typing", () => {
    expect(matchShortcut(k("s"), true)).toBeNull();
    expect(matchShortcut(k("p", { shiftKey: true }), true)).toBeNull();
  });

  it("labels bindings per platform", () => {
    expect(shortcutLabel("quickOpen", true)).toBe("⌘P");
    expect(shortcutLabel("quickOpen", false)).toBe("Ctrl+P");
    expect(shortcutLabel("gotoSymbol", true)).toBe("⌘⇧O");
  });
});
