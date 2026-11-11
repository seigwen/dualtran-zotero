/**
 * Target-language table for the DualTran preference pane.
 *
 * A code -> English name map, copied verbatim from `facts/language-names.json` (the same list
 * the browser build ships). The pane does not hardcode <option> elements: `preferences.xhtml`
 * renders them from `DualTranLanguages.names` through `DualTranCatalog.languageOptions`, so
 * adding a language is a one-line change here and nothing else.
 *
 * Loaded with `Services.scriptloader.loadSubScript` in Zotero and through `require()` in tests.
 */
(function (root) {
  "use strict";

  const names = {
    af: "Afrikaans",
    ar: "Arabic",
    bg: "Bulgarian",
    bn: "Bengali",
    ca: "Catalan",
    cs: "Czech",
    da: "Danish",
    de: "German",
    el: "Greek",
    en: "English",
    es: "Spanish",
    et: "Estonian",
    fa: "Persian",
    fi: "Finnish",
    fr: "French",
    he: "Hebrew",
    hi: "Hindi",
    hr: "Croatian",
    hu: "Hungarian",
    id: "Indonesian",
    it: "Italian",
    ja: "Japanese",
    ko: "Korean",
    lt: "Lithuanian",
    lv: "Latvian",
    ms: "Malay",
    nl: "Dutch",
    no: "Norwegian",
    pl: "Polish",
    pt: "Portuguese",
    "pt-BR": "Portuguese (Brazil)",
    ro: "Romanian",
    ru: "Russian",
    sk: "Slovak",
    sl: "Slovenian",
    sr: "Serbian",
    sv: "Swedish",
    th: "Thai",
    tr: "Turkish",
    uk: "Ukrainian",
    ur: "Urdu",
    vi: "Vietnamese",
    "zh-CN": "Chinese (Simplified)",
    "zh-TW": "Chinese (Traditional)",
  };

  /** English name for a code; the code itself when the table has no entry. */
  function forCode(code) {
    const key = String(code || "").trim();
    return Object.prototype.hasOwnProperty.call(names, key) ? names[key] : key;
  }

  const api = { names: names, forCode: forCode };

  root.DualTranLanguages = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
