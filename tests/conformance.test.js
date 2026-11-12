/**
 * DualTran conformance payload (SPEC 2.1.0).
 *
 * Two entry points share one contract:
 *   - `buildPayload()` — the runner (`npm run conformance`) imports this module and prints it.
 *   - `conformanceSuite()` — the vitest suite calls it and asserts on the validator result.
 *
 * Everything is DERIVED, never hand-written:
 *   - the control types come from parsing the real `content/preferences.xhtml`;
 *   - both states (unconfigured / configured) are read from a real `mount()` of
 *     `content/preferences.js` against that markup, so a regression in the pane shows up here;
 *   - the endpoint autofill cases are MEASURED on the mounted pane (pick, type, switch);
 *   - option lists come from `content/catalog.js` / `content/languages.js`, the i18n matrix from
 *     `locales/*.json`.
 *
 * `payload.provider|model|endpoint|reasoning` is the unconfigured state (SPEC 2.1's primary
 * contract); `payload.states.configured` is the same pane after a provider has been chosen.
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
const pane = require(resolve(root, "content/preferences.js"));

const RAW_CATALOGUE = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/models-dev-sample.json"), "utf8"));
const LANGUAGE_NAMES = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/language-names.json"), "utf8"));
const ENGLISH = JSON.parse(readFileSync(resolve(root, "locales/en.json"), "utf8"));
const CONFIG = JSON.parse(readFileSync(resolve(root, "conformance.json"), "utf8"));

const USER_ENDPOINT = "https://proxy.example/v1";
const CONFIGURED_PROVIDER = "anthropic";
const PREFIX = "extensions.zotero.dualtran.";

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

/* ------------------------------------------------- reading the mounted pane */

/**
 * A minimal DOM the pane script can mount into. It only implements what the pane uses:
 * getElementById, createElementNS, querySelectorAll (data-i18n), append/remove, attributes, and
 * a `value` that — like a real <select> — moves the selection with it.
 */
function stubElement(doc, tagName) {
  const element = {
    ownerDocument: doc,
    tagName: String(tagName).toUpperCase(),
    children: [],
    attributes: {},
    listeners: {},
    _value: "",
    selected: false,
    textContent: "",
    disabled: false,
    get firstChild() {
      return element.children[0] || null;
    },
    get options() {
      return element.children;
    },
    get value() {
      return element._value === undefined ? "" : element._value;
    },
    set value(next) {
      element._value = String(next);
      for (const child of element.children) child.selected = child.getAttribute("value") === String(next);
    },
    appendChild(child) {
      element.children.push(child);
      if (element.tagName === "SELECT" && element.children.length === 1) element.value = child.value;
      return child;
    },
    removeChild(child) {
      element.children = element.children.filter((entry) => entry !== child);
      return child;
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(element.attributes, name) ? element.attributes[name] : null;
    },
    removeAttribute(name) {
      delete element.attributes[name];
    },
    addEventListener(type, handler) {
      (element.listeners[type] = element.listeners[type] || []).push(handler);
    },
    removeEventListener(type, handler) {
      element.listeners[type] = (element.listeners[type] || []).filter((entry) => entry !== handler);
    },
    fire(type) {
      for (const handler of element.listeners[type] || []) handler({ target: element, type });
    },
  };
  return element;
}

function paneDocument(markup) {
  const nodes = [];
  const doc = {
    createElementNS: (_ns, tag) => stubElement(doc, tag),
    createElement: (tag) => stubElement(doc, tag),
    getElementById: (id) => nodes.find((node) => node.getAttribute("id") === id) || null,
    querySelectorAll: (selector) => {
      const attribute = /\[([a-z-]+)\]/.exec(selector);
      return attribute ? nodes.filter((node) => node.getAttribute(attribute[1]) !== null) : [];
    },
  };
  for (const match of stripComments(markup).matchAll(/<(?:[a-z][\w-]*:)?(select|input|button|span|label|p|h1)\b([^>]*)>/gi)) {
    const node = stubElement(doc, match[1]);
    for (const pair of match[2].matchAll(/([a-z][a-z0-9-]*)=["']([^"']*)["']/gi)) node.setAttribute(pair[1], pair[2]);
    nodes.push(node);
  }
  return doc;
}

/** A Zotero-shaped `io` with a warm catalogue cache, so mounting never touches the network. */
function paneIo(prefs) {
  const values = new Map(
    Object.entries({
      [PREFIX + "catalog"]: { ts: 1, data: RAW_CATALOGUE },
      [PREFIX + "migrated"]: true,
      ...prefs,
    })
  );
  return {
    getPref: (key) => (values.has(key) ? values.get(key) : undefined),
    setPref: (key, value) => values.set(key, value),
    hasUserValue: (key) => values.has(key),
    request: async () => {
      throw new Error("the conformance payload must render from the cache, never the network");
    },
  };
}

