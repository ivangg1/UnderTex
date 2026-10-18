import { describe, it, expect, vi, afterEach } from "vitest";
import { hideSplash, splashDelay, SPLASH_FADE_MS, SPLASH_MIN_MS } from "../services/splash";

describe("splash", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the splash for the minimum time, never negative", () => {
    expect(splashDelay(0)).toBe(SPLASH_MIN_MS);
    expect(splashDelay(200)).toBe(SPLASH_MIN_MS - 200);
    expect(splashDelay(5000)).toBe(0);
    expect(splashDelay(-10)).toBe(SPLASH_MIN_MS);
  });

  it("fades the splash out and then removes it from the document", () => {
    vi.useFakeTimers();
    const classes = new Set<string>();
    let removed = false;
    const el = {
      classList: { add: (c: string) => classes.add(c) },
      remove: () => {
        removed = true;
      },
    };
    const doc = { getElementById: (id: string) => (id === "splash" ? el : null) } as unknown as Document;

    hideSplash(doc, 100);
    vi.advanceTimersByTime(SPLASH_MIN_MS - 100 - 1);
    expect(classes.has("splash--hide")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(classes.has("splash--hide")).toBe(true);
    expect(removed).toBe(false);
    vi.advanceTimersByTime(SPLASH_FADE_MS);
    expect(removed).toBe(true);

    // No splash element: nothing to do, no error.
    expect(() => hideSplash({ getElementById: () => null } as unknown as Document, 0)).not.toThrow();
  });
});
