import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import i18n from "../content/i18n.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = resolve(root, "locales");

/** Same 38-language set as the browser extension's src/_locales. */
const LOCALES = [
  "af", "ar", "ca", "cs", "da", "de", "el", "en", "es", "fa", "fi", "fr", "he", "hi", "hr",
  "hu", "is", "it", "ja", "ko", "lv", "nl", "no", "pl", "pt_BR", "pt_PT", "ro", "ru", "sl",
  "sr", "sv", "th", "tr", "ug", "uk", "vi", "zh_CN", "zh_TW",
];

/** Languages whose script legitimately contains CJK unified ideographs. */
const CJK_OK = new Set(["zh_CN", "zh_TW", "ja"]);

function readLocale(code) {
  return JSON.parse(readFileSync(resolve(localesDir, code + ".json"), "utf8"));
}

describe("locale files", () => {
  it("ships exactly the 38 languages of the DualTran matrix", () => {
    const files = readdirSync(localesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
    expect(files).toEqual([...LOCALES].sort());
  });

  it("has the same non-empty key set as English", () => {
    const english = readLocale("en");
    for (const code of LOCALES) {
      const dict = readLocale(code);
      expect(Object.keys(dict).sort(), code).toEqual(Object.keys(english).sort());
      for (const key of Object.keys(english)) {
        expect(typeof dict[key], code + " " + key).toBe("string");
        expect(dict[key].trim().length, code + " " + key).toBeGreaterThan(0);
      }
    }
  });

  it("keeps placeholders and does not leave English-only copies of interpolated strings", () => {
    const english = readLocale("en");
    const withPlaceholders = Object.keys(english).filter((key) => /\{\w+\}/.test(english[key]));
    for (const code of LOCALES) {
      const dict = readLocale(code);
      for (const key of withPlaceholders) {
        const expected = [...english[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        const actual = [...dict[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        expect(actual, code + " " + key).toEqual(expected);
      }
    }
  });

  it("does not leak Chinese into languages that do not use it", () => {
    for (const code of LOCALES) {
      if (CJK_OK.has(code)) continue;
      const dict = readLocale(code);
      for (const [key, value] of Object.entries(dict)) {
        expect(/[\u4e00-\u9fff]/.test(value), code + " " + key).toBe(false);
      }
    }
  });
});

describe("i18n runtime", () => {
  it("interpolates named parameters", () => {
    i18n.set({ greet: "Hello {name}, {count} left" });
    expect(i18n.t("greet", { name: "Ada", count: 3 })).toBe("Hello Ada, 3 left");
  });

  it("returns the key when the string is missing", () => {
    i18n.set({});
    expect(i18n.t("missing.key")).toBe("missing.key");
  });

  it("leaves unknown placeholders untouched", () => {
    i18n.set({ greet: "Hello {name}" });
    expect(i18n.t("greet", {})).toBe("Hello {name}");
  });
});