const t = (key, params) => {
  const value = ENGLISH[key] || key;
  return params
    ? String(value).replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
    : value;
};

/** Mount the real pane with `prefs`; the returned view drives it like a user would. */
async function mountPane(prefs) {
  const doc = paneDocument(paneMarkup());
  await pane.mount(doc, paneIo(prefs), { t });
  return {
    doc,
    get provider() {
      return doc.getElementById("provider");
    },
    get model() {
      return doc.getElementById("model");
    },
    get endpoint() {
      return doc.getElementById("endpoint");
    },
    get reasoning() {
      return doc.getElementById("reasoning");
    },
    choose(providerId) {
      const select = doc.getElementById("provider");
      select.value = providerId;
      select.fire("change");
    },
    typeEndpoint(value) {
      const input = doc.getElementById("endpoint");
      input.value = value;
      input.fire("change");
    },
  };
}

/* ------------------------------------------------------------- the sections */

const PROJECTED = catalog.projectCatalog(RAW_CATALOGUE);
const PROVIDERS = catalog.buildProviderList(PROJECTED);
const SOURCE_OF = new Map(PROVIDERS.map((entry) => [entry.id, entry.source]));

function optionList(entries) {
  return entries.map((entry) => ({
    value: entry.value,
    label: entry.text || entry.label || entry.value,
    disabled: entry.disabled === true,
  }));
}

/** Provider picker: the selected row, the unconfigured placeholder, and the real options. */
function providerSection(view) {
  const select = view.provider;
  if (!select) return { control: "missing", current: "", placeholder: null, fallback: "", options: [] };
  const rows = select.children.map((option) => ({
    value: option.getAttribute("value"),
    label: option.textContent,
    disabled: option.getAttribute("disabled") === "true",
    selected: option.getAttribute("selected") === "true",
  }));
  const current = String(select.value || "");
  const placeholderRow = rows.find((row) => row.value === "");
  return {
    control: select.tagName === "SELECT" ? "select" : select.tagName.toLowerCase(),
    current,
    // SPEC 2.1: the unconfigured row lives on the select, never inside options. It is defined as
    // disabled, so it is reported disabled whether or not it is currently rendered.
    placeholder: {
      value: "",
      label: placeholderRow ? placeholderRow.label : t("providerPlaceholder"),
      disabled: placeholderRow ? placeholderRow.disabled : true,
      selected: current === "",
    },
    // No silent fallback: what the pane shows is what a request would use.
    fallback: "",
    options: rows
      .filter((row) => row.value !== "")
      .map((row) => ({
        value: row.value,
        label: row.label,
        source: SOURCE_OF.get(row.value) || "models.dev",
        // Normalised so "disabled entry in the list" (rule 6) is explicit, never `undefined`.
        disabled: row.disabled === true,
      })),
  };
}

/** Model picker: disabled + empty while no provider is chosen; per-provider lists always shipped. */
function modelSection(view) {
  const select = view.model;
  const currentProvider = view.provider ? String(view.provider.value || "") : "";
  const currentModel = select ? String(select.value || "") : "";
  // A selected model that is not one of the rows would mean the pane invented one.
  const rows = select ? select.children.map((option) => ({ value: option.getAttribute("value"), label: option.textContent })) : [];
  const known = rows.some((row) => row.value === currentModel);
  return {
    control: select && select.tagName === "SELECT" ? "select" : "missing",
    disabled: select ? select.disabled === true : true,
    selectedProvider: currentProvider,
    selectedModel: known ? currentModel : "",
    options: optionList(rows),
    byProvider: Object.fromEntries(PROVIDERS.map((entry) => [entry.id, optionList(entry.models)])),
  };
}

function endpointSection(view, controls) {
  const endpoint = view.endpoint;
  return {
    control: controlFor(controls, "endpoint", false),
    current: endpoint ? String(endpoint.value || "") : "",
    placeholder: endpoint ? String(endpoint.getAttribute("placeholder") || "") : "",
  };
}

function reasoningSection(view) {
  const select = view.reasoning;
  const resolveCases = (levels) => [
    { setting: catalog.LOWEST, levels, value: catalog.resolveReasoningDepth({ setting: catalog.LOWEST, levels }) },
  ];
  return {
    control: select && select.tagName === "SELECT" ? "select" : "missing",
    disabled: select ? select.disabled === true : true,
    default: catalog.LOWEST,
    selected: select ? String(select.value || "") : "",
    resolved: {
      none: resolveCases(["none", "minimal", "low"]),
      minimal: resolveCases(["minimal", "low"]),
      low: resolveCases(["low", "medium"]),
      "none-declared": resolveCases([]),
    },
  };
}

