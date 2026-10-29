/**
 * Pure translation helpers for the Zotero plugin.
 *
 * Loaded two ways: by bootstrap.js through `Services.scriptloader.loadSubScript` (no module
 * system in a Zotero bootstrap scope) and by the Node test suite through `require()`. To stay
 * usable in both, the file assigns to `globalThis.DualTranCore` and exports via `module.exports`
 * only when `module` exists.
 *
 * Everything that does not need Zotero lives here so it can be unit-tested in Node. The
 * bootstrap layer (menu, progress window, HTTP) stays thin and delegates here.
 */
(function (root) {
  "use strict";

  /** Zotero namespaces plugin prefs under `extensions.zotero.<id>.*`. */
  const PREF_PREFIX = "extensions.zotero.dualtran.";
  /** 0.1.2 read root-level `dualtran.*` by mistake; migrated to PREF_PREFIX on first run. */
  const LEGACY_PREFIX = "dualtran.";

  const DEFAULT_CONFIG = {
    engine: "google",
    target: "zh-CN",
    endpoint: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    timeout: 120000,
  };

  const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

  function isBlank(value) {
    return value === undefined || value === null || value === "";
  }

  /**
   * Read the plugin configuration through an injected getter.
   *
   * @param {(key: string) => *} getPref reads a fully-qualified pref name
   */
  function readConfig(getPref) {
    const values = {};
    for (const key of CONFIG_KEYS) {
      const value = getPref(PREF_PREFIX + key);
      values[key] = isBlank(value) ? DEFAULT_CONFIG[key] : value;
    }

    const engine = String(values.engine).trim().toLowerCase();
    if (engine !== "google" && engine !== "ai") {
      throw new Error(
        'Unknown engine "' + values.engine + '". Set ' + PREF_PREFIX + 'engine to "google" or "ai".'
      );
    }

    const timeout = Number(values.timeout);
    return {
      engine: engine,
      target: String(values.target).trim() || DEFAULT_CONFIG.target,
      endpoint: String(values.endpoint).trim() || DEFAULT_CONFIG.endpoint,
      apiKey: isBlank(values.apiKey) ? "" : String(values.apiKey).trim(),
      model: String(values.model).trim() || DEFAULT_CONFIG.model,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CONFIG.timeout,
    };
  }

  /**
   * Copy 0.1.2's root-level prefs into the scoped namespace. Runs on every startup and is a
   * no-op once the scoped pref has a user value.
   *
   * @param {{hasUserValue: Function, get: Function, set: Function, clear: Function}} io
   * @returns {string[]} the config keys that were migrated
   */
  function migrateLegacyPrefs(io) {
    const migrated = [];
    for (const key of CONFIG_KEYS) {
      const scoped = PREF_PREFIX + key;
      const legacy = LEGACY_PREFIX + key;
      if (io.hasUserValue(scoped) || !io.hasUserValue(legacy)) continue;
      io.set(scoped, io.get(legacy));
      io.clear(legacy);
      migrated.push(key);
    }
    return migrated;
  }

  function normalizeEndpoint(endpoint) {
    const trimmed = String(endpoint || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new Error('Endpoint must start with http:// or https:// (got "' + endpoint + '")');
    }
    return trimmed;
  }

  function chatCompletionsUrl(endpoint) {
    const base = normalizeEndpoint(endpoint);
    if (/\/chat\/completions$/i.test(base)) return base;
    if (/\/v\d+$/i.test(base)) return base + "/chat/completions";
    return base + "/v1/chat/completions";
  }

  function buildChatRequest(config, options) {
    const system =
      "You translate into " + options.target + ". Return only the translation, no commentary, " +
      "no quotes, and preserve citations, numbers and inline links exactly as they appear. " +
      "If the text is already in " + options.target + ", return it unchanged.";
    const body = {
      model: config.model,
      temperature: config.temperature === undefined ? 0 : config.temperature,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: options.text },
      ],
    };
    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers.Authorization = "Bearer " + config.apiKey;
    return { url: chatCompletionsUrl(config.endpoint), headers: headers, body: JSON.stringify(body) };
  }

  function parseChatResponse(payload) {
    if (payload && payload.error && payload.error.message) throw new Error(payload.error.message);
    const choice = payload && payload.choices && payload.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("The provider returned an empty translation");
    return content.trim();
  }

  /**
   * Build the Google endpoint URL by hand: bootstrap scopes are not guaranteed to expose
   * URLSearchParams, and GET must not depend on it.
   */
  function googleUrl(options) {
    const query = [
      ["client", "gtx"],
      ["sl", options.source || "auto"],
      ["tl", options.target],
      ["dt", "t"],
      ["q", options.text],
    ]
      .map(function (pair) {
        return pair[0] + "=" + encodeURIComponent(String(pair[1]));
      })
      .join("&");
    return "https://translate.googleapis.com/translate_a/single?" + query;
  }

  function parseGoogleResponse(payload) {
    const rows = payload && payload[0];
    if (!Array.isArray(rows)) throw new Error("Unexpected response from Google Translate");
    const text = rows
      .map(function (row) { return Array.isArray(row) ? String(row[0] === undefined ? "" : row[0]) : ""; })
      .join("")
      .trim();
    if (!text) throw new Error("Google Translate returned an empty translation");
    return text;
  }

  /** Google rejects oversized GET URLs; an AI provider can take the whole abstract. */
  function chunkLimitFor(engine) {
    return engine === "ai" ? 8000 : 1800;
  }

  function chunkText(text, limit) {
    limit = limit || 1800;
    const clean = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!clean) return [];
    if (clean.length <= limit) return [clean];
    const parts = [];
    let current = "";
    clean.split(/\n{2,}/).forEach(function (paragraph) {
      if ((current + "\n\n" + paragraph).trim().length <= limit) {
        current = current ? current + "\n\n" + paragraph : paragraph;
        return;
      }
      if (current) parts.push(current);
      if (paragraph.length <= limit) {
        current = paragraph;
      } else {
        for (let i = 0; i < paragraph.length; i += limit) parts.push(paragraph.slice(i, i + limit));
        current = "";
      }
    });
    if (current) parts.push(current);
    return parts;
  }

  /** Build the HTML body of the child note: source first, translation underneath. */
  function buildNoteHtml(title, abstractText, translatedTitle, translatedAbstract) {
    const escape = function (value) {
      return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    };
    const parts = [];
    if (title) {
      parts.push("<h1>" + escape(title) + "</h1>");
      if (translatedTitle) parts.push("<h2>" + escape(translatedTitle) + "</h2>");
    }
    if (abstractText) {
      parts.push("<h3>Original abstract</h3><p>" + escape(abstractText) + "</p>");
      if (translatedAbstract) parts.push("<h3>Translation</h3><p>" + escape(translatedAbstract) + "</p>");
    }
    return parts.join("\n");
  }

  /**
   * Turn a Zotero selection into the regular items we can translate: attachments and child
   * notes resolve to their parent record, duplicates collapse, top-level notes are dropped.
   *
   * @param {Array} items selected Zotero items
   * @param {(id: number) => *} getItem resolve an item id (Zotero.Items.get in the app)
   */
  function resolveTargets(items, getItem) {
    const targets = [];
    const seen = new Set();
    for (const item of items || []) {
      if (!item) continue;
      let target = item;
      if (!target.isRegularItem()) {
        const parentID = target.parentItemID;
        if (!parentID) continue;
        target = getItem(parentID);
        if (!target || !target.isRegularItem()) continue;
      }
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      targets.push(target);
    }
    return targets;
  }

  const api = {
    PREF_PREFIX: PREF_PREFIX,
    LEGACY_PREFIX: LEGACY_PREFIX,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    readConfig: readConfig,
    migrateLegacyPrefs: migrateLegacyPrefs,
    normalizeEndpoint: normalizeEndpoint,
    chatCompletionsUrl: chatCompletionsUrl,
    buildChatRequest: buildChatRequest,
    parseChatResponse: parseChatResponse,
    googleUrl: googleUrl,
    parseGoogleResponse: parseGoogleResponse,
    chunkLimitFor: chunkLimitFor,
    chunkText: chunkText,
    buildNoteHtml: buildNoteHtml,
    resolveTargets: resolveTargets,
  };

  root.DualTranCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
