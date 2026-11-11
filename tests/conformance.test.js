/**
 * DualTran conformance payload (SPEC 2.0.0).
 *
 * Two entry points share one contract:
 *   - `buildPayload()` — the runner (`npm run conformance`) imports this module and prints it.
 *   - `runConformance()` — the vitest suite calls it and asserts on the validator result.
 *
 * Everything is derived from the shipped surface: the option lists come from the pure functions
 * in `content/catalog.js` / `content/languages.js`, the control types come from parsing the real
 * `content/preferences.xhtml`, and the i18n matrix is read from `locales/*.json`. Nothing is
 * hand-written, so a regression in the pane shows up here.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { selfTest, validatePayload } from "../scripts/conformance/validate.mjs";
import { scanFiles } from "../scripts/conformance/scan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const require = createRequire(import.meta.url);

const catalog = require(resolve(root, "content/catalog.js"));
const languages = require(resolve(root, "content/languages.js"));

const RAW_CATALOGUE = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/models-dev-sample.json"), "utf8"));
const LANGUAGE_NAMES = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/language-names.json"), "utf8"));

/** The preference pane's real markup, or "" when the pane does not exist yet (RED). */
export function paneMarkup() {
  try {
    return readFileSync(resolve(root, "content/preferences.xhtml"), "utf8");
  } catch {
    return "";
  }
}

/** XHTML markup without its comments: prose in a comment must not look like a control. */
function stripComments(markup) {
  return String(markup).replace(/<!--[\s\S]*?-->/g, "");
}

const CONTROL_RE = /<(?:[a-z][\w-]*:)?(select|input|textarea)\b([^>]*)>/gi;

/** id -> {tag, type} for every control the pane markup declares. */
export function parseControls(markup) {
  const controls = {};
  for (const match of stripComments(markup).matchAll(CONTROL_RE)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const id = (attrs.match(/\bid=["']([^"']+)["']/i) || [])[1];
    if (!id) continue;
    const type = tag === "input" ? ((attrs.match(/\btype=["']([^"']+)["']/i) || [])[1] || "text").toLowerCase() : tag;
    controls[id] = { tag, type };
  }
  return controls;
}

/** Map the real control for an id onto the validator's vocabulary. */
function controlFor(controls, id, picker) {
  const control = controls[id];
  if (!control) return "missing";
  if (picker) return control.tag === "select" ? "select" : control.tag;
  if (control.type === "password") return "password";
  if (control.tag === "input") return "text";
  return control.tag;
}

/** Option lists rendered by the pane come from exactly these functions. */
function optionList(entries) {
  return entries.map((entry) => ({
    value: entry.value,
    label: entry.text || entry.label || entry.value,
    disabled: entry.disabled === true,
  }));
}

const CONFIG = JSON.parse(readFileSync(resolve(root, "conformance.json"), "utf8"));

export function buildPayload() {
  const controls = parseControls(paneMarkup());
  const projected = catalog.projectCatalog(RAW_CATALOGUE);
  const providers = catalog.buildProviderList(projected);
  const providerOptions = providers.map((entry) => ({
    value: entry.id,
    label: entry.name,
    source: entry.source,
  }));

  const byProvider = {};
  for (const entry of providers) byProvider[entry.id] = optionList(entry.models);

  const target = catalog.languageOptions(LANGUAGE_NAMES, "zh-CN");
  const current = "zh-CN";
  const currentProvider = "openai";
  const providerEntry = providers.find((entry) => entry.id === currentProvider);
  const providerApi = catalog.apiForProvider(projected.providers, currentProvider);
  const before = "";
  const after = catalog.resolveEndpointOnProviderChange({
    current: before,
    previousProvider: null,
    nextProvider: currentProvider,
    providers: projected.providers,
  });
  const userEdited = "https://proxy.example/v1";
  const afterSwitch = catalog.resolveEndpointOnProviderChange({
    current: userEdited,
    previousProvider: currentProvider,
    nextProvider: "deepseek",
    providers: projected.providers,
  });

  const modelEntry = providerEntry && providerEntry.models.find((model) => !/^__custom/.test(model.value));
  const selectedModel = modelEntry ? modelEntry.value : "";
  const selectedEntry =
    (selectedModel && projected.modelsById[currentProvider] && projected.modelsById[currentProvider][selectedModel]) ||
    {};
  const levels = Array.isArray(selectedEntry.levels) ? selectedEntry.levels : [];
  const resolveCases = (input) => [
    { setting: catalog.LOWEST, levels: input, value: catalog.resolveReasoningDepth({ setting: catalog.LOWEST, levels: input }) },
  ];

  return {
    spec: "2.0.0",
    host: "dualtran-zotero",
    language: {
      control: controlFor(controls, "target", true),
      current,
      options: optionList(target),
    },
    provider: {
      control: controlFor(controls, "provider", true),
      current: currentProvider,
      options: providerOptions,
    },
    model: {
      control: controlFor(controls, "model", true),
      byProvider,
      selectedProvider: currentProvider,
      selectedModel,
    },
    endpoint: {
      control: controlFor(controls, "endpoint", false),
      autofill: {
        provider: currentProvider,
        providerApi,
        before,
        after,
        userEdited,
        afterSwitch,
      },
    },
    reasoning: {
      control: controlFor(controls, "reasoning", true),
      default: catalog.LOWEST,
      selectedLevels: levels,
      resolved: {
        none: resolveCases(["none", "minimal", "low"]),
        minimal: resolveCases(["minimal", "low"]),
        low: resolveCases(["low", "medium"]),
        "none-declared": resolveCases([]),
      },
    },
    i18n: i18nSection(),
  };
}

