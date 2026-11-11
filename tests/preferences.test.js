/**
 * Behaviour of the preference pane against a tiny DOM stub.
 *
 * The pane talks to Zotero only through the injected `io` object, so the whole wiring — prefs
 * migration, catalogue cache, provider -> model -> reasoning cascade, the dirty-endpoint rule —
 * runs unchanged here.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const require = createRequire(import.meta.url);

const catalog = require(resolve(root, "content/catalog.js"));
const languages = require(resolve(root, "content/languages.js"));
const pane = require(resolve(root, "content/preferences.js"));

const RAW = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/models-dev-sample.json"), "utf8"));
const MARKUP = readFileSync(resolve(root, "content/preferences.xhtml"), "utf8");
const EN = JSON.parse(readFileSync(resolve(root, "locales/en.json"), "utf8"));
const PREFIX = "extensions.zotero.dualtran.";

globalThis.DualTranCatalog = catalog;
globalThis.DualTranLanguages = languages;

/* ------------------------------------------------------------------ DOM stub */

class StubElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.value = "";
    this.textContent = "";
    this.disabled = false;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  appendChild(child) {
    this.children.push(child);
    if (this.tagName === "SELECT" && this.children.length === 1) this.value = child.value;
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((entry) => entry !== child);
    return child;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] || []).filter((entry) => entry !== handler);
  }
  fire(type) {
    for (const handler of this.listeners[type] || []) handler({ target: this, type });
  }
  get options() {
    return this.children;
  }
  text() {
    return this.children.map((child) => child.textContent);
  }
  values() {
    return this.children.map((child) => child.getAttribute("value"));
  }
}

function parseMarkup(source) {
  // The pane's header comment explains the rules in prose; only real elements matter here.
  const markup = String(source).replace(/<!--[\s\S]*?-->/g, "");
  const doc = {
    elements: {},
    createElementNS: (_ns, tag) => new StubElement(doc, tag),
    getElementById(id) {
      return doc.elements[id] || null;
    },
    querySelectorAll(selector) {
      const attribute = /\[([a-z-]+)\]/.exec(selector);
      if (!attribute) return [];
      return Object.values(doc.elements).filter((node) => node.getAttribute(attribute[1]) !== null);
    },
  };
  const elements = [];
  for (const match of markup.matchAll(/<(?:[a-z][\w-]*:)?(select|input|button|span|label|p|h1)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const id = (attrs.match(/\bid=["']([^"']+)["']/) || [])[1];
    const node = new StubElement(doc, tag === "select" ? "select" : tag === "input" ? "input" : "div");
    for (const pair of attrs.matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/gi)) node.setAttribute(pair[1], pair[2]);
    elements.push(node);
    if (id) {
      doc.elements[id] = node;
    }
    if (node.getAttribute("data-i18n") !== null) {
      doc.elements["i18n:" + node.getAttribute("data-i18n")] = node;
    }
  }
  doc.all = elements;
  return doc;
}

/* ------------------------------------------------------------- fake Zotero IO */

function fakeIo(options = {}) {
  const values = new Map(Object.entries(options.prefs || {}));
  const userValues = new Set(Object.keys(options.prefs || {}).filter((key) => !(options.defaults || []).includes(key)));
  const requests = [];
  const io = {
    values,
    userValues,
    requests,
    getPref: (key) => (values.has(key) ? values.get(key) : undefined),
    setPref: (key, value) => {
      values.set(key, value);
      userValues.add(key);
    },
    hasUserValue: (key) => userValues.has(key),
    now: () => 1_700_000_000_000,
    request: async (method, url, params) => {
      requests.push({ method, url, params });
      if (options.failRequest) throw new Error(options.failRequest);
      return { response: options.response || RAW };
    },
  };
  return io;
}

const t = (key, params) => {
  const value = EN[key] || key;
  return params ? value.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name]))) : value;
};

