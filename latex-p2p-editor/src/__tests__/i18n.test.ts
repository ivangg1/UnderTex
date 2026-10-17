import { describe, it, expect } from "vitest";
import { en } from "../i18n/en";
import { es } from "../i18n/es";
import { detectLocale, interpolate, translate } from "../i18n";

describe("i18n dictionaries", () => {
  it("es covers exactly the same keys as en (no missing or stray translations)", () => {
    const enKeys = Object.keys(en).sort();
    const esKeys = Object.keys(es).sort();
    expect(esKeys).toEqual(enKeys);
  });

  it("both locales use the same placeholders for every message", () => {
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(es[key]), `placeholders differ for ${key}`).toEqual(placeholders(en[key]));
    }
  });

  it("no message is empty", () => {
    for (const dict of [en, es]) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `empty message: ${key}`).not.toBe("");
      }
    }
  });
});

describe("translate / interpolate / detectLocale", () => {
  it("interpolates placeholders and leaves unknown ones untouched", () => {
    expect(interpolate("{count} pages of {name}", { count: 3, name: "x" })).toBe("3 pages of x");
    expect(interpolate("Room {id}", {})).toBe("Room {id}");
    expect(interpolate("plain", undefined)).toBe("plain");
  });

  it("translates per locale with parameters", () => {
    expect(translate("en", "preview.pages", { count: 2 })).toBe("2 pages");
    expect(translate("es", "preview.pages", { count: 2 })).toBe("2 páginas");
    expect(translate("es", "status.room", { id: "abcd1234" })).toBe("Sala abcd1234");
  });

  it("prefers the stored locale, then the browser language, defaulting to English", () => {
    expect(detectLocale("es-AR", null)).toBe("es");
    expect(detectLocale("ES", null)).toBe("es");
    expect(detectLocale("en-US", null)).toBe("en");
    expect(detectLocale("fr-FR", null)).toBe("en");
    expect(detectLocale(undefined, null)).toBe("en");
    expect(detectLocale("es-ES", "en")).toBe("en");
    expect(detectLocale("en-US", "es")).toBe("es");
    expect(detectLocale("en-US", "garbage")).toBe("en");
  });
});
