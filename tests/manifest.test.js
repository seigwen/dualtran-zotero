import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const zotero = manifest.applications.zotero;

/**
 * Compare a version against an "X.Y.*" style range the way Zotero does for compatibility.
 * A range with fewer parts than the version is open at those levels ("10.*" covers 10.0.6).
 */
function inRange(version, min, max) {
  const parts = version.split(".").map(Number);
  const pad = (range) => {
    const values = range.split(".");
    while (values.length < parts.length) values.push("*");
    return values.map((value) => (value === "*" ? "*" : Number(value)));
  };
  const compare = (range, direction) => {
    const values = pad(range);
    for (let i = 0; i < parts.length; i += 1) {
      const bound = values[i];
      if (bound === "*") continue;
      if (parts[i] !== bound) return direction > 0 ? parts[i] > bound : parts[i] < bound;
    }
    return true;
  };
  return compare(min, 1) && compare(max, -1);
}

describe("Zotero manifest", () => {
  it("is an overlay manifest", () => {
    expect(manifest.manifest_version).toBe(2);
  });

  it("declares the Zotero add-on id and a minimum version", () => {
    expect(zotero.id).toBe("dualtran@seigwen.dev");
    expect(zotero.strict_min_version).toBeTruthy();
  });

  it("declares an explicit maximum, because Zotero refuses add-ons without one", () => {
    expect(zotero.strict_max_version).toMatch(/^\d+(\.\d+)*\.\*$/);
  });

  it("declares an update manifest, because Zotero 10 refuses add-ons without one", () => {
    expect(zotero.update_url).toMatch(/^https:\/\//);
  });

  it("ships an update manifest that can upgrade this exact build", () => {
    const updates = JSON.parse(readFileSync(resolve(root, "updates.json"), "utf8"));
    const entry = updates.addons[zotero.id];
    expect(entry).toBeTruthy();
    const latest = entry.updates[entry.updates.length - 1];
    expect(inRange("10.0.6", latest.applications.zotero.strict_min_version, latest.applications.zotero.strict_max_version)).toBe(true);
    expect(latest.update_link).toMatch(/^https:\/\/.+\.xpi$/);
    expect(latest.version).toBe(manifest.version);
  });

  it("covers the Zotero versions we claim to support", () => {
    for (const version of ["7.0", "7.0.6", "8.0", "9.0.0", "10.0.6"]) {
      expect(inRange(version, zotero.strict_min_version, zotero.strict_max_version)).toBe(true);
    }
  });

  it("refuses a version beyond the declared maximum", () => {
    expect(inRange("11.0.0", zotero.strict_min_version, zotero.strict_max_version)).toBe(false);
  });
});
