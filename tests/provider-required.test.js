/**
 * The entry points that actually hit the network (SPEC 2.1, product rule 5).
 *
 * `bootstrap.js` is a plain Zotero bootstrap script, not a module: it references the global
 * `Zotero`, `Services` and `APP_SHUTDOWN`. This harness evaluates it in a `vm` context whose
 * `Zotero` is a stub, then drives the real menu command and reader action. The invariant under
 * test is the one that cannot be checked by reading the pane: with no provider chosen nothing
 * leaves the process — no HTTP request, no child note, no annotation — and the localized
 * `providerRequiredError` is shown instead.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const require = createRequire(import.meta.url);

const EN = JSON.parse(readFileSync(resolve(root, "locales/en.json"), "utf8"));
const ZH = JSON.parse(readFileSync(resolve(root, "locales/zh_CN.json"), "utf8"));
const PREFIX = "extensions.zotero.dualtran.";

/* ------------------------------------------------------------------ Zotero stub */

function fakeItem(id, title = "Attention Is All You Need", abstractNote = "We propose the Transformer.") {
  const fields = { title, abstractNote };
  const item = {
    id,
    libraryID: 1,
    saved: 0,
    getField: (name) => fields[name] || "",
    setField: (name, value) => {
      fields[name] = value;
    },
    isRegularItem: () => true,
    parentItemID: false,
    saveTx: async () => {
      item.saved += 1;
    },
    fields,
  };
  return item;
}

function harness({ prefs = {}, dictionary = EN, item = fakeItem(1) } = {}) {
  const values = new Map(Object.entries(prefs));
  const requests = [];
  const alerts = [];
  const notes = [];
  const annotations = [];
  const progress = [];
  const menu = [];

  const i18n = require(resolve(root, "content/i18n.js"));
  i18n.set(dictionary);

  const win = {
    ZoteroPane: { getSelectedItems: () => [item] },
    document: {
      getElementById: (id) => (id === "dualtran-menu" ? { disabled: false } : null),
    },
  };

  const Zotero = {
    locale: "en",
    initialized: true,
    initializationPromise: Promise.resolve(),
    Prefs: {
      get: (key) => values.get(key),
      set: (key, value) => values.set(key, value),
    },
    File: { getResourceAsync: async () => "{}" },
    HTTP: {
      request: async (method, url, options) => {
        requests.push({ method, url, options });
        throw new Error("the network must not be reached in this test");
      },
    },
    Items: { get: (id) => (id === item.id ? item : null) },
    getMainWindows: () => [],
    getActiveZoteroPane: () => win.ZoteroPane,
    debug: () => {},
    alert: (_win, title, message) => alerts.push({ title, message }),
    DataObjectUtilities: { generateKey: () => "ABCD2345" },
    Annotations: {
      saveFromJSON: async (_attachment, json) => {
        annotations.push(json);
      },
    },
    Reader: {
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    },
    PreferencePanes: { register: () => {}, unregister: () => {} },
    ProgressWindow: class {
      changeHeadline(text) {
        progress.push(text);
      }
      addDescription() {}
      show() {}
      startCloseTimer() {}
    },
    Item: class {
      constructor(type) {
        this.type = type;
        this.libraryID = null;
        this.parentID = null;
      }
      setNote(html) {
        this.html = html;
      }
      async saveTx() {
        notes.push(this);
      }
    },
  };

  const scope = {
    Zotero,
    Services: {
      scriptloader: { loadSubScript: () => {} },
      prefs: { prefHasUserValue: (key) => values.has(key) },
      prompt: { confirm: () => true },
      ww: { registerNotification: () => {}, unregisterNotification: () => {} },
    },
    APP_SHUTDOWN: 2,
    DualTranI18n: i18n,
    DualTranCore: require(resolve(root, "content/translate.js")),
    DualTranCatalog: require(resolve(root, "content/catalog.js")),
    console,
  };
  scope.globalThis = scope;
  vm.createContext(scope);
  vm.runInContext(readFileSync(resolve(root, "bootstrap.js"), "utf8"), scope, { filename: "bootstrap.js" });

  return {
    Zotero,
    scope,
    win,
    values,
    requests,
    alerts,
    notes,
    annotations,
    progress,
    menu,
    item,
    runNote: () => scope.runItemAction(win, "note"),
    runReader: (mode = "highlight", text = "Attention is all you need") => {
      const button = {
        disabled: false,
        dataset: {},
        textContent: "",
        title: "",
      };
      const reader = { itemID: 7, type: "pdf" };
      const attachment = {
        parentItem: item,
        id: 7,
        libraryID: 1,
        isFileAttachment: () => true,
      };
      Zotero.Items.get = (id) => (id === 7 ? attachment : id === item.id ? item : null);
      const annotation = {
        text,
        pageLabel: "1",
        sortIndex: "00001|000001",
        position: { pageIndex: 0, rects: [[100, 700, 300, 712]] },
      };
      return scope.runReaderAction(button, mode, reader, attachment, annotation).then(() => button);
    },
  };
}

