// SyncTeX navigation helpers: the geometry between what the preview shows (CSS
// pixels of a rendered page) and what the backend's SyncTeX search speaks (PDF
// points from the page's top-left corner, as pdf.js reports page sizes at scale 1).
// Kept free of DOM access so the mapping can be unit-tested.

/** A rectangle in PDF points, origin at the page's top-left corner. */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Result of a forward search (`synctex_view`). */
export interface SynctexTarget extends PdfRect {
  page: number;
  /** The typeset lines of the source line, for the highlight. */
  boxes: PdfRect[];
  /** The source line that was actually found (may be the nearest typeset one). */
  line: number;
}

/** Result of an inverse search (`synctex_edit`): project-relative file and 1-based line. */
export interface SynctexSource {
  file: string;
  line: number;
}

/** On-screen geometry of a rendered page (e.g. from `getBoundingClientRect`). */
export interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Page size in PDF points (pdf.js viewport at scale 1). */
export interface PageSize {
  width: number;
  height: number;
}

/** ⌘-click on macOS, Ctrl-click elsewhere. */
export function isSyncClick(e: { metaKey: boolean; ctrlKey: boolean; altKey?: boolean }, mac: boolean): boolean {
  return (mac ? e.metaKey : e.ctrlKey) && !e.altKey;
}

/**
 * Converts a click at `(clientX, clientY)` over a rendered page into PDF points.
 * Uses the page's rendered size, so it is right at any zoom (and with the
 * rounding the preview applies to page sizes). Returns `null` outside the page.
 */
export function clientToPdfPoint(clientX: number, clientY: number, page: PageBox, size: PageSize): { x: number; y: number } | null {
  if (page.width <= 0 || page.height <= 0) return null;
  const fx = (clientX - page.left) / page.width;
  const fy = (clientY - page.top) / page.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return { x: fx * size.width, y: fy * size.height };
}

/** CSS box of a PDF rectangle inside a page rendered at `scale`, with `pad` px of air. */
export function pdfRectToCss(rect: PdfRect, scale: number, pad = 2): { left: number; top: number; width: number; height: number } {
  return {
    left: rect.x * scale - pad,
    top: rect.y * scale - pad,
    width: Math.max(rect.width * scale, 1) + 2 * pad,
    height: Math.max(rect.height * scale, 1) + 2 * pad,
  };
}

/**
 * Scroll offsets that bring `rect` (on a page whose top-left corner sits at
 * `pageOffset` inside the scroll content) into view: vertically a third down the
 * viewport, horizontally only when the box is off screen (zoomed-in pages).
 */
export function scrollForRect(
  rect: PdfRect,
  scale: number,
  pageOffset: { top: number; left: number },
  viewport: { width: number; height: number; scrollLeft: number }
): { top: number; left: number } {
  const top = Math.max(0, pageOffset.top + rect.y * scale - viewport.height / 3);
  const boxLeft = pageOffset.left + rect.x * scale;
  const boxRight = boxLeft + rect.width * scale;
  let left = viewport.scrollLeft;
  if (boxLeft < left || boxRight > left + viewport.width) {
    left = Math.max(0, boxLeft - 24);
  }
  return { top, left };
}