/**
 * R3 autofill, measured on a live pane: an empty endpoint takes the first provider's API base, a
 * hand-edited endpoint is not overwritten by a later switch, and `providerApi` is the catalogue's
 * base for that provider.
 */
async function measureAutofill(targetProvider) {
  const view = await mountPane({});
  view.typeEndpoint("");
  const before = String(view.endpoint ? view.endpoint.value : "");
  view.choose(targetProvider);
  const after = String(view.endpoint.value);
  view.typeEndpoint(USER_ENDPOINT);
  const other = PROVIDERS.find((entry) => entry.id !== targetProvider && entry.source !== "custom");
  view.choose(other.id);
  const afterSwitch = String(view.endpoint.value);
  return {
    provider: targetProvider,
    providerApi: catalog.apiForProvider(PROJECTED.providers, targetProvider),
    before,
    after,
    userEdited: USER_ENDPOINT,
    afterSwitch,
  };
}

/* ------------------------------------------------------------- the payload */

export async function buildPayload() {
  const controls = parseControls(paneMarkup());

  // Unconfigured: a fresh profile. Read BEFORE any interaction so nothing is written into it.
  const fresh = await mountPane({});
  const unconfigured = {
    provider: providerSection(fresh),
    model: modelSection(fresh),
    endpoint: { ...endpointSection(fresh, controls), autofill: await measureAutofill("anthropic") },
    reasoning: reasoningSection(fresh),
  };

  // Configured: the provider the user picked is stored, the pane must leave it alone.
  const stored = await mountPane({ [PREFIX + "aiProvider"]: CONFIGURED_PROVIDER });
  const live = await mountPane({ [PREFIX + "aiProvider"]: CONFIGURED_PROVIDER });
  live.typeEndpoint("");
  live.choose(CONFIGURED_PROVIDER);
  const after = String(live.endpoint.value);
  live.typeEndpoint(USER_ENDPOINT);
  const other = PROVIDERS.find((entry) => entry.id !== CONFIGURED_PROVIDER && entry.source !== "custom");
  live.choose(other.id);
  const afterSwitch = String(live.endpoint.value);
  const configured = {
    provider: providerSection(stored),
    model: modelSection(stored),
    endpoint: {
      ...endpointSection(stored, controls),
      autofill: {
        provider: CONFIGURED_PROVIDER,
        providerApi: catalog.apiForProvider(PROJECTED.providers, CONFIGURED_PROVIDER),
        before: "",
        after,
        userEdited: USER_ENDPOINT,
        afterSwitch,
      },
    },
    reasoning: reasoningSection(stored),
  };

  return {
    spec: "2.1.0",
    host: "dualtran-zotero",
    language: {
      control: controlFor(controls, "target", true),
      current: "zh-CN",
      options: optionList(catalog.languageOptions(LANGUAGE_NAMES, "zh-CN")),
    },
    provider: unconfigured.provider,
    model: unconfigured.model,
    endpoint: unconfigured.endpoint,
    reasoning: unconfigured.reasoning,
    states: { unconfigured, configured },
    i18n: i18nSection(),
  };
}

/** Locale files + every string key the pane surface renders. */
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
  const used = [
    ...new Set([
      ...[...stripComments(paneMarkup()).matchAll(/data-i18n(?:-aria-label)?=["']([^"']+)["']/g)].map((m) => m[1]),
      // Keys content/preferences.js renders itself: option labels and the empty state.
      "pref.customProvider",
      "pref.customModel",
      "pref.reasoningLowest",
      "pref.catalogStatus",
      "pref.refresh",
      "pref.title",
      "providerPlaceholder",
      "providerRequiredForModel",
    ]),
  ].sort();
  return { locales: codes, sourceLocale: "en", keys, files, used };
}

export async function runConformance() {
  const controls = selfTest();
  const payload = await buildPayload();
  payload.static = { hits: CONFIG.static ? scanFiles(root, CONFIG.static) : [] };
  payload.conformance = CONFIG;
  const summary = validatePayload(payload, CONFIG);
  return { controls, payload, summary };
}

export default buildPayload;

/* ------------------------------------------------------------------ vitest */

