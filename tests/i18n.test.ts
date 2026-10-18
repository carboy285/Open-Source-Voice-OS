import { describe, expect, it } from "vitest";
import { catalog, resolveLocale, t } from "../src/i18n/index.js";

describe("i18n", () => {
  it("has the same keys in English and Japanese", () => {
    const en = Object.keys(catalog("en")).sort();
    const ja = Object.keys(catalog("ja")).sort();
    expect(ja).toEqual(en);
  });

  it("uses the same placeholders in both catalogs", () => {
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
    for (const [key, value] of Object.entries(catalog("en"))) {
      expect(placeholders(catalog("ja")[key]!), key).toBe(placeholders(value));
    }
  });

  it("has no empty strings", () => {
    for (const locale of ["en", "ja"] as const) {
      for (const [key, value] of Object.entries(catalog(locale))) expect(value.trim(), `${locale}:${key}`).not.toBe("");
    }
  });

  it("fills placeholders and picks plural forms", () => {
    expect(t("menu.hotkey.dictate", { key: "Right Option" })).toBe("Hold Right Option to dictate");
    expect(t("report.filler_removed", { count: 1 })).toBe("Removed 1 filler");
    expect(t("report.filler_removed", { count: 3 })).toBe("Removed 3 fillers");
    expect(t("report.filler_removed", { count: 3 }, "ja")).toBe("言いよどみを 3 件削除");
    expect(t("missing.key")).toBe("missing.key");
  });

  it("follows the OS locale unless overridden", () => {
    expect(resolveLocale("system", "ja-JP")).toBe("ja");
    expect(resolveLocale("system", "en-GB")).toBe("en");
    expect(resolveLocale("en", "ja-JP")).toBe("en");
  });
});