async function open(ioOptions = {}, mountOptions = {}) {
  const io = fakeIo(ioOptions);
  const doc = parseMarkup(MARKUP);
  const handle = await pane.mount(doc, io, { t, catalogue: { forceRefresh: true }, ...mountOptions });
  return { io, doc, handle };
}

/* -------------------------------------------------------------------- tests */

describe("locale mapping", () => {
  it("maps Zotero's locale spelling onto the catalogue codes", () => {
    expect(pane.localeCandidates("pt-BR")[0]).toBe("pt_BR");
    expect(pane.localeCandidates("pt_BR")[0]).toBe("pt_BR");
    expect(pane.localeCandidates("zh-CN")[0]).toBe("zh_CN");
    expect(pane.localeCandidates("zh-TW")[0]).toBe("zh_TW");
    expect(pane.localeCandidates("pt-PT")[0]).toBe("pt_PT");
  });

  it("falls back to the base language and then English", () => {
    const candidates = pane.localeCandidates("de-AT");
    expect(candidates).toContain("de");
    expect(candidates[candidates.length - 1]).toBe("en");
  });
});

describe("legacy migration", () => {
  it("copies the 0.2.x target/endpoint/model onto the pane's keys once", () => {
    const io = fakeIo({
      prefs: {
        [PREFIX + "target"]: "ja",
        [PREFIX + "endpoint"]: "https://proxy.example/v1",
        [PREFIX + "model"]: "gpt-4o",
        [PREFIX + "aiProvider"]: "deepseek",
      },
    });
    const migrated = pane.migrateLegacy(io);
    expect(migrated).toEqual(["aiBaseUrl", "aiModel"]);
    expect(io.getPref(PREFIX + "aiProvider")).toBe("deepseek");
    expect(io.getPref(PREFIX + "aiBaseUrl")).toBe("https://proxy.example/v1");
    expect(io.getPref(PREFIX + "aiModel")).toBe("gpt-4o");
    expect(io.getPref(PREFIX + "target")).toBe("ja");
    expect(io.getPref(PREFIX + "migrated")).toBe(true);
    expect(pane.migrateLegacy(io)).toEqual([]);
  });

  it("never overwrites a value the user already chose", () => {
    const io = fakeIo({
      prefs: {
        [PREFIX + "target"]: "ja",
        [PREFIX + "endpoint"]: "https://proxy.example/v1",
        [PREFIX + "aiBaseUrl"]: "https://api.moonshot.ai/v1",
      },
    });
    pane.migrateLegacy(io);
    expect(io.getPref(PREFIX + "aiBaseUrl")).toBe("https://api.moonshot.ai/v1");
    expect(io.getPref(PREFIX + "target")).toBe("ja");
  });

  it("ignores keys the user never set", () => {
    const io = fakeIo({ prefs: {}, defaults: [] });
    expect(pane.migrateLegacy(io)).toEqual([]);
  });
});

