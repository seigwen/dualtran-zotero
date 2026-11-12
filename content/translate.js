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
    /**
     * SPEC 2.1: a fresh install has NO AI provider. The endpoint and model follow from the
     * provider the user picks, so they start empty too — nothing here may suggest OpenAI.
     */
    provider: "",
    endpoint: "",
    apiKey: "",
    model: "",
    /** R4: the stored sentinel, not a concrete effort. */
    reasoning: "lowest",
    timeout: 120000,
  };

  /** Shown (and thrown) when an AI translation is attempted without a provider. */
  const PROVIDER_REQUIRED = "Choose an AI provider in settings before translating.";

  const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

  /**
   * The pane writes these names (see the PREFS map in content/preferences.js): reading the raw
   * field names made the pane's choices invisible to the request path, so each field lists its
   * pref name(s). The second entry is the 0.2.x name, still honoured for older profiles.
   */
  const PREF_NAMES = {
    provider: ["aiProvider"],
    endpoint: ["aiBaseUrl", "endpoint"],
    model: ["aiModel", "model"],
    reasoning: ["aiReasoningDepth"],
  };

  /** First non-blank value among the pref names a field accepts, or the shipped default. */
  function readField(getPref, key) {
    for (const name of PREF_NAMES[key] || [key]) {
      const value = getPref(PREF_PREFIX + name);
      if (!isBlank(value)) return value;
    }
    return DEFAULT_CONFIG[key];
  }

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
      values[key] = readField(getPref, key);
    }

    const engine = String(values.engine).trim().toLowerCase();
    if (engine !== "google" && engine !== "ai") {
      throw new Error(
        'Unknown engine "' + values.engine + '". Set ' + PREF_PREFIX + 'engine to "google" or "ai".'
      );
    }

    const timeout = Number(values.timeout);
    // SPEC 2.1: an empty provider is a real state, not a blank to fill with a default. The raw
    // value is handed back untouched (whitespace stripped); nothing here picks a provider.
    const provider = isBlank(values.provider) ? "" : String(values.provider).trim();
    return {
      engine: engine,
      target: String(values.target).trim() || DEFAULT_CONFIG.target,
      provider: provider,
      providerRequired: engine === "ai" && provider === "",
      endpoint: isBlank(values.endpoint) ? "" : String(values.endpoint).trim(),
      apiKey: values.apiKey == null ? "" : String(values.apiKey).trim(),
      model: isBlank(values.model) ? "" : String(values.model).trim(),
      reasoning: String(values.reasoning || DEFAULT_CONFIG.reasoning),
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CONFIG.timeout,
    };
  }

  /** The message for an AI translation attempted without a provider. */
  function providerRequiredError() {
    return PROVIDER_REQUIRED;
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
    // R4: the pane stores the "lowest" sentinel; the concrete effort (none → minimal → low) is
    // resolved here, per model. No reasoning parameter at all when the model declares none.
    if (config.reasoning && typeof config.reasoning.resolve === "function") {
      const level = config.reasoning.resolve();
      if (level) body.reasoning_effort = level;
    }
    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers.Authorization = "Bearer " + config.apiKey;
    return { url: chatCompletionsUrl(config.endpoint), headers: headers, body: JSON.stringify(body) };
  }

  /**
   * THE request path for an AI translation (SPEC 2.1, rule 5).
   *
   * Every AI entry point goes through here, so "no provider" is refused in exactly one place:
   * an unconfigured install throws PROVIDER_REQUIRED and never builds — let alone sends — a
   * request. There is deliberately no `|| "openai"` / `|| CUSTOM_PROVIDER` fallback.
   */
  function buildProviderRequest(config, options) {
    const settings = config || {};
    if (isBlank(settings.provider)) throw new Error(PROVIDER_REQUIRED);
    if (!String(settings.endpoint || "").trim()) throw new Error('The AI provider "' + settings.provider + '" has no API endpoint.');
    if (!String(settings.model || "").trim()) throw new Error('The AI provider "' + settings.provider + '" has no model selected.');
    return buildChatRequest(settings, options);
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
  function buildNoteHtml(title, abstractText, translatedTitle, translatedAbstract, labels) {
    labels = labels || {};
    const originalLabel = labels.originalAbstract || "Original abstract";
    const translationLabel = labels.translation || "Translation";
    const escape = function (value) {
      return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    };
    const parts = [];
    if (title) {
      parts.push("<h1>" + escape(title) + "</h1>");
      if (translatedTitle) parts.push("<h2>" + escape(translatedTitle) + "</h2>");
    }
    if (abstractText) {
      parts.push("<h3>" + escape(originalLabel) + "</h3><p>" + escape(abstractText) + "</p>");
      if (translatedAbstract) {
        parts.push("<h3>" + escape(translationLabel) + "</h3><p>" + escape(translatedAbstract) + "</p>");
      }
    }
    return parts.join("\n");
  }

  /** Note body for a text selected in the reader: quote first, translation underneath. */
  function buildSelectionNote(selectionText, translation) {
    const escape = function (value) {
      return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    };
    if (!selectionText) throw new Error("There is no selected text");
    return "<blockquote><p>" + escape(selectionText) + "</p></blockquote>\n<p>" + escape(translation) + "</p>";
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

  /**
   * Explain why a selection produced nothing to translate. Returns null when the selection
   * contains at least one regular item (or a child that can resolve to one).
   */
  function selectionHint(items) {
    const list = items || [];
    if (!list.length) {
      return (
        "Select an item in the item list first — this command translates the selected item's " +
        "title and abstract into a child note."
      );
    }

    const translatable = list.some(function (item) {
      return item && (item.isRegularItem() || item.parentItemID);
    });
    if (translatable) return null;

    const onlyNotes = list.every(function (item) {
      return item && typeof item.isNote === "function" && item.isNote();
    });
    if (onlyNotes) {
      return (
        "A standalone note has no parent item, and this command does not translate note text. " +
        "Select the paper (or its PDF) in the item list; its title and abstract are translated " +
        "into a child note."
      );
    }
    return (
      "The selected item has no parent record. Select a library item such as a paper, or an " +
      "attachment that belongs to one."
    );
  }

  /**
   * Explain why a selection has nothing to translate, as a stable code the UI can localise.
   * Returns null when the selection contains a regular item (or a child that resolves to one).
   *
   * @returns {null | "empty" | "standalone-note" | "no-parent"}
   */
  function selectionProblem(items) {
    const list = items || [];
    if (!list.length) return "empty";

    const translatable = list.some(function (item) {
      return item && (item.isRegularItem() || item.parentItemID);
    });
    if (translatable) return null;

    const onlyNotes = list.every(function (item) {
      return item && typeof item.isNote === "function" && item.isNote();
    });
    return onlyNotes ? "standalone-note" : "no-parent";
  }

  /**
   * Build the position of a sticky-note annotation placed just below the last line of a
   * selection. PDF coordinates have the origin at the bottom left, so "below" subtracts.
   */
  function notePosition(position, size) {
    if (typeof position === "string") {
      try {
        position = JSON.parse(position);
      } catch (error) {
        throw new Error("Cannot place a sticky note: the selection position is invalid");
      }
    }
    if (!position || !Array.isArray(position.rects) || !position.rects.length) {
      throw new Error("Cannot place a sticky note: the selection has no position");
    }
    const rects = position.rects;
    const last = rects[rects.length - 1];
    const height = Math.max(last[3] - last[1], size || 12);
    return Object.assign({}, position, {
      rects: [[last[0], last[1] - height, last[0] + height, last[1]]],
    });
  }

  /**
   * Build the annotation JSON consumed by Zotero.Annotations.saveFromJSON().
   *
   * @param {Object} annotation the reader's selection annotation (params.annotation)
   * @param {string} translation translated text
   * @param {"highlight"|"sticky"} mode
   * @param {{key?: string, color?: string, generateKey?: Function}} [options]
   */
  function buildAnnotation(annotation, translation, mode, options) {
    options = options || {};
    if (!annotation || !annotation.text) throw new Error("There is no selected text to annotate");
    if (!translation || !String(translation).trim()) throw new Error("The translation is empty");

    const type = mode === "sticky" ? "note" : "highlight";
    const key = annotation.key || options.key || (options.generateKey ? options.generateKey() : "");
    if (!key) throw new Error("Cannot create an annotation without a key");

    let position = annotation.position;
    if (typeof position === "string") {
      try {
        position = JSON.parse(position);
      } catch (error) {
        throw new Error("Cannot create an annotation: the selection position is invalid");
      }
    }

    return {
      key: key,
      type: type,
      text: type === "highlight" ? annotation.text : undefined,
      comment: translation,
      color: options.color || "#2ea8e5",
      pageLabel: annotation.pageLabel,
      sortIndex: annotation.sortIndex,
      position: type === "note" ? notePosition(position, options.noteSize) : position,
    };
  }

  /** Append a plain-text translation block to the item's abstract (which is not HTML). */
  function buildAppendText(originalAbstract, translatedTitle, translatedAbstract, target, labels) {
    labels = labels || {};
    const heading = (labels.heading || "[DualTran · {target}]").replace("{target}", target);
    const titleLabel = labels.title || "Title:";
    const base = String(originalAbstract || "").trimEnd();
    const block = [heading];
    if (translatedTitle) block.push(titleLabel + " " + translatedTitle);
    if (translatedAbstract) block.push("", translatedAbstract);
    return base ? base + "\n\n" + block.join("\n") : block.join("\n");
  }

  /** Child note that preserves the metadata replaced by the “replace” action. */
  function buildBackupNote(fields, target, savedAt, labels) {
    labels = labels || {};
    const escape = function (value) {
      return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    };
    const saved = (labels.saved || "Saved {date} · target {target}")
      .replace("{date}", savedAt)
      .replace("{target}", target);
    const parts = ["<h2>" + escape(labels.heading || "DualTran backup — original metadata") + "</h2>"];
    parts.push("<p><strong>" + escape(labels.title || "Title") + ":</strong> " + escape(fields.title) + "</p>");
    if (fields.abstractText) {
      parts.push(
        "<p><strong>" + escape(labels.abstract || "Abstract") + ":</strong> " + escape(fields.abstractText) + "</p>"
      );
    }
    parts.push("<p><em>" + escape(saved) + "</em></p>");
    return parts.join("\n");
  }

  /** Fields for a translated copy of an item (no attachments, no notes). */
  function buildTranslatedItemFields(fields, translation, target) {
    return {
      title: translation.title || fields.title,
      abstractNote: translation.abstract || fields.abstractText || "",
      language: target,
    };
  }

  const api = {
    PREF_PREFIX: PREF_PREFIX,
    LEGACY_PREFIX: LEGACY_PREFIX,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    PROVIDER_REQUIRED: PROVIDER_REQUIRED,
    readConfig: readConfig,
    providerRequiredError: providerRequiredError,
    migrateLegacyPrefs: migrateLegacyPrefs,
    normalizeEndpoint: normalizeEndpoint,
    chatCompletionsUrl: chatCompletionsUrl,
    buildChatRequest: buildChatRequest,
    buildProviderRequest: buildProviderRequest,
    parseChatResponse: parseChatResponse,
    googleUrl: googleUrl,
    parseGoogleResponse: parseGoogleResponse,
    chunkLimitFor: chunkLimitFor,
    chunkText: chunkText,
    buildNoteHtml: buildNoteHtml,
    buildSelectionNote: buildSelectionNote,
    resolveTargets: resolveTargets,
    selectionHint: selectionHint,
    selectionProblem: selectionProblem,
    notePosition: notePosition,
    buildAnnotation: buildAnnotation,
    buildAppendText: buildAppendText,
    buildBackupNote: buildBackupNote,
    buildTranslatedItemFields: buildTranslatedItemFields,
  };

  root.DualTranCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
