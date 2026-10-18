// Removes the startup splash (markup and styles live in index.html) once the
// app has rendered, keeping it on screen for a minimum time so it never just
// flickers on fast machines.

export const SPLASH_MIN_MS = 700;
export const SPLASH_FADE_MS = 300;

/** Milliseconds to wait before fading out, given the time already elapsed. */
export function splashDelay(elapsedMs: number, minMs: number = SPLASH_MIN_MS): number {
  return Math.max(0, minMs - Math.max(0, elapsedMs));
}

export function hideSplash(doc: Document = document, now: number = performance.now()): void {
  const el = doc.getElementById("splash");
  if (!el) return;
  setTimeout(() => {
    el.classList.add("splash--hide");
    setTimeout(() => el.remove(), SPLASH_FADE_MS);
  }, splashDelay(now));
}
