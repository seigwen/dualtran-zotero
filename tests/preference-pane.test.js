import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "bootstrap.js"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const manifestId = manifest.applications.zotero.id;

/** Load bootstrap.js in a sandbox with just enough Zotero to exercise the pane code. */
function loadBootstrap(register) {
  const logs = [];
  const Zotero = {
    PreferencePanes: { register, unregister: () => {} },
    locale: "en-US",
    // bootstrap.js routes its own log() through Zotero.debug, so that is the capture point.
    debug: (message) => logs.push(String(message)),
    getMainWindows: () => [],
  };
  const sandbox = {
    Zotero,
    console: { log() {}, error() {} },
    errorMessage: (error) => String(error?.message || error),
    Services: { scriptloader: { loadSubScript() {} } },
  };
  vm.createContext(sandbox);
  // `const`/function declarations live in the script scope, so expose what the test drives.
  vm.runInContext(source + "\n;globalThis.__paneApi = { installPreferencePane };", sandbox);
  return { api: sandbox.__paneApi, logs };
}

describe("Zotero preference pane registration", () => {
  it("keys the pane with the id Zotero booted the add-on with", async () => {
    // The pane used to be registered under a hardcoded id that differed from the manifest's
    // by a suffix, so Zotero filed it under a plugin that does not exist and Settings never
    // listed DualTran — while the log said "registered".
    const calls = [];
    const { api } = loadBootstrap(async (options) => {
      calls.push(options);
      return {};
    });

    const ok = await api.installPreferencePane("file:///tmp/dualtran/", manifestId);

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].pluginID).toBe(manifestId);
  });

  it("surfaces a rejected registration instead of logging success", async () => {
    const { api, logs } = loadBootstrap(async () => {
      throw new Error("pane boom");
    });

    const ok = await api.installPreferencePane("file:///tmp/dualtran/", manifestId);

    expect(ok).toBe(false);
    expect(logs.join("\n")).toContain("FAILED");
    expect(logs.join("\n")).not.toMatch(/pane registered for/);
  });
});