describe("request-time reasoning (R4)", () => {
  const core = require(resolve(root, "content/translate.js"));
  const requestWith = (levels, setting) =>
    JSON.parse(
      core.buildChatRequest(
        {
          endpoint: "https://api.deepseek.com",
          apiKey: "k",
          model: "deepseek-v4-pro",
          reasoning: { resolve: () => catalog.resolveReasoningDepth({ setting, levels }) },
        },
        { text: "Hello", target: "zh-CN" }
      ).body
    );

  it("sends the cheapest declared effort for the stored sentinel", () => {
    expect(requestWith(["low", "high"], "lowest").reasoning_effort).toBe("low");
    expect(requestWith(["minimal", "low", "high"], "lowest").reasoning_effort).toBe("minimal");
    expect(requestWith(["none", "low"], "lowest").reasoning_effort).toBe("none");
  });

  it("sends no reasoning parameter for a model that declares nothing", () => {
    expect(requestWith([], "lowest")).not.toHaveProperty("reasoning_effort");
  });

  it("sends an explicit depth the user chose", () => {
    expect(requestWith(["low", "high", "max"], "max").reasoning_effort).toBe("max");
  });

  it("leaves requests without a reasoning resolver untouched", () => {
    const body = JSON.parse(
      core.buildChatRequest({ endpoint: "https://x/v1", model: "m" }, { text: "a", target: "en" }).body
    );
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

describe("catalogue loading", () => {
  it("refreshes over HTTP when there is no cache", async () => {
    const io = fakeIo({ response: RAW });
    const loaded = await pane.loadCatalogue(io);
    expect(loaded.source).toBe("network");
    expect(io.requests).toHaveLength(1);
    expect(io.requests[0].url).toBe("https://models.dev/api.json");
    const cache = io.getPref(PREFIX + "catalog");
    expect(cache.data.openai.name).toBe("OpenAI");
    expect(typeof cache.ts).toBe("number");
  });

  it("uses a cache younger than 24h without touching the network", async () => {
    const io = fakeIo({ prefs: { [PREFIX + "catalog"]: { ts: Date.now(), data: { openai: { name: "OpenAI", models: {} } } } } });
    const loaded = await pane.loadCatalogue(io);
    expect(loaded.source).toBe("cache");
    expect(io.requests).toHaveLength(0);
  });

  it("refreshes a cache older than 24h", async () => {
    const io = fakeIo({ prefs: { [PREFIX + "catalog"]: { ts: Date.now() - 25 * 60 * 60 * 1000, data: {} } }, response: RAW });
    const loaded = await pane.loadCatalogue(io);
    expect(loaded.source).toBe("network");
    expect(io.requests).toHaveLength(1);
  });

  it("falls back to the stale cache when the network fails", async () => {
    const stale = { ts: 1, data: { anthropic: { name: "Anthropic", models: {} } } };
    const io = fakeIo({ prefs: { [PREFIX + "catalog"]: stale }, failRequest: "offline" });
    const loaded = await pane.loadCatalogue(io);
    expect(loaded.source).toBe("stale");
    expect(loaded.data).toEqual(stale.data);
  });

  it("falls back to the built-ins when there is neither cache nor network", async () => {
    const io = fakeIo({ failRequest: "offline" });
    const loaded = await pane.loadCatalogue(io);
    expect(loaded.source).toBe("built-in");
    expect(pane.parseCache(io.getPref(PREFIX + "catalog"))).toEqual({ ts: 0, data: {} });
  });

  it("treats a corrupt cache value as absent", () => {
    expect(pane.parseCache("{not json")).toBeNull();
    expect(pane.parseCache({ ts: "soon", data: {} })).toBeNull();
    expect(pane.parseCache(undefined)).toBeNull();
  });
});

describe("mounted pane", () => {
  it("renders a language picker with >= 38 readable options and keeps the stored target", async () => {
    const { doc } = await open();
    const target = doc.getElementById("target");
    expect(target.options.length).toBeGreaterThanOrEqual(38);
    expect(target.values()).toContain("zh-CN");
    expect(target.value).toBe("zh-CN");
    expect(target.text()[0]).toMatch(/^(.+) \((.+)\)$/);
  });

  it("renders one alphabetical provider list with the custom provider last", async () => {
    const { doc } = await open();
    const provider = doc.getElementById("provider");
    const values = provider.values();
    expect(values[values.length - 1]).toBe("custom");
    expect(values).toContain("openai");
    expect(values).toContain("deepseek");
    expect(values).not.toContain("google");
    expect(new Set(values).size).toBe(values.length);
  });

  it("writes the new provider's API base into the endpoint field", async () => {
    const { doc, io } = await open();
    const provider = doc.getElementById("provider");
    provider.value = "deepseek";
    provider.fire("change");
    expect(doc.getElementById("endpoint").value).toBe("https://api.deepseek.com");
    expect(io.getPref(PREFIX + "aiProvider")).toBe("deepseek");
    expect(io.getPref(PREFIX + "aiBaseUrl")).toBe("https://api.deepseek.com");
  });

  it("keeps a hand-edited endpoint across a provider switch", async () => {
    const { doc, io } = await open();
    const endpoint = doc.getElementById("endpoint");
    endpoint.value = "https://proxy.example/v1";
    endpoint.fire("change");
    const provider = doc.getElementById("provider");
    provider.value = "openai";
    provider.fire("change");
    expect(endpoint.value).toBe("https://proxy.example/v1");
    expect(io.getPref(PREFIX + "aiBaseUrl")).toBe("https://proxy.example/v1");
    expect(io.getPref(PREFIX + "aiProvider")).toBe("openai");
  });

  it("repopulates the model list and picks the first model of the new provider", async () => {
    const { doc, io } = await open();
    const provider = doc.getElementById("provider");
    provider.value = "deepseek";
    provider.fire("change");
    const model = doc.getElementById("model");
    expect(model.values()).not.toContain("gpt-4o");
    expect(model.values()).toContain("deepseek-v4-pro");
    expect(model.values()[model.values().length - 1]).toBe("__custom__");
    expect(io.getPref(PREFIX + "aiModel")).toBe(model.value);
  });

  it("offers the reasoning sentinel first and persists the choice", async () => {
    const { doc, io } = await open();
    const provider = doc.getElementById("provider");
    provider.value = "deepseek";
    provider.fire("change");
    const reasoning = doc.getElementById("reasoning");
    expect(reasoning.values()[0]).toBe("lowest");
    expect(reasoning.values()).toEqual(expect.arrayContaining(["low", "high", "max"]));
    expect(io.getPref(PREFIX + "aiReasoningDepth") || "lowest").toBe("lowest");
    reasoning.value = "high";
    reasoning.fire("change");
    expect(io.getPref(PREFIX + "aiReasoningDepth")).toBe("high");
  });

  it("offers only the sentinel for a model that declares no reasoning", async () => {
    const { doc } = await open();
    const model = doc.getElementById("model");
    const values = model.values();
    expect(values).toContain("gpt-4o");
    model.value = "gpt-4o";
    model.fire("change");
    expect(doc.getElementById("reasoning").values()).toEqual(["lowest"]);
  });

  it("saves the target language and the API key on change", async () => {
    const { doc, io } = await open();
    const target = doc.getElementById("target");
    target.value = "ja";
    target.fire("change");
    expect(io.getPref(PREFIX + "target")).toBe("ja");
    const apiKey = doc.getElementById("apiKey");
    apiKey.value = "sk-test";
    apiKey.fire("input");
    expect(io.getPref(PREFIX + "apiKey")).toBe("sk-test");
    expect(doc.getElementById("apiKey").getAttribute("type")).toBe("password");
  });

  it("translates every label through the dictionary", async () => {
    const { doc } = await open();
    const label = doc.getElementById("i18n:pref.target");
    expect(label.textContent).toBe(EN["pref.target"]);
    expect(doc.getElementById("target").getAttribute("aria-label")).toBe(EN["pref.target"]);
    expect(doc.getElementById("refresh").textContent).toBe(EN["pref.refresh"]);
  });

  it("shows when the catalogue was refreshed", async () => {
    const { doc } = await open();
    const status = doc.getElementById("status");
    expect(status.textContent).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("refreshes the catalogue on demand", async () => {
    const { doc, io, handle } = await open();
    io.requests.length = 0;
    await handle.handlers.refresh();
    expect(io.requests).toHaveLength(1);
    expect(io.requests[0].url).toBe("https://models.dev/api.json");
    expect(doc.getElementById("provider").options.length).toBeGreaterThan(5);
  });

  it("falls back to the built-ins so the pane still renders offline", async () => {
    const { doc } = await open({ failRequest: "offline" }, { catalogue: { forceRefresh: true } });
    const provider = doc.getElementById("provider");
    expect(provider.values()).toContain("openai");
    expect(provider.values()).toContain("custom");
    expect(doc.getElementById("target").options.length).toBeGreaterThanOrEqual(38);
  });

  it("removes its listeners on destroy", async () => {
    const { doc, io, handle } = await open();
    handle.destroy();
    const provider = doc.getElementById("provider");
    provider.value = "deepseek";
    provider.fire("change");
    expect(io.getPref(PREFIX + "aiProvider")).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------- start() */

/** A window whose Zotero surface serves locale files from `locales/` (or fails, for fallbacks). */
function fakeZoteroWindow({ locale = "en", locales = ["en"], prefs = {}, response = RAW } = {}) {
  const doc = parseMarkup(MARKUP);
  const values = new Map(Object.entries(prefs));
  const requests = [];
  const win = {
    document: doc,
    Zotero: {
      locale,
      DualTranRootURI: "resource://dualtran/",
      Prefs: {
        get: (key) => values.get(key),
        set: (key, value) => values.set(key, value),
      },
      File: {
        getResourceAsync: async (uri) => {
          const code = uri.slice(uri.lastIndexOf("/") + 1).replace(/\.json$/, "");
          if (!locales.includes(code)) throw new Error("no such resource: " + code);
          return readFileSync(resolve(root, "locales", code + ".json"), "utf8");
        },
      },
      HTTP: {
        request: async (method, url) => {
          requests.push({ method, url });
          if (!response) throw new Error("offline");
          return { response };
        },
      },
    },
    Services: {
      scriptloader: { loadSubScript: (uri, scope) => (scope.DualTranI18n = require(resolve(root, "content/i18n.js"))) },
      prefs: { prefHasUserValue: (key) => values.has(key) },
    },
  };
  return { win, doc, values, requests };
}

describe("start()", () => {
  it("renders the pane from Zotero.DualTranRootURI and the locale file", async () => {
    const { win, doc } = fakeZoteroWindow({ locale: "en", locales: ["en"] });
    await pane.start(win);
    expect(doc.getElementById("target").children.length).toBeGreaterThanOrEqual(38);
    expect(doc.getElementById("provider").children.length).toBeGreaterThan(5);
    expect(doc.getElementById("provider").children.at(-1).getAttribute("value")).toBe("custom");
    expect(doc.getElementById("endpoint").value).toBe("https://api.openai.com/v1");
  });

  it("maps Zotero's pt-BR locale onto locales/pt_BR.json", async () => {
    const { win, doc } = fakeZoteroWindow({ locale: "pt-BR", locales: ["pt_BR", "pt"] });
    await pane.start(win);
    const ptBr = JSON.parse(readFileSync(resolve(root, "locales/pt_BR.json"), "utf8"));
    expect(doc.getElementById("refresh").textContent).toBe(ptBr["pref.refresh"]);
    expect(pane.localeCandidates("pt-BR")[0]).toBe("pt_BR");
  });

  it("falls back to English when the locale file is missing", async () => {
    const { win, doc } = fakeZoteroWindow({ locale: "xx-YY", locales: ["en"] });
    await pane.start(win);
    expect(doc.getElementById("refresh").textContent).toBe("Refresh catalogue");
  });

  it("keeps a user's endpoint override and stored provider across a start", async () => {
    const { win, doc } = fakeZoteroWindow({
      locale: "en",
      locales: ["en"],
      prefs: {
        [PREFIX + "aiProvider"]: "deepseek",
        [PREFIX + "aiModel"]: "deepseek-v4-flash",
        [PREFIX + "aiBaseUrl"]: "https://proxy.example/v1",
        [PREFIX + "target"]: "ja",
        [PREFIX + "migrated"]: true,
      },
    });
    await pane.start(win);
    expect(doc.getElementById("provider").value).toBe("deepseek");
    expect(doc.getElementById("model").value).toBe("deepseek-v4-flash");
    expect(doc.getElementById("endpoint").value).toBe("https://proxy.example/v1");
    expect(doc.getElementById("target").value).toBe("ja");
  });
});
