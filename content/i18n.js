/**
 * Tiny runtime dictionary for the Zotero add-on.
 *
 * Zotero localises its own UI with Fluent, but plugin code that builds menu labels and reader
 * popups has no bundle handle, so we keep a flat JSON dictionary per locale under `locales/`.
 *
 * Loaded by bootstrap.js through `Services.scriptloader.loadSubScript` and by the test suite
 * through `require()`.
 */
(function (root) {
  "use strict";

  let dictionary = {};

  function set(entries) {
    dictionary = entries && typeof entries === "object" ? entries : {};
  }

  function interpolate(value, params) {
    return String(value).replace(/\{(\w+)\}/g, function (match, name) {
      return params && params[name] !== undefined ? String(params[name]) : match;
    });
  }

  /**
   * Translate a key. Unknown keys return the key itself so a missing string is visible instead
   * of silent, and the English fallback is handled by loading en.json when the locale is absent.
   */
  function t(key, params) {
    const value = dictionary[key];
    if (typeof value !== "string" || !value) return key;
    return interpolate(value, params);
  }

  function keys() {
    return Object.keys(dictionary);
  }

  root.DualTranI18n = { set: set, t: t, keys: keys, interpolate: interpolate };
  if (typeof module !== "undefined" && module.exports) module.exports = root.DualTranI18n;
})(typeof globalThis !== "undefined" ? globalThis : this);
