/**
 * The pane has to boot itself.
 *
 * Zotero loads a pane's scripts into a sandbox *before* it parses and inserts the
 * fragment, then dispatches a bubbling `load` event on the fragment's root element.
 * Nothing calls an exported `start()`: a pane whose markup carries no `onload` handler
 * registers, appears in the sidebar, and never renders its content (the settings window
 * keeps showing the previous pane, because `_showPane` is never reached).
 *
 * Two mechanical requirements follow, and both were violated:
 *   1. No `<?xml … ?>` declaration — Zotero parses the fragment with parseXULToFragment,
 *      which chokes on a declaration that is not at the start of the document.
 *   2. The `onload` handler must resolve from the preferences *window* scope, so the
 *      script has to publish itself on `window`, not on the sandbox global.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const markup = readFileSync(resolve(root, "content/preferences.xhtml"), "utf8");
const script = readFileSync(resolve(root, "content/preferences.js"), "utf8");

describe("preference pane boot contract", () => {
  it("does not start with an XML declaration (parseXULToFragment rejects it)", () => {
    expect(markup.trimStart().startsWith("<?xml")).toBe(false);
  });

  it("boots from the root element's onload, the only hook Zotero fires", () => {
    const rootTag = markup.match(/<vbox[\s\S]*?>/);
    expect(rootTag, "pane root element").toBeTruthy();
    expect(rootTag[0]).toMatch(/onload="[^"]*DualTranPreferences\.start\(/);
  });

  it("publishes the API on the preferences window so the inline handler can see it", () => {
    expect(script).toMatch(/window\.DualTranPreferences\s*=/);
  });
});