const AI_NO_PROVIDER = { [PREFIX + "engine"]: "ai", [PREFIX + "target"]: "zh-CN" };
const AI_WITH_PROVIDER = {
  ...AI_NO_PROVIDER,
  [PREFIX + "aiProvider"]: "anthropic",
  [PREFIX + "aiBaseUrl"]: "https://api.anthropic.com/v1",
  [PREFIX + "aiModel"]: "claude-sonnet-4-5",
};

/* --------------------------------------------------------------------- tests */

/**
 * Install the Tools menu the way startup does, against a document stub that — like a real
 * document — can find the menu again by id (the pane re-syncs its disabled state on each open).
 */
function installTestMenu(h) {
  const nodes = {};
  const make = (tag) => {
    const node = {
      tag,
      attributes: {},
      listeners: {},
      children: [],
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      addEventListener(type, handler) {
        (this.listeners[type] = this.listeners[type] || []).push(handler);
      },
      fire(type) {
        for (const handler of this.listeners[type] || []) handler({ type });
      },
      appendChild(child) {
        this.children.push(child);
        if (child.id) nodes[child.id] = child;
        return child;
      },
    };
    return node;
  };
  const tools = make("menupopup");
  const doc = {
    getElementById: (id) => (id === "menu_ToolsPopup" ? tools : nodes[id] || null),
    createXULElement: make,
  };
  h.scope.installMenu({ document: doc });
  const menu = tools.children[0];
  menu.popup = menu.children[0];
  return menu;
}

describe("translation guard: empty AI provider (SPEC 2.1)", () => {
  it("shows the localized providerRequiredError and sends nothing for an item action", async () => {
    const h = harness({ prefs: AI_NO_PROVIDER });
    await h.runNote();
    expect(h.requests).toEqual([]);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].message).toBe(EN.providerRequiredError);
    expect(h.notes).toEqual([]);
    expect(h.item.saved).toBe(0);
    expect(h.item.getField("title")).toBe("Attention Is All You Need");
  });

  it("localizes the guard message", async () => {
    const h = harness({ prefs: AI_NO_PROVIDER, dictionary: ZH });
    await h.runNote();
    expect(h.requests).toEqual([]);
    expect(h.alerts[0].message).toBe("翻译前请先在设置中选择 AI 提供商。");
  });

  it("treats a whitespace-only provider as unconfigured", async () => {
    const h = harness({ prefs: { ...AI_NO_PROVIDER, [PREFIX + "aiProvider"]: "   " } });
    await h.runNote();
    expect(h.requests).toEqual([]);
    expect(h.alerts[0].message).toBe(EN.providerRequiredError);
  });

  it("disables a reader popup button and titles it with the same string", async () => {
    const h = harness({ prefs: AI_NO_PROVIDER });
    const button = await h.runReader("highlight");
    expect(h.requests).toEqual([]);
    expect(h.annotations).toEqual([]);
    expect(button.title).toBe(EN.providerRequiredError);
    expect(button.disabled).toBe(true);
    // The label stays the action name; the reason travels in the tooltip.
    expect(button.textContent).toBe(EN["reader.error"]);
  });

  it("still reaches the provider once one is chosen", async () => {
    const h = harness({ prefs: AI_WITH_PROVIDER });
    await expect(h.runReader("highlight")).resolves.toBeTruthy();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].method).toBe("POST");
    expect(h.requests[0].url.startsWith("https://api.anthropic.com/v1")).toBe(true);
    expect(h.requests[0].options.headers["Content-Type"]).toBe("application/json");
    // The stub request throws, so the popup reports the failure — the point is that it tried.
    expect(h.alerts).toEqual([]);
  });

  it("leaves the Google engine alone", async () => {
    const h = harness({ prefs: { [PREFIX + "engine"]: "google" } });
    await h.runNote();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].url.startsWith("https://translate.googleapis.com/")).toBe(true);
  });

  it("keeps the tools menu entries disabled while no provider is set", () => {
    const h = harness({ prefs: AI_NO_PROVIDER });
    const menu = installTestMenu(h);
    expect(menu.tag).toBe("menu");
    expect(menu.attributes.label).toBe(EN["menu.root"]);
    expect(menu.attributes.tooltiptext).toBe(EN.providerRequiredError);
    expect(menu.attributes.disabled).toBe("true");
  });

  it("enables the tools menu once a provider is chosen", () => {
    const h = harness({ prefs: AI_WITH_PROVIDER });
    const menu = installTestMenu(h);
    expect(menu.attributes.disabled).toBeUndefined();
    expect(menu.attributes.tooltiptext).toBeUndefined();
  });

  it("re-syncs the menu when the provider is chosen later", () => {
    const h = harness({ prefs: AI_NO_PROVIDER });
    const menu = installTestMenu(h);
    expect(menu.attributes.disabled).toBe("true");
    for (const [key, value] of Object.entries(AI_WITH_PROVIDER)) h.values.set(key, value);
    menu.popup.fire("popupshowing");
    expect(menu.attributes.disabled).toBeUndefined();
    expect(menu.attributes.tooltiptext).toBeUndefined();
  });
});