export function conformanceSuite() {
  describe("host conformance (SPEC 2.1.0)", () => {
    it("catches every negative control before trusting the gate", () => {
      expect(selfTest()).toBeGreaterThan(0);
    });

    it("passes R1-R5 on the shipped pane", async () => {
      const result = await runConformance();
      expect(result.payload.conformance.host).toBe("dualtran-zotero");
      expect(result.summary.languages).toBeGreaterThanOrEqual(38);
      expect(result.summary.providers).toBeGreaterThanOrEqual(5);
      expect(result.summary.localeCount).toBe(38);
    });

    it("reports the unconfigured provider with a disabled, selected placeholder", async () => {
      const { payload } = await runConformance();
      const { provider, model, endpoint, reasoning } = payload;
      expect(provider.current).toBe("");
      expect(provider.fallback).toBe("");
      expect(provider.placeholder).toEqual({
        value: "",
        label: ENGLISH.providerPlaceholder,
        disabled: true,
        selected: true,
      });
      expect(provider.options.some((option) => option.value === "")).toBe(false);
      expect(provider.options.every((option) => option.disabled === false)).toBe(true);
      expect(model.disabled).toBe(true);
      expect(model.selectedProvider).toBe("");
      expect(model.options).toEqual([]);
      expect(endpoint.current).toBe("");
      expect(endpoint.placeholder).toBe("https://");
      expect(reasoning.disabled).toBe(true);
      expect(reasoning.default).toBe("lowest");
    });

    it("reports the configured state after a provider pick", async () => {
      const { payload } = await runConformance();
      const { provider, model, endpoint, reasoning } = payload.states.configured;
      expect(provider.current).toBe("anthropic");
      expect(provider.placeholder.selected).toBe(false);
      expect(model.disabled).toBe(false);
      expect(model.selectedProvider).toBe("anthropic");
      expect(model.selectedModel).not.toBe("");
      expect(endpoint.current).toBe(catalog.apiForProvider(PROJECTED.providers, "anthropic"));
      expect(reasoning.disabled).toBe(false);
      // A hand-edited endpoint survives a later provider switch (measured on the pane).
      expect(endpoint.autofill.afterSwitch).toBe(USER_ENDPOINT);
      expect(endpoint.autofill.after).toBe(catalog.apiForProvider(PROJECTED.providers, "anthropic"));
    });

    it("keeps the empty state free of the OpenAI endpoint and model", async () => {
      const { payload } = await runConformance();
      expect(payload.provider.current).not.toBe("openai");
      expect(payload.model.selectedProvider).not.toBe("openai");
      expect(payload.model.options).toEqual([]);
      expect(payload.endpoint.current).toBe("");
      expect(payload.endpoint.current).not.toMatch(/openai/i);
    });

    it("fails R1 when the target is a text field again", async () => {
      const payload = await buildPayload();
      payload.language.control = "text";
      expect(() => validatePayload(payload, CONFIG)).toThrow(/^\[R1\]/);
    });

    it("fails R2 when a divider row sneaks into the provider list", async () => {
      const payload = await buildPayload();
      payload.provider.options.splice(2, 0, { value: "__more__", label: "──── More ────", disabled: true });
      expect(() => validatePayload(payload, CONFIG)).toThrow(/^\[R2\]/);
    });

    it("fails R2 when the unconfigured provider falls back to openai", async () => {
      const payload = await buildPayload();
      payload.provider.fallback = "openai";
      expect(() => validatePayload(payload, CONFIG)).toThrow(/^\[R2\]/);
    });

    it("fails R2 when the placeholder is enabled", async () => {
      const payload = await buildPayload();
      payload.provider.placeholder.disabled = false;
      expect(() => validatePayload(payload, CONFIG)).toThrow(/^\[R2\]/);
    });

    it("fails R3 when the unconfigured endpoint keeps the OpenAI default", async () => {
      const payload = await buildPayload();
      payload.endpoint.current = "https://api.openai.com/v1";
      expect(() => validatePayload(payload, CONFIG)).toThrow(/^\[R3\]/);
    });

    it("fails R3 when the provider switch stops writing the endpoint", async () => {
      const payload = await buildPayload();
      payload.endpoint.autofill.after = "";
      expect(() => validatePayload(payload, CONFIG)).toThrow(/^\[R3\]/);
    });

    it("fails R3 when a provider switch clobbers the user's override", async () => {
      const payload = await buildPayload();
      payload.endpoint.autofill.afterSwitch = payload.endpoint.autofill.providerApi;
      expect(() => validatePayload(payload, CONFIG)).toThrow(/^\[R3\]/);
    });

    it("fails R4 when the sentinel is replaced by a concrete default", async () => {
      const payload = await buildPayload();
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
