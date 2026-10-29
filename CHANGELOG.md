# Changelog

## 0.2.0

### Added

- Translate text selected in the PDF/EPUB reader from the selection popup: **Highlight**
  (annotation with the translation as comment), **Sticky** (sticky note below the last selected
  line, PDF only), and **Note** (child note with the quoted selection and the translation).
- **Tools → DualTran** submenu with four item actions: child note (existing behaviour), replace
  title and abstract (with confirmation and a backup note), append the translation to the
  abstract, and create a translated copy linked by a two-way *Related* relation.
- 38-language interface (English, Simplified and Traditional Chinese handwritten; the rest
  machine-translated and guarded by tests).

### Changed

- The single “DualTran: translate title and abstract” Tools entry became the **DualTran** submenu.

### Fixed

- The replace confirmation uses Zotero's prompt wrapper, so it reports the exact item count and
  keeps a backup note before touching the metadata.

## 0.1.4

### Fixed

- The “nothing to translate” dialog now explains the actual cause: an empty selection, a
  standalone note (notes have no parent item and note text is not translated), or an attachment
  without a parent record. Selecting text inside a note previously produced a misleading
  “Select at least one item first” message.

## 0.1.3

### Fixed

- Settings are read from `extensions.zotero.dualtran.*`. 0.1.2 read root-level `dualtran.*`,
  so every AI setting documented in 0.1.2 was silently ignored and the add-on always used
  Google.
- Settings written by 0.1.2 at the root are migrated into the scoped namespace on first start.
- Defaults are registered in `prefs.js`, so all settings appear in the Config Editor with their
  default values instead of having to be created by hand.
- HTTP requests now honour a timeout (pref `timeout`, default 120 s) instead of hanging.
- Selecting a PDF, attachment or child note now resolves to its parent item; duplicate
  selections collapse. Previously such a selection silently did nothing.
- The menu item is disabled while a run is in progress and a progress window reports item-by-item
  status, so a double click can no longer start two runs.
- The Tools entry is also installed in windows opened after startup.
- An item with an abstract but no title no longer gets an empty `<h1>`.
- `npm test` and `npm run build` are real scripts; package version and licence now match the
  add-on (0.1.3, MPL-2.0).

### Changed

- Google URLs are encoded by hand instead of using `URLSearchParams`, which is not guaranteed to
  exist in a bootstrap scope.
- The AI engine sends up to 8000 characters per request; Google keeps the 1800-character window.

## 0.1.2

### Fixed

- Zotero 10 refused the add-on with “may not be compatible” because the manifest lacked an
  `update_url`; the add-on now ships `updates.json` and declares it.

## 0.1.0

- First release: Tools-menu command that translates an item's title and abstract into a child
  note, with Google and OpenAI-compatible AI engines.
