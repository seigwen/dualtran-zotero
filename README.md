# DualTran Translate for Zotero

Translate what you are reading without losing the source:

- **A paper's title and abstract** — from the item list, into a child note, by replacing the
  fields, by appending the translation, or as a translated copy.
- **Text you select in the PDF/EPUB reader** — as an annotation, a sticky note below the
  selection, or a child note, straight from the selection popup.

- **Google Translate** — no key, no configuration.
- **AI** — any OpenAI-compatible endpoint with your own key (OpenAI, DeepSeek, OpenRouter, a
  local Ollama server, …). Zotero's privileged HTTP has no CORS wall, so localhost works.

This add-on is independent of the DualTran browser extension; it keeps its own settings.

## Requirements

- Zotero 7, 8, 9 or 10. Verified end to end on Zotero **10.0.6** (Linux).
- Internet access to `translate.googleapis.com` (Google engine) or to your AI endpoint.

## Install

1. Download `dualtran-zotero.xpi` from the [latest release](https://github.com/seigwen/dualtran-zotero/releases/latest).
2. Install it from the plugin manager:
   - **Zotero 10:** Tools → **Plugins** → ⚙ → **Install Plugin From File…**
   - **Zotero 7–9:** Tools → **Add-ons** → ⚙ → **Install Add-on From File…**
3. Restart Zotero. A **DualTran** submenu appears under **Tools**.

Zotero 10 refuses add-ons that do not declare an update manifest; this one does, so future
releases are offered as normal add-on updates.

## Translate an item

Select one or more items in the item list (a PDF, attachment or child note resolves to its parent
item), then pick one of the four entries under **Tools → DualTran**:

| Entry | Result |
| --- | --- |
| **Translate into a child note (keep the source)** | A child note: original title, translated title, original abstract, translation. |
| **Replace title and abstract…** | Asks for confirmation, saves the originals in a backup child note, then replaces the fields. |
| **Append translation to the abstract** | Keeps the abstract and appends `[DualTran · target]` + translated title + translation. |
| **Create a translated item** | Clones the metadata (authors, year, collections), swaps title/abstract for the translations, sets `language`, and links the copy with a two-way *Related* relation. Attachments and notes are not copied. |

A progress window reports item-by-item status, and failures are collected and shown once at the
end. The default target language is Simplified Chinese (`zh-CN`); see [Settings](#settings).

Selecting a standalone note (one with no parent item) does nothing and explains why: the command
works on the item-list selection, not on text inside the note editor.

## Translate selected text in the reader

Open a PDF or EPUB, select text, and use the **DualTran** row in the selection popup:

| Button | Result |
| --- | --- |
| **Highlight** | A highlight annotation whose comment is the translation (sidebar + annotation popup). |
| **Sticky** (PDF only) | A sticky-note annotation placed just below the last selected line, with the translation as its comment. |
| **Note** | A child note under the paper: the quoted selection followed by the translation. |

Each button shows `Translating…` while the request runs, then a `✓ … added` confirmation or the
error. The highlight colour is `#2ea8e5`.

**PDF text cannot be replaced.** Zotero's reader API does not rewrite a PDF's text layer, and
editing the file would break sync and font layout. The highlight annotation is the in-place
equivalent; the sticky note is the “below the selection” equivalent.

## Settings

There is no preference pane yet. Settings live in Zotero's Config Editor:

**Edit → Settings → Advanced → Config Editor** (macOS: **Zotero → Settings**).

Search for `extensions.zotero.dualtran` — the defaults are registered by the add-on, so every key
below is already listed with its default value. Edit a row in place; the next run picks the value
up, no restart needed.

| Pref (under `extensions.zotero.dualtran.`) | Default | Meaning |
| --- | --- | --- |
| `engine` | `google` | `google` or `ai`. Any other value is rejected with an error. |
| `target` | `zh-CN` | Target language code passed to the engine (`en`, `ja`, `de`, …). |
| `endpoint` | `https://api.openai.com/v1` | Base URL of the AI endpoint. |
| `apiKey` | empty | Bearer token for the AI endpoint. Leave empty for local servers. |
| `model` | `gpt-4o-mini` | Model id sent to the AI endpoint. |
| `timeout` | `120000` | Request timeout in milliseconds. |

`endpoint` accepts `https://api.openai.com/v1`, `https://api.deepseek.com`,
`http://127.0.0.1:11434/v1`, or a full `…/chat/completions` URL. A URL ending in `/v1` gets
`/chat/completions` appended; a bare host gets `/v1/chat/completions`.

Examples:

| Provider | `endpoint` | `model` | `apiKey` |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | required |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | required |
| OpenRouter | `https://openrouter.ai/api/v1` | e.g. `anthropic/claude-3.5-sonnet` | required |
| Ollama (local) | `http://127.0.0.1:11434/v1` | a model you have pulled | empty |

Set `engine` to `ai` after filling in the endpoint, key and model.

### Upgrading from 0.1.x

0.1.2 read its settings from root-level `dualtran.*` prefs by mistake, so the AI settings
documented for it were ignored. On first start, 0.1.3+ copies any root-level setting into
`extensions.zotero.dualtran.*` and removes the old key. Nothing to do by hand.

The old single Tools entry is now the first item of the **Tools → DualTran** submenu.

## Languages

The interface ships 38 languages, the same set as the DualTran browser extension. English,
Simplified Chinese and Traditional Chinese are written by hand; the rest are machine-translated
and checked for key parity and placeholder integrity by `npm test`.

## What it does not do

- It does not translate PDF full text — only the metadata and the text you select.
- It cannot replace PDF text (see above).
- It does not translate text selected inside the note editor; the reader popup is for PDF/EPUB
  readers.
- It does not update existing notes/annotations. Running an action twice creates a second note or
  annotation; delete the duplicate.
- Items with neither a title nor an abstract are skipped silently (a line goes to the debug log).
- It cannot be cancelled once started.

## Troubleshooting

- **The Tools menu has no DualTran entry.** Check that the add-on is enabled in Tools → Plugins
  (Add-ons in Zotero 7–9) and restart Zotero. For diagnosis, enable **Help → Debug Output Logging →
  View Output** and search for `DualTran:`; startup logs the version, the locale and the pref
  namespace.
- **No DualTran row in the selection popup.** The popup is only added for file attachments
  (PDF/EPUB/snapshot). For non-PDF readers the Sticky button is hidden.
- **“Unknown engine …”.** `engine` must be exactly `google` or `ai`.
- **HTTP 401 / 403.** Wrong or missing `apiKey` for the selected endpoint.
- **HTTP 404.** Usually a wrong `endpoint` or `model`; check the provider's base URL.
- **Google returns nothing / times out.** The Google endpoint is unreachable on some networks;
  switch to the `ai` engine.
- **Empty translation.** The provider answered with empty content; try another model.
- Request errors are also written to the debug output, including the item id.

## Privacy

The title and abstract of the selected items, and the text you select in the reader, are sent to
`translate.googleapis.com` when the Google engine is active, or to the endpoint you configure when
the AI engine is active. Nothing else leaves the machine: settings are stored in Zotero's prefs,
there is no telemetry, and the add-on makes no other network requests.

## Development

```bash
npm install
npm test              # unit tests + locale guards
npm run build         # writes dualtran-zotero.xpi
npm run i18n:translate # regenerate missing locales from English (needs an OpenAI-compatible endpoint)
```

Layout:

| Path | Role |
| --- | --- |
| `bootstrap.js` | Zotero entry point: menus, progress window, HTTP, item actions, reader popup |
| `content/translate.js` | pure, testable core: prefs, endpoints, chunking, parsing, note/annotation payloads |
| `content/i18n.js` | runtime dictionary lookup with `{placeholder}` interpolation |
| `prefs.js` | default prefs, loaded by Zotero into the default branch on every start |
| `locales/*.json` | 38 UI languages; `en`, `zh_CN`, `zh_TW` are maintained by hand |
| `manifest.json` | add-on id, compatibility range, update manifest URL |
| `updates.json` | update manifest served from `master`; add an entry per release |
| `scripts/i18n-translate.mjs` | fills missing locales from `locales/en.json` |

`npm run build` packages only runtime files (`manifest.json`, `bootstrap.js`, `prefs.js`,
`content/`, `locales/`).

## Licence

MPL-2.0. See [LICENSE](LICENSE).
