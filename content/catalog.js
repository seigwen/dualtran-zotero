/**
 * Pure catalogue helpers for the DualTran preference pane.
 *
 * Loaded two ways: by Zotero through `Services.scriptloader.loadSubScript` (a preference pane
 * has no module system) and by the Node suite through `require()`. The file therefore assigns to
 * `globalThis.DualTranCatalog` and exports through `module.exports` only when `module` exists.
 *
 * Everything here is pure: the pane script (content/preferences.js) owns the DOM and the prefs,
 * the tests own the fixtures. That keeps the product rules (one alphabetical provider list,
 * endpoint autofill that respects user edits, the `lowest` reasoning sentinel) testable without
 * a running Zotero.
 */
(function (root) {
  "use strict";

  /**
   * Providers DualTran knows how to talk to even when models.dev is unreachable or does not list
   * them. `dev` is the models.dev key the models are read from: the pane uses friendlier ids
   * (`google-gemini`, `moonshot`, `xai`) than the catalogue. `api` is the OpenAI-compatible base
   * the endpoint field is filled with (empty = leave the user's endpoint alone).
   */
  const BUILTINS = [
    { id: "openai", name: "OpenAI", dev: "openai", api: "https://api.openai.com/v1" },
    { id: "anthropic", name: "Anthropic", dev: "anthropic", api: "https://api.anthropic.com/v1" },
    { id: "google-gemini", name: "Google Gemini", dev: "google", api: "" },
    { id: "moonshot", name: "Moonshot AI", dev: "moonshotai", api: "https://api.moonshot.ai/v1" },
    { id: "deepseek", name: "DeepSeek", dev: "deepseek", api: "https://api.deepseek.com" },
    { id: "groq", name: "Groq", dev: "groq", api: "https://api.groq.com/openai/v1" },
    { id: "mistral", name: "Mistral", dev: "mistral", api: "https://api.mistral.ai/v1" },
    { id: "xai", name: "xAI", dev: "grok", api: "https://api.x.ai/v1" },
    { id: "openrouter", name: "OpenRouter", dev: "openrouter", api: "https://openrouter.ai/api/v1" },
    { id: "ollama", name: "Ollama", dev: "ollama", api: "http://127.0.0.1:11434/v1" },
    { id: "lmstudio", name: "LM Studio", dev: "lmstudio", api: "http://127.0.0.1:1234/v1" },
    { id: "custom", name: "Custom provider", dev: null, api: "" },
  ];

  /**
   * Aliases the models.dev catalogue uses for a provider. Several targets are ALSO built-in ids
   * (`deepseek`, `openai`, …); they resolve to themselves so a built-in always keeps naming its
   * own catalogue entry.
   */
  const ALIASES = {
    "google-gemini": "google",
    moonshot: "moonshotai",
    grok: "xai",
    "azure-openai": "azure",
  };

  /** The reasoning sentinel persisted in prefs: "whatever this model offers, cheapest first". */
  const LOWEST = "lowest";

  /**
   * Effort values DualTran can send, cheapest first. `default` is a models.dev placeholder, not
   * an OpenAI reasoning effort, so it is dropped; anything outside this list is ignored.
   */
  const REASONING_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

  /** Tried in order when the user picked the sentinel. */
  const LADDER = ["none", "minimal", "low"];

  const CUSTOM_MODEL_ID = "__custom__";
  const CUSTOM_PROVIDER_ID = "custom";

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function collator() {
    return new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  }

  function byName(left, right) {
    return collator().compare(left, right);
  }

  /** Effort levels a model advertises, in canonical order; [] when it declares nothing usable. */
  function levelsOf(model) {
    const options = model && Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
    const levels = new Set();
    for (const option of options) {
      if (!isObject(option) || option.type !== "effort" || !Array.isArray(option.values)) continue;
      for (const value of option.values) {
        if (REASONING_ORDER.indexOf(value) !== -1) levels.add(value);
      }
    }
    return REASONING_ORDER.filter((level) => levels.has(level));
  }

  /**
   * Normalise the models.dev document into what the pane needs.
   *
   * @returns {{providers: Object, modelsById: Object, reasoning: Object}}
   *   providers  id -> {id, name, api}
   *   modelsById id -> model id -> {value, text, levels}
   *   reasoning  id -> model id -> {levels, preferred}
   */
  function projectCatalog(raw) {
    const providers = {};
    const modelsById = {};
    const reasoning = {};
    const source = isObject(raw) ? raw : {};

    for (const [id, entry] of Object.entries(source)) {
      if (!isObject(entry)) continue;
      providers[id] = {
        id: id,
        name: String(entry.name || id),
        api: typeof entry.api === "string" && entry.api.trim() ? entry.api.trim().replace(/\/+$/, "") : "",
      };
      const models = isObject(entry.models) ? entry.models : {};
      modelsById[id] = {};
      reasoning[id] = {};
      for (const [modelId, model] of Object.entries(models)) {
        if (!isObject(model)) continue;
        const levels = levelsOf(model);
        modelsById[id][modelId] = {
          value: modelId,
          text: String(model.name || modelId),
          levels: levels,
        };
        reasoning[id][modelId] = {
          levels: levels,
          preferred: pickReasoning({ setting: LOWEST, levels: levels }),
        };
      }
    }

    return { providers: providers, modelsById: modelsById, reasoning: reasoning };
  }

  /** Endpoint base for a provider: the catalogue's when it publishes one, else the built-in. */
  function apiForProvider(providers, id) {
    const entry = isObject(providers) ? providers[id] : null;
    if (entry && entry.api) return String(entry.api).replace(/\/+$/, "");
    const builtin = BUILTINS.find((candidate) => candidate.id === id);
    return builtin ? builtin.api : "";
  }

  function modelsFor(catalog, provider) {
    const devId = provider.dev;
    const projected = devId && isObject(catalog.modelsById) ? catalog.modelsById[devId] : null;
    const models = projected ? Object.values(projected) : [];
    return models
      .slice()
      .sort((left, right) => byName(left.text, right.text))
      .map((model) => ({ value: model.value, text: model.text }))
      .concat([{ value: CUSTOM_MODEL_ID, text: "" }]);
  }

  /**
   * ONE alphabetical provider list: built-ins (models pulled from their models.dev entry) merged
   * with every remaining models.dev provider. Alias twins and duplicate ids collapse into a
   * single row, and the custom provider is always last.
   */
  function buildProviderList(catalog) {
    const safe = isObject(catalog) ? catalog : { providers: {}, modelsById: {} };
    const catalogue = isObject(safe.providers) ? safe.providers : {};
    const rows = [];
    const claimedDev = new Set();
    const claimedIds = new Set();

    for (const builtin of BUILTINS) {
      if (builtin.id === CUSTOM_PROVIDER_ID) continue;
      const devEntry = builtin.dev && isObject(catalogue[builtin.dev]) ? catalogue[builtin.dev] : null;
      if (builtin.dev) claimedDev.add(builtin.dev);
      claimedIds.add(builtin.id);
      rows.push({
        id: builtin.id,
        name: (devEntry && devEntry.name) || builtin.name,
        api: (devEntry && apiForProvider(catalogue, builtin.dev)) || builtin.api,
        source: "built-in",
        models: modelsFor(safe, builtin),
      });
    }

    for (const [id, entry] of Object.entries(catalogue)) {
      if (claimedDev.has(id) || claimedIds.has(id)) continue;
      claimedIds.add(id);
      rows.push({
        id: id,
        name: String(entry.name || id),
        api: apiForProvider(catalogue, id),
        source: "models.dev",
        models: modelsFor(safe, { id: id, dev: id }),
      });
    }

    rows.sort((left, right) => byName(left.name, right.name));

    const custom = BUILTINS.find((builtin) => builtin.id === CUSTOM_PROVIDER_ID);
    rows.push({
      id: custom.id,
      name: custom.name,
      api: custom.api,
      source: "custom",
      models: modelsFor(safe, custom),
    });
    return rows;
  }

  /**
   * Target-language options as `Name (code)`, sorted by name. `auto` is a source-language concept
   * and never appears here; a stored code the table does not know stays selectable as
   * `code (code)` so saving the pane cannot silently drop the user's target.
   */
  function languageOptions(names, current) {
    const table = isObject(names) ? names : {};
    const options = [];
    for (const [code, name] of Object.entries(table)) {
      if (!code || /^auto$/i.test(code)) continue;
      const label = typeof name === "string" && name.trim() ? name.trim() : code;
      options.push({ value: code, text: label + " (" + code + ")" });
    }
    options.sort((left, right) => byName(left.text, right.text));
    const wanted = String(current || "").trim();
    if (wanted && !options.some((option) => option.value === wanted)) {
      options.push({ value: wanted, text: wanted + " (" + wanted + ")" });
    }
    return options;
  }

  function normalizeBase(value) {
    return String(value || "")
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/chat\/completions$/i, "")
      .replace(/\/+$/, "");
  }

  /** True while the endpoint still holds what the previous provider wrote (i.e. is not dirtied). */
  function endpointIsPristine(current, previousProvider, providers) {
    const text = normalizeBase(current);
    if (!text) return true;
    if (!previousProvider) return false;
    const written = normalizeBase(apiForProvider(providers, previousProvider));
    return Boolean(written) && written === text;
  }

  /**
   * The endpoint after a provider pick.
   *
   * A user edit always wins: the field is only rewritten while it is empty or still holds the
   * base the previous provider wrote. A provider without a known base leaves it untouched.
   */
  function resolveEndpointOnProviderChange(options) {
    const current = options && options.current != null ? String(options.current) : "";
    const providers = options && options.providers;
    const next = options && options.nextProvider ? apiForProvider(providers, options.nextProvider) : "";
    if (!next) return current;
    if (endpointIsPristine(current, options && options.previousProvider, providers)) return next;
    return current;
  }

  /** Picker rows for the reasoning select: the sentinel first, then the model's own levels. */
  function reasoningOptions(options) {
    const setting = options && options.setting;
    const levels = options && Array.isArray(options.levels) ? options.levels : [];
    const rows = [{ value: LOWEST, level: "" }];
    for (const level of levels) {
      if (level === LOWEST) continue;
      rows.push({ value: level, level: level });
    }
    if (setting && setting !== LOWEST && levels.indexOf(setting) === -1) {
      rows.push({ value: String(setting), level: String(setting) });
    }
    return rows;
  }

  /** The concrete parameter value for a stored setting and the model's declared levels. */
  function pickReasoning(options) {
    const setting = options && options.setting;
    const levels = options && Array.isArray(options.levels) ? options.levels : [];
    if (!levels.length) return "";
    if (setting && setting !== LOWEST) {
      if (levels.indexOf(setting) !== -1) return setting;
      for (const level of LADDER) if (levels.indexOf(level) !== -1) return level;
      return levels[0];
    }
    for (const level of LADDER) if (levels.indexOf(level) !== -1) return level;
    return levels[0];
  }

  /** Request-time reasoning: "" means "send no reasoning parameter at all". */
  function resolveReasoningDepth(options) {
    return pickReasoning(options);
  }

  const api = {
    BUILTINS: BUILTINS,
    ALIASES: ALIASES,
    LOWEST: LOWEST,
    LADDER: LADDER,
    REASONING_ORDER: REASONING_ORDER,
    CUSTOM_MODEL_ID: CUSTOM_MODEL_ID,
    CUSTOM_PROVIDER_ID: CUSTOM_PROVIDER_ID,
    projectCatalog: projectCatalog,
    levelsOf: levelsOf,
    apiForProvider: apiForProvider,
    buildProviderList: buildProviderList,
    languageOptions: languageOptions,
    normalizeBase: normalizeBase,
    resolveEndpointOnProviderChange: resolveEndpointOnProviderChange,
    resolveReasoningDepth: resolveReasoningDepth,
    reasoningOptions: reasoningOptions,
  };

  root.DualTranCatalog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
