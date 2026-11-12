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
    /** SPEC 2.1: a fresh profile is unconfigured — never `openai`, never `custom`. */
    provider: "",
    model: "",
    endpoint: "",
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

  /**
   * Read the pane's settings through `io.getPref` (fully-qualified names).
   *
   * SPEC 2.1 rule 1: a stored value is reported exactly as stored (whitespace trimmed). An empty
   * provider stays empty — the pane renders its placeholder instead of inventing a provider — and
   * the fallbacks here are the *defaults*, which are themselves empty.
   */
  function readSettings(io) {
    const read = (name, fallback) => {
      const value = io.getPref(prefKey(name));
      return isBlank(value) ? fallback : String(value).trim();
    };
    return {
      target: read(PREFS.target, DEFAULTS.target),
      provider: read(PREFS.provider, DEFAULTS.provider),
      model: read(PREFS.model, DEFAULTS.model),
      endpoint: read(PREFS.endpoint, DEFAULTS.endpoint),
      reasoning: read(PREFS.reasoning, DEFAULTS.reasoning),
      apiKey: read(PREFS.apiKey, DEFAULTS.apiKey),
    };
  }

  /**
   * Copy the 0.2.x settings into the pane's keys, once.
   *
   * Only keys the user actually set are copied (so a stale default does not win over the new
   * default), the new keys are never overwritten, and the migration is recorded in a pref so a
   * later manual choice cannot be undone on the next start. The target language keeps its own
   * 0.2.x key name (`target`), so it is not part of the move list.
   *
   * SPEC 2.1 rule 8: there is no provider migration. 0.2.x never stored an AI provider id, so
   * nothing is invented from `engine`; a 0.2.x user starts unconfigured and picks a provider.
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

  /**
   * Rows for the provider picker (SPEC 2.1 rule 2).
   *
   * One alphabetical list of real providers, the custom provider last. The placeholder is a
   * separate, *disabled* first row that only appears while nothing is chosen: it is not a
   * provider, never takes part in the sort, and — being disabled — can never be picked again
   * once the user leaves the empty state (rule 6).
   *
   * A stored id the catalogue does not list is kept as its own row instead of being swapped for
   * another provider: stored values are never rewritten (rule 1).
   */
  function providerRows(providers, current, t) {
    const rows = [];
    const label = (entry) => (entry.source === "custom" ? t("pref.customProvider") : entry.name);
    if (!current) rows.push({ value: "", text: t("providerPlaceholder"), disabled: true });
    for (const entry of providers) rows.push({ value: entry.id, text: label(entry) });
    if (current && !providerEntry(providers, current)) rows.push({ value: current, text: current });
    return rows;
  }

  /**
   * Fill the provider picker and keep `state.provider` honest.
   *
   * The selected value comes from the stored state, never from "whatever ended up first": a
   * blank stored provider selects the placeholder, and nothing here writes a pref.
   */
  function renderProvider(select, providers, state, t) {
    if (!select) return;
    const rows = providerRows(providers, state.provider, t);
    fillSelect(select, rows, state.provider);
    const placeholder = select.options && select.options[0];
    if (placeholder && placeholder.getAttribute("value") === "") {
      placeholder.disabled = true;
      placeholder.setAttribute("disabled", "true");
    }
    state.provider = String(select.value || "");
    // `selected` is only true while the unconfigured row is the one on screen (rule 2).
    for (const option of select.options || []) {
      if (option.getAttribute("value") === "" && state.provider === "") option.setAttribute("selected", "true");
      else option.removeAttribute("selected");
    }
  }

  /** Model rows with a translated custom-model label, empty while no provider is chosen. */
  function renderModel(select, providers, state, t) {
    if (!select) return;
    const entry = state.provider ? providerEntry(providers, state.provider) : null;
    const rows = modelRows(entry, t("pref.customModel"));
    fillSelect(select, rows, state.model);
    if (rows.length && rows.some((row) => String(row.value) === String(select.value))) {
      state.model = String(select.value);
    } else {
      state.model = "";
    }
    select.disabled = !state.provider;
    if (!state.provider) {
      select.setAttribute("aria-label", t("providerRequiredForModel"));
      if (select.firstChild) select.firstChild.textContent = t("providerRequiredForModel");
    }
  }

  /**
   * Reasoning rows (R4). The stored sentinel is never replaced: while no provider is chosen the
   * picker is merely disabled and still shows `lowest`.
   */
  function renderReasoning(select, catalogue, state, t) {
    if (!select) return;
    const levels = state.provider ? levelsFor(catalogue, state.provider, state.model) : [];
    const rows = reasoningRows(levels, t);
    fillSelect(select, rows, state.reasoning);
    if (!state.provider && select.options && select.options[0]) {
      select.value = state.reasoning;
    }
    select.disabled = !state.provider;
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
    /**
     * Rule 4: once a provider is chosen, the endpoint shows that provider's API base. A profile
     * that has a provider but no stored endpoint (a pane older than the field, or a pref edited
     * by hand) must not render an empty field next to a chosen provider.
     */
    if (settings.provider && isBlank(settings.endpoint)) {
      settings.endpoint = catalog.apiForProvider(projected.providers, settings.provider);
    }
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
      // A blank stored target takes the first row without being written back: stored values are
      // never rewritten (SPEC 2.1 rule 1) — only a real user change saves.
      settings.target = target.value || settings.target;
      renderProvider(provider, providers, state, t);
      renderModel(model, providers, state, t);
      renderReasoning(reasoning, projected, { ...state, reasoning: settings.reasoning }, t);
      if (endpoint) {
        if (resetEndpoint) endpoint.value = state.endpoint;
        else if (!endpoint.value) endpoint.value = state.endpoint;
        // Rule 3: an unconfigured pane shows an empty field with the `https://` hint.
        endpoint.setAttribute("placeholder", "https://");
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

    /**
     * R2 + R3 + rule 4: a provider pick rewrites the model list, enables the cascade and — while
     * the endpoint is pristine — fills in the provider's API base. The placeholder is disabled,
     * so `nextProvider === ""` cannot come from a user choice and is ignored outright.
     */
    function onProviderChange() {
      const previousProvider = state.provider;
      const nextProvider = String(provider.value || "");
      if (!nextProvider) {
        renderProvider(provider, providers, state, t);
        return;
      }
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
      renderModel(model, providers, state, t);
      renderReasoning(reasoning, projected, { ...state, reasoning: settings.reasoning }, t);
      if (endpoint) endpoint.value = resolved;
      save(PREFS.provider, state.provider);
      if (resolved) save(PREFS.endpoint, resolved);
      if (state.model) save(PREFS.model, state.model);
    }

    function onModelChange() {
      if (!state.provider || !model.value) return;
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
        renderProvider(provider, state.providers, state, t);
        // Never pick a provider for the user: an unconfigured pane keeps its placeholder even
        // after a catalogue refresh (rule 1).
        if (!state.provider) {
          renderModel(model, state.providers, state, t);
          renderReasoning(reasoning, next, { ...state, reasoning: settings.reasoning }, t);
        }
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
    providerRows: providerRows,
    renderProvider: renderProvider,
    renderModel: renderModel,
    renderReasoning: renderReasoning,
    providerEntry: providerEntry,
    modelRows: modelRows,
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
