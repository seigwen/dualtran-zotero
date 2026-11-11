/**
 * DualTran preference pane script.
 *
 * Registered by bootstrap.js through Zotero.PreferencePanes.register and evaluated in the
 * preferences window after the XUL fragment is inserted. Two hard boundaries keep it testable:
 *
 *   - All logic that can be pure lives in DualTranCatalog / DualTranLanguages.
 *   - Everything that talks to Zotero (prefs, HTTP, file loading) goes through an injected
 *     `io` object, so content/preferences.js runs unchanged under vitest with a fake `io`.
 *
 * Wiring order matters: prefs first (migration), then the catalogue (cache or network), then
 * the selects, then the change handlers that write the prefs back.
 */
(function (root) {
  "use strict";

  /** `extensions.zotero.dualtran.<key>` */
  const PREF_PREFIX = "extensions.zotero.dualtran.";
  const PREFS = {
    target: "target",
    provider: "aiProvider",
    model: "aiModel",
    endpoint: "aiBaseUrl",
    reasoning: "aiReasoningDepth",
    apiKey: "apiKey",
    catalog: "catalog",
    migrated: "migrated",
  };

  /** Pre-0.3 keys the pane reads once and then retires, so a user's old setup survives. */
  const LEGACY = {
    target: "target",
    endpoint: "endpoint",
    model: "model",
    engine: "engine",
    apiKey: "apiKey",
  };

  const DEFAULTS = {
    target: "zh-CN",
    provider: "openai",
    model: "",
    endpoint: "https://api.openai.com/v1",
    reasoning: "lowest",
    apiKey: "",
  };

  const CATALOG_URL = "https://models.dev/api.json";
  const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * Zotero reports its locale with an underscore (`pt_BR`, `zh_CN`) and a region (`pt-PT`); the
   * locale files use underscores and are named after the browser build's list.
   */
  const LOCALE_ALIASES = {
    pt_BR: "pt_BR",
    "pt-BR": "pt_BR",
    pt_PT: "pt_PT",
    "pt-PT": "pt_PT",
    zh_CN: "zh_CN",
    "zh-CN": "zh_CN",
    zh_TW: "zh_TW",
    "zh-TW": "zh_TW",
  };

  function localeCandidates(locale) {
    const raw = String(locale || "en").trim() || "en";
    const underscored = raw.replace(/-/g, "_");
    const base = raw.split(/[-_]/)[0];
    const ordered = [
      LOCALE_ALIASES[raw],
      LOCALE_ALIASES[underscored],
      underscored,
      raw,
      base,
      "en",
    ].filter(Boolean);
    return [...new Set(ordered)];
  }

  function isBlank(value) {
    return value === undefined || value === null || String(value).trim() === "";
  }

  function prefKey(name) {
    return PREF_PREFIX + name;
  }

  /** Read the pane's settings through `io.getPref` (fully-qualified names). */
  function readSettings(io) {
    const read = (name, fallback) => {
      const value = io.getPref(prefKey(name));
      return isBlank(value) ? fallback : value;
    };
    return {
      target: String(read(PREFS.target, DEFAULTS.target)),
      provider: String(read(PREFS.provider, DEFAULTS.provider)),
      model: String(read(PREFS.model, DEFAULTS.model)),
      endpoint: String(read(PREFS.endpoint, DEFAULTS.endpoint)),
      reasoning: String(read(PREFS.reasoning, DEFAULTS.reasoning)),
      apiKey: String(read(PREFS.apiKey, DEFAULTS.apiKey)),
    };
  }

  /**
   * Copy the 0.2.x settings into the pane's keys, once.
   *
    * Only keys the user actually set are copied (so a stale default does not win over the new
    * default), the new keys are never overwritten, and the migration is recorded in a pref so a
    * later manual choice cannot be undone on the next start. The target language keeps its own
    * 0.2.x key name (`target`), so it is not part of the move list.
    */
  function migrateLegacy(io) {
    if (io.getPref(prefKey(PREFS.migrated)) === true) return [];
    const moves = [
      { from: LEGACY.target, to: PREFS.target },
      { from: LEGACY.endpoint, to: PREFS.endpoint },
      { from: LEGACY.model, to: PREFS.model },
      { from: LEGACY.apiKey, to: PREFS.apiKey },
    ];
    const migrated = [];
    for (const move of moves) {
      if (io.hasUserValue(prefKey(move.to))) continue;
      if (!io.hasUserValue(prefKey(move.from))) continue;
      const value = io.getPref(prefKey(move.from));
      if (isBlank(value)) continue;
      io.setPref(prefKey(move.to), value);
      migrated.push(move.to);
    }
    const engine = io.getPref(prefKey(LEGACY.engine));
    if (!io.hasUserValue(prefKey(PREFS.provider)) && String(engine || "").toLowerCase() === "google") {
      // 0.2.x translated for free through Google; keep the pane honest about that choice by
      // leaving the provider at its default instead of pretending the key above is used.
      migrated.push("provider(default)");
    }
    io.setPref(prefKey(PREFS.migrated), true);
    return migrated;
  }

  function parseCache(raw) {
    let value = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== "object") return null;
    const timestamp = Number(value.ts);
    if (!Number.isFinite(timestamp) || !value.data || typeof value.data !== "object") return null;
    return { ts: timestamp, data: value.data };
  }

  function isFresh(cache, now) {
    return Boolean(cache) && now - cache.ts < CATALOG_TTL_MS && now >= cache.ts;
  }

  /**
   * The models.dev document for this render.
   *
   * Order: fresh cache → network → stale cache → built-ins (empty document). A failed refresh is
   * never fatal: the pane always renders something and says which source it used.
   */
  async function loadCatalogue(io, options) {
    const force = Boolean(options && options.forceRefresh);
    const now = typeof (options && options.now) === "number" ? options.now : Date.now();
    const cached = parseCache(io.getPref(prefKey(PREFS.catalog)));
    if (!force && isFresh(cached, now)) return { data: cached.data, source: "cache", ts: cached.ts };

    try {
      const response = await io.request("GET", CATALOG_URL, { responseType: "json", timeout: 20000 });
      const data = response && response.response;
      if (!data || typeof data !== "object") throw new Error("empty catalogue response");
      io.setPref(prefKey(PREFS.catalog), { ts: now, data: data });
      return { data: data, source: "network", ts: now };
    } catch (error) {
      if (cached) return { data: cached.data, source: "stale", ts: cached.ts, error: error };
      io.setPref(prefKey(PREFS.catalog), { ts: 0, data: {} });
      return { data: {}, source: "built-in", ts: 0, error: error };
    }
  }

  /** Fill a <select> with `{value, text}` rows, keeping `selected` when it is still offered. */
  function fillSelect(select, options, selected) {
    if (!select) return;
    const doc = select.ownerDocument;
    while (select.firstChild) select.removeChild(select.firstChild);
    for (const option of options) {
      const element = doc.createElementNS("http://www.w3.org/1999/xhtml", "option");
      element.setAttribute("value", String(option.value));
      element.textContent = option.text;
      select.appendChild(element);
    }
    const wanted = String(selected == null ? "" : selected);
    if (wanted && options.some((option) => String(option.value) === wanted)) {
      select.value = wanted;
    } else if (options.length) {
      select.value = String(options[0].value);
    }
  }

  function providerEntry(providers, id) {
    return providers.find((entry) => entry.id === id) || null;
  }

  function modelRows(entry, customLabel) {
    if (!entry) return [];
    return entry.models.map((model) =>
      /^__custom/.test(model.value) ? { value: model.value, text: customLabel } : model
    );
  }

  /** Reasoning levels of the selected model, whatever the catalogue had to say about it. */
  function levelsFor(catalogue, provider, model) {
    const models = catalogue.modelsById[provider];
    const entry = models && models[model];
    return entry && Array.isArray(entry.levels) ? entry.levels : [];
  }

  function reasoningRows(levels, t) {
    const labels = {
      lowest: t("pref.reasoningLowest"),
      none: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    };
    return DualTranCatalog.reasoningOptions({ setting: DualTranCatalog.LOWEST, levels: levels }).map(
      (row) => ({ value: row.value, text: labels[row.value] || row.value })
    );
  }

  /** Every element carrying `attribute` (real DOMs and the test stub both answer this). */
function nodesWithAttribute(doc, attribute) {
  const nodes = typeof doc.querySelectorAll === "function" ? doc.querySelectorAll("[" + attribute + "]") : [];
  const list = nodes ? Array.from(nodes) : [];
  if (list.length) return list;
  const all = Array.isArray(doc.all) ? doc.all : [];
  return all.filter((node) => node.getAttribute && node.getAttribute(attribute) !== null);
}

function statusText(t, state) {
    if (!state || !state.ts) return "";
    const date = new Date(state.ts);
    const stamped = isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
    return t("pref.catalogStatus", { date: stamped });
  }

  /**
   * Wire the pane.
   *
   * @param {Document} doc the preferences document
   * @param {{getPref: Function, setPref: Function, hasUserValue: Function, request: Function,
   *          now?: Function}} io
   * @param {{t: Function, options?: Object}} options translator + first-render overrides
   * @returns {Promise<{state: Object, destroy: Function}>}
   */
  async function mount(doc, io, options) {
    const translator = (options && options.t) || function (key) { return key; };
    const t = (key, params) => translator(key, params);
    const catalog = root.DualTranCatalog;
    const languages = root.DualTranLanguages;
    if (!catalog) throw new Error("DualTran: content/catalog.js was not loaded before the pane");

    const el = (id) => doc.getElementById(id);
    const target = el("target");
    const provider = el("provider");
    const model = el("model");
    const endpoint = el("endpoint");
    const reasoning = el("reasoning");
    const apiKey = el("apiKey");
    const refresh = el("refresh");
    const status = el("status");

    // R5: every label comes from the dictionary, never from the markup's English fallback.
    for (const node of nodesWithAttribute(doc, "data-i18n")) {
      const key = node.getAttribute("data-i18n");
      if (key) node.textContent = t(key);
    }
    for (const node of nodesWithAttribute(doc, "data-i18n-aria-label")) {
      node.setAttribute("aria-label", t(node.getAttribute("data-i18n-aria-label")));
    }

    migrateLegacy(io);

    const settings = readSettings(io);
    const loaded = await loadCatalogue(io, options && options.catalogue);
    const projected = catalog.projectCatalog(loaded.data);
    const providers = catalog.buildProviderList(projected);
    const state = {
      providers: providers,
      catalogue: projected,
      provider: settings.provider,
      model: settings.model,
      endpoint: settings.endpoint,
      source: loaded.source,
      ts: loaded.ts,
    };

    /** Re-render everything except the endpoint, which the user may be editing. */
    function render(resetEndpoint) {
      fillSelect(target, catalog.languageOptions(languages ? languages.names : {}, settings.target), settings.target);
      settings.target = target.value || settings.target;
      fillSelect(
        provider,
        providers.map((entry) => ({
          value: entry.id,
          text: entry.source === "custom" ? t("pref.customProvider") : entry.name,
        })),
        state.provider
      );
      state.provider = provider.value || state.provider;
      const entry = providerEntry(providers, state.provider);
      fillSelect(model, modelRows(entry, t("pref.customModel")), state.model);
      state.model = model.value || state.model;
      fillSelect(reasoning, reasoningRows(levelsFor(projected, state.provider, state.model), t), settings.reasoning);
      if (endpoint) {
        if (resetEndpoint) endpoint.value = state.endpoint;
        else if (!endpoint.value) endpoint.value = state.endpoint;
      }
      if (apiKey) apiKey.value = settings.apiKey;
      if (status) status.textContent = statusText(t, { ts: loaded.ts, source: loaded.source });
    }

    function save(name, value) {
      io.setPref(prefKey(name), value);
    }

    function onTargetChange() {
      settings.target = target.value;
      save(PREFS.target, settings.target);
    }

    /** R2 + R3: a provider pick rewrites the model list and, when the endpoint is pristine, its base. */
    function onProviderChange() {
      const previousProvider = state.provider;
      const nextProvider = provider.value;
      const resolved = catalog.resolveEndpointOnProviderChange({
        current: endpoint ? endpoint.value : state.endpoint,
        previousProvider: previousProvider,
        nextProvider: nextProvider,
        providers: projected.providers,
      });
      state.provider = nextProvider;
      state.endpoint = resolved;
      // Keep the current model when the new provider also lists it; otherwise take its first.
      const nextEntry = providerEntry(providers, nextProvider);
      const keepModel = nextEntry && nextEntry.models.some((row) => row.value === state.model);
      if (!keepModel) {
        const first = nextEntry && nextEntry.models.find((row) => !/^__custom/.test(row.value));
        state.model = first ? first.value : "";
      }
      fillSelect(model, modelRows(nextEntry, t("pref.customModel")), state.model);
      state.model = model.value || state.model;
      fillSelect(reasoning, reasoningRows(levelsFor(projected, state.provider, state.model), t), settings.reasoning);
      if (endpoint) endpoint.value = resolved;
      save(PREFS.provider, state.provider);
      save(PREFS.endpoint, resolved);
      if (state.model) save(PREFS.model, state.model);
    }

    function onModelChange() {
      state.model = model.value;
      save(PREFS.model, state.model);
      fillSelect(reasoning, reasoningRows(levelsFor(projected, state.provider, state.model), t), reasoning.value);
    }

    function onEndpointInput() {
      state.endpoint = endpoint.value;
      save(PREFS.endpoint, endpoint.value);
    }

    function onReasoningChange() {
      settings.reasoning = reasoning.value;
      save(PREFS.reasoning, reasoning.value);
    }

    function onApiKeyInput() {
      settings.apiKey = apiKey.value;
      save(PREFS.apiKey, apiKey.value);
    }

    async function onRefresh() {
      if (refresh) refresh.disabled = true;
      try {
        io.setPref(prefKey(PREFS.catalog), { ts: 0, data: {} });
        const reloaded = await loadCatalogue(io, {
          forceRefresh: true,
          now: io.now ? io.now() : undefined,
        });
        const next = catalog.projectCatalog(reloaded.data);
        state.providers.length = 0;
        for (const row of catalog.buildProviderList(next)) state.providers.push(row);
        state.catalogue = next;
        state.source = reloaded.source;
        state.ts = reloaded.ts;
        fillSelect(
          provider,
          state.providers.map((item) => ({
            value: item.id,
            text: item.source === "custom" ? t("pref.customProvider") : item.name,
          })),
          state.provider
        );
        if (!providerEntry(state.providers, state.provider) && state.providers.length) {
          state.provider = state.providers[0].id;
          provider.value = state.provider;
        }
        const entry = providerEntry(state.providers, state.provider);
        fillSelect(model, modelRows(entry, t("pref.customModel")), state.model);
        state.model = model.value || state.model;
        if (status) status.textContent = statusText(t, { ts: reloaded.ts, source: reloaded.source });
      } finally {
        if (refresh) refresh.disabled = false;
      }
    }

    const listeners = [
      [target, "change", onTargetChange],
      [provider, "change", onProviderChange],
      [model, "change", onModelChange],
      [endpoint, "input", onEndpointInput],
      [endpoint, "change", onEndpointInput],
      [reasoning, "change", onReasoningChange],
      [apiKey, "input", onApiKeyInput],
      [apiKey, "change", onApiKeyInput],
      [refresh, "click", onRefresh],
    ];
    for (const [node, type, handler] of listeners) {
      if (node && node.addEventListener) node.addEventListener(type, handler);
    }

    render(true);

    return {
      state: state,
      handlers: {
        target: onTargetChange,
        provider: onProviderChange,
        model: onModelChange,
        endpoint: onEndpointInput,
        reasoning: onReasoningChange,
        apiKey: onApiKeyInput,
        refresh: onRefresh,
      },
      destroy: function () {
        for (const [node, type, handler] of listeners) {
          if (node && node.removeEventListener) node.removeEventListener(type, handler);
        }
      },
    };
  }

  /**
   * Entry point called by Zotero when the pane opens. Loads i18n.js and the locale dictionary,
   * then mounts. A failure here throws into Zotero's console instead of leaving a blank pane.
   */
  async function start(win) {
    const window = win || root;
    const zotero = window.Zotero || root.Zotero;
    const rootURI = zotero && zotero.DualTranRootURI ? zotero.DualTranRootURI : "";
    const Services = window.Services || root.Services;

    if (!window.DualTranI18n && rootURI && Services && Services.scriptloader) {
      Services.scriptloader.loadSubScript(rootURI + "content/i18n.js", window);
    }

    const i18n = window.DualTranI18n || root.DualTranI18n;
    const load = async (code) => JSON.parse(await zotero.File.getResourceAsync(rootURI + "locales/" + code + ".json"));
    let dictionary = null;
    for (const code of localeCandidates(zotero.locale)) {
      try {
        dictionary = await load(code);
        break;
      } catch (error) {
        // try the next candidate, English last
      }
    }
    i18n.set(dictionary || {});

    const io = {
      getPref: (key) => zotero.Prefs.get(key, true),
      setPref: (key, value) => zotero.Prefs.set(key, value, true),
      hasUserValue: (key) => {
        try {
          return Services.prefs.prefHasUserValue(key);
        } catch (error) {
          return false;
        }
      },
      request: (method, url, params) => zotero.HTTP.request(method, url, params),
    };

    return mount(window.document, io, { t: (key, params) => i18n.t(key, params) });
  }

  const api = {
    PREF_PREFIX: PREF_PREFIX,
    PREFS: PREFS,
    LEGACY: LEGACY,
    DEFAULTS: DEFAULTS,
    CATALOG_URL: CATALOG_URL,
    CATALOG_TTL_MS: CATALOG_TTL_MS,
    localeCandidates: localeCandidates,
    readSettings: readSettings,
    migrateLegacy: migrateLegacy,
    parseCache: parseCache,
    isFresh: isFresh,
    loadCatalogue: loadCatalogue,
    fillSelect: fillSelect,
    nodesWithAttribute: nodesWithAttribute,
    levelsFor: levelsFor,
    reasoningRows: reasoningRows,
    statusText: statusText,
    mount: mount,
    start: start,
  };

  root.DualTranPreferences = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
