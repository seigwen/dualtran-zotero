#!/usr/bin/env node
/**
 * Build the installable XPI from the plugin sources.
 *
 * Only runtime files ship: manifest.json, bootstrap.js, prefs.js and content/. Tests, docs and
 * the update manifest stay in the repository.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dualtran-zotero.xpi");
const files = ["manifest.json", "bootstrap.js", "prefs.js", "content", "locales"];

for (const file of files) {
  if (!existsSync(resolve(root, file))) {
    console.error("build: missing " + file);
    process.exit(1);
  }
}

rmSync(out, { force: true });
execFileSync("zip", ["-X", "-r", "-q", out, ...files], { cwd: root, stdio: "inherit" });

const size = statSync(out).size;
if (!size) {
  console.error("build: empty archive");
  process.exit(1);
}
console.log("built " + out + " (" + size + " bytes)");
