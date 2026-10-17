// Minimal, dependency-free i18n: typed dictionaries, a React context and a
// `t()` hook with `{placeholder}` interpolation. The locale is detected from the
// browser language and can be changed from the toolbar (persisted in localStorage).

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { en } from "./en";
import { es } from "./es";

export type Locale = "en" | "es";
export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

export const LOCALE_STORAGE_KEY = "latex_locale";
export const LOCALES: { code: Locale; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
];

export const dictionaries: Record<Locale, Messages> = { en, es: es as Messages };

export function detectLocale(navigatorLanguage: string | undefined, stored: string | null): Locale {
  if (stored === "en" || stored === "es") return stored;
  return (navigatorLanguage ?? "").toLowerCase().startsWith("es") ? "es" : "en";
}

/** Replaces `{name}` placeholders. Missing placeholders are left untouched. */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match
  );
}

export function translate(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  const template = dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
  return interpolate(template, params);
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readStoredLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(
    () => initialLocale ?? detectLocale(globalThis.navigator?.language, readStoredLocale())
  );
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => translate(locale, key, params),
    }),
    [locale, setLocale]
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used inside <I18nProvider>");
  }
  return ctx;
}
