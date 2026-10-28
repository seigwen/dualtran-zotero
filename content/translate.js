/**
 * Pure translation helpers for the Zotero plugin.
 *
 * Loaded two ways: by bootstrap.js through `Services.scriptloader.loadSubScript` (no module
 * system in a Zotero bootstrap scope) and by the Node test suite through `require()`. To stay
 * usable in both, the file assigns to `globalThis.DualTranCore` and exports via `module.exports`
 * only when `module` exists.
 */
(function (root) {
  "use strict";

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

  function googleUrl(options) {
    const params = new URLSearchParams({
      client: "gtx",
      sl: options.source || "auto",
      tl: options.target,
      dt: "t",
      q: options.text,
    });
    return "https://translate.googleapis.com/translate_a/single?" + params.toString();
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
    const parts = ["<h1>" + escape(title) + "</h1>"];
    if (translatedTitle) parts.push("<h2>" + escape(translatedTitle) + "</h2>");
    if (abstractText) {
      parts.push("<h3>Original abstract</h3><p>" + escape(abstractText) + "</p>");
      parts.push("<h3>Translation</h3><p>" + escape(translatedAbstract) + "</p>");
    }
    return parts.join("\n");
  }

  const api = {
    normalizeEndpoint: normalizeEndpoint,
    chatCompletionsUrl: chatCompletionsUrl,
    buildChatRequest: buildChatRequest,
    parseChatResponse: parseChatResponse,
    googleUrl: googleUrl,
    parseGoogleResponse: parseGoogleResponse,
    chunkText: chunkText,
    buildNoteHtml: buildNoteHtml,
  };

  root.DualTranCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
