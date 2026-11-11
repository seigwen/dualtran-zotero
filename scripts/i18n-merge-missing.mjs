#!/usr/bin/env node
/**
 * Copy keys that exist in locales/en.json but are missing from a locale file.
 *
 * The preference pane added ~19 `pref.*` keys. This script fills every locale with the English
 * value so the 38-locale key-parity test keeps passing (tests/i18n.test.js compares key sets).
 * `npm run i18n:translate --force` later replaces these English copies with real translations;
 * that is the documented next step in evidence/notes.md.
 *
 * Guarded: every file is re-parsed after writing, existing values are never overwritten, and a
 * locale that ends up with a different key set from English aborts the whole run.
 *
 * Usage: node scripts/i18n-merge-missing.mjs [--dry-run]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = resolve(root, "locales");
const dryRun = process.argv.includes("--dry-run");

function readDictionary(file) {
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  // Every locale file in this repo is written with JSON.stringify(dict, null, 2) + "\n";
  // refuse to normalise a file that is not, so the diff stays additive.
  if (raw !== JSON.stringify(parsed, null, 2) + "\n") {
    throw new Error(file + " is not in canonical 2-space JSON form; refusing to rewrite it");
  }
  return parsed;
}

const english = readDictionary(resolve(localesDir, "en.json"));
const englishKeys = Object.keys(english).sort();
const codes = readdirSync(localesDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -".json".length))
  .sort();

let total = 0;
const summary = [];
for (const code of codes) {
  if (code === "en") continue;
  const file = resolve(localesDir, code + ".json");
  const dictionary = readDictionary(file);
  const missing = englishKeys.filter((key) => !(key in dictionary));
  const extra = Object.keys(dictionary).filter((key) => !(key in english));
  if (extra.length) throw new Error(code + " has keys English does not: " + extra.join(", "));
  if (!missing.length) {
    summary.push(code + ": complete");
    continue;
  }
  for (const key of missing) dictionary[key] = english[key];
  const written = Object.keys(dictionary).sort();
  if (JSON.stringify(written) !== JSON.stringify(englishKeys)) {
    throw new Error(code + " would end up with a different key set than English");
  }
  const text = JSON.stringify(dictionary, null, 2) + "\n";
  const check = JSON.parse(text);
  if (JSON.stringify(Object.keys(check).sort()) !== JSON.stringify(englishKeys)) {
    throw new Error(code + " failed the post-write key check");
  }
  if (!dryRun) writeFileSync(file, text);
  total += missing.length;
  summary.push(code + ": +" + missing.length + " (" + missing.join(", ") + ")");
}

for (const line of summary) console.log(line);
console.log((dryRun ? "would merge " : "merged ") + total + " value(s) across " + (codes.length - 1) + " locale(s)");
