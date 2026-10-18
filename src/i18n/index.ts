import en from "./en.json" with { type: "json" };
import ja from "./ja.json" with { type: "json" };

export type Locale = "en" | "ja";
export const LOCALES: Locale[] = ["en", "ja"];

type Catalog = Record<string, string>;

const catalogs: Record<Locale, Catalog> = { en, ja };

export function catalog(locale: Locale): Catalog {
  return catalogs[locale];
}

/** Picks a supported locale from a setting ("system", "ja", "ja-JP"…) and the OS locale. */
export function resolveLocale(
  setting: string | undefined,
  system = Intl.DateTimeFormat().resolvedOptions().locale,
): Locale {
  const value = !setting || setting === "system" ? system : setting;
  return value.toLowerCase().startsWith("ja") ? "ja" : "en";
}

/**
 * Looks up a UI string. `{name}` placeholders are filled from params.
 * With a numeric `count`, `<key>.one` or `<key>.other` is used when present. Falls back to English, then the key.
 */
export function t(key: string, params: Record<string, string | number> = {}, locale: Locale = "en"): string {
  const count = params.count;
  const keys = typeof count === "number" ? [`${key}.${count === 1 ? "one" : "other"}`, key] : [key];
  let text: string | undefined;
  for (const k of keys) {
    text = catalog(locale)[k] ?? catalog("en")[k];
    if (text !== undefined) break;
  }
  if (text === undefined) return key;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match,
  );
}
