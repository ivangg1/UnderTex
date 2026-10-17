import { describe, it, expect } from "vitest";
import { clientToPdfPoint, isSyncClick, pdfRectToCss, scrollForRect } from "../services/synctex";
import { matchShortcut, shortcutLabel, type KeyLike } from "../services/shortcuts";

const LETTER = { width: 612, height: 792 };

describe("SyncTeX click mapping", () => {
  it("maps a click to PDF points at any zoom", () => {
    // Page rendered at 150% with its corner at (100, 50).
    const page = { left: 100, top: 50, width: 612 * 1.5, height: 792 * 1.5 };
    expect(clientToPdfPoint(100, 50, page, LETTER)).toEqual({ x: 0, y: 0 });
    const p = clientToPdfPoint(100 + 306 * 1.5, 50 + 72 * 1.5, page, LETTER)!;
    expect(p.x).toBeCloseTo(306);
    expect(p.y).toBeCloseTo(72);
    // Fit-to-width rounds the rendered size down: the mapping uses the real box.
    const fitted = { left: 0, top: 0, width: Math.floor(612 * 0.83), height: Math.floor(792 * 0.83) };
    const q = clientToPdfPoint(fitted.width, fitted.height, fitted, LETTER)!;
    expect(q.x).toBeCloseTo(612);
    expect(q.y).toBeCloseTo(792);
  });

  it("ignores clicks outside the page and empty boxes", () => {
    const page = { left: 0, top: 0, width: 612, height: 792 };
    expect(clientToPdfPoint(-1, 10, page, LETTER)).toBeNull();
    expect(clientToPdfPoint(10, 793, page, LETTER)).toBeNull();
    expect(clientToPdfPoint(1, 1, { left: 0, top: 0, width: 0, height: 0 }, LETTER)).toBeNull();
  });

  it("uses ⌘ on macOS and Ctrl elsewhere", () => {
    expect(isSyncClick({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isSyncClick({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(isSyncClick({ metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(isSyncClick({ metaKey: true, ctrlKey: false, altKey: true }, true)).toBe(false);
  });
});

describe("SyncTeX highlight and scroll", () => {
  const line = { x: 133.8, y: 140, width: 345, height: 9 };

  it("places the highlight in CSS pixels of the scaled page", () => {
    const css = pdfRectToCss(line, 2, 2);
    expect(css.left).toBeCloseTo(133.8 * 2 - 2);
    expect(css.top).toBeCloseTo(140 * 2 - 2);
    expect(css.width).toBeCloseTo(345 * 2 + 4);
    expect(css.height).toBeCloseTo(9 * 2 + 4);
    // Zero-sized boxes stay visible.
    expect(pdfRectToCss({ x: 0, y: 0, width: 0, height: 0 }, 1, 0).width).toBe(1);
  });

  it("scrolls the box a third down the viewport and only pans when it is off screen", () => {
    const viewport = { width: 600, height: 900, scrollLeft: 0 };
    const page3 = { top: 2 * (792 + 16) + 16, left: 20 };
    const s = scrollForRect(line, 1, page3, viewport);
    expect(s.top).toBeCloseTo(page3.top + 140 - 300);
    expect(s.left).toBe(0);
    // Zoomed in: the line starts beyond the viewport → pan to it.
    const z = scrollForRect(line, 3, { top: 0, left: 20 }, viewport);
    expect(z.left).toBeCloseTo(20 + 133.8 * 3 - 24);
    // Near the top of the document: never a negative scroll.
    expect(scrollForRect({ x: 0, y: 10, width: 10, height: 10 }, 1, { top: 0, left: 0 }, viewport).top).toBe(0);
  });
});

describe("Sync shortcut", () => {
  const k = (key: string, mods: Partial<KeyLike>): KeyLike => ({
    key,
    code: `Key${key.toUpperCase()}`,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });
  it("binds ⌘⇧J / Ctrl+Shift+J", () => {
    expect(matchShortcut(k("J", { metaKey: true, shiftKey: true }), true)).toBe("syncPdf");
    expect(matchShortcut(k("J", { ctrlKey: true, shiftKey: true }), false)).toBe("syncPdf");
    expect(matchShortcut(k("j", { metaKey: true }), true)).toBeNull();
    expect(shortcutLabel("syncPdf", true)).toBe("⌘⇧J");
    expect(shortcutLabel("syncPdf", false)).toBe("Ctrl+Shift+J");
  });
});