/** Locale files + the keys the pane markup references through data-i18n. */
function i18nSection() {
  const localesDir = resolve(root, "locales");
  const codes = readdirSync(localesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  const files = {};
  for (const code of codes) files[code] = JSON.parse(readFileSync(resolve(localesDir, code + ".json"), "utf8"));
  const english = files.en || {};
  const keys = Object.keys(english).sort();
  const used = [...new Set([...stripComments(paneMarkup()).matchAll(/data-i18n=["']([^"']+)["']/g)].map((m) => m[1]))].sort();
  return { locales: codes, sourceLocale: "en", keys, files, used };
}

export function runConformance() {
  const controls = selfTest();
  const payload = buildPayload();
  payload.static = { hits: CONFIG.static ? scanFiles(root, CONFIG.static) : [] };
  payload.conformance = CONFIG;
  const summary = validatePayload(payload, CONFIG);
  return { controls, payload, summary };
}

export default buildPayload;

/* ------------------------------------------------------------------ vitest */

export function conformanceSuite() {
  describe("host conformance (SPEC 2.0.0)", () => {
  it("catches every negative control before trusting the gate", () => {
    expect(selfTest()).toBeGreaterThan(0);
  });

  it("passes R1-R5 on the shipped pane", () => {
    const result = runConformance();
    expect(result.payload.conformance.host).toBe("dualtran-zotero");
    expect(result.summary.languages).toBeGreaterThanOrEqual(38);
    expect(result.summary.providers).toBeGreaterThanOrEqual(5);
    expect(result.summary.localeCount).toBe(38);
  });

  it("fails R1 when the target is a text field again", () => {
    const payload = buildPayload();
    payload.language.control = "text";
    expect(() => validatePayload(payload, CONFIG)).toThrow(/^\[R1\]/);
  });

  it("fails R2 when a divider row sneaks into the provider list", () => {
    const payload = buildPayload();
    payload.provider.options.splice(2, 0, { value: "__more__", label: "──── More ────", disabled: true });
    expect(() => validatePayload(payload, CONFIG)).toThrow(/^\[R2\]/);
  });

  it("fails R3 when the provider switch stops writing the endpoint", () => {
    const payload = buildPayload();
    payload.endpoint.autofill.after = "";
    expect(() => validatePayload(payload, CONFIG)).toThrow(/^\[R3\]/);
  });

  it("fails R4 when the sentinel is replaced by a concrete default", () => {
    const payload = buildPayload();
    payload.reasoning.default = "low";
    expect(() => validatePayload(payload, CONFIG)).toThrow(/^\[R4\]/);
  });
  });
}

function insideVitest() {
  if (typeof expect === "undefined" || typeof expect.getState !== "function") return false;
  try {
    // `testPath` throws when vitest has no worker state, which is exactly the plain-node case.
    return Boolean(expect.getState().testPath);
  } catch {
    return false;
  }
}

// `scripts/conformance/run.mjs` imports this module with plain node only to get `buildPayload()`,
// so the suite must not register there.
if (insideVitest()) conformanceSuite();
